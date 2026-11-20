import asyncio
from pathlib import Path
import httpx
from fastapi import FastAPI
from domain_glossary import build_ai_domain_context
from routers import external_agent


def test_public_knowledge_route_and_extraction_separation():
    app = FastAPI()
    app.include_router(external_agent.router)
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get("/api/external/v1/knowledge")
            assert response.status_code == 200
            assert "public, max-age=300" == response.headers["cache-control"]
            assert "(+1)" in response.text and "not direct" in response.text
            assert "no client, deal or contact data" in response.text
            assert "grants no access" in response.text
            for text in ("Never search another broker's DMs through cross-search", "other group members", "members' expectations", "not a guarantee", "no new groups selected", "never count as consent", "reload before", "reader access is separate"):
                assert text in response.text, text
            assert "specific locality stays specific" in response.text
            assert "Do not guess" in response.text
    asyncio.run(run())
    assert "(+1)" not in build_ai_domain_context()
    assert "How to search deal flow" not in build_ai_domain_context()


def test_missing_background_fails_without_partial_claim(monkeypatch):
    monkeypatch.setattr(external_agent, "BROKER_AGENT_KNOWLEDGE", Path("/nonexistent/knowledge.md"))
    app = FastAPI()
    app.include_router(external_agent.router)
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get("/api/external/v1/knowledge")
            assert response.status_code == 503
    asyncio.run(run())


def test_background_is_account_free_constant_not_a_storage_or_auth_operation(monkeypatch):
    class NoStorage:
        def __getattr__(self, name):
            raise AssertionError("knowledge must not inspect storage")
    monkeypatch.setattr(external_agent, "storage", NoStorage())
    app = FastAPI()
    app.include_router(external_agent.router)
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            anon = await client.get("/api/external/v1/knowledge")
            unknown = await client.get("/api/external/v1/knowledge", headers={"Authorization":"Bearer FIXTURE_INVALID", "X-Tenant-Id":"FIXTURE_TENANT"})
            assert anon.status_code == unknown.status_code == 200
            assert anon.content == unknown.content
            assert "text/plain" in anon.headers["content-type"]
            assert "FIXTURE_" not in anon.text
    asyncio.run(run())
