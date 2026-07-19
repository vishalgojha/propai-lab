import asyncio
from types import SimpleNamespace

import httpx
import pytest

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
    result = app.audit_capture_health(user={"id": "user"}, tenant_id="tenant")

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
    result = app.audit_duplicates(user={"id": "user"}, tenant_id="tenant")

    assert len(result) == 1
    assert calls[0][1] == ("tenant",)
    assert "raw_messages" in calls[0][0]
    assert "source_sync_jobs" not in calls[0][0]


def test_audit_timestamp_normalizes_datetime_values():
    from datetime import datetime, timezone

    assert app._audit_timestamp(datetime(2026, 7, 17, 4, 30, tzinfo=timezone.utc)) == "2026-07-17T04:30:00Z"


def test_audit_group_display_name_does_not_query_storage(monkeypatch):
    class Database:
        def execute(self, *_args, **_kwargs):
            raise AssertionError("display formatting must not query the database")

    monkeypatch.setattr(app, "storage", SimpleNamespace(db=Database()))

    assert app._audit_group_display_name("Bandra Brokers") == "Bandra Brokers"
    assert app._audit_group_display_name("120363123456789@g.us") == "WhatsApp Group 6789"


def test_audit_insights_is_tenant_scoped(monkeypatch):
    calls = []
    result_sets = iter([
        [("2026-07-17", 12, 4, 8)],
        [("Bandra West", 9, 3, 6, 5)],
        [("Broker One", 14, 10, 4, 3, 2, "2026-07-17T05:00:00Z")],
        [("Bandra Brokers", 7)],
    ])

    def rows(sql, params=()):
        calls.append((sql, params))
        return next(result_sets)

    monkeypatch.setattr(app, "_table_exists", lambda table: True)
    monkeypatch.setattr(app, "_audit_rows", rows)

    result = app.audit_insights(user={"id": "user"}, tenant_id="tenant-a")

    assert len(calls) == 4
    assert all("tenant" in sql.lower() for sql, _ in calls)
    assert all("tenant-a" in params for _, params in calls)
    assert result["daily_flow"][0]["posts"] == 12
    assert result["markets"][0]["name"] == "Bandra West"
    assert result["brokers"][0]["groups"] == 3
    assert result["exclusive_members"]["Bandra Brokers"] == 7


def test_audit_groups_uses_named_columns_from_supabase_json_rows(monkeypatch):
    """JSONB key order must never be mistaken for SQL select order."""
    calls = []
    result_sets = iter([
        [{
            "last_activity": "2026-07-18T12:00:00Z",
            "group_name": "Bandra Brokers",
            "senders_count": 4,
            "messages": 12,
        }],
        [{
            "unknown_locations": 1,
            "markets_count": 2,
            "listings": 6,
            "group_name": "Bandra Brokers",
            "requirements": 2,
            "observations": 8,
            "identities": 4,
        }],
        [{"total_unique_senders": 4}],
    ])

    def rows(sql, params=()):
        calls.append((sql, params))
        return next(result_sets)

    monkeypatch.setattr(app, "_table_exists", lambda table: True)
    monkeypatch.setattr(app, "_audit_rows", rows)

    result = app.audit_groups_v2(user={"id": "user"}, tenant_id="tenant-a")

    assert len(calls) == 3
    assert result["total_unique_senders"] == 4
    assert result["groups"][0]["name"] == "Bandra Brokers"
    assert result["groups"][0]["messages"] == 12
    assert result["groups"][0]["observations"] == 8
    assert result["groups"][0]["active_brokers"] == 4


def test_audit_building_names_reject_parser_style_false_positives():
    assert app._clean_audit_building_name(" *BRIGHT LAND` ") == "BRIGHT LAND"
    assert app._clean_audit_building_name(": Shadaab Tower*") == "Shadaab Tower"
    assert app._clean_audit_building_name("Floor: Call") is None
    assert app._clean_audit_building_name("Photo Available") is None
    assert app._clean_audit_building_name("Well-Maintained") is None
    assert app._clean_audit_building_name("388") is None


