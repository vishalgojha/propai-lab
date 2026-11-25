"""Real flow integration test for raw group sharing, on a disposable database.

Covers the path the closeout review flagged as unexercised: group selection ->
consent write success/failure, consent version, atomic partial failure, tenant
boundaries, the non-property privacy gate, revocation triggers and reconsent.
Local scratch PostgreSQL only, never production.
"""
import json
from pathlib import Path
import uuid

import psycopg2
import pytest

from broker_market_policy import (PROPERTY_PATTERN, classify_group_share_topic,
                                  validate_group_share_eligibility)

MIGRATIONS = [
    'supabase/migrations/20261119090000_broker_property_cross_search.sql',
    'supabase/migrations/20261120100000_independent_raw_group_sharing.sql',
]
V2 = 'broker-property-cross-search-v2'
PROPERTY_JID, UNCLEAR_JID, FAMILY_JID, OTHER_JID = ('111@g.us', '222@g.us', '333@g.us', '444@g.us')
NAMES = {PROPERTY_JID: 'Mumbai Property Exchange', UNCLEAR_JID: 'Founders Circle',
         FAMILY_JID: 'Hare Krishna Family', OTHER_JID: 'Pune Realty Brokers'}


@pytest.fixture(scope='module')
def db():
    admin = psycopg2.connect(host='/tmp', dbname='postgres', user='postgres'); admin.autocommit = True
    name = 'share_flow_' + uuid.uuid4().hex[:10]
    with admin.cursor() as q:
        q.execute('create database ' + name)
    c = psycopg2.connect(host='/tmp', dbname=name, user='postgres'); c.autocommit = True
    with c.cursor() as q:
        q.execute('''create schema auth;create table auth.users(id uuid primary key);
        create table organizations(id uuid primary key);
        create table org_whatsapp_connections(id bigint primary key,organization_id uuid,broker_id text,phone_number text,is_active boolean);
        create table organization_group_connections(id bigint primary key,organization_id uuid,whatsapp_connection_id bigint,group_jid text,group_name text,is_active boolean,opted_out boolean,public_market_source boolean,updated_at timestamptz);
        create table whatsapp_conversations(tenant_id uuid,broker_id text,conversation_type text,conversation_jid text,display_name text,message_count integer,last_message_at timestamptz);
        create table broker_whatsapp_devices(whatsapp_connection_key text,device_jid text);
        create table external_agent_api_keys(id uuid primary key,tenant_id uuid,scopes text[],revoked_at timestamptz);
        create table raw_messages(id bigint primary key,tenant_id uuid,message text,timestamp timestamptz,sender_phone text,sender_jid text,is_group boolean,source text,pipeline_version text,raw_payload jsonb,event_id text,message_uid text,synced_at timestamptz);
        ''')
        for migration in MIGRATIONS:
            q.execute(Path(migration).read_text())
    yield c
    c.close()
    with admin.cursor() as q:
        q.execute('drop database ' + name + ' with (force)')
    admin.close()


@pytest.fixture
def seeded(db):
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    a, b, u = [str(uuid.uuid4()) for _ in range(3)]
    with db.cursor() as q:
        for table in ('raw_messages', 'broker_market_raw_source_consents', 'broker_whatsapp_devices',
                      'whatsapp_conversations', 'organization_group_connections',
                      'org_whatsapp_connections', 'organizations', 'auth.users'):
            q.execute('truncate ' + table + ' cascade')
        q.execute('insert into auth.users values(%s)', (u,))
        q.execute('insert into organizations values(%s),(%s)', (a, b))
        q.execute("insert into org_whatsapp_connections values(1,%s,'phone-a','+919820000001',true),(2,%s,'phone-b','+919820000002',true)", (a, b))
        for i, (jid, gname) in enumerate(NAMES.items(), start=1):
            org, broker = (a, 'phone-a') if jid != OTHER_JID else (b, 'phone-b')
            q.execute("insert into whatsapp_conversations values(%s,%s,'group',%s,%s,5,%s)", (org, broker, jid, gname, now))
        for i, jid in enumerate((PROPERTY_JID, UNCLEAR_JID, FAMILY_JID), start=1):
            q.execute("insert into organization_group_connections values(%s,%s,1,%s,%s,true,false,true,%s)", (10 + i, a, jid, NAMES[jid], now))
    return db, a, b, u, now


