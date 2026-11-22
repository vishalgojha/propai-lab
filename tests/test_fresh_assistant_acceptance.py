"""Fresh-assistant connection acceptance, local only.

Disposable PostgreSQL + the real FastAPI connect/approval/collection/check
routes from this candidate. Credentials are fixture values minted by the
server code against a throwaway database. No live service, no real secret.

Scope of proof: this suite proves the PropAI server protocol and the
reference adapter's behavior end to end (start, owner approval, one-time
collection, store round-trip through a deliberately ephemeral dummy store,
resume, revocation, decline, expiry, account-switch and workspace binding).
It does NOT prove a real assistant's durable secure storage. The supported
secure save/resume capability for this Instinct is grounded separately in
the live vault (a password-only login entry with sandbox access, shape
already in durable use for the existing PropAI key). No production mint,
tenant, deployment or vault change happens here.
"""
import hashlib
import logging
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

psycopg2 = pytest.importorskip("psycopg2", reason="acceptance tests need psycopg2 for disposable PostgreSQL")
from psycopg2 import sql  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import routers.external_agent as api  # noqa: E402
from assistant_connection_client import AssistantConnection, SetupError  # noqa: E402


class Query:
    """Minimal SQL adapter over disposable PostgreSQL for the router's
    storage.client.table(...) calls. Supports the chains these routes use:
    select/insert/update/delete with eq/is_null/lt filters and limit."""

    def __init__(self, conn, table):
        self.conn = conn
        self.table = table
        self.columns = "*"
        self.filters = []
        self.values = []
        self.mutation = None
        self.n = 100

    def select(self, columns="*"):
        self.columns = columns
        return self

    def insert(self, body):
        self.mutation = ("insert", body)
        return self

    def update(self, body):
        self.mutation = ("update", body)
        return self

    def delete(self):
        self.mutation = ("delete", None)
        return self

    def eq(self, key, val):
        self.filters.append(sql.SQL("{} = %s").format(sql.Identifier(key)))
        self.values.append(val)
        return self

    def is_(self, key, val):
        assert val == "null"
        self.filters.append(sql.SQL("{} IS NULL").format(sql.Identifier(key)))
        return self

    def lt(self, key, val):
        self.filters.append(sql.SQL("{} < %s").format(sql.Identifier(key)))
        self.values.append(val)
        return self

    def limit(self, n):
        self.n = n
        return self

    def execute(self):
        where = sql.SQL(" AND ").join(self.filters) if self.filters else sql.SQL("TRUE")
        kind = self.mutation[0] if self.mutation else "select"
        if kind == "insert":
            body = self.mutation[1]
            query = sql.SQL("INSERT INTO {} ({}) VALUES ({}) RETURNING *").format(
                sql.Identifier(self.table),
                sql.SQL(",").join(map(sql.Identifier, body)),
                sql.SQL(",").join(sql.Placeholder() * len(body)),
            )
            values = list(body.values())
        elif kind == "update":
            body = self.mutation[1]
            query = sql.SQL("UPDATE {} SET {} WHERE {} RETURNING *").format(
                sql.Identifier(self.table),
                sql.SQL(",").join(
                    sql.SQL("{}=%s").format(sql.Identifier(k)) if v is not None
                    else sql.SQL("{}=NULL").format(sql.Identifier(k))
                    for k, v in body.items()
                ),
                where,
            )
            values = [v for v in body.values() if v is not None] + self.values
        elif kind == "delete":
            query = sql.SQL("DELETE FROM {} WHERE {} RETURNING *").format(
                sql.Identifier(self.table), where)
            values = list(self.values)
        else:
            query = sql.SQL("SELECT {} FROM {} WHERE {} LIMIT %s").format(
                sql.SQL(",").join(map(sql.Identifier, self.columns.split(","))),
                sql.Identifier(self.table), where)
            values = [*self.values, self.n]
        with self.conn.cursor() as c:
            c.execute(query, values)
            names = [d.name for d in c.description]
            return SimpleNamespace(data=[dict(zip(names, row)) for row in c.fetchall()])


