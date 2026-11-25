"""Disposable PostgreSQL coverage for the production atomic RPC and real REST adapter."""
import json,uuid,threading,time
from pathlib import Path
from types import SimpleNamespace
import psycopg2,pytest,httpx
from psycopg2 import sql
from psycopg2.extras import RealDictCursor
from storage.supabase import _RestClient
TABLES=[a+'_'+b+'_'+d for a in ('residential','commercial') for b in ('sale','rent') for d in ('listings','requirements')]
@pytest.fixture(scope='module')
def db():
 admin=psycopg2.connect(host='/dev/shm/propai-atomic-confirmation-prep/socket',port=55441,dbname='postgres',user='postgres');admin.autocommit=True
 name='confirm_'+uuid.uuid4().hex[:10]
 with admin.cursor() as q:q.execute(sql.SQL('create database {}').format(sql.Identifier(name)))
 c=psycopg2.connect(host='/dev/shm/propai-atomic-confirmation-prep/socket',port=55441,dbname=name,user='postgres');c.autocommit=True
 with c.cursor() as q:
  for role in ('anon','authenticated','service_role'):
   q.execute('select 1 from pg_roles where rolname=%s',(role,))
   if not q.fetchone():q.execute(sql.SQL('create role {}').format(sql.Identifier(role)))
  q.execute('''create schema auth;create table auth.users(id uuid primary key);create table organizations(id uuid primary key);
   create table org_whatsapp_connections(id bigint primary key,organization_id uuid,broker_id text,is_active boolean,phone_number text default '12025550123',extraction_status text default 'stopped',group_audit_required boolean default true,group_audit_completed_at timestamptz,updated_at timestamptz);
   create table organization_group_connections(id bigserial primary key,organization_id uuid,whatsapp_connection_id bigint,group_jid text,group_name text,is_active boolean,opted_out boolean,public_market_source boolean,network_owned boolean,updated_at timestamptz,connected_at timestamptz,unique(organization_id,whatsapp_connection_id,group_jid));
   create table external_agent_api_keys(id uuid primary key,tenant_id uuid,scopes text[],revoked_at timestamptz);
   create table raw_messages(id bigint primary key,tenant_id uuid,message text,timestamp timestamptz,sender_phone text,sender_jid text,is_group boolean,source text,pipeline_version text,raw_payload jsonb,event_id text,message_uid text,synced_at timestamptz);
   create table whatsapp_conversations(tenant_id uuid,broker_id text,conversation_type text,conversation_jid text,display_name text,message_count integer,last_message_at timestamptz);
   create table broker_whatsapp_devices(whatsapp_connection_key text primary key,device_jid text);
   create table public_market_publication_allowlist(tenant_id uuid primary key,whatsapp_connection_id bigint,enabled boolean,updated_at timestamptz);
   create table public_market_publication_denylist(raw_message_id bigint primary key);
  ''')
  for t in TABLES:q.execute(sql.SQL('create table {}(id bigserial primary key,tenant_id uuid,raw_message_id bigint,visibility text,source_scope text);create index on {}(tenant_id,raw_message_id)').format(sql.Identifier(t),sql.Identifier(t)))
  q.execute(Path('supabase/migrations/20261119090000_broker_property_cross_search.sql').read_text())
  q.execute(Path('supabase/migrations/20261120100000_independent_raw_group_sharing.sql').read_text())
  q.execute(Path('supabase/migrations/20261123150000_optional_source_contact_disclosure.sql').read_text())
  q.execute(Path('supabase/migrations/20261124100000_atomic_group_confirmation.sql').read_text())
  q.execute(Path('supabase/migrations/20261125160000_selection_receipt_semantic_invalidation.sql').read_text())
 yield c
 c.close()
 with admin.cursor() as q:q.execute(sql.SQL('drop database {} with(force)').format(sql.Identifier(name)))
 admin.close()