def search_ids(db):
    with db.cursor() as q:
        q.execute("select raw_id from broker_market_search(%s,%s,now()-interval '1 day',now()+interval '1 minute',21,null,null)",
                  (json.dumps([['lodha']]), PROPERTY_PATTERN))
        return [r[0] for r in q.fetchall()]


def post(db, raw_id, org, broker, jid, when):
    with db.cursor() as q:
        q.execute("insert into raw_messages values(%s,%s,'Lodha 3 bhk for sale call 9820056180',%s,'9820056180','',true,'WHATSAPP','go-ingestor',%s,%s,%s,%s)",
                  (raw_id, org, when, json.dumps({'data': {'key': {'remoteJid': jid}}}),
                   broker + ':m' + str(raw_id), broker + ':' + jid + ':m' + str(raw_id), when))


def test_group_topic_classification():
    assert classify_group_share_topic('Mumbai Property Exchange') == ('property', None)
    assert classify_group_share_topic('Flat Sale Andheri')[0] == 'property'
    assert classify_group_share_topic('Founders Circle') == ('unclear', None)
    assert classify_group_share_topic('Social Monkey App') == ('unclear', None)
    assert classify_group_share_topic('Hare Krishna Family') == ('non_property', 'personal or family')
    assert classify_group_share_topic('College Batchmates 2010')[0] == 'non_property'
    assert classify_group_share_topic('') == ('unclear', None)


def test_gate_blocks_non_property_and_holds_unclear():
    blocked, held = validate_group_share_eligibility([PROPERTY_JID, FAMILY_JID], [], NAMES)
    assert blocked == ['Hare Krishna Family (personal or family group)'] and held == []
    blocked, held = validate_group_share_eligibility([PROPERTY_JID, UNCLEAR_JID], [], NAMES)
    assert blocked == [] and held == ['Founders Circle']
    assert validate_group_share_eligibility([PROPERTY_JID, UNCLEAR_JID], [UNCLEAR_JID], NAMES) == ([], [])
    # Unknown jids are left to the RPC's directory-existence check.
    assert validate_group_share_eligibility(['999@g.us'], [], NAMES) == ([], [])


def test_consent_write_success_version_atomicity_and_boundaries(seeded):
    db, a, b, u, now = seeded
    with db.cursor() as q:
        q.execute('select public.broker_market_set_raw_sources(%s,1,%s,%s,%s,true)',
                  (a, [PROPERTY_JID, UNCLEAR_JID], u, V2))
        assert q.fetchone()[0] == 2
        q.execute('select group_jid,version,revoked_at,group_name from broker_market_raw_source_consents order by group_jid')
        rows = q.fetchall()
    assert [(r[0], r[1], r[2]) for r in rows] == [(PROPERTY_JID, V2, None), (UNCLEAR_JID, V2, None)]
    assert [r[3] for r in rows] == ['Mumbai Property Exchange', 'Founders Circle']
    with db.cursor() as q:
        # Wrong consent version is refused before any write.
        with pytest.raises(psycopg2.Error):
            q.execute('select public.broker_market_set_raw_sources(%s,1,%s,%s,%s,true)',
                      (a, [PROPERTY_JID], u, 'broker-property-cross-search-v1'))
        # Partial failure is atomic: one unknown group rejects the whole set.
        with pytest.raises(psycopg2.Error):
            q.execute('select public.broker_market_set_raw_sources(%s,1,%s,%s,%s,true)',
                      (a, [PROPERTY_JID, '999@g.us'], u, V2))
        q.execute('select count(*) from broker_market_raw_source_consents where revoked_at is null')
        assert q.fetchone()[0] == 2
        # Tenant boundary: the other workspace holds no consent and its groups
        # were never written into this tenant's rows.
        q.execute('select count(*) from broker_market_raw_source_consents where organization_id=%s', (b,))
        assert q.fetchone()[0] == 0


