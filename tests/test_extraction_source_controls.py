"""No network/provider/database use: exercise actual control code and routes."""
import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import ai_extraction
import extraction
import extraction_worker
from extraction_controls import ExtractionPaused, provider_control, source_context
from storage.supabase import SupabaseStorage


class Query:
    def __init__(self, rows):
        self.rows = rows
        self.filters = []
    def select(self, *_): return self
    def eq(self, *args):
        self.filters.append(args)
        return self
    def execute(self): return SimpleNamespace(data=self.rows)


def source_storage(rows):
    query = Query(rows)
    class Storage:
        client = SimpleNamespace(table=lambda _: query)
        is_extraction_allowed_for_source = SupabaseStorage.is_extraction_allowed_for_source
    return Storage(), query


def connection(broker, status="running", **extra):
    return dict(id=broker, broker_id=broker, instance_name="phone-" + broker,
                is_active=True, extraction_status=status, **extra)


@pytest.mark.parametrize("broker,expected", [("a", False), ("b", True), ("missing", False)])
def test_actual_storage_mixed_workspace_does_not_borrow_running_phone(broker, expected):
    storage, query = source_storage([connection("a", "paused"), connection("b")])
    assert storage.is_extraction_allowed_for_source("tenant-a", broker_id=broker) is expected
    assert query.filters == [("organization_id", "tenant-a")]


@pytest.mark.parametrize("rows,source", [
    ([connection("a")], {}),
    ([connection("a"), connection("a")], {"broker_id": "a"}),
    ([connection("a")], {"broker_id": "a", "instance": "phone-b"}),
    ([dict(connection("a"), is_active=False)], {"broker_id": "a"}),
    ([dict(connection("a"), extraction_status=None)], {"broker_id": "a"}),
])
def test_unknown_ambiguous_conflicting_inactive_and_missing_state_fail_closed(rows, source):
    storage, _ = source_storage(rows)
    assert storage.is_extraction_allowed_for_source("tenant-a", **source) is False


def test_instance_resolution_and_lookup_failure():
    storage, query = source_storage([connection("a")])
    assert storage.is_extraction_allowed_for_source("tenant-a", instance="phone-a")
    query.execute = lambda: (_ for _ in ()).throw(RuntimeError("offline"))
    assert not storage.is_extraction_allowed_for_source("tenant-a", broker_id="a")


def test_raw_metadata_roundtrip_worker():
    row = dict(id=1, tenant_id="tenant-a", raw_payload={"instance": "phone-a", "data": {"broker_id": "a"}})
    ctx = extraction_worker.context_from_raw(row)
    assert source_context(ctx) == {"broker_id": "a", "instance": "phone-a"}


def test_real_pipeline_blocks_mixed_source_without_touching_classifier(monkeypatch):
    storage, _ = source_storage([connection("a", "paused"), connection("b")])
    monkeypatch.setattr(extraction, "market_scope_skip_reason", lambda *a: pytest.fail("pipeline entered"))
    result = extraction.process_raw_message(1, {"tenant_id": "tenant-a", "broker_id": "a"}, storage)
    assert result["extraction_source"] == "extraction_control:not_running"
    assert provider_control.get() is None


def test_provider_rechecks_after_cooldown_and_does_not_fall_back(monkeypatch):
    state = {"allowed": True, "dispatches": 0}
    storage = SimpleNamespace(is_extraction_allowed_for_source=lambda *a, **k: state["allowed"])
    token = provider_control.set((storage, "tenant-a", {"broker_id": "a"}))
    class Client:
        def __init__(self, **kw):
            assert kw["max_retries"] == 0
            self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))
        def create(self, **kw):
            state["dispatches"] += 1
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='{}'), finish_reason="stop")], usage=None)
    monkeypatch.setattr(ai_extraction, "OpenAI", Client)
    monkeypatch.setattr(ai_extraction, "_wait_for_provider_cooldown", lambda _: state.update(allowed=False))
    try:
        with pytest.raises(ExtractionPaused):
            ai_extraction._call_provider({"name": "fake", "model": "fake", "api_key": "not-real", "base_url": "https://example.invalid"}, [])
        assert state["dispatches"] == 0
    finally:
        provider_control.reset(token)


