import asyncio

import pytest
from fastapi import FastAPI, HTTPException

from routers import external_agent


class Query:
    def __init__(self):
        self.filters = []

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, field, value):
        self.filters.append((field, value))
        return self

    def ilike(self, *_args):
        return self

    def or_(self, expression):
        self.or_expression = expression
        return self

    def gte(self, *_args):
        return self

    def lte(self, *_args):
        return self

    def order(self, *_args, **_kwargs):
        return self

    def limit(self, *_args):
        return self

    def offset(self, *_args):
        return self

    def execute(self):
        return type("Result", (), {"data": []})()


class Client:
    def __init__(self):
        self.query = Query()

    def table(self, _table):
        return self.query


def test_dms_search_requires_consent_before_query(monkeypatch):
    client = Client()
    monkeypatch.setattr(external_agent, "storage", type("Storage", (), {"client": client})())
    with pytest.raises(HTTPException, match="Private DM access is disabled"):
        asyncio.run(external_agent.external_raw_message_search(
            scope="dms", limit=25, offset=0,
            key={"tenant_id": "tenant-1", "scopes": ["raw_messages:read", "raw_messages:dms"]},
        ))
    assert client.query.filters == []


def test_dms_search_applies_tenant_and_private_filter(monkeypatch):
    client = Client()
    monkeypatch.setattr(external_agent, "storage", type("Storage", (), {"client": client})())
    result = asyncio.run(external_agent.external_raw_message_search(
        scope="dms", limit=25, offset=0,
        key={
            "tenant_id": "tenant-1",
            "scopes": ["raw_messages:read", "raw_messages:dms"],
            "external_agent_dms_enabled": True,
        },
    ))
    assert ("tenant_id", "tenant-1") in client.query.filters
    assert ("is_group", False) in client.query.filters
    assert result["scope"] == "dms"


def test_group_search_remains_group_only(monkeypatch):
    client = Client()
    monkeypatch.setattr(external_agent, "storage", type("Storage", (), {"client": client})())
    asyncio.run(external_agent.external_raw_message_search(
        scope="groups", limit=25, offset=0,
        key={"tenant_id": "tenant-1", "scopes": ["raw_messages:read"]},
    ))
    assert ("is_group", True) in client.query.filters


def test_search_matches_contact_identity_as_well_as_message(monkeypatch):
    client = Client()
    monkeypatch.setattr(external_agent, "storage", type("Storage", (), {"client": client})())
    asyncio.run(external_agent.external_raw_message_search(
        q="Sheetal", scope="dms", limit=25, offset=0,
        key={
            "tenant_id": "tenant-1",
            "scopes": ["raw_messages:read", "raw_messages:dms"],
            "external_agent_dms_enabled": True,
        },
    ))
    assert "message.ilike.%Sheetal%" in client.query.or_expression
    assert "sender.ilike.%Sheetal%" in client.query.or_expression
    assert "sender_phone.ilike.%Sheetal%" in client.query.or_expression


def test_dm_conversation_context_stays_tenant_and_chat_scoped(monkeypatch):
    class ConversationQuery(Query):
        calls = 0

        def execute(self):
            self.calls += 1
            if self.calls == 1:
                return type("Result", (), {"data": [{"id": 42, "is_group": False, "sender_jid": "chat-1"}]})()
            return type("Result", (), {"data": []})()

    query = ConversationQuery()
    client = type("Client", (), {"query": query, "table": lambda self, _: query})()
    monkeypatch.setattr(external_agent, "storage", type("Storage", (), {"client": client})())
    result = asyncio.run(external_agent.external_raw_message_conversation(
        raw_message_id=42,
        key={
            "tenant_id": "tenant-1",
            "scopes": ["raw_messages:read", "raw_messages:dms"],
            "external_agent_dms_enabled": True,
        },
    ))
    assert ("tenant_id", "tenant-1") in client.query.filters
    assert ("is_group", False) in client.query.filters
    assert result["count"] == 0


def test_search_rejects_unknown_scope(monkeypatch):
    app = FastAPI()
    app.include_router(external_agent.router)
    scope_parameter = next(
        parameter
        for parameter in app.openapi()["paths"]["/api/external/v1/messages/search"]["get"]["parameters"]
        if parameter["name"] == "scope"
    )
    assert scope_parameter["schema"]["pattern"] == "^(groups|dms|all)$"


def test_public_agent_guide_is_fetchable_without_a_key():
    response = asyncio.run(external_agent.external_agent_docs())
    guide = response.body.decode("utf-8")
    normalized_guide = " ".join(guide.split())
    assert response.media_type == "text/plain"
    assert "GET https://api.propai.live/api/external/v1/docs" in guide
    assert "scope=dms" in guide
    assert "Do not retry with `scope=all`" in normalized_guide
    assert "ppai_" not in guide


def test_standing_search_creation_requires_explicit_confirmation():
    with pytest.raises(HTTPException, match="explicit confirmation"):
        asyncio.run(external_agent.external_create_standing_search(
            external_agent.StandingSearchCreate(
                name="Bandra rentals", query_text="3 BHK rent Bandra", confirmed=False,
            ),
            key={"tenant_id": "tenant-1", "scopes": ["standing_searches:write"]},
        ))


def test_followup_write_is_private_and_never_outbound(monkeypatch):
    class InsertQuery:
        def insert(self, payload):
            self.payload = payload
            return self

        def execute(self):
            return type("Result", (), {"data": [{"id": 8, **self.payload}]})()

    query = InsertQuery()
    monkeypatch.setattr(external_agent, "storage", type("Storage", (), {
        "client": type("Client", (), {"table": lambda self, _: query})(),
    })())
    result = asyncio.run(external_agent.external_create_followup(
        external_agent.FollowupCreate(title="Review match", due_date="2026-11-13"),
        key={"tenant_id": "tenant-1", "scopes": ["followups:write"]},
    ))
    assert query.payload["tenant_id"] == "tenant-1"
    assert query.payload["status"] == "pending"
    assert result["outbound_sent"] is False
