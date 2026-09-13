"""Inbound lead webhooks for Meta and partner portals."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request

from routers.common import require_tenant, require_user, storage
from services.lead_followup import build_followup_draft, priority_for_lead
from services.lead_ingestion import match_inbound_lead, normalize_lead

router = APIRouter(prefix="/api/leads", tags=["lead-ingestion"])


def _shared_key() -> str:
    return os.getenv("LEAD_INGEST_SHARED_SECRET", "").strip()


def _check_shared_key(value: str | None) -> None:
    expected = _shared_key()
    if not expected or not value or not hmac.compare_digest(value, expected):
        raise HTTPException(401, "invalid lead ingestion credential")


def _meta_signature(body: bytes, signature: str | None) -> bool:
    secret = os.getenv("META_APP_SECRET", "").strip()
    if not secret or not signature or not signature.startswith("sha256="):
        return False
    digest = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature[7:], digest)


async def _retrieve_meta_lead(leadgen_id: str) -> dict[str, Any]:
    token = os.getenv("META_PAGE_ACCESS_TOKEN", "").strip()
    if not token:
        return {"leadgen_id": leadgen_id}
    version = os.getenv("META_GRAPH_API_VERSION", "v25.0").strip()
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.get(f"https://graph.facebook.com/{version}/{leadgen_id}", params={"access_token": token})
        response.raise_for_status()
        return response.json()


async def _persist(tenant_id: str, provider: str, payload: dict[str, Any]) -> dict[str, Any]:
    if provider not in {"meta", "magicbricks", "99acres", "website", "manual"}:
        raise HTTPException(400, "unsupported lead provider")
    envelope = normalize_lead(provider, {**payload, "tenant_id": tenant_id})
    existing = storage.client.table("inbound_leads").select("id,status").eq("tenant_id", tenant_id).eq("provider", provider).eq("idempotency_key", envelope["idempotency_key"]).limit(1).execute()
    if getattr(existing, "data", None):
        return {"id": existing.data[0]["id"], "status": "duplicate", "matches": 0}
    row = {**envelope, "tenant_id": tenant_id, "raw_payload": payload}
    result = storage.client.table("inbound_leads").insert(row).execute()
    if not getattr(result, "data", None):
        raise HTTPException(503, "lead could not be persisted")
    lead = result.data[0]
    try:
        count = match_inbound_lead(storage, tenant_id, lead)
        return {"id": lead["id"], "status": "matched", "matches": count}
    except Exception as exc:
        storage.client.table("inbound_leads").update({"status": "failed", "error_message": str(exc)[:500]}).eq("id", lead["id"]).eq("tenant_id", tenant_id).execute()
        raise HTTPException(503, "lead persisted but matching failed") from exc


@router.get("/{provider}/webhook/{tenant_id}")
async def verify_webhook(provider: str, tenant_id: str, hub_mode: str = Query("", alias="hub.mode"), hub_verify_token: str = Query("", alias="hub.verify_token"), hub_challenge: str = Query("", alias="hub.challenge")):
    if provider != "meta" or hub_mode != "subscribe" or not hmac.compare_digest(hub_verify_token, os.getenv("META_LEAD_WEBHOOK_VERIFY_TOKEN", "").strip()):
        raise HTTPException(403, "webhook verification failed")
    return int(hub_challenge) if hub_challenge.isdigit() else hub_challenge


@router.post("/{provider}/webhook/{tenant_id}")
async def receive_webhook(provider: str, tenant_id: str, request: Request, x_propai_ingest_key: str | None = Header(default=None), x_hub_signature_256: str | None = Header(default=None)):
    body = await request.body()
    if provider == "meta":
        if not _meta_signature(body, x_hub_signature_256):
            raise HTTPException(401, "invalid Meta webhook signature")
        parsed = json.loads(body or b"{}")
        results = []
        for entry in parsed.get("entry", []):
            for change in entry.get("changes", []):
                value = change.get("value") or {}
                if value.get("leadgen_id"):
                    lead = await _retrieve_meta_lead(str(value["leadgen_id"]))
                    lead.update({"leadgen_id": value["leadgen_id"], "page_id": value.get("page_id"), "form_id": value.get("form_id"), "ad_id": value.get("ad_id")})
                    results.append(await _persist(tenant_id, provider, lead))
        return {"status": "received", "leads": results}
    _check_shared_key(x_propai_ingest_key)
    payload = json.loads(body or b"{}")
    return await _persist(tenant_id, provider, payload)


@router.post("/{provider}/ingest/{tenant_id}")
async def ingest_normalized(provider: str, tenant_id: str, payload: dict[str, Any], x_propai_ingest_key: str | None = Header(default=None)):
    _check_shared_key(x_propai_ingest_key)
    return await _persist(tenant_id, provider, payload)


@router.get("/inbound")
async def list_inbound_leads(limit: int = Query(50, ge=1, le=200), _: Any = Depends(require_user), tenant_id: str = Depends(require_tenant)):
    rows = list(getattr(storage.client.table("inbound_leads").select("id,provider,external_lead_id,contact_name,contact_phone,contact_email,enquiry_text,property_reference,parsed_requirement,status,error_message,received_at,processed_at").eq("tenant_id", tenant_id).order("received_at", desc=True).limit(limit).execute(), "data", None) or [])
    if not rows:
        return {"leads": [], "count": 0}
    ids = [row["id"] for row in rows]
    matches = list(getattr(storage.client.table("inbound_lead_matches").select("*").eq("tenant_id", tenant_id).in_("lead_id", ids).order("match_score", desc=True).execute(), "data", None) or [])
    listing_ids = list({int(row["listing_id"]) for row in matches if row.get("listing_id") is not None})
    listings = list(getattr(storage.client.table("listings_unified").select("id,title,bhk,building_name,micro_market,transaction_type,price,price_unit,area_sqft,availability_status").eq("tenant_id", tenant_id).in_("id", listing_ids).execute(), "data", None) or []) if listing_ids else []
    listing_by_id = {int(row["id"]): row for row in listings}
    by_lead: dict[Any, list[dict[str, Any]]] = {}
    for match in matches:
        match["listing"] = listing_by_id.get(int(match["listing_id"]))
        by_lead.setdefault(match["lead_id"], []).append(match)
    followups = list(getattr(storage.client.table("inbound_lead_followups").select("*").eq("tenant_id", tenant_id).in_("lead_id", ids).execute(), "data", None) or [])
    followup_by_lead = {row["lead_id"]: row for row in followups}
    for row in rows:
        row["matches"] = by_lead.get(row["id"], [])
        row["priority"] = priority_for_lead(row, row["matches"])
        row["followup"] = followup_by_lead.get(row["id"])
    rows.sort(key=lambda row: str(row.get("received_at") or ""), reverse=True)
    rows.sort(key=lambda row: {"high": 0, "normal": 1, "review": 2, "done": 3}.get(row["priority"], 4))
    return {"leads": rows, "count": len(rows)}


@router.post("/inbound/{lead_id}/draft")
async def create_followup_draft(lead_id: int, body: dict[str, Any] | None = None, user: dict = Depends(require_user), tenant_id: str = Depends(require_tenant)):
    lead_rows = list(getattr(storage.client.table("inbound_leads").select("*").eq("tenant_id", tenant_id).eq("id", lead_id).limit(1).execute(), "data", None) or [])
    if not lead_rows:
        raise HTTPException(404, "lead not found")
    lead = lead_rows[0]
    matches = list(getattr(storage.client.table("inbound_lead_matches").select("*").eq("tenant_id", tenant_id).eq("lead_id", lead_id).order("match_score", desc=True).limit(5).execute(), "data", None) or [])
    requested_listing_id = (body or {}).get("listing_id")
    selected = next((row for row in matches if requested_listing_id and int(row.get("listing_id")) == int(requested_listing_id)), None) or (matches[0] if matches else None)
    listing = None
    if selected:
        listing_rows = list(getattr(storage.client.table("listings_unified").select("id,title,bhk,building_name,micro_market,transaction_type,price,price_unit,area_sqft,availability_status").eq("tenant_id", tenant_id).eq("id", selected["listing_id"]).limit(1).execute(), "data", None) or [])
        listing = listing_rows[0] if listing_rows else None
    draft = build_followup_draft(lead, listing)
    row = {"tenant_id": tenant_id, "lead_id": lead_id, "listing_id": listing.get("id") if listing else None, "draft_text": draft, "status": "drafted", "created_by": user.get("id")}
    result = storage.client.table("inbound_lead_followups").upsert(row, on_conflict="tenant_id,lead_id").execute()
    storage.client.table("inbound_leads").update({"status": "needs_followup"}).eq("tenant_id", tenant_id).eq("id", lead_id).execute()
    return {"followup": (getattr(result, "data", None) or [row])[0], "listing": listing}


@router.post("/inbound/{lead_id}/opened")
async def mark_followup_opened(lead_id: int, _: Any = Depends(require_user), tenant_id: str = Depends(require_tenant)):
    result = storage.client.table("inbound_lead_followups").update({"status": "opened", "opened_at": datetime.now(timezone.utc).isoformat()}).eq("tenant_id", tenant_id).eq("lead_id", lead_id).select("id").execute()
    if not getattr(result, "data", None):
        raise HTTPException(404, "follow-up draft not found")
    return {"ok": True}


@router.post("/inbound/{lead_id}/complete")
async def complete_followup(lead_id: int, body: dict[str, Any], user: dict = Depends(require_user), tenant_id: str = Depends(require_tenant)):
    outcome = str(body.get("outcome") or "contacted").strip()[:80]
    result = storage.client.table("inbound_lead_followups").update({"status": "completed", "outcome": outcome, "completed_at": datetime.now(timezone.utc).isoformat(), "completed_by": user.get("id")}).eq("tenant_id", tenant_id).eq("lead_id", lead_id).select("id").execute()
    if not getattr(result, "data", None):
        raise HTTPException(404, "follow-up draft not found")
    storage.client.table("inbound_leads").update({"status": "contacted" if outcome != "closed" else "closed"}).eq("tenant_id", tenant_id).eq("id", lead_id).execute()
    return {"ok": True, "status": "contacted" if outcome != "closed" else "closed"}
