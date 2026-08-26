import asyncio

import routers.brokers as brokers_router


def test_broker_directory_uses_source_pagination_and_returns_total(monkeypatch):
    source = [
        {
            "id": f"broker-{index}",
            "primary_phone": f"919999{index:06d}",
            "canonical_name": f"Broker {index}",
            "observation_count": 1,
            "listing_count": 1,
            "requirement_count": 0,
            "specialty_localities": [],
            "channels": [],
        }
        for index in range(321)
    ]
    calls = []

    class FakeStorage:
        def is_super_admin(self, _user_id):
            return True

        def get_workspace_blocked_broker_keys(self, _tenant_id):
            return set()

        def get_brokers_feed_total(self, **_kwargs):
            return len(source)

        def get_brokers_feed(self, limit, offset, min_observations, tenant_id, network_wide):
            calls.append((limit, offset, min_observations, tenant_id, network_wide))
            return source[offset:offset + limit]

        def broker_is_workspace_blocked(self, **_kwargs):
            return False

    monkeypatch.setattr(brokers_router, "storage", FakeStorage())

    async def run_sync(function, *args, **kwargs):
        return function(*args, **kwargs)

    monkeypatch.setattr(brokers_router.asyncio, "to_thread", run_sync)

    first = asyncio.run(brokers_router.list_brokers(
        user={"id": "admin"}, tenant_id="tenant-1", page_limit=60, page_offset=0,
    ))
    later = asyncio.run(brokers_router.list_brokers(
        user={"id": "admin"}, tenant_id="tenant-1", page_limit=60, page_offset=300,
    ))

    assert first["total"] == 321
    assert len(first["brokers"]) == 60
    assert [broker["id"] for broker in later["brokers"]] == [
        f"broker-{index}" for index in range(300, 321)
    ]
    assert calls == [(60, 0, 1, "tenant-1", True), (60, 300, 1, "tenant-1", True)]
