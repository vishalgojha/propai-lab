"""Fail-closed extraction-control checks at real pipeline boundaries."""

import pytest

import extraction
import extraction_worker
from storage.supabase import SupabaseStorage


class _ControlStorage:
    tenant_id = None

    def __init__(self, allowed):
        self.allowed = allowed

    def is_extraction_allowed_for_source(self, _tenant_id, **_source):
        return self.allowed


def _ctx():
    return {"tenant_id": "tenant-a", "msg_text": "2 BHK for rent in Bandra"}


def test_process_boundary_does_not_enter_pipeline_when_paused(monkeypatch):
    provider_calls = []
    monkeypatch.setattr(
        extraction,
        "market_scope_skip_reason",
        lambda *_args, **_kwargs: provider_calls.append("pipeline") or None,
    )

    result = extraction.process_raw_message(41, _ctx(), storage=_ControlStorage(False))

    assert result["extraction_source"] == "extraction_control:not_running"
    assert provider_calls == []


def test_worker_control_lookup_failure_does_not_process_rows(monkeypatch):
    class UnavailableStorage:
        def get_running_extraction_tenant_ids(self):
            raise RuntimeError("control plane unavailable")

    monkeypatch.setattr(
        extraction_worker,
        "process_raw_message",
        lambda *_args, **_kwargs: pytest.fail("provider pipeline must not start"),
    )
    monkeypatch.setattr(extraction_worker, "FAST_LANE_SLOTS", 1)
    monkeypatch.setattr(extraction_worker, "BACKLOG_LANE_SLOTS", 0)

    assert extraction_worker.run_cycle(UnavailableStorage(), {}) == (0, 0, 0, 0, 0)


def test_storage_control_lookup_failure_is_closed_and_tenant_scoped():
    class Query:
        def select(self, *_args): return self
        def eq(self, *_args): return self
        def execute(self): raise RuntimeError("lookup unavailable")

    class Client:
        def table(self, _name): return Query()

    storage = type("Storage", (), {"client": Client()})()
    assert SupabaseStorage.is_extraction_allowed_for_tenant(storage, "tenant-a") is False


def test_storage_control_requires_a_running_active_connection():
    class Query:
        def select(self, *_args): return self
        def eq(self, *_args): return self
        def execute(self):
            return type("Result", (), {"data": [
                {"is_active": True, "extraction_status": "paused"},
                {"is_active": False, "extraction_status": "running"},
            ]})()

    class Client:
        def table(self, _name): return Query()

    storage = type("Storage", (), {"client": Client()})()
    assert SupabaseStorage.is_extraction_allowed_for_tenant(storage, "tenant-a") is False
