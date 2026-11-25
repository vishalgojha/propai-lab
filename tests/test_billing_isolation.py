"""Isolation, idempotency, trial-eligibility and webhook-ordering tests for
the inert Razorpay billing scaffold. All storage and Razorpay HTTP are faked;
no live calls, no charge tests."""

import asyncio
import hashlib
import hmac
import json
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

import routers.billing as billing


class _Result:
    def __init__(self, data):
        self.data = data


class _FakeTable:
    def __init__(self, store, name, filters=None, update=None, insert=None, order_desc=None, limit_n=None):
        self.store = store
        self.name = name
        self.rows = store.tables.setdefault(name, [])
        self._filters = filters or []
        self._update = update
        self._insert = insert
        self._order_desc = order_desc
        self._limit = limit_n

    def _clone(self, **kw):
        return _FakeTable(
            self.store, self.name,
            filters=kw.get("filters", self._filters),
            update=kw.get("update", self._update),
            insert=kw.get("insert", self._insert),
            order_desc=kw.get("order_desc", self._order_desc),
            limit_n=kw.get("limit_n", self._limit),
        )

    def select(self, *a, **k):
        return self._clone()

    def eq(self, col, val):
        return self._clone(filters=self._filters + [(col, val)])

    def order(self, col, desc=False):
        return self._clone(order_desc=(col if desc else None))

    def limit(self, n):
        return self._clone(limit_n=n)

    def insert(self, payload):
        return self._clone(insert=payload)

    def update(self, payload):
        return self._clone(update=payload)

    def execute(self):
        if self._insert is not None:
            row = dict(self._insert)
            row.setdefault("id", f"row-{len(self.rows)}")  # simulate DB default
            self.store.operations.append(("insert", self.name, row))
            self.rows.append(row)
            return _Result([row])
        matched = [r for r in self.rows if all(r.get(c) == v for c, v in self._filters)]
        if self._order_desc:
            matched.sort(key=lambda r: r.get(self._order_desc) or "", reverse=True)
        if self._update is not None:
            self.store.operations.append(("update", self.name, dict(self._update)))
            for row in matched:
                row.update(self._update)
        if self._limit:
            matched = matched[: self._limit]
        return _Result(matched)


class _FakeClient:
    def __init__(self, store):
        self.store = store

    def table(self, name):
        return _FakeTable(self.store, name)


class _FakeStorage:
    def __init__(self):
        self.tables = {}
        self.operations = []
        self.client = _FakeClient(self)


class _FakeResponse:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def json(self):
        return self._payload


class _FakeRazorpayClient:
    calls = []
    next_payload = {"id": "sub_test123", "status": "created", "short_url": "https://rzp.io/l/test"}

    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, url, json=None, auth=None):
        type(self).calls.append({"url": url, "json": json, "auth": auth})
        return _FakeResponse(dict(type(self).next_payload))


class _FakeRequest:
    def __init__(self, body: bytes, signature: str):
        self._body = body
        self.headers = {"X-Razorpay-Signature": signature}

    async def body(self):
        return self._body

    async def json(self):
        return json.loads(self._body.decode())


@pytest.fixture()
def env(monkeypatch):
    store = _FakeStorage()
    monkeypatch.setattr(billing, "storage", store)
    monkeypatch.setattr(billing, "_KEY_ID", "rzp_test_key")
    monkeypatch.setattr(billing, "_KEY_SECRET", "rzp_test_secret")
    monkeypatch.setattr(billing, "_WEBHOOK_SECRET", "whsec_test")
    monkeypatch.setattr(billing.httpx, "AsyncClient", _FakeRazorpayClient)
    _FakeRazorpayClient.calls = []
    store.tables["subscription_plans"] = [
        {"code": "solo", "name": "Solo (1 number)", "monthly_price_inr": 1299,
         "whatsapp_numbers": 1, "razorpay_plan_id": "plan_solo", "active": True},
    ]
    store.tables["organizations"] = [{"id": "t1", "mcp_trial_started_at": None}]
    return store


def _create(tenant="t1", plan_code="solo"):
    return asyncio.run(billing.create_subscription(
        billing.SubscriptionCreate(plan_code=plan_code), user={"id": "u1"}, tenant_id=tenant,
    ))


def _sign(body: bytes, secret="whsec_test"):
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def _webhook(event: dict, secret="whsec_test"):
    body = json.dumps(event).encode()
    return asyncio.run(billing.razorpay_webhook(_FakeRequest(body, _sign(body, secret))))