SCHEMA = """
CREATE TABLE organizations(id text PRIMARY KEY, external_agent_dms_enabled boolean,
    mcp_trial_started_at timestamptz, mcp_trial_ends_at timestamptz);
CREATE TABLE external_agent_api_keys(
    id text PRIMARY KEY DEFAULT 'k_' || substr(md5(random()::text), 1, 12),
    tenant_id text, created_by text, label text, key_prefix text,
    scopes text[], expires_at timestamptz, revoked_at timestamptz,
    key_hash text, last_used_at timestamptz, replaced_by text);
CREATE TABLE external_agent_connect_sessions(
    id text PRIMARY KEY DEFAULT 'cs_' || substr(md5(random()::text), 1, 12),
    device_code_hash text, user_code text, label text, write_access boolean,
    status text DEFAULT 'pending', token text, expires_at timestamptz,
    tenant_id text, approved_by text, api_key_id text, decided_at timestamptz);
CREATE TABLE raw_messages(id bigint, tenant_id text, is_group boolean, message text);
INSERT INTO organizations(id, external_agent_dms_enabled) VALUES ('t1', false), ('t2', false);
INSERT INTO raw_messages VALUES (1, 't1', true, 'owned group post'), (2, 't2', true, 'foreign group post');
"""


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("CONNECT_SESSION_SECRET", "acceptance-fixture-seal")
    try:
        admin = psycopg2.connect(host="/tmp", dbname="postgres", user="postgres", connect_timeout=3)
    except psycopg2.OperationalError:
        pytest.skip("disposable local PostgreSQL not available")
    admin.autocommit = True
    name = "accept_" + uuid.uuid4().hex[:10]
    with admin.cursor() as c:
        c.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    db = psycopg2.connect(host="/tmp", dbname=name, user="postgres")
    db.autocommit = True
    with db.cursor() as c:
        c.execute(SCHEMA)
    monkeypatch.setattr(api, "storage", SimpleNamespace(client=SimpleNamespace(table=lambda t: Query(db, t))))

    async def allow(*args):
        return None
    monkeypatch.setattr(api, "_require_org_permission", allow)

    app = FastAPI()
    app.include_router(api.router)
    app.dependency_overrides[api.require_user] = lambda: {"id": "owner-1"}
    app.dependency_overrides[api.require_tenant] = lambda: "t1"
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client, db
    db.close()
    with admin.cursor() as c:
        c.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))
    admin.close()


class EphemeralDummyStore:
    """In-memory fixture store. Proves adapter behavior only; NOT the real
    secure store. The real supported save/resume path is grounded separately
    (see module docstring)."""

    def __init__(self):
        self.values = {}

    def save(self, name, value):
        self.values[name] = value

    def retrieve(self, name):
        return self.values[name]


def make_transport(client):
    def transport(method, path, body, token):
        headers = {"X-API-Key": token} if token else {}
        response = client.request(method, "/api/external/v1" + path, json=body, headers=headers)
        try:
            return response.status_code, response.json()
        except Exception:
            return response.status_code, {}
    return transport


def approve(client, user_code, workspace_id="t1"):
    return client.post(
        f"/api/external/v1/connect/sessions/by-code/{user_code}/approve",
        json={"workspace_id": workspace_id})


