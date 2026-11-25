"""Real disposable PostgreSQL, including actual SQL, HTTP routes and source reread.
No WhatsApp socket. The owning production app/auth integrations remain separate gates.
"""
import json
import uuid
from datetime import datetime,timedelta,timezone
from pathlib import Path
from types import SimpleNamespace
import psycopg2
from psycopg2.extras import RealDictCursor
from psycopg2 import sql
import pytest
from fastapi import FastAPI,HTTPException
from fastapi.testclient import TestClient
from routers import broker_market as market
from broker_market_policy import CONSENT_VERSION,PROPERTY_PATTERN

@pytest.fixture(scope='module')
def db():
    admin=psycopg2.connect(host='/tmp',dbname='postgres',user='postgres');admin.autocommit=True
    name='independent_raw_'+uuid.uuid4().hex[:10]
    with admin.cursor() as q:q.execute('create database '+name)
    c=psycopg2.connect(host='/tmp',dbname=name,user='postgres');c.autocommit=True
    with c.cursor() as q:
        for role in ('anon','authenticated','service_role'):
            q.execute('select 1 from pg_roles where rolname=%s',(role,))
            if not q.fetchone():q.execute(sql.SQL('create role {}').format(sql.Identifier(role)))
        q.execute('''create schema auth;create table auth.users(id uuid primary key);
        create table organizations(id uuid primary key);
        create table org_whatsapp_connections(id bigint primary key,organization_id uuid,broker_id text,is_active boolean,phone_number text default '12025550123',extraction_status text default 'stopped');
        create table organization_group_connections(id bigint primary key,organization_id uuid,whatsapp_connection_id bigint,group_jid text,group_name text,is_active boolean,opted_out boolean,public_market_source boolean,updated_at timestamptz);
        create table external_agent_api_keys(id uuid primary key,tenant_id uuid,scopes text[],revoked_at timestamptz);
        create table raw_messages(id bigint primary key,tenant_id uuid,message text,timestamp timestamptz,sender_phone text,sender_jid text,is_group boolean,source text,pipeline_version text,raw_payload jsonb,event_id text,message_uid text,synced_at timestamptz);
        create table whatsapp_conversations(tenant_id uuid,broker_id text,conversation_type text,conversation_jid text,display_name text,message_count integer default 0,last_message_at timestamptz);
        create table broker_whatsapp_devices(whatsapp_connection_key text primary key,device_jid text);
        create table typed_sentinel(id bigint,visibility text);
        ''')
        q.execute(Path('supabase/migrations/20261119090000_broker_property_cross_search.sql').read_text())
        q.execute(Path('supabase/migrations/20261120100000_independent_raw_group_sharing.sql').read_text())
        q.execute(Path('supabase/migrations/20261123150000_optional_source_contact_disclosure.sql').read_text())
    yield c
    c.close()
    with admin.cursor() as q:q.execute('drop database '+name+' with (force)')
    admin.close()

@pytest.fixture
def seeded(db):
    a,b,u,v=[str(uuid.uuid4()) for _ in range(4)]
    with db.cursor() as q:
        q.execute('truncate broker_whatsapp_devices,raw_messages,broker_market_raw_source_consents,broker_market_source_consents,organization_group_connections,org_whatsapp_connections,organizations,auth.users,whatsapp_conversations,typed_sentinel cascade')
        q.execute('insert into auth.users values(%s),(%s)',(u,v));q.execute('insert into organizations values(%s),(%s)',(a,b))
        q.execute("insert into org_whatsapp_connections(id,organization_id,broker_id,is_active) values(1,%s,'phone-a',true),(2,%s,'phone-b',true)",(a,b))
        q.execute("insert into whatsapp_conversations(tenant_id,broker_id,conversation_type,conversation_jid,display_name,message_count,last_message_at) values(%s,'phone-a','group','123@g.us','Property Alpha',42,now()),(%s,'phone-a','group','999@g.us','Social Beta',0,null),(%s,'phone-b','group','123@g.us','Property Alpha',7,now())",(a,a,b))
        q.execute("insert into typed_sentinel values(1,'workspace_private')")
    return db,a,b,u,v

