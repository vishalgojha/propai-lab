"""Adversarial lifecycle/real-JWKS checks for the post-v3 latency candidate."""
import asyncio
import base64
import json
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import Depends, FastAPI
from fastapi.security import HTTPAuthorizationCredentials
import httpx

from routers import common, auth_org
from tests.test_request_local_dedup import CountingStorage, USER, _unpaired_workspace


@pytest.fixture(autouse=True)
def isolated_direct_caller_memo():
    token = common._REQUEST_READ_MEMO.set(None)
    try:
        yield
    finally:
        state = common._REQUEST_READ_MEMO.get()
        if state:
            state.open = False
            state.data.clear()
        common._REQUEST_READ_MEMO.reset(token)


def test_real_jwks_refresh_keeps_event_loop_responsive_and_rejects_invalid(monkeypatch):
    key = ec.generate_private_key(ec.SECP256R1())
    jwk = json.loads(jwt.algorithms.ECAlgorithm.to_jwk(key.public_key()))
    jwk.update(kid='test-key', use='sig', alg='ES256')
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            time.sleep(.22)
            body = json.dumps({'keys': [jwk]}).encode()
            self.send_response(200); self.end_headers(); self.wfile.write(body)
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    monkeypatch.setattr(common, '_jwks_client', jwt.PyJWKClient(f'http://127.0.0.1:{server.server_port}/keys'))
    def token(**changes):
        claims = {'sub': 'actual-user', 'aud': 'authenticated', 'exp': datetime.now(timezone.utc) + timedelta(minutes=2)}
        claims.update(changes)
        return jwt.encode(claims, key, algorithm='ES256', headers={'kid': 'test-key'})
    async def run():
        ticks = []
        start = time.monotonic()
        async def heartbeat():
            await asyncio.sleep(.025); ticks.append(time.monotonic() - start)
        creds = HTTPAuthorizationCredentials(scheme='Bearer', credentials=token())
        result, _ = await asyncio.gather(common.get_current_user(creds), heartbeat())
        assert result['id'] == 'actual-user'
        assert ticks[0] < .14, ticks
        for bad in (token(aud='other'), token(exp=datetime.now(timezone.utc)-timedelta(seconds=2)), 'malformed'):
            assert await common.get_current_user(HTTPAuthorizationCredentials(scheme='Bearer', credentials=bad)) is None
        assert await common.get_current_user(None) is None
    try:
        asyncio.run(run())
    finally:
        server.shutdown(); server.server_close(); thread.join()


def test_auth_me_reuses_tenant_organization_read_in_real_http(monkeypatch):
    fake = CountingStorage(); _unpaired_workspace(fake)
    fake.is_super_admin = lambda uid: False
    monkeypatch.setattr(common.storage, '_real', fake)
    app = FastAPI(); app.middleware('http')(common.request_read_memo_middleware)
    app.dependency_overrides[common.get_current_user] = lambda: USER
    app.include_router(auth_org.router)
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as c:
            for n in (1, 2):
                r = await c.get('/api/auth/me')
                assert r.status_code == 200
                assert r.json()['active_tenant'] == 'org-1'
                assert fake.counts['get_user_organizations'] == n
    asyncio.run(run())


def test_existing_workspace_does_not_acquire_signup_lock(monkeypatch):
    fake = CountingStorage(); _unpaired_workspace(fake)
    monkeypatch.setattr(common.storage, '_real', fake)
    class FailLock:
        def __enter__(self):
            pytest.fail('steady state must not acquire provisioning lock')
        def __exit__(self, *args):
            pass
    monkeypatch.setitem(common._signup_phone_locks, 'org-1', FailLock())
    common._ensure_signup_whatsapp_phone(USER, 'org-1')


def test_concurrent_real_phone_provision_rechecks_prelock_empty_snapshots(monkeypatch):
    fake = CountingStorage()
    monkeypatch.setattr(common.storage, '_real', fake)
    user = dict(USER, phone='919876543210')
    gate = threading.Barrier(4)
    errors = []
    def request():
        state = common._RequestMemoState(); token = common._REQUEST_READ_MEMO.set(state)
        try:
            # Every request sees empty before any request takes the lock.
            assert common._list_whatsapp_connections_memo('org-1') == []
            assert common._list_whatsapp_directory_memo('org-1') == []
            gate.wait(timeout=3)
            common._ensure_signup_whatsapp_phone(user, 'org-1')
        except BaseException as e:
            errors.append(e)
        finally:
            state.open = False; state.data.clear(); common._REQUEST_READ_MEMO.reset(token)
    threads = [threading.Thread(target=request) for _ in range(4)]
    for thread in threads: thread.start()
    for thread in threads: thread.join(timeout=5)
    assert not errors
    assert not any(t.is_alive() for t in threads)
    assert len(fake.connections) == 1
    assert len(fake.directory) == 1


def test_delete_then_next_request_reprovisions_not_latched(monkeypatch):
    fake = CountingStorage()
    monkeypatch.setattr(common.storage, '_real', fake)
    async def request():
        state = common._RequestMemoState(); token = common._REQUEST_READ_MEMO.set(state)
        try:
            await asyncio.to_thread(common._ensure_signup_whatsapp_phone, USER, 'org-1')
        finally:
            state.open = False; state.data.clear(); common._REQUEST_READ_MEMO.reset(token)
    asyncio.run(request()); assert len(fake.connections) == 1
    old = fake.connections[0]['broker_id']; fake.connections.clear()
    asyncio.run(request()); assert len(fake.connections) == 1
    assert fake.connections[0]['broker_id'] != old
