"""AI chat, query, and promotion routes."""
import asyncio
import logging
import os
import re
import time
import uuid
from datetime import datetime, timezone
from typing import Any

import json as _json

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from routers.common import (
    storage, require_user, get_tenant_context,
    _doubleword_error_response,
)
from llm import ProviderConfigurationError

_logger = logging.getLogger(__name__)

router = APIRouter(tags=["ai"])

# Placeholders — wired by app.py after real definitions
get_embedder = None
_today_prefix = None

# ── Lazy-imports ───────────────────────────────────────────────────
from lab import ai_chat_engine as chat_engine
from lab.config import ENABLE_AI_PROMO, ENABLE_META_PUBLISHING


# ── SSE helpers ────────────────────────────────────────────────────

def _sse_event(data: dict | str) -> str:
    """Format a single SSE event."""
    payload = _json.dumps(data, default=str) if isinstance(data, dict) else str(data)
    return f"data: {payload}\n\n"


def _to_sse_chunks(response: dict) -> str:
    """Convert a workspace response dict into SSE text for DefaultChatTransport.

    Yields text-start, text-delta, data-*, and text-end events so the
    frontend useChat hook can render both prose and structured listing_cards.
    """
    msg_id = f"msg-{uuid.uuid4().hex[:8]}"
    content = str(response.get("content") or "").strip()
    blocks = response.get("blocks") or []

    # text-start
    yield _sse_event({"type": "text-start", "id": msg_id})

    # text-delta from content string
    if content:
        yield _sse_event({"type": "text-delta", "delta": content, "id": msg_id})

    # Emit each block as appropriate
    for block in blocks:
        block_type = block.get("type", "")
        if block_type == "listing_cards":
            yield _sse_event({
                "type": "data-listing_cards",
                "id": f"cards-{msg_id}",
                "data": {
                    "items": block.get("items") or [],
                    "title": block.get("title", "Active listings"),
                },
            })
        elif block_type in ("summary", "empty_state", "error_state", "greeting"):
            body = block.get("body") or ""
            if body and body != content:
                yield _sse_event({"type": "text-delta", "delta": f"\n\n{body}", "id": msg_id})

    # text-end
    yield _sse_event({"type": "text-end", "id": msg_id})
    yield _sse_event("[DONE]")


def _wrap_sse(response: dict) -> StreamingResponse:
    """Wrap a workspace response as an SSE StreamingResponse."""
    return StreamingResponse(
        _to_sse_chunks(response),
        media_type="text/event-stream",
        headers={
            "cache-control": "no-cache",
            "x-vercel-ai-ui-message-stream": "v1",
            "x-accel-buffering": "no",
        },
    )


def _wrap_chat_response(response: dict, is_inbox: bool = False):
    """Return SSE for /chat, plain JSON for inbox AI panel."""
    if is_inbox:
        return response
    return _wrap_sse(response)


def _preferred_workspace_provider(tenant_id: str | None) -> dict:
    """Resolve workspace-saved credentials before deployment environment keys."""
    try:
        providers = storage.get_llm_providers(tenant_id=tenant_id)
        def value(provider, key: str, default=""):
            if isinstance(provider, dict):
                return provider.get(key, default)
            return getattr(provider, key, default)

        complete = [
            p for p in providers
            if (value(p, "api_key") or "").strip()
            and (value(p, "model_name") or "").strip()
        ]
        active = [p for p in complete if bool(value(p, "is_active", 0))]
        # Legacy workspace rows can contain valid credentials but have a
        # false/NULL active flag. Prefer active rows, but do not discard the
        # only complete workspace provider and silently fall back to Merge.
        candidates = active or complete
        if candidates:
            # The workspace UI normally keeps one active row. Keep this
            # deterministic if legacy data contains more than one.
            candidates.sort(key=lambda p: (str(value(p, "provider_name")).lower() == "merge", str(value(p, "provider_name")).lower()))
            p = candidates[0]
            return {
                "api_key": value(p, "api_key").strip(),
                "model": value(p, "model_name").strip(),
                "base_url": (value(p, "base_url") or "https://api.openai.com/v1").strip().rstrip("/"),
                "provider": value(p, "provider_name"),
            }
    except Exception as exc:
        _logger.warning("Workspace LLM provider lookup failed: %s", exc)

    try:
        import llm as _llm
        providers = list(_llm.get_configured_providers())
        providers.sort(key=lambda p: str(p.get("name", "")).lower() == "merge")
        if providers:
            p = providers[0]
            return {"api_key": p["api_key"], "model": p["model"], "base_url": p["base_url"], "provider": p["name"]}
    except Exception:
        pass
    return {"api_key": "", "model": "", "base_url": "", "provider": "none"}


