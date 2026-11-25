"""Razorpay subscription billing for PropAI workspace plans.

Inert by design until live credentials are configured: every route that
touches Razorpay fails closed with 503 when RAZORPAY_KEY_ID/SECRET (or the
webhook secret) are absent. No plan creation, no charges and no billing
enforcement happen here; enforcement wiring is a separate authorized step.
"""

import hashlib
import hmac
import logging
import os
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from routers.common import require_tenant, require_user, storage

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/billing", tags=["billing"])

RAZORPAY_API_BASE = "https://api.razorpay.com/v1"
TRIAL_DAYS = 15

_KEY_ID = os.getenv("RAZORPAY_KEY_ID", "").strip()
_KEY_SECRET = os.getenv("RAZORPAY_KEY_SECRET", "").strip()
_WEBHOOK_SECRET = os.getenv("RAZORPAY_WEBHOOK_SECRET", "").strip()


def _require_keys() -> tuple[str, str]:
    if not _KEY_ID or not _KEY_SECRET:
        raise HTTPException(503, "Billing is not configured yet")
    return _KEY_ID, _KEY_SECRET


def verify_webhook_signature(body: bytes, signature: str, secret: str) -> bool:
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature or "")


class SubscriptionCreate(BaseModel):
    plan_code: str


# Repeat clicks must never mint a second Razorpay subscription: these
# statuses mean an in-flight or live subscription already exists.
_OPEN_SUBSCRIPTION_STATUSES = {"created", "authenticated", "active", "paused"}

# Forward-only status transitions so an out-of-order webhook cannot resurrect
# or wrongly downgrade a subscription (cancelled/expired are terminal).
_ALLOWED_TRANSITIONS = {
    "created": {"authenticated", "active", "halted", "cancelled", "expired"},
    "authenticated": {"active", "halted", "cancelled", "expired"},
    "active": {"halted", "cancelled", "paused", "expired"},
    "paused": {"active", "cancelled", "expired"},
    "halted": {"active", "cancelled", "expired"},
    "cancelled": set(),
    "expired": set(),
}


@router.get("/plans")
async def list_plans(user: dict = Depends(require_user), tenant_id: str = Depends(require_tenant)):
    rows = storage.client.table("subscription_plans").select(
        "code,name,monthly_price_inr,whatsapp_numbers"
    ).eq("active", True).execute().data or []
    return {"plans": rows, "trial_days": TRIAL_DAYS}


@router.get("/subscription")
async def current_subscription(user: dict = Depends(require_user), tenant_id: str = Depends(require_tenant)):
    rows = storage.client.table("tenant_subscriptions").select(
        "plan_code,status,start_at,trial_ends_at,current_period_end,created_at"
    ).eq("tenant_id", tenant_id).order("created_at", desc=True).limit(1).execute().data or []
    return {"subscription": rows[0] if rows else None}


