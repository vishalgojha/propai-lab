"""Provider-neutral lead normalization and tenant-local listing matching."""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from typing import Any

from matching.requirement_listing_matcher import cap_matches, score_candidate


def _text(value: Any) -> str:
    return str(value or "").strip()


def _first(payload: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = payload.get(key)
        if value not in (None, ""):
            return _text(value)
    return ""


def _field_data(payload: dict[str, Any]) -> dict[str, str]:
    fields = payload.get("field_data") or payload.get("fields") or []
    result: dict[str, str] = {}
    if isinstance(fields, dict):
        return {str(k).lower(): _text(v) for k, v in fields.items()}
    for item in fields if isinstance(fields, list) else []:
        if not isinstance(item, dict):
            continue
        name = _text(item.get("name") or item.get("key")).lower()
        values = item.get("values")
        value = values[0] if isinstance(values, list) and values else item.get("value")
        if name and value not in (None, ""):
            result[name] = _text(value)
    return result


def _number(value: Any) -> float | None:
    if value in (None, ""):
        return None
    match = re.search(r"\d+(?:\.\d+)?", _text(value).replace(",", ""))
    return float(match.group()) if match else None


def _money(value: Any) -> float | None:
    text = _text(value).lower().replace(",", "")
    number = _number(text)
    if number is None:
        return None
    if re.search(r"\b(?:cr|crore|crores)\b", text):
        return number * 10_000_000
    if re.search(r"\b(?:lakh|lac|lacs)\b", text):
        return number * 100_000
    if re.search(r"\b(?:k|thousand)\b", text):
        return number * 1_000
    return number


def _transaction(text: str, value: str) -> str:
    candidate = value.lower()
    if "rent" in candidate or "lease" in candidate:
        return "rent"
    if "sale" in candidate or "buy" in candidate or "purchase" in candidate:
        return "sale"
    lowered = text.lower()
    return "rent" if any(word in lowered for word in ("rent", "lease", "rental")) else "sale"


def normalize_lead(provider: str, payload: dict[str, Any], lead_id: int = 0) -> dict[str, Any]:
    """Map Meta/portal/webhook variants into one safe lead envelope.

    This is deterministic. Unknown provider fields remain in raw_payload and
    are never silently promoted into a typed requirement.
    """
    fields = _field_data(payload)
    text = _first(payload, "enquiry_text", "message", "description", "notes", "query")
    if not text:
        text = _first(fields, "message", "query", "requirement", "details", "project_interest")
    name = _first(payload, "contact_name", "name", "full_name", "buyer_name") or _first(fields, "full_name", "name", "buyer_name")
    phone = _first(payload, "contact_phone", "phone", "mobile") or _first(fields, "phone_number", "phone", "mobile")
    email = _first(payload, "contact_email", "email") or _first(fields, "email")
    property_reference = _first(payload, "property_reference", "property_id", "listing_id", "project_id") or _first(fields, "property_id", "project")
    location = _first(payload, "micro_market", "locality", "location", "area") or _first(fields, "locality", "location", "area", "preferred_location")
    transaction_value = _first(payload, "transaction_type", "intent", "purpose") or _first(fields, "transaction_type", "intent", "purpose")
    transaction = _transaction(text, transaction_value)
    asset_value = (_first(payload, "asset_type", "property_type") or _first(fields, "asset_type", "property_type") or "residential").lower()
    asset = "commercial" if "commercial" in asset_value or "office" in asset_value or "shop" in asset_value else "residential"
    bhk_value = _first(payload, "bhk", "configuration") or _first(fields, "bhk", "configuration", "bedrooms")
    bhk = _number(bhk_value)
    budget_min = _money(_first(payload, "budget_min", "min_budget", "price_min") or _first(fields, "budget_min", "min_budget", "price_min"))
    budget_max = _money(_first(payload, "budget_max", "budget", "max_budget", "price_max") or _first(fields, "budget_max", "budget", "max_budget", "price_max"))
    if budget_max is None and re.search(r"(?:₹|rs\.?|inr|cr(?:ore)?s?|lakh|lac|k\b)", text, re.I):
        budget_max = _money(text)
    external_id = _first(payload, "external_lead_id", "leadgen_id", "lead_id", "id")
    idempotency_key = external_id or hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()
    parsed = {
        "id": lead_id,
        "tenant_id": payload.get("tenant_id"),
        "req_type": f"{asset}_{transaction}",
        "status": "active",
        "asset_type": asset,
        "transaction_type": transaction,
        "micro_market": location or None,
        "building_name": _first(payload, "building_name", "society", "project_name") or _first(fields, "building_name", "society", "project_name") or None,
        "bhk_options": [bhk] if bhk is not None else [],
        "budget_min": budget_min,
        "budget_max": budget_max,
        "carpet_area_min_sqft": _number(_first(payload, "area_min_sqft", "area") or _first(fields, "area_min_sqft", "area")),
        "carpet_area_max_sqft": _number(_first(payload, "area_max_sqft", "area") or _first(fields, "area_max_sqft", "area")),
    }
    return {
        "provider": provider,
        "external_lead_id": external_id or None,
        "idempotency_key": idempotency_key,
        "contact_name": name or None,
        "contact_phone": phone or None,
        "contact_email": email or None,
        "enquiry_text": text or None,
        "property_reference": property_reference or None,
        "parsed_requirement": parsed,
    }


def match_inbound_lead(storage: Any, tenant_id: str, lead: dict[str, Any], minimum: float = 50, cap: int = 5) -> int:
    requirement = dict(lead.get("parsed_requirement") or {})
    requirement.update({"id": lead.get("id"), "tenant_id": tenant_id, "status": "active"})
    asset, transaction = requirement.get("asset_type"), requirement.get("transaction_type")
    listings = list(getattr(storage.client.table("listings_unified").select("*").eq("tenant_id", tenant_id).eq("asset_type", asset).eq("transaction_type", transaction).limit(2000).execute(), "data", None) or [])
    scored = [score_candidate(requirement, listing) for listing in listings]
    selected = cap_matches([item for item in scored if item], cap=cap, minimum=minimum)
    storage.client.table("inbound_lead_matches").delete().eq("tenant_id", tenant_id).eq("lead_id", lead["id"]).execute()
    if selected:
        rows = [{key: item.get(key) for key in ("lead_id", "listing_id", "match_score", "bhk_match", "market_match", "price_match", "building_match", "intent_match")} for item in selected]
        for row in rows:
            row.update({"lead_id": lead["id"], "tenant_id": tenant_id})
        storage.client.table("inbound_lead_matches").insert(rows).execute()
    storage.client.table("inbound_leads").update({"status": "matched", "processed_at": datetime.now(timezone.utc).isoformat()}).eq("id", lead["id"]).eq("tenant_id", tenant_id).execute()
    return len(selected)
