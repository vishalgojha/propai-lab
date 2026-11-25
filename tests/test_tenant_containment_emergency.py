"""Emergency tenant-containment regression tests (local, no DB, no network).

Covers the 2026-11-26 live-proven exposures:
- anonymous access to /api/workspace/members, /api/notes, /api/search,
  /api/search/parse (was 200; must now be 401)
- anonymous write paths on workspace members / notes (must be 401)
- cross-org X-Team-Member-Id binding (must be 403)
- tenant predicates present in raw-message and notes SQL
"""
import os
import sys

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-key")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers import common
from routers.common import get_current_user, get_tenant_context, storage
from routers import listings, notes, search, workspace

TENANT_A = "11111111-1111-1111-1111-111111111111"
TENANT_B = "22222222-2222-2222-2222-222222222222"

MEMBER_A = {"id": 10, "name": "Alice", "role": "owner", "is_active": True,
            "organization_id": TENANT_A, "permissions": 1023}
MEMBER_B = {"id": 20, "name": "Bob", "role": "member", "is_active": True,
            "organization_id": TENANT_B, "permissions": 1023}


class FakeResult:
    def __init__(self, rows=(), row=None):
        self._rows, self._row = rows, row

    def fetchall(self):
        return self._rows

    def fetchone(self):
        return self._row


class FakeDB:
    def __init__(self):
        self.calls = []

    def execute(self, sql, params=()):
        self.calls.append((sql, params))
        return FakeResult()

    def commit(self):
        pass


def make_client(tenant_id=None, member_lookup=None, listed=None):
    app = FastAPI()
    for mod in (listings, notes, search, workspace):
        app.include_router(mod.router)

    fake_db = FakeDB()

    class FakeStorage:
        pass

    fake = FakeStorage()
    fake.db = fake_db
    fake._perm_keys = lambda bits: []
    fake.list_team_members = lambda org_id=None: list(listed or [])
    fake.get_team_member = member_lookup or (lambda mid: None)
    fake._fetch_typed_rows = lambda *a, **k: {}
    storage._real = fake

    if tenant_id is not None:
        app.dependency_overrides[get_current_user] = lambda: {"id": "u-1", "email": "a@x.co"}
        app.dependency_overrides[get_tenant_context] = lambda: tenant_id
    client = TestClient(app)
    client._fake_db = fake_db

    def teardown():
        storage._real = None

    client._teardown = teardown
    return client


@pytest.fixture
def anon():
    c = make_client()
    yield c
    c._teardown()


@pytest.fixture
def tenant_a():
    c = make_client(tenant_id=TENANT_A,
                    member_lookup=lambda mid: dict(MEMBER_B) if mid == 20 else (dict(MEMBER_A) if mid == 10 else None),
                    listed=[MEMBER_A])
    yield c
    c._teardown()


# --- anonymous rejection -------------------------------------------------
@pytest.mark.parametrize("method,path", [
    ("GET", "/api/workspace/members"),
    ("GET", "/api/workspace/members/10"),
    ("POST", "/api/workspace/members"),
    ("PUT", "/api/workspace/members/10"),
    ("DELETE", "/api/workspace/members/10"),
    ("GET", "/api/notes?entity_type=broker&entity_id=1"),
    ("POST", "/api/notes"),
    ("DELETE", "/api/notes/1"),
    ("GET", "/api/search?q=Bandra"),
    ("GET", "/api/search/parse?q=test"),
    ("GET", "/api/search/raw?q=flat"),
    ("GET", "/api/search/raw/sender?sender=amit"),
    ("GET", "/api/search/raw/group?group_jid=abc@g.us"),
])
def test_anonymous_rejected(anon, method, path):
    r = anon.request(method, path, json={} if method in ("POST", "PUT") else None)
    assert r.status_code == 401, f"{method} {path} -> {r.status_code}"


def test_anonymous_with_foreign_member_header_rejected(anon):
    # Even supplying a member id header without auth must fail now.
    r = anon.get("/api/workspace/members", headers={"X-Team-Member-Id": "20"})
    assert r.status_code == 401


# --- tenant boundaries for signed-in users --------------------------------
def test_members_list_scoped_to_own_org(tenant_a):
    captured = {}
    orig = storage._real.list_team_members
    def _list(org_id=None):
        captured["org_id"] = org_id
        return [MEMBER_A]
    storage._real.list_team_members = _list
    try:
        r = tenant_a.get("/api/workspace/members")
        assert r.status_code == 200
        assert captured["org_id"] == TENANT_A
        assert all(m["organization_id"] == TENANT_A for m in r.json()["members"])
    finally:
        storage._real.list_team_members = orig