# ═══════════════════════════════════════════════════════════════════
# Models
# ═══════════════════════════════════════════════════════════════════

class QueryRequest(BaseModel):
    query: str
    k: int = 10


class PromoteRequest(BaseModel):
    observation_id: int
    channel: str = "whatsapp"
    use_ai: bool = False
    fields: dict | None = None
    api_key: str = ""


class ChatRequest(BaseModel):
    messages: list[dict]
    api_key: str = ""
    model: str = ""
    session_id: str = ""
    broker_phone: str = ""
    source: str = ""


# ═══════════════════════════════════════════════════════════════════
# Intent router helpers
# ═══════════════════════════════════════════════════════════════════

_CAPABILITY_SIGNALS = re.compile(
    r"\b(what (?:can|do) you (?:access|see)|"
    r"do you have (?:access to (?:the )?(?:database|data|system)|(?:a )?database (?:access|connection))|"
    r"what (?:data|datasets?|tools?) (?:do you have|can you use|are available)|"
    r"your (?:capabilities?|abilities|features?)|"
    r"what are you able to|"
    r"can you (?:access|write to|modify|delete) (?:the )?(?:database|data|system|tables?))\b",
    re.IGNORECASE,
)


def _has_query_signals(text: str) -> bool:
    lowered = text.lower()
    query_keywords = [
        "bhk", "rent", "buy", "sale", "lease", "price", "budget", "area", "sqft",
        "broker", "agent", "dealer", "builder", "owner",
        "building", "complex", "tower", "society", "project",
        "locality", "market", "area", "neighbourhood", "neighborhood",
        "flat", "apartment", "office", "shop", "property", "commercial",
        "listing", "listings", "properties", "deal", "requirement", "requirements",
        "show", "find", "search", "look", "need", "want",
        "cr", "lakh", "lac", "thousand", "crore",
        "bandra", "andheri", "juhu", "khar", "powai", "malad", "goregaon",
        "santacruz", "vile parle", "dadar", "worli", "lower parel", "bkc", "kalina",
        "lokhandwala", "pali hill", "chembur", "navi mumbai", "thane",
        "duplicate", "merge", "alias",
        "how many", "how much", "count ", "list ", "top ",
        "compare", "versus", "vs",
    ]
    return any(kw in lowered for kw in query_keywords)


# ═══════════════════════════════════════════════════════════════════
# Promote helpers
# ═══════════════════════════════════════════════════════════════════

def _parsed_display_label(parsed: dict) -> str:
    if (parsed.get("asset_type") or "").lower() == "commercial":
        label = parsed.get("commercial_use_type") or parsed.get("property_type") or "Commercial"
        return str(label).replace("_", " ").title()
    bhk = parsed.get("bhk")
    if bhk:
        return bhk
    prop_type = parsed.get("property_type")
    if prop_type:
        return str(prop_type).replace("_", " ").title()
    return "Property"


def _promote_highlights(parsed: dict) -> list[str]:
    highlights = []
    if parsed.get("bhk"):
        highlights.append(f"{parsed['bhk']} configuration")
    if parsed.get("area_sqft"):
        highlights.append(f"{parsed['area_sqft']:,} sqft built-up area")
    if parsed.get("furnishing"):
        highlights.append(f"{parsed['furnishing']}")
    if parsed.get("building_name"):
        highlights.append(f"Located at {parsed['building_name']}")
    if parsed.get("landmark_name"):
        highlights.append(f"Near {parsed['landmark_name']}")
    if parsed.get("micro_market"):
        highlights.append(f"Prime location: {parsed['micro_market']}")
    if parsed.get("location_raw") and parsed["location_raw"] not in (parsed.get("micro_market") or "", parsed.get("building_name") or ""):
        highlights.append(f"Area: {parsed['location_raw']}")
    return highlights[:5]


def _promote_price(parsed: dict) -> str:
    price = parsed.get("price")
    unit = parsed.get("price_unit")
    if price and unit == "Cr":
        return f"\u20b9{(price / 1_00_00_000):.2f} Cr"
    if price and unit == "L":
        return f"\u20b9{(price / 1_00_000):.1f} L"
    if price and unit == "lakh":
        return f"\u20b9{(price / 1_00_000):.1f} Lakh"
    if price:
        return f"\u20b9{price:,.0f}"
    return ""


