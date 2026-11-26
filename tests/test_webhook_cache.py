"""Bounded TTL caches on the WhatsApp webhook hot path.

These caches cover only stable or slowly-changing lookups (tenant
resolution, group display names, LID->phone mappings). Consent and
revocation checks must never be cached; the tests below pin that boundary
by asserting nothing in the consent path reads from these caches.
"""

import asyncio
import time

import pytest

from routers import infra


@pytest.fixture(autouse=True)
def clear_caches():
    infra._TENANT_RESOLVE_CACHE.clear()
    infra._GROUP_NAME_CACHE.clear()
    infra._LID_RESOLVE_CACHE.clear()
    yield
    infra._TENANT_RESOLVE_CACHE.clear()
    infra._GROUP_NAME_CACHE.clear()
    infra._LID_RESOLVE_CACHE.clear()


def test_ttl_cache_hit_and_miss():
    cache = infra._TTLCache(ttl_seconds=60)
    assert cache.get("k") is None
    cache.set("k", "v")
    assert cache.get("k") == "v"


def test_ttl_cache_expires(monkeypatch):
    cache = infra._TTLCache(ttl_seconds=60)
    now = time.monotonic()
    monkeypatch.setattr(time, "monotonic", lambda: now)
    cache.set("k", "v")
    monkeypatch.setattr(time, "monotonic", lambda: now + 61)
    assert cache.get("k") is None


def test_ttl_cache_evicts_oldest_when_full():
    cache = infra._TTLCache(ttl_seconds=60, max_entries=2)
    cache.set("a", 1)
    cache.set("b", 2)
    cache.set("c", 3)
    assert cache.get("a") is None
    assert cache.get("b") == 2
    assert cache.get("c") == 3


def test_tenant_resolve_caches_positive_result(monkeypatch):
    calls = []

    class FakeStorage:
        def get_org_whatsapp_connection_by_broker_id(self, broker_id):
            calls.append(broker_id)
            return {"organization_id": "tenant-1"}

    monkeypatch.setattr(infra, "storage", FakeStorage())
    assert asyncio.run(infra._resolve_webhook_tenant("broker-1")) == "tenant-1"
    assert asyncio.run(infra._resolve_webhook_tenant("broker-1")) == "tenant-1"
    assert calls == ["broker-1"]


def test_tenant_resolve_does_not_cache_misses(monkeypatch):
    calls = []

    class FakeStorage:
        def get_org_whatsapp_connection_by_broker_id(self, broker_id):
            calls.append(broker_id)
            return None

    monkeypatch.setattr(infra, "storage", FakeStorage())
    assert asyncio.run(infra._resolve_webhook_tenant("broker-1")) is None
    assert asyncio.run(infra._resolve_webhook_tenant("broker-1")) is None
    assert calls == ["broker-1", "broker-1"]


def test_group_name_cache_round_trip(monkeypatch):
    calls = []

    def fake_resolve(jid):
        calls.append(jid)
        return "Bandra West Brokers"

    monkeypatch.setattr(infra, "_resolve_group_name", fake_resolve)
    assert asyncio.run(infra._resolve_group_name_cached("120@g.us")) == "Bandra West Brokers"
    assert asyncio.run(infra._resolve_group_name_cached("120@g.us")) == "Bandra West Brokers"
    assert calls == ["120@g.us"]


def test_lid_resolve_caches_only_positive_mappings(monkeypatch):
    calls = []
    state = {"gm": None}

    class FakeStorage:
        def resolve_lid_from_group_members(self, sender_jid, group_jid):
            calls.append((sender_jid, group_jid))
            return state["gm"]

    monkeypatch.setattr(infra, "storage", FakeStorage())
    # Unresolved LIDs are not cached: a later mapping must be picked up.
    assert asyncio.run(infra._resolve_lid_member("111@lid", "120@g.us")) is None
    state["gm"] = {"member_phone": "919999999999", "display_name": "Ravi"}
    assert asyncio.run(infra._resolve_lid_member("111@lid", "120@g.us")) == {"member_phone": "919999999999", "display_name": "Ravi"}
    assert asyncio.run(infra._resolve_lid_member("111@lid", "120@g.us")) == {"member_phone": "919999999999", "display_name": "Ravi"}
    assert calls == [("111@lid", "120@g.us"), ("111@lid", "120@g.us")]


def test_consent_checks_have_no_cache_path():
    """The consent/extraction call sites in the webhook must call their
    resolvers directly, never a cache. Pin this structurally: no consent
    symbol may appear next to a cache reference in the webhook body."""
    import inspect

    src = inspect.getsource(infra.webhook)
    assert "extraction_allowed_for_group" in src
    assert "extraction_allowed" in src
    for line in src.splitlines():
        if "extraction_allowed" in line:
            assert "CACHE" not in line.upper()
