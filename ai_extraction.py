"""AI-first extraction pipeline — primary path for all listing/requirement parsing.

Provider rotation uses the same deployment-configured chain as chat.

On 429/timeout → immediately retry next key.
Only fall to regex if ALL 6 keys fail, or AI response fails schema validation twice.

Usage:
    from ai_extraction import ai_extract
    result = await ai_extract(raw_text, ctx)
    if result["extraction_source"] == "ai":
        # Use result["extraction"] (the structured schema)
    else:
        # Fallback — result["extraction"] has regex-parsed fields
"""

import json
import logging
import re
import time
from datetime import datetime, timezone
from typing import Optional

from openai import OpenAI
from llm import get_configured_providers

_logger = logging.getLogger(__name__)

# ── Provider configuration ────────────────────────────────────────────

# One provider registry for chat, WhatsApp, and extraction.  Models are always
# deployment configuration; changing a key/model in Coolify changes every path
# together after redeploy.
_PROVIDERS: list[dict] = list(get_configured_providers())

# Round-robin pointer
_rr_index = 0
_rr_lock = __import__("threading").Lock()


def _next_provider() -> dict | None:
    global _rr_index
    if not _PROVIDERS:
        return None
    with _rr_lock:
        p = _PROVIDERS[_rr_index]
        _rr_index = (_rr_index + 1) % len(_PROVIDERS)
    return p


# ── Extraction prompt ─────────────────────────────────────────────────

_EXTRACTION_SYSTEM_PROMPT = """You parse Mumbai real estate broker WhatsApp messages into JSON.

Return {"items": [<one object per listing>]} with exactly these fields per item:

listing_type: "sale" | "rent" | "requirement"
property_category: "residential" | "commercial"
bhk: number (1, 1.5, 2, 3...) or null for commercial
carpet_area_sqft: number or null
price: {amount: number|null, unit: "total"|"per_sqft"|null, period: "one_time"|"per_month"|null, raw_price_text: "exact phrase"|null}
  - Convert: 1 Cr = 10000000, 1 Lakh = 100000. amount = TOTAL price (not per-sqft)
locality: {raw_mention: "exact location text"|null, resolved_locality: "parent area like Bandra West"|null, confidence: "high"|"medium"}
building_name: "proper complex name" | null (NEVER amenities like "Sea View", "Semi Furnished")
furnishing_status: "unfurnished" | "semi_furnished" | "fully_furnished" | null
amenities: ["gym", "parking"...] (only if explicitly mentioned)
possession_status: "ready_to_move" | "under_construction" | date string | null
deal_tags: ["negotiable", "urgent_sale"...] (only if explicit in message)
additional_charges: [{label:str, amount:num, amount_type:"fixed"|"percent_of_price"}]
title: "3 BHK for Rent in Bandra West — ₹2.75L/month" (auto-generated from fields)
extraction_confidence: "high" | "medium" | "low"

Rules:
- One message may contain multiple listings. Put each in a separate items[] entry.
- For requirements (broker seeking), listing_type = "requirement".
- Building name = ONLY proper complex names (e.g. "Kalpataru Vivant"). NEVER features/descriptions.
- Return ONLY valid JSON. No markdown, no code blocks, no extra text."""


# ── Schema validation ─────────────────────────────────────────────────

_VALID_LISTING_TYPES = frozenset({"sale", "rent", "requirement"})
_VALID_CATEGORIES = frozenset({"residential", "commercial"})
_VALID_FURNISHING = frozenset({"unfurnished", "semi_furnished", "fully_furnished"})
_VALID_CONFIDENCE = frozenset({"high", "medium", "low"})
_VALID_PRICE_UNITS = frozenset({"total", "per_sqft"})
_VALID_PRICE_PERIODS = frozenset({"one_time", "per_month"})
_VALID_DEAL_TAGS = frozenset({
    "distress_sale",
    "urgent_sale",
    "negotiable",
    "bank_auction",
    "resale",
    "exclusive_mandate",
    "price_drop",
})
_VALID_CHARGE_TYPES = frozenset({"fixed", "percent_of_price"})


