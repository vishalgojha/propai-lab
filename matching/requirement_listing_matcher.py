"""Pure, tenant-safe scoring for requirement/listing matches."""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

from location import canonical_micro_market_slug
from price_plausibility import price_total_from_psf

REQ_TYPES = {
    "residential_rent": ("residential", "rent"),
    "residential_sale": ("residential", "sale"),
    "commercial_rent": ("commercial", "rent"),
    "commercial_sale": ("commercial", "sale"),
}


def normalize_bhk(value: Any) -> int | float | None:
    if value is None:
        return None
    match = re.search(r"\d+(?:\.\d+)?", str(value))
    if not match:
        return None
    number = float(match.group())
    return int(number) if number.is_integer() else number


def normalize_bhks(values: Any) -> set[int | float]:
    if not isinstance(values, (list, tuple)):
        values = [values]
    return {value for item in values if (value := normalize_bhk(item)) is not None}


def market_slug(value: Any) -> str | None:
    if not value:
        return None
    raw = str(value).strip()
    try:
        resolved = canonical_micro_market_slug(raw)
    except Exception:
        resolved = None
    if resolved:
        return str(resolved).strip().lower()
    return re.sub(r"[^a-z0-9]+", "-", raw.lower()).strip("-") or None


def listing_price(listing: dict[str, Any]) -> tuple[float | None, bool]:
    raw = listing.get("price")
    rate = listing.get("price_per_sqft")
    area = listing.get("carpet_area_sqft") or listing.get("area_sqft")
    model = str(listing.get("price_model") or "").lower()
    try:
        raw_value = float(raw) if raw is not None else None
        rate_value = float(rate) if rate is not None else None
        area_value = float(area) if area is not None else None
    except (TypeError, ValueError):
        return None, False
    if model == "psf" and rate_value and area_value:
        return price_total_from_psf(raw_value, rate_value, area_value)
    return raw_value, False


DEFAULT_POLICY = {
    "minimum_score": 50.0,
    "max_matches": 5,
    "freshness_days": 30,
    "area_tolerance_percent": 20.0,
    "budget_tolerance_percent": 0.0,
    "allow_missing_bhk": False,
    "allow_missing_price": True,
    "allow_missing_area": True,
    "enabled": True,
}


