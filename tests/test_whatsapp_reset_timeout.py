import asyncio
from types import SimpleNamespace

import httpx

from routers import whatsapp_sync


def test_reset_returns_immediately_and_finishes_in_background(monkeypatch):
    calls = []

    async def organization(_user, _tenant_id):
        return "org-1"

    async def allow(*_args, **_kwargs):
        return None

    async def phone(_phone_id, _org_id):
        return {"id": 41, "broker_id": "phone-41"}

    async def ingestor(method, path, *, timeout, headers):
        calls.append((method, path, timeout, headers))
        return "http://ingestor", httpx.Response(
            200,
            json={
                "credentials_deleted": True,
                "mapping_deleted": True,
                "pairing_required": True,
                "reset_at": "2026-08-11T13:00:00Z",
                "whatsapp_unlinked": True,
            },
        )

    monkeypatch.setattr(whatsapp_sync, "_request_organization_id", organization)
    monkeypatch.setattr(whatsapp_sync, "_require_org_permission", allow)
    monkeypatch.setattr(whatsapp_sync, "_scoped_phone", phone)
    monkeypatch.setattr(whatsapp_sync, "_first_ingestor_response", ingestor)
    monkeypatch.setattr(
        whatsapp_sync,
        "storage",
        SimpleNamespace(
            update_org_whatsapp_connection=lambda _phone_id, updates: {
                "id": 41,
                **updates,
            }
        ),
    )

    async def run_reset():
        result = await whatsapp_sync.reset_phone(
            41, user={"id": "admin"}, tenant_id="org-1"
        )
        task = whatsapp_sync._phone_reset_tasks.get(41)
        if task:
            await task
        return result

    result = asyncio.run(run_reset())

    assert result["ok"] is True
    assert result["accepted"] is True
    assert calls[0][0:3] == ("POST", "/reset", 25)
