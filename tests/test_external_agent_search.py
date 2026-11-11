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


def test_search_rejects_unknown_scope(monkeypatch):
    app = FastAPI()
    app.include_router(external_agent.router)
    scope_parameter = next(
        parameter
        for parameter in app.openapi()["paths"]["/api/external/v1/messages/search"]["get"]["parameters"]
        if parameter["name"] == "scope"
    )
    assert scope_parameter["schema"]["pattern"] == "^(groups|dms|all)$"
