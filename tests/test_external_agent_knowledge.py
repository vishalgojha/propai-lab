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
            for text in ("Direct messages are not ingested or available", "Do not raise it at every new property-search session", "Respect a remembered prior answer", "Would you like to review", "A yes to reviewing is not approval", "Do not claim all existing connected assistants were notified", "other group members", "members' expectations", "not a guarantee", "no new groups selected", "never count as consent", "reload before", "reader access is separate"):
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


def test_building_index_and_docs_are_public_and_safe():
    app = FastAPI()
    app.include_router(external_agent.router)
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            index = await client.get("/api/external/v1/knowledge/buildings")
            assert index.status_code == 200
            assert "public, max-age=300" == index.headers["cache-control"]
            assert "Agami Eternity" in index.text
            assert "in-boundary: identity from an opened non-broker page (26)" in index.text
            assert "unverified" in index.text
            doc = await client.get("/api/external/v1/knowledge/buildings/agami-eternity")
            assert doc.status_code == 200
            assert "Agami Eternity" in doc.text and "Kalanagar" in doc.text
            candidate = await client.get("/api/external/v1/knowledge/buildings/bhim-prerna")
            assert candidate.status_code == 200
            assert "no facts are asserted" in candidate.text
            for bad in ("../BROKER_AGENT_KNOWLEDGE", "no-such-building", "agami-eternity.md", "A" * 200):
                bad_resp = await client.get(f"/api/external/v1/knowledge/buildings/{bad}")
                assert bad_resp.status_code == 404, bad
            # index must not leak private-dataset statistics
            for leak in ("posts in the window", "One broker post", "repeated many times"):
                assert leak not in index.text
            assert leak not in doc.text
    asyncio.run(run())