def test_admin_retry_denied_before_queue_mutation(monkeypatch):
    from routers import listings
    storage, _ = source_storage([connection("a", "paused"), connection("b")])
    storage.is_super_admin = lambda _: True
    storage.get_raw_message = lambda *a, **k: {"raw_payload": {"data": {"broker_id": "a"}}}
    storage.retry_raw_extraction = lambda *a: pytest.fail("queue mutated")
    monkeypatch.setattr(listings, "storage", storage)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(listings.retry_extraction(1, {"id": "admin"}, "tenant-a"))
    assert exc.value.status_code == 409


def test_worker_paused_source_never_begins_attempt(monkeypatch):
    storage, _ = source_storage([connection("a", "paused"), connection("b")])
    storage.begin_raw_extraction_attempt = lambda *a, **k: pytest.fail("attempt consumed")
    monkeypatch.setattr(extraction_worker, "process_raw_message", lambda *a, **k: pytest.fail("pipeline entered"))
    stats = extraction_worker._process_lane(storage, [{"id": 1, "tenant_id": "tenant-a", "message": "2 BHK for rent in Bandra West carpet 900 sqft", "raw_payload": {"data": {"broker_id": "a"}}}], "recent", 1, {})
    assert stats["attempted"] == 0
    assert stats["failed"] == 0


def test_external_extract_checks_source_before_releasing_queue(monkeypatch):
    from routers import external_agent
    source = {"id": 1, "tenant_id": "tenant-a", "is_group": True, "group_name": "Test", "raw_payload": {"data": {"broker_id": "a", "key": {"remoteJid": "group@g.us"}}}}
    class RouteQuery(Query):
        def limit(self, *_): return self
        def or_(self, *_): return self
    class Client:
        def table(self, name):
            return RouteQuery({"raw_messages": [source], "organization_group_connections": [{"whatsapp_connection_id": 1}], "public_market_publication_allowlist": [{"enabled": True}], "org_whatsapp_connections": [connection("a", "paused"), connection("b")]}[name])
    storage = SimpleNamespace(client=Client(), retry_raw_extraction=lambda *a: pytest.fail("queue mutated"))
    storage.is_extraction_allowed_for_source = lambda *a, **k: SupabaseStorage.is_extraction_allowed_for_source(storage, *a, **k)
    monkeypatch.setattr(external_agent, "storage", storage)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(external_agent.external_raw_message_extract(1, {"tenant_id": "tenant-a", "scopes": [external_agent.EXTRACTION_SCOPE]}))
    assert exc.value.status_code == 409


def test_internal_trigger_does_not_schedule_paused_source(monkeypatch):
    from routers import infra
    from starlette.requests import Request
    monkeypatch.setenv("PROPAI_INTERNAL_TOKEN", "fixture-token")
    monkeypatch.setenv("PROPAI_API_IMMEDIATE_EXTRACTION", "1")
    storage, _ = source_storage([connection("a", "paused"), connection("b")])
    storage.get_raw_message = lambda *a, **k: SimpleNamespace(raw_payload={"data": {"broker_id": "a"}})
    monkeypatch.setattr(infra, "storage", storage)
    monkeypatch.setattr(infra, "_schedule_raw_extraction", lambda *a: pytest.fail("scheduled"))
    request = Request({"type": "http", "headers": [(b"x-propai-internal-token", b"fixture-token")]})
    result = asyncio.run(infra.trigger_extraction(infra.TriggerExtractionRequest(raw_id=1, tenant_id="tenant-a"), request))
    assert result["extraction_paused"] is True


def test_context_restored_on_pipeline_exception(monkeypatch):
    monkeypatch.setattr(extraction, "_process_raw_message", lambda *a: (_ for _ in ()).throw(RuntimeError("fixture")))
    with pytest.raises(RuntimeError):
        extraction.process_raw_message(1, {"tenant_id": "tenant-a"}, object())
    assert provider_control.get() is None