def grant(seed,groups=['123@g.us'],enabled=True,tenant=None,connection=1):
    db,a,b,u,v=seed
    with db.cursor() as q:
        q.execute('select broker_market_set_raw_sources(%s,%s,%s,%s,%s,%s)',(tenant or a,connection,groups,u,CONSENT_VERSION,enabled));return q.fetchone()[0]

def message(seed,id=1,org=None,broker='phone-a',jid='123@g.us',posted=None,captured=None):
    db,a,*_=seed;now=datetime.now(timezone.utc)
    with db.cursor() as q:q.execute("insert into raw_messages values(%s,%s,'Lodha 3 bhk for sale call 9820056180',%s,'9820056180','',true,'WHATSAPP','go-ingestor',%s,%s,%s,%s)",(id,org or a,posted or now,json.dumps({'data':{'key':{'remoteJid':jid}}}),broker+':m'+str(id),broker+':'+jid+':m'+str(id),captured or now))

def ids(db):
    with db.cursor() as q:q.execute('select raw_id from broker_market_eligible_source_rows order by raw_id');return [x[0] for x in q.fetchall()]

def untouched(db):
    with db.cursor() as q:
        q.execute('select count(*) from organization_group_connections');assert q.fetchone()[0]==0
        q.execute("select extraction_status from org_whatsapp_connections where id=1");assert q.fetchone()[0]=='stopped'
        q.execute('select visibility from typed_sentinel');assert q.fetchone()[0]=='workspace_private'

def test_no_legacy_promotion_and_raw_grant_without_extraction(seeded):
    db,a,b,u,v=seeded;message(seeded);assert ids(db)==[]
    assert grant(seeded)==1
    # Existing message predates consent and stays private, even when capture is recent.
    assert ids(db)==[]
    message(seeded,id=2);assert ids(db)==[2];untouched(db)
    assert grant(seeded,['123@g.us'],False)==1;assert ids(db)==[];untouched(db)

def test_regrant_forward_only_and_idempotent_grant(seeded):
    db,*_=seeded;grant(seeded);message(seeded)
    with db.cursor() as q:q.execute('select confirmed_at from broker_market_raw_source_consents');first=q.fetchone()[0]
    grant(seeded)
    with db.cursor() as q:q.execute('select confirmed_at from broker_market_raw_source_consents');assert q.fetchone()[0]==first
    grant(seeded,enabled=False);grant(seeded)
    # Deliberate future timestamp above can remain after new consent, so force a past posted time.
    with db.cursor() as q:q.execute("update raw_messages set timestamp=now()-interval '1 minute'")
    assert ids(db)==[]

@pytest.mark.parametrize('change',[
 "update raw_messages set is_group=false", "update raw_messages set pipeline_version='history-sync-suppressed'",
 "update raw_messages set raw_payload='{\"data\":{\"source\":\"history_sync\",\"key\":{\"remoteJid\":\"123@g.us\"}}}'",
 "update raw_messages set event_id='phone-b:m1'", "update raw_messages set message_uid='phone-b:123@g.us:m1'",
 "update raw_messages set timestamp=now()-interval '1 day'", "update raw_messages set synced_at=now()-interval '1 day'",
 "update org_whatsapp_connections set is_active=false where id=1", "update org_whatsapp_connections set broker_id='phone-new' where id=1",
 "update broker_market_raw_source_consents set revoked_at=now()",
])
def test_adversarial_provenance_and_revocation(seeded,change):
    db,*_=seeded;grant(seeded);message(seeded);assert ids(db)==[1]
    with db.cursor() as q:q.execute(change)
    assert ids(db)==[]
    with db.cursor() as q:q.execute('select * from broker_market_get(1)');assert q.fetchall()==[]

def test_same_name_and_same_jid_other_tenant_not_exposed(seeded):
    db,a,b,*_=seeded;grant(seeded);message(seeded);message(seeded,id=2,org=b,broker='phone-b');message(seeded,id=3,jid='999@g.us');assert ids(db)==[1]

@pytest.mark.parametrize('groups,tenant,connection', [(['123@g.us','nope@g.us'],None,1),(['123@g.us','888@g.us'],None,1),(['123@g.us'],None,2),([],None,1)])
def test_invalid_batch_atomic_no_partial_grants(seeded,groups,tenant,connection):
    with pytest.raises(psycopg2.Error):grant(seeded,groups,connection=connection)
    with seeded[0].cursor() as q:q.execute('select count(*) from broker_market_raw_source_consents');assert q.fetchone()[0]==0

