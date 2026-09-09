from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from matching.service import run_sample
from routers.common import require_tenant, require_user, storage

router = APIRouter(tags=["auto-matched"])

_REQUIREMENT_FIELDS = (
    "id", "matching_id", "req_type", "building_name", "micro_market", "bhk_options",
    "budget_min", "budget_max", "carpet_area_min_sqft", "carpet_area_max_sqft",
    "status", "created_at",
)
_LISTING_FIELDS = (
    "id", "matching_id", "asset_type", "transaction_type", "building_name", "micro_market",
    "locality_resolved", "summary_title", "price", "price_model", "price_per_sqft",
    "carpet_area_sqft", "area_sqft", "bhk", "furnishing", "needs_review",
    "extraction_confidence", "created_at", "updated_at",
)


class RunRequest(BaseModel):
    req_type: str | None = None
    limit_requirements: int = Field(default=50, ge=1, le=250)
    minimum_score: float | None = Field(default=None, ge=0, le=100)
    distinct_cap: int | None = Field(default=None, ge=1, le=50)


class PreferenceRequest(BaseModel):
    requirement_type: str
    requirement_typed_id: int = Field(ge=1)
    minimum_score: float = Field(default=50, ge=0, le=100)
    max_matches: int = Field(default=5, ge=1, le=50)
    freshness_days: int = Field(default=30, ge=1, le=365)
    area_tolerance_percent: float = Field(default=20, ge=0, le=100)
    budget_tolerance_percent: float = Field(default=0, ge=0, le=100)
    allow_missing_bhk: bool = False
    allow_missing_price: bool = True
    allow_missing_area: bool = True
    enabled: bool = True
    cadence_minutes: int = Field(default=15, ge=5, le=1440)
    notify_enabled: bool = False


class ApprovalRequest(BaseModel):
    item_kind: str
    source_type: str
    source_id: int = Field(ge=1)
    client_id: int | None = Field(default=None, ge=1)
    visibility: str = "workspace_private"
    approved: bool = True


class BucketRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    bucket_kind: str
    client_id: int | None = Field(default=None, ge=1)
    visibility: str = "workspace_private"


@router.post("/api/auto-matched/run")
async def run_auto_matching(body: RunRequest, _: Any = Depends(require_user), tenant_id: str = Depends(require_tenant)):
    return await asyncio.to_thread(run_sample, storage, tenant_id, body.req_type, body.limit_requirements, body.minimum_score, body.distinct_cap)


@router.put("/api/auto-matched/preferences")
async def save_match_preferences(body: PreferenceRequest, _: Any = Depends(require_user), tenant_id: str = Depends(require_tenant)):
    allowed = {"residential_rent", "residential_sale", "commercial_rent", "commercial_sale"}
    if body.requirement_type not in allowed:
        raise HTTPException(status_code=422, detail="Unsupported requirement type")
    payload = body.model_dump()
    payload["tenant_id"] = tenant_id
    result = storage.client.table("requirement_match_preferences").upsert(
        payload, on_conflict="tenant_id,requirement_type,requirement_typed_id"
    ).execute()
    return (getattr(result, "data", None) or [payload])[0]


@router.put("/api/auto-matched/approval")
async def set_matching_approval(body: ApprovalRequest, user: Any = Depends(require_user), tenant_id: str = Depends(require_tenant)):
    if body.item_kind not in {"listing", "requirement"} or body.source_type not in {"residential_rent", "residential_sale", "commercial_rent", "commercial_sale"}:
        raise HTTPException(status_code=422, detail="Invalid matching source")
    if body.visibility not in {"workspace_private", "team", "shared_market"}:
        raise HTTPException(status_code=422, detail="Invalid matching visibility")
    payload = body.model_dump() | {"tenant_id": tenant_id, "owner_user_id": user.get("id"), "approved_by": user.get("id"), "approved_at": None if not body.approved else datetime.now(timezone.utc).isoformat()}
    result = storage.client.table("matching_item_approvals").upsert(payload, on_conflict="tenant_id,item_kind,source_type,source_id").execute()
    return (getattr(result, "data", None) or [payload])[0]


