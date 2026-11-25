"""Disposable-Postgres coverage for semantic receipt invalidation.

Migration 20261125160000 narrows the atomic-confirmation receipt so it is
invalidated only by semantic selection changes, not by background
bookkeeping. These tests pin the exact production complaint: a completed
receipt was silently invalidated by updated_at churn on selection rows,
re-greying Start with no user action. They also pin adjacent behavior that
must keep holding (Start/Pause/Stop status flips, connection identity
changes, row insert/delete, re-confirm recovery).
"""
import uuid
from pathlib import Path

import psycopg2
import pytest
from psycopg2 import sql

TABLES = [a + '_' + b + '_' + d for a in ('residential', 'commercial') for b in ('sale', 'rent') for d in ('listings', 'requirements')]


def _visibility_functions():
    text = Path('supabase/migrations/20261112120000_group_public_market_boundary.sql').read_text()
    bodies = []
    for name in ('raw_message_has_public_group_source', 'sync_group_market_visibility'):
        marker = 'create or replace function public.' + name
        start = text.index(marker)
        end = text.index('$fn$;', start) + len('$fn$;')
        bodies.append(text[start:end])
    return bodies


@pytest.fixture(scope='module')
def db():
    admin = psycopg2.connect(host='/dev/shm/propai-atomic-confirmation-prep/socket', port=55441, dbname='postgres', user='postgres')
    admin.autocommit = True
    name = 'receipt_sem_' + uuid.uuid4().hex[:10]
    with admin.cursor() as q:
        q.execute(sql.SQL('create database {}').format(sql.Identifier(name)))
    c = psycopg2.connect(host='/dev/shm/propai-atomic-confirmation-prep/socket', port=55441, dbname=name, user='postgres')
    c.autocommit = True
    with c.cursor() as q:
        for role in ('anon', 'authenticated', 'service_role'):
            q.execute('select 1 from pg_roles where rolname=%s', (role,))
            if not q.fetchone():
                q.execute(sql.SQL('create role {}').format(sql.Identifier(role)))
        q.execute('''create schema auth;create table auth.users(id uuid primary key);create table organizations(id uuid primary key);
         create table org_whatsapp_connections(id bigint primary key,organization_id uuid,broker_id text,is_active boolean,phone_number text default '12025550123',extraction_status text default 'stopped',group_audit_required boolean default true,group_audit_completed_at timestamptz,updated_at timestamptz);
         create table organization_group_connections(id bigserial primary key,organization_id uuid,whatsapp_connection_id bigint,group_jid text,group_name text,is_active boolean,opted_out boolean,public_market_source boolean,network_owned boolean,updated_at timestamptz,connected_at timestamptz,unique(organization_id,whatsapp_connection_id,group_jid));
         create table external_agent_api_keys(id uuid primary key,tenant_id uuid,scopes text[],revoked_at timestamptz);
         create table raw_messages(id bigint primary key,tenant_id uuid,group_name text,message text,timestamp timestamptz,sender_phone text,sender_jid text,is_group boolean,source text,pipeline_version text,raw_payload jsonb,event_id text,message_uid text,synced_at timestamptz);
         create table whatsapp_conversations(tenant_id uuid,broker_id text,conversation_type text,conversation_jid text,display_name text,message_count integer,last_message_at timestamptz);
         create table broker_whatsapp_devices(whatsapp_connection_key text primary key,device_jid text);
         create table public_market_publication_allowlist(tenant_id uuid primary key,whatsapp_connection_id bigint,enabled boolean,updated_at timestamptz);
         create table public_market_publication_denylist(raw_message_id bigint primary key);
        ''')
        for tb in TABLES:
            q.execute(sql.SQL('create table {}(id bigserial primary key,tenant_id uuid,raw_message_id bigint,visibility text,source_scope text);create index on {}(tenant_id,raw_message_id)').format(sql.Identifier(tb), sql.Identifier(tb)))
        q.execute(Path('supabase/migrations/20261119090000_broker_property_cross_search.sql').read_text())
        q.execute(Path('supabase/migrations/20261120100000_independent_raw_group_sharing.sql').read_text())
        q.execute(Path('supabase/migrations/20261123150000_optional_source_contact_disclosure.sql').read_text())
        q.execute(Path('supabase/migrations/20261124100000_atomic_group_confirmation.sql').read_text())
        q.execute(Path('supabase/migrations/20261125160000_selection_receipt_semantic_invalidation.sql').read_text())
        for body in _visibility_functions():
            q.execute(body)
    yield c
    c.close()
    with admin.cursor() as q:
        q.execute(sql.SQL('drop database {} with(force)').format(sql.Identifier(name)))
    admin.close()


