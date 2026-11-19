"""Request-local auth-chain read dedup.

The auth/tenant chain used to repeat identical PostgREST lookups inside one
request (org list, WhatsApp connections, phone directory). The request-local
memo in routers.common collapses those to one read per request without any
cross-request caching: a second simulated request must hit storage again, and
provisioning writes must invalidate the memo so later reads in the same
request see the new rows.
"""
import asyncio

import pytest

from routers import common
from routers import whatsapp_sync as sync


class CountingStorage:
    def __init__(self):
        self.counts = {
            "get_user_organizations": 0,
            "list_org_whatsapp_connections": 0,
            "list_org_whatsapp_phone_directory": 0,
        }
        self.orgs = [{"id": "org-1", "created_at": "2026-01-01T00:00:00Z"}]
        self.connections = []
        self.directory = []

    def get_user_organizations(self, user_id):
        self.counts["get_user_organizations"] += 1
        return [dict(row) for row in self.orgs]

    def list_org_whatsapp_connections(self, org_id):
        self.counts["list_org_whatsapp_connections"] += 1
        return [dict(row) for row in self.connections]

    def list_org_whatsapp_phone_directory(self, org_id):
        self.counts["list_org_whatsapp_phone_directory"] += 1
        return [dict(row) for row in self.directory]

    def get_team_member_by_email(self, email, org_id=None):
        return {"id": "m-1", "email": email, "organization_id": org_id}

    def add_org_whatsapp_connection(self, org_id, phone_number, instance_name, broker_id):
        row = {
            "id": len(self.connections) + 1,
            "organization_id": org_id,
            "phone_number": phone_number,
            "instance_name": instance_name,
            "broker_id": broker_id,
            "is_active": True,
        }
        self.connections.append(row)
        return row

    def add_unpaired_org_whatsapp_connection_once(self, org_id, broker_id):
        for row in self.connections:
            if str(row["phone_number"]).startswith("Unpaired:"):
                return row
        return self.add_org_whatsapp_connection(org_id, f"Unpaired:{broker_id}", "", broker_id)

    def add_org_whatsapp_phone_directory(self, org_id, broker_id, phone_number, label, active):
        self.directory.append({
            "organization_id": org_id,
            "broker_id": broker_id,
            "phone_number": phone_number,
            "display_label": label,
            "is_active": active,
        })


def _install(monkeypatch, fake):
    # All routers share the single _StorageProxy instance, so pointing its
    # _real at the fake covers routers.common and routers.whatsapp_sync alike.
    monkeypatch.setattr(common.storage, "_real", fake)


def _simulate_request(user):
    async def _request():
        tenant_id = await common.get_tenant_context(user, "org-1")
        assert tenant_id == "org-1"
        return await sync.list_phones(user, tenant_id, False)

    return asyncio.run(_request())


USER = {"id": "user-1", "email": "owner@example.com", "user_metadata": {}}


def _unpaired_workspace(fake):
    fake.connections.append({
        "id": 1,
        "organization_id": "org-1",
        "phone_number": "Unpaired:phone-abc123",
        "instance_name": "",
        "broker_id": "phone-abc123",
        "is_active": True,
    })


def test_auth_chain_reads_once_per_request(monkeypatch):
    fake = CountingStorage()
    _unpaired_workspace(fake)
    _install(monkeypatch, fake)

    result = _simulate_request(USER)

    assert fake.counts == {
        "get_user_organizations": 1,
        "list_org_whatsapp_connections": 1,
        "list_org_whatsapp_phone_directory": 1,
    }
    assert len(result["phones"]) == 1


def test_no_cross_request_caching(monkeypatch):
    fake = CountingStorage()
    _unpaired_workspace(fake)
    _install(monkeypatch, fake)

    _simulate_request(USER)
    _simulate_request(USER)

    # The second simulated request re-reads everything: the memo is
    # request-scoped, so revocation/state changes are never hidden by a cache.
    assert fake.counts == {
        "get_user_organizations": 2,
        "list_org_whatsapp_connections": 2,
        "list_org_whatsapp_phone_directory": 2,
    }


def test_provisioning_write_invalidates_memo(monkeypatch):
    fake = CountingStorage()
    _install(monkeypatch, fake)
    user = {
        "id": "user-1",
        "email": "owner@example.com",
        "user_metadata": {"phone": "09876543210"},
    }

    result = _simulate_request(user)

    # Provisioning read the (empty) lists, wrote the signup phone, invalidated,
    # and list_phones re-queried and saw the new row in the same request.
    assert fake.counts["list_org_whatsapp_connections"] == 2
    assert fake.counts["list_org_whatsapp_phone_directory"] == 2
    assert fake.counts["get_user_organizations"] == 1
    numbers = {row.get("phone_number") for row in result["phones"]}
    assert "919876543210" in numbers


def test_revocation_visible_within_following_request(monkeypatch):
    fake = CountingStorage()
    _unpaired_workspace(fake)
    _install(monkeypatch, fake)

    _simulate_request(USER)
    # Membership revoked after the first request.
    fake.orgs = []

    async def _second_request():
        return await common.get_tenant_context(USER, "org-1")

    # No cached membership: the requested tenant is no longer allowed, and the
    # no-orgs resolution path cannot resurrect it (storage here declines to
    # create a workspace because org creation is not part of this fake).
    try:
        tid = asyncio.run(_second_request())
    except Exception:
        tid = None
    assert tid != "org-1"
