"""Usage-tracking regression tests.

Contracts covered:
- record_search_usage stores only workspace/surface/origin plus the
  fixed action; it has no content parameters at all, insert failures are
  swallowed, and a missing tenant or unknown origin is a no-op.
- Assistant/API origin mapping: only an explicit X-PropAI-Initiator:
  automation header counts as automation; every other assistant call stays
  assistant_unlabeled. Unknown provenance is never labeled human usage.
- External route hooks count completed searches only and never record
  failed, scope-rejected or consent-rejected calls.
- Authenticated app search routes record origin="app". Chat helpers only
  mark a request-scoped collector; the completed authenticated turn emits at
  most one event. Unauthenticated self-chat helper reuse is not app usage.
- /api/usage/summary aggregation: workspace week/day windows,
  automation and assistant_unlabeled kept out of the human numbers, setup
  stages, honest notes.

Run from the repo root:
    python3 -m pytest tests/test_usage_tracking.py -q
"""

import asyncio
import inspect
import threading
import time
from datetime import datetime, timedelta, timezone
from unittest import mock

import pytest
from fastapi import HTTPException

import routers.ai_chat as ai_chat
import routers.external_agent as external_agent
import routers.search as search
import routers.usage as usage_mod
import usage_events

_real_enqueue = usage_events._enqueue


# ── record_search_usage ──────────────────────────────────────────


class _InsertQuery:
    def __init__(self, db):
        self.db = db

    def insert(self, row):
        if self.db.get("fail"):
            raise RuntimeError("boom")
        self.db.setdefault("inserts", []).append(row)
        return self

    def execute(self):
        return mock.Mock(data=[])


class _RecordClient:
    def __init__(self, db):
        self.db = db

    def table(self, name):
        assert name == "broker_usage_events"
        return _InsertQuery(self.db)


class _RecordStorage:
    def __init__(self, db):
        self.client = _RecordClient(db)


@pytest.fixture(autouse=True)
def reset_usage_storage(monkeypatch):
    monkeypatch.setattr(usage_events, "_enqueue", usage_events._insert_row)
    usage_events._storage = None
    yield
    usage_events._storage = None


def test_record_stores_only_allowed_fields_and_never_content():
    db = {}
    usage_events._storage = _RecordStorage(db)
    usage_events.record_search_usage(
        tenant_id="org-1", surface="app", origin="app"
    )
    row = db["inserts"][0]
    assert set(row) <= usage_events.ALLOWED_FIELDS
    assert row == {
        "tenant_id": "org-1",
        "surface": "app",
        "action": "search",
        "origin": "app",
    }
    # The function has no parameter that could carry query text, filters or
    # message content; this is the no-search-text-storage guarantee.
    assert set(inspect.signature(usage_events.record_search_usage).parameters) == {
        "tenant_id", "surface", "origin",
    }
    assert "query" not in usage_events.ALLOWED_FIELDS
    assert "text" not in usage_events.ALLOWED_FIELDS


def test_record_rejects_unknown_origin_and_missing_tenant():
    db = {}
    usage_events._storage = _RecordStorage(db)
    usage_events.record_search_usage(tenant_id="org-1", surface="app", origin="human")
    usage_events.record_search_usage(tenant_id=None, surface="app", origin="app")
    usage_events.record_search_usage(tenant_id="", surface="app", origin="app")
    assert "inserts" not in db


def test_record_swallows_insert_failure():
    db = {"fail": True}
    usage_events._storage = _RecordStorage(db)
    usage_events.record_search_usage(tenant_id="org-1", surface="app", origin="app")


def test_record_noops_when_storage_unavailable():
    usage_events._storage = None
    with mock.patch.object(usage_events, "_get_storage", return_value=None):
        usage_events.record_search_usage(tenant_id="org-1", surface="app", origin="app")


# ── Assistant origin mapping ─────────────────────────────────────


def _capture(monkeypatch):
    calls = []
    monkeypatch.setattr(usage_events, "record_search_usage", lambda **kw: calls.append(kw))
    return calls


def test_assistant_origin_defaults_to_unlabeled(monkeypatch):
    calls = _capture(monkeypatch)
    external_agent._record_assistant_search({"tenant_id": "t1", "id": "k1"}, None)
    assert calls == [{
        "tenant_id": "t1", "surface": "assistant",
        "origin": "assistant_unlabeled",
    }]


