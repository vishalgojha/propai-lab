"""Regression tests for the extraction worker's recent/backlog lanes."""

from datetime import datetime, timezone

import extraction_worker


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
    monkeypatch.setattr(extraction_worker, "should_skip", lambda _message: None)
    monkeypatch.setattr(
        extraction_worker,
        "process_raw_message",
        lambda raw_id, _ctx, storage=None: seen.append(raw_id),
    )

    result = extraction_worker.run_cycle(storage, {})

    assert result == (2, 0, 0, 0)
    assert [call[0] for call in storage.calls] == ["fast", "backlog"]
    assert all(call[2] == 7 for call in storage.calls)
    assert set(seen) == {1, 2}


def test_recent_cutoff_is_utc_and_configurable(monkeypatch):
    monkeypatch.setattr(extraction_worker, "RECENT_WINDOW_HOURS", 24.0)
    now = datetime(2026, 8, 2, 12, 0, tzinfo=timezone.utc)

    assert extraction_worker.recent_cutoff(now) == "2026-08-01T12:00:00+00:00"


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
    monkeypatch.setattr(extraction_worker, "should_skip", lambda _message: None)
    monkeypatch.setattr(
        extraction_worker,
        "process_raw_message",
        lambda raw_id, _ctx, storage=None: seen.append(raw_id),
    )

    result = extraction_worker.run_cycle(storage, {})

    assert result == (1, 0, 0, 0)
    assert [call[0] for call in storage.calls] == ["fast", "backlog"]
    assert seen == [2]
