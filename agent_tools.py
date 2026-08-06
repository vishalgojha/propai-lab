"""Supabase-backed tools for the workspace AI agent.

This module deliberately keeps tool schemas separate from the LLM adapter.
Reads execute immediately; writes always return a signed confirmation token
until the confirmation endpoint explicitly approves them.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import time
from typing import Any


READ_TOOL_NAMES = frozenset({
    "search_listings",
    "get_client_requirements",
    "match_client_to_listings",
    "get_broker_profile",
})
WRITE_TOOL_NAMES = frozenset({
    "create_client_property_candidate",
    "create_lead",
    "log_internal_note",
})


def _function(name: str, description: str, properties: dict, required: list[str]) -> dict:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": required,
                "additionalProperties": False,
            },
        },
    }


TOOL_DEFINITIONS = [
    _function(
        "search_listings",
        "Search fresh, tenant-scoped residential or commercial listings. Use this for inventory questions instead of guessing from prompt context.",
        {
            "locality": {"type": "string", "description": "Locality or micro-market, such as Bandra East"},
            "bhk": {"type": "number", "description": "BHK number; omit for any configuration"},
            "price_min": {"type": "number", "description": "Minimum absolute price or monthly rent"},
            "price_max": {"type": "number", "description": "Maximum absolute price or monthly rent"},
            "listing_type": {"type": "string", "enum": ["rent", "sale"]},
            "property_type": {"type": "string", "enum": ["residential", "commercial"]},
        },
        ["locality", "listing_type", "property_type"],
    ),
    _function(
        "get_client_requirements",
        "Read the saved requirements for one workspace client.",
        {"client_id": {"type": "string", "description": "Client ID"}},
        ["client_id"],
    ),
    _function(
        "match_client_to_listings",
        "Compare a client's saved primary requirement against fresh listings and return explainable matches.",
        {"client_id": {"type": "string", "description": "Client ID"}},
        ["client_id"],
    ),
    _function(
        "get_broker_profile",
        "Read a tenant-scoped broker profile and activity summary.",
        {"broker_id": {"type": "string", "description": "Broker ID"}},
        ["broker_id"],
    ),
    _function(
        "create_client_property_candidate",
        "Propose saving a listing as a candidate for a client. This always requires user confirmation before writing.",
        {
            "client_id": {"type": "string"},
            "listing_id": {"type": "string"},
            "notes": {"type": "string"},
        },
        ["client_id", "listing_id", "notes"],
    ),
    _function(
        "create_lead",
        "Propose creating a lead for a client from a listing. This always requires user confirmation before writing.",
        {
            "listing_id": {"type": "integer", "description": "Typed listing ID; required by the leads table"},
            "client_id": {"type": "integer", "description": "Optional client ID when a workspace client is resolved"},
            "source": {"type": "string"},
            "notes": {"type": "string"},
        },
        ["listing_id", "source", "notes"],
    ),
    _function(
        "log_internal_note",
        "Propose adding an internal workspace note. This always requires user confirmation before writing.",
        {
            "entity_type": {"type": "string"},
            "entity_id": {"type": "string"},
            "note": {"type": "string"},
            "author_id": {"type": "string"},
        },
        ["entity_type", "entity_id", "note", "author_id"],
    ),
]


def _json(value: Any) -> str:
    return json.dumps(value, default=str, separators=(",", ":"))


def _number(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _clean_phone(value: Any) -> str:
    """Return a clean Indian phone number, never a WhatsApp JID."""
    digits = re.sub(r"\D+", "", str(value or ""))
    if len(digits) >= 12 and digits.startswith("91"):
        digits = digits[-10:]
    return digits if len(digits) == 10 else ""


def _clean_broker_name(value: Any, fallback: Any = None) -> str:
    """Hide raw WhatsApp JIDs and phone numbers from listing cards."""
    for candidate in (value, fallback):
        text = str(candidate or "").strip()
        if not text or "@s.whatsapp.net" in text.lower():
            continue
        if len(re.sub(r"\D+", "", text)) >= 10:
            continue
        return text
    return "Broker"


def _tenant_query(client: Any, table: str, tenant_id: str | None, columns: str):
    query = client.table(table).select(columns)
    if tenant_id:
        query = query.eq("tenant_id", tenant_id)
    return query


def _client_row(client: Any, client_id: str, tenant_id: str | None) -> dict | None:
    query = _tenant_query(client, "clients", tenant_id, "id,name,phone,email,notes,status")
    rows = query.eq("id", client_id).limit(1).execute().data or []
    return rows[0] if rows else None


def _listing_query(client: Any, args: dict, tenant_id: str | None) -> list[dict]:
    locality = str(args.get("locality") or "").strip()
    listing_type = str(args.get("listing_type") or "rent").lower()
    property_type = str(args.get("property_type") or "residential").lower()
    table = f"{property_type}_{listing_type}_listings"
    price_column = "monthly_rent" if listing_type == "rent" else "total_asking_price"
    price_alias = "monthly_rent" if listing_type == "rent" else "total_asking_price"
    unit_price_column = "rent_per_sqft" if listing_type == "rent" else "price_per_sqft"
    columns = (
        "id,legacy_source_id,raw_message_id,building_name,micro_market,landmark_name,"
        "broker_id,broker_name,broker_phone,bhk,transaction_type,carpet_area_sqft,"
        f"{price_column},{unit_price_column},created_at,needs_review"
    )
    query = _tenant_query(client, table, tenant_id, columns).ilike("micro_market", f"%{locality}%")
    bhk = _number(args.get("bhk"))
    if bhk is not None:
        # BHK is a discrete configuration, not a text search. Searching for
        # `3` must not also return 3.5 BHK rows, while stored `3.0` values
        # remain equivalent to the user's `3 BHK` request.
        bhk_text = f"{bhk:g}"
        if bhk.is_integer():
            query = query.or_(f"bhk.eq.{bhk_text},bhk.eq.{bhk_text}.0")
        else:
            query = query.eq("bhk", bhk_text)
    minimum = _number(args.get("price_min"))
    maximum = _number(args.get("price_max"))
    if minimum is not None:
        query = query.gte(price_column, minimum)
    if maximum is not None:
        query = query.lte(price_column, maximum)
    rows = query.eq("needs_review", False).order("created_at", desc=True).limit(50).execute().data or []
    broker_ids = {row.get("broker_id") for row in rows if row.get("broker_id") is not None}
    broker_profiles = {}
    if broker_ids:
        try:
            profiles = (
                client.table("brokers")
                .select("id,canonical_name,primary_phone")
                .in_("id", list(broker_ids))
                .execute()
                .data
                or []
            )
            broker_profiles = {row.get("id"): row for row in profiles}
        except Exception:
            broker_profiles = {}
    for row in rows:
        row["listing_id"] = str(row.get("id"))
        row["legacy_listing_id"] = str(row.get("legacy_source_id")) if row.get("legacy_source_id") else None
        row["price"] = row.get(price_alias)
        row["property_type"] = property_type
        row["listing_type"] = listing_type
        profile = broker_profiles.get(row.get("broker_id"), {})
        row["broker_phone"] = _clean_phone(row.get("broker_phone")) or _clean_phone(profile.get("primary_phone"))
        row["broker_name"] = _clean_broker_name(row.get("broker_name"), profile.get("canonical_name"))
    return rows


def _active_requirement(client: Any, client_id: str, tenant_id: str | None) -> dict | None:
    query = _tenant_query(
        client,
        "client_requirements",
        tenant_id,
        "id,client_id,intent,bhk,price_min,price_max,micro_market,building_name,"
        "area_sqft_min,area_sqft_max,furnishing,use_type,landmarks,must_have,"
        "nice_to_have,notes,is_primary,created_at,updated_at",
    )
    rows = query.eq("client_id", client_id).order("is_primary", desc=True).order("updated_at", desc=True).limit(20).execute().data or []
    return rows[0] if rows else None


def _typed_listing_row(client: Any, listing_id: Any, tenant_id: str) -> dict | None:
    """Resolve a listing ID across the four tenant-scoped typed tables."""
    try:
        numeric_id = int(listing_id)
    except (TypeError, ValueError):
        return None
    matches = []
    for table in (
        "residential_rent_listings",
        "residential_sale_listings",
        "commercial_rent_listings",
        "commercial_sale_listings",
    ):
        rows = (
            client.table(table)
            .select("id,tenant_id")
            .eq("id", numeric_id)
            .eq("tenant_id", tenant_id)
            .limit(1)
            .execute()
            .data
            or []
        )
        matches.extend(rows)
    return matches[0] if len(matches) == 1 else None


def _confirmation_secret() -> bytes:
    secret = os.getenv("PROPAI_AGENT_CONFIRMATION_SECRET") or os.getenv("SUPABASE_JWT_SECRET")
    if not secret:
        raise RuntimeError("PROPAI_AGENT_CONFIRMATION_SECRET is required for write confirmations")
    return secret.encode()


def make_confirmation_token(tool_name: str, args: dict, tenant_id: str | None, user_id: str | None) -> str:
    payload = {"tool": tool_name, "args": args, "tenant_id": tenant_id, "user_id": user_id, "exp": int(time.time()) + 900}
    body = base64.urlsafe_b64encode(_json(payload).encode()).decode().rstrip("=")
    signature = hmac.new(_confirmation_secret(), body.encode(), hashlib.sha256).hexdigest()
    return f"{body}.{signature}"


def _read_confirmation_token(token: str, tenant_id: str | None, user_id: str | None) -> tuple[str, dict]:
    try:
        body, signature = token.split(".", 1)
        expected = hmac.new(_confirmation_secret(), body.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            raise ValueError("invalid confirmation signature")
        decoded = base64.urlsafe_b64decode(body + "=" * (-len(body) % 4))
        payload = json.loads(decoded)
    except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ValueError("invalid confirmation token") from exc
    if int(payload.get("exp") or 0) < int(time.time()):
        raise ValueError("confirmation expired")
    if str(payload.get("tenant_id") or "") != str(tenant_id or "") or str(payload.get("user_id") or "") != str(user_id or ""):
        raise ValueError("confirmation does not belong to this user/workspace")
    return str(payload.get("tool") or ""), dict(payload.get("args") or {})


def _pending(tool_name: str, args: dict, tenant_id: str | None, user_id: str | None) -> dict:
    return {
        "status": "pending_confirmation",
        "tool": tool_name,
        "message": f"I’m ready to run {tool_name.replace('_', ' ')}, but this changes workspace data. Please confirm.",
        "confirmation_token": make_confirmation_token(tool_name, args, tenant_id, user_id),
        "args": args,
    }


def execute_tool(
    name: str,
    args: dict,
    client: Any,
    tenant_id: str | None,
    *,
    user_id: str | None = None,
    confirmed: bool = False,
) -> dict:
    if name not in READ_TOOL_NAMES and name not in WRITE_TOOL_NAMES:
        return {"status": "error", "error": f"Unknown agent tool: {name}"}
    if not tenant_id:
        return {"status": "error", "error": "An active workspace is required for agent tools"}
    if name in WRITE_TOOL_NAMES and not confirmed:
        return _pending(name, args, tenant_id, user_id)

    if name == "search_listings":
        return {"status": "ok", "tool": name, "results": _listing_query(client, args, tenant_id)}

    if name == "get_client_requirements":
        if not _client_row(client, str(args.get("client_id") or ""), tenant_id):
            return {"status": "not_found", "client_id": args.get("client_id")}
        query = _tenant_query(
            client,
            "client_requirements",
            tenant_id,
            "id,client_id,intent,bhk,price_min,price_max,micro_market,building_name,"
            "area_sqft_min,area_sqft_max,furnishing,use_type,landmarks,must_have,"
            "nice_to_have,notes,is_primary,created_at,updated_at,building_grade_preference,"
            "sourcing_preference,possession_timeline",
        )
        rows = query.eq("client_id", str(args.get("client_id"))).order("is_primary", desc=True).limit(20).execute().data or []
        return {"status": "ok", "tool": name, "requirements": rows}

    if name == "match_client_to_listings":
        client_id = str(args.get("client_id") or "")
        if not _client_row(client, client_id, tenant_id):
            return {"status": "not_found", "client_id": client_id}
        requirement = _active_requirement(client, client_id, tenant_id)
        if not requirement:
            return {"status": "ok", "client_id": client_id, "matches": [], "reason": "no_saved_requirement"}
        intent = str(requirement.get("intent") or "rent").lower()
        listing_type = "rent" if intent in {"rent", "lease", "pre_leased"} else "sale"
        rows = _listing_query(client, {
            "locality": requirement.get("micro_market") or "",
            "bhk": requirement.get("bhk"),
            "price_min": requirement.get("price_min"),
            "price_max": requirement.get("price_max"),
            "listing_type": listing_type,
            "property_type": "commercial" if str(requirement.get("use_type") or "").lower() in {"office", "shop", "retail", "commercial"} else "residential",
        }, tenant_id)
        return {"status": "ok", "tool": name, "client_id": client_id, "requirement": requirement, "matches": rows}

    if name == "get_broker_profile":
        query = _tenant_query(client, "brokers", tenant_id, "id,canonical_name,primary_phone,observation_count,listing_count,requirement_count,rental_count,commercial_count,group_count,market_count,building_count,active_days_30,avg_ticket,is_hidden,created_at,updated_at")
        rows = query.eq("id", str(args.get("broker_id") or "")).limit(1).execute().data or []
        return {"status": "ok", "tool": name, "profile": rows[0] if rows else None}

    if name == "create_client_property_candidate":
        client_id = str(args.get("client_id") or "")
        listing_id = str(args.get("listing_id") or "")
        client_row = _client_row(client, client_id, tenant_id)
        if not client_row:
            return {"status": "not_found", "client_id": client_id}
        legacy = _tenant_query(client, "listings_legacy", tenant_id, "id,building_name,micro_market,bhk,price,price_unit,area_sqft,furnishing,latest_raw_message_id,created_at").eq("id", listing_id).limit(1).execute().data or []
        if not legacy:
            return {"status": "not_found", "listing_id": listing_id, "reason": "listing_legacy_fk_required"}
        row = legacy[0]
        inserted = client.table("client_property_candidates").insert({
            "client_id": client_id,
            "listing_id": row["id"],
            "message_id": row.get("latest_raw_message_id"),
            "building_name": row.get("building_name"),
            "micro_market": row.get("micro_market"),
            "bhk": row.get("bhk"),
            "price": row.get("price"),
            "price_unit": row.get("price_unit"),
            "area_sqft": row.get("area_sqft"),
            "furnishing": row.get("furnishing"),
            "source_text": row.get("building_name") or row.get("micro_market") or "",
            "notes": str(args.get("notes") or "").strip(),
            "status": "pending",
            "tenant_id": tenant_id,
            "source_timestamp": row.get("created_at"),
        }).execute().data or []
        return {"status": "ok", "tool": name, "candidate": inserted[0] if inserted else None}

    if name == "create_lead":
        listing_id = args.get("listing_id")
        listing = _typed_listing_row(client, listing_id, tenant_id)
        if not listing:
            return {"status": "not_found", "listing_id": listing_id, "reason": "listing_id must resolve to exactly one typed listing in this workspace"}
        client_id = args.get("client_id")
        client_row = None
        if client_id not in (None, ""):
            client_row = _client_row(client, str(client_id), tenant_id)
            if not client_row:
                return {"status": "not_found", "client_id": client_id}
        inserted = client.table("leads").insert({
            "listing_id": int(listing_id),
            "client_id": int(client_id) if client_id not in (None, "") else None,
            "client_name": client_row.get("name") if client_row else None,
            "client_phone": client_row.get("phone") if client_row else None,
            "message": str(args.get("notes") or "").strip(),
            "source": str(args.get("source") or "agent").strip() or "agent",
            "tenant_id": tenant_id,
        }).execute().data or []
        return {"status": "ok", "tool": name, "lead": inserted[0] if inserted else None}

    if name == "log_internal_note":
        try:
            author_id = int(args.get("author_id"))
        except (TypeError, ValueError):
            return {"status": "error", "tool": name, "error": "author_id must be a numeric team member ID"}
        inserted = client.table("internal_notes").insert({
            "entity_type": str(args.get("entity_type") or "").strip(),
            "entity_id": str(args.get("entity_id") or "").strip(),
            "author_id": author_id,
            "mentioned_member_ids": [],
            "body": str(args.get("note") or "").strip(),
            "tenant_id": tenant_id,
        }).execute().data or []
        return {"status": "ok", "tool": name, "note": inserted[0] if inserted else None}

    return {"status": "error", "error": "Unhandled agent tool"}


def confirm_tool(token: str, client: Any, tenant_id: str | None, user_id: str | None) -> dict:
    name, args = _read_confirmation_token(token, tenant_id, user_id)
    if name not in WRITE_TOOL_NAMES:
        raise ValueError("only write tools can be confirmed")
    return execute_tool(name, args, client, tenant_id, user_id=user_id, confirmed=True)
