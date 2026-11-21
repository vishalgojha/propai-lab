"""DM identifier masking, per-key DM grant and bound connection status.

Fake-adapter unit tests over the real route functions. No live service.
"""
import asyncio

import pytest
from fastapi import HTTPException

import routers.external_agent as external_agent
from routers.external_agent import (
    UNNAMED_DM_CONTACT,
    _mask_dm_response_row,
    _mask_phone_like_text,
    _saved_dm_contact_name,
)


class _Result:
    def __init__(self, data):
        self.data = data


class _FakeTable:
    def __init__(self, rows, filters=None, update_payload=None, cap=None, cols=None):
        self.rows = rows
        self._filters = filters or []
        self._update = update_payload
        self._cap = cap
        self._cols = cols

    def _clone(self, **kwargs):
        return _FakeTable(
            self.rows,
            filters=kwargs.get("filters", self._filters),
            update_payload=kwargs.get("update", self._update),
            cap=kwargs.get("cap", self._cap),
            cols=kwargs.get("cols", self._cols),
        )

    def select(self, columns="", *_args, **_kwargs):
        cols = None
        if isinstance(columns, str) and columns.strip() and columns.strip() != "*":
            cols = [col.strip() for col in columns.split(",") if col.strip()]
        return self._clone(cols=cols)

    def eq(self, column, value):
        return self._clone(filters=self._filters + [("eq", column, value)])

    def is_(self, column, value):
        return self._clone(filters=self._filters + [("is", column, value)])

    def in_(self, column, values):
        return self._clone(filters=self._filters + [("in", column, values)])

    def order(self, *_args, **kwargs):
        return self._clone()

    def like(self, column, pattern):
        needle = str(pattern).strip("%")
        return self._clone(filters=self._filters + [("like", column, needle)])

    def ilike(self, column, pattern):
        needle = str(pattern).strip("%")
        return self._clone(filters=self._filters + [("like", column, needle)])

    def limit(self, n, *_args):
        return self._clone(cap=n)

    def offset(self, *_args):
        return self._clone()

    def update(self, payload):
        return self._clone(update=payload)

    def insert(self, payload):
        self.rows.append(dict(payload))
        return self._clone()

    def or_(self, expression):
        _OR_LOG.append(expression)
        return self._clone()

    def gte(self, *_args):
        return self._clone()

    def lte(self, *_args):
        return self._clone()

    def execute(self):
        matched = list(self.rows)
        for kind, column, value in self._filters:
            if kind == "eq":
                matched = [row for row in matched if row.get(column) == value]
            elif kind == "is":
                matched = [row for row in matched if (row.get(column) is None) == (value == "null")]
            elif kind == "in":
                matched = [row for row in matched if row.get(column) in value]
            elif kind == "like":
                matched = [row for row in matched if value in str(row.get(column) or "")]
        if self._update is not None:
            for row in matched:
                row.update(self._update)
        if self._cap is not None:
            matched = matched[: self._cap]
        if self._cols is not None:
            matched = [{key: row.get(key) for key in self._cols} for row in matched]
        return _Result(matched)


_OR_LOG: list = []


class _FakeClient:
    def __init__(self, tables):
        self._tables = tables

    def table(self, name):
        return _FakeTable(self._tables.setdefault(name, []))


class _FakeStorage:
    def __init__(self, client):
        self.client = client


def _install(monkeypatch, tables):
    monkeypatch.setattr(external_agent, "storage", _FakeStorage(_FakeClient(tables)))
    monkeypatch.setattr(external_agent, "_record_assistant_trial_start", lambda *a, **k: None)
    return tables


# --- phone-like text masking -------------------------------------------------

@pytest.mark.parametrize("text,hidden", [
    ("Call 9820012345 today", "Call [number hidden] today"),
    ("Call +91 98200 12345 today", "Call [number hidden] today"),
    ("Call +919820012345 today", "Call [number hidden] today"),
    ("Call 98200-12345 today", "Call [number hidden] today"),
    ("Call (022) 48901234 today", "Call ([number hidden] today"),
])
def test_phone_like_runs_are_hidden(text, hidden):
    assert _mask_phone_like_text(text) == hidden


@pytest.mark.parametrize("text", [
    "2 BHK 1.25 cr budget",
    "85L asking, 60k rent",
    "2,50,00,000 final",
    "1200 sqft carpet",
    "visit on 2026-11-21",
    "met on 2026-11-21 14:30",
    "available 5-7 pm",
    "tower 4 flat 1203",
])
def test_property_quantities_prices_and_dates_survive(text):
    assert _mask_phone_like_text(text) == text


# --- saved contact name resolution -------------------------------------------

def test_saved_full_name_wins(monkeypatch):
    _install(monkeypatch, {"whatsmeow_contacts": [{"their_jid": "9198@s.whatsapp.net", "full_name": "Sheetal", "first_name": "", "business_name": ""}]})
    assert _saved_dm_contact_name("9198@s.whatsapp.net", "9198200", {}) == "Sheetal"