@pytest.fixture
def seed(db):
 a,b,u=[str(uuid.uuid4()) for _ in range(3)]
 with db.cursor() as q:
  q.execute('truncate whatsapp_group_selection_requests,whatsapp_group_selection_receipts,broker_market_raw_source_consents,broker_market_source_consents,organization_group_connections,org_whatsapp_connections,public_market_publication_allowlist,public_market_publication_denylist,raw_messages,whatsapp_conversations,broker_whatsapp_devices,auth.users,organizations cascade')
  for t in TABLES:q.execute(sql.SQL('truncate {}').format(sql.Identifier(t)))
  q.execute('insert into organizations values(%s),(%s);insert into auth.users values(%s)',(a,b,u))
  q.execute("insert into org_whatsapp_connections(id,organization_id,broker_id,is_active) values(1,%s,'phone-a',true),(2,%s,'phone-b',true)",(a,b))
  q.execute("insert into whatsapp_conversations select %s,'phone-a','group',i::text||'@g.us','Same name',0,null from generate_series(1,140)i",(a,))
 return db,a,b,u

def confirm(seed,groups=None,request=None):
 c,a,b,u=seed
 with c.cursor() as q:
  q.execute('select confirm_whatsapp_group_selection(%s,1,%s,%s,%s,%s)',(a,groups if groups is not None else ['1@g.us'],u,request or str(uuid.uuid4()),'phone-a'))
  return q.fetchone()[0]
def state(seed):
 c,a,*_=seed
 with c.cursor() as q:q.execute('select whatsapp_group_selection_state(%s,1)',(a,));return q.fetchone()[0]
def raw(seed,n=1,broker='phone-a',jid='1@g.us',tenant=None,is_group=True):
 c,a,b,u=seed
 with c.cursor() as q:
  q.execute("insert into raw_messages(id,tenant_id,is_group,source,pipeline_version,raw_payload,event_id,message_uid) values(%s,%s,%s,'WHATSAPP','go-ingestor',%s,%s,%s)",(n,tenant or a,is_group,json.dumps({'data':{'broker_id':broker,'key':{'remoteJid':jid}}}),broker+':m'+str(n),broker+':'+jid+':m'+str(n)))
  for t in TABLES:q.execute(sql.SQL("insert into {}(tenant_id,raw_message_id,visibility,source_scope) values(%s,%s,'workspace_private','whatsapp_private')").format(sql.Identifier(t)),(tenant or a,n))
@pytest.mark.parametrize('n',[0,1,140])
def test_exact_confirmation_and_duplicate(seed,n):
 c,a,b,u=seed;r=str(uuid.uuid4());groups=[str(i)+'@g.us' for i in range(1,n+1)]
 assert state(seed)['complete'] is False
 result=confirm(seed,groups,r);assert result['complete'] and result['selected_group_jids']==sorted(groups)
 assert confirm(seed,groups,r)==result
 with c.cursor() as q:
  q.execute('select extraction_status from org_whatsapp_connections where id=1');assert q.fetchone()[0]=='stopped'
  q.execute('select count(*) from broker_market_raw_source_consents');assert q.fetchone()[0]==0

def test_all_tables_exact_provenance_and_allowlist(seed):
 c,a,b,u=seed
 for args in [(1,'phone-a','1@g.us',a,True),(2,'phone-b','1@g.us',a,True),(3,'phone-a','1@g.us',b,True),(4,'phone-a','1@g.us',a,False),(5,'phone-a','2@g.us',a,True)]:raw(seed,*args)
 confirm(seed)
 with c.cursor() as q:
  for t in TABLES:q.execute(sql.SQL("select count(*) from {} where visibility='shared_market'").format(sql.Identifier(t)));assert q.fetchone()[0]==0
  q.execute('insert into public_market_publication_allowlist values(%s,1,true)',(a,))
 assert not state(seed)['complete']
 confirm(seed)
 with c.cursor() as q:
  for t in TABLES:q.execute(sql.SQL("select raw_message_id from {} where visibility='shared_market'").format(sql.Identifier(t)));assert q.fetchall()==[(1,)]
 confirm(seed,[])
 with c.cursor() as q:
  for t in TABLES:q.execute(sql.SQL("select count(*) from {} where visibility='shared_market'").format(sql.Identifier(t)));assert q.fetchone()[0]==0