def _promote_headline(parsed: dict, channel: str) -> str:
    label = _parsed_display_label(parsed)
    building = parsed.get("building_name", "")
    market = parsed.get("micro_market", "")
    price = _promote_price(parsed)
    location = market or parsed.get("location_raw", "")
    if channel == "whatsapp":
        parts = [f"\U0001f3d7\ufe0f {label}"]
        if building:
            parts.append(f"at {building}")
        if location:
            parts.append(f"in {location}")
        if price:
            parts.append(f"| {price}")
        return " ".join(parts)
    if channel in ("facebook", "instagram"):
        parts = [f"{label}"]
        if building:
            parts.append(f"at {building}")
        if location:
            parts.append(f"in {location}")
        if price:
            parts.append(f"\u2014 {price}")
        return " ".join(parts)
    return ""


def _promote_whatsapp(parsed: dict, highlights: list[str]) -> str:
    label = _parsed_display_label(parsed)
    building = parsed.get("building_name", "")
    market = parsed.get("micro_market", "")
    price = _promote_price(parsed)
    area = f"{parsed['area_sqft']:,} sqft" if parsed.get("area_sqft") else ""
    furnish = parsed.get("furnishing", "")
    broker = parsed.get("broker_name", "")
    phone = re.sub(r"[^0-9]", "", parsed.get("broker_phone") or "")[-10:]
    lines = ["\U0001f3d7\ufe0f *" + _promote_headline(parsed, "whatsapp") + "*", ""]
    if building:
        lines.append(f"\U0001f4cd {building}")
    if market:
        lines.append(f"\U0001f4cd {market}")
    detail_parts = [p for p in [label, area, furnish] if p]
    if detail_parts:
        lines.append(" | ".join(detail_parts))
    if price:
        lines.append(f"\U0001f4b0 {price}")
    lines.append("")
    lines.append("\u2728 Highlights:")
    for h in highlights[:4]:
        lines.append(f"  \u2705 {h}")
    lines.append("")
    if broker:
        lines.append(f"\U0001f4de {broker}")
    if phone and len(phone) == 10:
        lines.append(f"   wa.me/91{phone}")
    return "\n".join(lines)


def _promote_instagram(parsed: dict, highlights: list[str]) -> str:
    label = _parsed_display_label(parsed)
    building = parsed.get("building_name", "")
    market = parsed.get("micro_market", "")
    price = _promote_price(parsed)
    area = f"{parsed['area_sqft']:,} sqft" if parsed.get("area_sqft") else ""
    furnish = parsed.get("furnishing", "")
    lines = [f"\u2728 {label}" + (f" at {building}" if building else "")]
    if market:
        lines.append(f"\U0001f4cd {market}")
    if price:
        lines.append(f"\U0001f4b0 {price}")
    lines.append("")
    if area or furnish:
        detail_parts = [p for p in [area, furnish] if p]
        lines.append(" | ".join(detail_parts))
    lines.append("")
    lines.append("What you get:")
    for h in highlights[:4]:
        lines.append(f"\u2705 {h}")
    lines.append("")
    lines.append("\U0001f4f2 DM for more details or site visit!")
    return "\n".join(lines)


def _promote_facebook(parsed: dict, highlights: list[str]) -> str:
    insta = _promote_instagram(parsed, highlights)
    return insta + "\n\nAvailable for sale/rent. Serious inquiries only."


def _identify_channel_emoji(channel: str) -> str:
    return {"whatsapp": "\U0001f4ac", "facebook": "\U0001f44d", "instagram": "\U0001f4f8"}.get(channel, "\U0001f4e2")


def _ai_promote(system: str, prompt: str) -> str | None:
    try:
        from llm import get_client, get_model
        client = get_client()
        model = get_model()
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": prompt}],
            max_tokens=300,
        )
        usage = getattr(resp, "usage", None)
        try:
            from usage_logger import log_ai_usage
            log_ai_usage(
                agent="promote",
                model=model,
                tokens_input=getattr(usage, "prompt_tokens", 0) or 0,
                tokens_output=getattr(usage, "completion_tokens", 0) or 0,
            )
        except Exception:
            pass
        return resp.choices[0].message.content
    except Exception:
        return None


def _ai_promote_with_key(system: str, prompt: str, api_key: str) -> str | None:
    try:
        from llm import get_client, get_model
        from openai import OpenAI
        client = get_client() if not api_key else OpenAI(api_key=api_key, base_url="https://api.doubleword.ai/v1")
        model = get_model()
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": prompt}],
            max_tokens=300,
        )
        usage = getattr(resp, "usage", None)
        try:
            from usage_logger import log_ai_usage
            log_ai_usage(
                agent="promote",
                model=model,
                tokens_input=getattr(usage, "prompt_tokens", 0) or 0,
                tokens_output=getattr(usage, "completion_tokens", 0) or 0,
            )
        except Exception:
            pass
        return resp.choices[0].message.content
    except Exception:
        return None