def test_disconnect_reactivate_does_not_restore_old_consent(seeded):
    db,*_=seeded;grant(seeded);message(seeded);assert ids(db)==[1]
    with db.cursor() as q:q.execute('update org_whatsapp_connections set is_active=false where id=1');q.execute('update org_whatsapp_connections set is_active=true where id=1')
    assert ids(db)==[]

@pytest.fixture
def client(seeded,monkeypatch):
    db,a,b,u,v=seeded
    monkeypatch.setenv('BROKER_PROPERTY_CROSS_SEARCH_ENABLED','true');monkeypatch.setenv('BROKER_MARKET_SIGNING_SECRET','local-nonproduction')
    monkeypatch.setattr(market,'_record_assistant_trial_start',lambda _:None)
    async def allow(*args):pass
    monkeypatch.setattr(market,'_require_org_permission',allow)
    class RPC:
        def __init__(self,n,p):self.n=n;self.p=p
        def execute(self):
            p={k:json.dumps(v) if k=='p_terms' else v for k,v in self.p.items()}
            with db.cursor(cursor_factory=RealDictCursor) as q:
                q.execute('select * from '+self.n+'('+','.join(k+' => %s' for k in p)+')',tuple(p.values()));rows=[dict(x) for x in q.fetchall()]
                if self.n in ['broker_market_set_raw_sources','broker_market_take_rate']:return SimpleNamespace(data=rows[0][self.n])
                for row in rows:
                    for k,val in row.items():
                        if hasattr(val,'isoformat'):row[k]=val.isoformat()
                return SimpleNamespace(data=rows)
    class Table:
        def __init__(self,name):self.name=name;self.cols='*';self.filters=[];self.args=[];self.n=1001;self.sort=None
        def select(self,cols):self.cols=cols;return self
        def eq(self,k,v):self.filters.append(sql.SQL('{}=%s').format(sql.Identifier(k)));self.args.append(v);return self
        def is_(self,k,v):self.filters.append(sql.SQL('{} is null').format(sql.Identifier(k)));return self
        def order(self,k):self.sort=k;return self
        def limit(self,n):self.n=n;return self
        def execute(self):
            query=sql.SQL('select {} from {}').format(sql.SQL(',').join(sql.Identifier(x) for x in self.cols.split(',')),sql.Identifier(self.name))
            if self.filters:query+=sql.SQL(' where ')+sql.SQL(' and ').join(self.filters)
            if self.sort:query+=sql.SQL(' order by {}').format(sql.Identifier(self.sort))
            query+=sql.SQL(' limit %s')
            with db.cursor(cursor_factory=RealDictCursor) as q:q.execute(query,self.args+[self.n]);return SimpleNamespace(data=[dict(x) for x in q.fetchall()])
    monkeypatch.setattr(market,'storage',SimpleNamespace(client=SimpleNamespace(rpc=lambda n,p:RPC(n,p).execute().data,table=Table)))
    app=FastAPI();app.include_router(market.router)
    app.dependency_overrides[market.require_user]=lambda:{'id':u}
    app.dependency_overrides[market.require_tenant]=lambda:a
    key={'id':'fresh-reader','tenant_id':b,'scopes':[market.SCOPE]}
    app.dependency_overrides[market.market_key]=lambda:key
    with TestClient(app) as c:yield c,seeded

def test_actual_http_grant_masked_reader_option_then_revoke(client):
    c,seed=client;payload={'whatsapp_connection_id':1,'group_jids':['123@g.us'],'consent_version':CONSENT_VERSION,'confirmed':True,'enabled':True}
    assert c.put('/api/external/v1/market/raw-sources',json=payload).status_code==200
    message(seed);untouched(seed[0])
    r=c.post('/api/external/v1/market/search',json={'building':'Lodha'});assert r.status_code==200,r.text
    assert len(r.json()['results'])==1 and '9820056180' not in r.text
    opt=r.json()['results'][0]['option'];assert c.post('/api/external/v1/market/option',json={'option':opt}).status_code==200
    assert c.put('/api/external/v1/market/raw-sources',json={**payload,'confirmed':False,'enabled':False}).status_code==200
    assert c.post('/api/external/v1/market/option',json={'option':opt}).status_code==404
    untouched(seed[0])