def test_server_owned_amounts_no_client_fields(env):
    _create()
    assert len(_FakeRazorpayClient.calls) == 1
    payload = _FakeRazorpayClient.calls[0]["json"]
    # Amount/currency never come from the client: only the server-side plan id.
    assert payload["plan_id"] == "plan_solo"
    assert "amount" not in payload and "currency" not in payload
    assert set(payload) <= {"plan_id", "total_count", "customer_notify", "notes", "start_at"}


def test_repeat_click_returns_existing_without_new_remote_call(env):
    first = _create()
    assert first["status"] == "created"
    second = _create()
    body = json.loads(second.body.decode()) if hasattr(second, "body") else second
    assert body["existing"] is True
    assert len(_FakeRazorpayClient.calls) == 1  # no second Razorpay call
    inserts = [op for op in env.operations if op[0] == "insert" and op[1] == "tenant_subscriptions"]
    assert len(inserts) == 1  # no duplicate row


def test_trial_offset_only_for_never_trialled_workspace(env):
    _create()
    payload = _FakeRazorpayClient.calls[0]["json"]
    assert "start_at" in payload  # fresh workspace gets the 15-day offset
    trial_row = env.tables["tenant_subscriptions"][0]
    assert trial_row["trial_ends_at"] is not None

    env2 = env
    env2.tables["organizations"] = [{"id": "t2", "mcp_trial_started_at": "2026-11-01T00:00:00Z"}]
    _FakeRazorpayClient.calls = []
    _create(tenant="t2")
    payload2 = _FakeRazorpayClient.calls[0]["json"]
    assert "start_at" not in payload2  # existing broker billed from day one
    row2 = env2.tables["tenant_subscriptions"][-1]
    assert row2["trial_ends_at"] is None


def test_create_grants_no_paid_entitlement(env):
    _create()
    # organizations is only read for trial eligibility, never updated
    assert not [op for op in env.operations if op[0] == "update" and op[1] == "organizations"]
    row = env.tables["tenant_subscriptions"][0]
    assert row["status"] == "created"  # setup alone is not an active entitlement


def test_tenant_isolation_reads_and_idempotency(env):
    _create(tenant="t1")
    other = asyncio.run(billing.current_subscription(user={"id": "u9"}, tenant_id="t9"))
    assert other["subscription"] is None  # t1's subscription invisible to t9
    _FakeRazorpayClient.calls = []
    second = _create(tenant="t9")  # t9 may still start its own
    assert second["status"] == "created"
    assert len(_FakeRazorpayClient.calls) == 1


def _sub_event(event_type, event_id, sub_id="sub_test123"):
    return {"id": event_id, "event": event_type,
            "payload": {"subscription": {"entity": {"id": sub_id}}}}


def test_webhook_replay_is_acknowledged_without_reprocessing(env):
    _create()
    assert _webhook(_sub_event("subscription.activated", "evt_1"))["received"] is True
    updates = [op for op in env.operations if op[0] == "update" and op[1] == "tenant_subscriptions"]
    assert len(updates) == 1
    again = _webhook(_sub_event("subscription.activated", "evt_1"))
    assert again.get("duplicate") is True
    updates = [op for op in env.operations if op[0] == "update" and op[1] == "tenant_subscriptions"]
    assert len(updates) == 1  # replay did not reprocess


def test_webhook_out_of_order_cannot_resurrect_cancelled(env):
    _create()
    _webhook(_sub_event("subscription.cancelled", "evt_10"))
    assert env.tables["tenant_subscriptions"][0]["status"] == "cancelled"
    _webhook(_sub_event("subscription.activated", "evt_11"))
    assert env.tables["tenant_subscriptions"][0]["status"] == "cancelled"  # terminal


def test_webhook_bad_signature_rejected(env):
    body = json.dumps(_sub_event("subscription.activated", "evt_x")).encode()
    with pytest.raises(HTTPException) as exc:
        asyncio.run(billing.razorpay_webhook(_FakeRequest(body, "bad-signature")))
    assert exc.value.status_code == 400
    assert env.tables.get("razorpay_webhook_events", []) == []  # nothing stored


def test_unlinked_plan_conflict(env):
    env.tables["subscription_plans"] = [
        {"code": "solo", "name": "Solo", "monthly_price_inr": 1299,
         "whatsapp_numbers": 1, "razorpay_plan_id": None, "active": True},
    ]
    with pytest.raises(HTTPException) as exc:
        _create()
    assert exc.value.status_code == 409
    assert _FakeRazorpayClient.calls == []