def test_denylist_and_malformed_uid_fail_closed(seed):
 c,a,b,u=seed;raw(seed,1);raw(seed,2);raw(seed,3)
 with c.cursor() as q:
  q.execute('insert into public_market_publication_allowlist values(%s,1,true)',(a,));q.execute('insert into public_market_publication_denylist values(1)');q.execute("update raw_messages set message_uid='phone-a:1@g.us:m2:extra' where id=2");q.execute("update raw_messages set raw_payload=jsonb_set(raw_payload,'{data,broker_id}','\"phone-b\"') where id=3")
 confirm(seed)
 with c.cursor() as q:
  for t in TABLES:q.execute(sql.SQL("select count(*) from {} where visibility='shared_market'").format(sql.Identifier(t)));assert q.fetchone()[0]==0

def test_rollback_after_choice_before_completion(seed):
 c,a,b,u=seed;raw(seed)
 with c.cursor() as q:q.execute("create function fail_confirmation() returns trigger language plpgsql as $$begin raise exception 'injected';end$$;create trigger inject before update on residential_sale_listings for each row execute function fail_confirmation();insert into public_market_publication_allowlist values(%s,1,true)",(a,))
 try:
  with pytest.raises(psycopg2.Error):confirm(seed)
  with c.cursor() as q:
   q.execute('select count(*) from organization_group_connections');assert q.fetchone()[0]==0
   q.execute('select count(*) from whatsapp_group_selection_receipts');assert q.fetchone()[0]==0
 finally:
  with c.cursor() as q:q.execute('drop trigger inject on residential_sale_listings;drop function fail_confirmation()')

@pytest.mark.parametrize('change',[
 "update organization_group_connections set opted_out=true where whatsapp_connection_id=1",
 "update org_whatsapp_connections set is_active=false where id=1",
 "update org_whatsapp_connections set broker_id='phone-new' where id=1",
 "insert into broker_whatsapp_devices values('phone-a','device')",
])
def test_stale_receipts_and_response_loss_recovery(seed,change):
 c,a,b,u=seed;r=str(uuid.uuid4());confirm(seed,request=r);assert state(seed)['request_id']==r
 with c.cursor() as q:q.execute(change)
 assert not state(seed)['complete']
 with pytest.raises(psycopg2.Error):confirm(seed,request=r)

def test_old_request_cannot_replay_after_new_selection(seed):
 r=str(uuid.uuid4());confirm(seed,['1@g.us'],r);confirm(seed,['2@g.us'])
 with pytest.raises(psycopg2.Error):confirm(seed,['1@g.us'],r)
 assert state(seed)['selected_group_jids']==['2@g.us']

def test_retained_raw_consent_survives_real_optout_revokes(seed):
 c,a,b,u=seed;confirm(seed,['1@g.us','2@g.us'])
 with c.cursor() as q:q.execute("select broker_market_set_raw_sources(%s,1,ARRAY['1@g.us','2@g.us'],%s,'broker-property-cross-search-v2',true)",(a,u))
 confirm(seed,['1@g.us'])
 with c.cursor() as q:
  q.execute('select group_jid,revoked_at is null from broker_market_raw_source_consents order by group_jid');assert q.fetchall()==[('1@g.us',True),('2@g.us',False)]
 confirm(seed,['1@g.us','2@g.us'])
 with c.cursor() as q:q.execute("select revoked_at is not null from broker_market_raw_source_consents where group_jid='2@g.us'");assert q.fetchone()[0]

def test_actual_rest_adapter_executes_rpc_and_returns_receipt(seed):
 c,a,b,u=seed
 def server(request):
  assert request.url.path=='/rest/v1/rpc/confirm_whatsapp_group_selection'
  params=json.loads(request.content)
  with c.cursor() as q:q.execute('select confirm_whatsapp_group_selection('+','.join(k+' => %s' for k in params)+')',tuple(params.values()));result=q.fetchone()[0]
  return httpx.Response(200,json=result)
 client=_RestClient('https://local.invalid','test-key');client._http=httpx.Client(transport=httpx.MockTransport(server))
 result=client.rpc('confirm_whatsapp_group_selection',{'p_tenant':a,'p_connection':1,'p_groups':['1@g.us'],'p_actor':u,'p_request':str(uuid.uuid4()),'p_broker':'phone-a'})
 assert result['complete'] and result['selected_group_jids']==['1@g.us']

