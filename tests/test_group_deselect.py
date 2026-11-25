import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException

from storage.supabase import _RestClient
from routers import whatsapp_group_controls as controls


@pytest.fixture
def adapter():
    requests = []

    def handle(request):
        requests.append(request)
        if request.url.path.endswith('/rpc/sync_group_market_visibility'):
            return httpx.Response(200, json=None)
        if request.method == 'PATCH':
            # First PATCH matches one row; the idempotency test swaps this.
            return httpx.Response(200, json=[{'group_jid': 'stale@g.us'}])
        return httpx.Response(200, json=[{'group_name': 'Stale Group'}])

    client = _RestClient('https://fixture.invalid', 'fixture-only')
    client._http.close()
    client._http = httpx.Client(transport=httpx.MockTransport(handle))
    yield client, requests
    client.close()


def _patch_common(monkeypatch, client):
    async def allow(*args):
        pass
    monkeypatch.setattr(controls, '_resolve_active_organization_id', lambda *args: 'own')
    monkeypatch.setattr(controls, '_require_org_permission', allow)
    monkeypatch.setattr(controls, '_connection', lambda *args: {'id': 225, 'broker_id': 'own-phone'})
    monkeypatch.setattr(controls, '_organization_has_unlimited_group_access', lambda *args: True)
    monkeypatch.setattr(controls, '_cap_state', lambda *args, **kwargs: {'cap': None, 'remaining': None, 'unlimited': True})
    monkeypatch.setattr(controls, 'storage', SimpleNamespace(client=client))


def test_deselect_clears_only_that_groups_selection(adapter, monkeypatch):
    client, requests = adapter
    _patch_common(monkeypatch, client)
    body = controls.GroupRequest(whatsapp_connection_id=225, group_jid='stale@g.us')
    result = asyncio.run(controls.deselect_group(body, {'id': 'user'}, 'own'))
    assert result['ok'] and result['deselected'] is True
    assert result['group_jid'] == 'stale@g.us'

    patches = [r for r in requests if r.method == 'PATCH']
    assert len(patches) == 1
    patch = patches[0]
    assert 'organization_group_connections' in patch.url.path
    assert patch.url.params['organization_id'] == 'eq.own'
    assert patch.url.params['whatsapp_connection_id'] == 'eq.225'
    assert patch.url.params['group_jid'] == 'eq.stale@g.us'
    payload = json.loads(patch.content)
    # Only the selection flag (and its timestamp) may change: no opt-out, no
    # is_active flip, nothing that touches other groups or sharing state.
    assert payload['public_market_source'] is False
    assert set(payload) <= {'public_market_source', 'updated_at'}

    rpcs = [r for r in requests if r.url.path.endswith('/rpc/sync_group_market_visibility')]
    assert len(rpcs) == 1
    rpc_body = json.loads(rpcs[0].content)
    # Un-publish only: a deselect must never publish.
    assert rpc_body['p_public_market_source'] is False
    assert rpc_body['p_group_jid'] == 'stale@g.us'


def test_deselect_is_idempotent(adapter, monkeypatch):
    client, requests = adapter
    _patch_common(monkeypatch, client)
    # Second removal finds no selected row; it must still succeed quietly.
    client._http.close()
    def handle_empty(request):
        requests.append(request)
        if request.method == 'PATCH':
            return httpx.Response(200, json=[])
        if request.url.path.endswith('/rpc/sync_group_market_visibility'):
            return httpx.Response(200, json=None)
        return httpx.Response(200, json=[{'group_name': 'Stale Group'}])
    client._http = httpx.Client(transport=httpx.MockTransport(handle_empty))
    body = controls.GroupRequest(whatsapp_connection_id=225, group_jid='stale@g.us')
    result = asyncio.run(controls.deselect_group(body, {'id': 'user'}, 'own'))
    assert result['ok'] and result['deselected'] is False


def test_deselect_rejects_without_org_permission(adapter, monkeypatch):
    client, requests = adapter
    async def deny(*args):
        raise HTTPException(status_code=403, detail='no')
    monkeypatch.setattr(controls, '_resolve_active_organization_id', lambda *args: 'other-org')
    monkeypatch.setattr(controls, '_require_org_permission', deny)
    monkeypatch.setattr(controls, 'storage', SimpleNamespace(client=client))
    body = controls.GroupRequest(whatsapp_connection_id=225, group_jid='stale@g.us')
    with pytest.raises(HTTPException):
        asyncio.run(controls.deselect_group(body, {'id': 'user'}, 'other-org'))
    # No write may leave the route when permission fails.
    assert not [r for r in requests if r.method == 'PATCH']
    assert not [r for r in requests if r.url.path.endswith('/rpc/sync_group_market_visibility')]
