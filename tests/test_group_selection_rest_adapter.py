import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest

from storage.supabase import _RestClient
from routers import whatsapp_group_controls as controls


@pytest.fixture
def adapter():
    requests = []
    def handle(request):
        requests.append(request)
        return httpx.Response(200, json=[])
    client = _RestClient('https://fixture.invalid', 'fixture-only')
    client._http.close()
    client._http = httpx.Client(transport=httpx.MockTransport(handle))
    yield client, requests
    client.close()


@pytest.mark.parametrize('values', [[], ['123@g.us'], ['123@g.us', 'a,b', 'a"b', 'a\\b', 'a(b)', 'white space'], [f'{i}@g.us' for i in range(140)]])
def test_negated_list_serializes_with_real_http_adapter(adapter, values):
    client, requests = adapter
    client.table('organization_group_connections').update({'is_active': False}).eq('organization_id', 'own').eq('whatsapp_connection_id', 225).not_.in_('group_jid', values).execute()
    request, = requests
    assert request.method == 'PATCH'
    assert request.url.params['organization_id'] == 'eq.own'
    assert request.url.params['whatsapp_connection_id'] == 'eq.225'
    expression = request.url.params['group_jid']
    assert expression.startswith('not.in.(') and expression.endswith(')')
    # Parse the literal list to prove escaping preserves every supplied value.
    assert json.loads('[' + expression[len('not.in.('):-1] + ']') == values


def test_existing_not_is_unchanged(adapter):
    client, requests = adapter
    client.table('example').select('id').not_.is_('deleted_at', 'null').execute()
    assert requests[0].url.params['deleted_at'] == 'not.is.null'


@pytest.mark.parametrize('count', [0, 1, 140])
def test_actual_selection_route_retains_selected_groups_before_upsert(adapter, monkeypatch, count):
    client, requests = adapter
    selected = [f'{i}@g.us' for i in range(count)]
    directory = [{'group_jid': jid, 'group_name': jid, 'selectable': True} for jid in selected]
    async def allow(*args):
        pass
    monkeypatch.setattr(controls, '_resolve_active_organization_id', lambda *args: 'own')
    monkeypatch.setattr(controls, '_require_org_permission', allow)
    monkeypatch.setattr(controls, '_connection', lambda *args: {'id': 225, 'broker_id': 'own-phone'})
    monkeypatch.setattr(controls, '_is_propai_connection', lambda *args: False)
    monkeypatch.setattr(controls, '_is_primary_group_selection_connection', lambda *args: True)
    monkeypatch.setattr(controls, '_organization_has_unlimited_group_access', lambda *args: True)
    monkeypatch.setattr(controls, '_group_directory', lambda *args, **kwargs: directory)
    monkeypatch.setattr(controls, '_cap_state', lambda *args, **kwargs: {})
    metadata_updates = []
    monkeypatch.setattr(controls, 'storage', SimpleNamespace(client=client, is_super_admin=lambda *args: True, update_org_whatsapp_connection=lambda *args: metadata_updates.append(args)))
    body = controls.GroupSelectionRequest(whatsapp_connection_id=225, group_jids=selected, confirm=True)
    result = asyncio.run(controls.select_groups(body, {'id': 'user'}, 'own'))
    assert result['selected_group_jids'] == selected
    assert result['selected_count'] == count
    deselection = requests[0]
    assert deselection.method == 'PATCH'
    assert deselection.url.params['organization_id'] == 'eq.own'
    assert deselection.url.params['whatsapp_connection_id'] == 'eq.225'
    assert json.loads(deselection.content)['public_market_source'] is False
    if count:
        expression = deselection.url.params['group_jid']
        retained = json.loads('[' + expression[len('not.in.('):-1] + ']')
        assert retained == selected
        upsert = requests[1]
        assert upsert.method == 'POST'
        rows = json.loads(upsert.content)
        assert [row['group_jid'] for row in rows] == selected
        assert all(row['public_market_source'] and row['is_active'] and not row['opted_out'] for row in rows)
        assert len([r for r in requests if r.url.path.endswith('/rpc/sync_group_market_visibility')]) == count
    else:
        assert 'group_jid' not in deselection.url.params
        assert len(requests) == 1
    assert metadata_updates[0][1]['group_audit_required'] is False
    assert 'extraction_status' not in metadata_updates[0][1]
    assert not any('extraction/start' in str(r.url) or 'raw_messages' in str(r.url) for r in requests)