def test_audit_buildings_use_explicit_tenant_scoped_mentions(monkeypatch):
    calls = []

    def rows(sql, params=()):
        calls.append((sql, params))
        return [
            {"building_name": "Arasu CHS", "occurrences": 3},
            {"occurrences": 2, "building_name": " arasu chs* "},
            {"building_name": "on call", "occurrences": 12},
            {"building_name": ": Shadaab Tower*", "occurrences": 2},
        ]

    monkeypatch.setattr(app, "_audit_rows", rows)

    result = app._audit_buildings_for_group(
        "tenant-a", "group-jid", "Royal Realtors"
    )

    assert result == [
        {"building_name": "Arasu CHS", "occurrences": 5},
        {"building_name": "Shadaab Tower", "occurrences": 2},
    ]
    assert len(calls) == 1
    assert "r.tenant_id = ?" in calls[0][0]
    assert calls[0][1][1:] == ("tenant-a", "group-jid", "Royal Realtors")


def test_audit_overlap_uses_named_columns_from_supabase_json_rows(monkeypatch):
    monkeypatch.setattr(app, "_table_exists", lambda table: True)
    monkeypatch.setattr(app, "_audit_rows", lambda *_args, **_kwargs: [
        {"sender": "broker-1", "group_name": "Group A"},
        {"group_name": "Group B", "sender": "broker-1"},
        {"sender": "broker-2", "group_name": "Group A"},
        {"group_name": "Group B", "sender": "broker-2"},
    ])

    result = app.audit_group_overlap(user={"id": "user"}, tenant_id="tenant-a")

    assert result["pairs"][0]["shared_senders"] == 2
    assert {item["name"] for item in result["groups"]} == {"Group A", "Group B"}


def test_phone_list_resolves_authenticated_workspace(monkeypatch):
    seen = []

    class Storage:
        def list_org_whatsapp_connections(self, org_id):
            seen.append(org_id)
            return [{"id": 13, "broker_id": "phone-real", "phone_number": "919820056180"}]

    async def inline_to_thread(function, *args, **kwargs):
        return function(*args, **kwargs)

    monkeypatch.setattr(app, "storage", Storage())
    monkeypatch.setattr(app, "_resolve_active_organization_id", lambda user, tenant_id: "workspace-real")
    monkeypatch.setattr(app.asyncio, "to_thread", inline_to_thread)

    result = asyncio.run(app.list_phones(
        user={"id": "user"}, tenant_id=app.DEFAULT_TENANT_ID, include_live=False,
    ))

    assert seen == ["workspace-real"]
    assert result["phones"][0]["phone_number"] == "919820056180"


def test_create_phone_reuses_workspace_placeholder(monkeypatch):
    connection_calls = []

    class Storage:
        def list_org_whatsapp_connections(self, org_id):
            return [{"id": 19, "broker_id": "phone-placeholder", "phone_number": "Unpaired:phone-placeholder", "instance_name": ""}]

        def update_org_whatsapp_connection(self, conn_id, updates):
            return None

    async def ingestor(method, path, **kwargs):
        connection_calls.append((method, path, kwargs))
        return None, None

    async def allow_phone_management(user, org_id, permission):
        assert (user["id"], org_id, permission) == ("user", "workspace-real", "manage_whatsapp")

    async def inline_to_thread(function, *args, **kwargs):
        return function(*args, **kwargs)

    monkeypatch.setattr(app, "storage", Storage())
    monkeypatch.setattr(app, "_resolve_active_organization_id", lambda user, tenant_id: "workspace-real")
    monkeypatch.setattr(app, "_first_ingestor_response", ingestor)
    monkeypatch.setattr(app, "_require_org_permission", allow_phone_management)
    monkeypatch.setattr(app.asyncio, "to_thread", inline_to_thread)

    result = asyncio.run(app.create_phone(
        {"instance_name": ""}, user={"id": "user"}, tenant_id="workspace-real",
    ))

    assert result["id"] == 19
    assert connection_calls[0][2]["params"]["broker_id"] == "phone-placeholder"


def test_phone_list_marks_missing_session_as_stopped_when_ingestor_is_reachable(monkeypatch):
    class Storage:
        def list_org_whatsapp_connections(self, org_id):
            assert org_id == "workspace-real"
            return [{"id": 13, "broker_id": "phone-real", "phone_number": "919820056180"}]

    async def ingestor(method, path, **kwargs):
        assert (method, path) == ("GET", "/list")
        return "http://ingestor:3001", httpx.Response(200, json=[])

    async def inline_to_thread(function, *args, **kwargs):
        return function(*args, **kwargs)

    monkeypatch.setattr(app, "storage", Storage())
    monkeypatch.setattr(app, "_resolve_active_organization_id", lambda user, tenant_id: "workspace-real")
    monkeypatch.setattr(app, "_first_ingestor_response", ingestor)
    monkeypatch.setattr(app, "_broker_live_statuses", {})
    monkeypatch.setattr(app.asyncio, "to_thread", inline_to_thread)

    result = asyncio.run(app.list_phones(
        user={"id": "user"}, tenant_id="workspace-real", include_live=True,
    ))

    phone = result["phones"][0]
    assert phone["connected"] is False
    assert phone["connection_state"] == "stopped"
    assert phone["live_status_available"] is True
    assert phone["live_status_error"] == ""


