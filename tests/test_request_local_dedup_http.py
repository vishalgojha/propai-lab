"""Real-HTTP lifecycle tests for the request-local read memo.

Unlike the context-level tests in test_request_local_dedup.py, these run
actual HTTP requests through the ASGI stack with the production middleware
(request_read_memo_middleware) registered the same way app.py registers it,
so the request lifecycle (install -> handler -> clear/reset) is exercised
end to end.
"""
import asyncio
import threading
import time

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from routers import common
from routers import whatsapp_sync as sync
from tests.test_request_local_dedup import CountingStorage, USER, _unpaired_workspace


def _build_app(fake):
    common.storage._real = fake
    app = FastAPI()
    # Same registration as app.py.
    app.middleware("http")(common.request_read_memo_middleware)

    app.dependency_overrides[common.get_current_user] = lambda: USER

    @app.get("/api/phones")
    async def phones(
        user: dict = Depends(common.get_current_user),
        tenant_id: str | None = Depends(common.get_tenant_context),
    ):
        return await sync.list_phones(user, tenant_id, False)

    return app


@pytest.fixture
def fake():
    storage = CountingStorage()
    _unpaired_workspace(storage)
    return storage


def test_two_http_requests_each_get_fresh_memo(fake):
    with TestClient(_build_app(fake)) as client:
        assert client.get("/api/phones").status_code == 200
        assert fake.counts == {
            "get_user_organizations": 1,
            "list_org_whatsapp_connections": 1,
            "list_org_whatsapp_phone_directory": 1,
        }
        assert client.get("/api/phones").status_code == 200
        # Second HTTP request: memo did not leak across requests.
        assert fake.counts == {
            "get_user_organizations": 2,
            "list_org_whatsapp_connections": 2,
            "list_org_whatsapp_phone_directory": 2,
        }


def test_revocation_between_http_requests_is_visible(fake):
    with TestClient(_build_app(fake)) as client:
        assert client.get("/api/phones").status_code == 200
        fake.orgs = []  # membership revoked after the first request
        second = client.get("/api/phones")
        assert second.status_code == 403
        # The denied request re-read storage: no cached membership was served.
        assert fake.counts["get_user_organizations"] == 2


def test_child_task_during_request_shares_live_memo(fake):
    common.storage._real = fake
    app = FastAPI()
    app.middleware("http")(common.request_read_memo_middleware)
    app.dependency_overrides[common.get_current_user] = lambda: USER

    @app.get("/child")
    async def child(user: dict = Depends(common.get_current_user)):
        await common.get_tenant_context(user, None)  # primes the memo (1 read)
        async def child_task():
            return await asyncio.to_thread(common._get_user_organizations_memo, USER["id"])
        await asyncio.create_task(child_task())
        return {"counts": dict(fake.counts)}

    with TestClient(app) as client:
        body = client.get("/child").json()
    assert body["counts"]["get_user_organizations"] == 1  # child saw the memo, no re-read


def test_background_task_after_response_cannot_serve_stale_memo(fake):
    common.storage._real = fake
    app = FastAPI()
    app.middleware("http")(common.request_read_memo_middleware)
    app.dependency_overrides[common.get_current_user] = lambda: USER
    bg_done = threading.Event()
    outcome = {}

    @app.get("/spawn")
    async def spawn(user: dict = Depends(common.get_current_user)):
        await common.get_tenant_context(user, None)  # primes the memo (1 read)
        async def bg():
            await asyncio.sleep(0.3)  # outlive the response
            outcome["before"] = dict(fake.counts)
            # The request is finished; the inherited state was closed by the
            # middleware, so this must hit storage, never a stale memo entry.
            orgs_first = await asyncio.to_thread(common._get_user_organizations_memo, USER["id"])
            outcome["after_first"] = dict(fake.counts)
            outcome["first_result"] = orgs_first
            # Intervening revocation: a SECOND background read must re-query
            # again. A refilled dict would serve the pre-revocation row here.
            fake.orgs = []
            orgs_second = await asyncio.to_thread(common._get_user_organizations_memo, USER["id"])
            outcome["after_second"] = dict(fake.counts)
            outcome["second_result"] = orgs_second
            bg_done.set()
        asyncio.create_task(bg())
        return {"ok": True}

    with TestClient(app) as client:
        assert client.get("/spawn").status_code == 200
        assert bg_done.wait(timeout=5), "background task did not finish"
    assert outcome["before"]["get_user_organizations"] == 1
    assert outcome["after_first"]["get_user_organizations"] == 2  # re-read, not stale
    assert outcome["first_result"], "first background read should still see membership"
    assert outcome["after_second"]["get_user_organizations"] == 3  # re-read AGAIN
    assert outcome["second_result"] == [], "revocation must be visible to the second background read"


def test_blocked_loader_cannot_write_back_after_response(fake):
    common.storage._real = fake
    app = FastAPI()
    app.middleware("http")(common.request_read_memo_middleware)
    app.dependency_overrides[common.get_current_user] = lambda: USER
    loader_gate = threading.Event()
    loader_calls = {"n": 0}
    bg_done = threading.Event()
    outcome = {}

    def slow_loader():
        loader_calls["n"] += 1
        loader_gate.wait(timeout=5)  # blocked until after the response
        return [{"id": "org-1"}]

    @app.get("/slow")
    async def slow(user: dict = Depends(common.get_current_user)):
        async def bg():
            await asyncio.sleep(0.2)  # let the response finish and state close
            first = await asyncio.to_thread(
                common._memoized_read, ("blocked", "key"), slow_loader
            )
            outcome["first"] = first
            # Loader returned after the request closed and must NOT have been
            # stored: the next read on the inherited state calls the loader again.
            second = await asyncio.to_thread(
                common._memoized_read, ("blocked", "key"), slow_loader
            )
            outcome["second"] = second
            bg_done.set()
        asyncio.create_task(bg())
        return {"ok": True}

    with TestClient(app) as client:
        assert client.get("/slow").status_code == 200
        time.sleep(0.5)  # ensure the first loader is parked past response
        loader_gate.set()
        assert bg_done.wait(timeout=5), "background task did not finish"
    assert loader_calls["n"] == 2, "closed state must not store or serve the late loader result"
    assert outcome["first"] == outcome["second"] == [{"id": "org-1"}]
