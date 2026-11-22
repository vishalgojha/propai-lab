import asyncio
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException
from routers import whatsapp_sync


@pytest.mark.parametrize("status,payload,removed", [
    (503, {"error": "retirement unverified"}, False),
    (404, {"detail": "missing handler"}, False),
    (200, {"ok": True}, False),
    (200, {"credentials_deleted": False, "mapping_deleted": True, "reset_at": "fixture"}, False),
    (200, {"credentials_deleted": True, "mapping_deleted": True, "reset_at": "fixture"}, True),
])
def test_delete_keeps_phone_until_cleanup_receipt(monkeypatch, status, payload, removed):
    calls = []
    ingestor_calls = []

    async def organization(*_args):
        return "fixture-org"

    async def allow(*_args):
        pass

    async def phone(*_args):
        return {"id": 41, "broker_id": "fixture-reset"}

    async def ingestor(method, path, **_kwargs):
        ingestor_calls.append(path)
        return "http://fixture", httpx.Response(status, json=payload)

    monkeypatch.setattr(whatsapp_sync, "_request_organization_id", organization)
    monkeypatch.setattr(whatsapp_sync, "_require_org_permission", allow)
    monkeypatch.setattr(whatsapp_sync, "_scoped_phone", phone)
    monkeypatch.setattr(whatsapp_sync, "_first_ingestor_response", ingestor)
    monkeypatch.setattr(whatsapp_sync, "storage", SimpleNamespace(
        remove_org_whatsapp_connection=lambda phone_id: calls.append(phone_id) or True,
    ))
    if removed:
        assert asyncio.run(whatsapp_sync.delete_phone(41, user={"id": "fixture"})) == {"ok": True}
    else:
        with pytest.raises(HTTPException) as error:
            asyncio.run(whatsapp_sync.delete_phone(41, user={"id": "fixture"}))
        assert error.value.status_code == 502
    assert calls == ([41] if removed else [])
    assert ingestor_calls == ["/delete-session"]