def test_search_privacy_filter_and_tenant_isolation(seeded):
    db, a, b, u, now = seeded
    from datetime import datetime, timedelta, timezone
    with db.cursor() as q:
        q.execute('select public.broker_market_set_raw_sources(%s,1,%s,%s,%s,true)',
                  (a, [PROPERTY_JID, UNCLEAR_JID], u, V2))
    # Posts carry their real insertion time so they land after the consent
    # timestamp (freshness rule) and before any later re-consent in the test.
    later = datetime.now(timezone.utc)
    post(db, 1, a, 'phone-a', PROPERTY_JID, later)   # consented property group: visible
    post(db, 2, a, 'phone-a', UNCLEAR_JID, later)    # explicitly confirmed unclear: visible
    post(db, 3, a, 'phone-a', FAMILY_JID, later)     # non-property, never consented: hidden
    post(db, 4, b, 'phone-b', OTHER_JID, later)      # other tenant, no consent: hidden
    assert sorted(search_ids(db)) == [1, 2]


def test_revocation_triggers_and_reconsent(seeded):
    db, a, b, u, now = seeded
    from datetime import datetime, timezone
    with db.cursor() as q:
        q.execute('select public.broker_market_set_raw_sources(%s,1,%s,%s,%s,true)',
                  (a, [PROPERTY_JID, UNCLEAR_JID], u, V2))
    later = datetime.now(timezone.utc)
    post(db, 1, a, 'phone-a', PROPERTY_JID, later)
    post(db, 2, a, 'phone-a', UNCLEAR_JID, later)
    assert sorted(search_ids(db)) == [1, 2]
    with db.cursor() as q:
        # Group opt-out revokes that group's consent immediately...
        q.execute("update organization_group_connections set opted_out=true where group_jid=%s", (UNCLEAR_JID,))
        assert search_ids(db) == [1]
        # ...and an opted-out group cannot be re-shared until privacy control is restored.
        with pytest.raises(psycopg2.Error):
            q.execute('select public.broker_market_set_raw_sources(%s,1,%s,%s,%s,true)',
                      (a, [UNCLEAR_JID], u, V2))
        q.execute("update organization_group_connections set opted_out=false where group_jid=%s", (UNCLEAR_JID,))
        q.execute('select public.broker_market_set_raw_sources(%s,1,%s,%s,%s,true)',
                  (a, [UNCLEAR_JID], u, V2))
        assert q.fetchone()[0] == 1
        # Consent freshness: the message posted before this re-confirmation is
        # not resurrected; only new posts in the group become searchable.
        assert search_ids(db) == [1]
        # A device re-registration is an identity boundary: all of the
        # connection's consents pause, nothing is silently restored.
        q.execute("insert into broker_whatsapp_devices values('phone-a','device-1')")
        q.execute('select count(*) from broker_market_raw_source_consents where revoked_at is null')
        assert q.fetchone()[0] == 0
        assert search_ids(db) == []
        # The owner's explicit re-confirmation restores sharing, and consent
        # freshness still excludes messages posted before the new confirmation.
        q.execute('select public.broker_market_set_raw_sources(%s,1,%s,%s,%s,true)',
                  (a, [PROPERTY_JID, UNCLEAR_JID], u, V2))
        assert q.fetchone()[0] == 2
        assert search_ids(db) == []
    post(db, 5, a, 'phone-a', PROPERTY_JID, datetime.now(timezone.utc))
    assert search_ids(db) == [5]
