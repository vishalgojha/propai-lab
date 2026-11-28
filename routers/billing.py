"""Tenant-scoped Razorpay subscription billing."""

import hashlib
import hmac
import json
import os
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field

from routers.common import (
    _require_org_permission,
    get_tenant_context,
    require_user,
    storage,
)

router = APIRouter(tags=["billing"])

PLANS = {
    "solo": {"label": "Solo", "amount": 1299, "numbers": 1, "tier": "starter", "env": "RAZORPAY_PLAN_SOLO"},
    "two_numbers": {"label": "2 numbers", "amount": 1499, "numbers": 2, "tier": "growth", "env": "RAZORPAY_PLAN_TWO_NUMBERS"},
    "three_numbers": {"label": "3 numbers", "amount": 2599, "numbers": 3, "tier": "scale", "env": "RAZORPAY_PLAN_THREE_NUMBERS"},
}


class SubscriptionRequest(BaseModel):
    plan_key: str = Field(min_length=1, max_length=32)


class VerifySubscriptionRequest(BaseModel):
    razorpay_payment_id: str = Field(min_length=5, max_length=80)
    razorpay_subscription_id: str = Field(min_length=5, max_length=80)
    razorpay_signature: str = Field(min_length=20, max_length=128)


def _config() -> tuple[str, str]:
    key_id = os.getenv("RAZORPAY_KEY_ID", "").strip()
    key_secret = os.getenv("RAZORPAY_KEY_SECRET", "").strip()
    if not key_id or not key_secret:
        raise HTTPException(503, "Razorpay billing is not configured yet")
    return key_id, key_secret


def _plan(plan_key: str) -> dict:
    plan = PLANS.get(plan_key)
    if not plan:
        raise HTTPException(400, "Choose a valid PropAI plan")
    plan_id = os.getenv(plan["env"], "").strip()
    if not plan_id:
        raise HTTPException(503, f"Razorpay plan {plan_key} is not configured yet")
    return {**plan, "plan_id": plan_id, "plan_key": plan_key}


def _org_id(tenant_id: str | None) -> str:
    if not tenant_id:
        raise HTTPException(403, "No workspace selected")
    return str(tenant_id)


def _trial_start_at() -> int:
    try:
        trial_days = max(0, int(os.getenv("RAZORPAY_TRIAL_DAYS", "15")))
    except ValueError:
        trial_days = 15
    return int((datetime.now(timezone.utc) + timedelta(days=trial_days)).timestamp())


@router.get("/api/billing/plans")
async def billing_plans(user: dict = Depends(require_user)):
    return {
        "plans": [
            {"key": key, "label": value["label"], "amount": value["amount"], "numbers": value["numbers"]}
            for key, value in PLANS.items()
        ],
        "currency": "INR",
    }