def _normalize_extraction(raw: dict) -> dict:
    """Normalize and validate LLM extraction response."""
    result = {}

    # listing_type
    lt = str(raw.get("listing_type", "")).strip().lower()
    if lt in _VALID_LISTING_TYPES:
        result["listing_type"] = lt
    else:
        result["listing_type"] = None

    # property_category
    pc = str(raw.get("property_category", "")).strip().lower()
    if pc in _VALID_CATEGORIES:
        result["property_category"] = pc
    else:
        result["property_category"] = None

    # bhk
    bhk = raw.get("bhk")
    if bhk is not None:
        try:
            result["bhk"] = float(bhk)
        except (ValueError, TypeError):
            result["bhk"] = None
    else:
        result["bhk"] = None

    # carpet_area_sqft
    area = raw.get("carpet_area_sqft")
    if area is not None:
        try:
            result["carpet_area_sqft"] = float(area)
        except (ValueError, TypeError):
            result["carpet_area_sqft"] = None
    else:
        result["carpet_area_sqft"] = None

    # price
    price = raw.get("price", {})
    if isinstance(price, dict):
        amount = price.get("amount")
        try:
            result["price"] = {
                "amount": float(amount) if amount is not None else None,
                "unit": str(price.get("unit", "")).strip().lower() if price.get("unit") else None,
                "period": str(price.get("period", "")).strip().lower() if price.get("period") else None,
                "raw_price_text": str(price.get("raw_price_text", "")).strip() or None,
            }
        except (ValueError, TypeError):
            result["price"] = {"amount": None, "unit": None, "period": None, "raw_price_text": None}
        if result["price"]["unit"] not in _VALID_PRICE_UNITS:
            result["price"]["unit"] = "total"
        if result["price"]["period"] not in _VALID_PRICE_PERIODS:
            result["price"]["period"] = None
    else:
        result["price"] = {"amount": None, "unit": None, "period": None, "raw_price_text": None}

    # locality
    loc = raw.get("locality", {})
    if isinstance(loc, dict):
        conf = str(loc.get("confidence", "")).strip().lower()
        rm = loc.get("raw_mention")
        rl = loc.get("resolved_locality")
        result["locality"] = {
            "raw_mention": str(rm).strip() if rm is not None else None,
            "resolved_locality": str(rl).strip() if rl is not None else None,
            "confidence": conf if conf in _VALID_CONFIDENCE else "low",
        }
    else:
        result["locality"] = {"raw_mention": None, "resolved_locality": None, "confidence": "low"}

    # building_name — reject garbage patterns that the LLM sometimes extracts
    # as building names (furnishing descriptions, price phrases, etc.)
    bn = raw.get("building_name")
    bn_str = str(bn).strip() if bn and str(bn).strip() else None
    if bn_str:
        bn_lower = bn_str.lower()
        _GARBAGE_BUILDING_PATTERNS = (
            "stamp duty", "furnished", "carpet", "bhk", "sqft", "sq ft",
            "ready to move", "negotiable", "balcony", "sea view",
            "amenities", "parking", "deposit", "possession",
            " available", "available ", "options", "benefit",
            "family", "bachelor", "veg ", " non-veg",
            " near ", "opp ", "opposite", "behind", "floor",
        )
        if any(pat in bn_lower for pat in _GARBAGE_BUILDING_PATTERNS):
            bn_str = None
        elif len(bn_str) < 3 or len(bn_str) > 80:
            bn_str = None
    result["building_name"] = bn_str

    # furnishing_status
    fs = str(raw.get("furnishing_status", "")).strip().lower().replace(" ", "_")
    if fs in _VALID_FURNISHING:
        result["furnishing_status"] = fs
    elif fs and fs != "null":
        result["furnishing_status"] = fs
    else:
        result["furnishing_status"] = None

    # amenities
    amenities = raw.get("amenities", [])
    if isinstance(amenities, list):
        result["amenities"] = [str(a).strip() for a in amenities if a and str(a).strip()]
    else:
        result["amenities"] = []

    # possession_status
    ps = raw.get("possession_status")
    result["possession_status"] = str(ps).strip() if ps and str(ps).strip() else None

    # title
    title = raw.get("title")
    result["title"] = str(title).strip() if title and str(title).strip() else None

    # extraction_confidence
    ec = str(raw.get("extraction_confidence", "")).strip().lower()
    result["extraction_confidence"] = ec if ec in _VALID_CONFIDENCE else "medium"

    # deal_tags — whitelist-filter list of lowercase strings.
    tags = raw.get("deal_tags", [])
    if isinstance(tags, list):
        result["deal_tags"] = [
            str(t).strip().lower()
            for t in tags
            if str(t).strip().lower() in _VALID_DEAL_TAGS
        ]
    else:
        result["deal_tags"] = []

    # additional_charges — array of {label, amount, amount_type} with
    # amount_type in {"fixed", "percent_of_price"}. Junk entries (missing
    # label, missing amount, bad amount_type, non-numeric amount) are
    # silently dropped so a malformed entry can't poison the whole row.
    charges = raw.get("additional_charges", [])
    normalized_charges: list[dict] = []
    if isinstance(charges, list):
        for c in charges:
            if not isinstance(c, dict):
                continue
            label = str(c.get("label", "")).strip()
            amount = c.get("amount")
            amount_type = str(c.get("amount_type", "")).strip().lower()
            if not label or amount is None or amount_type not in _VALID_CHARGE_TYPES:
                continue
            try:
                normalized_charges.append({
                    "label": label,
                    "amount": float(amount),
                    "amount_type": amount_type,
                })
            except (ValueError, TypeError):
                continue
    result["additional_charges"] = normalized_charges

    return result


