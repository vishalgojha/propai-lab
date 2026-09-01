from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .requirement_listing_matcher import cap_matches, market_slug, score_candidate


def _rows(result: Any) -> list[dict[str, Any]]:
    return list(getattr(result, "data", None) or [])


def _load_listings(storage: Any, tenant_id: str, requirements: list[dict[str, Any]]) -> list[dict[str, Any]]:
    type_pairs = {
        (str(row.get("req_type") or "").split("_", 1)[0], str(row.get("req_type") or "").split("_", 1)[1])
        for row in requirements
        if "_" in str(row.get("req_type") or "")
    }
    listings: list[dict[str, Any]] = []
    for asset, transaction in type_pairs:
        listings.extend(_rows(storage.client.table("listings_unified_matching").select("*").eq(
            "tenant_id", tenant_id
        ).eq("asset_type", asset).eq("transaction_type", transaction).limit(2000).execute()))
    return listings


def _run_requirements(storage: Any, tenant_id: str, requirements: list[dict[str, Any]], minimum: float, distinct_cap: int) -> dict[str, int]:
    listings = _load_listings(storage, tenant_id, requirements)
    inserted = 0
    groups = 0
    now = datetime.now(timezone.utc).isoformat()
    for requirement in requirements:
        candidates = []
        req_market = market_slug(requirement.get("micro_market"))
        for listing in listings:
            listing_market = str(listing.get("canonical_micro_market_slug") or market_slug(listing.get("locality_resolved")) or "").lower() or None
            area = listing.get("carpet_area_sqft")
            req_min, req_max = requirement.get("carpet_area_min_sqft"), requirement.get("carpet_area_max_sqft")
            if req_market and listing_market and req_market != listing_market and not requirement.get("building_name"):
                continue
            if area and (req_min or req_max):
                try:
                    lo = float(req_min or req_max) * 0.8; hi = float(req_max or req_min) * 1.2
                    if not lo <= float(area) <= hi:
                        continue
                except (TypeError, ValueError):
                    pass
            scored = score_candidate(requirement, listing)
            if scored:
                candidates.append(scored)
        selected = cap_matches(candidates, distinct_cap, minimum)
        # A listing can arrive through more than one compatible type-pair
        # query. Keep the best-ranked occurrence once per requirement/listing
        # pair before sending the batch to PostgREST; duplicate rows in one
        # upsert batch trigger a 409 conflict even with the unique index.
        unique_selected = []
        seen_pairs = set()
        for match in selected:
            pair = (match.get("requirement_id"), match.get("listing_id"))
            if pair in seen_pairs:
                continue
            seen_pairs.add(pair)
            unique_selected.append(match)
        selected = unique_selected
        # A rerun is authoritative for the requirement: remove stale rows
        # before writing the current top-N set. Typed IDs are the source of
        # truth; legacy_source_id may be absent in the current typed tables.
        requirement_type = requirement.get("req_type")
        requirement_typed_id = requirement.get("id")
        if requirement_type and requirement_typed_id is not None:
            storage.client.table("requirement_matches").delete().eq(
                "tenant_id", tenant_id
            ).eq("requirement_type", requirement_type).eq(
                "requirement_typed_id", requirement_typed_id
            ).execute()
        if selected:
            groups += 1
            payload = [{k: match[k] for k in ("match_score", "bhk_match", "market_match", "price_match", "building_match", "intent_match")} | {
                "requirement_id": requirement.get("matching_id"),
                "listing_id": match["listing"].get("matching_id"),
                "requirement_type": requirement_type,
                "requirement_typed_id": requirement_typed_id,
                "listing_type": match["listing"].get("card_type"),
                "listing_typed_id": match["listing"].get("id"),
                "matched_at": now,
                "tenant_id": tenant_id,
            } for match in selected if match["listing"].get("card_type") and match["listing"].get("id") is not None]
            storage.client.table("requirement_matches").upsert(
                payload,
                on_conflict="tenant_id,requirement_type,requirement_typed_id,listing_type,listing_typed_id",
            ).execute()
            inserted += len(payload)
    return {"requirements_scanned": len(requirements), "match_rows_written": inserted, "requirements_with_matches": groups}


def run_requirement(storage: Any, tenant_id: str, requirement_id: int, req_type: str | None = None, minimum: float = 50, distinct_cap: int = 5) -> dict[str, int]:
    """Match one newly-created or edited requirement immediately."""
    requirements_query = storage.client.table("requirements_unified_matching").select("*").eq(
        "tenant_id", tenant_id
    ).eq("id", requirement_id).in_("status", ["active", "open", "pending"])
    if req_type:
        requirements_query = requirements_query.eq("req_type", req_type)
    requirements = _rows(requirements_query.limit(1).execute())
    return _run_requirements(storage, tenant_id, requirements, minimum, distinct_cap)


def run_sample(storage: Any, tenant_id: str, req_type: str | None = None, limit_requirements: int = 50, minimum: float = 50, distinct_cap: int = 5) -> dict[str, int]:
    requirements_query = storage.client.table("requirements_unified_matching").select("*").eq(
        "tenant_id", tenant_id
    ).in_("status", ["active", "open", "pending"]).order(
        "created_at", desc=True
    ).limit(min(limit_requirements, 250))
    if req_type:
        requirements_query = requirements_query.eq("req_type", req_type)
    requirements = _rows(requirements_query.execute())
    return _run_requirements(storage, tenant_id, requirements, minimum, distinct_cap)