# ═══════════════════════════════════════════════════════════════════
# Block 1 — Semantic search, explain, summary, broker/building lookup
# ═══════════════════════════════════════════════════════════════════

@router.post("/api/ai/query")
async def ai_query(req: QueryRequest, user: dict = Depends(require_user)):
    eng = get_embedder()
    eng.partial_fit([req.query])
    emb = eng.embed(req.query)
    from lab.embedding import pack_embedding
    blob = pack_embedding(emb)
    results = storage.knn_search(blob, k=req.k)
    return {"query": req.query, "count": len(results), "results": results}


@router.get("/api/ai/similar/{observation_id}")
async def ai_similar(observation_id: int, k: int = 10, user: dict = Depends(require_user)):
    detail = storage.get_observation_detail(observation_id)
    parsed = detail.get("parsed", {})
    emb = parsed.get("embedding")
    if not emb:
        raise HTTPException(404, "Observation has no embedding")
    results = storage.knn_search(emb, k=k + 1)
    filtered = [r for r in results if r.get("id") != parsed.get("id")][:k]
    return {"observation_id": observation_id, "count": len(filtered), "results": filtered}


@router.get("/api/ai/explain/{observation_id}")
async def ai_explain(observation_id: int, user: dict = Depends(require_user)):
    detail = storage.get_observation_detail(observation_id)
    parsed = detail.get("parsed", {})
    raw = detail.get("raw", {})
    if not parsed:
        raise HTTPException(404, "Observation not found")

    raw_text = raw.get("message", "")
    lower = raw_text.lower()

    rules = []

    if parsed.get("intent") == "PRE-LAUNCH":
        rules.append("intent=PRE-LAUNCH: matched pre-launch/new-launch keywords")
    elif parsed.get("intent") == "COMMERCIAL":
        rules.append("intent=COMMERCIAL: matched commercial keywords (office/shop/warehouse)")
    elif parsed.get("intent") == "RENT":
        rules.append("intent=RENT: matched rental keywords (rent/lease)")
    elif parsed.get("intent") == "SELL":
        if any(x in lower for x in ["sale", "sell", "selling", "available", "ready to move", "resale", "for sale"]):
            rules.append("intent=SELL: matched sale keywords")
        else:
            rules.append("intent=SELL: default (no buy/rent/pre-launch keywords detected)")
    elif parsed.get("intent") == "BUY":
        rules.append("intent=BUY: matched buy/requirement keywords")

    if parsed.get("principal") == "Owner":
        rules.append("principal=Owner: matched owner-sale/direct-owner pattern")
    elif parsed.get("principal") == "Buyer Client":
        rules.append("principal=Buyer Client: matched client-requirement/buyer-need pattern")
    else:
        rules.append("principal=Unknown: no owner or buyer-client pattern detected")

    broker = parsed.get("broker_name")
    profile = parsed.get("profile_name")
    if profile:
        rules.append(f"broker_name='{broker}' from WhatsApp profile name")
    elif broker:
        rules.append(f"broker_name='{broker}' from signature block (bottom-up extraction)")

    if parsed.get("forwarded"):
        rules.append("forwarded=1: message contains forwarded indicator")

    if parsed.get("bhk"):
        rules.append(f"bhk='{parsed['bhk']}': matched BHK pattern")
    if parsed.get("price"):
        rules.append(f"price={parsed['price']} {parsed.get('price_unit','')}: matched price pattern")
    if parsed.get("area_sqft"):
        rules.append(f"area_sqft={parsed['area_sqft']}: matched area pattern")
    if parsed.get("furnishing"):
        rules.append(f"furnishing='{parsed['furnishing']}': matched furnishing keyword")
    if parsed.get("building_name"):
        rules.append(f"building_name='{parsed['building_name']}': extracted from location")
    if parsed.get("landmark_name"):
        rules.append(f"landmark_name='{parsed['landmark_name']}': extracted from location")
    if parsed.get("micro_market"):
        rules.append(f"micro_market='{parsed['micro_market']}': extracted from location")

    resolver = detail.get("resolver", {})
    if resolver.get("method") == "resolved":
        rules.append(f"resolver={resolver['method']}: matched building #{resolver.get('building_id')} "
                      f"({resolver.get('building_name', 'unknown')}) with confidence {resolver.get('resolver_confidence', 0)}")
    elif resolver.get("failure_category"):
        rules.append(f"resolver={resolver['method']}: {resolver['failure_category']}")

    return {
        "observation_id": observation_id,
        "parsed": {k: v for k, v in parsed.items() if v is not None and k != "embedding"},
        "rules": rules,
    }