@router.get("/api/billing/status")
async def billing_status(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    org_id = _org_id(tenant_id)
    rows = storage.client.table("billing_subscriptions").select(
        "plan_key,status,razorpay_subscription_id,current_period_end,updated_at"
    ).eq("organization_id", org_id).limit(1).execute().data or []
    row = rows[0] if rows else None
    return {"subscription": row}


@router.post("/api/billing/create-subscription")
async def create_subscription(
    body: SubscriptionRequest,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    org_id = _org_id(tenant_id)
    await _require_org_permission(user, org_id, "manage_billing")
    key_id, key_secret = _config()
    plan = _plan(body.plan_key)
    existing = storage.client.table("billing_subscriptions").select("status").eq("organization_id", org_id).limit(1).execute().data or []
    if existing and existing[0].get("status") in {"active", "authenticated", "pending"}:
        raise HTTPException(409, "This workspace already has an active or pending subscription")
    payload = {
        "plan_id": plan["plan_id"],
        "total_count": 120,
        "start_at": _trial_start_at(),
        "customer_notify": 1,
        "notes": {"organization_id": org_id, "plan_key": body.plan_key},
    }
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(
                "https://api.razorpay.com/v1/subscriptions",
                auth=(key_id, key_secret),
                json=payload,
            )
    except httpx.HTTPError as exc:
        raise HTTPException(502, "Razorpay could not be reached") from exc
    if response.status_code >= 400:
        raise HTTPException(502, "Razorpay rejected the subscription request")
    remote = response.json()
    record = {
        "organization_id": org_id,
        "plan_key": body.plan_key,
        "razorpay_subscription_id": remote["id"],
        "status": remote.get("status", "created"),
        "current_period_end": None,
    }
    storage.client.table("billing_subscriptions").upsert(record, on_conflict="organization_id").execute()
    return {
        "key_id": key_id,
        "subscription_id": remote["id"],
        "plan_key": body.plan_key,
        "amount": plan["amount"],
        "currency": "INR",
    }


@router.post("/api/billing/verify-subscription")
async def verify_subscription(
    body: VerifySubscriptionRequest,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    org_id = _org_id(tenant_id)
    await _require_org_permission(user, org_id, "manage_billing")
    _, key_secret = _config()
    signed = f"{body.razorpay_payment_id}|{body.razorpay_subscription_id}".encode()
    expected = hmac.new(key_secret.encode(), signed, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, body.razorpay_signature):
        raise HTTPException(400, "Razorpay payment verification failed")
    rows = storage.client.table("billing_subscriptions").select("plan_key").eq(
        "organization_id", org_id
    ).eq("razorpay_subscription_id", body.razorpay_subscription_id).limit(1).execute().data or []
    if not rows:
        raise HTTPException(404, "Subscription was not created for this workspace")
    plan = PLANS[rows[0]["plan_key"]]
    storage.client.table("billing_subscriptions").update({
        "status": "authenticated",
        "razorpay_payment_id": body.razorpay_payment_id,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }).eq("organization_id", org_id).eq("razorpay_subscription_id", body.razorpay_subscription_id).execute()
    storage.client.table("organizations").update({"subscription_tier": plan["tier"]}).eq("id", org_id).execute()
    return {"ok": True, "status": "authenticated", "plan_key": rows[0]["plan_key"]}


@router.post("/api/billing/webhook")
async def billing_webhook(
    request: Request,
    x_razorpay_signature: str = Header(default=""),
    x_razorpay_event_id: str = Header(default=""),
):
    secret = os.getenv("RAZORPAY_WEBHOOK_SECRET", "").strip()
    if not secret or not x_razorpay_signature or not x_razorpay_event_id:
        raise HTTPException(503, "Razorpay webhook is not configured")
    raw = await request.body()
    expected = hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, x_razorpay_signature):
        raise HTTPException(400, "Invalid Razorpay webhook signature")
    try:
        payload = json.loads(raw)
        event = str(payload.get("event") or "")
        entity = payload.get("payload", {}).get("subscription", {}).get("entity", {})
        subscription_id = str(entity.get("id") or "")
    except (TypeError, ValueError, AttributeError) as exc:
        raise HTTPException(400, "Invalid Razorpay webhook payload") from exc
    if not subscription_id:
        return {"ok": True}
    existing = storage.client.table("billing_webhook_events").select("id").eq("event_id", x_razorpay_event_id).limit(1).execute().data or []
    if existing:
        return {"ok": True, "duplicate": True}
    storage.client.table("billing_webhook_events").insert({
        "event_id": x_razorpay_event_id,
        "event": event,
        "payload": payload,
    }).execute()
    status_map = {
        "subscription.authenticated": "authenticated",
        "subscription.activated": "active",
        "subscription.charged": "active",
        "subscription.pending": "pending",
        "subscription.halted": "halted",
        "subscription.cancelled": "cancelled",
        "subscription.completed": "completed",
    }
    status = status_map.get(event)
    if status:
        updated = storage.client.table("billing_subscriptions").update({"status": status}).eq(
            "razorpay_subscription_id", subscription_id
        ).select("organization_id,plan_key").execute().data or []
        if updated and status in {"active", "authenticated"}:
            plan = PLANS.get(updated[0].get("plan_key"))
            if plan and updated[0].get("organization_id"):
                storage.client.table("organizations").update({"subscription_tier": plan["tier"]}).eq("id", updated[0]["organization_id"]).execute()
    return {"ok": True}
