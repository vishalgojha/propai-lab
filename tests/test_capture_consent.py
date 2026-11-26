"""One-tap capture consent: receipt-based storage shape and revoke semantics.

Capture consent is the selection confirmation receipt itself: a
whatsapp_group_selection_receipts row with a non-blanked state_fingerprint
completed at or after PROPAI_CAPTURE_CONSENT_AFTER. Confirmations before the
cutoff were made under copy that said capture happened either way, so they
are not consent to storage. Revoking consent blanks the fingerprint (the
designed invalidated state used by every selection/connection change); the
receipt row stays as the audit record. No marker rows and no schema change.
"""
import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from routers import whatsapp_group_controls as wgc

CUTOFF = "2026-11-26T10:00:00+00:00"


def _receipt(org, conn, completed_at, fingerprint="abc123"):
    return {
        "organization_id": org,
        "whatsapp_connection_id": conn,
        "state_fingerprint": fingerprint,
        "completed_at": completed_at,
    }


class _FakeTable:
    def __init__(self, store):
        self.store = store
        self._ops = []
        self._limit = None
        self._update = None

    def select(self, *_args):
        self._ops, self._limit, self._update = [], None, None
        return self

    def eq(self, column, value):
        self._ops.append(("eq", column, value))
        return self

    def neq(self, column, value):
        self._ops.append(("neq", column, value))
        return self

    def gte(self, column, value):
        self._ops.append(("gte", column, value))
        return self

    def limit(self, n):
        self._limit = n
        return self

    def update(self, payload):
        self._update = payload
        return self

    def _matches(self, row):
        for op, col, val in self._ops:
            cell = row.get(col)
            if op == "eq" and cell != val:
                return False
            if op == "neq" and cell == val:
                return False
            if op == "gte" and not (cell is not None and cell >= val):
                return False
        return True

    def execute(self):
        if self._update is not None:
            for row in self.store:
                if self._matches(row):
                    row.update(self._update)
            return SimpleNamespace(data=[])
        rows = [row for row in self.store if self._matches(row)]
        if self._limit:
            rows = rows[: self._limit]
        return SimpleNamespace(data=rows)


class _FakeClient:
    def __init__(self, store):
        self.store = store

    def table(self, name):
        assert name == "whatsapp_group_selection_receipts"
        return _FakeTable(self.store)


@pytest.fixture
def store(monkeypatch):
    rows = []
    monkeypatch.setattr(wgc, "storage", SimpleNamespace(client=_FakeClient(rows)))
    monkeypatch.setenv("PROPAI_CAPTURE_CONSENT_AFTER", CUTOFF)
    return rows


def test_no_receipt_means_no_consent(store):
    assert wgc._capture_consent_active("org-1", 7) is False


def test_post_cutoff_current_receipt_is_consent(store):
    store.append(_receipt("org-1", 7, "2026-11-26T11:00:00+00:00"))
    assert wgc._capture_consent_active("org-1", 7) is True


def test_legacy_pre_cutoff_receipt_is_not_consent(store):
    # Confirmed under copy that said capture happened either way: not consent.
    store.append(_receipt("org-1", 7, "2026-11-25T09:00:00+00:00"))
    assert wgc._capture_consent_active("org-1", 7) is False


def test_blanked_fingerprint_is_not_consent(store):
    # Revoked, or invalidated by a selection/connection/device change.
    store.append(_receipt("org-1", 7, "2026-11-26T11:00:00+00:00", fingerprint=""))
    assert wgc._capture_consent_active("org-1", 7) is False


def test_consent_is_scoped_per_connection(store):
    store.append(_receipt("org-1", 7, "2026-11-26T11:00:00+00:00"))
    assert wgc._capture_consent_active("org-1", 8) is False
    assert wgc._capture_consent_active("org-2", 7) is False


def test_missing_cutoff_env_fails_closed(store, monkeypatch):
    monkeypatch.delenv("PROPAI_CAPTURE_CONSENT_AFTER")
    store.append(_receipt("org-1", 7, "2026-11-26T11:00:00+00:00"))
    assert wgc._capture_consent_active("org-1", 7) is False


def test_revoke_endpoint_blanks_fingerprint_and_reconfirm_restores(store, monkeypatch):
    store.append(_receipt("org-1", 7, "2026-11-26T11:00:00+00:00"))
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
    # Audit record kept, fingerprint blanked, consent inactive.
    assert len(store) == 1
    assert store[0]["state_fingerprint"] == ""
    assert wgc._capture_consent_active("org-1", 7) is False

    # Re-confirming writes a fresh receipt (the RPC path); consent returns.
    store[0]["state_fingerprint"] = "def456"
    store[0]["completed_at"] = datetime.now(timezone.utc).isoformat()
    assert wgc._capture_consent_active("org-1", 7) is True