def score_candidate(
    requirement: dict[str, Any],
    listing: dict[str, Any],
    policy: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    policy = {**DEFAULT_POLICY, **(policy or {})}
    # Missing tenant identity is never a wildcard. NULL must not match NULL;
    # an unscoped requirement is unsafe to use for cross-tenant matching.
    requirement_tenant = requirement.get("tenant_id")
    listing_tenant = listing.get("tenant_id")
    if not requirement_tenant or not listing_tenant or listing_tenant != requirement_tenant:
        return None
    status = str(requirement.get("status") or "active").lower()
    if status not in {"active", "open", "pending"}:
        return None
    req_type = REQ_TYPES.get(str(requirement.get("req_type") or "").lower())
    if not req_type or (listing.get("asset_type"), listing.get("transaction_type")) != req_type:
        return None
    listing_status = str(listing.get("status") or listing.get("lifecycle_status") or "active").lower()
    if listing_status not in {"active", "open", "available", "listed"}:
        return None
    if listing.get("needs_review") is True or str(listing.get("extraction_confidence") or "").lower() == "low":
        return None
    expires = listing.get("expires_at")
    if expires:
        try:
            if datetime.fromisoformat(str(expires).replace("Z", "+00:00")) <= datetime.now(timezone.utc):
                return None
        except ValueError:
            pass
    freshness_value = listing.get("updated_at") or listing.get("created_at")
    if freshness_value:
        try:
            age_days = (datetime.now(timezone.utc) - datetime.fromisoformat(str(freshness_value).replace("Z", "+00:00"))).total_seconds() / 86400
            if age_days > max(1, int(policy["freshness_days"] or 30)):
                return None
        except (TypeError, ValueError):
            pass
    req_market = market_slug(requirement.get("micro_market"))
    listing_market = str(listing.get("canonical_micro_market_slug") or market_slug(listing.get("locality_resolved")) or "").lower() or None
    building_requested = bool(str(requirement.get("building_name") or "").strip())
    building_match = None if not building_requested else str(requirement["building_name"]).strip().lower() == str(listing.get("building_name") or "").strip().lower()
    market_match = bool(req_market and listing_market and req_market == listing_market) or bool(building_match)
    if building_requested and not building_match:
        return None
    if req_market and not market_match:
        return None
    bhk_options = normalize_bhks(requirement.get("bhk_options"))
    listing_bhk = normalize_bhk(listing.get("bhk"))
    bhk_match = bool(bhk_options and listing_bhk in bhk_options)
    if bhk_options and not bhk_match and not policy["allow_missing_bhk"]:
        return None
    price, implausible = listing_price(listing)
    low, high = requirement.get("budget_min"), requirement.get("budget_max")
    try:
        low = float(low) if low is not None else None
        high = float(high) if high is not None else low
    except (TypeError, ValueError):
        low = high = None
    price_match = None
    if price is not None and high is not None and high > 0 and not implausible:
        tolerance = max(0.0, float(policy["budget_tolerance_percent"] or 0)) / 100
        lower_bound = low * (1 - tolerance) if low is not None else None
        upper_bound = high * (1 + tolerance)
        if lower_bound is None or lower_bound <= price <= upper_bound:
            price_match = 0.0
        else:
            price_match = abs(price - (lower_bound if price < lower_bound else upper_bound)) / high
            return None
    elif low is not None and not policy["allow_missing_price"]:
        return None
    req_min, req_max = requirement.get("carpet_area_min_sqft"), requirement.get("carpet_area_max_sqft")
    area = listing.get("carpet_area_sqft") or listing.get("area_sqft")
    area_match = None
    if req_min is not None or req_max is not None:
        try:
            lower = float(req_min if req_min is not None else req_max)
            upper = float(req_max if req_max is not None else req_min)
            tolerance = max(0.0, float(policy["area_tolerance_percent"] or 0)) / 100
            if area is None:
                if not policy["allow_missing_area"]:
                    return None
            elif not lower * (1 - tolerance) <= float(area) <= upper * (1 + tolerance):
                return None
            else:
                area_match = True
        except (TypeError, ValueError):
            pass
    applicable = [(market_match, 20), (bhk_match if bhk_options else None, 25)]
    if building_requested:
        applicable.append((bool(building_match), 30))
    if low is not None and price_match is not None:
        applicable.append((max(0.0, 1.0 - min(price_match, 1.0)), 25))
    if area_match is not None:
        applicable.append((area_match, 10))
    applicable = [(value, weight) for value, weight in applicable if value is not None]
    total_weight = sum(weight for _, weight in applicable) or 1
    score = sum((float(value) if isinstance(value, (int, float)) else float(bool(value))) * weight for value, weight in applicable) / total_weight * 100
    if implausible:
        score *= 0.8
    return {
        "requirement_id": requirement.get("id"), "listing_id": listing.get("id"),
        "match_score": round(score, 2), "bhk_match": bhk_match, "market_match": market_match,
        "price_match": price_match, "building_match": building_match, "intent_match": True,
        "price_implausible": implausible, "broker_id": listing.get("broker_id"),
        "building_name": listing.get("building_name"), "listing": listing,
        "match_reasons": [label for ok, label in (
            (building_match, "building"), (market_match, "market"),
            (bhk_match if bhk_options else None, "BHK"),
            (price_match == 0.0 if price_match is not None else None, "budget"),
            (area_match, "area"),
        ) if ok],
        "unknown_fields": [label for ok, label in (
            (listing_bhk if bhk_options else True, "BHK"),
            (price if low is not None else True, "budget"),
            (area if (req_min is not None or req_max is not None) else True, "area"),
        ) if not ok],
    }


def cap_matches(matches: list[dict[str, Any]], cap: int = 5, minimum: float = 50) -> list[dict[str, Any]]:
    chosen, keys = [], set()
    for match in sorted(matches, key=lambda item: item["match_score"], reverse=True):
        if match["match_score"] < minimum:
            continue
        listing = match["listing"]
        # A building is not a unit. Only remove the same typed listing identity;
        # separate flats from one broker/building must remain matchable.
        key = (listing.get("card_type") or listing.get("asset_type"), listing.get("id"))
        if key in keys:
            continue
        keys.add(key); chosen.append(match)
        if len(chosen) >= cap:
            break
    return chosen