@router.post("/api/auto-matched/buckets")
async def create_matching_bucket(body: BucketRequest, user: Any = Depends(require_user), tenant_id: str = Depends(require_tenant)):
    if body.bucket_kind not in {"listings", "requirements"} or body.visibility not in {"workspace_private", "team", "shared_market"}:
        raise HTTPException(status_code=422, detail="Invalid bucket")
    payload = body.model_dump() | {"tenant_id": tenant_id, "owner_user_id": user.get("id")}
    result = storage.client.table("match_buckets").insert(payload).execute()
    return (getattr(result, "data", None) or [payload])[0]


@router.get("/api/auto-matched/buckets")
async def list_matching_buckets(_: Any = Depends(require_user), tenant_id: str = Depends(require_tenant)):
    result = storage.client.table("match_buckets").select("*").eq("tenant_id", tenant_id).order("updated_at", desc=True).execute()
    return getattr(result, "data", None) or []


@router.post("/api/auto-matched/buckets/{bucket_id}/items")
async def add_matching_bucket_item(bucket_id: int, body: ApprovalRequest, user: Any = Depends(require_user), tenant_id: str = Depends(require_tenant)):
    bucket = storage.client.table("match_buckets").select("id,bucket_kind").eq("tenant_id", tenant_id).eq("id", bucket_id).limit(1).execute()
    if not (getattr(bucket, "data", None) or []):
        raise HTTPException(status_code=404, detail="Bucket not found")
    expected = "listing" if bucket.data[0]["bucket_kind"] == "listings" else "requirement"
    if body.item_kind != expected:
        raise HTTPException(status_code=422, detail=f"This bucket accepts {expected}s")
    payload = {"tenant_id": tenant_id, "bucket_id": bucket_id, "source_type": body.source_type, "source_id": body.source_id, "added_by": user.get("id")}
    result = storage.client.table("match_bucket_items").upsert(payload, on_conflict="bucket_id,source_type,source_id").execute()
    return (getattr(result, "data", None) or [payload])[0]


@router.get("/api/auto-matched")
async def get_auto_matched(_: Any = Depends(require_user), tenant_id: str = Depends(require_tenant), limit: int = Query(default=1000, ge=1, le=2000)):
    matches = list(getattr(storage.client.table("requirement_matches").select("*").eq("tenant_id", tenant_id).order("match_score", desc=True).limit(limit).execute(), "data", None) or [])
    requirements = list(getattr(storage.client.table("requirements_unified_matching").select(",".join(_REQUIREMENT_FIELDS)).eq("tenant_id", tenant_id).in_("status", ["active", "open", "pending"]).order("created_at", desc=True).limit(limit).execute(), "data", None) or [])
    if not requirements:
        return {"requirements": [], "total_requirements": 0, "total_matches": 0}
    listing_keys = {(row.get("listing_type"), row.get("listing_typed_id")) for row in matches}
    listings = []
    for listing_type in {key[0] for key in listing_keys if key[0]}:
        ids = [key[1] for key in listing_keys if key[0] == listing_type and key[1] is not None]
        if ids:
            listings.extend(list(getattr(storage.client.table("listings_unified_matching").select(",".join(_LISTING_FIELDS)).eq("tenant_id", tenant_id).eq("card_type", listing_type).in_("id", ids).execute(), "data", None) or []))
    listing_by_key = {(row.get("card_type"), row.get("id")): row for row in listings}
    preference_rows = list(getattr(storage.client.table("requirement_match_preferences").select("*").eq("tenant_id", tenant_id).execute(), "data", None) or [])
    preferences = {(row.get("requirement_type"), row.get("requirement_typed_id")): row for row in preference_rows}
    groups = []
    for req in requirements:
        rows = [row for row in matches if row.get("requirement_type") == req.get("req_type") and row.get("requirement_typed_id") == req.get("id")]
        groups.append({"requirement": req, "preferences": preferences.get((req.get("req_type"), req.get("id"))), "matches": [{"match": row, "listing": listing_by_key.get((row.get("listing_type"), row.get("listing_typed_id")))} for row in rows if listing_by_key.get((row.get("listing_type"), row.get("listing_typed_id")))]})
    return {"requirements": groups, "total_requirements": len(groups), "total_matches": sum(len(g["matches"]) for g in groups)}