def test_pushname_is_never_used_as_saved_name(monkeypatch):
    _install(monkeypatch, {"whatsmeow_contacts": [{"their_jid": "9198@s.whatsapp.net", "push_name": "Sheetal"}]})
    assert _saved_dm_contact_name("9198@s.whatsapp.net", "", {}) == UNNAMED_DM_CONTACT


def test_saved_name_with_embedded_number_is_masked(monkeypatch):
    _install(monkeypatch, {"whatsmeow_contacts": [{"their_jid": "9198@s.whatsapp.net", "full_name": "Rahul 9820012345"}]})
    assert _saved_dm_contact_name("9198@s.whatsapp.net", "", {}) == "Rahul [number hidden]"


def test_number_only_saved_name_falls_back_to_unnamed(monkeypatch):
    _install(monkeypatch, {"whatsmeow_contacts": [{"their_jid": "9198@s.whatsapp.net", "full_name": "9820012345"}]})
    assert _saved_dm_contact_name("9198@s.whatsapp.net", "", {}) == UNNAMED_DM_CONTACT


def test_unknown_contact_never_falls_back_to_phone(monkeypatch):
    _install(monkeypatch, {"whatsmeow_contacts": []})
    name = _saved_dm_contact_name("919820056180@s.whatsapp.net", "919820056180", {})
    assert name == UNNAMED_DM_CONTACT
    assert "9820056180" not in name


# --- row masking --------------------------------------------------------------

def _dm_row():
    return {
        "id": 7, "tenant_id": "t1", "is_group": False, "sender": "publicPushname",
        "sender_jid": "919820012345@s.whatsapp.net", "sender_phone": "919820012345",
        "group_name": "919820012345@s.whatsapp.net",
        "message": "2 BHK 1.25 cr, call 9820012345", "timestamp": "2026-11-21T09:00:00+00:00",
    }


def test_dm_row_masked_with_saved_name(monkeypatch):
    _install(monkeypatch, {"whatsmeow_contacts": [{"their_jid": "919820012345@s.whatsapp.net", "full_name": "Atul Sondhi"}]})
    masked = _mask_dm_response_row(_dm_row(), {})
    assert masked["sender"] == "Atul Sondhi"
    assert masked["sender_jid"] is None
    assert masked["sender_phone"] is None
    assert masked["group_name"] is None
    assert masked["message"] == "2 BHK 1.25 cr, call [number hidden]"
    assert "9820012345" not in str(masked)


def test_group_row_untouched(monkeypatch):
    _install(monkeypatch, {})
    row = _dm_row()
    row.update({"is_group": True, "group_name": "Kandivali Brokers"})
    masked = _mask_dm_response_row(row, {})
    assert masked == row


# --- message search route -----------------------------------------------------

def _dm_key():
    return {"tenant_id": "t1", "scopes": ["raw_messages:read", "raw_messages:dms"], "external_agent_dms_enabled": True}


def test_search_masks_dm_rows_but_not_group_rows(monkeypatch):
    tables = _install(monkeypatch, {
        "raw_messages": [_dm_row(), {**_dm_row(), "id": 8, "is_group": True, "group_name": "Kandivali Brokers"}],
        "whatsmeow_contacts": [],
    })
    result = asyncio.run(external_agent.external_raw_message_search(q="", scope="dms", since="", until="", limit=25, offset=0, key=_dm_key()))
    for item in result["results"]:
        assert item["sender"] == UNNAMED_DM_CONTACT
        assert "9820012345" not in str(item)


def test_search_still_matches_phone_server_side(monkeypatch):
    _install(monkeypatch, {"raw_messages": [], "whatsmeow_contacts": []})
    del _OR_LOG[:]
    asyncio.run(external_agent.external_raw_message_search(q="9820012345", scope="dms", since="", until="", limit=25, offset=0, key=_dm_key()))
    assert any("sender_phone.ilike" in expression for expression in _OR_LOG)


def test_get_dm_message_masked(monkeypatch):
    _install(monkeypatch, {"raw_messages": [_dm_row()], "whatsmeow_contacts": []})
    result = asyncio.run(external_agent.external_raw_message_get(7, key=_dm_key()))
    assert result["message"]["sender"] == UNNAMED_DM_CONTACT
    assert result["message"]["sender_phone"] is None


def test_conversation_rows_masked(monkeypatch):
    anchor = dict(_dm_row())
    anchor.update({"message_uid": "b1:919820012345@s.whatsapp.net:1", "raw_payload": {"data": {"key": {"remoteJid": "919820012345@s.whatsapp.net"}}}})
    _install(monkeypatch, {"raw_messages": [anchor], "whatsmeow_contacts": []})
    result = asyncio.run(external_agent.external_raw_message_conversation(7, limit=40, key=_dm_key()))
    assert result["messages"]
    for row in result["messages"]:
        assert row["sender_phone"] is None
        assert "9820012345" not in str(row)


