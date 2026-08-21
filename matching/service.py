from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .requirement_listing_matcher import cap_matches, market_slug, score_candidate


def _rows(result: Any) -> list[dict[str, Any]]:
    return list(getattr(result, "data", None) or [])


def run_sample(storage: Any, tenant_id: str, req_type: str | None = None, limit_requirements: int = 50, minimum: float = 50, distinct_cap: int = 5) -> dict[str, int]:
    requirements_query = storage.client.table("requirements_unified").select("*").eq("tenant_id", tenant_id).in_("status", ["active", "open", "pending"]).limit(min(limit_requirements, 250))
    if req_type:
        requirements_query = requirements_query.eq("req_type", req_type)
    requirements = _rows(requirements_query.execute())
    type_pairs = {(str(r.get("req_type")),) for r in requirements}
    listings: list[dict[str, Any]] = []
    for (kind,) in type_pairs:
        asset, transaction = kind.split("_", 1) if "_" in kind else (None, None)
        if not asset or not transaction:
            continue
        listings.extend(_rows(storage.client.table("listings_unified").select("*").eq("tenant_id", tenant_id).eq("asset_type", asset).eq("transaction_type", transaction).limit(2000).execute()))
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
        # A rerun is authoritative for the bounded requirement sample: remove
        # stale rows before writing the current top-N set.
        storage.client.table("requirement_matches").delete().eq("tenant_id", tenant_id).eq("requirement_id", requirement.get("id")).execute()
        if selected:
            groups += 1
            payload = [{k: match[k] for k in ("requirement_id", "listing_id", "match_score", "bhk_match", "market_match", "price_match", "building_match", "intent_match")} | {"matched_at": now, "tenant_id": tenant_id} for match in selected]
            storage.client.table("requirement_matches").upsert(payload, on_conflict="requirement_id,listing_id").execute()
            inserted += len(payload)
    return {"requirements_scanned": len(requirements), "match_rows_written": inserted, "requirements_with_matches": groups}