def test_phone_list_exposes_ingestor_auth_configuration_error(monkeypatch):
    class Storage:
        def list_org_whatsapp_connections(self, org_id):
            return [{"id": 13, "broker_id": "phone-real", "phone_number": "919820056180"}]

    async def ingestor(method, path, **kwargs):
        return "http://ingestor:3001", httpx.Response(401, json={"error": "invalid token"})

    async def inline_to_thread(function, *args, **kwargs):
        return function(*args, **kwargs)

    monkeypatch.setattr(app, "storage", Storage())
    monkeypatch.setattr(app, "_resolve_active_organization_id", lambda user, tenant_id: "workspace-real")
    monkeypatch.setattr(app, "_first_ingestor_response", ingestor)
    monkeypatch.setattr(app, "_broker_live_statuses", {})
    monkeypatch.setattr(app.asyncio, "to_thread", inline_to_thread)

    result = asyncio.run(app.list_phones(
        user={"id": "user"}, tenant_id="workspace-real", include_live=True,
    ))

    phone = result["phones"][0]
    assert phone["connected"] is None
    assert phone["connection_state"] == "unavailable"
    assert phone["live_status_available"] is False
    assert "PROPAI_INTERNAL_TOKEN" in phone["live_status_error"]


def test_delete_phone_removes_ingestor_session_and_workspace_record(monkeypatch):
    calls = []

    class Storage:
        def remove_org_whatsapp_connection(self, phone_id):
            calls.append(("storage-delete", phone_id))
            return True

    async def allow_phone_management(user, org_id, permission):
        assert (org_id, permission) == ("workspace-real", "manage_whatsapp")

    async def scoped_phone(phone_id, org_id):
        return {"id": phone_id, "organization_id": org_id, "broker_id": "phone-real"}

    async def ingestor(method, path, **kwargs):
        calls.append((method, path, kwargs["params"]["broker_id"]))
        return "http://ingestor:3001", httpx.Response(200, json={"ok": True})

    async def inline_to_thread(function, *args, **kwargs):
        return function(*args, **kwargs)

    monkeypatch.setattr(app, "storage", Storage())
    monkeypatch.setattr(app, "_resolve_active_organization_id", lambda user, tenant_id: "workspace-real")
    monkeypatch.setattr(app, "_require_org_permission", allow_phone_management)
    monkeypatch.setattr(app, "_scoped_phone", scoped_phone)
    monkeypatch.setattr(app, "_first_ingestor_response", ingestor)
    monkeypatch.setattr(app.asyncio, "to_thread", inline_to_thread)

    result = asyncio.run(app.delete_phone(
        13, user={"id": "user"}, tenant_id="workspace-real",
    ))

    assert result == {"ok": True}
    assert calls == [
        ("POST", "/delete-session", "phone-real"),
        ("storage-delete", 13),
    ]


def test_connect_phone_maps_ingestor_unauthorized_to_dependency_error(monkeypatch):
    async def allow_phone_management(user, org_id, permission):
        return None

    async def scoped_phone(phone_id, org_id):
        return {"id": phone_id, "organization_id": org_id, "broker_id": "phone-real"}

    async def ingestor(method, path, **kwargs):
        return "http://ingestor:3001", httpx.Response(401, json={"error": "invalid token"})

    monkeypatch.setattr(app, "_resolve_active_organization_id", lambda user, tenant_id: "workspace-real")
    monkeypatch.setattr(app, "_require_org_permission", allow_phone_management)
    monkeypatch.setattr(app, "_scoped_phone", scoped_phone)
    monkeypatch.setattr(app, "_first_ingestor_response", ingestor)

    with pytest.raises(app.HTTPException) as exc:
        asyncio.run(app.connect_phone(13, user={"id": "user"}, tenant_id="workspace-real"))

    assert exc.value.status_code == 502
    assert "PROPAI_INTERNAL_TOKEN" in exc.value.detail