@router.get("/api/ai/summary")
async def ai_summary(user: dict = Depends(require_user)):
    today = _today_prefix()
    activity = storage.dashboard_activity(today)
    types = storage.dashboard_message_types_today(today)
    type_map = {t["intent"]: t["c"] for t in types}

    growth = storage.dashboard_growth(today)
    today_timeline = growth["timeline"][-1] if growth["timeline"] else None

    top_brokers = storage.get_top_brokers_today(today)
    heat = storage.dashboard_heatmap()
    top_markets = [h for h in heat if h.get("c", 0) > 0][:10]

    return {
        "date": today,
        "messages_today": activity.get("messages_today", 0),
        "message_types": type_map,
        "growth": {
            "new_buildings": today_timeline.get("new_buildings", 0) if today_timeline else 0,
            "new_landmarks": today_timeline.get("new_landmarks", 0) if today_timeline else 0,
            "new_developers": today_timeline.get("new_developers", 0) if today_timeline else 0,
        },
        "top_brokers": top_brokers,
        "hot_markets": top_markets,
    }


@router.get("/api/ai/broker/{broker_name:path}")
async def ai_broker(broker_name: str, user: dict = Depends(require_user)):
    observations = storage.get_observations_by_broker(broker_name)
    if not observations:
        raise HTTPException(404, f"No observations for broker: {broker_name}")
    total = len(observations)
    intents = {}
    buildings = set()
    markets = set()
    prices = []
    for o in observations:
        i = o.get("intent")
        if i:
            intents[i] = intents.get(i, 0) + 1
        b = o.get("building_name")
        if b:
            buildings.add(b)
        m = o.get("micro_market")
        if m:
            markets.add(m)
        p = o.get("price")
        if p:
            prices.append(p)
    avg_price = round(sum(prices) / len(prices), 2) if prices else None
    last_5 = observations[:5]
    for o in last_5:
        o.pop("embedding", None)
    return {
        "broker_name": broker_name,
        "total_observations": total,
        "intent_breakdown": intents,
        "unique_buildings": list(buildings),
        "unique_markets": list(markets),
        "avg_price": avg_price,
        "last_observations": last_5,
    }


@router.get("/api/ai/building/{building_name:path}")
async def ai_building(building_name: str, user: dict = Depends(require_user)):
    observations = storage.get_observations_by_building(building_name)
    if not observations:
        raise HTTPException(404, f"No observations for building: {building_name}")
    total = len(observations)
    intents = {}
    prices = []
    brokers = set()
    for o in observations:
        i = o.get("intent")
        if i:
            intents[i] = intents.get(i, 0) + 1
        p = o.get("price")
        if p:
            prices.append(p)
        b = o.get("broker_name")
        if b:
            brokers.add(b)
    avg_price = round(sum(prices) / len(prices), 2) if prices else None
    last_5 = observations[:5]
    for o in last_5:
        o.pop("embedding", None)
    return {
        "building_name": building_name,
        "total_observations": total,
        "intent_breakdown": intents,
        "unique_brokers": list(brokers),
        "avg_price": avg_price,
        "last_observations": last_5,
    }


# ═══════════════════════════════════════════════════════════════════
# Block 2 — Promote Listing (ad copy generation)
# ═══════════════════════════════════════════════════════════════════

@router.get("/api/promote/config")
async def promote_config(user: dict = Depends(require_user)):
    has_meta_credentials = bool(
        os.getenv("META_ACCESS_TOKEN")
        and (os.getenv("META_PAGE_ID") or os.getenv("META_INSTAGRAM_BUSINESS_ID"))
    )
    return {
        "enable_ai_promo": ENABLE_AI_PROMO,
        "enable_meta_publishing": ENABLE_META_PUBLISHING,
        "meta_publish_available": ENABLE_META_PUBLISHING and has_meta_credentials,
    }


