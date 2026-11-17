import asyncio
import time
from types import SimpleNamespace
from routers import auth_org


def test_auth_me_slow_storage_does_not_block_loop(monkeypatch):
    user = {'id':'user-a','email':'owner@example.invalid'}
    calls=[]
    def orgs(uid):
        time.sleep(.15);calls.append(('orgs',uid));return [{'id':'tenant-a'}]
    def admin(uid):
        time.sleep(.15);calls.append(('admin',uid));return False
    monkeypatch.setattr(auth_org,'storage',SimpleNamespace(get_user_organizations=orgs,is_super_admin=admin))
    async def run():
        t=time.monotonic();ticks=[]
        async def heartbeat():
            await asyncio.sleep(.025);ticks.append(time.monotonic()-t)
        result,_=await asyncio.gather(auth_org.auth_me(user=user,tenant_id='tenant-a'),heartbeat())
        assert ticks[0] < .12
        assert result == {'authenticated':True,'user':user,'organizations':[{'id':'tenant-a'}],'active_tenant':'tenant-a','is_super_admin':False,'role_check_available':True}
    asyncio.run(run())
    assert calls == [('orgs','user-a'),('admin','user-a')]


def test_auth_me_preserves_error_semantics(monkeypatch):
    def fail(uid): raise RuntimeError('temporary storage error')
    monkeypatch.setattr(auth_org,'storage',SimpleNamespace(get_user_organizations=fail,is_super_admin=fail))
    result=asyncio.run(auth_org.auth_me(user={'id':'a'},tenant_id=None))
    assert result == {'authenticated':True,'user':{'id':'a'},'organizations':[],'active_tenant':None,'is_super_admin':None,'role_check_available':False}


def test_auth_me_unauthenticated_never_reads_storage(monkeypatch):
    monkeypatch.setattr(auth_org,'storage',SimpleNamespace())
    assert asyncio.run(auth_org.auth_me(user=None,tenant_id=None)) == {'authenticated':False}
