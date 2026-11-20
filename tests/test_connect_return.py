"""Regressions for terminal connect status and fixed Instinct chat return."""
import asyncio
from datetime import datetime, timedelta, timezone
import pytest
from fastapi import HTTPException
import routers.external_agent as api
from test_external_agent_connect import _FakeTable, _FakeStorage, _future, _past


class Client:
    def __init__(self, session, key):
        self.tables = {'external_agent_connect_sessions': [session], 'external_agent_api_keys': [key] if key else []}
    def table(self, name):
        return _FakeTable(self.tables[name])


def setup(monkeypatch, state='consumed', **changes):
    row = dict(id='s1', user_code='ABCD-2345', status=state, label='Instinct', write_access=False, expires_at=_future(), tenant_id='t1', approved_by='u1', api_key_id='k1')
    row.update(changes)
    client = Client(row, dict(id='k1', tenant_id='t1', revoked_at=None, expires_at=None))
    monkeypatch.setattr(api, 'storage', _FakeStorage(client))
    return client


def preview(user='u1', tenant='t1'):
    return asyncio.run(api.preview_connect_session('ABCD-2345', user={'id': user}, tenant_id=tenant))


@pytest.mark.parametrize('state,expected', [('approved','approved'), ('consumed','collected'), ('denied','denied'), ('approving','approving'), ('expired','expired')])
def test_owner_terminal_status_is_truthful(monkeypatch, state, expected):
    setup(monkeypatch,state)
    data = preview()
    assert data['status'] == expected
    assert data['return_url'] == 'https://wa.me/16508702892'
    assert not {'token','device_code','api_key_id','tenant_id','approved_by'} & data.keys()


@pytest.mark.parametrize('user,tenant', [('u2','t1'), ('u1','t2'), ('u2','t2')])
def test_foreign_owner_or_workspace_cannot_read_terminal_state(monkeypatch,user,tenant):
    setup(monkeypatch)
    with pytest.raises(HTTPException) as ex: preview(user,tenant)
    assert ex.value.status_code == 404


@pytest.mark.parametrize('key', [None, {'id':'k1','tenant_id':'t1','revoked_at':'now'}, {'id':'k1','tenant_id':'t1','expires_at':_past()}])
def test_revoked_missing_expired_key_never_reports_connected(monkeypatch,key):
    c=setup(monkeypatch)
    c.tables['external_agent_api_keys']=[key] if key else []
    assert preview()['status'] in {'revoked','expired'}


def test_collected_key_outlives_approval_link(monkeypatch):
    setup(monkeypatch,expires_at=_past())
    assert preview()['status']=='collected'


def test_expired_uncollected_approval_never_reports_connected(monkeypatch):
    setup(monkeypatch,'approved',expires_at=_past())
    assert preview()['status']=='expired'


def test_pending_still_has_read_only_scopes_and_other_assistant_no_return(monkeypatch):
    setup(monkeypatch,'pending',tenant_id=None,approved_by=None,label='https://evil.invalid')
    data=preview()
    assert data['status']=='pending'
    assert data['scopes']==sorted(api.DEFAULT_READ_SCOPES)
    assert 'return_url' not in data


def test_terminal_status_does_not_mint_or_consume_again(monkeypatch):
    c=setup(monkeypatch)
    monkeypatch.setattr(api,'_create_external_key', lambda *_a: (_ for _ in ()).throw(AssertionError('must not mint')))
    first=preview();second=preview()
    assert first==second
    assert c.tables['external_agent_connect_sessions'][0]['status']=='consumed'


def test_actual_approval_collection_preview_flow_populates_owner_and_key(monkeypatch):
    c=setup(monkeypatch,'pending',tenant_id=None,approved_by=None,api_key_id=None)
    def mint(tenant,user,label,write):
        c.tables['external_agent_api_keys']=[{'id':'minted-key','tenant_id':tenant,'revoked_at':None,'expires_at':None}]
        return {'id':'minted-key'},'ppai_fixture_only'
    monkeypatch.setattr(api,'_create_external_key',mint)
    async def allow(*args): return None
    monkeypatch.setattr(api,'_require_org_permission',allow)
    import os
    os.environ.setdefault('CONNECT_SESSION_SECRET','test-seal-key')
    asyncio.run(api.approve_connect_session('ABCD-2345',user={'id':'u1'},tenant_id='t1'))
    row=c.tables['external_agent_connect_sessions'][0]
    assert (row['approved_by'],row['tenant_id'],row['api_key_id'])==('u1','t1','minted-key')
    assert preview()['status']=='approved'
    row['device_code_hash']=api._digest('fixture-device')
    result=asyncio.run(api.poll_connect_session('fixture-device'))
    assert result['status']=='approved' and 'token' in result
    assert preview()['status']=='collected'
    assert c.tables['external_agent_connect_sessions'][0]['token'] is None
