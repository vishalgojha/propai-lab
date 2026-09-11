from types import SimpleNamespace

from routers import admin as admin_mod


class _Result:
    def __init__(self, row=None, rows=None):
        self.row = row
        self.rows = rows or []

    def fetchone(self):
        return self.row

    def fetchall(self):
        return self.rows


def test_identity_metrics_returns_partial_data_when_source_query_fails(monkeypatch):
    class Database:
        def execute(self, sql, params=()):
            if "raw_messages" in sql:
                raise RuntimeError("statement timeout")
            if "group_members" in sql and "COUNT(DISTINCT" in sql:
                return _Result({"count": 4})
            if "broker_phones" in sql:
                return _Result(rows=[{"phone": "+91 90000 00000"}])
            if "FROM (" in sql:
                return _Result({"count": 4})
            raise AssertionError(sql)

    monkeypatch.setattr(
        admin_mod,
        "storage",
        SimpleNamespace(
            list_all_whatsapp_connections=lambda: [
                {"phone_number": "+91 98200 56180", "extraction_status": "running", "is_active": True},
                {"phone_number": "+91 90000 00000", "extraction_status": "stopped", "is_active": True},
            ],
            db=Database(),
        ),
    )

    result = admin_mod._identity_metrics()

    assert result["connected_session_rows"] == 2
    assert result["unique_connected_numbers"] == 2
    assert result["active_parsing_session_rows"] == 1
    assert result["unique_active_parsing_numbers"] == 1
    assert result["unique_raw_sender_identities"] is None
    assert result["unique_group_member_identities"] == 4
    assert result["unique_seen_identities"] is None
    assert result["resolved_broker_numbers"] == 1
    assert result["unresolved_seen_identities"] is None
    assert "raw_senders" in result["metric_errors"]
    assert "seen_identities" in result["metric_errors"]