@pytest.fixture
def seed(db):
    a, u = str(uuid.uuid4()), str(uuid.uuid4())
    with db.cursor() as q:
        q.execute('truncate whatsapp_group_selection_requests,whatsapp_group_selection_receipts,organization_group_connections,org_whatsapp_connections,whatsapp_conversations,broker_whatsapp_devices,public_market_publication_allowlist,public_market_publication_denylist,raw_messages,auth.users,organizations cascade')
        for tb in TABLES:
            q.execute(sql.SQL('truncate {}').format(sql.Identifier(tb)))
        q.execute('insert into organizations values(%s);insert into auth.users values(%s)', (a, u))
        q.execute("insert into org_whatsapp_connections(id,organization_id,broker_id,is_active) values(1,%s,'phone-a',true)", (a,))
        for i in (1, 2, 3):
            q.execute("insert into whatsapp_conversations values(%s,'phone-a','group',%s,%s,0,null)", (a, '%d@g.us' % i, 'Grp%d' % i))
    return db, a, u


def confirm(seed, groups=('1@g.us', '2@g.us', '3@g.us')):
    c, a, u = seed
    with c.cursor() as q:
        q.execute('select confirm_whatsapp_group_selection(%s,%s,%s,%s,%s,%s)', (a, 1, list(groups), u, str(uuid.uuid4()), 'phone-a'))
        return q.fetchone()[0]


def state(seed):
    c, a, _ = seed
    with c.cursor() as q:
        q.execute('select whatsapp_group_selection_state(%s,%s)', (a, 1))
        return q.fetchone()[0]


def test_confirm_completes_receipt(seed):
    assert confirm(seed)['complete'] is True
    assert state(seed)['complete'] is True


def test_updated_at_only_touch_keeps_receipt(seed):
    """The production bug: background writes bumped updated_at and the receipt
    silently invalidated, re-greying Start with no user action."""
    confirm(seed)
    c, a, _ = seed
    with c.cursor() as q:
        q.execute('update organization_group_connections set updated_at=now() where organization_id=%s and whatsapp_connection_id=1', (a,))
    assert state(seed)['complete'] is True


def test_group_name_refresh_keeps_receipt(seed):
    confirm(seed)
    c, a, _ = seed
    with c.cursor() as q:
        q.execute("update organization_group_connections set group_name='Renamed group',updated_at=now() where organization_id=%s and whatsapp_connection_id=1 and group_jid='1@g.us'", (a,))
    assert state(seed)['complete'] is True


def test_semantic_selection_change_invalidates(seed):
    confirm(seed)
    c, a, _ = seed
    with c.cursor() as q:
        q.execute("update organization_group_connections set opted_out=true,updated_at=now() where organization_id=%s and whatsapp_connection_id=1 and group_jid='2@g.us'", (a,))
    assert state(seed)['complete'] is False


def test_public_market_source_change_invalidates(seed):
    confirm(seed)
    c, a, _ = seed
    with c.cursor() as q:
        q.execute("update organization_group_connections set public_market_source=false,updated_at=now() where organization_id=%s and whatsapp_connection_id=1 and group_jid='2@g.us'", (a,))
    assert state(seed)['complete'] is False


def test_row_insert_or_delete_invalidates(seed):
    confirm(seed)
    c, a, _ = seed
    with c.cursor() as q:
        q.execute("insert into organization_group_connections(organization_id,whatsapp_connection_id,group_jid,is_active,opted_out,public_market_source) values(%s,1,'9@g.us',true,false,false)", (a,))
    assert state(seed)['complete'] is False
    confirm(seed)
    with c.cursor() as q:
        q.execute("delete from organization_group_connections where organization_id=%s and whatsapp_connection_id=1 and group_jid='9@g.us'", (a,))
    assert state(seed)['complete'] is False


def test_start_then_status_changes_keep_receipt(seed):
    """A successful Start flips extraction_status stopped -> running; the
    receipt that authorized it must stay valid (pause/restart must not demand
    a fresh confirmation). The original fingerprint/trigger already excluded
    extraction_status; this pins that behavior against regressions."""
    confirm(seed)
    c, a, _ = seed
    with c.cursor() as q:
        q.execute('select start_confirmed_whatsapp_extraction(%s,1)', (a,))
        q.execute('select extraction_status from org_whatsapp_connections where id=1')
        assert q.fetchone()[0] == 'running'
    assert state(seed)['complete'] is True
    with c.cursor() as q:
        q.execute("update org_whatsapp_connections set extraction_status='paused' where id=1")
    assert state(seed)['complete'] is True
    with c.cursor() as q:
        q.execute("update org_whatsapp_connections set extraction_status='stopped' where id=1")
    assert state(seed)['complete'] is True
    with c.cursor() as q:
        q.execute('select start_confirmed_whatsapp_extraction(%s,1)', (a,))  # restart without re-confirm


def test_connection_identity_change_still_invalidates(seed):
    confirm(seed)
    c, a, _ = seed
    with c.cursor() as q:
        q.execute("update org_whatsapp_connections set phone_number='12025559999' where id=1")
    assert state(seed)['complete'] is False


def test_reconfirm_after_invalidation_restores(seed):
    confirm(seed)
    c, a, _ = seed
    with c.cursor() as q:
        q.execute("update organization_group_connections set opted_out=true,updated_at=now() where organization_id=%s and whatsapp_connection_id=1 and group_jid='2@g.us'", (a,))
    assert state(seed)['complete'] is False
    result = confirm(seed, groups=('1@g.us', '3@g.us'))
    assert result['complete'] is True
    assert state(seed)['complete'] is True
