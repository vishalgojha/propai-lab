import asyncio
from types import SimpleNamespace

import app


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return self._rows


def test_capture_health_uses_one_tenant_scoped_query(monkeypatch):
    calls = []

    class Database:
        def execute(self, sql, params=()):
            calls.append((sql, params))
            return _Result([{
                "total_raw": 20,
                "raw_today": 5,
                "last_msg": "2026-07-17T04:30:00Z",
                "total_parsed": 18,
                "parsed_today": 4,
                "total_kr": 18,
                "total_obs": 18,
                "total_oe": 18,
                "total_brokers": 3,
                "pending_enrich": 2,
                "pending_ai": 1,
            }])

    monkeypatch.setattr(app, "storage", SimpleNamespace(db=Database()))
    result = asyncio.run(app.audit_capture_health(user={"id": "user"}, tenant_id="tenant"))

    assert len(calls) == 1
    assert calls[0][1][0] == "tenant"
    assert result["queue_backlog"] == 3
    assert result["total_msgs_today"] == 5
    assert result["total_parsed_today"] == 4
    assert result["degraded"] is False


def test_duplicate_audit_reads_current_tenant_messages(monkeypatch):
    calls = []

    def rows(sql, params=()):
        calls.append((sql, params))
        return [
            {"group_id": "Bandra Brokers", "group_name": "Bandra Brokers", "error": "", "status": "captured"},
            {"group_id": "Bandra Brokers West", "group_name": "Bandra Brokers West", "error": "", "status": "captured"},
        ]

    monkeypatch.setattr(app, "_audit_rows", rows)
    result = asyncio.run(app.audit_duplicates(user={"id": "user"}, tenant_id="tenant"))

    assert len(result) == 1
    assert calls[0][1] == ("tenant",)
    assert "raw_messages" in calls[0][0]
    assert "source_sync_jobs" not in calls[0][0]


def test_audit_timestamp_normalizes_datetime_values():
    from datetime import datetime, timezone

    assert app._audit_timestamp(datetime(2026, 7, 17, 4, 30, tzinfo=timezone.utc)) == "2026-07-17T04:30:00Z"
