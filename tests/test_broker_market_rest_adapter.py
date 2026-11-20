"""Production _RestClient over mock HTTP, no SDK-shaped RPC fixture.

A transport models the server commit before its scalar response. The old router
executes the write, then fails on int.execute(), leaving the committed grant.
"""
import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from storage.supabase import _RestClient
from routers import broker_market as market
from broker_market_policy import CONSENT_VERSION


@pytest.fixture
def rig(monkeypatch):
    state = {'active': [], 'writes': 0, 'reply': 1, 'timeout': False, 'status': 200, 'calls': [], 'by_name': {}}
    def handle(req):
        path = req.url.path
        state['calls'].append(path)
        if '/rpc/' in path:
            if path.endswith('/broker_market_set_raw_sources'):
                body = json.loads(req.content)
                state['writes'] += 1
                state['active'] = [{'group_jid': j, 'group_name': 'Property', 'confirmed_at': '2026-11-20T10:00:00Z'} for j in body['p_groups']]
                if state['timeout']:
                    raise httpx.ReadTimeout('response lost after commit', request=req)
            if state['status'] != 200:
                return httpx.Response(state['status'], json={'message': 'database unavailable'})
            if state['reply'] == 'EMPTY_BODY':
                return httpx.Response(204)
            reply = state['by_name'].get(path.rsplit('/', 1)[1], state['reply'])
            return httpx.Response(200, content=json.dumps(reply), headers={'Content-Type': 'application/json'})
        if path.endswith('/org_whatsapp_connections'):
            return httpx.Response(200, json=[{'id': 225, 'broker_id': 'phone-owner'}])
        if path.endswith('/whatsapp_conversations'):
            return httpx.Response(200, json=[{'conversation_jid': '123@g.us', 'display_name': 'Property'}])
        if path.endswith('/broker_market_raw_source_consents'):
            return httpx.Response(200, json=state['active'])
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
    app.dependency_overrides[market.market_key] = lambda: {'id': 'reader-key', 'tenant_id': 'reader'}
    monkeypatch.setattr(market, '_record_assistant_trial_start', lambda _: None)
    monkeypatch.setenv('BROKER_MARKET_SIGNING_SECRET', 'local-test-only')
    with TestClient(app) as c:
        yield c, state
    adapter.close()


def grant(c):
    return c.put('/api/external/v1/market/raw-sources', json={
        'whatsapp_connection_id': 225, 'group_jids': ['123@g.us'],
        'consent_version': CONSENT_VERSION, 'confirmed': True, 'enabled': True})


@pytest.mark.parametrize('value', [True, False, 0, 134, [], [{'raw_id': 1}], None, 'EMPTY_BODY'])
def test_actual_adapter_json_shapes(rig, value):
    _, state = rig; state['reply'] = value
    result = asyncio.run(market.rpc('read_only_test', {}))
    assert result == ([] if value == 'EMPTY_BODY' else value)
    if value not in ('EMPTY_BODY', None): assert type(result) is type(value)


def test_committed_scalar_grant_is_success_and_reload_is_truth(rig):
    c, state = rig
    response = grant(c)
    assert response.status_code == 200, response.text
    assert response.json()['changed'] == 1 and state['writes'] == 1
    reload = c.get('/api/external/v1/market/raw-sources?whatsapp_connection_id=225')
    assert reload.status_code == 200
    assert reload.json()['active_sources'] == state['active']
    assert state['writes'] == 1


@pytest.mark.parametrize('value', [True, False, '1', [1], {'changed': 1}, 0, 2])
def test_source_count_remains_strict_integer_and_exact(rig, value):
    c, state = rig; state['reply'] = value
    assert grant(c).status_code == 503
    assert state['writes'] == 1
    assert c.get('/api/external/v1/market/raw-sources?whatsapp_connection_id=225').json()['active_sources']
    assert state['writes'] == 1  # Never retry an ambiguous committed request.


@pytest.mark.parametrize('value,allowed', [(True, True), (False, False), (1, False), ([], False), ('true', False)])
def test_rate_requires_json_true_not_truthy(rig, value, allowed):
    _, state = rig; state['reply'] = value
    if allowed:
        asyncio.run(market.rate({'tenant_id': 'reader'}, 'search'))
    else:
        with pytest.raises(market.HTTPException) as e:
            asyncio.run(market.rate({'tenant_id': 'reader'}, 'search'))
        assert e.value.status_code == 429


def test_timeout_after_commit_is_ambiguous_no_automatic_retry(rig):
    c, state = rig; state['timeout'] = True
    assert grant(c).status_code == 503
    assert state['writes'] == 1
    assert c.get('/api/external/v1/market/raw-sources?whatsapp_connection_id=225').json()['active_sources']
    assert state['writes'] == 1


def test_http_error_is_fail_closed(rig):
    _, state = rig; state['status'] = 503
    with pytest.raises(market.HTTPException) as e:
        asyncio.run(market.rpc('read_only_test', {}))
    assert e.value.status_code == 503


def test_actual_adapter_search_and_option_rows_masked_then_revoked(rig):
    c, state = rig
    row = {'raw_id': 42, 'body': 'Juhu 3 bhk for rent call 9820056180',
           'posted_at': '2026-11-20T10:00:00Z', 'sender_phone': '9820056180', 'sender_jid': ''}
    state['by_name'] = {'broker_market_take_rate': True,
                        'broker_market_search': [row], 'broker_market_get': [row]}
    found = c.post('/api/external/v1/market/search', json={'locality': 'Juhu'})
    assert found.status_code == 200, found.text
    assert '9820056180' not in found.text
    option = found.json()['results'][0]['option']
    reread = c.post('/api/external/v1/market/option', json={'option': option})
    assert reread.status_code == 200 and '9820056180' not in reread.text
    state['by_name']['broker_market_get'] = []
    assert c.post('/api/external/v1/market/option', json={'option': option}).status_code == 404
    state['by_name']['broker_market_search'] = []
    empty = c.post('/api/external/v1/market/search', json={'locality': 'Juhu'})
    assert empty.status_code == 200 and empty.json()['results'] == []
    assert state['writes'] == 0