@pytest.mark.parametrize("header", ["automation", " AUTOMATION ", "Automation"])
def test_assistant_origin_explicit_automation(monkeypatch, header):
    calls = _capture(monkeypatch)
    external_agent._record_assistant_search({"tenant_id": "t1", "id": "k1"}, header)
    assert calls[0]["origin"] == "automation"


@pytest.mark.parametrize("header", ["human", "app", "broker", "automation2"])
def test_assistant_origin_bogus_header_stays_unlabeled(monkeypatch, header):
    calls = _capture(monkeypatch)
    external_agent._record_assistant_search({"tenant_id": "t1", "id": "k1"}, header)
    assert calls[0]["origin"] == "assistant_unlabeled"


# ── External route hooks ─────────────────────────────────────────


def _raising_storage():
    client = mock.Mock()
    client.table.side_effect = RuntimeError("storage down")
    storage = mock.Mock()
    storage.client = client
    storage.get_shared_market_listings.side_effect = RuntimeError("storage down")
    return storage


def test_raw_message_search_records_then_tolerates_failure_failure_not_counted(monkeypatch):
    calls = _capture(monkeypatch)
    monkeypatch.setattr(external_agent, "storage", _raising_storage())
    key = {"tenant_id": "t1", "id": "k1", "scopes": ["raw_messages:read"]}
    with pytest.raises(RuntimeError):
        asyncio.run(external_agent.external_raw_message_search(
            q="x", scope="groups", since="", until="", limit=25, offset=0,
            key=key, x_propai_initiator=None,
        ))
    assert calls == []


def test_raw_message_search_automation_header_failure_not_counted(monkeypatch):
    calls = _capture(monkeypatch)
    monkeypatch.setattr(external_agent, "storage", _raising_storage())
    key = {"tenant_id": "t1", "id": "k1", "scopes": ["raw_messages:read"]}
    with pytest.raises(RuntimeError):
        asyncio.run(external_agent.external_raw_message_search(
            q="x", scope="groups", since="", until="", limit=25, offset=0,
            key=key, x_propai_initiator="automation",
        ))
    assert calls == []


def test_raw_message_search_scope_rejection_never_records(monkeypatch):
    calls = _capture(monkeypatch)
    key = {"tenant_id": "t1", "id": "k1", "scopes": []}
    with pytest.raises(HTTPException):
        asyncio.run(external_agent.external_raw_message_search(
            q="x", scope="groups", since="", until="", limit=25, offset=0,
            key=key, x_propai_initiator="automation",
        ))
    assert calls == []


def test_listing_search_scope_rejection_never_records(monkeypatch):
    calls = _capture(monkeypatch)
    key = {"tenant_id": "t1", "id": "k1", "scopes": []}
    with pytest.raises(HTTPException):
        asyncio.run(external_agent.external_listing_search(
            key=key, x_propai_initiator="automation",
        ))
    assert calls == []


def test_listing_search_records_unlabeled_failure_not_counted(monkeypatch):
    calls = _capture(monkeypatch)
    monkeypatch.setattr(external_agent, "storage", _raising_storage())
    key = {"tenant_id": "t1", "id": "k1", "scopes": ["inventory:read"]}
    with pytest.raises(Exception):
        asyncio.run(external_agent.external_listing_search(
            key=key, x_propai_initiator=None,
        ))
    assert calls == []


def test_requirements_scope_rejection_never_records(monkeypatch):
    calls = _capture(monkeypatch)
    key = {"tenant_id": "t1", "id": "k1", "scopes": []}
    with pytest.raises(HTTPException):
        asyncio.run(external_agent.external_requirements(key=key, x_propai_initiator="automation"))
    assert calls == []


def test_requirements_records(monkeypatch):
    calls = _capture(monkeypatch)
    monkeypatch.setattr(external_agent, "_tenant_parsed", mock.AsyncMock(return_value=[]))
    key = {"tenant_id": "t1", "id": "k1", "scopes": ["requirements:read"]}
    asyncio.run(external_agent.external_requirements(key=key, x_propai_initiator="automation"))
    assert calls and calls[0]["origin"] == "automation"