@router.post("/api/promote/generate")
async def promote_generate(req: PromoteRequest, user: dict = Depends(require_user)):
    detail = storage.get_observation_detail(req.observation_id)
    if not detail.get("parsed"):
        raise HTTPException(404, "Observation not found")
    parsed = dict(detail["parsed"])
    if req.fields:
        allowed_fields = {
            "bhk", "price", "price_unit", "area_sqft", "furnishing", "location_raw",
            "building_name", "landmark_name", "micro_market", "broker_name", "broker_phone",
        }
        for key, value in req.fields.items():
            if key in allowed_fields and value not in (None, ""):
                parsed[key] = value
    highlights = _promote_highlights(parsed)
    headline = _promote_headline(parsed, req.channel)

    if req.channel == "whatsapp":
        body = _promote_whatsapp(parsed, highlights)
    elif req.channel == "instagram":
        body = _promote_instagram(parsed, highlights)
    elif req.channel == "facebook":
        body = _promote_facebook(parsed, highlights)
    else:
        raise HTTPException(400, f"Unknown channel: {req.channel}")

    result = {
        "channel": req.channel,
        "emoji": _identify_channel_emoji(req.channel),
        "headline": headline,
        "body": body,
        "highlights": highlights,
        "ai_enhanced": False,
    }

    promo_api_key = req.api_key or ""
    if req.use_ai and ENABLE_AI_PROMO:
        try:
            system = "You are a Mumbai real estate marketing assistant. Given property details, write a short promotional ad for the specified channel. Keep it under 120 words. Return only the ad body, no preamble."
            price_str = _promote_price(parsed)
            detail_parts = [v for v in [_parsed_display_label(parsed), parsed.get("furnishing"), f"{parsed.get('area_sqft', '')} sqft" if parsed.get('area_sqft') else ""] if v]
            prompt = f"Channel: {req.channel}\nBuilding: {parsed.get('building_name', 'N/A')}\nLocation: {parsed.get('micro_market', parsed.get('location_raw', 'N/A'))}\nDetails: {' | '.join(detail_parts)}\nPrice: {price_str}\nBroker: {parsed.get('broker_name', 'N/A')}"
            loop = asyncio.get_running_loop()
            ai_body = await loop.run_in_executor(None, lambda: _ai_promote_with_key(system, prompt, promo_api_key))
            if ai_body:
                result["body"] = ai_body
                result["ai_enhanced"] = True
        except Exception:
            pass

    return result


# ═══════════════════════════════════════════════════════════════════
# Block 3 — AI config, chat sessions, chat
# ═══════════════════════════════════════════════════════════════════

@router.get("/api/ai/config")
async def ai_config(user: dict = Depends(require_user), tenant_id: str | None = Depends(get_tenant_context)):
    info = _preferred_workspace_provider(tenant_id)
    return {
        "has_server_key": info.get("provider") != "none",
        "base_url": info.get("base_url", ""),
        "model": info.get("model", ""),
        "provider": info.get("provider", "none"),
    }


@router.get("/api/ai/chat/sessions")
async def list_chat_sessions(broker_phone: str = "", limit: int = 50, user: dict = Depends(require_user), tenant_id: str | None = Depends(get_tenant_context)):
    if not broker_phone:
        return []
    return storage.list_chat_sessions(broker_phone, limit=limit, tenant_id=tenant_id)


@router.post("/api/ai/chat/sessions")
async def create_chat_session(broker_phone: str = "", title: str = "New chat", user: dict = Depends(require_user), tenant_id: str | None = Depends(get_tenant_context)):
    if not broker_phone:
        raise HTTPException(400, "broker_phone required")
    return storage.create_chat_session(broker_phone, title=title, tenant_id=tenant_id) or {}


@router.get("/api/ai/chat/sessions/{session_id}/messages")
async def get_chat_session_messages(session_id: str, user: dict = Depends(require_user), tenant_id: str | None = Depends(get_tenant_context)):
    session = storage.get_chat_session(session_id, tenant_id=tenant_id)
    if not session:
        raise HTTPException(404, "Session not found")
    return storage.get_ai_chat_messages(session_id, tenant_id=tenant_id)


@router.delete("/api/ai/chat/sessions/{session_id}")
async def delete_chat_session(session_id: str, user: dict = Depends(require_user), tenant_id: str | None = Depends(get_tenant_context)):
    storage.delete_chat_session(session_id, tenant_id=tenant_id)
    return {"ok": True}