def test_current_authority_and_legacy_client_denied(client,monkeypatch):
    c,seed=client;p={'whatsapp_connection_id':1,'group_jids':['123@g.us'],'consent_version':CONSENT_VERSION,'confirmed':True,'enabled':True}
    for delta in [{'consent_version':'broker-property-cross-search-v1'},{'confirmed':False},{'group_jids':[]}]:assert c.put('/api/external/v1/market/raw-sources',json={**p,**delta}).status_code==400
    old={k:v for k,v in p.items() if k!='enabled'}
    assert c.put('/api/external/v1/market/source-consent',json=old).status_code==410
    async def deny(*args):raise HTTPException(403,'denied')
    monkeypatch.setattr(market,'_require_org_permission',deny)
    assert c.put('/api/external/v1/market/raw-sources',json=p).status_code==403
    assert c.get('/api/external/v1/market/raw-sources?whatsapp_connection_id=1').status_code==403


def test_real_http_directory_and_active_grants_are_separate_from_legacy(client):
    c,seed=client;db,a,b,u,v=seed
    before=c.get('/api/external/v1/market/raw-sources?whatsapp_connection_id=1')
    assert before.status_code==200,before.text
    assert len(before.json()['groups'])==2 and before.json()['active_sources']==[]
    assert before.json()['consent_version']==CONSENT_VERSION
    assert c.get('/api/external/v1/market/raw-sources?whatsapp_connection_id=2').status_code==404
    grant(seed);after=c.get('/api/external/v1/market/raw-sources?whatsapp_connection_id=1').json()
    assert [x['group_jid'] for x in after['active_sources']]==['123@g.us']
    # A social directory name is not permission. It remains unshared until the owner acts.
    assert not any(x['group_jid']=='999@g.us' for x in after['active_sources'])
    untouched(db)


def test_legacy_ticks_and_old_consent_do_not_promote_any_raw_row(seeded):
    db,a,b,u,v=seeded
    with db.cursor() as q:
        q.execute("insert into organization_group_connections values(11,%s,1,'123@g.us','Property Alpha',true,false,true,now()-interval '1 day')",(a,))
        q.execute("insert into broker_market_source_consents values(11,'broker-property-cross-search-v1',%s,now()-interval '1 day',now()-interval '1 day',null)",(u,))
    message(seeded);assert ids(db)==[]
    grant(seeded);message(seeded,id=2);assert ids(db)==[2]
    # Negative privacy controls revoke; later positive extraction choices do not restore it.
    with db.cursor() as q:q.execute('update organization_group_connections set opted_out=true,public_market_source=false where id=11')
    assert ids(db)==[]


@pytest.mark.parametrize('role',['anon','authenticated'])
def test_raw_table_and_mutator_not_accessible_to_browser_roles(seeded,role):
    db,*_=seeded
    with db.cursor() as q:
        q.execute(sql.SQL('set role {}').format(sql.Identifier(role)))
        try:
            with pytest.raises(psycopg2.errors.InsufficientPrivilege):q.execute('select * from broker_market_raw_source_consents')
            with pytest.raises(psycopg2.errors.InsufficientPrivilege):q.execute("select broker_market_set_raw_sources(null,1,array['123@g.us'],null,'broker-property-cross-search-v2',true)")
        finally:q.execute('reset role')


