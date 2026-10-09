import pytest

from routers import workspace


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_market_inbox_feed_route_delegates_to_market_items(monkeypatch):
    async def inline_to_thread(func, *args, **kwargs):
        return func(*args, **kwargs)

    monkeypatch.setattr(workspace.asyncio, "to_thread", inline_to_thread)
    calls = []

    class StorageStub:
        def get_market_items_feed(self, **kwargs):
            calls.append(kwargs)
            return [{"id": 1, "message_type": "listing"}]

    monkeypatch.setattr(workspace, "storage", StorageStub())

    result = await workspace.inbox_market_items(
        limit=700,
        offset=-3,
        broker_key="919999999999",
        intent="SELL",
        result_type="requirements",
        user={},
        tenant_id="tenant-1",
    )

    assert result == [{"id": 1, "message_type": "listing"}]
    assert calls == [{
        "limit": 500,
        "offset": 0,
        "broker_key": "919999999999",
        "intent": "SELL",
        "result_type": "requirements",
        "asset_type": "all",
        "market_localities": [],
        "tenant_id": "tenant-1",
        "include_raw_unparsed": True,
        "source_state": "all",
    }]


def test_market_inbox_feed_route_is_registered():
    assert any(route.path == "/api/inbox/items" for route in workspace.router.routes)


@pytest.mark.anyio
async def test_raw_message_archive_is_workspace_scoped_and_paginated(monkeypatch):
    async def inline_to_thread(func, *args, **kwargs):
        return func(*args, **kwargs)

    monkeypatch.setattr(workspace.asyncio, "to_thread", inline_to_thread)
    calls = {"filters": [], "orders": [], "offset": None, "limit": None}

    class Query:
        def select(self, columns):
            calls["columns"] = columns
            return self

        def eq(self, key, value):
            calls["filters"].append((key, value))
            return self

        def ilike(self, key, value):
            calls["filters"].append((key, value))
            return self

        def order(self, key, **kwargs):
            calls["orders"].append((key, kwargs))
            return self

        def offset(self, value):
            calls["offset"] = value
            return self

        def limit(self, value):
            calls["limit"] = value
            return self

        def execute(self):
            return type("Response", (), {"data": [{
                "id": 91,
                "message": "3 BHK rent in Bandra East",
                "group_name": "Bandra Brokers",
                "sender": "A Broker",
                "timestamp": "2026-10-09T10:00:00Z",
            }]})()

    class Client:
        def table(self, name):
            assert name == "raw_messages"
            return Query()

    monkeypatch.setattr(workspace, "storage", type("Storage", (), {"client": Client()})())
    result = await workspace.inbox_raw_messages(
        limit=500,
        offset=50,
        q="Bandra",
        user={"id": "user-1"},
        tenant_id="tenant-1",
    )

    assert calls["filters"] == [
        ("tenant_id", "tenant-1"),
        ("is_group", True),
        ("message", "%Bandra%"),
    ]
    assert calls["offset"] == 50
    assert calls["limit"] == 100
    assert result["total"] is None
    assert result["items"][0]["is_source_message"] is True
    assert result["items"][0]["is_unparsed"] is False
    assert result["items"][0]["raw_message_id"] == 91


@pytest.mark.anyio
async def test_raw_message_archive_requires_active_workspace():
    with pytest.raises(Exception) as error:
        await workspace.inbox_raw_messages(user={"id": "user-1"}, tenant_id=None)
    assert getattr(error.value, "status_code", None) == 403


@pytest.mark.anyio
async def test_raw_message_detail_scopes_id_lookup_to_workspace(monkeypatch):
    async def inline_to_thread(func, *args, **kwargs):
        return func(*args, **kwargs)

    monkeypatch.setattr(workspace.asyncio, "to_thread", inline_to_thread)
    filters = []

    class Query:
        def select(self, _columns): return self
        def eq(self, key, value):
            filters.append((key, value))
            return self
        def limit(self, _limit): return self
        def execute(self):
            return type("Response", (), {"data": [{"id": 91, "message": "Source evidence"}]})()

    class Client:
        def table(self, name):
            assert name == "raw_messages"
            return Query()

    monkeypatch.setattr(workspace, "storage", type("Storage", (), {"client": Client()})())
    result = await workspace.inbox_raw_message_detail(
        91,
        user={"id": "user-1"},
        tenant_id="tenant-1",
    )

    assert filters == [("tenant_id", "tenant-1"), ("is_group", True), ("id", 91)]
    assert result["raw"]["message"] == "Source evidence"
