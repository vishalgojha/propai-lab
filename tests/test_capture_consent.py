"""One-tap capture consent marker: storage shape and revoke semantics.

The consent lives as a marker row on organization_group_connections with a
synthetic JID so no migration is needed and no group-scoped query can see it.
The ingestor requires BOTH the marker (opted_out=False) and an active
selection row for a group before persisting that group's messages.
"""
import asyncio
from types import SimpleNamespace

import pytest

from routers import whatsapp_group_controls as wgc


class _FakeTable:
    def __init__(self, store):
        self.store = store
        self._filters = {}
        self._limit = None
        self._result = None

    def select(self, *_args):
        self._filters = {}
        self._limit = None
        self._result = None
        return self

    def eq(self, column, value):
        self._filters[column] = value
        return self

    def limit(self, n):
        self._limit = n
        return self

    def upsert(self, payload, on_conflict=None):
        key = (payload["organization_id"], payload["whatsapp_connection_id"], payload["group_jid"])
        self.store[key] = dict(payload)
        self._result = [dict(payload)]
        return self

    def execute(self):
        if self._result is not None:
            result, self._result = self._result, None
            return SimpleNamespace(data=result)
        rows = [row for row in self.store.values() if all(row.get(k) == v for k, v in self._filters.items())]
        if self._limit:
            rows = rows[: self._limit]
        return SimpleNamespace(data=rows)


class _FakeClient:
    def __init__(self, store):
        self.store = store

    def table(self, name):
        assert name == "organization_group_connections"
        return _FakeTable(self.store)


@pytest.fixture
def store(monkeypatch):
    rows = {}
    monkeypatch.setattr(wgc, "storage", SimpleNamespace(client=_FakeClient(rows)))
    return rows


def test_allow_writes_active_consent_marker(store):
    wgc._write_capture_consent("org-1", 7, True)
    marker = store[("org-1", 7, wgc.CAPTURE_CONSENT_GROUP_JID)]
    assert marker["opted_out"] is False
    # Never counts as a selected group and is never published.
    assert marker["is_active"] is False
    assert marker["public_market_source"] is False
    assert marker["group_name"] == wgc.CAPTURE_CONSENT_VERSION


def test_consent_active_only_with_active_marker(store):
    assert wgc._capture_consent_active("org-1", 7) is False
    wgc._write_capture_consent("org-1", 7, True)
    assert wgc._capture_consent_active("org-1", 7) is True
    wgc._write_capture_consent("org-1", 7, False)
    assert wgc._capture_consent_active("org-1", 7) is False


def test_consent_is_scoped_per_connection(store):
    wgc._write_capture_consent("org-1", 7, True)
    assert wgc._capture_consent_active("org-1", 8) is False
    assert wgc._capture_consent_active("org-2", 7) is False


def test_revoke_endpoint_turns_saving_off(store, monkeypatch):
    wgc._write_capture_consent("org-1", 7, True)
    monkeypatch.setattr(wgc, "_resolve_active_organization_id", lambda user, tenant: "org-1")
    async def _allow(*_args):
        return None
    monkeypatch.setattr(wgc, "_require_org_permission", _allow)
    monkeypatch.setattr(wgc, "_connection", lambda org, conn: {"id": conn})

    result = asyncio.run(wgc.revoke_capture_consent(
        wgc.ExtractionControlRequest(whatsapp_connection_id=7),
        user={"id": "user-1"},
        tenant_id="org-1",
    ))
    assert result == {"ok": True, "capture_consent_active": False}
    assert wgc._capture_consent_active("org-1", 7) is False

    # Re-confirming flips the same marker back on; no duplicate rows.
    wgc._write_capture_consent("org-1", 7, True)
    assert wgc._capture_consent_active("org-1", 7) is True
    markers = [k for k in store if k[2] == wgc.CAPTURE_CONSENT_GROUP_JID]
    assert len(markers) == 1


def test_marker_jid_never_matches_real_group(store):
    # Every group-scoped filter in the product matches real @g.us JIDs; the
    # marker must stay invisible to them.
    assert not wgc.CAPTURE_CONSENT_GROUP_JID.endswith("@g.us")