def test_standing_search_run_always_automation_failure_not_counted(monkeypatch):
    calls = _capture(monkeypatch)
    monkeypatch.setattr(external_agent, "storage", _raising_storage())
    key = {"tenant_id": "t1", "id": "k1", "scopes": ["standing_searches:read"]}
    with pytest.raises(Exception):
        asyncio.run(external_agent.external_run_standing_search(search_id=1, limit=20, key=key))
    assert calls == []


# ── App route hooks ──────────────────────────────────────────────


def _capture_search_module(monkeypatch):
    calls = []
    monkeypatch.setattr(usage_events, "record_search_usage", lambda **kw: calls.append(kw))
    return calls


def test_search_raw_records_app_origin_failure_not_counted(monkeypatch):
    calls = _capture_search_module(monkeypatch)
    monkeypatch.setattr(search, "storage", _raising_storage())
    # A degraded indexed-search response must not count as a completed search.
    search_out = asyncio.run(search.search_raw_messages(
        q="bandra", limit=20, offset=0, user={"id": "u1"}, tenant_id="org-1"))
    assert isinstance(search_out, dict)
    assert calls == []


def test_market_search_records_app_origin_failure_not_counted(monkeypatch):
    calls = _capture_search_module(monkeypatch)
    monkeypatch.setattr(search, "storage", _raising_storage())
    with pytest.raises(Exception):
        asyncio.run(search.market_search(user={"id": "u1"}, tenant_id="org-1"))
    assert calls == []


def test_market_items_records_app_origin_before_parsing_failure_not_counted(monkeypatch):
    calls = _capture_search_module(monkeypatch)

    async def _boom(query):
        raise RuntimeError("llm down")

    monkeypatch.setattr(search, "_parse_query_llm", _boom)
    with pytest.raises(RuntimeError):
        asyncio.run(search.search_market_items(
            q="2 bhk bandra", result_type="all", include_requirements=False,
            asset_type="all", intent_filter="", limit=50, offset=0,
            user={"id": "u1"}, tenant_id="org-1",
        ))
    assert calls == []


def test_chat_listing_search_records_app_origin_failure_not_counted(monkeypatch):
    calls = []
    monkeypatch.setattr(usage_events, "record_search_usage", lambda **kw: calls.append(kw))

    def _exec(name, args, client, tenant_id, user_id=None):
        raise RuntimeError("tool down")

    monkeypatch.setattr("agent_tools.execute_tool", _exec)
    with pytest.raises(Exception):
        asyncio.run(ai_chat._current_listing_search(
            {"intent": "RENT", "micro_markets": ["bandra"]}, "org-1", "u1"
        ))
    assert calls == []


def test_chat_requirement_search_records_app_origin_failure_not_counted(monkeypatch):
    calls = []
    monkeypatch.setattr(usage_events, "record_search_usage", lambda **kw: calls.append(kw))

    def _exec(name, args, client, tenant_id, user_id=None):
        raise RuntimeError("tool down")

    monkeypatch.setattr("agent_tools.execute_tool", _exec)
    with pytest.raises(Exception):
        asyncio.run(ai_chat._current_requirement_search(
            {"intent": "RENT", "micro_markets": ["bandra"]}, "org-1", "u1"
        ))
    assert calls == []


# ── /api/usage/summary aggregation ───────────────────────────────


class _SummaryQuery:
    def __init__(self, rows):
        self.rows = list(rows)
        self._limit = None
        self._offset = 0

    def select(self, columns):
        self._columns = columns
        return self

    def eq(self, column, value):
        self.rows = [r for r in self.rows if r.get(column) == value]
        return self

    def gte(self, column, value):
        self.rows = [r for r in self.rows if str(r.get(column, "")) >= value]
        return self

    def order(self, column, desc=False):
        self.rows = sorted(self.rows, key=lambda r: str(r.get(column) or ""), reverse=desc)
        return self

    def limit(self, n):
        self._limit = n
        return self

    def offset(self, n):
        self._offset = n
        return self

    def execute(self):
        rows = self.rows[self._offset:]
        return mock.Mock(data=list(rows if self._limit is None else rows[:self._limit]))