# ── Locality resolution ───────────────────────────────────────────────

_LIKE_ESCAPE_RE = re.compile(r"([%_\\])")


def _escape_like(s: str) -> str:
    return _LIKE_ESCAPE_RE.sub(r"\\\1", s)


def resolve_locality(raw_mention: str | None, storage=None) -> dict:
    """Resolve a raw locality mention to its parent locality.

    Steps:
        1. Exact match against locality_reference.sub_locality
        2. Case-insensitive match
        3. Substring / like match
        4. If storage is None, return AI-inferred value as-is
    """
    if not raw_mention or not raw_mention.strip():
        return {"resolved_locality": None, "confidence": "low", "raw_mention": raw_mention}

    mention = raw_mention.strip()

    if storage is None:
        return {"resolved_locality": None, "confidence": "low", "raw_mention": mention}

    try:
        db = storage.client if hasattr(storage, "client") else None
        if not db:
            return {"resolved_locality": None, "confidence": "low", "raw_mention": mention}

        # Try exact match first
        res = db.table("locality_reference").select("parent_locality, confidence").eq(
            "sub_locality", mention
        ).limit(1).execute()
        if res.data:
            row = res.data[0]
            return {
                "resolved_locality": row["parent_locality"],
                "confidence": row.get("confidence") or "medium",
                "raw_mention": mention,
            }

        # Case-insensitive via ilike
        res = db.table("locality_reference").select("parent_locality, confidence").ilike(
            "sub_locality", mention
        ).limit(1).execute()
        if res.data:
            row = res.data[0]
            return {
                "resolved_locality": row["parent_locality"],
                "confidence": row.get("confidence") or "medium",
                "raw_mention": mention,
            }

        # Substring match — check if mention contains a known sub-locality
        res = db.table("locality_reference").select("sub_locality, parent_locality, confidence").limit(200).execute()
        if res.data:
            mention_lower = mention.lower()
            for row in res.data:
                sub = (row.get("sub_locality") or "").lower()
                if sub and sub in mention_lower:
                    return {
                        "resolved_locality": row["parent_locality"],
                        "confidence": row.get("confidence") or "medium",
                        "raw_mention": mention,
                    }

    except Exception:
        _logger.warning("locality_reference query failed for %r", mention, exc_info=True)

    return {"resolved_locality": None, "confidence": "low", "raw_mention": mention}


