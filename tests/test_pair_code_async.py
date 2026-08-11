import asyncio

import httpx

from routers import whatsapp_sync as sync


def test_pair_code_start_returns_before_background_ingestor_result(monkeypatch):
    calls = []

    class Storage:
        @staticmethod
        def list_org_whatsapp_connections(_org_id):
            return [{
                "id": 22,
                "broker_id": "phone-placeholder",
                "phone_number": "Unpaired:phone-placeholder",
            }]

    async def allow(*_args, **_kwargs):
        return None

    async def scoped_phone(phone_id, org_id):
        return {"id": phone_id, "organization_id": org_id, "broker_id": "phone-placeholder"}

    async def disconnected(*_args, **_kwargs):
        return {"connected": False}

    async def ingestor(method, path, **kwargs):
        calls.append((method, path, kwargs))
        await asyncio.sleep(0.01)
        return "http://ingestor:3001", httpx.Response(202, json={"state": "generating"})

    async def inline_to_thread(function, *args, **kwargs):
        return function(*args, **kwargs)

    monkeypatch.setattr(sync, "storage", Storage())
    monkeypatch.setattr(sync, "_resolve_active_organization_id", lambda _user, _tenant: "org-1")
    monkeypatch.setattr(sync, "_require_org_permission", allow)
    monkeypatch.setattr(sync, "_scoped_phone", scoped_phone)
    monkeypatch.setattr(sync, "_best_ingestor_status_for_broker", disconnected)
    monkeypatch.setattr(sync, "_first_ingestor_response", ingestor)
    monkeypatch.setattr(sync.asyncio, "to_thread", inline_to_thread)
    sync._phone_pair_tasks.clear()
    sync._phone_pair_results.clear()

    async def run():
        result = await sync.pair_code_phone(
            22,
            {"phone": "919820056180"},
            user={"id": "user-1"},
            tenant_id="org-1",
        )
        assert result == {"ok": True, "accepted": True, "state": "generating"}
        assert 22 in sync._phone_pair_tasks
        await sync._phone_pair_tasks[22]

    asyncio.run(run())

    assert calls[0][0:2] == ("POST", "/pair-code/start")
    assert sync._phone_pair_results[22]["state"] == "generating"