def test_connection_deactivation_race_blocks_pending_grant(seeded):
    import threading,time
    db,a,b,u,v=seeded
    contender=psycopg2.connect(db.dsn);contender.autocommit=True
    outcome=[];started=threading.Event()
    with db.cursor() as q:q.execute('begin');q.execute('select id from org_whatsapp_connections where id=1 for update')
    def attempt():
        try:
            started.set()
            with contender.cursor() as q:q.execute("select broker_market_set_raw_sources(%s,1,array['123@g.us'],%s,%s,true)",(a,u,CONSENT_VERSION))
            outcome.append('granted')
        except psycopg2.Error:outcome.append('denied')
    thread=threading.Thread(target=attempt);thread.start();assert started.wait(2)
    try:
        # Wait for the real transaction lock, not a fake scheduling delay.
        waiting=False
        for _ in range(100):
            with db.cursor() as q:q.execute('select wait_event_type from pg_stat_activity where pid=%s',(contender.get_backend_pid(),));waiting=q.fetchone()[0]=='Lock'
            if waiting:break
            time.sleep(.01)
        assert waiting,'grant did not reach the connection lock'
        with db.cursor() as q:q.execute('update org_whatsapp_connections set is_active=false where id=1');q.execute('commit')
        thread.join(3);assert not thread.is_alive();assert outcome==['denied']
        with db.cursor() as q:q.execute('select count(*) from broker_market_raw_source_consents');assert q.fetchone()[0]==0
    finally:
        with db.cursor() as q:q.execute('rollback')
        contender.close();thread.join(3)


def test_all137_exact_grant_and_invalid_batch_remains_atomic(seeded):
    db,a,b,u,v=seeded
    jids=[f'{10000+i}@g.us' for i in range(137)]
    with db.cursor() as q:q.executemany("insert into whatsapp_conversations(tenant_id,broker_id,conversation_type,conversation_jid,display_name) values(%s,'phone-a','group',%s,'Real estate fixture')",[(a,g) for g in jids])
    with pytest.raises(psycopg2.Error):grant(seeded,jids+['999999@g.us'])
    with db.cursor() as q:q.execute('select count(*) from broker_market_raw_source_consents');assert q.fetchone()[0]==0
    assert grant(seeded,jids)==137
    with db.cursor() as q:q.execute('select count(*) from broker_market_raw_source_consents where revoked_at is null');assert q.fetchone()[0]==137
    untouched(db)


def test_over200_rejected_in_sql_and_http(client):
    c,seed=client;jids=[f'{10000+i}@g.us' for i in range(201)]
    with pytest.raises(psycopg2.Error):grant(seed,jids)
    payload={'whatsapp_connection_id':1,'group_jids':jids,'consent_version':CONSENT_VERSION,'confirmed':True,'enabled':True}
    assert c.put('/api/external/v1/market/raw-sources',json=payload).status_code==422


@pytest.mark.parametrize('negative',["opted_out=true","is_active=false","public_market_source=false,is_active=false","DELETE"])
def test_negative_group_controls_permanently_revoke_and_do_not_restore(seeded,negative):
 db,a,b,u,v=seeded
 with db.cursor() as q:q.execute("insert into organization_group_connections values(11,%s,1,'123@g.us','Alpha',true,false,true,now())",(a,))
 grant(seeded);message(seeded);assert ids(db)==[1]
 with db.cursor() as q:
  if negative=='DELETE':q.execute('delete from organization_group_connections where id=11')
  else:q.execute('update organization_group_connections set '+negative+' where id=11')
 assert ids(db)==[]
 with db.cursor() as q:
  q.execute('select revoked_at is not null from broker_market_raw_source_consents');assert q.fetchone()[0]
  if negative=='DELETE':q.execute("insert into organization_group_connections values(11,%s,1,'123@g.us','Alpha',true,false,true,now())",(a,))
  else:q.execute('update organization_group_connections set is_active=true,opted_out=false,public_market_source=true where id=11')
 assert ids(db)==[]
 grant(seeded);message(seeded,id=2);assert ids(db)==[2]


def test_opted_out_group_cannot_be_newly_granted(seeded):
 db,a,b,u,v=seeded
 with db.cursor() as q:q.execute("insert into organization_group_connections values(11,%s,1,'123@g.us','Alpha',false,true,false,now())",(a,))
 with pytest.raises(psycopg2.Error):grant(seeded)
 with db.cursor() as q:q.execute('select count(*) from broker_market_raw_source_consents');assert q.fetchone()[0]==0