# ── Title generation (shared between app + www) ────────────────────────

def generate_title(extraction: dict) -> str:
    """Generate human-readable title from structured extraction fields.

    This is the canonical title builder — used by both the app and www.
    Never copy-pastes raw broker text as title.
    """
    listing_type = extraction.get("listing_type")
    property_category = extraction.get("property_category")
    bhk = extraction.get("bhk")
    building_name = extraction.get("building_name")
    locality = extraction.get("locality", {})
    resolved_locality = locality.get("resolved_locality") if isinstance(locality, dict) else None
    raw_mention = locality.get("raw_mention") if isinstance(locality, dict) else None
    price = extraction.get("price", {})
    amenities = extraction.get("amenities", [])

    pieces = []

    if listing_type == "requirement":
        pieces.append("Requirement:")

    # BHK / property type prefix
    if bhk:
        if bhk == 0.5:
            pieces.append("1 RK")
        elif bhk == int(bhk):
            pieces.append(f"{int(bhk)} BHK")
        else:
            pieces.append(f"{bhk} BHK")
    elif property_category == "commercial":
        pieces.append("Commercial")

    # Transaction type
    if listing_type == "sale":
        pieces.append("for Sale")
    elif listing_type == "rent":
        pieces.append("for Rent")

    # Locality
    loc_parts = []
    if resolved_locality and resolved_locality.strip():
        loc_parts.append(resolved_locality)
        if raw_mention and raw_mention.lower() != resolved_locality.lower():
            loc_parts.append(f"({raw_mention})")
    elif raw_mention:
        loc_parts.append(raw_mention)
    if loc_parts:
        pieces.append("in " + " ".join(loc_parts))

    # Building
    if building_name:
        pieces.append(f"— {building_name}")

    # Price
    price_amount = None
    price_raw = None
    if isinstance(price, dict):
        price_amount = price.get("amount")
        price_raw = price.get("raw_price_text")

    if price_amount is not None and price_amount > 0:
        period = price.get("period") if isinstance(price, dict) else None
        is_rent = listing_type == "rent" or period == "per_month"
        price_str = _format_price_amount(price_amount, is_rent)
        pieces.append(f"— {price_str}")
    elif price_raw:
        pieces.append(f"— {price_raw}")
    elif listing_type == "requirement":
        if isinstance(price, dict) and price.get("raw_price_text"):
            pieces.append(f"— Budget {price['raw_price_text']}")

    title = " ".join(pieces)
    return title.strip() if title.strip() else "Listing"


_PRICE_SCALES = [
    (1_00_00_000, "Cr", 1_00_00_000),
    (1_00_000, "Lakh", 1_00_000),
    (1_000, "K", 1_000),
]


def _format_price_amount(amount: float, is_rent: bool = False) -> str:
    if amount <= 0:
        return "Price on request"
    for threshold, label, divisor in _PRICE_SCALES:
        if amount >= threshold:
            value = amount / divisor
            fmt = f"₹{value:.1f} {label}" if value != int(value) else f"₹{int(value)} {label}"
            if is_rent:
                fmt += "/month"
            return fmt
    fmt = f"₹{int(amount):,}"
    if is_rent:
        fmt += "/month"
    return fmt


# ── Image detection ──────────────────────────────────────────────────

def _has_flyer_image(ctx: dict) -> bool:
    msg = ctx.get("msg", {})
    if not isinstance(msg, dict):
        return False
    has_image = "imageMessage" in msg
    if not has_image:
        return False
    msg_text = ctx.get("msg_text", "")
    return len(msg_text.strip()) < 100


# ── Main extraction function ──────────────────────────────────────────

