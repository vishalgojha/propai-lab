from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Depends, Query
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
    minimum_score: float = Field(default=50, ge=0, le=100)
    distinct_cap: int = Field(default=5, ge=1, le=10)


@router.post("/api/auto-matched/run")
async def run_auto_matching(body: RunRequest, _: Any = Depends(require_user), tenant_id: str = Depends(require_tenant)):
    return await asyncio.to_thread(run_sample, storage, tenant_id, body.req_type, body.limit_requirements, body.minimum_score, body.distinct_cap)


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
    groups = []
    for req in requirements:
        rows = [row for row in matches if row.get("requirement_type") == req.get("req_type") and row.get("requirement_typed_id") == req.get("id")]
        groups.append({"requirement": req, "matches": [{"match": row, "listing": listing_by_key.get((row.get("listing_type"), row.get("listing_typed_id")))} for row in rows if listing_by_key.get((row.get("listing_type"), row.get("listing_typed_id")))]})
    return {"requirements": groups, "total_requirements": len(groups), "total_matches": sum(len(g["matches"]) for g in groups)}