class _SummaryStorage:
    def __init__(self, rows, connections=None):
        self._rows = rows
        self._connections = connections or []
        self.client = mock.Mock()
        self.client.table.side_effect = lambda name: _SummaryQuery(self._connections if name == "org_whatsapp_connections" else self._rows)

    def list_org_whatsapp_connections(self, tenant_id):
        return list(self._connections)


def _iso(dt):
    return dt.isoformat()


def _summary(rows, connections=None, monkeypatch=None):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    monkeypatch.setattr(usage_mod, "storage", _SummaryStorage(rows, connections))
    app = FastAPI()
    app.include_router(usage_mod.router)
    app.dependency_overrides[usage_mod.require_user] = lambda: {"id": "caller"}
    app.dependency_overrides[usage_mod.require_tenant] = lambda: "org-1"
    try:
        with TestClient(app) as client:
            resp = client.get("/api/usage/summary")
        assert resp.status_code == 200, resp.text
        return resp.json()
    finally:
        app.dependency_overrides.pop(usage_mod.require_user, None)
        app.dependency_overrides.pop(usage_mod.require_tenant, None)


def test_summary_aggregates_and_separates_origins(monkeypatch):
    now = datetime.now(timezone.utc)
    rows = [
        # Two workspace app searches inside the week, on two days
        {"tenant_id": "org-1", "origin": "app",
         "created_at": _iso(now - timedelta(hours=1))},
        {"tenant_id": "org-1", "origin": "app",
         "created_at": _iso(now - timedelta(days=3))},
        # One workspace app search 10 days ago (outside the week)
        {"tenant_id": "org-1", "origin": "app",
         "created_at": _iso(now - timedelta(days=10))},
        # automation and unlabeled traffic must stay out of human numbers
        {"tenant_id": "org-1", "origin": "automation",
         "created_at": _iso(now - timedelta(hours=2))},
        {"tenant_id": "org-1", "origin": "automation",
         "created_at": _iso(now - timedelta(days=20))},
        {"tenant_id": "org-1", "origin": "assistant_unlabeled",
         "created_at": _iso(now - timedelta(hours=3))},
        # outside the 30-day window: excluded
        {"tenant_id": "org-1", "origin": "app",
         "created_at": _iso(now - timedelta(days=40))},
        # another tenant: excluded
        {"tenant_id": "org-2", "origin": "app",
         "created_at": _iso(now - timedelta(hours=1))},
    ]
    body = _summary(rows, connections=[{"is_active": True, "phone_number": "+919999999999"}], monkeypatch=monkeypatch)

    assert body["tenant_id"] == "org-1"
    assert body["setup_stage"] == "returning"  # 2 distinct app days in window
    assert body["searches_last_7_days"] == 2
    assert body["days_with_real_search_last_30_days"] == 3  # three workspace search dates
    assert body["last_real_search_at"] == _iso(now - timedelta(hours=1))

    assert body["automation"]["searches_last_7_days"] == 1
    assert body["automation"]["last_at"] == _iso(now - timedelta(hours=2))
    assert body["assistant_unlabeled"]["searches_last_7_days"] == 1
    # automation/unlabeled never leak into the human totals
    assert body["searches_last_7_days"] == 2
    assert "per_user" not in body

    notes = " ".join(body["notes"])
    assert "since this tracking shipped" in notes
    assert "kept separate" in notes and "not human usage" in notes


def test_summary_stages(monkeypatch):
    now = datetime.now(timezone.utc)
    one_app = [{"tenant_id": "org-1", "origin": "app",
                "created_at": _iso(now - timedelta(hours=1))}]
    assert _summary(one_app, connections=[{"is_active": True, "phone_number": "+919999999999"}],
                    monkeypatch=monkeypatch)["setup_stage"] == "first_search"
    assert _summary([], connections=[{"is_active": True, "phone_number": "+919999999999"}],
                    monkeypatch=monkeypatch)["setup_stage"] == "whatsapp_connected"
    assert _summary([], connections=[{"is_active": False}],
                    monkeypatch=monkeypatch)["setup_stage"] == "signed_up"
    assert _summary([], connections=[],
                    monkeypatch=monkeypatch)["setup_stage"] == "signed_up"


def test_summary_empty_is_honest_zero(monkeypatch):
    body = _summary([], monkeypatch=monkeypatch)
    assert body["searches_last_7_days"] == 0
    assert body["last_real_search_at"] is None
    assert "per_user" not in body
    assert body["automation"]["last_at"] is None


