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
    start_at = datetime.now(timezone.utc) + timedelta(days=TRIAL_DAYS)
    payload = {
        "plan_id": plan["razorpay_plan_id"],
        "total_count": 120,
        "start_at": int(start_at.timestamp()),
        "customer_notify": 1,
        "notes": {"tenant_id": tenant_id, "plan_code": body.plan_code},
    }
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
        "start_at": start_at.isoformat(),
        "trial_ends_at": start_at.isoformat(),
        "created_by": user["id"],
    }).execute()
    return {
        "subscription_id": data.get("id"),
        "status": data.get("status"),
        "short_url": data.get("short_url"),
        "trial_ends_at": start_at.isoformat(),
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
    storage.client.table("razorpay_webhook_events").insert({
        "razorpay_event_id": event_id,
        "event_type": event_type,
        "payload": event,
    }).execute()
    subscription = (event.get("payload") or {}).get("subscription", {}).get("entity") or {}
    razorpay_sub_id = subscription.get("id")
    status_map = {
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
        storage.client.table("tenant_subscriptions").update({
            "status": new_status,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).eq("razorpay_subscription_id", razorpay_sub_id).execute()
    return {"received": True}
