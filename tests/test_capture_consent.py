"""One-tap capture consent: receipt-bound consent version and revoke semantics.

Capture consent is the selection confirmation receipt itself: a
whatsapp_group_selection_receipts row with a non-blanked state_fingerprint
AND capture_consent_version equal to the current wording version. The API
records the version only when the confirming client explicitly acknowledged
the capture-consent wording; a confirmation submitted by an older client
(version NULL) still saves the selection but is not capture consent, so a
stale bundle cannot grant capture. Revoking consent blanks the fingerprint
and the version (the designed invalidated state used by every
selection/connection change); the receipt row stays as the audit record.
"""
import asyncio
from types import SimpleNamespace

import pytest

from routers import whatsapp_group_controls as wgc


def _receipt(org, conn, version=wgc.CAPTURE_CONSENT_VERSION, fingerprint="abc123"):
    return {
        "organization_id": org,
        "whatsapp_connection_id": conn,
        "state_fingerprint": fingerprint,
        "capture_consent_version": version,
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
    return rows


def test_no_receipt_means_no_consent(store):
    assert wgc._capture_consent_active("org-1", 7) is False


def test_acked_current_receipt_is_consent(store):
    store.append(_receipt("org-1", 7))
    assert wgc._capture_consent_active("org-1", 7) is True


def test_unacked_receipt_is_not_consent(store):
    # Confirmed by an older client that never showed the capture wording:
    # the selection is saved, but it is not consent to storage.
    store.append(_receipt("org-1", 7, version=None))
    assert wgc._capture_consent_active("org-1", 7) is False


def test_wrong_version_receipt_is_not_consent(store):
    store.append(_receipt("org-1", 7, version="broker-group-capture-v0"))
    assert wgc._capture_consent_active("org-1", 7) is False


def test_blanked_fingerprint_is_not_consent(store):
    # Revoked, or invalidated by a selection/connection/device change.
    store.append(_receipt("org-1", 7, fingerprint=""))
    assert wgc._capture_consent_active("org-1", 7) is False


def test_consent_is_scoped_per_connection(store):
    store.append(_receipt("org-1", 7))
    assert wgc._capture_consent_active("org-1", 8) is False
    assert wgc._capture_consent_active("org-2", 7) is False


def test_revoke_endpoint_blanks_fingerprint_and_version(store, monkeypatch):
    store.append(_receipt("org-1", 7))
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
    # Audit record kept, fingerprint and version blanked, consent inactive.
    assert len(store) == 1
    assert store[0]["state_fingerprint"] == ""
    assert store[0]["capture_consent_version"] is None
    assert wgc._capture_consent_active("org-1", 7) is False

    # Re-confirming writes a fresh receipt (the RPC path); consent returns.
    store[0]["state_fingerprint"] = "def456"
    store[0]["capture_consent_version"] = wgc.CAPTURE_CONSENT_VERSION
    assert wgc._capture_consent_active("org-1", 7) is True


# --- select endpoint: old bundles cannot grant capture consent ---

def _select_endpoint_mocks(monkeypatch):
    rpc_calls = []

    class _RPCClient:
        def rpc(self, name, params):
            rpc_calls.append((name, params))
            return SimpleNamespace(data=None)

    async def _allow(*_args):
        return None

    monkeypatch.setattr(wgc, "_resolve_active_organization_id", lambda user, tenant: "org-1")
    monkeypatch.setattr(wgc, "_require_org_permission", _allow)
    monkeypatch.setattr(wgc, "_connection", lambda org, conn: {"id": conn, "broker_id": "broker-1"})
    monkeypatch.setattr(wgc, "_is_propai_connection", lambda conn: True)
    monkeypatch.setattr(wgc, "_is_primary_group_selection_connection", lambda org, conn: True)
    monkeypatch.setattr(wgc, "_organization_has_unlimited_group_access", lambda org: True)
    monkeypatch.setattr(wgc, "_group_selection_is_unlimited", lambda *a, **k: True)
    monkeypatch.setattr(wgc, "_group_directory", lambda *a, **k: [
        {"group_jid": "111@g.us", "selectable": True},
    ])

    def _rpc(name, params):
        rpc_calls.append((name, params))
        return {
            "complete": True,
            "selected_group_jids": params["p_groups"],
            "request_id": params["p_request"],
            "completed_at": "2026-11-26T12:00:00+00:00",
        }

    monkeypatch.setattr(wgc, "storage", SimpleNamespace(
        client=SimpleNamespace(rpc=_rpc),
        is_super_admin=lambda user_id: False,
    ))
    monkeypatch.setattr(wgc.asyncio, "to_thread", lambda fn, *a, **k: _async_wrap(fn, *a, **k))
    return rpc_calls


async def _async_wrap(fn, *args, **kwargs):
    return fn(*args, **kwargs)


def _run_select(monkeypatch, **body_overrides):
    rpc_calls = _select_endpoint_mocks(monkeypatch)
    body = wgc.GroupSelectionRequest(
        whatsapp_connection_id=7,
        group_jids=["111@g.us"],
        confirm=True,
        request_id="12345678-1234-1234-1234-123456789012",
        **body_overrides,
    )
    result = asyncio.run(wgc.select_groups(body, user={"id": "user-1"}, tenant_id="org-1"))
    return result, rpc_calls


def test_old_bundle_confirm_saves_selection_without_capture_consent(monkeypatch):
    # No capture_consent fields at all: selection still works, RPC records
    # no consent version, so the capture gate keeps this connection off.
    result, rpc_calls = _run_select(monkeypatch)
    assert result["ok"] is True
    assert rpc_calls[0][1]["p_capture_consent_version"] is None


def test_new_ui_confirm_binds_consent_version(monkeypatch):
    result, rpc_calls = _run_select(
        monkeypatch,
        capture_consent_version=wgc.CAPTURE_CONSENT_VERSION,
        capture_consent_confirmed=True,
    )
    assert result["ok"] is True
    assert rpc_calls[0][1]["p_capture_consent_version"] == wgc.CAPTURE_CONSENT_VERSION


def test_wrong_consent_version_rejected(monkeypatch):
    with pytest.raises(Exception) as excinfo:
        _run_select(
            monkeypatch,
            capture_consent_version="broker-group-capture-v0",
            capture_consent_confirmed=True,
        )
    assert getattr(excinfo.value, "status_code", None) == 400


def test_unconfirmed_consent_ack_rejected(monkeypatch):
    with pytest.raises(Exception) as excinfo:
        _run_select(
            monkeypatch,
            capture_consent_version=wgc.CAPTURE_CONSENT_VERSION,
            capture_consent_confirmed=False,
        )
    assert getattr(excinfo.value, "status_code", None) == 400
