from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from .requirement_listing_matcher import DEFAULT_POLICY, cap_matches, market_slug, score_candidate


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


def _run_requirements(storage: Any, tenant_id: str, requirements: list[dict[str, Any]], minimum: float | None, distinct_cap: int | None, preferences: dict[tuple[str, int], dict[str, Any]] | None = None) -> dict[str, int]:
    listings = _load_listings(storage, tenant_id, requirements)
    inserted = 0
    groups = 0
    now = datetime.now(timezone.utc).isoformat()
    for requirement in requirements:
        policy = {**DEFAULT_POLICY, **(preferences or {}).get((requirement.get("req_type"), requirement.get("id")), {})}
        if minimum is not None:
            policy["minimum_score"] = minimum
        if distinct_cap is not None:
            policy["max_matches"] = distinct_cap
        if not policy.get("enabled", True):
            continue
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
                    tolerance = max(0.0, float(policy.get("area_tolerance_percent", 20) or 0)) / 100
                    lo = float(req_min or req_max) * (1 - tolerance); hi = float(req_max or req_min) * (1 + tolerance)
                    if not lo <= float(area) <= hi:
                        continue
                except (TypeError, ValueError):
                    pass
            scored = score_candidate(requirement, listing, policy)
            if scored:
                candidates.append(scored)
        selected = cap_matches(candidates, int(policy["max_matches"]), float(policy["minimum_score"]))
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
                "match_reasons": match.get("match_reasons", []),
                "unknown_fields": match.get("unknown_fields", []),
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


def run_requirement(storage: Any, tenant_id: str, requirement_id: int, req_type: str | None = None, minimum: float | None = None, distinct_cap: int | None = None) -> dict[str, int]:
    """Match one newly-created or edited requirement immediately."""
    requirements_query = storage.client.table("requirements_unified_matching").select("*").eq(
        "tenant_id", tenant_id
    ).eq("id", requirement_id).in_("status", ["active", "open", "pending"])
    if req_type:
        requirements_query = requirements_query.eq("req_type", req_type)
    requirements = _rows(requirements_query.limit(1).execute())
    return _run_requirements(storage, tenant_id, requirements, minimum, distinct_cap, _load_preferences(storage, tenant_id))


def _load_preferences(storage: Any, tenant_id: str) -> dict[tuple[str, int], dict[str, Any]]:
    try:
        rows = _rows(storage.client.table("requirement_match_preferences").select("*").eq("tenant_id", tenant_id).execute())
    except Exception:
        return {}
    return {(str(row.get("requirement_type")), int(row["requirement_typed_id"])): row for row in rows if row.get("requirement_type") and row.get("requirement_typed_id") is not None}


def run_sample(storage: Any, tenant_id: str, req_type: str | None = None, limit_requirements: int = 50, minimum: float | None = None, distinct_cap: int | None = None) -> dict[str, int]:
    requirements_query = storage.client.table("requirements_unified_matching").select("*").eq(
        "tenant_id", tenant_id
    ).in_("status", ["active", "open", "pending"]).order(
        "created_at", desc=True
    ).limit(min(limit_requirements, 250))
    if req_type:
        requirements_query = requirements_query.eq("req_type", req_type)
    requirements = _rows(requirements_query.execute())
    return _run_requirements(storage, tenant_id, requirements, minimum, distinct_cap, _load_preferences(storage, tenant_id))


def run_due(storage: Any, tenant_id: str, limit_requirements: int = 50) -> dict[str, int]:
    """Run only enabled requirements whose persisted cadence is due."""
    requirements_query = storage.client.table("requirements_unified_matching").select("*").eq(
        "tenant_id", tenant_id
    ).in_("status", ["active", "open", "pending"]).order("created_at", desc=True).limit(min(limit_requirements, 250))
    requirements = _rows(requirements_query.execute())
    preferences = _load_preferences(storage, tenant_id)
    now = datetime.now(timezone.utc)
    due = []
    for requirement in requirements:
        policy = preferences.get((requirement.get("req_type"), requirement.get("id")), {})
        if policy.get("enabled", True) is False:
            continue
        next_run = policy.get("next_run_at")
        if next_run:
            try:
                if datetime.fromisoformat(str(next_run).replace("Z", "+00:00")) > now:
                    continue
            except ValueError:
                pass
        due.append(requirement)
    result = _run_requirements(storage, tenant_id, due, None, None, preferences)
    for requirement in due:
        key = (requirement.get("req_type"), requirement.get("id"))
        policy = preferences.get(key, {})
        cadence = max(5, min(1440, int(policy.get("cadence_minutes", 15) or 15)))
        try:
            storage.client.table("requirement_match_preferences").upsert({
                "tenant_id": tenant_id, "requirement_type": key[0], "requirement_typed_id": key[1],
                "next_run_at": (now + timedelta(minutes=cadence)).isoformat(), "last_run_at": now.isoformat(),
                "last_run_status": "ok", "last_run_metrics": result,
            }, on_conflict="tenant_id,requirement_type,requirement_typed_id").execute()
        except Exception:
            pass
    return result