def test_acceptance_full_roundtrip_and_resume(env, caplog):
    client, db = env
    transport = make_transport(client)
    store = EphemeralDummyStore()
    caplog.set_level(logging.DEBUG)

    # 1. Start: 201, safe approval destination, no credential material yet.
    adapter = AssistantConnection(transport, store)
    started = adapter.start()
    assert started["state"] == "awaiting_approval"
    assert started["approval_url"].startswith("https://app.propai.live/connect?code=")
    assert started["interval"] >= 5
    assert repr(adapter.pending) == "PendingConnection(<private>)"

    # 2. Poll before approval: pending, no token.
    code, body = transport("GET", "/connect/sessions/" + adapter.pending.device_code, None, None)
    assert code == 202 and body["status"] == "pending" and "token" not in body

    # 3. Owner preview: pending, read-only scope disclosure, workspace bound.
    preview = client.get(f"/api/external/v1/connect/sessions/by-code/{started['user_code']}")
    assert preview.status_code == 200
    pdata = preview.json()
    assert pdata["status"] == "pending" and pdata["workspace_id"] == "t1"
    assert pdata["write_access"] is False
    assert pdata["scopes"] and not any(s.endswith(":write") or s.startswith("write") for s in pdata["scopes"])

    # 4. Owner approves with matching workspace.
    assert approve(client, started["user_code"]).status_code == 200

    # 5. Collect exactly once, store round-trip, then scoped read check.
    device_code = adapter.pending.device_code
    with db.cursor() as c:
        c.execute("SELECT token FROM external_agent_connect_sessions")
        sealed_at_rest = c.fetchone()[0]
    result = adapter.collect_and_check()
    assert result["state"] == "read_verified" and result["workspace_id"] == "t1"
    assert result["groups_only"] and not result["pool_verified"] and not result["live_capture_verified"]
    saved = store.retrieve(adapter.store_name)
    assert saved.startswith("ppai_")
    # Token is sealed at rest: the database never held the plaintext.
    assert sealed_at_rest != saved and sealed_at_rest is not None

    # 6. One-use: a second poll never serves the token again and now says
    # so truthfully ("already collected", 410) instead of the misleading
    # "expired" wording the route previously used for the consumed state.
    code, body = transport("GET", "/connect/sessions/" + device_code, None, None)
    assert code == 410 and "token" not in body and "already collected" in body.get("detail", "")

    # 7. Resume with a fresh adapter process against the saved credential.
    resumed = AssistantConnection(transport, store)
    resumed.store_name = adapter.store_name
    again = resumed.check_saved()
    assert again["state"] == "read_verified" and again["workspace_id"] == "t1"

    # 8. The connection check never started the trial clock.
    with db.cursor() as c:
        c.execute("SELECT mcp_trial_started_at, mcp_trial_ends_at FROM organizations WHERE id='t1'")
        assert c.fetchone() == (None, None)

    # 9. No secret leakage: the plaintext token appears in exactly one
    # response (the single collection) and never in logs.
    assert saved not in caplog.text
    assert saved not in preview.text


def test_acceptance_one_use_collection_enforced(env):
    client, db = env
    adapter = AssistantConnection(make_transport(client), EphemeralDummyStore())
    started = adapter.start()
    approve(client, started["user_code"])
    device_code = adapter.pending.device_code
    adapter.collect_and_check()
    code, body = make_transport(client)("GET", "/connect/sessions/" + device_code, None, None)
    assert code == 410 and "token" not in body and "already collected" in body.get("detail", "")
    with db.cursor() as c:
        c.execute("SELECT status, token FROM external_agent_connect_sessions")
        status, token = c.fetchone()
    assert status == "consumed" and token is None


def test_acceptance_decline_mints_nothing(env):
    client, db = env
    adapter = AssistantConnection(make_transport(client), EphemeralDummyStore())
    started = adapter.start()
    assert client.post(f"/api/external/v1/connect/sessions/by-code/{started['user_code']}/deny").status_code == 200
    with pytest.raises(SetupError):
        adapter.collect_and_check()
    with db.cursor() as c:
        c.execute("SELECT count(*) FROM external_agent_api_keys")
        assert c.fetchone()[0] == 0


