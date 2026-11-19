"""Real PostgreSQL policy tests. Local disposable database only, never production."""
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
import uuid
import psycopg2
import pytest
from broker_market_policy import PROPERTY_PATTERN


@pytest.fixture(scope='module')
def db():
    admin=psycopg2.connect(host='/tmp',dbname='postgres',user='postgres');admin.autocommit=True
    name='market_test_'+uuid.uuid4().hex[:10]
    with admin.cursor() as q:q.execute('create database '+name)
    c=psycopg2.connect(host='/tmp',dbname=name,user='postgres');c.autocommit=True
    with c.cursor() as q:
        for role in ('anon','authenticated','service_role'):
            q.execute('select 1 from pg_roles where rolname=%s',(role,))
            if not q.fetchone():q.execute('create role '+role)
        q.execute('''create schema auth;create table auth.users(id uuid primary key);
        create table organizations(id uuid primary key);
        create table org_whatsapp_connections(id bigint primary key,organization_id uuid,broker_id text,is_active boolean);
        create table organization_group_connections(id bigint primary key,organization_id uuid,whatsapp_connection_id bigint,group_jid text,group_name text,is_active boolean,opted_out boolean,public_market_source boolean,updated_at timestamptz);
        create table external_agent_api_keys(id uuid primary key,tenant_id uuid,scopes text[],revoked_at timestamptz);
        create table raw_messages(id bigint primary key,tenant_id uuid,message text,timestamp timestamptz,sender_phone text,sender_jid text,is_group boolean,source text,pipeline_version text,raw_payload jsonb,event_id text,message_uid text,synced_at timestamptz);
        ''')
        q.execute(Path('supabase/migrations/20261119090000_broker_property_cross_search.sql').read_text())
    yield c
    c.close()
    with admin.cursor() as q:q.execute('drop database '+name+' with (force)')
    admin.close()


@pytest.fixture
def seeded(db):
    now=datetime.now(timezone.utc); consent=now-timedelta(minutes=10)
    a,b,u=[str(uuid.uuid4()) for _ in range(3)]
    with db.cursor() as q:
        q.execute('truncate raw_messages,broker_market_source_consents,organization_group_connections,org_whatsapp_connections,organizations,auth.users cascade')
        q.execute('insert into auth.users values(%s)',(u,))
        q.execute('insert into organizations values(%s),(%s)',(a,b))
        q.execute("insert into org_whatsapp_connections values(1,%s,'phone-a',true),(2,%s,'phone-b',true)",(a,b))
        q.execute("insert into organization_group_connections values(11,%s,1,'123@g.us','Same group',true,false,true,%s),(22,%s,2,'456@g.us','Same group',true,false,true,%s)",(a,consent,b,consent))
        q.execute("insert into broker_market_source_consents values(11,'broker-property-cross-search-v1',%s,%s,%s,null)",(u,consent,consent))
        for i,org,broker,jid in [(1,a,'phone-a','123@g.us'),(2,b,'phone-b','456@g.us'),(3,a,'phone-a','999@g.us')]:
            q.execute("insert into raw_messages values(%s,%s,'Lodha 3 bhk for sale call 9820056180',%s,'9820056180','',true,'WHATSAPP','go-ingestor',%s,%s,%s,%s)",(i,org,now,json.dumps({'data':{'key':{'remoteJid':jid}}}),broker+':m'+str(i),broker+':'+jid+':m'+str(i),now))
    return db,now


def ids(db):
    with db.cursor() as q:
        q.execute('select raw_id from broker_market_search(%s,%s,now()-interval \'1 day\',now()+interval \'1 minute\',21,null,null)',(json.dumps([['lodha']]),PROPERTY_PATTERN))
        return [r[0] for r in q.fetchall()]


def test_actual_cross_org_positive_exact_identity_before_limit(seeded):
    db,_=seeded
    assert ids(db)==[1]  # caller-independent source consent, not same-name group2
    with db.cursor() as q:
        q.execute('select * from broker_market_get(2)');assert not q.fetchall()
        q.execute('select * from broker_market_get(3)');assert not q.fetchall()

