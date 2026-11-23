"""Local-only optional contact-disclosure policy regression tests."""
from pathlib import Path
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
import pytest
from tests.test_independent_raw_sharing import db, seeded, grant, message
from tests.test_broker_market_rest_adapter import rig
from broker_market_policy import CONTACT_CONSENT_VERSION

@pytest.fixture
def contact_seed(seeded):
    conn,*_=seeded
    with conn.cursor() as q:
        q.execute("select to_regclass('public.broker_market_contact_consents')")
        if q.fetchone()[0] is None:
            q.execute(Path('supabase/migrations/20261123150000_optional_source_contact_disclosure.sql').read_text())
    return seeded

def contact_grant(seed, enabled=True):
    conn,a,b,u,v=seed
    with conn.cursor() as q:
        q.execute('select broker_market_set_contact_sources(%s,1,%s,%s,%s,%s)',(a,['123@g.us'],u,CONTACT_CONSENT_VERSION,enabled))
        return q.fetchone()[0]

def allowed(conn,id):
    with conn.cursor() as q:
        q.execute('select broker_market_contact_allowed(%s)',(id,));return q.fetchone()[0]

def test_separate_future_grant_and_revoke(contact_seed):
    seed=contact_seed;conn,*_=seed
    grant(seed);message(seed,id=1)
    assert not allowed(conn,1)
    assert contact_grant(seed)==1
    assert not allowed(conn,1)
    message(seed,id=2)
    assert allowed(conn,2)
    contact_grant(seed,False)
    assert not allowed(conn,2)

def test_parent_regrant_never_resurrects(contact_seed):
    seed=contact_seed;conn,*_=seed
    grant(seed);contact_grant(seed);message(seed,id=1)
    assert allowed(conn,1)
    grant(seed,enabled=False);grant(seed)
    message(seed,id=2)
    assert not allowed(conn,2)


def test_idempotent_contact_grant_preserves_boundary(contact_seed):
    seed=contact_seed;conn,*_=seed
    grant(seed);contact_grant(seed)
    with conn.cursor() as q:q.execute('select confirmed_at from broker_market_contact_consents');before=q.fetchone()[0]
    contact_grant(seed)
    with conn.cursor() as q:q.execute('select confirmed_at from broker_market_contact_consents');assert q.fetchone()[0]==before


def test_contact_grant_cannot_create_raw_permission(contact_seed):
    import psycopg2
    with pytest.raises(psycopg2.Error):contact_grant(contact_seed)


def test_http_mixed_grants_all_labels_and_current_reread(rig):
    c,state=rig
    row={'raw_id':42,'body':'Juhu 3 bhk rent Alice 9820056180 Bob 9876543210','posted_at':'2026-11-23T10:00:00Z','sender_phone':'9999999999','sender_jid':'','automatic_contacts':True}
    old={**row,'raw_id':43,'automatic_contacts':False}
    state['by_name']={'broker_market_take_rate':True,'broker_market_search_with_contacts':[row,old],'broker_market_get_with_contacts':[row]}
    r=c.post('/api/external/v1/market/search',json={'locality':'Juhu'})
    assert r.status_code==200,r.text
    a,b=r.json()['results']
    assert len(a['contacts'])==2 and 'contacts' not in b
    assert '9820056180' not in a['text'] and '9999999999' not in r.text
    for contact in a['contacts']:assert '9820056180' not in contact['label'] and '9876543210' not in contact['label']
    option=a['option']
    r=c.post('/api/external/v1/market/contact',json={'option':option})
    assert r.status_code==200 and len(r.json()['contacts'])==2
    state['by_name']['broker_market_get_with_contacts']=[{**row,'automatic_contacts':False}]
    r=c.post('/api/external/v1/market/option',json={'option':option})
    assert 'contacts' not in r.json()
    assert c.post('/api/external/v1/market/contact',json={'option':option}).status_code==422
    state['by_name']['broker_market_get_with_contacts']=[]
    assert c.post('/api/external/v1/market/option',json={'option':option}).status_code==404


def test_auto_contacts_never_use_poster_fallback(rig):
    from routers.broker_market import result_item
    row={'raw_id':1,'body':'Juhu 3 bhk rent','posted_at':'2026-11-23','sender_phone':'9820056180','automatic_contacts':True,'sender_jid':''}
    result=result_item(row,{'tenant_id':'a','id':'b'})
    assert result['contacts']==[] and '9820056180' not in str(result)