# --- per-key DM access grant ---------------------------------------------------

async def _noop_permission(*_args, **_kwargs):
    return None


def _grant_setup(monkeypatch):
    tables = _install(monkeypatch, {
        "organizations": [{"id": "t1", "external_agent_dms_enabled": True}],
        "external_agent_api_keys": [
            {"id": "k1", "tenant_id": "t1", "scopes": ["raw_messages:read"], "revoked_at": None},
            {"id": "k2", "tenant_id": "t1", "scopes": ["raw_messages:read"], "revoked_at": None},
        ],
    })
    monkeypatch.setattr(external_agent, "_require_org_permission", _noop_permission)
    monkeypatch.setattr(external_agent, "_write_audit_start", lambda *a, **k: "audit-1")
    monkeypatch.setattr(external_agent, "_write_audit_finish", lambda *a, **k: None)
    return tables


def test_dm_access_grant_adds_scope_to_one_key_only(monkeypatch):
    tables = _grant_setup(monkeypatch)
    result = asyncio.run(external_agent.update_external_key_dm_access(
        "k1", external_agent.ApiKeyDmAccessUpdate(enabled=True), user={"id": "u1"}, tenant_id="t1"))
    assert "raw_messages:dms" in result["scopes"]
    keys = {row["id"]: row for row in tables["external_agent_api_keys"]}
    assert "raw_messages:dms" in keys["k1"]["scopes"]
    assert "raw_messages:dms" not in keys["k2"]["scopes"]


def test_dm_access_grant_requires_workspace_consent(monkeypatch):
    tables = _grant_setup(monkeypatch)
    tables["organizations"][0]["external_agent_dms_enabled"] = False
    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(external_agent.update_external_key_dm_access(
            "k1", external_agent.ApiKeyDmAccessUpdate(enabled=True), user={"id": "u1"}, tenant_id="t1"))
    assert excinfo.value.status_code == 409
    assert "consent is off" in excinfo.value.detail


def test_dm_access_removal_is_per_key(monkeypatch):
    tables = _grant_setup(monkeypatch)
    tables["external_agent_api_keys"][0]["scopes"].append("raw_messages:dms")
    result = asyncio.run(external_agent.update_external_key_dm_access(
        "k1", external_agent.ApiKeyDmAccessUpdate(enabled=False), user={"id": "u1"}, tenant_id="t1"))
    assert "raw_messages:dms" not in result["scopes"]


def test_dm_access_grant_missing_key_404(monkeypatch):
    _grant_setup(monkeypatch)
    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(external_agent.update_external_key_dm_access(
            "k9", external_agent.ApiKeyDmAccessUpdate(enabled=True), user={"id": "u1"}, tenant_id="t1"))
    assert excinfo.value.status_code == 404


# --- bound connection status ---------------------------------------------------

def test_connection_status_binds_latest_decided_session(monkeypatch):
    tables = _install(monkeypatch, {
        "organizations": [{"id": "t1", "external_agent_dms_enabled": True, "external_agent_dms_consented_at": "2026-11-01T00:00:00+00:00"}],
        "external_agent_connect_sessions": [
            {"id": "s1", "tenant_id": "t1", "status": "consumed", "label": "Instinct", "api_key_id": "k1", "decided_at": "2026-11-20T00:00:00+00:00"},
        ],
        "external_agent_api_keys": [
            {"id": "k1", "tenant_id": "t1", "label": "Instinct", "key_prefix": "ppai_aaa", "scopes": ["raw_messages:read"], "revoked_at": None, "last_used_at": None},
            {"id": "k2", "tenant_id": "t1", "label": "Instinct", "key_prefix": "ppai_bbb", "scopes": ["raw_messages:read", "raw_messages:dms"], "revoked_at": None, "last_used_at": None},
        ],
    })
    result = asyncio.run(external_agent.external_connection_status(user={"id": "u1"}, tenant_id="t1"))
    assert result["dm_consent_enabled"] is True
    connection = result["connection"]
    assert connection["key_id"] == "k1"
    assert connection["can_read_groups"] is True
    # Consent is on but the bound key lacks the scope: the honest state is no DM read.
    assert connection["can_read_dms"] is False
    # The other key carrying the DM scope must not leak into an optimistic aggregate.
    assert result["unbound_active_keys"] == 1
    assert "ppai_bbb" not in str(connection)


def test_connection_status_without_session_is_unbound(monkeypatch):
    _install(monkeypatch, {
        "organizations": [{"id": "t1", "external_agent_dms_enabled": False}],
        "external_agent_connect_sessions": [],
        "external_agent_api_keys": [{"id": "k1", "tenant_id": "t1", "revoked_at": None}],
    })
    result = asyncio.run(external_agent.external_connection_status(user={"id": "u1"}, tenant_id="t1"))
    assert result["connection"] is None
    assert result["unbound_active_keys"] == 1
    assert result["dm_consent_enabled"] is False
