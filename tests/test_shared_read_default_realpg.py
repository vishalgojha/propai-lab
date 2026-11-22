"""Shared-pool read default + group-review metadata, real disposable PostgreSQL.

Covers: new external keys mint with broker_market:read by default (existing
keys untouched), the key-facing shared-sources review endpoint returns the
reader tenant's OWN sharing metadata only (never content, never other
tenants, revoked rows vanish immediately), the endpoint refuses keys without
the market scope, and the MCP reader disable path persists an explicit
revoked row even when no grant row existed (default-on semantics).
"""
from pathlib import Path
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from tests.test_independent_raw_sharing import db, seeded, client, grant
from routers import broker_market as market
from broker_market_policy import CONSENT_VERSION

MIGRATION = 'supabase/migrations/20261121100000_shared_read_default_and_review.sql'


@pytest.fixture(scope='module', autouse=True)
def shared_read_migration(db):
    with db.cursor() as q:
        q.execute(Path('supabase/migrations/20261119100000_broker_market_mcp_reader_grants.sql').read_text())
        q.execute(Path(MIGRATION).read_text())
    return db


def test_new_keys_default_to_shared_pool_read():
    from routers.external_agent import _new_key_scopes
    assert 'broker_market:read' in _new_key_scopes(False)
    assert 'broker_market:read' in _new_key_scopes(True)


def test_shared_sources_endpoint_returns_own_metadata_only(client):
    c, seed = client
    db, a, b, u, v = seed
    grant(seed, tenant=b, connection=2)
    grant(seed)  # tenant a shares the same jid; must not leak into b's view
    r = c.get('/api/external/v1/market/shared-sources')
    assert r.status_code == 200, r.text
    body = r.json()
    assert body['consent_version'] == CONSENT_VERSION and body['forward_only'] is True
    sources = body['sources']
    assert len(sources) == 1
    s = sources[0]
    assert s['group_jid'] == '123@g.us' and s['group_name'] == 'Property Alpha'
    assert s['message_count'] == 7 and s['last_message_at'] is not None
    assert s['whatsapp_connection_id'] == 2 and s['confirmed_at']
    forbidden = {'message', 'body', 'sender_phone', 'sender_jid', 'raw_payload', 'text'}
    assert not forbidden & set(s), s
    # Owner uncheck removes the row from the review view immediately.
    grant(seed, tenant=b, connection=2, enabled=False)
    assert c.get('/api/external/v1/market/shared-sources').json()['sources'] == []


def test_shared_sources_require_market_scope(client):
    c, seed = client
    # Override the inner auth dependency so the REAL market_key gate (feature
    # flag + scope check + membership) runs against a scope-less credential.
    bad = FastAPI()
    bad.include_router(market.router)
    bad.dependency_overrides[market.external_auth] = lambda: {
        'id': 'plain-key', 'tenant_id': seed[2], 'scopes': ['inventory:read']}
    with TestClient(bad) as b2:
        assert b2.get('/api/external/v1/market/shared-sources').status_code == 403


def test_mcp_default_grant_only_when_no_recorded_choice(seeded):
    db, a, b, u, v = seeded
    with db.cursor() as q:
        # First authorization: the default grant is created.
        q.execute('select broker_market_default_mcp_reader_grant(%s,%s,%s)', (a, u, u))
        assert q.fetchone()[0] is True
        # A recorded enable is left untouched.
        q.execute('select broker_market_default_mcp_reader_grant(%s,%s,%s)', (a, u, u))
        assert q.fetchone()[0] is False
        # A recorded explicit disable is never resurrected by re-authorization.
        q.execute('select * from broker_market_set_mcp_reader_access(%s,%s,false,%s)', (a, u, u))
        q.execute('select broker_market_default_mcp_reader_grant(%s,%s,%s)', (a, u, u))
        assert q.fetchone()[0] is False
        q.execute('select revoked_at from broker_market_mcp_reader_grants where organization_id=%s and user_id=%s', (a, u))
        assert q.fetchone()[0] is not None


def test_mcp_disable_without_row_persists_revoked(seeded):
    db, a, b, u, v = seeded
    with db.cursor() as q:
        q.execute('select * from broker_market_set_mcp_reader_access(%s,%s,false,%s)', (a, u, u))
        q.execute('select revoked_at from broker_market_mcp_reader_grants where organization_id=%s and user_id=%s', (a, u))
        row = q.fetchone()
        assert row and row[0] is not None
        q.execute('select * from broker_market_set_mcp_reader_access(%s,%s,true,%s)', (a, u, u))
        q.execute('select revoked_at from broker_market_mcp_reader_grants where organization_id=%s and user_id=%s', (a, u))
        assert q.fetchone()[0] is None
        q.execute('select * from broker_market_set_mcp_reader_access(%s,%s,false,%s)', (a, u, u))
        q.execute('select revoked_at from broker_market_mcp_reader_grants where organization_id=%s and user_id=%s', (a, u))
        assert q.fetchone()[0] is not None
