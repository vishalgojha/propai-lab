"""Private directory: real HTTP auth boundary, projections, and bounded reads."""
from types import SimpleNamespace
import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from routers import admin
from routers.common import require_user
from storage.supabase import SupabaseStorage, create_client


def client_for(monkeypatch, *, super_admin=True, authenticated=True, fail=False):
    calls = []
    def directory(kind, page, size):
        calls.append((kind, page, size))
        if fail: raise RuntimeError('provider secret must not reach response')
        return dict(kind=kind, rows=[{'id':'one'}], page=page, page_size=size, has_more=False,total=1)
    monkeypatch.setattr(admin, 'storage', SimpleNamespace(is_super_admin=lambda _:super_admin, admin_user_directory=directory))
    app = FastAPI();app.include_router(admin.router)
    if authenticated: app.dependency_overrides[require_user] = lambda:{'id':'viewer'}
    return TestClient(app), calls


def test_normal_broker_denied_before_any_directory_read(monkeypatch):
    c,calls=client_for(monkeypatch,super_admin=False)
    assert c.get('/api/admin/user-directory').status_code==403
    assert calls==[]


def test_anonymous_denied(monkeypatch):
    c,calls=client_for(monkeypatch,authenticated=False)
    assert c.get('/api/admin/user-directory').status_code in (401,403)
    assert calls==[]


def test_admin_read_and_pagination(monkeypatch):
    c,calls=client_for(monkeypatch)
    r=c.get('/api/admin/user-directory?kind=accounts&page=2&page_size=25')
    assert r.status_code==200 and r.json()['as_of']
    assert r.headers['cache-control']=='private, no-store'
    assert calls==[('accounts',2,25)]
    assert c.post('/api/admin/user-directory',json={}).status_code==405


@pytest.mark.parametrize('query',['kind=invalid','page=0','page=10001','page_size=0','page_size=101','page=bad'])
def test_invalid_bounds_never_read(monkeypatch,query):
    c,calls=client_for(monkeypatch)
    assert c.get('/api/admin/user-directory?'+query).status_code in (400,422)
    assert calls==[]


def test_provider_failure_is_not_empty_success_or_secret(monkeypatch):
    c,_=client_for(monkeypatch,fail=True)
    r=c.get('/api/admin/user-directory')
    assert r.status_code==502 and 'secret' not in r.text


def storage_for(handler):
    c=create_client('https://example.invalid','fixture-secret')
    c._http=httpx.Client(transport=httpx.MockTransport(handler),headers=c._headers)
    s=object.__new__(SupabaseStorage);s._client=c
    return s


def test_auth_directory_only_allowlisted_fields_and_no_writes():
    def handler(r):
        if r.url.path == '/auth/v1/admin/users':
            assert r.method=='GET'
            assert r.url.params['page']=='2' and r.url.params['per_page']=='2'
            assert r.headers['authorization']=='Bearer fixture-secret'
            return httpx.Response(200,json={'users':[{'id':'u','email':'test@example.invalid','created_at':'2026-11-23T10:00:00Z','user_metadata':{'first_name':'Test','last_name':'User','secret':'never'},'app_metadata':{'secret':'never'},'encrypted_password':'never','identities':['never']}]})
        assert r.url.path == '/rest/v1/organizations'
        assert r.url.params['select']=='owner_user_id,owner_phone'
        return httpx.Response(200,json=[])
    data=storage_for(handler).admin_user_directory('accounts',2,2)
    assert data['rows'][0]['name']=='Test User'
    assert data['total'] is None and data['has_more'] is False
    assert 'never' not in str(data)


def test_auth_directory_uses_workspace_phone_when_auth_phone_is_empty():
    def handler(r):
        if r.url.path == '/auth/v1/admin/users':
            return httpx.Response(200,json={'users':[{'id':'u','email':'raj@example.invalid','user_metadata':{}}]})
        assert r.url.path == '/rest/v1/organizations'
        return httpx.Response(200,json=[{'owner_user_id':'u','owner_phone':'919820056180'}])

    data=storage_for(handler).admin_user_directory('accounts',1,25)
    assert data['rows'][0]['phone']=='919820056180'


def test_auth_full_page_has_next_without_guessing_total():
    def handler(r):
        if r.url.path == '/auth/v1/admin/users':
            return httpx.Response(200,json={'users':[{'id':'u'}]})
        return httpx.Response(200,json=[])
    s=storage_for(handler)
    data=s.admin_user_directory('accounts',1,1)
    assert data['has_more'] and data['total'] is None


def test_workspace_read_has_exact_count_projection_and_order():
    def handler(r):
        if r.url.path!='/rest/v1/organizations':
            return httpx.Response(200,json=[])
        assert r.method=='GET' and r.url.path=='/rest/v1/organizations'
        assert r.url.params['select']=='id,name,owner_user_id,owner_phone,created_at,is_active'
        assert r.url.params['order']=='created_at.desc,id.desc'
        assert r.url.params['offset']=='25' and r.url.params['limit']=='25'
        assert 'count=exact' in r.headers['prefer']
        return httpx.Response(200,json=[{'id':'w','name':'Test'}],headers={'content-range':'25-25/26'})
    data=storage_for(handler).admin_user_directory('workspaces',2,25)
    assert data['total']==26 and not data['has_more']


def test_owner_details_from_membership_and_auth_without_writes():
    seen=[]
    def handler(r):
        seen.append((r.method,r.url.path))
        assert r.method=='GET'
        p=r.url.path
        if p=='/rest/v1/organizations':
            return httpx.Response(200,json=[{'id':'o1','name':'A'},{'id':'o2','name':'B'},{'id':'o3','name':'C'},{'id':'o4','name':'D'}],headers={'content-range':'0-3/4'})
        if p=='/rest/v1/roles': return httpx.Response(200,json=[{'id':7}])
        if p=='/rest/v1/organization_members':
            return httpx.Response(200,json=[{'organization_id':'o1','user_id':'u1'},{'organization_id':'o2','user_id':'u2'},{'organization_id':'o3','user_id':'u3'}])
        if p=='/auth/v1/admin/users/u1': return httpx.Response(200,json={'phone':'919800000001','phone_confirmed_at':'2026-01-01','user_metadata':{}})
        if p=='/auth/v1/admin/users/u2': return httpx.Response(200,json={'phone':'','user_metadata':{'phone':'9800000002'}})
        if p=='/auth/v1/admin/users/u3': return httpx.Response(200,json={'user_metadata':{}})
        raise AssertionError(p)
    rows=storage_for(handler).admin_user_directory('workspaces',1,25)['rows']
    by={r['id']:r for r in rows}
    assert by['o1']['owner_user_id']=='u1' and by['o1']['owner_phone_source']=='verified_auth'
    assert by['o2']['owner_phone']=='9800000002' and by['o2']['owner_phone_source']=='signup_entry'
    assert by['o3']['owner_user_id']=='u3' and not by['o3'].get('owner_phone') and by['o3']['owner_phone_source'] is None
    assert by['o4'].get('owner_user_id') is None and by['o4']['owner_user_source'] is None
    assert all(m=='GET' for m,_ in seen)
    assert 'never' not in str(rows)
