"""Owner HTTP controls -> real PostgreSQL -> reader retrieval, no production data.

The transport adapter below maps the small Supabase fluent surface to parameterized
SQL; permissions/routes/policy SQL are the production implementations.
"""
import json
from datetime import datetime,timezone,timedelta
from types import SimpleNamespace
from pathlib import Path
import pytest
from psycopg2 import sql
from psycopg2.extras import RealDictCursor
from fastapi import FastAPI,HTTPException
from fastapi.testclient import TestClient
from tests.test_independent_raw_sharing import db,seeded,message
from broker_market_policy import CONSENT_VERSION
from routers import broker_market as market


def encoded(rows):
    return [{k:v.isoformat() if hasattr(v,'isoformat') else v for k,v in r.items()} for r in rows]

class Table:
    def __init__(self,c,name):self.c=c;self.name=name;self.cols='*';self.where=[];self.args=[];self.values=None;self.conflict=None
    def select(self,cols):self.cols=cols;return self
    def eq(self,k,v):self.where.append(sql.SQL('{}=%s').format(sql.Identifier(k)));self.args.append(v);return self
    def is_(self,k,v):self.where.append(sql.SQL('{} is null').format(sql.Identifier(k)));return self
    def in_(self,k,v):self.where.append(sql.SQL('{}=ANY(%s)').format(sql.Identifier(k)));self.args.append(v);return self
    def limit(self,n):return self
    def order(self,n):return self
    def upsert(self,values,on_conflict):self.values=values;self.conflict=on_conflict;return self
    def execute(self):
        with self.c.cursor(cursor_factory=RealDictCursor) as q:
            if self.values is not None:
                rows=[]
                for row in self.values:
                    keys=list(row)
                    query=sql.SQL('insert into {} ({}) values ({}) on conflict ({}) do update set {} returning *').format(sql.Identifier(self.name),sql.SQL(',').join(map(sql.Identifier,keys)),sql.SQL(',').join(sql.Placeholder() for _ in keys),sql.Identifier(self.conflict),sql.SQL(',').join(sql.SQL('{}=excluded.{}').format(sql.Identifier(k),sql.Identifier(k)) for k in keys))
                    q.execute(query,[row[k] for k in keys]);rows.extend(q.fetchall())
            else:
                query=sql.SQL('select {} from {}').format(sql.SQL(',').join(map(sql.Identifier,self.cols.split(','))),sql.Identifier(self.name))
                if self.where:query+=sql.SQL(' where ')+sql.SQL(' and ').join(self.where)
                q.execute(query,self.args);rows=q.fetchall()
            return SimpleNamespace(data=encoded(rows))

class RPC:
    def __init__(self,c,n,p):self.c=c;self.n=n;self.p=p
    def execute(self):
        with self.c.cursor(cursor_factory=RealDictCursor) as q:
            query=sql.SQL('select * from {}({})').format(sql.Identifier(self.n),sql.SQL(',').join(sql.SQL('{} => %s').format(sql.Identifier(k)) for k in self.p))
            
            try:q.execute(query,[json.dumps(v) if k=='p_terms' else v for k,v in self.p.items()])
            except Exception as exc:print('LOCAL_RPC_ERROR',self.n,str(exc));raise
            rows=encoded(q.fetchall())
            return SimpleNamespace(data=rows[0][self.n] if self.n in ['broker_market_take_rate','broker_market_set_raw_sources'] else rows)


def test_owner_consent_reader_search_untick_and_mcp_grant_round_trip(seeded,monkeypatch):
    c,org,other_org,user,other_user=seeded
    with c.cursor() as q:
        q.execute(Path('supabase/migrations/20261119100000_broker_market_mcp_reader_grants.sql').read_text())
    monkeypatch.setenv('BROKER_PROPERTY_CROSS_SEARCH_ENABLED','true');monkeypatch.setenv('BROKER_MARKET_SIGNING_SECRET','fixture-only')
    monkeypatch.setattr(market,'_record_assistant_trial_start',lambda _:None)
    monkeypatch.setattr(market,'storage',SimpleNamespace(client=SimpleNamespace(table=lambda n:Table(c,n),rpc=lambda n,p:RPC(c,n,p).execute().data)))
    permissions=[]
    async def allow(u,t,p):
        assert u['id']==user and t==org and p=='manage_whatsapp';permissions.append(p)
    monkeypatch.setattr(market,'_require_org_permission',allow)
    app=FastAPI();app.include_router(market.router)
    app.dependency_overrides[market.require_user]=lambda:{'id':user}
    app.dependency_overrides[market.require_tenant]=lambda:org
    app.dependency_overrides[market.market_key]=lambda:{'id':'reader-key','tenant_id':'different-source-reader','scopes':[market.SCOPE]}
    with TestClient(app) as http:
        assert http.post('/api/external/v1/market/search',json={'building':'Lodha'}).json()['results']==[]
        response=http.put('/api/external/v1/market/raw-sources',json={'whatsapp_connection_id':1,'group_jids':['123@g.us'],'consent_version':CONSENT_VERSION,'confirmed':True,'enabled':True})
        assert response.status_code==200,response.text
        # Existing pre-consent rows remain private; simulate one new captured row.
        assert http.post('/api/external/v1/market/search',json={'building':'Lodha'}).json()['results']==[]
        message(seeded)
        result=http.post('/api/external/v1/market/search',json={'building':'Lodha'}).json()
        assert len(result['results'])==1
        option=result['results'][0]['option']
        assert http.get('/api/external/v1/market/mcp-reader-access').json()['enabled'] is False
        for enable in (True,False):
            response=http.put('/api/external/v1/market/mcp-reader-access',json={'enabled':enable})
            assert response.status_code==200,response.text
            assert http.get('/api/external/v1/market/mcp-reader-access').json()['enabled'] is enable
            with c.cursor() as q:
                q.execute('select user_id,granted_by,revoked_at from broker_market_mcp_reader_grants where organization_id=%s',(org,));row=q.fetchone()
                assert str(row[0])==str(row[1])==user
                assert (row[2] is None) is enable
        response=http.put('/api/external/v1/market/raw-sources',json={'whatsapp_connection_id':1,'group_jids':['123@g.us'],'consent_version':CONSENT_VERSION,'confirmed':False,'enabled':False});assert response.status_code==200,response.text
        assert http.post('/api/external/v1/market/option',json={'option':option}).status_code==404
        assert http.post('/api/external/v1/market/search',json={'building':'Lodha'}).json()['results']==[]
        with c.cursor() as q:q.execute("select extraction_status from org_whatsapp_connections where id=1");assert q.fetchone()[0]=='stopped'
        assert http.post('/api/external/v1/market/search',json={'building':'Lodha'}).json()['results']==[]
    assert len(permissions)==4
