"""Disposable-Postgres coverage for the single-group deselect write path.

The endpoint itself is covered at request level by test_group_deselect.py;
these tests prove the database semantics of the exact statements the endpoint
issues (ogc UPDATE clearing public_market_source AND is_active +
sync_group_market_visibility FALSE) against the real migration functions:
other selections preserved, org/connection isolation, idempotence, receipt
invalidation, concurrent double-deselect, and un-publish scoped to the
deselected group only. is_active=False removes the group from the extraction
selection (cap count, UI checkbox state and extraction eligibility all read
is_active) without marking a privacy opt-out.
"""
import json, re, threading, uuid
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
    name = 'deselect_' + uuid.uuid4().hex[:10]
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
        for t in TABLES:
            q.execute(sql.SQL('create table {}(id bigserial primary key,tenant_id uuid,raw_message_id bigint,visibility text,source_scope text);create index on {}(tenant_id,raw_message_id)').format(sql.Identifier(t), sql.Identifier(t)))
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
    a, b, u = [str(uuid.uuid4()) for _ in range(3)]
    with db.cursor() as q:
        q.execute('truncate whatsapp_group_selection_requests,whatsapp_group_selection_receipts,broker_market_raw_source_consents,broker_market_source_consents,organization_group_connections,org_whatsapp_connections,public_market_publication_allowlist,public_market_publication_denylist,raw_messages,whatsapp_conversations,broker_whatsapp_devices,auth.users,organizations cascade')
        for t in TABLES:
            q.execute(sql.SQL('truncate {}').format(sql.Identifier(t)))
        q.execute('insert into organizations values(%s),(%s);insert into auth.users values(%s)', (a, b, u))
        q.execute("insert into org_whatsapp_connections(id,organization_id,broker_id,is_active) values(1,%s,'phone-a',true),(2,%s,'phone-b',true)", (a, b))
        for i in (1, 2, 3):
            q.execute("insert into whatsapp_conversations values(%s,'phone-a','group',%s,%s,0,null)", (a, '%d@g.us' % i, 'Grp%d' % i))
        q.execute("insert into whatsapp_conversations values(%s,'phone-b','group','1@g.us','Grp1',0,null)", (b,))
    return db, a, b, u


def confirm(seed, conn, org, groups, broker):
    c = seed[0]
    u = seed[3]
    with c.cursor() as q:
        q.execute('select confirm_whatsapp_group_selection(%s,%s,%s,%s,%s,%s)', (org, conn, groups, u, str(uuid.uuid4()), broker))
        return q.fetchone()[0]


def state(seed, conn, org):
    c = seed[0]
    with c.cursor() as q:
        q.execute('select whatsapp_group_selection_state(%s,%s)', (org, conn))
        return q.fetchone()[0]


def deselect_sql(cur, org, conn, jid):
    """The exact statements routers/whatsapp_group_controls.py:deselect_group issues."""
    cur.execute('update organization_group_connections set public_market_source=false,is_active=false,updated_at=now() where organization_id=%s and whatsapp_connection_id=%s and group_jid=%s', (org, conn, jid))
    updated = cur.rowcount
    cur.execute('select group_name from organization_group_connections where organization_id=%s and whatsapp_connection_id=%s and group_jid=%s', (org, conn, jid))
    row = cur.fetchone()
    cur.execute('select sync_group_market_visibility(%s,%s,%s,%s)', (org, jid, (row[0] if row else None) or jid, False))
    return updated


def raw(seed, n, org, broker, jid, group_name):
    c = seed[0]
    with c.cursor() as q:
        q.execute("insert into raw_messages(id,tenant_id,group_name,is_group,source,pipeline_version,raw_payload,event_id,message_uid) values(%s,%s,%s,true,'WHATSAPP','go-ingestor',%s,%s,%s)",
                  (n, org, group_name, json.dumps({'data': {'broker_id': broker, 'key': {'remoteJid': jid}}}), broker + ':m' + str(n), broker + ':' + jid + ':m' + str(n)))
        for t in TABLES:
            q.execute(sql.SQL("insert into {}(tenant_id,raw_message_id,visibility,source_scope) values(%s,%s,'workspace_private','whatsapp_private')").format(sql.Identifier(t)), (org, n))


def visibility_counts(seed, org):
    c = seed[0]
    out = {}
    with c.cursor() as q:
        for t in TABLES:
            q.execute(sql.SQL("select visibility,count(*) from {} where tenant_id=%s group by visibility order by 1").format(sql.Identifier(t)), (org,))
            out[t] = dict(q.fetchall())
    return out