@router.post("/api/ai/chat")
async def ai_chat(req: ChatRequest, user: dict = Depends(require_user), tenant_id: str | None = Depends(get_tenant_context)):
    from ai_chat_engine import get_memory

    session_id = req.session_id or "default"
    memory = get_memory(session_id)
    preferred_provider = _preferred_workspace_provider(tenant_id)
    effective_api_key = (req.api_key or "").strip() or preferred_provider["api_key"]
    effective_model = (req.model or "").strip() or preferred_provider["model"]
    effective_base_url = preferred_provider["base_url"]

    for msg in req.messages:
        role = msg.get("role", "")
        content = str(msg.get("content", "")).strip()
        if content:
            if not memory.working or memory.working[-1].get("content") != content:
                memory.add(role, content)

    def _persist(role: str, content: str) -> None:
        if not req.session_id or not content:
            return
        try:
            storage.add_chat_message(req.session_id, role, content, tenant_id=tenant_id)
            storage.touch_chat_session(req.session_id, tenant_id=tenant_id)
        except Exception as exc:
            _logger.exception("Could not persist AI chat message session=%s role=%s: %s", req.session_id, role, exc)

    def _maybe_title(text: str) -> None:
        if not req.session_id or not text:
            return
        try:
            msgs = storage.get_ai_chat_messages(req.session_id, limit=3, tenant_id=tenant_id)
            user_msgs = [m for m in msgs if m.get("role") == "user"]
            if len(user_msgs) <= 1:
                title = text[:80].strip()
                storage.update_chat_session_title(req.session_id, title, tenant_id=tenant_id)
        except Exception:
            pass

    broker = None
    if req.broker_phone:
        try:
            _bp = storage.get_user_profile(req.broker_phone, tenant_id=tenant_id)
            if _bp and (_bp.get("first_name") or _bp.get("last_name")):
                broker = {
                    "name": f"{_bp.get('first_name', '')} {_bp.get('last_name', '')}".strip(),
                    "phone": req.broker_phone,
                    "city": _bp.get("city", ""),
                }
        except Exception:
            pass

    last_user = ""
    for msg in reversed(req.messages):
        if msg.get("role") == "user":
            last_user = str(msg.get("content", "")).strip()
            break

    _is_inbox = req.source == "inbox"

    if last_user and _CAPABILITY_SIGNALS.search(last_user):
        try:
            cap_sources = chat_engine.load_data()
            cap_live = chat_engine.load_live_data(getattr(storage, "db", None))
            cap_sources.update(cap_live)
            if cap_sources:
                cap_msgs = [
                    {"role": "system", "content": chat_engine.build_system_prompt(cap_sources, broker=broker)},
                    {"role": "user", "content": last_user},
                ]
                loop = asyncio.get_running_loop()
                cap_reply = await asyncio.wait_for(
                    loop.run_in_executor(
                        None,
                        lambda: chat_engine.get_model_reply(
                            cap_msgs, cap_sources, api_key=effective_api_key,
                            model=effective_model or None, base_url=effective_base_url or None, max_tool_rounds=0,
                        ),
                    ),
                    timeout=30,
                )
                text = (cap_reply.content or "").strip() or "I can help with that."
                _persist("user", last_user)
                _persist("assistant", text)
                _maybe_title(last_user)
                return _wrap_chat_response({
                    "content": text,
                    "blocks": [{"type": "summary", "body": text}],
                    "sources": list(cap_sources.keys()),
                    "status_steps": [],
                    "trace": {"route": "capability_llm"},
                }, _is_inbox)
        except Exception:
            pass

    if last_user and not _has_query_signals(last_user):
        try:
            loop = asyncio.get_running_loop()
            reply = await asyncio.wait_for(
                loop.run_in_executor(
                    None,
                    lambda: chat_engine.get_conversational_reply(
                        req.messages, api_key=effective_api_key, model=effective_model or None,
                        base_url=effective_base_url or None, broker=broker
                    ),
                ),
                timeout=30,
            )
            text = (reply.content or "").strip()
            if text:
                _persist("user", last_user)
                _persist("assistant", text)
                _maybe_title(last_user)
                return _wrap_chat_response({
                    "content": text,
                    "blocks": [{"type": "greeting", "body": text}],
                    "sources": [],
                    "status_steps": [],
                    "trace": {"route": "conversational_llm"},
                }, _is_inbox)
            else:
                return _wrap_chat_response({
                    "content": "AI returned an empty response. Please try again.",
                    "blocks": [{"type": "error", "body": "AI returned an empty response. Please try again."}],
                    "sources": [],
                    "status_steps": [],
                    "trace": {"route": "conversational_empty"},
                }, _is_inbox)
        except ProviderConfigurationError as exc:
            _logger.error("LLM provider configuration error: %s", exc)
            error_text = f"LLM provider not configured. Please check API keys. {exc}"
            _persist("user", last_user)
            _persist("assistant", error_text)
            _maybe_title(last_user)
            return _wrap_chat_response({
                "content": error_text,
                "blocks": [{"type": "error", "body": error_text}],
                "sources": [],
                "trace": {"route": "conversational_error"},
            }, _is_inbox)
        except Exception as exc:
            exc_msg = str(exc) if exc else "no details"
            if not exc_msg or exc_msg == "None":
                exc_msg = "LLM provider unavailable or misconfigured"
            _logger.error("AI chat failed: %s", exc_msg)
            return _wrap_chat_response({
                "content": f"AI chat failed: {exc_msg}. Please try again.",
                "blocks": [{"type": "error", "body": f"AI chat failed: {exc_msg}. Please try again."}],
                "sources": [],
                "trace": {"route": "conversational_error"},
            }, _is_inbox)

    if last_user and memory.detect_topic_change(last_user) and len(memory.working) > 2:
        memory.compact_topic()
    memory.prune()

    sources = chat_engine.load_data()
    try:
        live = chat_engine.load_live_data(getattr(storage, "db", None))
        sources.update(live)
    except Exception:
        pass
    if not sources:
        return _wrap_chat_response({"error": "no_data", "content": "No data found. Check CSV files and database."}, _is_inbox)

    search_request_text = last_user
    if last_user and not re.search(r"\b\d+(?:\.5)?\s*(?:bhk|bed(?:room)?s?)\b|\b(?:rent|rental|lease|sale|sell|buy|purchase)\b", last_user, re.IGNORECASE):
        previous_users = [
            str(msg.get("content", "")).strip()
            for msg in req.messages[:-1]
            if msg.get("role") == "user" and str(msg.get("content", "")).strip()
        ]
        if previous_users:
            # A follow-up such as “Powai has plenty of inventory” should
            # inherit the active 3 BHK + RENT constraints from the prior turn.
            search_request_text = f"{previous_users[-1]}\nFollow-up correction: {last_user}"

    deterministic_query = chat_engine.parse_market_search_request(
        search_request_text,
        api_key=effective_api_key,
        model=effective_model,
        base_url=effective_base_url,
        db_path=getattr(storage, "db", None),
    )
    if deterministic_query:
        try:
            search_result = await asyncio.to_thread(
                chat_engine.execute_tool,
                "market_search",
                deterministic_query,
                sources,
                getattr(storage, "db", None),
                tenant_id,
            )
            response = chat_engine.deterministic_market_response(
                deterministic_query, search_result, sources
            )
            _persist("user", last_user)
            _persist("assistant", response.get("content", ""))
            _maybe_title(last_user)
            return _wrap_chat_response(response, _is_inbox)
        except Exception as exc:
            _logger.exception("Deterministic market search failed for filters=%s", deterministic_query)
            response = chat_engine.deterministic_market_response(
                deterministic_query, "", sources
            )
            _persist("user", last_user)
            _persist("assistant", response.get("content", ""))
            _maybe_title(last_user)
            return _wrap_chat_response(response, _is_inbox)

    loop = asyncio.get_running_loop()

    def _call():
        system_prompt = chat_engine.build_system_prompt(sources, broker=broker)
        context = memory.build_context()
        msgs = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": context},
        ]
        reply = chat_engine.get_model_reply(
            msgs,
            sources,
            api_key=effective_api_key,
            model=effective_model or None,
            base_url=effective_base_url or None,
            max_tool_rounds=2,
        )
        if reply.content:
            memory.add("assistant", reply.content)
        return chat_engine.normalize_workspace_response(reply.content or "", sources)

    try:
        response = await asyncio.wait_for(loop.run_in_executor(None, _call), timeout=90)
        _persist("user", last_user)
        _persist("assistant", response.get("content", ""))
        _maybe_title(last_user)
        return _wrap_sse(response)
    except asyncio.TimeoutError:
        return JSONResponse(
            status_code=504,
            content={"error": "timeout", "message": "Request timed out. Try a simpler query."},
        )
    except Exception as exc:
        err_str = str(exc)
        if "budget_exhausted" in err_str or "402" in err_str:
            return JSONResponse(
                status_code=503,
                content={"error": "ai_unavailable", "message": "AI service credits exhausted. Extraction and chat will resume once credits are added."},
            )
        return _doubleword_error_response(exc)


@router.get("/api/ai/chat/overview")
async def ai_chat_overview(user: dict = Depends(require_user)):
    sources = chat_engine.load_data()
    live = chat_engine.load_live_data(getattr(storage, "db", None))
    sources.update(live)
    if not sources:
        return {"error": "no_data"}
    return {"overview": chat_engine.build_overview(sources), "sources": list(sources.keys())}