def test_allow_resume_then_pause_blocks_second_provider_dispatch(monkeypatch):
    state = {"allowed": True, "calls": 0}
    storage = SimpleNamespace(is_extraction_allowed_for_source=lambda *a, **k: state["allowed"])
    token = provider_control.set((storage, "tenant-a", {"broker_id": "a"}))
    class Client:
        def __init__(self, **kw): self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))
        def create(self, **kw):
            state["calls"] += 1
            state["allowed"] = False
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='{"ok": true}'), finish_reason="stop")], usage=None)
    monkeypatch.setattr(ai_extraction, "OpenAI", Client)
    monkeypatch.setattr(ai_extraction, "_wait_for_provider_cooldown", lambda _: None)
    monkeypatch.setattr("usage_logger.log_ai_usage", lambda **kw: None)
    provider = {"name": "fake", "model": "fake", "api_key": "not-real", "base_url": "https://example.invalid"}
    try:
        assert ai_extraction._call_provider(provider, []) == {"ok": True}
        with pytest.raises(ExtractionPaused): ai_extraction._call_provider(provider, [])
        assert state["calls"] == 1
    finally:
        provider_control.reset(token)


@pytest.mark.parametrize("status,expected", [("paused", False), ("running", True), ("stopped", False)])
def test_incoming_webhook_saves_raw_but_only_schedules_its_running_phone(monkeypatch, status, expected):
    from routers import infra
    from starlette.requests import Request
    monkeypatch.setenv("PROPAI_INTERNAL_TOKEN", "fixture-token")
    storage, _ = source_storage([connection("a", status), connection("b")])
    saved, scheduled = [], []
    storage.get_org_whatsapp_connection_by_broker_id = lambda _: {"organization_id": "tenant-a"}
    storage.get_raw_by_uid = lambda *a, **k: None
    storage.save_raw_message = lambda raw: saved.append(raw) or 1
    storage.touch_whatsapp_conversation = lambda *a: None
    monkeypatch.setattr(infra, "storage", storage)
    monkeypatch.setattr(infra, "extraction_allowed_for_group", lambda *a, **k: True)
    monkeypatch.setattr(infra, "_resolve_group_name", lambda *_: "Fixture group")
    monkeypatch.setattr(infra, "_schedule_raw_extraction", lambda *args: scheduled.append(args) or True)
    monkeypatch.setattr(infra, "get_bus", lambda: SimpleNamespace(publish=lambda *a: None))
    body = {"event": "MESSAGES_UPSERT", "instance": "phone-a", "data": {"broker_id": "a", "key": {"id": "fixture-message", "remoteJid": "group@g.us"}, "message": {"conversation": "2 BHK for rent Bandra"}}}
    request = SimpleNamespace(headers={"X-PropAI-Internal-Token": "fixture-token"}, json=lambda: None)
    async def json_body(): return body
    request.json = json_body
    result = asyncio.run(infra.webhook(request))
    assert len(saved) == 1
    assert bool(scheduled) is expected
    assert result["extraction_queued"] is expected


def test_query_time_interpretation_remains_independent_of_structured_controls(monkeypatch):
    calls = []
    class Client:
        def __init__(self, **kw):
            assert "max_retries" not in kw
            self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))
        def create(self, **kw):
            calls.append(kw)
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='{}'), finish_reason="stop")], usage=None)
    monkeypatch.setattr(ai_extraction, "OpenAI", Client)
    monkeypatch.setattr(ai_extraction, "_wait_for_provider_cooldown", lambda _: None)
    monkeypatch.setattr("usage_logger.log_ai_usage", lambda **kw: None)
    assert provider_control.get() is None
    assert ai_extraction._call_provider({"name": "fake", "model": "fake", "api_key": "not-real", "base_url": "https://example.invalid"}, [], tenant_id="tenant-a", source_id=1, call_stage="initial_extraction") == {}
    assert len(calls) == 1


def test_source_check_isolation_between_parallel_worker_contexts(monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    barrier = Barrier(2)
    def pipeline(raw_id, ctx, storage):
        barrier.wait(timeout=3)
        current_storage, tenant, source = provider_control.get()
        assert tenant == ctx["tenant_id"]
        assert current_storage is storage
        assert source["broker_id"] == ctx["broker_id"]
        return tenant
    monkeypatch.setattr(extraction, "_process_raw_message", pipeline)
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(extraction.process_raw_message, i, {"tenant_id": f"tenant-{i}", "broker_id": str(i)}, object()) for i in range(2)]
        assert {f.result() for f in futures} == {"tenant-0", "tenant-1"}
    assert provider_control.get() is None