def test_deselect_preserves_other_selections_and_invalidates_receipt(seed):
    c, a, b, u = seed
    result = confirm(seed, 1, a, ['1@g.us', '2@g.us', '3@g.us'], 'phone-a')
    assert result['complete'] is True
    with c.cursor() as q:
        q.execute("select public_market_source,is_active,opted_out,updated_at from organization_group_connections where organization_id=%s and whatsapp_connection_id=1 order by group_jid", (a,))
        before = q.fetchall()
        assert all(r[0] is True and r[1] is True and r[2] is False for r in before)
        q.execute('select start_confirmed_whatsapp_extraction(%s,1)', (a,))  # receipt valid: start allowed
    with c.cursor() as q:
        assert deselect_sql(q, a, 1, '2@g.us') == 1
        q.execute("select public_market_source,is_active,opted_out from organization_group_connections where organization_id=%s and whatsapp_connection_id=1 and group_jid='2@g.us'", (a,))
        assert q.fetchone() == (False, False, False)  # removed from the selection: no longer active, not a privacy opt-out
        q.execute("select public_market_source,is_active,opted_out,updated_at from organization_group_connections where organization_id=%s and whatsapp_connection_id=1 and group_jid in ('1@g.us','3@g.us') order by group_jid", (a,))
        after = q.fetchall()
        assert after == [before[0], before[2]]  # other rows byte-identical, even updated_at
    assert state(seed, 1, a)['complete'] is False  # receipt invalidated by trigger
    with c.cursor() as q:
        with pytest.raises(Exception):
            q.execute('select start_confirmed_whatsapp_extraction(%s,1)', (a,))  # Start blocked until re-confirm


def test_deselect_isolated_across_orgs_and_connections(seed):
    c, a, b, u = seed
    confirm(seed, 1, a, ['1@g.us'], 'phone-a')
    confirm(seed, 2, b, ['1@g.us'], 'phone-b')
    with c.cursor() as q:
        assert deselect_sql(q, a, 1, '1@g.us') == 1
        q.execute("select public_market_source,is_active,opted_out from organization_group_connections where organization_id=%s and whatsapp_connection_id=2 and group_jid='1@g.us'", (b,))
        assert q.fetchone() == (True, True, False)  # other org untouched
    assert state(seed, 1, a)['complete'] is False
    assert state(seed, 2, b)['complete'] is True  # other org's receipt intact


def test_deselect_unpublishes_only_that_group(seed):
    c, a, b, u = seed
    raw(seed, 11, a, 'phone-a', '1@g.us', 'Grp1')
    raw(seed, 12, a, 'phone-a', '2@g.us', 'Grp2')
    with c.cursor() as q:
        q.execute('insert into public_market_publication_allowlist values(%s,1,true)', (a,))
    confirm(seed, 1, a, ['1@g.us', '2@g.us'], 'phone-a')
    counts = visibility_counts(seed, a)
    assert all(v.get('shared_market') == 2 for v in counts.values())
    with c.cursor() as q:
        deselect_sql(q, a, 1, '1@g.us')
    counts = visibility_counts(seed, a)
    for t in TABLES:
        assert counts[t].get('shared_market') == 1  # group 2 stays published
        assert counts[t].get('workspace_private') == 1  # group 1 un-published
    with c.cursor() as q:
        q.execute("select t.visibility,t.source_scope from residential_sale_listings t join raw_messages r on r.id=t.raw_message_id where r.group_name='Grp1'")
        assert q.fetchone() == ('workspace_private', 'whatsapp_private')


def test_deselect_idempotent_second_run_is_noop(seed):
    c, a, b, u = seed
    confirm(seed, 1, a, ['1@g.us'], 'phone-a')
    with c.cursor() as q:
        assert deselect_sql(q, a, 1, '1@g.us') == 1
        # Postgres counts matched rows, not changed ones: a repeat UPDATE still
        # matches the row but leaves identical state (public_market_source was
        # already false), and the sync finds nothing left to un-publish.
        assert deselect_sql(q, a, 1, '1@g.us') == 1
        q.execute("select public_market_source,is_active,opted_out from organization_group_connections where organization_id=%s and whatsapp_connection_id=1 and group_jid='1@g.us'", (a,))
        assert q.fetchone() == (False, False, False)
        q.execute('select sync_group_market_visibility(%s,%s,%s,%s)', (a, '1@g.us', 'Grp1', False))
        assert q.fetchone()[0] == 0
    assert state(seed, 1, a)['complete'] is False


def test_deselect_concurrent_double_removal(seed):
    c, a, b, u = seed
    confirm(seed, 1, a, ['1@g.us'], 'phone-a')
    dsn = c.dsn
    results, errors = [], []

    def worker():
        try:
            conn = psycopg2.connect(dsn)
            conn.autocommit = True
            with conn.cursor() as q:
                results.append(deselect_sql(q, a, 1, '1@g.us'))
            conn.close()
        except Exception as exc:  # pragma: no cover - failure path
            errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors
    assert results == [1, 1]  # both match the row; row lock serializes them; final state identical
    with c.cursor() as q:
        q.execute("select public_market_source from organization_group_connections where organization_id=%s and whatsapp_connection_id=1 and group_jid='1@g.us'", (a,))
        assert q.fetchone()[0] is False
    assert state(seed, 1, a)['complete'] is False