@pytest.mark.parametrize('mutation',[
 "update organization_group_connections set opted_out=true where id=11",
 "update organization_group_connections set is_active=false where id=11",
 "update organization_group_connections set public_market_source=false where id=11",
 "delete from broker_market_source_consents",
 "update broker_market_source_consents set revoked_at=now()",
 "update org_whatsapp_connections set is_active=false where id=1",
 "update raw_messages set message_uid='phone-b:123@g.us:m1' where id=1",
 "update raw_messages set event_id='phone-b:m1' where id=1",
 "update raw_messages set raw_payload='{\"data\":{\"key\":{\"remoteJid\":\"456@g.us\"}}}' where id=1",
 "update raw_messages set is_group=false where id=1",
 "update raw_messages set timestamp=now()-interval '1 day' where id=1",
 "update raw_messages set pipeline_version='history-sync-suppressed' where id=1",
])
def test_immediate_revoke_and_bad_source_denied(seeded,mutation):
    db,_=seeded
    assert ids(db)==[1]
    with db.cursor() as q:q.execute(mutation)
    assert ids(db)==[]
    with db.cursor() as q:q.execute('select * from broker_market_get(1)');assert not q.fetchall()


def test_no_general_browsing_and_private_discussion_not_misrepresented(seeded):
    db,_=seeded
    with db.cursor() as q:
        q.execute("update raw_messages set message='Lodha personal argument' where id=1")
    assert ids(db)==[]
    with db.cursor() as q:q.execute("update raw_messages set message='Lodha 3 bhk for sale. personal argument' where id=1")
    assert ids(db)==[1] # deliberate documented limitation, not false privacy classifier


def test_rate_limit_is_cross_connection_and_bounded(seeded):
    db,_=seeded
    with db.cursor() as q:
        q.execute('truncate broker_market_rate_windows')
        for i in range(11):
            q.execute("select broker_market_take_rate('reader','contact')")
            assert q.fetchone()[0] is (i<10)


def test_anon_authenticated_cannot_call_internal_functions(seeded):
    db,_=seeded
    for role in ('anon','authenticated'):
        with db.cursor() as q:
            q.execute('set role '+role)
            with pytest.raises(psycopg2.errors.InsufficientPrivilege):q.execute('select * from broker_market_eligible_rows()')
            q.execute('reset role')


def test_atomic_reader_scope_does_not_touch_other_scopes_or_revoked_keys(seeded):
    db,_=seeded
    tenant,key,other=[str(uuid.uuid4()) for _ in range(3)]
    with db.cursor() as q:
        q.execute("insert into external_agent_api_keys values(%s,%s,array['raw_messages:read'],null)",(key,tenant))
        q.execute("select * from broker_market_set_key_access(%s,%s,true)",(other,key));assert not q.fetchall()
        q.execute("select scopes from broker_market_set_key_access(%s,%s,true)",(tenant,key));assert set(q.fetchone()[0])=={'raw_messages:read','broker_market:read'}
        q.execute("select scopes from broker_market_set_key_access(%s,%s,false)",(tenant,key));assert q.fetchone()[0]==['raw_messages:read']
        q.execute("update external_agent_api_keys set revoked_at=now() where id=%s",(key,))
        q.execute("select * from broker_market_set_key_access(%s,%s,true)",(tenant,key));assert not q.fetchall()


def test_cosmetic_refresh_preserves_consent_but_unselect_reselect_does_not(seeded):
    db,_=seeded
    with db.cursor() as q:q.execute("update organization_group_connections set updated_at=now(),group_name='Renamed group' where id=11")
    assert ids(db)==[1]
    with db.cursor() as q:
        q.execute('update organization_group_connections set is_active=false where id=11')
        q.execute('update organization_group_connections set is_active=true where id=11')
    assert ids(db)==[]


def test_supporting_indexes_present_and_usable(seeded):
    db,_=seeded
    with db.cursor() as q:
        q.execute("select indexname from pg_indexes where tablename='raw_messages'")
        names={r[0] for r in q.fetchall()}
        assert {'broker_market_source_time_idx','broker_market_text_fts_idx'} <= names
        q.execute("insert into raw_messages(id,tenant_id,message,timestamp,is_group,source,pipeline_version) select 1000+n,gen_random_uuid(),'Andheri office rental',now(),true,'WHATSAPP','go-ingestor' from generate_series(1,10000)n")
        q.execute('analyze raw_messages')
        q.execute('set enable_seqscan=off')
        q.execute("explain select id from raw_messages where is_group is true and source='WHATSAPP' and pipeline_version='go-ingestor' and to_tsvector('english',message) @@ websearch_to_tsquery('english','Lodha')")
        assert 'broker_market_text_fts_idx' in '\n'.join(r[0] for r in q.fetchall())
        q.execute('reset enable_seqscan')