def test_cross_org_member_header_rejected(tenant_a):
    r = tenant_a.get("/api/workspace/members", headers={"X-Team-Member-Id": "20"})  # Bob is org B
    assert r.status_code == 403


def test_own_org_member_header_accepted(tenant_a):
    r = tenant_a.get("/api/workspace/members/10", headers={"X-Team-Member-Id": "10"})
    assert r.status_code == 200
    assert r.json()["id"] == 10


def test_raw_sender_sql_tenant_scoped(tenant_a):
    r = tenant_a.get("/api/search/raw/sender?sender=amit")
    assert r.status_code == 200
    sql, params = tenant_a._fake_db.calls[0]
    assert "tenant_id = ?" in sql
    assert TENANT_A in params


def test_raw_group_sql_tenant_scoped(tenant_a):
    r = tenant_a.get("/api/search/raw/group?group_jid=abc@g.us")
    assert r.status_code == 200
    sql, params = tenant_a._fake_db.calls[0]
    assert "tenant_id = ?" in sql
    assert TENANT_A in params


def test_raw_fts_sql_tenant_scoped(tenant_a):
    r = tenant_a.get("/api/search/raw?q=flat")
    assert r.status_code == 200
    statements = [c[0] for c in tenant_a._fake_db.calls]
    assert any("rm.tenant_id = ?" in s for s in statements)
    for _sql, params in tenant_a._fake_db.calls:
        assert TENANT_A in params


def test_notes_list_tenant_scoped(tenant_a):
    r = tenant_a.get("/api/notes?entity_type=broker&entity_id=1")
    assert r.status_code == 200
    sql, params = tenant_a._fake_db.calls[0]
    assert "n.tenant_id = ?" in sql
    assert TENANT_A in params


def test_notes_insert_sets_tenant(tenant_a):
    r = tenant_a.post("/api/notes", json={"entity_type": "broker", "entity_id": "1", "body": "hello"})
    assert r.status_code == 200
    insert_sql, params = tenant_a._fake_db.calls[0]
    assert "tenant_id" in insert_sql
    assert TENANT_A in params


def test_notes_delete_tenant_scoped(tenant_a):
    class _Row:
        def __getitem__(self, k):
            return 10  # author_id matches fallback member (owner id 10 via header below)
    orig_execute = tenant_a._fake_db.execute
    tenant_a._fake_db.execute = lambda sql, params=(): (tenant_a._fake_db.calls.append((sql, params)) or FakeResult(row=_Row()))
    try:
        r = tenant_a.delete("/api/notes/5", headers={"X-Team-Member-Id": "10"})
        assert r.status_code == 200
        for sql, params in tenant_a._fake_db.calls:
            assert "tenant_id = ?" in sql and TENANT_A in params
    finally:
        tenant_a._fake_db.execute = orig_execute


def test_palette_search_requires_auth_but_works_signed_in(tenant_a):
    r = tenant_a.get("/api/search?q=Bandra")
    assert r.status_code == 200


# --- shared-network visibility gates --------------------------------------
def _typed_row(tid, visibility, table="residential_rent_listings", rid=1, title="2BHK Bandra"):
    return {
        "id": rid, "_typed_table": table, "tenant_id": tid, "visibility": visibility,
        "building_name": "Bandra View", "micro_market": "Bandra", "locality_raw": "Bandra",
        "broker_name": "X", "group_name": "g", "summary_title": title,
        "transaction_type": "rent", "created_at": "2026-01-01", "last_seen_at": "2026-01-01",
    }


def test_palette_hides_other_tenant_private_rows(tenant_a):
    storage._real._fetch_typed_rows = lambda *a, **k: [
        _typed_row(TENANT_A, "workspace_private", rid=1, title="own private"),
        _typed_row(TENANT_A, None, rid=2, title="own shared"),
        _typed_row(TENANT_B, None, rid=3, title="other shared"),
        _typed_row(TENANT_B, "workspace_private", rid=4, title="other private"),
    ]
    r = tenant_a.get("/api/search?q=Bandra")
    assert r.status_code == 200
    titles = [l["summary_title"] for l in r.json().get("listings", [])]
    assert "own private" in titles
    assert "own shared" in titles
    assert "other shared" in titles
    assert "other private" not in titles


def test_listings_route_smoke_signed_in(tenant_a):
    storage._real.get_listings = lambda limit, offset: []
    r = tenant_a.get("/api/listings")
    assert r.status_code == 200
