"""Permission repairs: auth_org role checks, business_api legacy-table gates."""
import os, sys, types

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-key")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if "openai" not in sys.modules:
    _m = types.ModuleType("openai"); _m.OpenAI = object; _m.AsyncOpenAI = object
    sys.modules["openai"] = _m

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers.common import get_current_user, get_tenant_context, storage
from routers import auth_org, business_api

ORG = "11111111-1111-1111-1111-111111111111"


class _Row(dict):
    def __getitem__(self, k):
        return 0


class _DB:
    def execute(self, sql, params=()):
        class R:
            def fetchone(s): return _Row()
            def fetchall(s): return []
        return R()


def _client(perms, admin=False):
    app = FastAPI()
    app.include_router(auth_org.router)
    app.include_router(business_api.router)

    class F: pass
    f = F()
    f.db = _DB()
    f.is_super_admin = lambda uid: admin
    f.get_user_organizations = lambda uid: [{"id": ORG}]
    f.user_has_org_permission = lambda uid, org, key: key in perms
    f.update_organization = lambda *a, **k: True
    f.add_organization_member = lambda *a, **k: {"ok": 1}
    f.remove_organization_member = lambda *a, **k: True
    f.update_member_role = lambda *a, **k: True
    f.create_role = lambda *a, **k: {"id": 1}
    f.list_organization_members = lambda org: []
    f.get_stats = lambda *a, **k: {}
    f.get_organization = lambda org: {"id": org}
    storage._real = f
    app.dependency_overrides[get_current_user] = lambda: {"id": "u-1", "email": "a@x.co"}
    app.dependency_overrides[get_tenant_context] = lambda: ORG
    return TestClient(app, raise_server_exceptions=False)


@pytest.fixture(autouse=True)
def _reset():
    yield
    storage._real = None


ORG_MUTATIONS = [
    ("PATCH", f"/api/orgs/{ORG}", {"name": "x"}, "manage_workspace"),
    ("POST", f"/api/orgs/{ORG}/members", {"user_id": "u2"}, "manage_users"),
    ("DELETE", f"/api/orgs/{ORG}/members/u2", None, "manage_users"),
    ("PATCH", f"/api/orgs/{ORG}/members/u2/role", {"role_id": 1}, "manage_roles"),
    ("POST", f"/api/orgs/{ORG}/roles", {"name": "n", "slug": "n"}, "manage_roles"),
]


@pytest.mark.parametrize("method,path,body,key", ORG_MUTATIONS)
def test_org_mutation_denied_without_permission(method, path, body, key):
    c = _client(perms=set())
    assert c.request(method, path, json=body).status_code == 403


@pytest.mark.parametrize("method,path,body,key", ORG_MUTATIONS)
def test_org_mutation_allowed_with_permission(method, path, body, key):
    c = _client(perms={key})
    assert c.request(method, path, json=body).status_code == 200


def test_org_member_listing_still_open_to_members():
    assert _client(perms=set()).get(f"/api/orgs/{ORG}/members").status_code == 200


LEGACY = [
    ("GET", "/api/business-api/team"), ("GET", "/api/business-api/roles"),
    ("GET", "/api/business-api/tools"), ("GET", "/api/business-api/conversations"),
    ("GET", "/api/business-api/audit"), ("GET", "/api/waba/sessions"),
]


@pytest.mark.parametrize("method,path", LEGACY)
def test_legacy_business_api_denied_for_non_admin(method, path):
    assert _client(perms=set()).request(method, path).status_code == 403


@pytest.mark.parametrize("method,path", LEGACY)
def test_legacy_business_api_allowed_for_super_admin(method, path):
    assert _client(perms=set(), admin=True).request(method, path).status_code == 200


def test_team_member_patch_denied_for_non_admin():
    body = {"name": "n", "mobile_number": "9999999999", "role": "manager",
            "assigned_markets": [], "active": True, "waba_identity": ""}
    assert _client(perms=set()).patch("/api/business-api/team/1", json=body).status_code == 403


def test_legacy_routes_anonymous_401():
    app = FastAPI(); app.include_router(business_api.router)
    c = TestClient(app, raise_server_exceptions=False)
    for _, path in LEGACY:
        assert c.get(path).status_code == 401


def test_overview_workspace_scoped_for_non_admin(monkeypatch):
    async def _vals(org_id):
        return {}
    monkeypatch.setattr("routers.business_api._workspace_waba_values", _vals)
    c = _client(perms=set())
    r = c.get("/api/business-api/overview")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total_team_members"] == 0 and body["connected_team_members"] == 0
    assert body["inventory_summary"]["groups"] == 0