@router.post("/subscriptions", status_code=201)
async def create_subscription(body: SubscriptionCreate, user: dict = Depends(require_user), tenant_id: str = Depends(require_tenant)):
    """Create a Razorpay subscription with a 15-day trial (future start_at).

    The broker completes the token-authorization transaction on the returned
    Razorpay short_url; the first real charge lands at start_at.
    """
    key_id, key_secret = _require_keys()
    plan_rows = storage.client.table("subscription_plans").select(
        "code,name,razorpay_plan_id"
    ).eq("code", body.plan_code).eq("active", True).limit(1).execute().data or []
    plan = plan_rows[0] if plan_rows else None
    if not plan or not plan.get("razorpay_plan_id"):
        raise HTTPException(409, "Plan is not linked to Razorpay yet")
    existing = storage.client.table("tenant_subscriptions").select(
        "id,plan_code,status,short_url,start_at,trial_ends_at"
    ).eq("tenant_id", tenant_id).order("created_at", desc=True).limit(5).execute().data or []
    open_sub = next((row for row in existing if row.get("status") in _OPEN_SUBSCRIPTION_STATUSES), None)
    if open_sub:
        return JSONResponse(status_code=200, content={
            "subscription_id": open_sub.get("id"),
            "status": open_sub["status"],
            "short_url": open_sub.get("short_url"),
            "trial_ends_at": open_sub.get("trial_ends_at"),
            "existing": True,
            "note": "An open subscription already exists for this workspace; no new one was created.",
        })
    # Trial eligibility follows the established commercial intent: only a
    # workspace that has never started its assistant trial gets the 15-day
    # offset. Existing brokers with a started trial are billed from day one.
    org_rows = storage.client.table("organizations").select(
        "mcp_trial_started_at"
    ).eq("id", tenant_id).limit(1).execute().data or []
    trial_already_started = bool(org_rows and org_rows[0].get("mcp_trial_started_at"))
    start_at = None if trial_already_started else datetime.now(timezone.utc) + timedelta(days=TRIAL_DAYS)
    payload = {
        "plan_id": plan["razorpay_plan_id"],
        "total_count": 120,
        "customer_notify": 1,
        "notes": {"tenant_id": tenant_id, "plan_code": body.plan_code},
    }
    if start_at is not None:
        payload["start_at"] = int(start_at.timestamp())
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{RAZORPAY_API_BASE}/subscriptions",
                json=payload,
                auth=(key_id, key_secret),
            )
    except httpx.RequestError:
        logger.exception("Razorpay subscription create failed to reach API")
        raise HTTPException(503, "Could not reach Razorpay")
    if resp.status_code >= 400:
        logger.warning("Razorpay subscription create rejected: status=%s", resp.status_code)
        raise HTTPException(502, "Razorpay rejected the subscription request")
    data = resp.json()
    storage.client.table("tenant_subscriptions").insert({
        "tenant_id": tenant_id,
        "plan_code": body.plan_code,
        "razorpay_subscription_id": data.get("id"),
        "status": data.get("status") or "created",
        "short_url": data.get("short_url"),
        "start_at": start_at.isoformat() if start_at else None,
        "trial_ends_at": start_at.isoformat() if start_at else None,
        "created_by": user["id"],
    }).execute()
    return {
        "subscription_id": data.get("id"),
        "status": data.get("status"),
        "short_url": data.get("short_url"),
        "trial_ends_at": start_at.isoformat() if start_at else None,
        "note": "Complete the verification step on the Razorpay page; the first charge lands only after the trial.",
    }


@router.post("/webhooks/razorpay")
async def razorpay_webhook(request: Request):
    if not _WEBHOOK_SECRET:
        raise HTTPException(503, "Billing webhooks are not configured yet")
    body = await request.body()
    signature = request.headers.get("X-Razorpay-Signature", "")
    if not verify_webhook_signature(body, signature, _WEBHOOK_SECRET):
        raise HTTPException(400, "Invalid webhook signature")
    event = await request.json()
    event_type = str(event.get("event") or "")
    event_id = str(event.get("id") or "") or None
    if event_id:
        seen = storage.client.table("razorpay_webhook_events").select(
            "id"
        ).eq("razorpay_event_id", event_id).limit(1).execute().data or []
        if seen:
            # Replay: acknowledge without reprocessing.
            return {"received": True, "duplicate": True}
    storage.client.table("razorpay_webhook_events").insert({
        "razorpay_event_id": event_id,
        "event_type": event_type,
        "payload": event,
    }).execute()
    subscription = (event.get("payload") or {}).get("subscription", {}).get("entity") or {}
    razorpay_sub_id = subscription.get("id")
    status_map = {
        "subscription.authenticated": "authenticated",
        "subscription.activated": "active",
        "subscription.charged": "active",
        "subscription.halted": "halted",
        "subscription.cancelled": "cancelled",
        "subscription.expired": "expired",
        "subscription.paused": "paused",
        "subscription.resumed": "active",
    }
    new_status = status_map.get(event_type)
    if razorpay_sub_id and new_status:
        current_rows = storage.client.table("tenant_subscriptions").select(
            "status"
        ).eq("razorpay_subscription_id", razorpay_sub_id).limit(1).execute().data or []
        current_status = (current_rows[0].get("status") if current_rows else None) or "created"
        if new_status in _ALLOWED_TRANSITIONS.get(current_status, set()):
            storage.client.table("tenant_subscriptions").update({
                "status": new_status,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }).eq("razorpay_subscription_id", razorpay_sub_id).execute()
        else:
            logger.info(
                "Ignoring out-of-order subscription webhook: current=%s event=%s",
                current_status, event_type,
            )
    return {"received": True}
