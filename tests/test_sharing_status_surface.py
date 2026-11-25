"""Truthful sharing status surface: revoked consent metadata for the owner UI
and connection-health signals for the owner's assistant.

Covers the paused-vs-never-shared distinction: selected groups whose consent
was revoked by a device change or deselect must surface as paused, never as
silently not-shared, and never as shared.
"""
import asyncio
import json
from types import SimpleNamespace

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from storage.supabase import _RestClient
from routers import broker_market as market
from routers import external_agent


ACTIVE = [{'group_jid': '123@g.us', 'group_name': 'Property', 'confirmed_at': '2026-11-20T10:00:00Z'}]
REVOKED = [{'group_jid': '456@g.us', 'group_name': 'Old', 'revoked_at': '2026-11-25T13:13:00Z'}]


def _consent_handler(req, state):
    params = dict(req.url.params)
    marker = params.get('revoked_at', '')
    if marker == 'is.null':
        return httpx.Response(200, json=state['active'])
    if marker.startswith('not.is.'):
        return httpx.Response(200, json=state['revoked'])
    raise AssertionError(f'unexpected revoked_at filter: {marker!r}')


def _rig(monkeypatch):
    state = {'active': list(ACTIVE), 'revoked': list(REVOKED)}
    def handle(req):
        path = req.url.path
        if path.endswith('/org_whatsapp_connections'):
            return httpx.Response(200, json=[{'id': 225, 'broker_id': 'phone-owner'}])
        if path.endswith('/whatsapp_conversations'):
            return httpx.Response(200, json=[
                {'conversation_jid': '123@g.us', 'display_name': 'Property', 'message_count': 5, 'last_message_at': '2026-11-20T12:00:00Z'},
                {'conversation_jid': '456@g.us', 'display_name': 'Old', 'message_count': 2, 'last_message_at': '2026-11-20T11:00:00Z'}])
        if path.endswith('/broker_market_raw_source_consents'):
            return _consent_handler(req, state)
        raise AssertionError(path)
    adapter = _RestClient('https://test.invalid', 'local-test-only')
    adapter._http.close()
    adapter._http = httpx.Client(transport=httpx.MockTransport(handle), headers=adapter._headers)
    monkeypatch.setattr(market, 'storage', SimpleNamespace(client=adapter))
    monkeypatch.setenv('BROKER_PROPERTY_CROSS_SEARCH_ENABLED', 'true')
    async def allow(*args): pass
    monkeypatch.setattr(market, '_require_org_permission', allow)
    app = FastAPI(); app.include_router(market.router)
    app.dependency_overrides[market.require_user] = lambda: {'id': 'owner'}
    app.dependency_overrides[market.require_tenant] = lambda: 'tenant'
    client = TestClient(app)
    return client, state, adapter


def test_raw_sources_returns_revoked_metadata_only(monkeypatch):
    c, state, adapter = _rig(monkeypatch)
    try:
        response = c.get('/api/external/v1/market/raw-sources?whatsapp_connection_id=225')
        assert response.status_code == 200, response.text
        body = response.json()
        assert [s['group_jid'] for s in body['active_sources']] == ['123@g.us']
        revoked = body['revoked_sources']
        assert [s['group_jid'] for s in revoked] == ['456@g.us']
        # Metadata only: no message content, no senders, no other tenants.
        assert set(revoked[0].keys()) == {'group_jid', 'group_name', 'revoked_at', 'share_class', 'share_class_topic'}
    finally:
        adapter.close()


class _FakeQuery:
    def __init__(self, rows):
        self._rows = rows
    def select(self, *args, **kwargs): return self
    def eq(self, *args, **kwargs): return self
    def in_(self, *args, **kwargs): return self
    def order(self, *args, **kwargs): return self
    def limit(self, *args, **kwargs): return self
    def execute(self): return SimpleNamespace(data=self._rows)


def _health_storage(tables):
    return SimpleNamespace(
        client=SimpleNamespace(table=lambda name: _FakeQuery(tables.get(name, []))),
    )


def test_connection_health_distinguishes_paused_from_never_shared(monkeypatch):
    tables = {
        'org_whatsapp_connections': [{'id': 225, 'broker_id': 'phone-owner', 'phone_number': '9199',
                                      'instance_name': 'Main', 'is_active': True, 'extraction_status': 'running'}],
        # A and B selected; C consented earlier but no longer selected.
        'organization_group_connections': [{'group_jid': 'A@g.us'}, {'group_jid': 'B@g.us'}],
        'broker_market_raw_source_consents': [
            {'group_jid': 'A@g.us', 'revoked_at': None},
            {'group_jid': 'B@g.us', 'revoked_at': '2026-11-25T13:13:00Z'},
            {'group_jid': 'C@g.us', 'revoked_at': '2026-11-24T09:00:00Z'},
        ],
        'broker_whatsapp_devices': [{'created_at': '2026-11-25T13:18:08Z', 'updated_at': '2026-11-25T13:18:08Z'}],
    }
    monkeypatch.setattr(external_agent, 'storage', _health_storage(tables))
    health = external_agent._connection_health('tenant')
    assert len(health) == 1
    row = health[0]
    assert row['selected_groups'] == 2
    assert row['shared_groups'] == 1  # only A has an unrevoked consent
    assert row['paused_groups'] == 1  # B revoked but still selected: paused, not "not shared"
    assert row['last_device_change_at'] == '2026-11-25T13:18:08Z'
    assert row['is_active'] is True


def test_attention_response_carries_connection_health_and_no_restore_note(monkeypatch):
    monkeypatch.setattr(external_agent, '_connection_health', lambda tenant: [{'connection_id': 225, 'paused_groups': 2}])
    tables = {'follow_ups': []}
    monkeypatch.setattr(external_agent, 'storage', SimpleNamespace(
        client=SimpleNamespace(table=lambda name: _FakeQuery(tables.get(name, []))),
        list_saved_market_searches=lambda tenant: [],
    ))
    key = {'tenant_id': 'tenant', 'scopes': ['workspace:attention']}
    result = asyncio.run(external_agent.external_workspace_attention(key))
    assert result['attention']['connection_health'] == [{'connection_id': 225, 'paused_groups': 2}]
    assert 'never restore' in result['sharing_note']
    assert result['outbound_actions'] == 'not performed'
