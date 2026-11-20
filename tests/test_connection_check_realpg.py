"""Disposable PostgreSQL + real FastAPI auth/check routes, no live service.

Local schema models only columns used by this route. This does not prove
production Supabase/RLS, fresh-assistant storage, onboarding or live capture.
"""
import hashlib
import uuid
from types import SimpleNamespace
import psycopg2
from psycopg2 import sql
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
import routers.external_agent as api

class Query:
    def __init__(self,conn,table,log):self.conn=conn;self.table=table;self.log=log;self.columns='*';self.filters=[];self.values=[];self.updates=None;self.n=100
    def select(self,columns):self.columns=columns;return self
    def update(self,body):self.updates=body;return self
    def eq(self,key,val):self.filters.append(sql.SQL('{} = %s').format(sql.Identifier(key)));self.values.append(val);return self
    def is_(self,key,val):assert val=='null';self.filters.append(sql.SQL('{} IS NULL').format(sql.Identifier(key)));return self
    def limit(self,n):self.n=n;return self
    def execute(self):
        where=sql.SQL(' AND ').join(self.filters) if self.filters else sql.SQL('TRUE')
        if self.updates is None:
            query=sql.SQL('SELECT {} FROM {} WHERE {} LIMIT %s').format(sql.SQL(',').join(map(sql.Identifier,self.columns.split(','))),sql.Identifier(self.table),where)
            values=[*self.values,self.n]
        else:
            query=sql.SQL('UPDATE {} SET {} WHERE {} RETURNING *').format(sql.Identifier(self.table),sql.SQL(',').join(sql.SQL('{}=%s').format(sql.Identifier(k)) for k in self.updates),where)
            values=[*self.updates.values(),*self.values]
        self.log.append((self.table,self.columns,self.filters,self.updates))
        with self.conn.cursor() as c:
            c.execute(query,values)
            names=[d.name for d in c.description]
            return SimpleNamespace(data=[dict(zip(names,row)) for row in c.fetchall()])

@pytest.fixture
def app_db(monkeypatch):
    admin=psycopg2.connect(host='/tmp',dbname='postgres',user='postgres');admin.autocommit=True
    name='connect_test_'+uuid.uuid4().hex[:10]
    with admin.cursor() as c:c.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
    db=psycopg2.connect(host='/tmp',dbname=name,user='postgres');db.autocommit=True
    log=[]
    with db.cursor() as c:
        c.execute('''CREATE TABLE external_agent_api_keys(id text,tenant_id text,created_by text,label text,scopes text[],expires_at timestamptz,revoked_at timestamptz,key_hash text,last_used_at timestamptz);
        CREATE TABLE organizations(id text,external_agent_dms_enabled boolean,mcp_trial_started_at timestamptz,mcp_trial_ends_at timestamptz);
        CREATE TABLE raw_messages(id bigint,tenant_id text,is_group boolean,message text);
        INSERT INTO organizations(id,external_agent_dms_enabled) VALUES('t1',true),('t2',false);
        INSERT INTO raw_messages VALUES(1,'t1',true,'owned group'),(2,'t1',false,'private dm'),(3,'t2',true,'foreign group');''')
        c.execute('INSERT INTO external_agent_api_keys(id,tenant_id,created_by,label,scopes,key_hash) VALUES(%s,%s,%s,%s,%s,%s)',('k1','t1','u1','fixture',['raw_messages:read'],hashlib.sha256(('ppai_'+'f'*45).encode()).hexdigest()))
    monkeypatch.setattr(api,'storage',SimpleNamespace(client=SimpleNamespace(table=lambda table:Query(db,table,log))))
    app=FastAPI();app.include_router(api.router)
    with TestClient(app,raise_server_exceptions=False) as client:
        yield client,db,log
    db.close()
    with admin.cursor() as c:c.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(name)))
    admin.close()

HEADERS={'X-API-Key':'ppai_'+'f'*45}


def test_real_database_read_auth_no_content_no_trial(app_db):
    client,db,log=app_db
    result=client.get('/api/external/v1/connection-check',headers=HEADERS)
    assert result.status_code==200,result.text
    data=result.json();assert data['workspace_id']=='t1' and data['groups_read_verified']
    assert not data['storage_verified'] and not data['starts_trial'] and not data['dms_included']
    assert all(s not in result.text for s in ('owned group','private dm','foreign group'))
    raw=[entry for entry in log if entry[0]=='raw_messages']
    assert len(raw)==1 and raw[0][1]=='id' and raw[0][3] is None
    with db.cursor() as c:
        c.execute('SELECT mcp_trial_started_at,mcp_trial_ends_at FROM organizations');assert all(row==(None,None) for row in c.fetchall())
        c.execute("SELECT last_used_at IS NOT NULL FROM external_agent_api_keys WHERE id='k1'");assert c.fetchone()==(True,)


def test_real_database_empty_groups_still_verifies_query_not_capture(app_db):
    client,db,log=app_db
    with db.cursor() as c:c.execute("DELETE FROM raw_messages WHERE tenant_id='t1' AND is_group=true")
    result=client.get('/api/external/v1/connection-check',headers=HEADERS)
    assert result.status_code==200 and result.json()['groups_read_verified']
    assert 'message_count' not in result.json()

@pytest.mark.parametrize('update,status',[("UPDATE external_agent_api_keys SET revoked_at=now()",401),("UPDATE external_agent_api_keys SET expires_at=now()-interval '1 day'",401),("UPDATE external_agent_api_keys SET scopes='{}'",403)])
def test_real_database_revocation_expiry_scope_fail_closed(app_db,update,status):
    client,db,log=app_db
    with db.cursor() as c:c.execute(update)
    result=client.get('/api/external/v1/connection-check',headers=HEADERS)
    assert result.status_code==status
    assert not any(e[0]=='raw_messages' for e in log)


def test_real_database_query_error_is_not_connected(app_db):
    client,db,log=app_db
    with db.cursor() as c:c.execute('DROP TABLE raw_messages')
    result=client.get('/api/external/v1/connection-check',headers=HEADERS)
    assert result.status_code==500 and 'groups_read_verified' not in result.text


def test_real_database_missing_or_conflicting_auth_never_reads(app_db):
    client,db,log=app_db
    assert client.get('/api/external/v1/connection-check').status_code==401
    assert client.get('/api/external/v1/connection-check',headers={**HEADERS,'Authorization':'Bearer ppai_wrong'}).status_code==401
    assert not any(e[0]=='raw_messages' for e in log)


def test_http_workspace_change_is_rejected_before_storage_or_mint(app_db,monkeypatch):
    client,db,log=app_db
    client.app.dependency_overrides[api.require_user]=lambda:{'id':'u1'}
    client.app.dependency_overrides[api.require_tenant]=lambda:'t2'
    async def allow(*args):pass
    monkeypatch.setattr(api,'_require_org_permission',allow)
    result=client.post('/api/external/v1/connect/sessions/by-code/ABCD-2345/approve',json={'workspace_id':'t1'})
    assert result.status_code==409 and not log
