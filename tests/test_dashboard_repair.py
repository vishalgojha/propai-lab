import asyncio
import inspect
import time
import uuid
from types import SimpleNamespace
import psycopg2
from psycopg2.extras import RealDictCursor
import pytest
from routers import dashboard, workspace

TABLES = ('residential_sale_listings','residential_rent_listings','commercial_sale_listings','commercial_rent_listings','residential_sale_requirements','residential_rent_requirements','commercial_sale_requirements','commercial_rent_requirements')

@pytest.fixture
def db(monkeypatch):
    c = psycopg2.connect(host='/tmp', dbname='postgres', user='postgres'); c.autocommit = True
    schema = 'dashboard_test_' + uuid.uuid4().hex[:10]
    with c.cursor() as q:
        q.execute('create schema ' + schema); q.execute('set search_path to ' + schema)
        for table in TABLES:
            q.execute('create table '+table+' (tenant_id text, building_name text, micro_market text, extraction_confidence text, needs_review boolean, created_at timestamptz)')
        q.execute('create table raw_messages (tenant_id text,created_at timestamptz)')
        q.execute('create table ai_suggestions (tenant_id text,status text,agent text,suggestion_type text)')
        q.execute('create table resolver_decisions (tenant_id text,building_name text,created_at timestamptz,method text,failure_category text)')
        q.execute('create table sync_checkpoints (instance_name text,status text)')
        q.execute('create table org_whatsapp_connections (organization_id text,is_active boolean,instance_name text)')
        q.execute("insert into residential_sale_listings values ('a','A Tower','Bandra','low',true,now()),('b','Private B','Juhu','high',false,now())")
        q.execute("insert into residential_rent_requirements values ('a',null,'Khar','medium',false,now())")
        q.execute("insert into ai_suggestions values ('a','pending','building','new'),('b','pending','building','new')")
        q.execute("insert into resolver_decisions values ('a','A Tower',now(),'unresolved','location'),('b','Private B',now(),'unresolved','secret')")
        q.execute("insert into sync_checkpoints values ('a-session','error'),('b-session','error')")
        q.execute("insert into org_whatsapp_connections values ('a',true,'a-session'),('b',true,'b-session')")
    class DB:
        def execute(self, sql, params=()):
            # Exercise the production SQL adapter's repeated named-parameter contract.
            from storage.supabase import _SupabaseDatabaseAdapter
            sql, params = _SupabaseDatabaseAdapter._translate_sql(sql, params)
            import re
            order=[]
            sql=re.sub(r'\$(\d+)',lambda m: order.append(int(m[1])-1) or '%s',sql)
            q=c.cursor(cursor_factory=RealDictCursor); q.execute(sql,[params[i] for i in order]);return q
    storage=SimpleNamespace(db=DB())
    monkeypatch.setattr(dashboard,'storage',storage);monkeypatch.setattr(workspace,'storage',storage)
    monkeypatch.setattr(workspace,'_chip_cache',{})
    yield c
    with c.cursor() as q:q.execute('drop schema '+schema+' cascade')
    c.close()


def test_action_sql_current_columns_and_tenant_isolation(db):
    a=dashboard.action_dashboard(user={'id':'u'},tenant_id='a')
    assert a['low_confidence_parses']==1
    assert a['pending_review_unresolved']==1
    assert a['pending_ai_suggestions']==1
    assert a['disconnected_groups']==1
    assert a['top_parser_failures']==[{'failure_category':'location','c':1}]
    empty=dashboard.action_dashboard(user={'id':'u'},tenant_id='empty')
    assert empty['pending_ai_suggestions']==0 and empty['top_parser_failures']==[]


def test_suggestions_cold_warm_and_cross_tenant(db):
    a=workspace.chat_suggestions(user={'id':'u'},tenant_id='a')
    b=workspace.chat_suggestions(user={'id':'u'},tenant_id='b')
    assert a['top_building']=='A Tower' and a['top_demand_market']=='Khar' and a['pending']==1
    assert b['top_building']=='Private B'
    assert workspace.chat_suggestions(user={'id':'u'},tenant_id='a')==a
    empty=workspace.chat_suggestions(user={'id':'u'},tenant_id='empty')
    assert empty['top_building'] is None and empty['pending']==0
    assert not inspect.iscoroutinefunction(workspace.chat_suggestions)
    assert not inspect.iscoroutinefunction(dashboard.action_dashboard)


def test_metric_aggregate_scope_windows_and_one_round_trip(db):
    with db.cursor() as q:
        q.execute("insert into residential_sale_listings values ('a','Old','Bandra','low',true,now()-interval '5 days')")
        q.execute("insert into raw_messages values ('a',now()),('a',now()-interval '5 days'),('b',now())")
    today=asyncio.run(dashboard.dashboard_time_window(window='today',user={'id':'u'},tenant_id='a'))
    assert today['messages']==1 and today['total_messages']==2
    assert today['supply']==1 and today['total_supply']==2
    assert today['demand']==1 and today['total_demand']==1
    assert today['needs_review']==1 and today['total_needs_review']==2
    all_time=asyncio.run(dashboard.dashboard_time_window(window='all',user={'id':'u'},tenant_id='a'))
    assert all_time['supply']==2 and all_time['messages']==2
    empty=asyncio.run(dashboard.dashboard_time_window(window='today',user={'id':'u'},tenant_id='empty'))
    assert empty['supply']==0 and empty['total_messages']==0


def test_empty_tenant_cannot_read_http_routes(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routers.common import require_user, require_tenant
    from fastapi import HTTPException
    def denied(): raise HTTPException(403,'No organization membership found')
    app=FastAPI();app.include_router(dashboard.router);app.include_router(workspace.router)
    app.dependency_overrides[require_user]=lambda:{'id':'u'}
    app.dependency_overrides[require_tenant]=denied
    c=TestClient(app)
    assert c.get('/api/action/dashboard').status_code==403
    assert c.get('/api/chat/suggestions').status_code==403


def test_metrics_storage_work_does_not_block_event_loop(monkeypatch):
    def totals(*args):
        time.sleep(.1)
        return {key:0 for key in ('messages','total_messages','supply','total_supply','demand','total_demand','rentals','total_rentals','needs_review','total_needs_review')}
    monkeypatch.setattr(dashboard,'_dashboard_metric_totals',totals)
    async def run():
        ticks=[]
        async def heartbeat():
            await asyncio.sleep(.01);ticks.append(time.monotonic())
        start=time.monotonic()
        await asyncio.gather(dashboard.dashboard_time_window(window='today',user={'id':'u'},tenant_id='a'),heartbeat())
        assert ticks[0]-start < .08
    asyncio.run(run())
