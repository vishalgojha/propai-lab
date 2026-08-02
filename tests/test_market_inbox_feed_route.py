import asyncio

from routers import workspace


def test_market_inbox_feed_route_delegates_to_parsed_observations(monkeypatch):
    calls = []

    class StorageStub:
        def get_observations_feed(self, **kwargs):
            calls.append(kwargs)
            return [{"id": 1, "message_type": "listing"}]

    monkeypatch.setattr(workspace, "storage", StorageStub())

    result = asyncio.run(
        workspace.observations_feed(
            limit=700,
            offset=-3,
            broker_key="919999999999",
            intent="SELL",
            user={},
            tenant_id="tenant-1",
        )
    )

    assert result == [{"id": 1, "message_type": "listing"}]
    assert calls == [{
        "limit": 500,
        "offset": 0,
        "broker_key": "919999999999",
        "intent": "SELL",
        "tenant_id": "tenant-1",
    }]


def test_market_inbox_feed_route_is_registered():
    assert any(route.path == "/api/observations/feed" for route in workspace.router.routes)
