import asyncio
import json
from types import SimpleNamespace
import pytest
from fastapi import HTTPException
from assistant_connection_client import AssistantConnection,SetupError
from test_connect_return import setup,preview
import routers.external_agent as api

class Store:
    def __init__(self):self.values={}
    def save(self,name,value):self.values[name]=value
    def retrieve(self,name):return self.values[name]

class Transport:
    def __init__(self):self.calls=[];self.status=200;self.check_code=200
    def __call__(self,method,path,body,token):
        self.calls.append((method,path,body,token))
        if path=='/connect/sessions':return 201,dict(device_code='x'*32,user_code='ABCD-2345',connect_url='https://app.propai.live/connect?code=ABCD-2345',interval=5)
        if path.startswith('/connect/sessions/'):
            if self.status==202:return 202,{'status':'pending'}
            return self.status,{'status':'approved','token':'ppai_fixture_not_a_live_secret'}
        if path=='/connection-check':return self.check_code,dict(ok=True,groups_read_verified=True,workspace_id='t1',checked_at='fixture')
        raise AssertionError(path)


def test_adapter_starts_read_only_and_never_returns_private_values():
    t=Transport();s=Store();a=AssistantConnection(t,s);public=a.start()
    assert public['state']=='awaiting_approval' and 'device_code' not in public
    assert t.calls[0][2]=={'label':'Instinct','write_access':False}
    assert 'x'*32 not in repr(a.pending)
    result=a.collect_and_check()
    assert result['state']=='read_verified' and not result['pool_verified']
    assert 'ppai_' not in json.dumps(result)
    assert len(s.values)==1 and a.pending is None
    assert t.calls[-1][1]=='/connection-check'
    assert not any('/messages/search' in c[1] for c in t.calls)


def test_pending_does_not_save_or_probe():
    t=Transport();s=Store();a=AssistantConnection(t,s);a.start();t.status=202
    assert a.collect_and_check()=={'state':'awaiting_approval','retry_after':5}
    assert not s.values and len(t.calls)==2

@pytest.mark.parametrize('status',[401,403,404,410,503])
def test_decline_expiry_failure_never_reports_connected(status):
    t=Transport();s=Store();a=AssistantConnection(t,s);a.start();t.status=status
    with pytest.raises(SetupError):a.collect_and_check()
    assert not s.values and a.pending is None


def test_storage_failure_no_probe_or_repeat_collection():
    class Broken(Store):
        def retrieve(self,name):raise RuntimeError('fixture secret failure')
    t=Transport();a=AssistantConnection(t,Broken());a.start()
    with pytest.raises(SetupError) as exc:a.collect_and_check()
    assert 'fixture secret' not in str(exc.value) and 'ppai_' not in str(exc.value)
    assert len(t.calls)==2
    with pytest.raises(SetupError):a.collect_and_check()
    assert len(t.calls)==2


def test_read_failure_and_later_revocation_fail_closed():
    t=Transport();a=AssistantConnection(t,Store());a.start();t.check_code=503
    with pytest.raises(SetupError):a.collect_and_check()
    t.check_code=200;assert a.check_saved()['state']=='read_verified'
    t.check_code=401
    with pytest.raises(SetupError):a.check_saved()


def test_bad_approval_destination_refused():
    t=Transport()
    def bad(*args):
        status,body=t(*args);body['connect_url']='https://evil.invalid/connect';return status,body
    a=AssistantConnection(bad,Store())
    with pytest.raises(SetupError):a.start()
    assert a.pending is None


def test_browser_collected_is_never_connected_proof(monkeypatch):
    setup(monkeypatch,'consumed');data=preview()
    assert data['status']=='collected' and data['connection_verified'] is False
    assert data['workspace_id']=='t1'


def test_workspace_switch_before_allow_cannot_mint(monkeypatch):
    setup(monkeypatch,'pending',tenant_id=None,approved_by=None)
    async def allow(*args):return None
    monkeypatch.setattr(api,'_require_org_permission',allow)
    monkeypatch.setattr(api,'_create_external_key',lambda *args:pytest.fail('minted on changed account'))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(api.approve_connect_session('ABCD-2345',user={'id':'u1'},tenant_id='t2',body=api.ConnectApproval(workspace_id='t1')))
    assert exc.value.status_code==409


def test_connection_check_scoped_no_content_no_trial(monkeypatch):
    calls=[]
    class Q:
        def select(self,*args):calls.append(('select',args));return self
        def eq(self,*args):calls.append(('eq',args));return self
        def limit(self,*args):calls.append(('limit',args));return self
        def execute(self):return SimpleNamespace(data=[{'id':9}])
    monkeypatch.setattr(api,'storage',SimpleNamespace(client=SimpleNamespace(table=lambda name:Q())))
    monkeypatch.setattr(api,'_record_assistant_trial_start',lambda *args:pytest.fail('trial started'))
    result=asyncio.run(api.external_connection_check(key={'tenant_id':'t1','scopes':['raw_messages:read']}))
    assert ('eq',('tenant_id','t1')) in calls and ('eq',('is_group',True)) in calls
    assert result['groups_read_verified'] is True and not result['starts_trial'] and not result['storage_verified']
    assert 'id' not in result and 'message' not in result


def test_connection_check_requires_raw_read_scope():
    with pytest.raises(HTTPException) as exc:asyncio.run(api.external_connection_check(key={'tenant_id':'t1','scopes':[]}))
    assert exc.value.status_code==403

@pytest.mark.parametrize('phase',['start','collect','check'])
def test_transport_errors_never_propagate_private_details(phase):
    t=Transport();s=Store();a=AssistantConnection(t,s)
    def broken(*args):raise RuntimeError('fixture private transport value')
    if phase!='start':a.start()
    if phase=='check':a.collect_and_check()
    a.transport=broken
    with pytest.raises(SetupError) as exc:
        if phase=='start':a.start()
        elif phase=='collect':a.collect_and_check()
        else:a.check_saved()
    assert 'fixture private' not in str(exc.value)
