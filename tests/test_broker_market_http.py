import asyncio
from types import SimpleNamespace
import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from psycopg2.extras import RealDictCursor

from tests.test_broker_market_realpg import db,seeded
from routers import broker_market as market
from broker_market_policy import PropertySearch


@pytest.fixture
def client(seeded,monkeypatch):
    connection,_=seeded
    monkeypatch.setenv('SUPABASE_SERVICE_KEY','local-test-signing-only')
    monkeypatch.setattr(market,'_record_assistant_trial_start',lambda tenant:None)
    monkeypatch.setenv('BROKER_PROPERTY_CROSS_SEARCH_ENABLED','true')
    # Exercise real PostgreSQL RPCs via the production route, not fake policy rows.
    class RPC:
        def __init__(self,name,params):self.name=name;self.params=params
        def execute(self):
            import json
            params={k:json.dumps(v) if k=='p_terms' else v for k,v in self.params.items()}
            with connection.cursor(cursor_factory=RealDictCursor) as q:
                placeholders=','.join(k+' => %s' for k in params)
                q.execute('select * from '+self.name+'('+placeholders+')',tuple(params.values()))
                rows=[dict(r) for r in q.fetchall()]
                for row in rows:
                    for k,v in row.items():
                        if hasattr(v,'isoformat'):row[k]=v.isoformat()
                if self.name=='broker_market_take_rate':return SimpleNamespace(data=rows[0][self.name])
                return SimpleNamespace(data=rows)
    monkeypatch.setattr(market,'storage',SimpleNamespace(client=SimpleNamespace(rpc=lambda n,p:RPC(n,p).execute().data)))
    app=FastAPI();app.include_router(market.router)
    key={'id':'test-key','tenant_id':'reader-org','created_by':'reader-user','scopes':[market.SCOPE]}
    app.dependency_overrides[market.market_key]=lambda:key
    with TestClient(app) as test:
        yield test,connection,key


def test_rest_source_live_revoke_get_contact_and_no_contact_bulk(client):
    c,db,key=client
    res=c.post('/api/external/v1/market/search',json={'building':'Lodha'})
    assert res.status_code==200,res.text
    rows=res.json()['results'];assert len(rows)==1
    assert '9820056180' not in res.text
    option=rows[0]['option']
    assert c.post('/api/external/v1/market/option',json={'option':option}).status_code==200
    assert c.post('/api/external/v1/market/contact',json={'option':option}).status_code==422
    reveal=c.post('/api/external/v1/market/contact',json={'option':option,'broker_interest_quote':'This option looks interesting','broker_confirmed_this_option':True})
    assert reveal.status_code==200,reveal.text
    assert reveal.json()['phone']=='+919820056180'
    with db.cursor() as q:q.execute('update organization_group_connections set opted_out=true where id=11')
    assert c.post('/api/external/v1/market/option',json={'option':option}).status_code==404
    assert c.post('/api/external/v1/market/contact',json={'option':option,'broker_interest_quote':'This option looks interesting','broker_confirmed_this_option':True}).status_code==404
    assert c.post('/api/external/v1/market/search',json={'building':'Lodha'}).json()['results']==[]


def test_mcp_calls_same_handler_and_private_fields_absent(client):
    c,db,key=client
    payload={'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':'property_cross_search','arguments':{'building':'Lodha'}}}
    r=c.post('/api/external/v1/market/mcp',json=payload)
    assert r.status_code==200,r.text
    data=r.json()['result']['structuredContent']
    assert len(data['results'])==1 and '9820056180' not in r.text
    assert set(data['results'][0])=={'option','text','timestamp','source','verified_inventory'}
    payload['params']['arguments']={'sender':'Alice'}
    assert c.post('/api/external/v1/market/mcp',json=payload).json()['error']['code']==-32602


def test_reader_bound_reference_and_source_content_immutable(client):
    c,db,key=client
    option=c.post('/api/external/v1/market/search',json={'building':'Lodha'}).json()['results'][0]['option']
    key['id']='different-key'
    assert c.post('/api/external/v1/market/option',json={'option':option}).status_code==404
    key['id']='test-key'
    with db.cursor() as q:q.execute("update raw_messages set message='Lodha 3 bhk sale edited call 9876543210' where id=1")
    assert c.post('/api/external/v1/market/option',json={'option':option}).status_code==404


def test_no_auth_no_market_and_unknown_queries_rejected(monkeypatch):
    monkeypatch.setenv('BROKER_PROPERTY_CROSS_SEARCH_ENABLED','false')
    app=FastAPI();app.include_router(market.router)
    with TestClient(app) as c:
        assert c.post('/api/external/v1/market/search',json={'building':'Lodha'}).status_code==401
    with pytest.raises(Exception):market.enabled()


def test_legacy_combined_consent_is_retired(client,monkeypatch):
    c,db,key=client
    c.app.dependency_overrides[market.require_user]=lambda:{'id':'00000000-0000-4000-8000-000000000001'}
    c.app.dependency_overrides[market.require_tenant]=lambda:'owner-org'
    payload={'whatsapp_connection_id':1,'group_jids':['123@g.us'],'consent_version':'broker-property-cross-search-v1','confirmed':True}
    assert c.put('/api/external/v1/market/source-consent',json=payload).status_code==410
    # Current permission, version and independent-source behavior is exercised
    # against actual new SQL+HTTP in test_independent_raw_sharing.py.


def test_disabled_and_missing_reader_scope_not_automatically_upgraded(monkeypatch):
    from fastapi import HTTPException
    monkeypatch.setenv('BROKER_PROPERTY_CROSS_SEARCH_ENABLED','true')
    with pytest.raises(HTTPException) as error:
        asyncio.run(market.market_key({'id':'k','tenant_id':'t','scopes':['raw_messages:read']}))
    assert error.value.status_code==403
    monkeypatch.setenv('BROKER_PROPERTY_CROSS_SEARCH_ENABLED','false')
    with pytest.raises(HTTPException) as error:
        asyncio.run(market.market_key({'id':'k','tenant_id':'t','scopes':['broker_market:read']}))
    assert error.value.status_code==503


def test_mcp_owner_grant_and_revoke_require_manage_permission(client,monkeypatch):
    c,db,key=client
    c.app.dependency_overrides[market.require_user]=lambda:{'id':'owner-user'}
    c.app.dependency_overrides[market.require_tenant]=lambda:'owner-org'
    calls=[]
    async def allowed(*args):calls.append(('permission',args))
    async def rpc(name,params):calls.append((name,params));return [{'enabled':params['p_enabled']}]
    monkeypatch.setattr(market,'_require_org_permission',allowed)
    monkeypatch.setattr(market,'rpc',rpc)
    for enabled in (True,False):
        r=c.put('/api/external/v1/market/mcp-reader-access',json={'enabled':enabled})
        assert r.status_code==200 and r.json()['enabled'] is enabled
        assert calls[-1][1]=={'p_tenant':'owner-org','p_user':'owner-user','p_enabled':enabled,'p_actor':'owner-user'}
    async def denied(*args):
        from fastapi import HTTPException
        raise HTTPException(403,'denied')
    monkeypatch.setattr(market,'_require_org_permission',denied)
    before=len(calls)
    assert c.put('/api/external/v1/market/mcp-reader-access',json={'enabled':True}).status_code==403
    assert len(calls)==before
