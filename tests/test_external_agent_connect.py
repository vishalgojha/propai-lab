import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

import routers.external_agent as external_agent


class _Result:
    def __init__(self, data):
        self.data = data


class _FakeTable:
    """Minimal immutable-chain stand-in for the Supabase adapter used by the router."""

    def __init__(self, rows, filters=None, update=None, insert=None):
        self.rows = rows
        self._filters = filters or []
        self._update = update
        self._insert = insert

    def _clone(self, **kwargs):
        return _FakeTable(
            self.rows,
            filters=kwargs.get("filters", self._filters),
            update=kwargs.get("update", self._update),
            insert=kwargs.get("insert", self._insert),
        )

    def select(self, *_args, **_kwargs):
        return self._clone()

    def eq(self, column, value):
        return self._clone(filters=self._filters + [(column, value)])

    def limit(self, *_args, **_kwargs):
        return self._clone()

    def insert(self, payload):
        return self._clone(insert=payload)

    def update(self, payload):
        return self._clone(update=payload)

    def execute(self):
        if self._insert is not None:
            self.rows.append(dict(self._insert))
            return _Result([dict(self._insert)])
        matched = [row for row in self.rows if all(row.get(col) == val for col, val in self._filters)]
        if self._update is not None:
            for row in matched:
                row.update(self._update)
        return _Result(matched)


class _FakeClient:
    def __init__(self, rows):
        self._rows = rows

    def table(self, _name):
        return _FakeTable(self._rows)


def _future():
    return (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()


def _sealed(value):
    import os
    os.environ.setdefault("CONNECT_SESSION_SECRET", "test-seal-key")
    return external_agent._seal_token(value)


def _past():
    return (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()


class _FakeStorage:
    def __init__(self, client):
        self.client = client


def _install_fake_client(monkeypatch, rows):
    client = _FakeClient(rows)
    monkeypatch.setattr(external_agent, "storage", _FakeStorage(client))
    return client


def test_create_connect_session_returns_codes_and_url(monkeypatch):
    rows = []
    _install_fake_client(monkeypatch, rows)
    result = asyncio.run(external_agent.create_connect_session(external_agent.ConnectSessionCreate(label="Instinct")))
    assert result["device_code"]
    assert result["user_code"] in result["connect_url"]
    assert result["connect_url"].startswith(external_agent.FRONTEND_APP_URL)
    assert result["expires_in"] == external_agent.CONNECT_SESSION_TTL_SECONDS
    assert rows and rows[0]["user_code"] == result["user_code"]


def test_poll_pending_session_returns_202(monkeypatch):
    rows = [{"device_code_hash": external_agent._digest("dc"), "status": "pending", "token": None, "expires_at": _future()}]
    _install_fake_client(monkeypatch, rows)
    response = asyncio.run(external_agent.poll_connect_session("dc"))
    assert response.status_code == 202


def test_poll_approved_session_returns_token_exactly_once(monkeypatch):
    rows = [{"id": "s1", "device_code_hash": external_agent._digest("dc"), "status": "approved", "token": _sealed("ppai_secret"), "expires_at": _future()}]
    _install_fake_client(monkeypatch, rows)
    first = asyncio.run(external_agent.poll_connect_session("dc"))
    assert first["token"] == "ppai_secret"
    assert rows[0]["status"] == "consumed"
    assert rows[0]["token"] is None
    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(external_agent.poll_connect_session("dc"))
    assert excinfo.value.status_code == 410


def test_expired_approved_session_destroys_uncollected_token(monkeypatch):
    rows = [{"id": "s1", "device_code_hash": external_agent._digest("dc"), "status": "approved", "token": _sealed("ppai_secret"), "expires_at": _past()}]
    _install_fake_client(monkeypatch, rows)
    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(external_agent.poll_connect_session("dc"))
    assert excinfo.value.status_code == 410
    assert rows[0]["status"] == "expired"
    assert rows[0]["token"] is None


def test_poll_expired_pending_session_returns_410(monkeypatch):
    rows = [{"device_code_hash": external_agent._digest("dc"), "status": "pending", "token": None, "expires_at": _past()}]
    _install_fake_client(monkeypatch, rows)
    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(external_agent.poll_connect_session("dc"))
    assert excinfo.value.status_code == 410


def test_approve_mints_key_and_completes_session(monkeypatch):
    rows = [{"id": "s1", "user_code": "ABCD-2345", "status": "pending", "label": "Instinct", "write_access": False, "expires_at": _future()}]
    _install_fake_client(monkeypatch, rows)

    async def _allow(_user, _tenant, _permission):
        return None

    monkeypatch.setattr(external_agent, "_require_org_permission", _allow)
    monkeypatch.setattr(external_agent, "_create_external_key", lambda tenant, user, label, write: ({"id": "k1"}, "ppai_new"))

    result = asyncio.run(external_agent.approve_connect_session("abcd-2345", user={"id": "u1"}, tenant_id="t1"))
    assert result["ok"] is True
    assert rows[0]["status"] == "approved"
    # The token is sealed at rest, never stored in plaintext.
    assert rows[0]["token"] != "ppai_new"
    assert external_agent._unseal_token(rows[0]["token"]) == "ppai_new"
    assert rows[0]["tenant_id"] == "t1"

    # A second approval is refused.
    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(external_agent.approve_connect_session("abcd-2345", user={"id": "u1"}, tenant_id="t1"))
    assert excinfo.value.status_code == 409


def test_deny_marks_session(monkeypatch):
    rows = [{"id": "s1", "user_code": "ABCD-2345", "status": "pending", "label": "Instinct", "write_access": False, "expires_at": _future()}]
    _install_fake_client(monkeypatch, rows)
    result = asyncio.run(external_agent.deny_connect_session("ABCD-2345", user={"id": "u1"}, tenant_id="t1"))
    assert result["approved"] is False
    assert rows[0]["status"] == "denied"
    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(external_agent.poll_connect_session("dc-unknown"))
    assert excinfo.value.status_code == 404
