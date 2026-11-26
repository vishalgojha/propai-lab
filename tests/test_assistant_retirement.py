"""Built-in assistant retirement (26 Nov 2026): paid paths must be unreachable.

Owner decision: the built-in PropAI assistant is retired for cost; Instinct or
MCP are the supported assistant routes. These tests prove the gated endpoints
keep their authentication and return before any ElevenLabs/Sarvam/storage work.
"""

import asyncio
import os

import pytest


def _boom(name):
    def _raise(*args, **kwargs):
        raise AssertionError(f"paid/retired path reached: {name}")

    async def _raise_async(*args, **kwargs):
        raise AssertionError(f"paid/retired path reached: {name}")

    return _raise, _raise_async


def test_internal_self_chat_silent_ack_after_auth_no_paid_calls(monkeypatch):
    """Ingestor-facing route: valid token -> blank reply, zero paid/storage work."""
    from routers import self_chat as sc

    monkeypatch.setenv("PROPAI_INTERNAL_TOKEN", "test-internal-token")
    sync_boom, async_boom = _boom("transcribe")
    monkeypatch.setattr(sc, "_transcribe_self_chat_audio", async_boom)
    _, agent_boom = _boom("agent")
    monkeypatch.setattr(sc, "_run_self_chat_agent", agent_boom)
    _, storage_boom = _boom("storage")
    monkeypatch.setattr(sc, "_self_chat_storage_call", storage_boom)

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(sc.router)
    with TestClient(app) as client:
        # Auth preserved: no/wrong token is still rejected.
        assert client.post("/api/internal/self-chat", json={}).status_code in {401, 422}
        bad = client.post(
            "/api/internal/self-chat",
            json={"broker_id": "b1", "text": "hi", "message_id": "m1", "sender_jid": ""},
            headers={"X-PropAI-Internal-Token": "wrong"},
        )
        assert bad.status_code == 401
        ok = client.post(
            "/api/internal/self-chat",
            json={"broker_id": "b1", "text": "2bhk bandra", "message_id": "m1", "sender_jid": "123@s.whatsapp.net"},
            headers={"X-PropAI-Internal-Token": "test-internal-token"},
        )
    assert ok.status_code == 200
    assert ok.json() == {"reply": ""}  # ingestor sends nothing for a blank reply


def test_user_self_chat_returns_retired_notice_no_paid_calls(monkeypatch):
    from routers import self_chat as sc

    _, agent_boom = _boom("agent")
    monkeypatch.setattr(sc, "_run_self_chat_agent", agent_boom)
    _, storage_boom = _boom("storage")
    monkeypatch.setattr(sc, "_self_chat_storage_call", storage_boom)

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(sc.router)
    with TestClient(app) as client:
        assert client.post("/api/self-chat", json={"text": "hi"}).status_code == 401
    app.dependency_overrides[sc.require_user] = lambda: {"id": "u1"}
    with TestClient(app) as client:
        response = client.post("/api/self-chat", json={"text": "find 2bhk"})
    assert response.status_code == 200
    assert "retired" in response.json()["reply"].lower()


def test_in_app_chat_returns_410_no_paid_calls(monkeypatch):
    from routers import ai_chat

    _, agent_boom = _boom("workspace agent")
    monkeypatch.setattr(ai_chat, "_workspace_provider_candidates", agent_boom)

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(ai_chat.router)
    with TestClient(app) as client:
        assert client.post("/api/ai/chat", json={"messages": [{"role": "user", "content": "hi"}]}).status_code == 401
    app.dependency_overrides[ai_chat.require_user] = lambda: {"id": "u1"}
    app.dependency_overrides[ai_chat.get_tenant_context] = lambda: "org1"
    with TestClient(app) as client:
        response = client.post(
            "/api/ai/chat",
            json={"messages": [{"role": "user", "content": "find 2bhk bandra"}]},
        )
    assert response.status_code == 410
    assert "retired" in response.json()["detail"].lower()


def test_scribe_token_route_retired_no_elevenlabs_mint():
    """Static guard: the retired scribe-token route must keep auth, answer 410,
    and contain no path that can call ElevenLabs or mint a token."""
    from pathlib import Path

    source = Path("frontend/src/app/api/voice/scribe-token/route.ts").read_text()
    assert "api.elevenlabs.io" not in source
    assert "single-use-token" not in source
    assert "ELEVENLABS_API_KEY" not in source
    assert "auth.getUser" in source, "authentication must be preserved"
    assert "401" in source, "unauthenticated callers must still get 401"
    assert "410" in source and "retired" in source.lower()