def test_acceptance_expired_pending_session_fails_closed(env):
    client, db = env
    adapter = AssistantConnection(make_transport(client), EphemeralDummyStore())
    started = adapter.start()
    with db.cursor() as c:
        c.execute("UPDATE external_agent_connect_sessions SET expires_at = %s",
                  ((datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(),))
    with pytest.raises(SetupError):
        adapter.collect_and_check()
    with db.cursor() as c:
        c.execute("SELECT count(*) FROM external_agent_api_keys")
        assert c.fetchone()[0] == 0


def test_acceptance_approved_but_uncollected_expiry_destroys_token(env):
    client, db = env
    adapter = AssistantConnection(make_transport(client), EphemeralDummyStore())
    started = adapter.start()
    approve(client, started["user_code"])
    with db.cursor() as c:
        c.execute("UPDATE external_agent_connect_sessions SET expires_at = %s",
                  ((datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(),))
    with pytest.raises(SetupError):
        adapter.collect_and_check()
    with db.cursor() as c:
        c.execute("SELECT token, status FROM external_agent_connect_sessions")
        token, status = c.fetchone()
    assert token is None and status == "expired"


def test_acceptance_workspace_mismatch_rejected_and_stays_pending(env):
    client, db = env
    adapter = AssistantConnection(make_transport(client), EphemeralDummyStore())
    started = adapter.start()
    result = approve(client, started["user_code"], workspace_id="t2")
    assert result.status_code == 409
    with db.cursor() as c:
        c.execute("SELECT status FROM external_agent_connect_sessions")
        assert c.fetchone()[0] == "pending"
        c.execute("SELECT count(*) FROM external_agent_api_keys")
        assert c.fetchone()[0] == 0


@pytest.mark.parametrize("payload", [None, {}, {"workspace_id": ""}])
def test_acceptance_legacy_or_empty_approval_fails_closed(env, payload):
    client, db = env
    adapter = AssistantConnection(make_transport(client), EphemeralDummyStore())
    started = adapter.start()
    result = client.post(
        f"/api/external/v1/connect/sessions/by-code/{started['user_code']}/approve", json=payload)
    assert result.status_code == 422
    with db.cursor() as c:
        c.execute("SELECT status FROM external_agent_connect_sessions")
        assert c.fetchone()[0] == "pending"
        c.execute("SELECT count(*) FROM external_agent_api_keys")
        assert c.fetchone()[0] == 0


def test_acceptance_approval_requires_owner_auth(env):
    client, db = env
    client.app.dependency_overrides.clear()
    adapter = AssistantConnection(make_transport(client), EphemeralDummyStore())
    started = adapter.start()
    result = approve(client, started["user_code"])
    assert result.status_code in (401, 403)
    with db.cursor() as c:
        c.execute("SELECT count(*) FROM external_agent_api_keys")
        assert c.fetchone()[0] == 0


def test_acceptance_terminal_state_hidden_from_other_workspaces(env):
    client, db = env
    adapter = AssistantConnection(make_transport(client), EphemeralDummyStore())
    started = adapter.start()
    approve(client, started["user_code"])
    client.app.dependency_overrides[api.require_user] = lambda: {"id": "intruder"}
    client.app.dependency_overrides[api.require_tenant] = lambda: "t2"
    assert client.get(f"/api/external/v1/connect/sessions/by-code/{started['user_code']}").status_code == 404


def test_acceptance_revoked_key_fails_resume(env):
    client, db = env
    adapter = AssistantConnection(make_transport(client), EphemeralDummyStore())
    started = adapter.start()
    approve(client, started["user_code"])
    adapter.collect_and_check()
    with db.cursor() as c:
        c.execute("UPDATE external_agent_api_keys SET revoked_at = now()")
    with pytest.raises(SetupError):
        adapter.check_saved()


def test_acceptance_expired_key_fails_resume(env):
    client, db = env
    adapter = AssistantConnection(make_transport(client), EphemeralDummyStore())
    started = adapter.start()
    approve(client, started["user_code"])
    adapter.collect_and_check()
    with db.cursor() as c:
        c.execute("UPDATE external_agent_api_keys SET expires_at = now() - interval '1 day'")
    with pytest.raises(SetupError):
        adapter.check_saved()


def test_acceptance_account_switch_detected(env):
    client, db = env
    adapter = AssistantConnection(make_transport(client), EphemeralDummyStore())
    started = adapter.start()
    approve(client, started["user_code"])
    adapter.collect_and_check()
    with db.cursor() as c:
        c.execute("UPDATE external_agent_api_keys SET tenant_id = 't2'")
    with pytest.raises(SetupError, match="Account changed"):
        adapter.check_saved()


def test_acceptance_default_grant_is_read_only_and_dm_closed(env):
    client, db = env
    adapter = AssistantConnection(make_transport(client), EphemeralDummyStore())
    started = adapter.start()
    approve(client, started["user_code"])
    adapter.collect_and_check()
    saved = store_token = store = None
    saved = adapter.store.retrieve(adapter.store_name)
    headers = {"X-API-Key": saved}
    with db.cursor() as c:
        c.execute("SELECT scopes FROM external_agent_api_keys")
        scopes = c.fetchone()[0]
    assert not any(s.endswith(":write") or s.startswith("write") for s in scopes)
    assert "raw_messages:read" in scopes
    # No DM scope on the key and no workspace DM consent: DM search stays shut.
    dm = client.get("/api/external/v1/messages/search?scope=dms", headers=headers)
    assert dm.status_code == 403


def test_acceptance_device_code_stored_hashed_only(env):
    client, db = env
    adapter = AssistantConnection(make_transport(client), EphemeralDummyStore())
    adapter.start()
    device_code = adapter.pending.device_code
    with db.cursor() as c:
        c.execute("SELECT device_code_hash FROM external_agent_connect_sessions")
        stored = c.fetchone()[0]
    assert stored == hashlib.sha256(device_code.encode()).hexdigest()
    assert stored != device_code