@pytest.mark.parametrize('change',[
 "update organization_group_connections set opted_out=true",
 "update org_whatsapp_connections set is_active=false where id=1",
 "update broker_market_contact_consents set version='broker-property-contact-results-v1',revoked_at=now()",
 "update raw_messages set is_group=false",
 "update raw_messages set synced_at=now()-interval '1 day'",
 "update broker_market_contact_consents set raw_confirmed_at=raw_confirmed_at-interval '1 second'",
])
def test_current_source_negatives_fail_closed(contact_seed,change):
    seed=contact_seed;conn,a,*_=seed
    if 'organization_group_connections' in change:
        with conn.cursor() as q:q.execute("insert into organization_group_connections(id,organization_id,whatsapp_connection_id,group_jid,opted_out,is_active,public_market_source) values(11,%s,1,'123@g.us',false,true,true)",(a,))
    grant(seed);contact_grant(seed);message(seed,id=1)
    assert allowed(conn,1)
    with conn.cursor() as q:q.execute(change)
    assert not allowed(conn,1)


def test_mcp_uses_same_contact_policy(rig):
    c,state=rig
    row={'raw_id':42,'body':'Juhu 3 bhk rent call 9820056180','posted_at':'2026-11-23','sender_phone':'','sender_jid':'','automatic_contacts':True}
    state['by_name']={'broker_market_take_rate':True,'broker_market_search_with_contacts':[row]}
    r=c.post('/api/external/v1/market/mcp',json={'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':'property_cross_search','arguments':{'locality':'Juhu'}}})
    assert r.status_code==200
    assert r.json()['result']['structuredContent']['results'][0]['contacts'][0]['phone']=='+919820056180'


def test_contact_consent_requires_current_explicit_optin(rig):
    c,state=rig
    payload={'whatsapp_connection_id':225,'group_jids':['123@g.us'],'consent_version':CONTACT_CONSENT_VERSION,'confirmed':False,'enabled':True}
    assert c.put('/api/external/v1/market/contact-sources',json=payload).status_code==400
    payload.update(confirmed=True,consent_version='old')
    assert c.put('/api/external/v1/market/contact-sources',json=payload).status_code==400
    assert not any('set_contact_sources' in x for x in state['calls'])


def test_optout_then_reset_cannot_restore_contact_permission(contact_seed):
    seed=contact_seed;conn,a,*_=seed
    with conn.cursor() as q:q.execute("insert into organization_group_connections(id,organization_id,whatsapp_connection_id,group_jid,opted_out,is_active,public_market_source) values(11,%s,1,'123@g.us',false,true,true)",(a,))
    grant(seed);contact_grant(seed);message(seed,id=1)
    assert allowed(conn,1)
    with conn.cursor() as q:
        q.execute('update organization_group_connections set opted_out=true where id=11')
        q.execute('update organization_group_connections set opted_out=false where id=11')
    assert not allowed(conn,1)
    message(seed,id=2)
    assert not allowed(conn,2)
    grant(seed)
    message(seed,id=3)
    assert not allowed(conn,3)


def test_source_post_scope_does_not_claim_digest_flat_association(rig):
    from routers.broker_market import result_item
    row={'raw_id':1,'body':'Juhu 3 bhk Alice 9820056180\nBandra 2 bhk Bob 9876543210','posted_at':'2026-11-23','automatic_contacts':True}
    result=result_item(row,{'tenant_id':'a','id':'b'})
    assert result['contact_scope']=='source_post'
    assert len(result['contacts'])==2
    assert all(x['association']=='unverified' for x in result['contacts'])
    assert 'other flats' in result['contact_warning']


def test_contact_owner_routes_deny_nonmanager_and_unauthenticated(rig,monkeypatch):
    from fastapi import HTTPException
    from routers import broker_market as market
    c,state=rig
    async def deny(*args):raise HTTPException(403,'Insufficient workspace permission')
    monkeypatch.setattr(market,'_require_org_permission',deny)
    payload={'whatsapp_connection_id':225,'group_jids':['123@g.us'],'consent_version':CONTACT_CONSENT_VERSION,'confirmed':True,'enabled':True}
    assert c.get('/api/external/v1/market/contact-sources?whatsapp_connection_id=225').status_code==403
    assert c.put('/api/external/v1/market/contact-sources',json=payload).status_code==403
    def unauthenticated():raise HTTPException(401,'Not signed in')
    c.app.dependency_overrides[market.require_user]=unauthenticated
    assert c.get('/api/external/v1/market/contact-sources?whatsapp_connection_id=225').status_code==401
    assert c.put('/api/external/v1/market/contact-sources',json=payload).status_code==401
    assert state['calls']==[]