@pytest.mark.parametrize('mutation',["update org_whatsapp_connections set phone_number='12025550999' where id=1", "update broker_whatsapp_devices set device_jid='new:2@s.whatsapp.net' where whatsapp_connection_key='phone-a'", "delete from broker_whatsapp_devices where whatsapp_connection_key='phone-a'"])
def test_same_broker_actual_identity_change_revokes(seeded,mutation):
 db,a,b,u,v=seeded
 with db.cursor() as q:q.execute("insert into broker_whatsapp_devices values('phone-a','old:1@s.whatsapp.net')")
 grant(seeded);message(seeded);assert ids(db)==[1]
 with db.cursor() as q:q.execute(mutation)
 assert ids(db)==[]
 with db.cursor() as q:
  q.execute("update org_whatsapp_connections set phone_number='12025550123' where id=1")
  q.execute("insert into broker_whatsapp_devices values('phone-a','old:1@s.whatsapp.net') on conflict(whatsapp_connection_key) do update set device_jid=excluded.device_jid")
 assert ids(db)==[]

@pytest.mark.parametrize('keep',[['123@g.us'],[]])
def test_actual_legacy_selection_retains_or_revokes_raw_as_requested(seeded,monkeypatch,keep):
 import asyncio
 from routers import whatsapp_group_controls as controls
 db,a,b,u,v=seeded
 with db.cursor() as q:
  q.execute("alter table organization_group_connections add column if not exists network_owned boolean, add column if not exists connected_at timestamptz")
  q.execute("alter table organization_group_connections alter column id set default -1")
  q.execute("create unique index if not exists local_legacy_key on organization_group_connections(organization_id,whatsapp_connection_id,group_jid)")
  q.execute("insert into organization_group_connections(id,organization_id,whatsapp_connection_id,group_jid,group_name,is_active,opted_out,public_market_source,updated_at) values(11,%s,1,'123@g.us','Alpha',true,false,true,now())",(a,))
 grant(seeded);message(seeded);assert ids(db)==[1]
 class Mutation:
  def __init__(self,name):self.name=name;self.values=None;self.rows=None;self.filters=[];self.args=[];self.negative=False
  def update(self,values):self.values=values;return self
  def upsert(self,rows,**kwargs):self.rows=rows;return self
  def eq(self,k,v):self.filters.append(sql.SQL('{}=%s').format(sql.Identifier(k)));self.args.append(v);return self
  @property
  def not_(self):self.negative=True;return self
  def in_(self,k,values):
   self.filters.append(sql.SQL('{} <> all(%s)').format(sql.Identifier(k)));self.args.append(values);return self
  def execute(self):
   with db.cursor() as q:
    if self.rows is None:
     keys=list(self.values);q.execute(sql.SQL('update {} set {} where {}').format(sql.Identifier(self.name),sql.SQL(',').join(sql.SQL('{}=%s').format(sql.Identifier(k)) for k in keys),sql.SQL(' and ').join(self.filters)),list(self.values.values())+self.args)
    else:
     for row in self.rows:
      keys=list(row);q.execute(sql.SQL('insert into {} ({}) values ({}) on conflict(organization_id,whatsapp_connection_id,group_jid) do update set {}').format(sql.Identifier(self.name),sql.SQL(',').join(map(sql.Identifier,keys)),sql.SQL(',').join(sql.Placeholder() for k in keys),sql.SQL(',').join(sql.SQL('{}=excluded.{}').format(sql.Identifier(k),sql.Identifier(k)) for k in keys)),list(row.values()))
   return SimpleNamespace(data=[])
 async def allow(*args):pass
 monkeypatch.setattr(controls,'_resolve_active_organization_id',lambda *args:a)
 monkeypatch.setattr(controls,'_require_org_permission',allow)
 monkeypatch.setattr(controls,'_connection',lambda *args:{'id':1,'broker_id':'phone-a'})
 monkeypatch.setattr(controls,'_is_primary_group_selection_connection',lambda *args:True)
 monkeypatch.setattr(controls,'_is_propai_connection',lambda *args:False)
 monkeypatch.setattr(controls,'_organization_has_unlimited_group_access',lambda *args:True)
 monkeypatch.setattr(controls,'_group_selection_is_unlimited',lambda *args,**kw:True)
 monkeypatch.setattr(controls,'_group_directory',lambda *args,**kw:[{'group_jid':'123@g.us','group_name':'Alpha','selectable':True}])
 monkeypatch.setattr(controls,'_cap_state',lambda *args,**kw:{})
 monkeypatch.setattr(controls,'storage',SimpleNamespace(is_super_admin=lambda _:False,update_org_whatsapp_connection=lambda *args:None,client=SimpleNamespace(table=Mutation,rpc=lambda *args:SimpleNamespace(execute=lambda:None))))
 result=asyncio.run(controls.select_groups(controls.GroupSelectionRequest(whatsapp_connection_id=1,group_jids=keep,confirm=True),{'id':u},a))
 assert result['selected_group_jids']==keep
 assert ids(db)==([1] if keep else [])
 with db.cursor() as q:q.execute('select revoked_at is null from broker_market_raw_source_consents');assert q.fetchone()[0]==bool(keep)