def _call_provider(
    provider: dict,
    messages: list[dict],
    timeout: int = 45,
    *,
    source_id: int | None = None,
    tenant_id: str | None = None,
) -> dict | list | None:
    """Call a single LLM provider. Returns a parsed JSON object/array or None.

    Logs every completed API call (success or truncated) to ai_usage_log so
    cost is never silently lost.
    """
    from usage_logger import log_ai_usage

    try:
        client = OpenAI(api_key=provider["api_key"], base_url=provider["base_url"])
        request = dict(
            model=provider["model"],
            messages=messages,
            temperature=0.1,
            # Reasoning models (notably Qwen 3.6) can spend their first tokens
            # thinking before emitting the final JSON.  1,024 was often not
            # enough for both; a truncated reasoning response has no content
            # and was incorrectly treated as an unavailable provider.
            max_tokens=2048,
            timeout=timeout,
        )
        # Doubleword supports OpenAI-compatible JSON mode.  Its response must
        # be an object, hence the stable {"items": [...]} envelope in the
        # prompt above.  Other providers retain the portable prompt-only path.
        if provider["name"] == "doubleword":
            request["response_format"] = {"type": "json_object"}
        resp = client.chat.completions.create(**request)
        usage = getattr(resp, "usage", None)
        tokens_in = getattr(usage, "prompt_tokens", 0) or 0
        tokens_out = getattr(usage, "completion_tokens", 0) or 0

        choice = resp.choices[0]
        raw = choice.message.content
        truncated_no_content = False
        if not raw or not raw.strip():
            reasoning = getattr(choice.message, "reasoning_content", None)
            finish_reason = getattr(choice, "finish_reason", None)
            truncated_no_content = True
            if reasoning:
                _logger.warning(
                    "Provider %s returned reasoning but no final JSON (finish=%s)",
                    provider["name"], finish_reason,
                )
            else:
                _logger.warning(
                    "Provider %s returned empty content (finish=%s)",
                    provider["name"], finish_reason,
                )
            # Log the spend even though the output was empty
            log_ai_usage(
                agent="extraction",
                model=provider["model"],
                tokens_input=tokens_in,
                tokens_output=tokens_out,
                source="raw_message",
                source_id=source_id,
                provider_name=provider["name"],
                tenant_id=tenant_id,
                truncated=True,
            )
            return None

        # Log successful call
        log_ai_usage(
            agent="extraction",
            model=provider["model"],
            tokens_input=tokens_in,
            tokens_output=tokens_out,
            source="raw_message",
            source_id=source_id,
            provider_name=provider["name"],
            tenant_id=tenant_id,
        )

        cleaned = raw.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[-1] if "\n" in cleaned else cleaned[3:]
            if cleaned.endswith("```"):
                cleaned = cleaned[:-3].strip()
        parsed = json.loads(cleaned)
        # The structured-output envelope keeps JSON mode compatible with both
        # single and multi-listing broker posts.  Keep accepting the legacy
        # object/array shape from non-Doubleword providers during rollout.
        if isinstance(parsed, dict) and isinstance(parsed.get("items"), list):
            return parsed["items"]
        return parsed
    except json.JSONDecodeError:
        _logger.warning("Provider %s returned malformed JSON", provider["name"])
        return None
    except Exception as exc:
        status = getattr(exc, "status_code", None) or getattr(exc, "code", None)
        if status == 429:
            _logger.info("Provider %s rate-limited (429), will retry next key", provider["name"])
        else:
            _logger.warning("Provider %s failed: %s", provider["name"], exc)
        return None


