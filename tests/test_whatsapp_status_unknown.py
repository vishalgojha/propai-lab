"""Actual dashboard handler, controlled read failures, no production requests.

These are fault-injection unit/ASGI tests, not proof of the real source session.
The old handler returns connected=false for unavailable reads, so the unknown
cases must fail against the unmodified baseline.
"""
from types import SimpleNamespace
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from routers import dashboard as d


@pytest.mark.parametrize('reachable,error,status,expected,state',[
    (False,'WhatsApp service returned HTTP 404.',None,None,'unavailable'),
    (False,'timeout',None,None,'unavailable'),
    (False,'',None,None,'unavailable'),
    (True,'',None,False,'stopped'),
    (True,'',{'connected':True,'connection_state':'open'},True,'open'),
    (True,'',{'connected':False,'connection_state':'stopped'},False,'stopped'),
])
def test_owner_status_unavailable_is_not_disconnected(monkeypatch,reachable,error,status,expected,state):
    monkeypatch.setattr(d,'_resolve_active_organization_id',lambda user,tenant:'owner')
    monkeypatch.setattr(d,'storage',SimpleNamespace(list_org_whatsapp_connections=lambda org:[{'broker_id':'owner-phone'}]))
    async def read(timeout):
        return ({'owner-phone':{'broker_id':'owner-phone',**status}} if status else {}),reachable,error
    monkeypatch.setattr(d,'_merged_ingestor_list',read)
    monkeypatch.setattr(d,'_broker_live_statuses',{})
    app=FastAPI();app.include_router(d.router)
    app.dependency_overrides[d.require_user]=lambda:{'id':'fixture-user'}
    app.dependency_overrides[d.get_tenant_context]=lambda:'owner'
    with TestClient(app) as client:
        response=client.get('/api/dashboard/whatsapp-status')
        assert response.status_code==200,response.text
        value=response.json()
        assert value['connected'] is expected
        assert value['state']==value['status']==state


def test_phone_lookup_failure_is_unknown_not_disconnected(monkeypatch):
    monkeypatch.setattr(d,'_resolve_active_organization_id',lambda user,tenant:'owner')
    def fail(org):raise RuntimeError('controlled lookup failure')
    monkeypatch.setattr(d,'storage',SimpleNamespace(list_org_whatsapp_connections=fail))
    app=FastAPI();app.include_router(d.router)
    app.dependency_overrides[d.require_user]=lambda:{'id':'fixture-user'}
    app.dependency_overrides[d.get_tenant_context]=lambda:'owner'
    with TestClient(app) as client:
        value=client.get('/api/dashboard/whatsapp-status').json()
        assert value['connected'] is None
        assert value['state']=='unavailable'
        assert value['status_available'] is False
