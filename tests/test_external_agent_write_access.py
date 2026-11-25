import asyncio

import pytest
from fastapi import HTTPException

from routers import external_agent


class FakeQuery:
    """Minimal Supabase-query stub that records updates per table."""

    def __init__(self, client, table):
        self.client = client
        self.table = table
        self.mode = None
        self.payload = None

    def select(self, *_args, **_kwargs):
        self.mode = "select"
        return self

    def update(self, payload):
        self.mode = "update"
        self.payload = payload
        return self

    def insert(self, payload):
        self.mode = "insert"
        self.payload = payload
        return self

    def eq(self, *_args):
        return self

    def is_(self, *_args):
        return self

    def in_(self, *_args):
        return self

    def order(self, *_args, **_kwargs):
        return self

    def offset(self, *_args):
        return self

    def limit(self, *_args):
        return self

    def execute(self):
        if self.mode == "select":
            return type("Result", (), {"data": list(self.client.rows.get(self.table, []))})()
        if self.mode == "update":
            self.client.updates.append((self.table, self.payload))
            return type("Result", (), {"data": [{"id": "key-1"}]})()
        return type("Result", (), {"data": []})()


class FakeClient:
    def __init__(self, rows):
        self.rows = rows
        self.updates = []

    def table(self, table):
        return FakeQuery(self, table)


def _patch_common(monkeypatch, client):
    monkeypatch.setattr(external_agent, "storage", type("Storage", (), {"client": client})())
    async def allow(_user, _tenant, _perm):
        return True
    monkeypatch.setattr(external_agent, "_require_org_permission", allow)
    monkeypatch.setattr(external_agent, "_write_audit_start", lambda *a, **k: "audit-1")
    monkeypatch.setattr(external_agent, "_write_audit_finish", lambda *a, **k: None)


def _run_write_access(monkeypatch, body):
    client = FakeClient({
        "external_agent_api_keys": [{
            "id": "key-1",
            "scopes": ["inventory:read", "requirements:read", "raw_messages:read"],
        }],
    })
    _patch_common(monkeypatch, client)
    result = asyncio.run(external_agent.update_external_key_write_access(
        "key-1", body, user={"id": "user-1"}, tenant_id="tenant-1",
    ))
    return client, result


def test_write_access_default_grants_full_bundle(monkeypatch):
    client, result = _run_write_access(monkeypatch, external_agent.ApiKeyWriteAccessUpdate(enabled=True))
    assert set(result["scopes"]) == {
        "inventory:read", "requirements:read", "raw_messages:read",
        "inventory:write", "requirements:write", "standing_searches:write", "followups:write",
    }


def test_write_access_subset_grants_only_requested_scopes(monkeypatch):
    client, result = _run_write_access(monkeypatch, external_agent.ApiKeyWriteAccessUpdate(
        enabled=True, scopes=["inventory:write", "requirements:write"],
    ))
    assert set(result["scopes"]) == {
        "inventory:read", "requirements:read", "raw_messages:read",
        "inventory:write", "requirements:write",
    }
    table, payload = client.updates[0]
    assert table == "external_agent_api_keys"
    assert "standing_searches:write" not in payload["scopes"]
    assert "followups:write" not in payload["scopes"]


def test_write_access_subset_rejects_unsupported_scope(monkeypatch):
    with pytest.raises(HTTPException) as excinfo:
        _run_write_access(monkeypatch, external_agent.ApiKeyWriteAccessUpdate(
            enabled=True, scopes=["inventory:write", "raw_messages:read"],
        ))
    assert excinfo.value.status_code == 422


def test_write_access_disable_strips_write_bundle(monkeypatch):
    client = FakeClient({
        "external_agent_api_keys": [{
            "id": "key-1",
            "scopes": ["inventory:read", "inventory:write", "requirements:write", "followups:write"],
        }],
    })
    _patch_common(monkeypatch, client)
    result = asyncio.run(external_agent.update_external_key_write_access(
        "key-1", external_agent.ApiKeyWriteAccessUpdate(enabled=False),
        user={"id": "user-1"}, tenant_id="tenant-1",
    ))
    assert result["scopes"] == ["inventory:read"]


def test_saved_requirements_returns_tenant_rows_with_client_names(monkeypatch):
    client = FakeClient({
        "client_requirements": [{
            "id": 7, "client_id": "c-1", "bhk": "2", "price_min": 100, "price_max": 200,
            "micro_market": "Bandra West", "area_sqft_min": None, "area_sqft_max": None,
            "notes": "Test requirement", "created_at": "2026-11-26T00:00:00Z",
        }],
        "clients": [{"id": "c-1", "name": "Test Client"}],
    })
    monkeypatch.setattr(external_agent, "storage", type("Storage", (), {"client": client})())
    result = asyncio.run(external_agent.external_saved_requirements(
        key={"tenant_id": "tenant-1", "scopes": ["requirements:read"]},
    ))
    assert result["private"] is True
    assert result["count"] == 1
    row = result["results"][0]
    assert row["client_name"] == "Test Client"
    assert row["micro_market"] == "Bandra West"
    assert row["budget_min"] == 100
    assert "phone" not in row


def test_saved_requirements_requires_read_scope():
    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(external_agent.external_saved_requirements(
            key={"tenant_id": "tenant-1", "scopes": []},
        ))
    assert excinfo.value.status_code == 403