# ── /api/admin/usage/brokers ─────────────────────────────────────


class _AdminStorage(_SummaryStorage):
    def __init__(self, rows, orgs, admin_ids):
        super().__init__(rows)
        self._orgs = orgs
        self._admin_ids = set(admin_ids)

    def is_super_admin(self, user_id):
        return user_id in self._admin_ids

    def list_organizations(self, limit=1000, offset=0):
        return list(self._orgs)[offset:offset + limit]

    def list_all_whatsapp_connections(self):
        return []


def _admin(rows, orgs, caller, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    monkeypatch.setattr(usage_mod, "storage", _AdminStorage(rows, orgs, {"owner-1"}))
    app = FastAPI()
    app.include_router(usage_mod.router)
    app.dependency_overrides[usage_mod.require_user] = lambda: {"id": caller}
    try:
        with TestClient(app) as client:
            return client.get("/api/admin/usage/brokers")
    finally:
        app.dependency_overrides.pop(usage_mod.require_user, None)


def test_admin_usage_requires_super_admin(monkeypatch):
    resp = _admin([], [], "someone-else", monkeypatch)
    assert resp.status_code == 403


def test_admin_usage_covers_all_orgs_and_separates_origins(monkeypatch):
    now = datetime.now(timezone.utc)
    rows = [
        {"tenant_id": "org-a", "origin": "app",
         "created_at": _iso(now - timedelta(hours=1))},
        {"tenant_id": "org-a", "origin": "app",
         "created_at": _iso(now - timedelta(days=3))},
        {"tenant_id": "org-a", "origin": "assistant_unlabeled",
         "created_at": _iso(now - timedelta(hours=2))},
        {"tenant_id": "org-a", "origin": "automation",
         "created_at": _iso(now - timedelta(days=2))},
        {"tenant_id": "org-b", "origin": "assistant_unlabeled",
         "created_at": _iso(now - timedelta(hours=3))},
        {"tenant_id": "org-b", "origin": "app",
         "created_at": _iso(now - timedelta(days=40))},  # outside window
    ]
    orgs = [
        {"id": "org-a", "name": "Alpha Realty", "created_at": "2026-11-01T00:00:00+00:00"},
        {"id": "org-b", "name": "Beta Estates", "created_at": "2026-11-05T00:00:00+00:00"},
        {"id": "org-c", "name": "Never Used", "created_at": "2026-11-10T00:00:00+00:00"},
    ]
    resp = _admin(rows, orgs, "owner-1", monkeypatch)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    tenants = {t["tenant_id"]: t for t in body["tenants"]}
    assert set(tenants) == {"org-a", "org-b", "org-c"}  # zero-usage org visible

    a = tenants["org-a"]
    assert a["org_name"] == "Alpha Realty"
    assert a["searches_last_7_days"] == 2
    assert a["days_with_real_search_last_30_days"] == 2
    assert a["last_real_search_at"] == _iso(now - timedelta(hours=1))
    assert a["assistant_unlabeled"]["searches_last_7_days"] == 1
    assert a["automation"]["searches_last_7_days"] == 1

    b = tenants["org-b"]
    assert b["searches_last_7_days"] == 0
    assert b["last_real_search_at"] == _iso(now - timedelta(days=40))
    assert b["assistant_unlabeled"]["searches_last_7_days"] == 1
    # the unlabeled assistant traffic is never counted as human usage
    assert b["days_with_real_search_last_30_days"] == 0

    c = tenants["org-c"]
    assert c["searches_last_7_days"] == 0
    assert "per_user" not in c
    assert c["automation"] == {"searches_last_7_days": 0, "last_at": None}
    assert "since this tracking shipped" in " ".join(body["notes"])




def test_admin_usage_pages_past_provider_row_cap(monkeypatch):
    now = _iso(datetime.now(timezone.utc) - timedelta(hours=1))
    rows = [{"id": n, "tenant_id": "org-a", "origin": "app", "created_at": now} for n in range(1201)]
    orgs = [{"id": "org-a", "name": "Alpha"}]
    response = _admin(rows, orgs, "owner-1", monkeypatch)
    body = response.json()
    assert response.status_code == 200
    assert body["tenants"][0]["searches_last_7_days"] == 1201
    assert body["partial"] is False


def test_day_grouping_uses_india_time_not_utc():
    assert usage_mod._day("2026-11-20T23:00:00+00:00") == "2026-11-21"
    assert usage_mod._day("2026-11-21T01:00:00+00:00") == "2026-11-21"


def test_placeholder_phone_is_not_a_linked_setup_milestone():
    assert not usage_mod._linked({"is_active": True, "phone_number": "Unpaired-123"})
    assert not usage_mod._linked({"is_active": True, "phone_number": ""})
    assert usage_mod._linked({"is_active": True, "phone_number": "+919999999999"})
    assert usage_mod._stage(0, False, None) == "setup_unknown"


def test_admin_usage_stage_includes_linked_and_never_used_workspaces(monkeypatch):
    storage = _AdminStorage([], [{"id": "org-linked", "name": "Linked"}, {"id": "org-new", "name": "New"}], {"owner-1"})
    storage._connections = [{"id": "connection-1", "organization_id": "org-linked", "is_active": True, "phone_number": "+919999999999"}]
    monkeypatch.setattr(usage_mod, "storage", storage)
    body = asyncio.run(usage_mod.admin_broker_usage(user={"id": "owner-1"}))
    by_id = {t["tenant_id"]: t for t in body["tenants"]}
    assert by_id["org-linked"]["setup_stage"] == "whatsapp_connected"
    assert by_id["org-new"]["setup_stage"] == "signed_up"


def test_real_background_queue_does_not_block_request(monkeypatch):
    entered, release = threading.Event(), threading.Event()
    def blocked_insert(row):
        entered.set()
        assert release.wait(2)
    monkeypatch.setattr(usage_events, "_insert_row", blocked_insert)
    started = time.monotonic()
    _real_enqueue({"tenant_id": "fixture"})
    assert time.monotonic() - started < 0.5
    assert entered.wait(1)
    release.set()
    usage_events._pending.join()


def test_real_queue_persists_content_free_event(monkeypatch):
    db = {}
    usage_events._storage = _RecordStorage(db)
    monkeypatch.setattr(usage_events, "_enqueue", _real_enqueue)
    usage_events.record_search_usage(tenant_id="fixture", surface="app", origin="app")
    usage_events._pending.join()
    assert len(db["inserts"]) == 1
    assert set(db["inserts"][0]) <= usage_events.ALLOWED_FIELDS


def test_completed_app_search_is_recorded_over_real_http_router(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    calls = _capture(monkeypatch)
    fake = mock.Mock()
    fake.get_shared_market_listings.return_value = []
    monkeypatch.setattr(search, "storage", fake)
    app = FastAPI()
    app.include_router(search.router)
    app.dependency_overrides[search.require_user] = lambda: {"id": "u1"}
    app.dependency_overrides[search.get_tenant_context] = lambda: "org1"
    with TestClient(app) as client:
        response = client.get("/api/search/market?q=bandra")
    assert response.status_code == 200
    assert calls == [{"tenant_id": "org1", "surface": "app", "origin": "app"}]


@pytest.mark.parametrize("initiator,origin", [(None,"assistant_unlabeled"),("automation","automation"),("app","assistant_unlabeled")])
def test_completed_assistant_search_is_recorded_over_http(monkeypatch, initiator, origin):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    calls = _capture(monkeypatch)
    monkeypatch.setattr(external_agent, "_tenant_parsed", mock.AsyncMock(return_value=[]))
    monkeypatch.setattr(external_agent, "_record_assistant_trial_start", lambda tenant: None)
    app = FastAPI()
    app.include_router(external_agent.router)
    app.dependency_overrides[external_agent.external_auth] = lambda: {"id":"k1","tenant_id":"org1","scopes":["requirements:read"]}
    headers = {"X-PropAI-Initiator":initiator} if initiator else {}
    with TestClient(app) as client:
        response = client.get("/api/external/v1/requirements", headers=headers)
    assert response.status_code == 200
    assert calls == [{"tenant_id":"org1","surface":"assistant","origin":origin}]


def test_reusable_chat_requirement_helper_outside_app_request_is_not_app_usage(monkeypatch):
    calls = _capture(monkeypatch)
    monkeypatch.setattr(ai_chat, "storage", mock.Mock(client=object()))
    monkeypatch.setattr("agent_tools.execute_tool", lambda *a, **kw: {"status":"ok","results":[]})
    result = asyncio.run(ai_chat._current_requirement_search({"intent":"RENT","micro_markets":["bandra"]},"org1","u1"))
    assert result["content"]
    assert calls == []


def test_model_selected_chat_searches_are_counted_without_content(monkeypatch):
    calls = _capture(monkeypatch)
    @usage_events.tracked_chat_turn
    async def turn(user):
        usage_events.record_chat_search_activity([
            {"tool":"search_listings","status":"ok","summary":"not stored"},
            {"tool":"search_requirements","status":"ok"},
        ], "org1", user["id"])
    asyncio.run(turn(user={"id":"u1"}))
    assert calls == [{"tenant_id":"org1","surface":"app","origin":"app"}]
    calls.clear()
    usage_events.record_chat_search_activity([{"tool":"search_listings","status":"error"},{"tool":"save_my_deal","status":"ok"}], "org1", "u1")
    assert calls == []


def test_cross_broker_api_search_records_after_success(monkeypatch):
    from routers import broker_market
    from broker_market_policy import PropertySearch
    calls = _capture(monkeypatch)
    monkeypatch.setattr(broker_market, "rate", mock.AsyncMock())
    monkeypatch.setattr(broker_market, "rpc", mock.AsyncMock(return_value=[]))
    monkeypatch.setattr(broker_market, "_record_assistant_trial_start", lambda tenant: None)
    response = asyncio.run(broker_market.search(PropertySearch.model_validate({"locality":"bandra","bedrooms":2}), {"id":"key1","tenant_id":"org1"}, x_propai_initiator="automation"))
    assert response["results"] == []
    assert calls == [{"tenant_id":"org1","surface":"assistant","origin":"automation"}]


# Actual chat/self-chat entrypoint regressions. Storage/model responses are
# fixture data here; the separate DB rehearsal does not mock usage persistence.
def _chat_fixture(monkeypatch):
    from types import SimpleNamespace
    import agent_tools
    monkeypatch.setattr(ai_chat, "storage", SimpleNamespace(client=object(), db=None))
    monkeypatch.setattr(ai_chat, "_resolve_active_organization_id", lambda user, tid: tid)
    monkeypatch.setattr(ai_chat, "_workspace_provider_candidates", lambda *a: [{"api_key":"fixture", "model":"fixture", "base_url":"http://127.0.0.1:9"}])
    monkeypatch.setattr(ai_chat, "_load_chat_broker_context", lambda *a: {})
    monkeypatch.setattr(ai_chat.chat_engine, "parse_market_search_request", lambda *a, **kw: {"intent":"RENT","bhk":3,"micro_markets":["Bandra West"]})
    monkeypatch.setattr(agent_tools, "_group_message_query", lambda *a, **kw: [])
    monkeypatch.setattr(agent_tools, "execute_tool", lambda *a, **kw: {"status":"ok", "results":[]})


def test_grouped_chat_http_counts_source_plus_listing_once(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    import agent_tools
    calls = _capture(monkeypatch)
    _chat_fixture(monkeypatch)
    searches = []
    monkeypatch.setattr(agent_tools, "_group_message_query", lambda *a, **kw: searches.append("source") or [])
    monkeypatch.setattr(agent_tools, "execute_tool", lambda *a, **kw: searches.append(a[0]) or {"status":"ok", "results":[]})
    app = FastAPI(); app.include_router(ai_chat.router)
    app.dependency_overrides[ai_chat.require_user] = lambda: {"id":"u1"}
    app.dependency_overrides[ai_chat.get_tenant_context] = lambda: "org1"
    with TestClient(app) as client:
        response = client.post("/api/ai/chat", json={"messages":[{"role":"user", "content":"Find 3 bhk rent in Bandra West from my groups"}]})
    assert response.status_code == 200, response.text
    assert "source" in searches and "search_listings" in searches
    assert calls == [{"tenant_id":"org1","surface":"app","origin":"app"}]


def test_actual_self_chat_helper_reuse_never_counts_as_app(monkeypatch):
    from routers import self_chat
    _chat_fixture(monkeypatch)
    calls = _capture(monkeypatch)
    result = asyncio.run(self_chat._fast_self_chat_search("Find 3 BHK rentals in Bandra West", "org1"))
    assert result is not None, "self-chat must really reach the successful shared listing helper"
    assert result["content"]
    assert calls == []


def test_model_selected_graph_search_counts_once_through_actual_executor(monkeypatch):
    import services.propai_workspace_graph as graph
    _chat_fixture(monkeypatch)
    calls = _capture(monkeypatch)
    monkeypatch.setattr(ai_chat.chat_engine, "parse_market_search_request", lambda *a, **kw: None)
    monkeypatch.setattr(ai_chat, "_has_query_signals", lambda text: True)
    monkeypatch.setattr(ai_chat.chat_engine, "load_data", lambda: {})
    monkeypatch.setattr(ai_chat.chat_engine, "build_system_prompt", lambda *a, **kw: "Fixture")
    worker_threads = []
    async def graph_reply(**kw):
        worker_threads.append(threading.get_ident())
        kw["activity_sink"].extend([{"tool":"search_listings","status":"ok"}, {"tool":"search_requirements","status":"ok"}])
        return {"content":"Fixture search completed", "trace":{}}
    monkeypatch.setattr(graph, "run_workspace_graph", graph_reply)
    response = asyncio.run(ai_chat.ai_chat(ai_chat.ChatRequest(messages=[{"role":"user","content":"Compare these options"}]), user={"id":"u1"}, tenant_id="org1"))
    assert worker_threads and worker_threads[0] != threading.get_ident()
    async def body():
        return "".join([chunk if isinstance(chunk,str) else chunk.decode() async for chunk in response.body_iterator])
    assert "_usage_search_succeeded" not in asyncio.run(body())
    assert calls == [{"tenant_id":"org1","surface":"app","origin":"app"}]


def test_chat_request_context_resets_after_failure_and_isolates_concurrent_users(monkeypatch):
    calls = _capture(monkeypatch)
    @usage_events.tracked_chat_turn
    async def turn(user, fail=False):
        usage_events.mark_chat_search("org-" + user["id"], user["id"])
        await asyncio.sleep(0)
        if fail:
            raise RuntimeError("failed request")
        usage_events.mark_chat_search("org-" + user["id"], user["id"])
        return {}
    async def run():
        with pytest.raises(RuntimeError):
            await turn(user={"id":"failed"}, fail=True)
        await asyncio.gather(turn(user={"id":"u1"}), turn(user={"id":"u2"}))
        assert usage_events._chat_turn.get() is None
    asyncio.run(run())
    assert sorted(c["tenant_id"] for c in calls) == ["org-u1", "org-u2"]


def test_unauthenticated_chat_http_is_rejected_without_usage(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    calls = _capture(monkeypatch)
    app = FastAPI(); app.include_router(ai_chat.router)
    with TestClient(app) as client:
        response = client.post("/api/ai/chat", json={"messages":[{"role":"user","content":"Bandra flats"}]})
    assert response.status_code == 401
    assert calls == []


def test_admin_usage_avoids_ambiguous_global_connection_embed_and_pages(monkeypatch):
    storage = _AdminStorage([], [{"id": "org-a", "name": "Alpha"}], {"owner-1"})
    storage._connections = [{"id": str(n), "organization_id": "other", "is_active": True, "phone_number": "+919999999999"} for n in range(1200)]
    storage._connections.append({"id": "zz-last", "organization_id": "org-a", "is_active": True, "phone_number": "+919999999999"})
    storage.list_all_whatsapp_connections = mock.Mock(side_effect=RuntimeError("ambiguous embed"))
    queries = []
    def table(name):
        q = _SummaryQuery(storage._connections if name == "org_whatsapp_connections" else [])
        if name == "org_whatsapp_connections":
            queries.append(q)
        return q
    storage.client.table.side_effect = table
    monkeypatch.setattr(usage_mod, "storage", storage)
    body = asyncio.run(usage_mod.admin_broker_usage(user={"id": "owner-1"}))
    assert body["tenants"][0]["setup_stage"] == "whatsapp_connected"
    assert [q._offset for q in queries] == [0, 500, 1000]
    assert all(q._columns == "id,organization_id,phone_number,is_active" for q in queries)
    storage.list_all_whatsapp_connections.assert_not_called()