@pytest.mark.parametrize('change',["update organization_group_connections set opted_out=true where id=11", "update broker_whatsapp_devices set device_jid='new:2@s.whatsapp.net' where whatsapp_connection_key='phone-a'"])
def test_negative_change_waiting_for_grant_revokes_after_commit(seeded,change):
 import threading,time
 db,a,b,u,v=seeded
 with db.cursor() as q:
  q.execute("insert into organization_group_connections(id,organization_id,whatsapp_connection_id,group_jid,is_active,opted_out) values(11,%s,1,'123@g.us',true,false)",(a,))
  q.execute("insert into broker_whatsapp_devices values('phone-a','old:1@s.whatsapp.net')")
  q.execute('begin');q.execute('select id from org_whatsapp_connections where id=1 for update')
 contender=psycopg2.connect(db.dsn);contender.autocommit=True;outcome=[]
 def change_now():
  try:
   with contender.cursor() as q:q.execute(change)
   outcome.append('changed')
  except psycopg2.Error as e:outcome.append(type(e).__name__)
 thread=threading.Thread(target=change_now);thread.start()
 try:
  waiting=False
  for _ in range(100):
   with db.cursor() as q:q.execute('select wait_event_type from pg_stat_activity where pid=%s',(contender.get_backend_pid(),));waiting=q.fetchone()[0]=='Lock'
   if waiting:break
   time.sleep(.01)
  assert waiting
  grant(seeded)
  with db.cursor() as q:q.execute('commit')
  thread.join(3);assert not thread.is_alive();assert outcome==['changed']
  with db.cursor() as q:q.execute('select revoked_at is not null from broker_market_raw_source_consents');assert q.fetchone()[0]
 finally:
  with db.cursor() as q:q.execute('rollback')
  contender.close();thread.join(3)


@pytest.mark.parametrize('formatted',['+1 (202) 555-0123','1 202 555 0123','1202-555.0123','  +12025550123  '])
def test_same_phone_formatting_and_same_device_refresh_preserve_raw(seeded,formatted):
 db,a,b,u,v=seeded
 with db.cursor() as q:q.execute("insert into broker_whatsapp_devices values('phone-a','12025550123:7@s.whatsapp.net')")
 grant(seeded);message(seeded)
 with db.cursor() as q:
  q.execute('update org_whatsapp_connections set phone_number=%s where id=1',(formatted,))
  q.execute("insert into broker_whatsapp_devices values('phone-a','12025550123:7@s.whatsapp.net') on conflict(whatsapp_connection_key) do update set device_jid=excluded.device_jid")
 assert ids(db)==[1]
 with db.cursor() as q:q.execute('select revoked_at is null from broker_market_raw_source_consents');assert q.fetchone()[0]


@pytest.mark.parametrize('changed',['2025550123','012025550123','Unpaired:12025550123','bad12025550123',None,''])
def test_phone_normalization_never_equates_changed_digits_or_unpaired_values(seeded,changed):
 db,a,b,u,v=seeded;grant(seeded);message(seeded)
 with db.cursor() as q:q.execute('update org_whatsapp_connections set phone_number=%s where id=1',(changed,))
 assert ids(db)==[]


def test_changed_device_for_same_phone_is_real_identity_boundary(seeded):
 db,a,b,u,v=seeded
 with db.cursor() as q:q.execute("insert into broker_whatsapp_devices values('phone-a','12025550123:7@s.whatsapp.net')")
 grant(seeded);message(seeded)
 with db.cursor() as q:q.execute("update broker_whatsapp_devices set device_jid='12025550123:8@s.whatsapp.net' where whatsapp_connection_key='phone-a'")
 assert ids(db)==[]
