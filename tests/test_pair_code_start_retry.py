import asyncio
from types import SimpleNamespace

import httpx

from routers import whatsapp_sync
from routers.common import _ingestor_failure_message

PHONE_ID = 167
PHONE = {
    "id": PHONE_ID,
    "broker_id": "phone-e10598e1f1df",
    "phone_number": "919773757759",
}


def _wire_pairing(monkeypatch, responses):
    calls = []

    async def organization(_user, _tenant_id):
        return "org-218187ca"

    async def allow(*_args, **_kwargs):
        return None

    async def phone(_phone_id, _org_id):
        return dict(PHONE)

    async def live_status(_broker_id, timeout=2):
        return None

    async def ingestor(method, path, *, timeout, headers, **_body):
        calls.append((method, path))
        return "http://ingestor", responses[len(calls) - 1]

    monkeypatch.setattr(whatsapp_sync, "_request_organization_id", organization)
    monkeypatch.setattr(whatsapp_sync, "_require_org_permission", allow)
    monkeypatch.setattr(whatsapp_sync, "_scoped_phone", phone)
    monkeypatch.setattr(whatsapp_sync, "_best_ingestor_status_for_broker", live_status)
    monkeypatch.setattr(whatsapp_sync, "_ingestor_failure_message", _ingestor_failure_message)
    monkeypatch.setattr(whatsapp_sync, "_first_ingestor_response", ingestor)
    monkeypatch.setattr(
        whatsapp_sync,
        "storage",
        SimpleNamespace(
            update_org_whatsapp_connection=lambda _phone_id, updates: {**PHONE, **updates},
            list_org_whatsapp_connections=lambda _org_id: [dict(PHONE)],
        ),
    )
    monkeypatch.setattr(whatsapp_sync, "_PAIR_START_RETRY_DELAY", 0.0)
    monkeypatch.setitem(whatsapp_sync._phone_pair_results, PHONE_ID, {})
    monkeypatch.delitem(whatsapp_sync._phone_pair_tasks, PHONE_ID, raising=False)
    return calls


async def _start_pair():
    await whatsapp_sync.pair_code_phone(
        PHONE_ID,
        {"phone": PHONE["phone_number"]},
        user={"id": "admin"},
        tenant_id="org-218187ca",
    )
    task = whatsapp_sync._phone_pair_tasks.get(PHONE_ID)
    if task:
        await task


def _conflict():
    return httpx.Response(
        409,
        json={"error": "pairing session is still releasing; retry in a few seconds"},
        request=httpx.Request("POST", "http://ingestor:3001/pair-code/start"),
    )


def test_transient_409_is_retried_without_asking_the_operator_to_click_again(monkeypatch):
    responses = [_conflict(), _conflict(), httpx.Response(
        202,
        json={"ok": True, "state": "generating"},
        request=httpx.Request("POST", "http://ingestor:3001/pair-code/start"),
    )]
    calls = _wire_pairing(monkeypatch, responses)

    asyncio.run(_start_pair())

    assert len(calls) == 3
    assert whatsapp_sync._phone_pair_results[PHONE_ID]["state"] == "generating"


def test_exhausted_retries_surface_the_ingestor_reason_not_a_generic_error(monkeypatch):
    calls = _wire_pairing(monkeypatch, [_conflict(), _conflict(), _conflict()])

    asyncio.run(_start_pair())

    assert len(calls) == 3
    result = whatsapp_sync._phone_pair_results[PHONE_ID]
    assert result["state"] == "pairing_error"
    assert result["pairing_error"] == "pairing session is still releasing; retry in a few seconds"


def test_non_conflict_failures_are_not_retried(monkeypatch):
    responses = [httpx.Response(
        500,
        json={"error": "WhatsApp service is not ready"},
        request=httpx.Request("POST", "http://ingestor:3001/pair-code/start"),
    )]
    calls = _wire_pairing(monkeypatch, responses)

    asyncio.run(_start_pair())

    assert len(calls) == 1
    result = whatsapp_sync._phone_pair_results[PHONE_ID]
    assert result["state"] == "pairing_error"
    assert result["pairing_error"] == "WhatsApp service is not ready"


def test_status_stays_generating_while_a_background_retry_is_running(monkeypatch):
    async def organization(_user, _tenant_id):
        return "org-218187ca"

    async def allow(*_args, **_kwargs):
        return None

    async def phone(_phone_id, _org_id):
        return dict(PHONE)

    async def ingestor(method, path, *, timeout, headers):
        return "http://ingestor", httpx.Response(
            200,
            json={"ok": True, "state": "not_started"},
            request=httpx.Request("GET", "http://ingestor:3001/pair-code/status"),
        )

    monkeypatch.setattr(whatsapp_sync, "_request_organization_id", organization)
    monkeypatch.setattr(whatsapp_sync, "_require_org_permission", allow)
    monkeypatch.setattr(whatsapp_sync, "_scoped_phone", phone)
    monkeypatch.setattr(whatsapp_sync, "_ingestor_failure_message", _ingestor_failure_message)
    monkeypatch.setattr(whatsapp_sync, "_first_ingestor_response", ingestor)

    async def run():
        waiter = asyncio.create_task(asyncio.Event().wait())
        whatsapp_sync._phone_pair_tasks[PHONE_ID] = waiter
        whatsapp_sync._phone_pair_results[PHONE_ID] = {
            "ok": True,
            "state": "generating",
            "pairing_attempt": 2,
        }
        try:
            return await whatsapp_sync.pair_code_status(
                PHONE_ID, user={"id": "admin"}, tenant_id="org-218187ca"
            )
        finally:
            waiter.cancel()
            whatsapp_sync._phone_pair_tasks.pop(PHONE_ID, None)
            whatsapp_sync._phone_pair_results.pop(PHONE_ID, None)

    result = asyncio.run(run())

    assert result["state"] == "generating"
