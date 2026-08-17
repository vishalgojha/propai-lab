"""Regression tests for the extraction worker's recent/backlog lanes."""

from datetime import datetime, timezone

import extraction_worker


def test_stale_extraction_claim_is_not_a_retryable_failure():
    assert extraction_worker._is_stale_extraction_claim(
        RuntimeError("raw message is not available for extraction")
    )
    assert not extraction_worker._is_stale_extraction_claim(
        RuntimeError("provider timeout")
    )


class _Storage:
    def __init__(self):
        self.calls = []
        self.processed = []

    def get_unprocessed_raw_messages_since(self, cutoff, limit=100):
        self.calls.append(("fast", cutoff, limit))
        return [{"id": 1, "message": "3 BHK for rent in Bandra", "timestamp": cutoff}]

    def get_unprocessed_raw_messages_before(self, cutoff, limit=100):
        self.calls.append(("backlog", cutoff, limit))
        return [{"id": 2, "message": "3 BHK for sale in Andheri", "timestamp": "2026-01-01T00:00:00+00:00"}]

    def mark_raw_processed(self, raw_id):
        self.processed.append(raw_id)


def test_run_cycle_fetches_and_processes_both_lanes(monkeypatch):
    storage = _Storage()
    seen = []

    monkeypatch.setattr(extraction_worker, "CONCURRENCY", 5)
    monkeypatch.setattr(extraction_worker, "FAST_LANE_SLOTS", 3)
    monkeypatch.setattr(extraction_worker, "BACKLOG_LANE_SLOTS", 2)
    monkeypatch.setattr(extraction_worker, "BATCH_SIZE", 7)
    monkeypatch.setattr(extraction_worker, "LIVE_ONLY", False)
    monkeypatch.setattr(
        extraction_worker,
        "process_raw_message",
        lambda raw_id, _ctx, storage=None: seen.append(raw_id),
    )

    result = extraction_worker.run_cycle(storage, {})

    assert result == (2, 2, 0, 0, 0)
    assert [call[0] for call in storage.calls] == ["fast", "backlog"]
    assert all(call[2] == 7 for call in storage.calls)
    assert set(seen) == {1, 2}


def test_recent_cutoff_is_utc_and_configurable(monkeypatch):
    monkeypatch.setattr(extraction_worker, "RECENT_WINDOW_HOURS", 24.0)
    now = datetime(2026, 8, 2, 12, 0, tzinfo=timezone.utc)

    assert extraction_worker.recent_cutoff(now) == "2026-08-01T12:00:00+00:00"


def test_live_only_uses_fixed_cutover_and_skips_backlog(monkeypatch):
    storage = _Storage()
    seen = []
    monkeypatch.setattr(extraction_worker, "LIVE_ONLY", True)
    monkeypatch.setattr(
        extraction_worker,
        "LIVE_CUTOFF_AT",
        datetime(2026, 8, 16, 8, 0, tzinfo=timezone.utc),
    )
    monkeypatch.setattr(extraction_worker, "FAST_LANE_SLOTS", 1)
    monkeypatch.setattr(extraction_worker, "BACKLOG_LANE_SLOTS", 1)
    monkeypatch.setattr(extraction_worker, "BATCH_SIZE", 7)
    monkeypatch.setattr(
        extraction_worker,
        "process_raw_message",
        lambda raw_id, _ctx, storage=None: seen.append(raw_id),
    )

    result = extraction_worker.run_cycle(storage, {})

    assert result == (1, 1, 0, 0, 0)
    assert [call[0] for call in storage.calls] == ["fast"]
    assert extraction_worker.recent_cutoff() == "2026-08-16T08:00:00+00:00"
    assert seen == [1]


def test_context_uses_numeric_raw_id_for_usage_attribution():
    context = extraction_worker.context_from_raw({"id": 77, "message": "office for rent"})

    assert context["raw_id"] == 77


def test_group_consent_requires_positive_selection_for_broker_accounts():
    policy = {
        "unlimited_orgs": set(),
        "connections": {("org-1", "phone-1"): 31},
        "selected": {("org-1", 31, "selected@g.us")},
    }
    selected = {"tenant_id": "org-1", "group_name": "selected@g.us", "raw_payload": {"data": {"broker_id": "phone-1"}}}
    unselected = {"tenant_id": "org-1", "group_name": "other@g.us", "raw_payload": {"data": {"broker_id": "phone-1"}}}
    no_consent_row = {"tenant_id": "org-1", "group_name": "new@g.us", "raw_payload": {"data": {"broker_id": "phone-1"}}}

    assert extraction_worker._row_has_group_consent(selected, policy)
    assert not extraction_worker._row_has_group_consent(unselected, policy)
    assert not extraction_worker._row_has_group_consent(no_consent_row, policy)


def test_super_admin_group_consent_still_requires_explicit_selection():
    policy = {
        "unlimited_orgs": {"admin-org"},
        "connections": {},
        "selected": set(),
    }
    row = {"tenant_id": "admin-org", "group_name": "any@g.us", "raw_payload": {"data": {"broker_id": "phone-1"}}}

    assert not extraction_worker._row_has_group_consent(row, policy)


def test_failed_fast_lane_does_not_block_backlog(monkeypatch):
    class _FastLaneUnavailable(_Storage):
        def get_unprocessed_raw_messages_since(self, cutoff, limit=100):
            self.calls.append(("fast", cutoff, limit))
            raise RuntimeError("temporary fast-lane failure")

    storage = _FastLaneUnavailable()
    seen = []

    monkeypatch.setattr(extraction_worker, "FAST_LANE_SLOTS", 1)
    monkeypatch.setattr(extraction_worker, "BACKLOG_LANE_SLOTS", 1)
    monkeypatch.setattr(extraction_worker, "BATCH_SIZE", 7)
    monkeypatch.setattr(
        extraction_worker,
        "process_raw_message",
        lambda raw_id, _ctx, storage=None: seen.append(raw_id),
    )

    result = extraction_worker.run_cycle(storage, {})

    assert result == (1, 1, 0, 0, 0)
    assert [call[0] for call in storage.calls] == ["fast", "backlog"]
    assert seen == [2]


def test_storage_failure_is_counted_as_failed_and_not_cleared(monkeypatch):
    storage = _Storage()
    monkeypatch.setattr(extraction_worker, "FAST_LANE_SLOTS", 1)
    monkeypatch.setattr(extraction_worker, "BACKLOG_LANE_SLOTS", 0)
    monkeypatch.setattr(extraction_worker, "BATCH_SIZE", 7)
    monkeypatch.setattr(
        extraction_worker,
        "process_raw_message",
        lambda _raw_id, _ctx, storage=None: {"storage_status": "failed"},
    )

    retry_counts = {}
    result = extraction_worker.run_cycle(storage, retry_counts)

    assert result == (1, 0, 1, 0, 0)
    assert retry_counts == {1: 1}


def test_run_cycle_does_not_process_when_all_tenants_are_stopped(monkeypatch):
    class _StoppedStorage(_Storage):
        def get_running_extraction_tenant_ids(self):
            return []

    storage = _StoppedStorage()

    def fail_if_called(*_args, **_kwargs):
        raise AssertionError("stopped tenants must not be processed")

    monkeypatch.setattr(extraction_worker, "process_raw_message", fail_if_called)

    assert extraction_worker.run_cycle(storage, {}) == (0, 0, 0, 0, 0)
    assert storage.calls == []