def ai_extract(raw_text: str, ctx: dict | None = None, storage=None) -> dict:
    """Main entry point: try AI providers in rotation, fall back to regex.

    Returns a dict with:
        extraction: dict — first normalized extraction result (compatibility)
        extractions: list[dict] — every normalized opportunity in the message
        extraction_source: "ai" | "regex_fallback" | "image_unprocessed"
        needs_review: bool
        provider_used: str | None
        error: str | None
    """
    start = time.time()
    result = {
        "extraction": None,
        "extractions": [],
        "extraction_source": None,
        "needs_review": False,
        "provider_used": None,
        "error": None,
    }

    # ── Image-only message? ──────────────────────────────────────
    if ctx and _has_flyer_image(ctx):
        result["extraction_source"] = "image_unprocessed"
        result["needs_review"] = True
        result["extraction"] = {
            "listing_type": None,
            "property_category": None,
            "bhk": None,
            "carpet_area_sqft": None,
            "price": {"amount": None, "unit": None, "period": None, "raw_price_text": None},
            "locality": {"raw_mention": None, "resolved_locality": None, "confidence": "low"},
            "building_name": None,
            "furnishing_status": None,
            "amenities": [],
            "possession_status": None,
            "title": "Listing (image — needs review)",
            "extraction_confidence": "low",
        }
        _logger.info("ai_extract: image-only message flagged unprocessed (%s)", time.time() - start)
        return result

    # ── Not enough text? ──────────────────────────────────────────
    if not raw_text or len(raw_text.strip()) < 10:
        result["extraction_source"] = "regex_fallback"
        result["needs_review"] = True
        result["extraction"] = None
        _logger.info("ai_extract: text too short (%s)", time.time() - start)
        return result

    # ── Build messages ────────────────────────────────────────────
    messages = [
        {"role": "system", "content": _EXTRACTION_SYSTEM_PROMPT},
        {"role": "user", "content": f"Extract listing data from this WhatsApp broker message:\n\n{raw_text}"},
    ]

    # Try providers in round-robin, up to total provider count attempts
    attempts = 0
    max_attempts = len(_PROVIDERS) * 2  # Allow two full rotations
    last_error = None
    _src_id = ctx.get("message_id") if ctx else None
    _tid = ctx.get("tenant_id") if ctx else None

    while attempts < max_attempts:
        provider = _next_provider()
        if provider is None:
            last_error = "No providers configured"
            break

        attempts += 1
        raw_extraction = _call_provider(provider, messages, source_id=_src_id, tenant_id=_tid)

        if raw_extraction is None:
            # Backoff before trying next provider (avoids cascading rate limits)
            import time as _time
            _time.sleep(min(attempts * 1.5, 8))
            continue

        candidates = raw_extraction if isinstance(raw_extraction, list) else [raw_extraction]
        normalized_items: list[dict] = []
        for candidate in candidates:
            if not isinstance(candidate, dict):
                continue
            normalized = _normalize_extraction(candidate)
            if normalized.get("listing_type") is None:
                _logger.warning("Provider %s: skipped an item without listing_type", provider["name"])
                continue

            # Locality resolution against reference table
            loc = normalized.get("locality", {})
            if isinstance(loc, dict) and loc.get("raw_mention") and not loc.get("resolved_locality"):
                resolved = resolve_locality(loc["raw_mention"], storage=storage)
                if resolved["resolved_locality"]:
                    loc["resolved_locality"] = resolved["resolved_locality"]
                    loc["confidence"] = resolved["confidence"]

            if not normalized.get("title"):
                normalized["title"] = generate_title(normalized)
            normalized_items.append(normalized)

        if not normalized_items:
            _logger.warning("Provider %s: schema validation failed (no valid listings)", provider["name"])
            continue

        result["extraction"] = normalized_items[0]
        result["extractions"] = normalized_items
        result["extraction_source"] = "ai"
        result["provider_used"] = provider["name"]
        result["needs_review"] = any(item.get("extraction_confidence") == "low" for item in normalized_items)

        _logger.info(
            "ai_extract: %d item(s) via %s in %.1fs",
            len(normalized_items), provider["name"], time.time() - start,
        )
        return result

    # ── All providers failed — flag for regex fallback ────────────
    result["extraction_source"] = "regex_fallback"
    result["needs_review"] = True
    result["error"] = last_error or f"All {len(_PROVIDERS)} providers failed after {attempts} attempts"

    _logger.warning(
        "ai_extract: all providers failed in %.1fs — %s",
        time.time() - start, result["error"],
    )
    return result


def ai_extract_sync(raw_text: str, ctx: dict | None = None, storage=None) -> dict:
    """Synchronous wrapper for ai_extract (calls the async-compatible sync code directly)."""
    return ai_extract(raw_text, ctx, storage)
