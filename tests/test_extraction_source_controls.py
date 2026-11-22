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


@pytest.mark.parametrize("kind,instance", [("confirmed_waba_direct", "waba"), ("authenticated_waba_agent", "waba-agent")])
def test_business_intake_grant_is_exact_scoped_and_never_stored_metadata(monkeypatch, kind, instance):
    from extraction_controls import process_business_intake, extraction_allowed
    storage, _ = source_storage([connection("a", "paused")])
    ctx = {"tenant_id": "tenant-a", "instance": instance, "source": "WABA_AGENT"}
    def pipeline(raw_id, actual, current_storage):
        assert extraction_allowed(current_storage, "tenant-a", actual)
        assert not extraction_allowed(current_storage, "tenant-b", actual)
        assert not extraction_allowed(object(), "tenant-a", actual)
        assert not extraction_allowed(current_storage, "tenant-a", dict(actual))
        # The same exact authorization is used at dispatch.
        from extraction_controls import require_extraction_allowed
        require_extraction_allowed(*provider_control.get())
        return {"listing_ids": [1]}
    monkeypatch.setattr(extraction, "_process_raw_message", pipeline)
    assert process_business_intake(1, ctx, storage, kind=kind)["listing_ids"] == [1]
    assert not extraction_allowed(storage, "tenant-a", ctx)
    assert provider_control.get() is None


def test_business_intake_exception_does_not_leak_authorization(monkeypatch):
    from extraction_controls import process_business_intake, extraction_allowed
    storage = object()
    ctx = {"tenant_id": "tenant-a", "instance": "waba"}
    monkeypatch.setattr(extraction, "_process_raw_message", lambda *a: (_ for _ in ()).throw(RuntimeError("fixture")))
    with pytest.raises(RuntimeError):
        process_business_intake(1, ctx, storage, kind="confirmed_waba_direct")
    assert not extraction_allowed(storage, "tenant-a", ctx)


def test_scheduler_record_has_real_source_instance_and_obeys_pause(monkeypatch):
    import scheduler
    from ingestion.base import SourceRecord
    storage, _ = source_storage([connection("a", "paused"), connection("b")])
    storage.save_raw_message = lambda _: 1
    monkeypatch.setattr(scheduler, "get_app_storage", lambda: storage)
    record = SourceRecord(source="whatsapp", instance="phone-a", group_id="fixture@g.us", record_id="1", text="2 BHK Bandra", meta={"tenant_id": "tenant-a"})
    result = scheduler.process_record(record)
    assert result["extraction_source"] == "extraction_control:not_running"


@pytest.mark.parametrize("requirement", [False, True])
def test_actual_business_webhooks_preserve_authenticated_intake(monkeypatch, requirement):
    import business_api
    from extraction_controls import extraction_allowed
    storage = SimpleNamespace(get_raw_by_uid=lambda *a, **k: None, save_raw_message=lambda _: 71)
    monkeypatch.setattr(business_api, "BUSINESS_API_WEBHOOK_SECRET", "fixture-secret")
    monkeypatch.setattr(business_api, "get_storage", lambda: storage)
    monkeypatch.setattr(business_api, "resolve_broker", lambda _: {"id": "broker-a", "canonical_name": "Fixture"})
    monkeypatch.setattr(business_api, "_tenant_id_for", lambda _: "tenant-a")
    calls = []
    def pipeline(raw_id, ctx, current_storage):
        assert extraction_allowed(current_storage, "tenant-a", ctx)
        assert provider_control.get()[0] is storage
        calls.append(raw_id)
        return {"listing_ids": [3], "parsed_ids": [4]}
    monkeypatch.setattr(extraction, "_process_raw_message", pipeline)
    if requirement:
        body = business_api.CreateRequirementRequest(phone="919999999999", raw_text="Need 2 BHK", confirmed=True)
        func = business_api.create_requirement_webhook
        unconfirmed = body.model_copy(update={"confirmed": False})
        with pytest.raises(HTTPException) as exc:
            asyncio.run(func(unconfirmed, "fixture-secret"))
        assert exc.value.status_code == 409
    else:
        body = business_api.SaveListingRequest(phone="919999999999", raw_text="2 BHK for rent")
        func = business_api.save_listing_webhook
    with pytest.raises(HTTPException) as exc:
        asyncio.run(func(body, "wrong-secret"))
    assert exc.value.status_code in {401, 403}
    assert not calls
    assert asyncio.run(func(body, "fixture-secret"))["status"] == "saved"
    assert calls == [71]


def test_actual_waba_confirm_publish_uses_scoped_business_contract(monkeypatch):
    from routers import common
    from extraction_controls import extraction_allowed
    class DB:
        def execute(self, sql, params):
            if sql.startswith("SELECT id, message"):
                return SimpleNamespace(fetchall=lambda: [(1, "2 BHK for rent in Bandra")])
            return SimpleNamespace(lastrowid=72)
    storage = SimpleNamespace(db=DB())
    monkeypatch.setattr(common, "storage", storage)
    def pipeline(raw_id, ctx, current_storage):
        assert raw_id == 72
        assert ctx["instance"] == "waba"
        assert extraction_allowed(current_storage, "tenant-a", ctx)
        return {"listing_ids": [3]}
    monkeypatch.setattr(extraction, "_process_raw_message", pipeline)
    result = asyncio.run(common._publish_waba_direct_listing("919999999999", "confirmation-id", "Fixture", {}, "tenant-a"))
    assert result.startswith("Published 1 listing")
    assert provider_control.get() is None


def test_scheduler_running_record_does_not_acquire_business_exemption(monkeypatch):
    import scheduler
    from ingestion.base import SourceRecord
    from extraction_controls import extraction_allowed
    storage, _ = source_storage([connection("a")])
    storage.save_raw_message = lambda _: 1
    monkeypatch.setattr(scheduler, "get_app_storage", lambda: storage)
    def pipeline(raw_id, ctx, current_storage):
        assert extraction_allowed(current_storage, "tenant-a", ctx)
        assert ctx["instance"] == "phone-a"
        # Merely calling a scheduler record waba cannot borrow business authority.
        assert not extraction_allowed(current_storage, "tenant-a", {**ctx, "instance": "waba"})
        return {"storage_status": "stored"}
    monkeypatch.setattr(extraction, "_process_raw_message", pipeline)
    record = SourceRecord(source="whatsapp", instance="phone-a", group_id="fixture@g.us", record_id="1", text="2 BHK Bandra", meta={"tenant_id": "tenant-a"})
    assert scheduler.process_record(record)["storage_status"] == "stored"