def test_concurrent_optout_cannot_leave_valid_receipt(seed):
 c,a,b,u=seed;confirm(seed)
 other=psycopg2.connect(c.dsn);other.autocommit=True
 try:
  with c.cursor() as q:q.execute('begin');q.execute('select 1 from org_whatsapp_connections where id=1 for update')
  done=[]
  def optout():
   try:
    with other.cursor() as q:q.execute('update organization_group_connections set opted_out=true where whatsapp_connection_id=1')
    done.append('ok')
   except Exception as e:done.append(type(e).__name__)
  t=threading.Thread(target=optout);t.start();time.sleep(.03)
  with c.cursor() as q:q.execute('commit')
  t.join(3);assert done==['ok'];assert not state(seed)['complete']
 finally:other.close()

def test_realistic_140_groups_all_tables_volume(seed):
 c,a,b,u=seed
 with c.cursor() as q:
  q.execute('insert into public_market_publication_allowlist values(%s,1,true)',(a,))
  q.execute("insert into raw_messages(id,tenant_id,is_group,source,pipeline_version,raw_payload,event_id,message_uid) select i,%s,true,'WHATSAPP','go-ingestor',jsonb_build_object('data',jsonb_build_object('broker_id','phone-a','key',jsonb_build_object('remoteJid',((i%%140)+1)::text||'@g.us'))),'phone-a:m'||i,'phone-a:'||((i%%140)+1)::text||'@g.us:m'||i from generate_series(1,140000)i",(a,))
  for table in TABLES:q.execute(sql.SQL("insert into {}(tenant_id,raw_message_id,visibility,source_scope) select %s,i,'workspace_private','whatsapp_private' from generate_series(1,140000,10)i").format(sql.Identifier(table)),(a,))
 start=time.monotonic();r=confirm(seed,[str(i)+'@g.us' for i in range(1,141)]);elapsed=time.monotonic()-start
 assert r['complete']
 with c.cursor() as q:
  q.execute('select visibility_rows from whatsapp_group_selection_receipts');assert q.fetchone()[0]==112000
  for table in TABLES:q.execute(sql.SQL("select count(*) from {} where visibility='shared_market'").format(sql.Identifier(table)));assert q.fetchone()[0]==14000
 print('full eight-table transaction seconds:',round(elapsed,3));assert elapsed<10

def test_start_requires_current_receipt_but_never_auto_starts(seed):
 c,a,b,u=seed
 with c.cursor() as q:
  with pytest.raises(psycopg2.Error):q.execute('select start_confirmed_whatsapp_extraction(%s,1)',(a,))
 confirm(seed)
 with c.cursor() as q:
  q.execute('select extraction_status from org_whatsapp_connections where id=1');assert q.fetchone()[0]=='stopped'
  q.execute('select start_confirmed_whatsapp_extraction(%s,1)',(a,));q.execute('select extraction_status from org_whatsapp_connections where id=1');assert q.fetchone()[0]=='running'
  q.execute("update org_whatsapp_connections set extraction_status='stopped' where id=1");q.execute('update organization_group_connections set opted_out=true')
  with pytest.raises(psycopg2.Error):q.execute('select start_confirmed_whatsapp_extraction(%s,1)',(a,))

def test_installation_does_not_complete_legacy_choices(seed):
 c,a,b,u=seed
 with c.cursor() as q:
  q.execute("insert into organization_group_connections(organization_id,whatsapp_connection_id,group_jid,is_active,opted_out,public_market_source) values(%s,1,'1@g.us',true,false,true)",(a,))
 assert not state(seed)['complete']
 with c.cursor() as q:q.execute('select count(*) from whatsapp_group_selection_receipts');assert q.fetchone()[0]==0
