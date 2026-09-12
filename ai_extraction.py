"""Structured extraction pipeline for broker WhatsApp messages.

Provider rotation uses the same deployment-configured chain as chat.

The pipeline uses an LLM boundary-only pass when a message may contain
multiple independent source blocks, then passes the verbatim source to the
normal model extraction route.

The model still owns the final structured fields, but it no longer sees a
flat blob of text with no document shape.

Usage:
    from ai_extraction import ai_extract
    result = await ai_extract(raw_text, ctx)
    if result["extraction_source"] == "ai":
        # Use result["extraction"] (the structured schema)
    else:
        # No structured extraction was produced; queue for review.
"""

import json
import logging
import os
import re
import time
from datetime import datetime, timezone
from threading import Lock
from typing import Any, Optional

from openai import OpenAI
from llm import get_configured_providers
from extraction_models import validate_source_semantics
from extraction_quality import building_name_problem, canonicalize_extraction_confidence
from price_normalization import canonical_price_rupees
from source_boundary import apply_source_boundary
from price_plausibility import apply_price_plausibility_guard
from agents.building_alias_engine import fuzzy_score
from domain_glossary import build_ai_domain_context
from config import get_region_config
from preflight_classifier import (
    is_explicit_heading as _is_explicit_heading,
)

_logger = logging.getLogger(__name__)

# Reference data is effectively read-mostly.  Without a short-lived cache the
# extraction hot path performs a building-alias query for every WhatsApp
# message (and locality fallback can perform three more queries).  Keep these
# caches process-local and bounded; writes become visible after the TTL.
_REFERENCE_CACHE_TTL_SECONDS = max(30.0, float(os.getenv("EXTRACTION_REFERENCE_CACHE_TTL_SECONDS", "300")))
_REFERENCE_CACHE_MAX_TENANTS = 32
_REFERENCE_CACHE_LOCK = Lock()
_ALIAS_ROWS_CACHE: dict[str, tuple[float, list[dict]]] = {}
_BUILDING_LOCALITY_CACHE: dict[tuple[str, str], tuple[float, dict]] = {}

_BULK_INVENTORY_RE = re.compile(
    r"(?i)\b(?:direct\s+inventor(?:y|ies)|signature\s+spaces|property\s+portfolio|"
    r"multiple\s+(?:properties|options)|all\s+properties)\b"
)
def _coerce_float(value) -> float | None:
    if value in (None, ""):
        return None
    if isinstance(value, dict):
        for key in ("amount", "value", "number", "count", "min", "max"):
            if key in value:
                coerced = _coerce_float(value.get(key))
                if coerced is not None:
                    return coerced
        return None
    if isinstance(value, (list, tuple)):
        for item in value:
            coerced = _coerce_float(item)
            if coerced is not None:
                return coerced
        return None
    text = str(value).strip().replace(",", "")
    if not text or text.lower() in {".", "-", "+", "null", "none"}:
        return None
    if re.search(r"\.{2,}", text):
        return None
    match = re.search(r"-?\d+(?:\.\d+)?", text)
    if not match:
        return None
    try:
        return float(match.group(0))
    except (TypeError, ValueError):
        return None


def _coerce_int(value) -> int | None:
    coerced = _coerce_float(value)
    return int(coerced) if coerced is not None else None


# ── Provider configuration ────────────────────────────────────────────

# Chat and WhatsApp share one provider chain; extraction intentionally
# diverges from it.  Structured field extraction needs precision, not deep
# reasoning, and premium models (grid/merge) cost 15-30x more per token.
# Small fast models are therefore tried first and premium ones are kept as
# an escalation fallback for when every cheap provider fails or returns
# malformed JSON.  Set EXTRACTION_MODEL (e.g. "llama-3.1-8b-instant") to
# pin a specific model ahead of all others; otherwise any non-premium model
# present in the chain is preferred.
# The deployment-wide chain is used by other backend paths. Sarvam has a
# separate extraction credential so enabling chat must not spend that key on
# extraction accidentally.
_PROVIDERS: list[dict] = [
    provider for provider in get_configured_providers()
    if provider.get("name") not in {"sarvam", "sarvam_1", "sarvam_2", "sarvam_3", "sarvam_4"}
]


def _append_extraction_provider(
    providers: list[dict],
    *,
    env_prefix: str,
    name: str,
    default_base_url: str,
    api_key_override: str = "",
    supports_json_mode: bool = True,
    reasoning_effort: str | None = "none",
    max_tokens: int = 4096,
    model_override: str = "",
    base_url_override: str = "",
) -> None:
    """Append an extraction-only OpenAI-compatible provider, when configured.

    These credentials are intentionally separate from the chat provider chain:
    a temporary backlog-drain budget must not be consumed by interactive chat.
    """
    api_key = (api_key_override or os.getenv(f"{env_prefix}_API_KEY", "")).strip()
    model = (model_override or os.getenv(f"{env_prefix}_MODEL", "")).strip()
    base_url = (base_url_override or os.getenv(f"{env_prefix}_BASE_URL", default_base_url)).strip()
    if api_key and model:
        providers.append({
            "name": name,
            "api_key": api_key,
            "base_url": base_url,
            "model": model,
            "supports_json_mode": supports_json_mode,
            "max_tokens": max_tokens,
        })
        if reasoning_effort:
            providers[-1]["reasoning_effort"] = reasoning_effort
        elif env_prefix.startswith("EXTRACTION_SARVAM"):
            # Sarvam-105B enables low reasoning when the field is omitted.
            # An explicit JSON null is required to disable it and preserve
            # the completion budget for the structured answer.
            providers[-1]["disable_reasoning"] = True
    elif api_key or model:
        _logger.warning(
            "Skipping extraction provider %s: set both %s_API_KEY and %s_MODEL",
            name,
            env_prefix,
            env_prefix,
        )


# OpenRouter is an optional extraction lane. It must be explicitly enabled so
# the OpenRouter key used by chat/OpenClaw cannot silently add a second
# extraction provider. This keeps extraction deterministic: a deployment with
# Doubleword configured does not also consume OpenRouter credits by default.
def _openrouter_extraction_enabled() -> bool:
    return os.getenv("EXTRACTION_OPENROUTER_ENABLED", "false").strip().lower() in {
        "1", "true", "yes", "on"
    }


_openrouter_extraction_key = os.getenv("EXTRACTION_OPENROUTER_API_KEY", "").strip()
_openrouter_free_enabled = os.getenv("EXTRACTION_OPENROUTER_FREE_ENABLED", "false").strip().lower() in {
    "1", "true", "yes", "on"
}
if _openrouter_extraction_enabled() and _openrouter_free_enabled:
    _append_extraction_provider(
        _PROVIDERS,
        env_prefix="EXTRACTION_OPENROUTER",
        name="extraction-openrouter-free",
        default_base_url="https://openrouter.ai/api/v1",
        api_key_override=_openrouter_extraction_key,
        supports_json_mode=True,
        reasoning_effort="low",
        max_tokens=8192,
    )
if _openrouter_extraction_enabled():
    # SECONDARY is model-agnostic. DEEPSEEK remains a transition fallback so
    # an existing deployment keeps working until Coolify is renamed.
    _secondary_key = (
        os.getenv("EXTRACTION_OPENROUTER_SECONDARY_API_KEY", "").strip()
        or os.getenv("EXTRACTION_OPENROUTER_DEEPSEEK_API_KEY", "").strip()
        or _openrouter_extraction_key
    )
    _secondary_model = (
        os.getenv("EXTRACTION_OPENROUTER_SECONDARY_MODEL", "").strip()
        or os.getenv("EXTRACTION_OPENROUTER_DEEPSEEK_MODEL", "").strip()
    )
    _secondary_base_url = (
        os.getenv("EXTRACTION_OPENROUTER_SECONDARY_BASE_URL", "").strip()
        or os.getenv("EXTRACTION_OPENROUTER_DEEPSEEK_BASE_URL", "").strip()
        or "https://openrouter.ai/api/v1"
    )
    _append_extraction_provider(
        _PROVIDERS,
        env_prefix="EXTRACTION_OPENROUTER_SECONDARY",
        name="extraction-openrouter-secondary",
        default_base_url="https://openrouter.ai/api/v1",
        api_key_override=_secondary_key,
        supports_json_mode=True,
        reasoning_effort="low",
        max_tokens=16384,
        model_override=_secondary_model,
        base_url_override=_secondary_base_url,
    )

# Doubleword remains the paid, quality-preserving extraction fallback.
_append_extraction_provider(
    _PROVIDERS,
    env_prefix="EXTRACTION_SARVAM",
    name="extraction-sarvam",
    default_base_url="https://api.sarvam.ai/v1",
    # Extraction needs compact schema-valid JSON. Reasoning consumed the
    # output budget on Sarvam and left no final JSON (finish=length).
    reasoning_effort=None,
    # Sarvam 105B can spend substantial output on the expanded typed schema;
    # 4096 caused reasoning-only responses with finish=length and no JSON.
    max_tokens=8192,
)

# Optional Sarvam-hosted open-source fallback. Keep this on a separate key
# switch because the beta models require whitelist access and use Sarvam's v2
# endpoint. Gemma 4 answers directly without a reasoning trace, making it a
# safer structured-JSON fallback than reasoning-first open-source models.
_sarvam_open_source_key = os.getenv("EXTRACTION_SARVAM_OPEN_SOURCE_API_KEY", "").strip()
if _sarvam_open_source_key:
    _append_extraction_provider(
        _PROVIDERS,
        env_prefix="EXTRACTION_SARVAM_OPEN_SOURCE",
        name="extraction-sarvam-gemma4",
        default_base_url="https://api.sarvam.ai/v2",
        api_key_override=_sarvam_open_source_key,
        model_override=os.getenv("EXTRACTION_SARVAM_OPEN_SOURCE_MODEL", "gemma4").strip() or "gemma4",
        reasoning_effort=None,
        max_tokens=8192,
    )

_append_extraction_provider(
    _PROVIDERS,
    env_prefix="EXTRACTION_DOUBLEWORD",
    name="extraction-doubleword",
    default_base_url="https://api.doubleword.ai/v1",
)

# Append Gemini as a fallback provider (used when MERGE key is exhausted).
# Checks ENRICHMENT_GEMINI_KEY first (scoped for enrichment/extraction),
# then falls back to GEMINI_API_KEY (production key).
_gemini_key = os.getenv("ENRICHMENT_GEMINI_KEY") or os.getenv("GEMINI_API_KEY", "")
if _gemini_key:
    _PROVIDERS.append({
        "name": "gemini",
        "provider": "gemini",
        "api_key": _gemini_key,
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "model": "gemini-3.1-flash-lite",
    })

_EXTRACTION_MODEL = os.getenv("EXTRACTION_MODEL", "").strip().lower()
_EXTRACTION_FALLBACK_ORDER = any(
    provider.get("name") in {
        "extraction-openrouter-free",
        "extraction-openrouter-secondary",
        "extraction-sarvam",
        "extraction-sarvam-gemma4",
    }
    for provider in _PROVIDERS
)
try:
    _EXTRACTION_PROVIDER_TIMEOUT = max(
        30, int(os.getenv("EXTRACTION_PROVIDER_TIMEOUT_SECONDS", "180"))
    )
except ValueError:
    _logger.warning(
        "Invalid EXTRACTION_PROVIDER_TIMEOUT_SECONDS; using 180 seconds"
    )
    _EXTRACTION_PROVIDER_TIMEOUT = 180
_PREMIUM_MODEL_HINTS = (
    "claude", "opus", "sonnet", "haiku",
    "code-max", "code_max", "text-max", "text_max",
    "gpt-", "o1", "o3", "o4",
)


def _extraction_provider_priority(provider: dict) -> int:
    """Sort key used to order extraction providers cheap-first.

    Tier 0 = pinned/preferred cheap model, tier 1 = any other non-premium
    model, tier 2 = premium escalation.  The sort is stable, so within a
    tier the original chain order is preserved and round-robin still
    distributes load evenly across equal-cost providers.
    """
    model = (provider.get("model") or "").lower()
    name = provider.get("name") or ""
    if name == "extraction-sarvam":
        return 0
    if name == "extraction-sarvam-gemma4":
        return 0
    if name == "extraction-openrouter-free":
        return 1
    if name == "extraction-openrouter-secondary":
        return 1
    if name == "extraction-doubleword":
        return 2
    if _EXTRACTION_MODEL and _EXTRACTION_MODEL in model:
        return 3
    if any(hint in model for hint in _PREMIUM_MODEL_HINTS):
        return 4
    return 3 if _EXTRACTION_FALLBACK_ORDER else (1 if _EXTRACTION_MODEL else 0)


_PROVIDERS.sort(key=_extraction_provider_priority)

# Round-robin pointer
_rr_index = 0
_rr_lock = __import__("threading").Lock()
_provider_cooldowns: dict[str, float] = {}
_provider_cooldown_lock = Lock()


def _response_headers(value) -> dict[str, str]:
    """Return the small set of rate-limit headers exposed by an SDK object."""
    headers = getattr(value, "headers", None)
    if headers is None:
        response = getattr(value, "response", None)
        headers = getattr(response, "headers", None)
    if not headers:
        return {}
    wanted = (
        "retry-after", "x-ratelimit-limit", "x-ratelimit-remaining",
        "x-ratelimit-reset", "ratelimit-limit", "ratelimit-remaining",
        "ratelimit-reset",
    )
    return {
        key: str(headers[key])
        for key in wanted
        if key in headers
    }


def _retry_after_seconds(headers: dict[str, str]) -> float:
    raw = headers.get("retry-after", "")
    try:
        return max(1.0, min(120.0, float(raw)))
    except (TypeError, ValueError):
        return 5.0


def _wait_for_provider_cooldown(provider_name: str) -> None:
    with _provider_cooldown_lock:
        remaining = _provider_cooldowns.get(provider_name, 0.0) - time.monotonic()
    if remaining > 0:
        time.sleep(remaining)


def _cooldown_provider(provider_name: str, seconds: float) -> None:
    with _provider_cooldown_lock:
        _provider_cooldowns[provider_name] = max(
            _provider_cooldowns.get(provider_name, 0.0),
            time.monotonic() + seconds,
        )


def _next_provider(attempt: int = 0) -> dict | None:
    global _rr_index
    if not _PROVIDERS:
        return None
    if _EXTRACTION_FALLBACK_ORDER:
        return _PROVIDERS[attempt % len(_PROVIDERS)]
    with _rr_lock:
        p = _PROVIDERS[_rr_index]
        _rr_index = (_rr_index + 1) % len(_PROVIDERS)
    return p


# ── Extraction prompt ─────────────────────────────────────────────────

# Runtime extraction uses `_UNIFIED_EXTRACTION_PROMPT` as the normal single
# model call. It can classify mixed messages and return multiple item-scoped
# routes in one response. `_get_extraction_prompt()` remains available for
# explicit route-specific tools and compatibility tests, but is not invoked as
# a routine second pass during production extraction.

# ── Schema validation ─────────────────────────────────────────────────

_PRICE_PARSING_INSTRUCTIONS = """PRICE PARSING — CRITICAL:
- Convert explicit units to absolute rupees: 1 Cr = 10000000, 1 Lakh = 100000, and K = 1000.
- Indian broker shorthand: L/l, lac, lacs, lakh, and lakhs all mean lakh rupees;
  never interpret L/l as million. Thus 1.85L = 185000 rupees, 2.20L = 220000
  rupees, and 4L = 400000 rupees. Preserve the source spelling in raw_price_text,
  but use lakh semantics in the amount and any generated title.
- “8.5 Cr” means 85000000, never 8.5 or 8500000.
- “2.50 Lakhs” means 250000; “75 K” means 75000.
- “8.5.Cr”, “2:25 Cr”, “4'25 Cr”, and “75.Lakh” use punctuation as a separator: parse them as 8.5 Cr, 2.25 Cr, 4.25 Cr, and 75 Lakh. An apostrophe between price digits is a decimal separator here, not a thousands separator.
- Preserve raw_price_text exactly as written in the source.
- “60k” or “95k” means thousand. A decimal k-quote below 5 such as “1.20k”
  or “3.5k” in a Mumbai residential rental may mean lakh, but 5k and above
  always retains thousand semantics (for example 14.5k=14500). Preserve the
  raw text and set needs_review=true when context does not make the unit clear.
- For PSF/per-sqft quotes use unit “per_sqft” and keep amount as the per-sqft rate; otherwise use unit “total”.
- When the source states a price range, set amount to the lower bound and amount_max to the upper bound. Preserve the full range in raw_price_text.
- Never infer a price from unrelated numbers such as floor, parking, area, or phone numbers."""

_GENERIC_PRICE_PARSING_INSTRUCTIONS = """PRICE PARSING — CRITICAL:
- Convert explicit units to absolute rupees: 1 Cr = 10000000, 1 Lakh = 100000, and K = 1000.
- Preserve the exact source spelling in raw_price_text.
- Treat L/l, lac, lakh, Cr/crore, and K as Indian currency units only when the
  source context supports that interpretation.
- For PSF/per-sqft quotes use unit `per_sqft`; otherwise use unit `total`.
- Do not infer a recurring period, deposit, or sale/rent intent when the source
  does not support it; use the evidence tier `unknown` and set needs_review.
- Never infer a price from unrelated numbers such as floor, parking, area, or phone numbers."""

# This compact, production-facing subset of ``docs/GLOSSARY.md`` is shared
# through a helper so every AI extraction route receives the same vocabulary.
_MUMBAI_BROKER_GLOSSARY = build_ai_domain_context()
_ACTIVE_REGION_CONFIG = get_region_config()
_ACTIVE_BROKER_GLOSSARY = (
    _MUMBAI_BROKER_GLOSSARY
    if os.getenv("EXTRACTION_REGION", "mumbai").strip().casefold() == "mumbai"
    else _ACTIVE_REGION_CONFIG.get("broker_glossary", "")
)
_ACTIVE_PRICE_PARSING_INSTRUCTIONS = (
    _PRICE_PARSING_INSTRUCTIONS
    if os.getenv("EXTRACTION_REGION", "mumbai").strip().casefold() == "mumbai"
    else _GENERIC_PRICE_PARSING_INSTRUCTIONS
)


def _classify_message_flags(text: str) -> tuple[str, str, bool]:
    """Classify the extraction route before asking an LLM for fields.

    This is deliberately conservative: a marketing phrase such as “looking
    for the perfect office” is not a requirement unless the message actually
    asks someone to source a property.
    """
    value = (text or "").lower()
    demand = re.search(
        r"\b(?:urgent\s+)?(?:requirement|required|wanted|want|need|needed|seeking|looking\s+for|looking\s+to\s+(?:buy|rent)|client\s+(?:needs?|is\s+looking)|buyer\s+required|tenant\s+required|chahiye|koi\s+.+\s+(?:hai|available)\s+kya)\b",
        value,
    )
    supply = re.search(
        r"\b(?:available|inventory|direct\s+listing|for\s+(?:rent|sale)|rent\s*[-:]|sale\s*[-:]|asking|outright|inspection|carpet\s+area|possession)\b",
        value,
    )
    separator_count = len(re.findall(r"(?m)^\s*[━─]{3,}\s*$", text or ""))
    repeated_inventory_markers = len(re.findall(
        r"(?i)\b(?:rent|sale|carpet|area)\s*[-:–]", value
    ))
    bulk_inventory = bool(_BULK_INVENTORY_RE.search(value)) and (
        separator_count >= 2 or repeated_inventory_markers >= 3
    )
    # A footer may say that a client profile is required before a viewing. It
    # is an instruction attached to a supply broadcast, not buyer demand.
    is_requirement = bool(demand and not (supply and demand.start() > supply.start()))
    if bulk_inventory:
        is_requirement = False

    investor_unit_commercial = bool(
        re.search(r"\binvestor\s+unit\b", value)
        and re.search(r"\b(?:lease|rent|rental)\b", value)
        and re.search(r"\bpremises\b", value)
        and not re.search(
            r"\b(?:\d+(?:\.\d+)?\s*(?:bhk|rk)|flat|apartment|residential|villa|bungalow|independent\s+(?:house|home))\b",
            value,
        )
    )
    commercial = bool(re.search(
        r"\b(?:office|shop|showroom|warehouse|godown|industrial|retail|commercial|hotel|hospitality|restaurant|banquet|lodging|bare\s*shell|warm\s*shell|plug[- ]and[- ]play|chargeable\s+area|ceiling\s+height|mezzanine|cabin|workstation|conference\s+room|cam|lease\s+deed|power\s+load|food\s+court|otla)\b",
        value,
    )) or investor_unit_commercial
    rent = bool(re.search(
        r"\b(?:rent|rental|lease|monthly|per\s+month|deposit|tenancy|lock[- ]in|notice\s+period|lease\s+out)\b",
        value,
    ))
    # Mumbai shorthand: S/F means semi-furnished. When it is attached to an
    # @-quoted amount, brokers use the line as a rental quote even when they
    # omit the word "rent". Never treat S/F itself as sale evidence.
    semi_furnished_rental_quote = bool(re.search(
        r"\b(?:s\s*/\s*f|sf)\b\s*@\s*₹?\s*\d",
        value,
    ))
    if semi_furnished_rental_quote:
        rent = True
    sale = bool(re.search(
        r"\b(?:sale|sell|buy|purchase|outright|outrate|asking|quote|sale\s+price|crore|cr)\b",
        value,
    ))
    # Mumbai broker shorthand often omits the word "rent" in inventory
    # broadcasts: `3 BHK ... 2.75 lac nego` is a monthly rental quote, while a
    # sale quote is normally marked sale/asking/outright or expressed in Cr.
    # Do not let the old final `sale` default turn an unlabeled residential
    # lakh quote into public sale inventory.
    unlabeled_residential_lakh = bool(
        _ACTIVE_REGION_CONFIG.get("unlabeled_lakh_is_rental", False)
        and not commercial
        and not sale
        and re.search(r"\b\d+(?:\.\d+)?\s*(?:lacs?|lakhs?|lac|l)\b", value)
        and re.search(r"\b(?:\d+(?:\.\d+)?\s*(?:bhk|rk)|flat|apartment|residential|villa|bungalow)\b", value)
    )
    if is_requirement and rent:
        transaction = "rent"
    elif is_requirement and sale:
        transaction = "sale"
    elif rent and not sale:
        transaction = "rent"
    elif unlabeled_residential_lakh:
        transaction = "rent"
    elif sale and not rent:
        transaction = "sale"
    elif rent and sale:
        transaction = "rent" if value.find("rent") < value.find("sale") else "sale"
    else:
        transaction = "sale"
    return ("commercial" if commercial else "residential", transaction, is_requirement)


def classify_message_type(text: str) -> tuple[str, str]:
    """Return the deterministic ``(asset_type, transaction_type)`` route."""
    asset, transaction, is_requirement = _classify_message_flags(text)
    return asset, ("requirement" if is_requirement else transaction)


_FOCUSED_FIELDS = {
    ("residential", "sale", False): "bhk, original_bhk, current_bhk, configuration_type, configuration_details, is_converted_unit, is_combination_unit, can_sell_separately, carpet_area_sqft, built_up_area_sqft, super_built_up_area_sqft, balcony_area_sqft, balcony_area_raw_text, terrace_area_sqft, covered_terrace_area_sqft, terrace_area_raw_text, sellable_area_sqft, price, price_basis, price_math, locality, building_name, wing, furnishing_status, unit_condition, availability_status, possession_status, possession_date, bathroom_count, car_parking_count, parking_type, parking_details, floor_range, floor_min, floor_max, floor_label, property_view, view_description, vastu_compliant, age_of_property, building_amenities, amenities, amenities_unverified_claim, brokerage_type, brokerage_context, co_brokered, token_amount, payment_plan, society_restrictions, society_restrictions_raw, showing_instructions, contact_instructions, broker_company, contacts, unstructured_facts, deal_tags, title",
    ("residential", "rent", False): "bhk, original_bhk, current_bhk, configuration_type, configuration_details, is_converted_unit, is_combination_unit, carpet_area_sqft, built_up_area_sqft, balcony_present, balcony_area_sqft, balcony_area_raw_text, terrace_area_sqft, covered_terrace_area_sqft, terrace_area_raw_text, sit_out_present, price, locality, building_name, furnishing_status, unit_condition, availability_status, availability_date_raw, available_from, possession_status, bathroom_count, car_parking_count, parking_type, parking_details, floor_range, floor_min, floor_max, floor_label, wing, has_lift, building_amenities, amenities, amenities_unverified_claim, property_view, view_description, deposit_amount, deposit_months, deposit_raw_text, pet_policy, tenant_type_preference, sharing_allowed, food_preference, lease_term_type, lease_term_min_months, lease_term_max_months, lease_term_raw_text, lock_in_period_months, notice_period_months, brokerage_type, brokerage_context, brokerage_terms_raw, plus_one_deal, fee_sharing_required, client_profile_required, society_restrictions, society_restrictions_raw, broker_company, contacts, company_lease_criteria, showing_instructions, contact_instructions, unstructured_facts, deal_tags, title",
    ("commercial", "sale", False): "commercial_use_type, carpet_area_sqft, built_up_area_sqft, chargeable_area_sqft, super_built_up_area_sqft, saleable_area_sqft, price, price_basis, price_math, locality, building_name, fitout_status, occupancy_status, ceiling_height, floor_level, floor_range, car_parking_count, power_load_kw, cabin_count, director_cabin_count, manager_cabin_count, ceo_cabin_present, cubicle_count, workstation_count, conference_room_count, washroom_count, ladies_washroom_count, gents_washroom_count, pantry_type, reception_area, server_room, storage_area, telephone_booth_count, play_area, has_central_ac, has_power_backup, has_lift, terrace_area_sqft, covered_terrace_area_sqft, terrace_area_raw_text, frontage_ft, entrance_count, permitted_use_types, ideal_for, project_inventory, area_min_sqft, area_max_sqft, floor_plate_sqft, project_status, building_amenities, broker_rera_number, brokerage_type, deal_tags, title",
    ("commercial", "rent", False): "commercial_use_type, carpet_area_sqft, built_up_area_sqft, chargeable_area_sqft, mezzanine_area_sqft, area_raw_text, area_min_sqft, area_max_sqft, price, price_basis, price_math, locality, building_name, fitout_status, ceiling_height, floor_level, floor_range, deposit_amount, deposit_months, deposit_raw_text, cam_amount, cam_applicable, cam_unit, power_load_kw, cabin_count, director_cabin_count, manager_cabin_count, ceo_cabin_present, cubicle_count, workstation_count, conference_room_count, conference_room_capacity, meeting_room_count, meeting_room_capacity, training_room_capacity, cafeteria_seat_count, washroom_count, ladies_washroom_count, gents_washroom_count, pantry_type, reception_area, server_room, storage_area, telephone_booth_count, play_area, accounts_area, lounge_area, terrace_area_sqft, covered_terrace_area_sqft, terrace_area_raw_text, frontage_ft, entrance_count, otla_area_sqft, otla_area_raw_text, heritage_space, permitted_use_types, ideal_for, automatic_shutter_count, room_count, suite_count, banquet_hall_count, restaurant_count, bar_facility, operational_status, rent_inclusions, possession_status, possession_date, availability_status, inspection_notice_minutes, license_type, short_term_allowed, lease_term_type, lock_in_period_months, notice_period_months, escalation_pct, escalation_frequency, rent_free_period_months, fitout_period_months, lease_deed_type, sub_leasing_allowed, building_amenities, broker_rera_number, brokerage_type, deal_tags, needs_review, title",
    ("residential", "sale", True): "bhk_options, budget_min, budget_max, area_min_sqft, area_max_sqft, locality_options, landmark_options, building_preferences, furnishing_preference, possession_preference, car_parking_min, buyer_type, transaction_nature, urgency, is_flexible, deal_tags, needs_review, title",
    ("residential", "rent", True): "bhk_options, configuration_preference, budget_min, budget_max, area_min_sqft, area_max_sqft, carpet_area_min_sqft, carpet_area_max_sqft, built_up_area_min_sqft, built_up_area_max_sqft, locality_options, landmark_options, building_preferences, furnishing_preference, possession_preference, age_preference, floor_preference, view_preference, deposit_budget_max, tenant_type, nationality, has_pets, sharing_acceptable, food_preference, car_parking_min, amenity_requirements, lease_term_preference, company_lease_criteria, brokerage_willingness, urgency, is_flexible, deal_tags, needs_review, title",
    ("commercial", "sale", True): "commercial_use_type, area_min_sqft, area_max_sqft, budget_min, budget_max, budget_per_sqft_max, locality_options, landmark_options, fitout_preference, car_parking_min, needs_mezzanine, needs_lift, needs_power_backup, needs_central_ac, min_power_load_kw, buyer_type, urgency, is_flexible, deal_tags, needs_review, title",
    ("commercial", "rent", True): "commercial_use_type, intended_use_details, area_min_sqft, area_max_sqft, area_basis_preference, budget_min, budget_max, budget_per_sqft_max, budget_includes_maintenance, locality_options, location_flexibility, fitout_preference, floor_min, floor_max, floor_count_max, floor_preference, consecutive_floors_required, car_parking_min, parking_required, needs_attached_washroom, needs_washroom, needs_pantry, needs_mezzanine, needs_lift, needs_power_backup, needs_central_ac, power_requirements, premium_building_required, glass_facade_required, residential_cum_commercial_ok, by_lanes_accepted, entrance_requirement, signage_required, loading_access_required, min_cabin_count, min_workstation_count, needs_conference_room, deposit_budget_max, lease_term_preference, max_lock_in_months, max_notice_period_months, company_type, team_size, media_requested, urgency, brokerage_context, brokerage_terms_raw, contacts, is_flexible, deal_tags, title",
}


_RESIDENTIAL_SALE_EXTRACTION_RULES = """
Residential sale listing rules:
- Bulk broadcasts: emit one item per property row/block. If a heading such as
  "3 BHK FOR SALE" or "ANDHERI WEST" applies to following blocks, carry that
  context into each item that uses it. Do not let one block's facts leak into
  another unrelated block.
- A section heading such as "Cuffe Parade / Nariman Point / Colaba" or "New
  Listings added" is context, not a property item or title. Item-specific
  locality overrides the shared heading. A generic/anonymized label such as
  "Cuffe Parade - Premium Tower", "Confidential Building", or "New Project"
  is not a building name: keep building_name null and retain any useful words
  only as unstructured facts. Never manufacture a building identity.
- Source evidence: each item should be faithful to its listing slice. Shared
  footer contact/company details may be copied to every item, but broker footer
  text must not become building, locality, price, requirement, or title data.
  Company/person/RERA/footer lines and broker instructions such as "allow 24
  hrs", "client profile needed", and "for details/visits" are never listings.
- "+1": "Available in+1", "available in +1", "my +1", or standalone "+1"
  means co-brokered. Set co_brokered=true and brokerage_context="+1". Never
  treat this as floor, area, deposit, price, or BHK.
- Terrace/balcony: never add balcony or terrace area into carpet_area_sqft.
  Use balcony_area_sqft/balcony_area_raw_text and
  terrace_area_sqft/covered_terrace_area_sqft/terrace_area_raw_text. Preserve
  the full wording in area_raw_text.
- Price math: if a PSF quote and explicit sellable/chargeable area are stated,
  set sellable_area_sqft, computed_total_asking_price, computed_price_confidence,
  and price_math with formula/inputs/source. If only carpet plus terrace is
  stated and no sellable area is stated, do not assume terrace weighting; record
  the areas and leave computed_total_asking_price null or low-confidence.
- Contacts: extract every explicit contact number, up to 8, into contacts.
  Preserve associated person/company names when present. broker_phone is only
  the primary contact; contacts should keep the additional team numbers.
- Society restrictions: extract explicit diet/community/religion/society
  conditions exactly as written into society_restrictions_raw and canonical
  tags in society_restrictions. Never infer these restrictions.
- Showing/access: "1 day notice", "key with me", "for inspection contact",
  "call for details" and similar operational instructions belong in
  showing_instructions or contact_instructions.
- Unit configuration: "3+2 BHK combination" means is_combination_unit=true and
  configuration_details. "3BHK converted into 2BHK" means
  is_converted_unit=true, original_bhk=3, current_bhk=2, bhk/current_bhk=2.
- Wing/floor: "G wing" means wing="G". "below 10th floor" means
  floor_label="below 10th floor" and floor_max=9. "higher floor" means
  floor_label="higher floor"; do not invent a floor number.
- Views/vastu: keep canonical searchable view in property_view when obvious,
  but preserve rich wording in view_description. "vastu compliant" means
  vastu_compliant=true; do not put it in orientation.
"""


_RESIDENTIAL_RENT_EXTRACTION_RULES = """
Residential rent listing rules:
- Bulk broadcasts: emit one item per independently actionable apartment. Carry
  a shared BHK, locality, or contact footer into each item only when the source
  structure clearly applies it. Do not let one item's price, area, or tenant
  rule leak into another item.
- A normal apartment rental is supported. PG, hostel, paying-guest, dormitory,
  co-living, room-sharing, and bed-by-bed offers are not supported inventory;
  do not emit typed listing items for them.
- Mumbai rent shorthand: in a clear residential-rental context, decimal
  k-quotes below 5 such as 1.30k, 2.50k, or 3.5k may mean 1.30 lakh,
  2.50 lakh, or 3.5 lakh respectively. Preserve the exact raw text and
  normalize to absolute rupees. Values of 5k or more retain thousand
  semantics: 5k=5000, 14.5k=14500, and 25k=25000. Plain 130k remains 130000.
  Never normalize 1.30k to 1300 or 14.5k to 14.5 lakh.
- For total monthly residential rent, a small decimal k-value is lakh
  shorthand: 1.30k=130000, 1.3k=130000, 2.50k=250000, and 3.5k=350000.
  This typo-rescue applies only below 5k; 5k and above is a valid literal
  monthly rent in lower-cost Mumbai Metropolitan Region markets.
  This rule does not apply to per_sqft rates, sale prices, deposits,
  maintenance, parking charges, or other fees. If the context is unclear,
  preserve the source quote and set needs_review=true.
- Normalize L/l, lac, lacs, lakh, and lakhs to lakh semantics. For example,
  1.85L is 185000 rupees, never 1850000; generated titles must say
  1.85 Lakh/month rather than 18.5 Lakh/month.
- Lease language means RENT. Extract lease duration separately from lock-in:
  “3/5 years lease” is lease_term_min_months=36 and lease_term_max_months=60,
  while lock_in_period_months is only for an explicit lock-in period.
- Deposits: “3 months deposit” populates deposit_months; a flat amount such as
  “2 lakh deposit” populates deposit_amount. Preserve deposit_raw_text. Do not
  invent a deposit amount when only months are given.
- Residential rent is normally maintenance/CAM inclusive. Do not invent or
  split residential maintenance or CAM fields.
- Tenant rules are facts: preserve family, bachelor, expat, company lease,
  pets, vegetarian, or similar wording. Do not turn them into requirements or
  silently omit them.
- Balcony, terrace, and sit-out are separate from carpet area. Never add them
  to carpet_area_sqft. Preserve raw wording and use the dedicated area fields.
- “No lift” and “No car park” are explicit negatives: set has_lift=false or
  car_parking_count=0. Missing information remains null.
- Views and vague claims: store a canonical property_view only when clear and
  preserve rich wording in view_description or unstructured_facts. “All
  amenities” remains an unverified claim; do not invent an amenity list.
- Explicit use context is a separate fact from asset_type. For wording such
  as “ideal for”, “suitable for”, “use as”, or “commercial use”, preserve the
  source-stated options in unstructured_facts.suitable_for as a list. This
  applies even when a property is described as residential-cum-commercial:
  do not turn that wording into a building name, and do not invent or broaden
  the stated use options. Include the fact in the public SEO title or
  description only when it is clearly supported by this source slice.
- Contacts: extract every explicit phone number, up to 8, with associated
  person/company names. broker_phone is only the primary contact; contacts
  retains the team numbers.
- Indian brokerage language: “+1”, “plus one”, “sharing”, “joint deal”, or
  “mandate plus one” means a fee-sharing arrangement. Set plus_one_deal=true
  and fee_sharing_required=true, preserve brokerage_terms_raw, and never infer
  the fee percentage. “Mandate” alone is not exclusive; only explicit
  “exclusive mandate” means exclusive.
- Company lease criteria such as MNCs, consulates, paid-up capital, client
  profile required, or corporate tenant preference belong in
  company_lease_criteria, client_profile_required, tenant_type_preference, or
  unstructured_facts. Preserve the exact source wording.
- Typos: preserve the broker's original text. Resolve a known locality alias
  for search only when the match is strong and context supports it; never
  fabricate a building name. “Building name: please call” remains null.
- Availability dates without an unambiguous year should be preserved in
  availability_date_raw; do not invent a year. “Immediate” belongs in
  availability_status.
- A message saying sale and lease for the same property preserves both modes;
  do not silently choose one. A sale-priced crore quote without rent language
  is not monthly rent, even if a heading contains a typo such as “RANTAL”.
- Same-inventory matching across brokers is not extraction. Preserve each
  broker's observation and source-specific facts; never merge or suppress it.
"""


_COMMERCIAL_RENT_EXTRACTION_RULES = """
Commercial rent listing rules:
- Commercial supply includes offices, shops, retail/showrooms, restaurants/cafes,
  warehouses/godowns/sheds, hotels/guest houses, and similar business premises.
  Preserve the specific use in commercial_use_type and permitted_use_types.
- Extract one independently actionable unit or floor-level option per item. A
  message with multiple floors and distinct rates becomes linked items; keep
  each floor's own area and rate. A project availability range is one project
  inventory item with area_min_sqft/area_max_sqft, not fabricated individual
  offices.
- Area basis matters: keep carpet_area_sqft, built_up_area_sqft, and
  chargeable_area_sqft separate. Treat “loft” and “mezzanine” as
  mezzanine_area_sqft; never add it to carpet or chargeable area. A per-sqft rent explicitly quoted on chargeable
  area must use chargeable_area_sqft; on carpet area use carpet_area_sqft. If
  the basis and total are clear, compute monthly_rent and preserve price_math
  with rate, basis, area, and formula. Never silently use carpet area for a
  chargeable-area quote.
- Composite area is not a total by default. For “600 + 360 Loft”, preserve
  `area_raw_text`, set `mezzanine_area_sqft=360`, and do not put 960 into
  `carpet_area_sqft` or `chargeable_area_sqft`. Only assign the 600 to a
  dedicated primary-area field when the source explicitly states its basis.
- Commercial rent is monthly. Normalize “pkg”, “package”, “pckg”, and “packg”
  to ordinary monthly rent; do not turn them into deposit, CAM, or a 1% charge.
  Preserve price.raw_price_text and set price_basis="monthly" when the source
  gives only a package amount. CAM is separate only when explicitly stated.
- Indian commercial rent uses lakh shorthand too: L/l, lac, lacs, lakh, and
  lakhs mean lakh rupees, never million. Therefore 1.85L=185000 rupees and
  2.20L=220000 rupees. For a total monthly rent only, decimal k-values below
  5 such as 1.30k or 3.5k mean 130000 or 350000 rupees respectively. Values
  of 5k or more retain thousand semantics: 14.5k=14500. Do not
  apply that k-rule to per_sqft rates, sale prices, deposits, CAM, maintenance,
  or other fees; set needs_review=true when the context is ambiguous.
- Deposits: “6 months deposit” sets deposit_months; a flat amount sets
  deposit_amount. Do not derive a deposit amount from months. Keep deposit_raw_text.
- Capture office capacity and facilities when stated: workstations, cabins,
  director/CEO cabins, cubicles, conference/meeting/training room capacities,
  cafeteria seats, pantry, reception, server/storage/accounts/lounge areas,
  washrooms, parking, lift, power backup, central AC, telephone booths, and
  play areas. Preserve separate manager, ladies-washroom, and gents-washroom
  counts when the source states them.
- Price examples: “Rent 190 rs build-up” means `price=190`,
  `rent_per_sqft=190`, `price_basis="built_up_area_sqft"`, and the original
  wording in `price_raw_text`; it is not a ₹190 monthly rent.
- Capture commercial-specific facts such as terrace/otla areas, covered terrace,
  frontage, entrance count, ceiling height, automatic shutters, heritage space,
  short-term/leave-and-license terms, inspection notice, operational hotel
  facilities, and rent inclusions. Do not fold terrace/otla into carpet area.
- “L&L” means leave-and-license; store license_type accordingly. “PKG/package”
  is not an old-style deposit calculation.
- Broker RERA numbers such as “RERA NO - A51900002370”, “MahaRERA”, or
  “RERA: ...” belong in broker_rera_number. Keep property/project RERA separate.
- Preserve typos in raw evidence, but normalize obvious search aliases only in
  search-oriented fields. Do not invent prices, areas, amenities, or building
  names. Keep missing building_name null.
- Locality must use {"raw_mention": ..., "resolved_locality": ..., "confidence": ...};
  never emit a `normalized` key. Use null for unresolved canonical locality.
- `needs_review` is required when a price/unit, area basis, or other material fact
  is ambiguous. Furnished, semi-furnished, bare-shell, and builder-finish are
  `fitout_status` values, never `deal_tags`. Deal tags must use only the documented
  whitelist.
- When a building is named, make the title specific using only the building
  name present in the current source message. Never use a remembered or
  illustrative building name in a title.
- Deal-source facts such as “deal side by side only”, “mandate”, “plus one”,
  and brokerage wording belong in brokerage_context/brokerage_terms_raw or
  unstructured_facts; do not merge inventory across different brokers.
"""

_GENERIC_RESIDENTIAL_RENT_EXTRACTION_RULES = """
Residential rent listing rules:
- Emit one item per independently actionable property and keep each item's
  price, area, tenant rule, and contact tied to its own source text.
- Do not emit unsupported room/bed/hostel offers as normal apartment listings.
- Lease language means rent; extract lease duration separately from lock-in.
- Preserve deposits, tenant rules, amenities, negatives, availability dates,
  and exact source wording without inventing missing values.
- Infer a recurring rent period only when the source and surrounding context
  make that interpretation clear; otherwise use an unknown evidence tier and
  set needs_review=true.
"""


_COMMERCIAL_SALE_EXTRACTION_RULES = """
Commercial sale listing rules:
- Commercial sale supply includes offices, shops, showrooms, retail, restaurants,
  warehouses, and developer/project inventory. Preserve commercial_use_type.
- A message with multiple options under one building is multiple linked listing
  items. Keep each option's own area, floor, parking, furnishing, and asking price;
  never combine the options into one averaged row.
- A project/developer broadcast with an area range and no specific unit or price
  is one project_inventory item with area_min_sqft/area_max_sqft, developer name,
  project_status, floor_plate_sqft, and amenities. Never fabricate one listing per
  size in the range.
- Keep carpet, built-up, chargeable, saleable, terrace, and covered-terrace areas
  separate. Never fold terrace or frontage into carpet. A per-sqft sale quote may
  be multiplied only when the source explicitly states the pricing area; preserve
  price_math with rate, basis, area, and formula. Otherwise keep price_per_sqft
  without inventing total_asking_price.
- Total quotes such as “₹7.20 Cr” populate total_asking_price. “Negotiable” is a
  price qualifier/deal tag, not a changed amount. Preserve raw price text.
- Capture office facilities and capacities: workstations, cabins, director/CEO
  cabins, cubicles, conference/meeting rooms, pantry, reception, server/storage,
  parking, lift, power backup, and central AC.
- Capture frontage, entrances, ceiling height, permitted uses, inspection/access
  instructions, and project amenities when explicitly stated. Preserve uncertain
  marketing claims as unverified facts rather than inventing structured values.
- Broker RERA formats belong in broker_rera_number; property/project RERA remains
  separate. Extract all explicit contacts, up to 8, with the primary broker phone
  kept distinct from the contacts list.
- Preserve the original source evidence and broker wording. Never merge inventory
  from different brokers; same building does not mean the same office/unit.
"""


_RESIDENTIAL_RENT_REQUIREMENT_RULES = """
Residential rent requirement rules:
- This is demand, not supply. Keep listing_type="requirement" and never create
  a listing from a requirement phrase such as "looking for" or "required".
- Extract BHK/configuration exactly, including 1 RK, 2.5 BHK, jodi, and converted
  layouts. Use bhk_options/configuration_preference; do not force a whole number.
- Extract monthly budget in absolute rupees. "70k" is 70000, "1.30 lakh" is
  130000, and "up to 1.5L" sets budget_max=150000. Never treat a deposit as rent.
- Preserve locality corridors and alternatives in locality_options, including
  "Bandra to Santacruz West" or "Andheri East to Goregaon East". Keep the raw
  wording in the source evidence and do not collapse a corridor into one place.
- Extract area ranges, area basis, furnishing preference, floor preference,
  higher/lower/middle-floor wording, view preference, parking minimum, amenities,
  possession timing, and building preferences when explicitly stated.
- Tenant facts are important searchable requirements: family, bachelor, couple,
  student, expat, company lease, pets, sharing, vegetarian/food preference, and
  other explicit occupancy conditions. Preserve them without judging or filtering.
- Deposit requirements may be a flat amount or months of rent. Store a flat
  amount in deposit_budget_max only when explicitly stated; preserve month-based
  wording in the raw evidence and do not convert it without a rent basis.
- Lease terms such as 3/5 years, short-term, immediate possession, and company
  lease belong in lease_term_preference/possession_preference.
- Reject PG/hostel/bed-sharing-only demand as out of scope: return no item for it.
- Residential rent normally does not have separate CAM or maintenance fields;
  do not invent them. Brokerage wording and "side by side" belong in
  brokerage_willingness or the raw evidence.
- Set needs_review=true when budget units, BHK, locality, or another material
  requirement is ambiguous. Keep deal_tags restricted to the whitelist.
"""


_RESIDENTIAL_SALE_REQUIREMENT_RULES = """
Residential sale requirement rules:
- This is purchase demand, not supply. Keep listing_type="requirement" and
  never create a listing from phrases such as "looking to buy", "want to
  purchase", "buyer required", or "client is looking". Do not invent a
  building or available unit from the request.
- Extract every stated configuration into bhk_options, preserving 1 RK,
  fractional BHK, jodi, converted layouts, and alternatives. Do not force a
  single BHK when the buyer gives a range or multiple options.
- Budget is the purchase price, not monthly rent. Normalize absolute totals
  into budget_min and budget_max:
  "70 lakh" becomes 7000000, "1.30 lakh" becomes 130000, "1.5 crore"
  becomes 15000000, and "up to 2 Cr" sets budget_max=20000000. Preserve
  whether the source says total purchase price or per-square-foot budget;
  never treat a rent, deposit, token, or maintenance amount as the purchase
  budget. If a per-sqft quote is ambiguous or cannot be separated from a
  total price, preserve the raw wording and flag the requirement for review.
- Extract area ranges into area_min_sqft/area_max_sqft. Keep the stated area
  basis and raw wording in the evidence; do not turn a carpet-area preference
  into a fabricated built-up or saleable area.
- Preserve locality corridors and alternatives in locality_options, including
  "Bandra to Santacruz West", "Andheri East or Powai", and similar wording.
  Do not collapse a corridor into one locality or silently choose a preferred
  endpoint. Keep locality ambiguity flagged for review.
- building_preferences are preferences, not facts about an available
  property. Capture named buildings, societies, project types, or explicit
  building requirements only when stated; do not invent a building name.
- furnishing_preference, car_parking_min, possession_preference, and urgency
  are explicit constraints. "Ready possession" or "immediate" means an
  immediate/ready requirement; "under construction acceptable" and stated
  delivery timelines belong in possession_preference. Do not infer a
  possession timeline from a sale advertisement or a generic "buy" phrase.
- buyer_type is only "end-use", "investment", or the source's explicit
  equivalent when stated. Never infer end-use versus investment from budget,
  locality, or BHK.
- transaction_nature captures an explicit resale, new, builder, or
  under-construction preference. Do not infer resale merely because a buyer
  wants immediate possession, or new construction merely because the message
  mentions a project.
- is_flexible is true only for explicit flexibility such as "flexible budget",
  "negotiable", or "open to options"; preserve the qualifying wording and do
  not manufacture flexibility from a broad range. deal_tags remain restricted
  to the documented whitelist and require source evidence.
- Set needs_review=true when the budget unit or amount is ambiguous, a BHK or
  locality corridor cannot be resolved, total versus per-sqft pricing is
  unclear, or another material purchase constraint conflicts or is incomplete.
  Do not hide an explicitly stated budget, BHK, locality, or preference merely
  because the request is informal.
- title should describe the demand, such as "3 BHK Buyer Requirement in Bandra
  West", and must not read like an advertised available property.
"""


_COMMERCIAL_SALE_REQUIREMENT_RULES = """
Commercial sale requirement rules:
- This is purchase demand, not supply. Keep listing_type="requirement" and
  never invent a building, asking price, or available commercial unit from a
  request such as "looking to buy an office" or "client wants a shop".
- Extract commercial_use_type precisely: office, retail/shop, showroom,
  warehouse/godown, restaurant/cafe, industrial, or another explicit use.
  Preserve qualifiers such as "for a clinic", "ground-floor retail", or
  "warehouse for storage" in the structured use and title/evidence. Do not
  broaden a specific use into generic commercial space.
- Extract area ranges into area_min_sqft/area_max_sqft. Preserve whether the
  source says carpet, built-up, chargeable, or another basis in the evidence;
  do not fabricate a missing maximum from wording such as "800+".
- Budget is a purchase price or an explicit purchase PSF ceiling, never rent.
  Normalize "up to 5 Cr" to budget_max=50000000 and "₹25,000 per sqft max"
  to budget_per_sqft_max=25000. A single total purchase figure sets the
  appropriate budget bound; a range sets budget_min/budget_max. Do not invent
  CAM, maintenance, deposit, or other rental fields because they do not exist
  in this sale-requirement schema. Flag total-versus-PSF or lakh/crore unit
  ambiguity for review while preserving the raw wording.
- Preserve locality corridors and flexibility in locality_options, including
  "Bandra to Santacruz West", highway/road preferences, alternatives, and
  "okay with nearby areas". Do not collapse a corridor into one locality or
  silently discard an explicit flexibility condition.
- fitout_preference captures only an explicit bare-shell, warm-shell,
  furnished, ready-office, or similar purchase preference. Do not infer fitout
  from the intended use or from a project name.
- car_parking_min is a minimum only when the buyer explicitly requests parking
  or a number of spaces. needs_mezzanine, needs_lift, needs_power_backup, and
  needs_central_ac are booleans only for explicit constraints; never infer
  them from building class, floor, locality, or commercial_use_type.
- min_power_load_kw is populated only from an explicit load requirement such
  as "minimum 20 kW". Preserve the unit and flag ambiguous electrical
  language for review; do not derive a load from area or intended use.
- buyer_type is end-use, investment, or another explicit buyer description
  only when stated. Never infer it from the property type, budget, or urgency.
- urgency and is_flexible require source evidence. "Immediate purchase",
  "urgent", "open to nearby locations", and "budget flexible" may be
  captured when explicitly stated; do not convert a generic inquiry into an
  urgent or flexible requirement.
- deal_tags remain restricted to the documented whitelist and require explicit
  evidence. Set needs_review=true when budget units, total-versus-PSF basis,
  area, commercial use, locality corridor, or any material amenity constraint
  is ambiguous or conflicting.
- title should describe the demand, such as "Commercial Office Purchase
  Requirement in Andheri East", and must not read like an available listing.
"""


_COMMERCIAL_RENT_REQUIREMENT_RULES = """
Commercial rent requirement rules:
- This is demand, not supply. Keep listing_type="requirement" and never invent
  a building, rent, or available unit from the request.
- Extract the intended use precisely: office, gaming office, cafe, retail, etc.
  Preserve qualifiers such as “for gaming purpose” or “cafe (induction)” in
  intended_use_details/unstructured_facts.
- Area ranges populate area_min_sqft/area_max_sqft and area_basis_preference
  (usually carpet). “800+” means area_min_sqft=800 with no fabricated maximum.
- Preserve location corridors and flexibility: “Bandra to Santacruz West”,
  “Malad East to Goregaon East on highway”, “okay with by lanes”, and similar
  wording belong in locality_options/location_flexibility. Do not collapse a
  corridor into one locality.
- Budget is a monthly rental budget. “90K to 1 lakh” becomes budget_min=90000
  and budget_max=100000. A single “up to 150K” sets budget_max=150000.
- Normalize common broker spellings such as “lack”, “lacs”, “lac”, and “L” to
  lakh when the surrounding text clearly describes a budget. Preserve the raw
  wording and set needs_review=true if the unit remains ambiguous.
- Furnishing is a preference. Capture minimum cabins, workstations, conference
  rooms, washrooms, attached washroom, pantry, lift, parking, floor range, and
  building standards as explicit constraints. “Commercial building not
  necessary” means residential_cum_commercial_ok=true; “only commercial premium
  building” means premium_building_required=true and the commercial preference.
- Capture operational requirements such as a street-facing or visible entrance,
  signage/branding visibility, loading or vehicle access, power/load needs,
  ground-floor or floor-count limits, and consecutive-floor requirements. Keep
  “near [road]”, “road touch”, and preferred roads in location_flexibility rather
  than inventing a normalized locality.
- If the budget explicitly includes maintenance/CAM, set
  budget_includes_maintenance=true; otherwise leave it null. Do not invent CAM
  for a requirement merely because it is common in commercial leases.
- Extract “glass facade”, “photos/pics requested”, and similar non-price needs as
  structured searchable requirements when present. Never treat photos as proof
  that a listing has been verified.
- “Brokerage side by side” belongs in brokerage_context/brokerage_terms_raw.
  Extract every stated contact, up to 8, while keeping the primary broker phone
  separate. Preserve urgent wording in urgency.
"""


def _get_extraction_prompt(
    asset_type: str,
    transaction_type: str,
    is_requirement: bool = False,
    mixed_transaction: bool = False,
) -> str:
    """Build a small route-specific prompt instead of sending all 85 fields."""
    fields = _FOCUSED_FIELDS[(asset_type, transaction_type, is_requirement)]
    # These fields form the cross-route evidence/public contract. Keeping them
    # outside the route lists meant focused passes silently dropped the source
    # slice and SEO copy even though the unified pass knew about them.
    fields = f"{fields}, source_slice, source_notes, broker_notes, unstructured_facts, property_intelligence, landmark_options, public_seo_title, public_seo_description"
    side = "DEMAND/REQUIREMENT" if is_requirement else "SUPPLY/LISTING"
    route_rules = ""
    if (asset_type, transaction_type, is_requirement) == ("residential", "sale", False):
        route_rules = _RESIDENTIAL_SALE_EXTRACTION_RULES
    elif (asset_type, transaction_type, is_requirement) == ("residential", "rent", False):
        route_rules = (
            _RESIDENTIAL_RENT_EXTRACTION_RULES
            if os.getenv("EXTRACTION_REGION", "mumbai").strip().casefold() == "mumbai"
            else _GENERIC_RESIDENTIAL_RENT_EXTRACTION_RULES
        )
    elif (asset_type, transaction_type, is_requirement) == ("commercial", "rent", False):
        route_rules = _COMMERCIAL_RENT_EXTRACTION_RULES
    elif (asset_type, transaction_type, is_requirement) == ("commercial", "sale", False):
        route_rules = _COMMERCIAL_SALE_EXTRACTION_RULES
    elif (asset_type, transaction_type, is_requirement) == ("commercial", "rent", True):
        route_rules = _COMMERCIAL_RENT_REQUIREMENT_RULES
    elif (asset_type, transaction_type, is_requirement) == ("residential", "rent", True):
        route_rules = _RESIDENTIAL_RENT_REQUIREMENT_RULES
    elif (asset_type, transaction_type, is_requirement) == ("residential", "sale", True):
        route_rules = _RESIDENTIAL_SALE_REQUIREMENT_RULES
    elif (asset_type, transaction_type, is_requirement) == ("commercial", "sale", True):
        route_rules = _COMMERCIAL_SALE_REQUIREMENT_RULES
    expected_listing_type = "requirement" if is_requirement else transaction_type
    listing_type_rule = (
        f'- listing_type: exactly "{expected_listing_type}".'
        if is_requirement
        else '- listing_type: infer "sale" or "rent" from the source block. The route below is only a field-schema hint, not a hard label; an explicit rent/sale marker or price label in the source overrides it. If the source contains independently actionable sale and rent options, emit one item per option.'
    )
    return f"""You are an expert AI real-estate extraction analyst for Indian WhatsApp broker messages.
First interpret what each source block means, then map it to the allowed JSON schema. You are extracting {side} data with an initial schema hint of {asset_type} {transaction_type}; this hint is not authoritative when the raw source says otherwise. Return only valid JSON:
{{"items": [{{...}}]}}. Emit one object per independently actionable property or requirement.
Use the raw source as the evidence, but infer the semantic role of clearly labelled
fields from normal broker wording (for example `Rent`, `Outright`, `Rental`, `Sale`,
`Quote`, `Budget`, `BHK`, `Carpet`, and `Building`). Do not require the source to use
the exact schema field names. Never invent facts from outside the message, average,
merge separate units, or summarize raw text. Preserve locality.raw_mention and
price.raw_price_text exactly. For requirements use arrays/ranges and never turn a
concrete advertised availability into a requirement.
Every explicit fact in the source must be returned when it belongs to the allowed
schema. For requirements, an explicitly stated BHK, budget, locality preference,
furnishing preference, tenant type, or lease/company-lease condition is mandatory;
do not omit it merely because it is not needed to identify the opportunity.

Every item MUST include these discriminator fields:
{listing_type_rule}
- property_category: exactly "{asset_type}".
- extraction_confidence: one of "high", "medium", or "low".
Fields allowed for the remaining route-specific data: {fields}.
Use `source_notes` for concise source-grounded notes that do not fit a typed
field (for example broker instructions, viewing constraints, unusual layout,
or deal context). Use `broker_notes` for every additional explicit broker note
that is not already represented by a typed field; each note must include a
category, faithful text, and source_text from this item only. Use
`unstructured_facts` for additional structured key/value facts. Never use any
of these fields to introduce facts not present in the source.
{_ACTIVE_PRICE_PARSING_INSTRUCTIONS}
{_ACTIVE_BROKER_GLOSSARY}
{route_rules}
For listing price, return price={{amount, unit, period, raw_price_text}}. For a requirement,
return budget_min/budget_max instead of pretending the budget is a listing price.
Return no markdown or explanation."""

_VALID_LISTING_TYPES = frozenset({"sale", "rent", "lease", "pg", "joint_venture", "requirement"})
_VALID_CATEGORIES = frozenset({"residential", "commercial"})
_VALID_FURNISHING = frozenset({"unfurnished", "semi_furnished", "fully_furnished"})
_VALID_CONFIDENCE = frozenset({"high", "medium", "low"})
_VALID_POSSESSION = frozenset({
    "ready_to_move", "under_construction", "ready_possession",
    "oc_received", "preleased", "not_specified",
})
_VALID_AVAILABILITY = frozenset({
    "available", "sold", "let_out", "withdrawn", "closed", "not_specified",
})
_VALID_FURNISHING_CANONICAL = frozenset({
    "fully_furnished", "semi_furnished", "unfurnished", "bare_shell",
    "builder_finish", "not_specified",
})
_VALID_PRICE_UNITS = frozenset({"total", "per_sqft"})
_VALID_PRICE_PERIODS = frozenset({"one_time", "per_month"})

# Alias maps bridge common LLM variants to the canonical enum values used
# downstream.  Higher recall here directly means more rows survive
# `_normalize_extraction` instead of being dropped with "no valid listings".
_LISTING_TYPE_ALIASES = {
    "sale": "sale",
    "for_sale": "sale",
    "selling": "sale",
    "sell": "sale",
    "rent": "rent",
    "for_rent": "rent",
    "rental": "rent",
    "rentals": "rent",
    "rent_out": "rent",
    "lease": "rent",
    "requirement": "requirement",
    "requirements": "requirement",
    "needed": "requirement",
    "need": "requirement",
    "wanted": "requirement",
    "want": "requirement",
    "seeking": "requirement",
    "looking_for": "requirement",
    "listing": "sale",
    "sale_listing": "sale",
    "rental_listing": "rent",
    "rent_listing": "rent",
    "demand": "requirement",
    "buyer_requirement": "requirement",
    "tenant_requirement": "requirement",
}
_CATEGORY_ALIASES = {
    "residential": "residential",
    "resi": "residential",
    "residential_apartment": "residential",
    "residential_property": "residential",
    "home": "residential",
    "commercial": "commercial",
    "comm": "commercial",
    "commercial_property": "commercial",
    "office": "commercial",
    "shop": "commercial",
    "retail": "commercial",
}
_TRANSACTION_TYPE_ALIASES = {
    "for_sale": "sale",
    "selling": "sale",
    "sell": "sale",
    "for_rent": "rent",
    "rental": "rent",
    "rentals": "rent",
    "rent_out": "rent",
    "available_on_lease": "lease",
    "pre_leased": "preleased",
}
_POSSESSION_ALIASES = {
    "immediate": "ready_to_move",
    "immediate_possession": "ready_to_move",
    "ready": "ready_to_move",
    "ready_to_move": "ready_to_move",
    "ready_to_occupy": "ready_to_move",
    "possession_available": "ready_to_move",
    "available_for_possession": "ready_to_move",
    "under_construction": "under_construction",
    "oc_received": "oc_received",
    "oc_available": "oc_received",
    "pre_leased": "preleased",
    "preleased": "preleased",
}
_AVAILABILITY_ALIASES = {
    "available": "available",
    "available_now": "available",
    "active": "available",
    "live": "available",
    "on_market": "available",
    "vacant": "available",
    "sold_out": "sold",
    "rented_out": "let_out",
    "leased_out": "let_out",
    "let_out": "let_out",
    "deal_closed": "closed",
}
_PRICE_UNIT_ALIASES = {
    "total": "total",
    "total_price": "total",
    "absolute": "total",
    "lump_sum": "total",
    "overall": "total",
    "monthly": "total",
    "per_month": "total",
    "one_time": "total",
    "per_sqft": "per_sqft",
    "psf": "per_sqft",
    "per_square_foot": "per_sqft",
    "per_square_feet": "per_sqft",
    "per_sq_ft": "per_sqft",
}
_PRICE_PERIOD_ALIASES = {
    "one_time": "one_time",
    "upfront": "one_time",
    "single_payment": "one_time",
    "per_month": "per_month",
    "monthly": "per_month",
    "month": "per_month",
    "monthly_rent": "per_month",
}
_FURNISHING_ALIASES = {
    "unfurnished": "unfurnished",
    "bare": "unfurnished",
    "bare_shell": "bare_shell",
    "bare_shell_finish": "bare_shell",
    "semi_furnished": "semi_furnished",
    "semi-furnished": "semi_furnished",
    "semifurnished": "semi_furnished",
    "semi_finished": "semi_furnished",
    "semi-finished": "semi_furnished",
    "part_furnished": "semi_furnished",
    "part-furnished": "semi_furnished",
    "s_f": "semi_furnished",
    "semi": "semi_furnished",
    "fully_furnished": "fully_furnished",
    "fully-furnished": "fully_furnished",
    "fully_finished": "fully_furnished",
    "fully-finished": "fully_furnished",
    "fully_loaded": "fully_furnished",
    "fully-loaded": "fully_furnished",
    "full_furnished": "fully_furnished",
    "furnished": "fully_furnished",
    "builder_finish": "builder_finish",
    "builder-finish": "builder_finish",
}
_VALID_DEAL_TAGS = frozenset({
    "distress_sale",
    "urgent_sale",
    "negotiable",
    "bank_auction",
    "resale",
    "exclusive_mandate",
    "price_drop",
    "brand_new_building",
})
_VALID_CHARGE_TYPES = frozenset({"fixed", "percent_of_price"})
_VALID_BROKER_NOTE_CATEGORIES = frozenset({
    "negotiation", "legal", "charges", "access", "media", "utility",
    "tenant_rule", "building", "unit", "brokerage", "other",
})
_PROPERTY_INTELLIGENCE_SECTIONS = frozenset({
    "unit_features", "building_features", "pricing_terms", "access_and_rules",
    "location_context", "relationships", "unresolved_mentions",
})

# Fields are intentionally copied after the discriminator-specific
# normalisation below.  Keeping this allow-list explicit prevents arbitrary
# provider output from reaching storage while ensuring the eight route schemas
# do not silently lose valid commercial/residential attributes.
_PASSTHROUGH_FIELDS = frozenset({
    "built_up_area_sqft", "chargeable_area_sqft", "mezzanine_area_sqft", "area_raw_text",
    "broker_rera_number", "floor_level", "floor_count", "possession_status",
    "super_built_up_area_sqft", "saleable_area_sqft", "project_inventory",
    "area_min_sqft", "area_max_sqft", "floor_plate_sqft", "project_status",
    "possession_date", "availability_status", "price_math", "rent_inclusions",
    "license_type", "short_term_allowed", "inspection_notice_minutes",
    "frontage_ft", "entrance_count", "otla_area_sqft", "otla_area_raw_text",
    "terrace_area_sqft", "covered_terrace_area_sqft", "terrace_area_raw_text",
    "heritage_space", "permitted_use_types", "ideal_for", "automatic_shutter_count",
    "room_count", "suite_count", "banquet_hall_count", "restaurant_count",
    "bar_facility", "operational_status", "director_cabin_count", "manager_cabin_count",
    "ceo_cabin_present", "cubicle_count", "conference_room_capacity",
    "meeting_room_capacity", "training_room_capacity", "cafeteria_seat_count",
    "accounts_area", "lounge_area", "telephone_booth_count", "ladies_washroom_count",
    "gents_washroom_count", "play_area",
    "price_basis", "commercial_use_type", "fitout_status", "ceiling_height",
    "floor_range", "car_parking_count", "parking_type", "power_load_kw",
    "cabin_count", "workstation_count", "conference_room_count",
    "meeting_room_count", "washroom_count", "pantry_type",
    "has_central_ac", "has_power_backup", "has_lift", "building_amenities",
    "amenities_unverified_claim", "bathroom_count", "parking_count",
    "property_view", "view_description", "age_of_property", "configuration_type",
    "configuration_details", "original_bhk", "current_bhk", "is_converted_unit",
    "is_combination_unit", "can_sell_separately", "availability_status",
    "brokerage_context", "co_brokered", "wing", "floor_min", "floor_max",
    "floor_label", "balcony_area_sqft", "balcony_area_raw_text",
    "terrace_area_sqft", "covered_terrace_area_sqft", "terrace_area_raw_text",
    "sellable_area_sqft", "computed_total_asking_price",
    "computed_price_confidence", "price_math", "unit_condition",
    "vastu_compliant", "parking_details", "society_restrictions",
    "society_restrictions_raw", "broker_company", "contacts",
    "showing_instructions", "contact_instructions", "source_notes", "unstructured_facts",
    "possession_date", "oc_status", "brokerage_type", "token_amount",
    "payment_plan", "transaction_nature", "deposit_amount", "deposit_months",
    "deposit_raw_text", "cam_amount", "cam_applicable", "cam_unit",
    "lease_term_type", "lock_in_period_months", "notice_period_months", "occupancy_status",
    "deal_tags", "broker_notes", "needs_review", "title",
    # Requirement-only fields. These must survive normalization so the
    # typed requirement tables receive ranges, budgets, and preferences.
    "area_min_sqft", "area_max_sqft", "budget_min", "budget_max",
    "budget_per_sqft_max", "locality_options", "fitout_preference",
    "intended_use_details", "area_basis_preference", "location_flexibility",
    "floor_min", "floor_max", "floor_count_max", "floor_preference",
    "consecutive_floors_required", "parking_required",
    "needs_attached_washroom", "needs_washroom", "needs_pantry",
    "power_requirements", "entrance_requirement", "signage_required",
    "loading_access_required", "budget_includes_maintenance",
    "premium_building_required", "glass_facade_required",
    "residential_cum_commercial_ok", "by_lanes_accepted", "media_requested",
    "min_cabin_count", "min_workstation_count", "needs_conference_room",
    "brokerage_terms_raw",
    "landmark_options",
    "car_parking_min", "needs_mezzanine", "needs_lift", "needs_power_backup",
    "needs_central_ac", "min_power_load_kw", "buyer_type", "urgency",
    "is_flexible", "transaction_nature", "building_preferences", "age_preference",
    "view_preference", "brokerage_willingness",
    "bhk_options", "furnishing_preference", "tenant_type",
    "sharing_acceptable", "food_preference", "amenity_requirements",
    "company_lease_criteria", "lease_term_preference", "nationality",
    "property_intelligence", "arrangement", "evidence_tiers", "inference_notes",
})

_NUMERIC_PASSTHROUGH_FIELDS = frozenset({
    "built_up_area_sqft", "chargeable_area_sqft", "car_parking_count",
    "power_load_kw", "cabin_count", "workstation_count",
    "conference_room_count", "meeting_room_count", "washroom_count", "manager_cabin_count",
    "telephone_booth_count", "ladies_washroom_count", "gents_washroom_count",
    "bathroom_count", "parking_count", "token_amount", "deposit_amount",
    "deposit_months", "cam_amount", "lock_in_period_months",
    "notice_period_months", "area_min_sqft", "area_max_sqft",
    "budget_min", "budget_max", "budget_per_sqft_max", "car_parking_min",
    "min_power_load_kw", "original_bhk", "current_bhk", "floor_min",
    "floor_max", "floor_count_max", "balcony_area_sqft", "terrace_area_sqft",
    "covered_terrace_area_sqft", "sellable_area_sqft",
    "computed_total_asking_price", "super_built_up_area_sqft", "saleable_area_sqft",
    "floor_plate_sqft",
    "frontage_ft", "otla_area_sqft", "entrance_count", "automatic_shutter_count",
    "room_count", "suite_count", "banquet_hall_count", "restaurant_count",
    "director_cabin_count", "manager_cabin_count", "cubicle_count", "conference_room_capacity",
    "meeting_room_capacity", "training_room_capacity", "cafeteria_seat_count",
    "inspection_notice_minutes",
    "min_cabin_count", "min_workstation_count", "floor_min", "floor_max",
})

_INTEGER_PASSTHROUGH_FIELDS = frozenset({
    "car_parking_count", "cabin_count", "workstation_count",
    "conference_room_count", "meeting_room_count", "washroom_count", "manager_cabin_count",
    "bathroom_count", "parking_count", "deposit_months",
    "lock_in_period_months", "notice_period_months", "car_parking_min",
    "floor_min", "floor_max",
    "floor_count", "entrance_count", "automatic_shutter_count", "room_count",
    "suite_count", "banquet_hall_count", "restaurant_count", "director_cabin_count",
    "cubicle_count", "conference_room_capacity", "meeting_room_capacity",
    "training_room_capacity", "cafeteria_seat_count", "inspection_notice_minutes",
    "min_cabin_count", "min_workstation_count", "telephone_booth_count",
    "ladies_washroom_count", "gents_washroom_count", "floor_min", "floor_max",
})


def _extract_json_object(raw: str | None) -> object | None:
    """Robustly extract a JSON object/array from LLM output.

    Many providers occasionally:
    - add a sentence of prose before/after the JSON ("Here is the JSON:")
    - wrap in ```json fences and forget a closing fence
    - JSON is the last `{}` block in the response

    Strategy:
    1. Direct ``json.loads`` on the trimmed response.
    2. Find the first balanced ``{...}`` or ``[...]`` substring (string-aware
       so embedded braces in strings do not throw off depth tracking) and try
       ``json.loads`` on each one until success.

    Returns the parsed Python value, or ``None`` if nothing usable is found.
    """
    if not raw:
        return None
    s = raw.strip()

    # Strip a single ``` / ```json fence pair if present at the start.
    if s.startswith("```"):
        rest = s.split("\n", 1)[-1] if "\n" in s else s[3:]
        # Drop trailing ``` boundary if present, otherwise keep everything.
        if rest.rstrip().endswith("```"):
            rest = rest.rstrip()[:-3]
        s = rest.strip()

    if not s:
        return None

    try:
        return json.loads(s)
    except json.JSONDecodeError:
        pass

    for opener, closer in (('{', '}'), ('[', ']')):
        idx = s.find(opener)
        while idx != -1:
            depth = 0
            in_str = False
            esc = False
            end = -1
            for i in range(idx, len(s)):
                c = s[i]
                if esc:
                    esc = False
                    continue
                if in_str:
                    if c == '\\':
                        esc = True
                    elif c == '"':
                        in_str = False
                    continue
                if c == '"':
                    in_str = True
                    continue
                if c == opener:
                    depth += 1
                elif c == closer:
                    depth -= 1
                    if depth == 0:
                        end = i
                        break
            if end != -1:
                try:
                    return json.loads(s[idx:end + 1])
                except json.JSONDecodeError:
                    pass
            idx = s.find(opener, idx + 1)
    return None


def _normalize_configuration_type(value, bhk=None) -> str | None:
    """Return the canonical display/storage label for a unit configuration."""
    text = str(value).strip() if value is not None else ""
    fallback = _coerce_float(bhk)
    if not text and fallback is None:
        return None
    if re.fullmatch(r"\d+(?:\.\d+)?", text):
        number = _coerce_float(text)
        if number == 0.5:
            return "1 RK"
        return f"{number:g} BHK" if number is not None else None
    match = re.fullmatch(r"(\d+(?:\.\d+)?)\s*(BHK|RK)", text, re.IGNORECASE)
    if match:
        number = _coerce_float(match.group(1))
        kind = match.group(2).upper()
        if number == 0.5 and kind == "BHK":
            return "1 RK"
        return f"{number:g} {kind}" if number is not None else None
    if text:
        return text
    if fallback == 0.5:
        return "1 RK"
    return f"{fallback:g} BHK" if fallback is not None else None


def _segment_document(raw_text: str, ctx: dict | None = None) -> dict:
    """Return model-selected source blocks without deterministic parsing."""
    from extraction import preview_source_boundaries

    _pattern, chunks = preview_source_boundaries(raw_text, (ctx or {}).get("tenant_id"))
    blocks = []
    for index, chunk in enumerate(chunks):
        text = str(chunk.get("normalized_message") or "").strip()
        if text:
            blocks.append({
                "index": index,
                "start_line": None,
                "line_count": len(text.splitlines()) or 1,
                "text": text,
                "lines": text.splitlines() or [text],
            })
    return {
        "document_type": "Multi Listing" if len(blocks) >= 2 else "Single Listing",
        "header": None,
        "block_count": len(blocks),
        "blocks": blocks,
        "raw_text": raw_text,
    }


def _building_alias_context(raw_text: str, ctx: dict | None, storage=None) -> list[dict]:
    """Return a small tenant-scoped alias shortlist for the model.

    This is context retrieval, not resolution: the model still decides whether
    a name refers to one of these buildings.  The shortlist prevents thousands
    of aliases from being sent on every request.
    """
    if storage is None:
        return []
    tenant_id = (ctx or {}).get("tenant_id") or getattr(storage, "_tenant_id", None)
    try:
        cache_key = str(tenant_id or "__shared__")
        now = time.monotonic()
        with _REFERENCE_CACHE_LOCK:
            cached = _ALIAS_ROWS_CACHE.get(cache_key)
        if cached and now - cached[0] < _REFERENCE_CACHE_TTL_SECONDS:
            rows = cached[1]
        else:
            query = storage.client.table("building_name_aliases").select(
                "building_id,alias,canonical_name"
            )
            if tenant_id:
                query = query.or_(f"tenant_id.eq.{tenant_id},tenant_id.is.null")
            rows = query.limit(2500).execute().data or []
            # Canonical buildings are part of the enrichment registry even
            # when no broker alias has been created yet.  They must be
            # available before extraction so a name such as "Sethia Sea View"
            # is resolved as a building instead of being left for the model to
            # guess from an isolated one-line slice.
            building_query = storage.client.table("buildings").select(
                "id,canonical_name"
            )
            if tenant_id:
                building_query = building_query.or_(f"tenant_id.eq.{tenant_id},tenant_id.is.null")
            canonical_rows = building_query.limit(2500).execute().data or []
            rows = list(rows) + [
                {
                    "building_id": row.get("id"),
                    "alias": row.get("canonical_name"),
                    "canonical_name": row.get("canonical_name"),
                }
                for row in canonical_rows
                if row.get("id") and row.get("canonical_name")
            ]
            with _REFERENCE_CACHE_LOCK:
                if len(_ALIAS_ROWS_CACHE) >= _REFERENCE_CACHE_MAX_TENANTS and cache_key not in _ALIAS_ROWS_CACHE:
                    oldest = min(_ALIAS_ROWS_CACHE, key=lambda key: _ALIAS_ROWS_CACHE[key][0])
                    _ALIAS_ROWS_CACHE.pop(oldest, None)
                _ALIAS_ROWS_CACHE[cache_key] = (now, rows)
        scored = []
        for row in rows:
            alias = str(row.get("alias") or "").strip()
            if not alias or not row.get("building_id"):
                continue
            score = fuzzy_score(raw_text, alias)
            # Token containment is a useful retrieval signal for long WhatsApp
            # messages where whole-document similarity is naturally low.
            text_tokens = set(re.findall(r"[a-z0-9]+", raw_text.casefold()))
            alias_tokens = set(re.findall(r"[a-z0-9]+", alias.casefold()))
            overlap = len(text_tokens & alias_tokens) / max(len(alias_tokens), 1)
            scored.append((max(score, overlap), row))
        scored.sort(key=lambda item: item[0], reverse=True)
        result = []
        seen = set()
        for score, row in scored:
            key = row.get("building_id")
            if key in seen:
                continue
            seen.add(key)
            result.append({
                "building_id": key,
                "alias": row.get("alias"),
                "canonical_name": row.get("canonical_name"),
            })
            if len(result) >= 20:
                break
        return result
    except Exception as exc:
        _logger.debug("building alias context unavailable: %s", exc)
        return []


_LOCALITY_CONTEXT_CACHE: tuple[float, list[dict]] = (0.0, [])


def _locality_reference_context(storage=None) -> list[dict]:
    """Return a small cached locality gazetteer for extraction grounding."""
    global _LOCALITY_CONTEXT_CACHE
    if storage is None:
        return []
    cached_at, cached = _LOCALITY_CONTEXT_CACHE
    if cached and time.time() - cached_at < 3600:
        return cached
    try:
        rows = storage.client.table("locality_reference").select(
            "sub_locality,parent_locality,alternate_names"
        ).limit(300).execute().data or []
        context = [
            {
                "locality": row.get("sub_locality"),
                "parent": row.get("parent_locality"),
                "aliases": row.get("alternate_names") or [],
            }
            for row in rows
            if row.get("sub_locality")
        ]
        _LOCALITY_CONTEXT_CACHE = (time.time(), context)
        return context
    except Exception as exc:
        _logger.debug("locality reference context unavailable: %s", exc)
        return []


_UNIFIED_SCHEMA_FIELD_CONTRACT = ", ".join(sorted({
    field.strip()
    for fields in _FOCUSED_FIELDS.values()
    for field in fields.split(",")
    if field.strip()
}))
_UNIFIED_SCHEMA_FIELD_CONTRACT = f"{_UNIFIED_SCHEMA_FIELD_CONTRACT}, property_intelligence"


_UNIFIED_EXTRACTION_PROMPT = """You extract structured real-estate opportunities from one raw WhatsApp message.
The message below is authoritative evidence. Do not rewrite, split, normalize, or
strip it before interpreting it. Return JSON only with this shape:
{
  "message_class": "listing" | "requirement" | "market_chatter" | "irrelevant" | "mixed",
  "listing_count": number,
  "items": [
    {
      "listing_type": "sale" | "rent" | "lease" | "pg" | "joint_venture" | "requirement",
      "property_category": "residential" | "commercial",
      "building_name": string | null,
      "building_id": number | null,
      "building_resolution_confidence": number,
      "locality": {"raw_mention": string | null, "resolved_locality": string | null, "confidence": number},
      "bhk": number | null,
      "original_bhk": number | null,
      "current_bhk": number | null,
      "configuration_type": string | null,
      "configuration_details": string | null,
      "is_combination_unit": boolean | null,
      "carpet_area_sqft": number | null,
      "built_up_area_sqft": number | null,
      "super_built_up_area_sqft": number | null,
      "area_raw_text": string | null,
      "price": {"amount": number | null, "amount_max": number | null, "unit": "total" | "per_sqft", "period": "one_time" | "per_month" | null, "raw_price_text": string | null},
      "evidence_tiers": {"field_name": "explicit" | "inferred" | "unknown"},
      "inference_notes": {"field_name": "brief explanation for an inferred value"},
      "transaction_type": "sale" | "rent" | "lease" | "pg" | "joint_venture" | null,
      "possession_status": "ready_to_move" | "under_construction" | "ready_possession" | "oc_received" | "preleased" | "not_specified",
      "furnishing_status": "fully_furnished" | "semi_furnished" | "unfurnished" | "bare_shell" | "builder_finish" | "not_specified",
      "availability_status": "available" | "sold" | "let_out" | "withdrawn" | "closed" | "not_specified",
      "price_basis": "carpet" | "built_up" | "super_built_up" | "saleable" | "not_specified",
      "car_parking_count": number | null,
      "parking_type": string | null,
      "parking_details": {"source_text": "exact source wording", "parking_type": "covered|open|stilt|garage|unknown", "count": number | null},
      "floor_range": string | null,
      "floor_min": number | null,
      "floor_max": number | null,
      "floor_label": string | null,
      "wing": string | null,
      "building_amenities": ["explicit source-grounded amenity"],
      "unit_amenities": ["explicit source-grounded amenity"],
      "property_view": string | null,
      "view_description": string | null,
      "broker_company": string | null,
      "contacts": [{"name": "source-grounded name", "phone": "source-grounded phone"}],
      "source_notes": string | null,
      "extraction_confidence_score": number,
      "field_confidence": {"field_name": number},
      "provenance": {"field_name": "exact quote from the raw message"},
      "source_slice": "the exact contiguous raw-message block belonging only to this item",
      "landmark_options": ["source-grounded nearby landmark or landmark alternative"],
      "public_seo_title": "source-grounded title for www.propai.live, or null",
      "public_seo_description": "source-grounded description of at most 250 words, or null",
      "broker_notes": [
        {"category": "negotiation|legal|charges|access|media|utility|tenant_rule|building|unit|brokerage|other", "text": "faithful note", "source_text": "exact source wording"}
      ],
      "unstructured_facts": {"fact_name": "explicit source-grounded value"},
      "property_intelligence": {
        "unit_features": [{"label": "balcony|view|layout|condition|amenity", "value": "explicit fact", "source_text": "exact source wording"}],
        "building_features": [{"label": "lift|power_backup|amenity|facility", "value": "explicit fact", "source_text": "exact source wording"}],
        "pricing_terms": [{"label": "negotiability|maintenance|tax|deposit|payment_plan", "value": "explicit fact", "source_text": "exact source wording"}],
        "access_and_rules": [{"label": "tenant_rule|visit|notice|possession|restriction", "value": "explicit fact", "source_text": "exact source wording"}],
        "location_context": [{"label": "landmark|road|station|neighbourhood", "value": "explicit fact", "source_text": "exact source wording"}],
        "relationships": [{"type": "shared_building|alternative_unit|jodi|same_project|option", "target": "explicit relationship target", "source_text": "exact source wording"}],
        "unresolved_mentions": [{"text": "explicit source wording", "reason": "why it is not safely normalized"}]
      }
    }
  ]
}
The context includes a document-level preflight structural classification. Use
it only as a hint for how the complete message may be organized, not as facts
about every item. Re-evaluate signals inside each item's own source block:
sale, rent, furnishing, commercial use, area, parking, floor, and configuration
cues from sibling blocks must never be copied into this item. If the document
contains multiple entries, first identify each independent source block and
then extract that block's complete schema fields. If the preflight conflicts
with the raw message, follow the raw message and preserve the correct source
boundaries.
The eight typed destination tables are the extraction contract. Return every
field applicable to the item's own route, including null for fields absent from
that source block. Do not produce a small summary. Treat preflight signals as a
checklist: built_up_area_cue means inspect BU/BUA/build-up wording;
parking_cue means inspect car parks and parking details; floor_cue means keep
qualitative floor wording; and combination_unit_cue means preserve the JODI
expression and relationship.
`parking_details` must contain only source-grounded keys such as `source_text`,
`parking_type`, and `count`; never copy a schema placeholder or emit a key named
`key` with text such as "explicit source-grounded value".
The complete field contract is the union of the eight typed destinations:
__UNIFIED_SCHEMA_FIELD_CONTRACT__
Return the fields applicable to each item, including null when a field is absent.
For each item, preserve exact source wording in provenance and copy the complete,
contiguous source block into source_slice. source_slice must be copied verbatim,
including the item's heading and fields, but must not include the next item,
shared footer, broker signature, or unrelated header. A requirement is demand,
not inventory. Never invent a building_id: use only the supplied alias context, and
return null when no context entry is an actual match. Confidence values are 0.0-1.0.

Semantic ownership is yours, not the preflight or pattern detector's. Bold text,
numbered lines, inline headers, and pattern_id are advisory formatting signals
only. Decide from meaning whether a phrase is a named building/project or a
generic descriptor. "Flat sharing", "flat sheering", "sharing flat", and
"shared flat" describe an arrangement and are never building names.
Use evidence_tiers: explicit means stated, inferred means clear context, and
unknown means genuinely ambiguous. In a rental/lease/PG item, an unqualified
"50k" normally means recurring monthly rent; mark the period inferred when
monthly is not written. Use one_time only for clear deposit/token/advance/
one-time/lump-sum wording.

`listing_count` means the number of independent extracted items only. It never
means the BHK number, floor number, parking count, or external item index. An
item count may be non-null only when that source block explicitly says multiple
units/flats/apartments are available. `5 BHK` is one five-bedroom item, never
`5 x 5 BHK`.

For requirements, `building_name` is optional and is usually null. Preserve
nearby landmarks, roads, stations, and alternative reference points in
`landmark_options`; do not promote a landmark into a building identity. A
requirement with a grounded locality and budget is valid without a building.

Generate the public SEO fields only from this item's source slice and verified
fields. Never include phone numbers, WhatsApp/group names, broker contact
details, private instructions, or facts from another item. These fields are for
www.propai.live only; the authenticated app should show structured facts and
source evidence instead. Return null when a safe public description is not
supported by the source.

The user context may include approved_correction_examples. Treat these as
tenant-scoped guidance for similar wording only. They are not authoritative
facts and must never override an explicit quote in the current raw message.

Location separation is strict: a locality/area/neighborhood such as Bandra West,
Andheri East, Powai, or Khar West belongs in locality.raw_mention and locality.resolved_locality,
not building_name. building_name is only the specific named society, tower, project,
or building (for example Lodha Belmondo or Rustomjee Seasons). If a message says
"3 BHK in Bandra West" with no named society, building_name must be null and the
locality must be Bandra West. Use the supplied locality_reference context to
distinguish locality names from building names; do not promote a locality into a
building merely because it appears in a heading.

Field ownership is strict inside every listing block. Never put a price or price
header (for example "3 lacs", "₹8 lakh", "3cr"), furnishing line ("Fully
Furnished"), floor line, parking line, configuration line, broker footer, or
generic ad phrase into building_name. Those belong in their dedicated fields or
unstructured_facts. If the block has no specifically named building, return
building_name=null. Never borrow a building name, price, or locality from the
previous or next block. Preserve the full source slice in source_slice so an
uncertain item can be reviewed rather than guessed.

Broker shorthand must be expanded only when the source supports it: BU/BUA
means built-up area, CA means carpet area, SBA means super built-up area, and
"2 car parks" means car_parking_count=2. "Higher floor" is a valid qualitative
floor_label and must not be discarded merely because no numeric floor exists.
For "1+1 BHK Jodi", preserve the exact configuration_details and set
is_combination_unit=true; the aggregate bhk may be 2, but the title and
provenance must retain "1+1 BHK Jodi".

This is extraction, not a location-answering task. Do not add facts from memory,
Google, portals, maps, or general knowledge. If the source says "Lower Parel West",
return that source locality; do not add wards, stations, coordinates, descriptions,
or rent opinions. A known building may be resolved only when it appears in the
supplied known_buildings context or in the current source block. If the source says
"Rent: 300/- Rs p.sf", preserve it as per_sqft and never convert it into a monthly
total without an explicit total. For requirements, use budget fields only; never
emit asking-price fields.

Broker notes are internal, source-grounded facts that are useful to a broker or
reviewer but do not fit an existing typed field. Capture every such note from
the item's source slice, not merely a summary. This includes negotiability or
final-price wording; all-in/plus-plus and maintenance, CAM, GST, TDS, stamp or
registration charges; clear-title, papers, loan or litigation notes; OC/CC and
RERA status; inspection, notice, key, visit, client-profile and media-available
instructions; utilities and appliances such as pipe gas, white goods, ACs,
wardrobes or kitchen cabinets; tenant/community/pet rules; private lift, ramp,
open/covered parking and unit-structure notes; redevelopment, DA-signed,
conversion-potential, investment-return and mandate notes; and other explicit
operational or deal conditions. Use an existing typed field as well when one
exists, but also preserve the original note in broker_notes when it carries
meaningful wording. Do not invent or infer a note. Never put phone numbers in
public SEO fields. Keep broker_notes concise, deduplicated, and limited to this
item's source slice.

Property intelligence is the lossless-but-structured layer above the typed
schema. Populate it for explicit facts that matter but do not have a dedicated
column yet: balconies, views, layouts, amenities, floor qualifiers, parking
details, maintenance/tax/deposit terms, access instructions, tenant rules,
landmarks, unit alternatives, JODI relationships, project context, and facts
that remain unresolved. Every entry must be traceable to this item's source
slice through source_text. Do not repeat a value already captured cleanly in a
typed field unless the wording carries additional meaning. Never use it for
memory, enrichment, comparable properties, or facts from sibling items.
"""


_UNIFIED_EXTRACTION_PROMPT = _UNIFIED_EXTRACTION_PROMPT.replace(
    "__UNIFIED_SCHEMA_FIELD_CONTRACT__",
    _UNIFIED_SCHEMA_FIELD_CONTRACT,
)


def _normalize_property_intelligence(raw) -> dict:
    """Keep the rich intelligence layer item-local, bounded, and source-linked."""
    if not isinstance(raw, dict):
        return {}
    normalized: dict[str, list[dict]] = {}
    for section in _PROPERTY_INTELLIGENCE_SECTIONS:
        entries = raw.get(section)
        if not isinstance(entries, list):
            continue
        clean: list[dict] = []
        seen: set[tuple[str, str, str]] = set()
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            if section == "relationships":
                kind = str(entry.get("type") or "other").strip().lower()[:80]
                value = str(entry.get("target") or "").strip()
                source = str(entry.get("source_text") or "").strip()
                if not value or not source:
                    continue
                item = {"type": kind, "target": value[:300], "source_text": source[:1000]}
                key = (kind, value.casefold(), source.casefold())
            elif section == "unresolved_mentions":
                value = str(entry.get("text") or "").strip()
                reason = str(entry.get("reason") or "not safely normalized").strip()
                if not value:
                    continue
                item = {"text": value[:1000], "reason": reason[:300]}
                key = ("unresolved", value.casefold(), reason.casefold())
            else:
                label = str(entry.get("label") or "other").strip().lower()[:80]
                value = str(entry.get("value") or "").strip()
                source = str(entry.get("source_text") or "").strip()
                if not value or not source:
                    continue
                item = {"label": label, "value": value[:500], "source_text": source[:1000]}
                key = (label, value.casefold(), source.casefold())
            if key in seen:
                continue
            seen.add(key)
            clean.append(item)
            if len(clean) >= 24:
                break
        if clean:
            normalized[section] = clean
    return normalized


def _normalize_extraction(raw: dict) -> dict:
    """Normalize and validate LLM extraction response."""
    result = {}

    # listing_type — accept enum value directly, then map common LLM variants
    # to the canonical set.  Without this normalization step, providers often
    # emit "for_sale"/"rental"/"wanted" which currently drop the entire
    # candidate as "no valid listings".
    lt_raw = str(raw.get("listing_type", "")).strip().lower()
    lt_raw = lt_raw.replace(" ", "_").replace("-", "_")
    result["listing_type"] = _LISTING_TYPE_ALIASES.get(lt_raw, lt_raw)
    if result["listing_type"] not in _VALID_LISTING_TYPES:
        result["listing_type"] = None
    # Typed routing currently has sale/rent destinations. Preserve the AI's
    # richer transaction_type separately while routing lease/PG/JV to rent.
    if result["listing_type"] in {"lease", "pg", "joint_venture"}:
        result["routing_listing_type"] = "rent"
    transaction_raw = str(raw.get("transaction_type") or "").strip().lower()
    transaction_raw = re.sub(r"[\s-]+", "_", transaction_raw)
    result["transaction_type"] = _TRANSACTION_TYPE_ALIASES.get(
        transaction_raw,
        transaction_raw or result["listing_type"] or None,
    )

    # property_category — same alias pattern
    # The canonical prompt calls this property_category, while some model
    # providers return the equivalent discriminator as asset_type. Accept the
    # explicit AI field alias; never derive it from keywords or prose.
    pc_raw = str(
        raw.get("property_category") or raw.get("asset_type") or ""
    ).strip().lower()
    pc_raw = pc_raw.replace(" ", "_").replace("-", "_")
    result["property_category"] = _CATEGORY_ALIASES.get(pc_raw, pc_raw)
    if result["property_category"] not in _VALID_CATEGORIES:
        result["property_category"] = None

    # bhk
    result["bhk"] = _coerce_float(raw.get("bhk"))
    result["configuration_type"] = _normalize_configuration_type(raw.get("configuration_type"), result["bhk"])

    # carpet_area_sqft
    result["carpet_area_sqft"] = _coerce_float(raw.get("carpet_area_sqft"))

    # price
    price = raw.get("price", {})
    if isinstance(price, dict):
        amount = price.get("amount")
        result["price"] = {
            "amount": _coerce_float(amount),
            "amount_max": _coerce_float(price.get("amount_max")),
            "unit": str(price.get("unit", "")).strip().lower() if price.get("unit") else None,
            "period": str(price.get("period", "")).strip().lower() if price.get("period") else None,
            "raw_price_text": str(price.get("raw_price_text", "")).strip() or None,
        }
        for field, aliases in (("unit", _PRICE_UNIT_ALIASES), ("period", _PRICE_PERIOD_ALIASES)):
            value = result["price"][field]
            normalized_value = re.sub(r"[\s-]+", "_", str(value or ""))
            result["price"][field] = aliases.get(normalized_value, normalized_value or None)
            valid = _VALID_PRICE_UNITS if field == "unit" else _VALID_PRICE_PERIODS
            if result["price"][field] not in valid:
                result["price"][field] = None
        # A PSF quote is a rate, not a monthly total. Providers sometimes
        # copy the rent period onto it; that would make titles display
        # "₹250/month" and can misroute downstream price logic.
        if result["price"]["unit"] == "per_sqft":
            result["price"]["period"] = None
    else:
        result["price"] = {"amount": None, "amount_max": None, "unit": None, "period": None, "raw_price_text": None}

    # locality
    loc = raw.get("locality", {})
    if isinstance(loc, dict):
        raw_conf = loc.get("confidence")
        conf = str(raw_conf).strip().lower()
        rm = loc.get("raw_mention")
        rl = loc.get("resolved_locality")
        result["locality"] = {
            "raw_mention": str(rm).strip() if rm is not None else None,
            "resolved_locality": str(rl).strip() if rl is not None else None,
            "confidence": raw_conf if isinstance(raw_conf, (int, float)) else (conf if conf in _VALID_CONFIDENCE else "low"),
        }
    else:
        result["locality"] = {"raw_mention": None, "resolved_locality": None, "confidence": "low"}

    # building_name — reject garbage patterns that the LLM sometimes extracts
    # as building names (broker names, ad text, property types, deal terms, etc.)
    bn = raw.get("building_name")
    bn_str = str(bn).strip() if bn and str(bn).strip() else None
    if bn_str:
        bn_lower = bn_str.lower()
        _GARBAGE_BUILDING_PATTERNS = (
            # deal terms / specs
            "stamp duty", "furnish", "carpet", "bhk", "sqft", "sq ft",
            "ready to move", "negotiable", "balcony", "sea view",
            "amenities", "parking", "deposit", "possession",
            " available", "available ", "options", "benefit",
            "family", "bachelor", "veg ", " non-veg",
            " near ", "opp ", "opposite", "behind", "floor",
            "brokerage", "car park", "higher flr", "lower flr",
            "1st floor", "2nd floor", "3rd floor", " ground ",
            # ad text
            "pics ", " video ", "photos ", "virtual tour",
            "for more details", "contact", "call ", "whatsapp",
            "limited period", "hurry", "urgent", "exclusive",
            "convenient nearby", "prime location", "strategic location",
            "rental inventory", "inventory", "direct inventor", "outright opportunit",
            "type ", "size ", "configuration",
            # property types (not building names)
            "restaurant", "cafe", "café", "shop ", "retail",
            "office", "showroom", "warehouse", "godown",
            " bungalow", "villa ", "penthouse",
            # broker / firm names
            "realtor", "estate ", "consultant", "properties",
            " realty", "real estate", " deals", "advisors",
            "infra ", "developers", "constructions",
            "from :", "from:",
        )
        if any(pat in bn_lower for pat in _GARBAGE_BUILDING_PATTERNS):
            bn_str = None
        elif len(bn_str) < 3 or len(bn_str) > 80:
            bn_str = None
        # reject if starts with a digit (deal terms like "4.5bhk", "1 Car Park")
        elif bn_str[0].isdigit():
            bn_str = None
    result["building_name"] = bn_str
    if bn_str:
        building_problem = building_name_problem(
            bn_str,
            locality=(result.get("locality") or {}).get("resolved_locality"),
        )
        if building_problem:
            # Preserve the rejected token for the slice-level repair pass;
            # never persist it as the actual building_name.
            result["building_name_raw_candidate"] = bn_str
            result["building_name"] = None
            result["needs_review"] = True
            result["validation_flags"] = [building_problem, "building_name_unresolved"]

    # Some providers call the commercial loft field by its synonym. The
    # typed schema uses mezzanine_area_sqft for both concepts.
    if raw.get("mezzanine_area_sqft") is None and raw.get("loft_area_sqft") is not None:
        result["mezzanine_area_sqft"] = _coerce_float(raw.get("loft_area_sqft"))

    # furnishing_status — enum + aliases (LLM writes "semi-furnished",
    # "fully furnished", "bare" etc.)
    provenance = raw.get("provenance") if isinstance(raw.get("provenance"), dict) else {}
    # Some providers put the source wording under provenance instead of the
    # top-level field. Use it only as a candidate; source grounding still
    # decides whether the candidate is safe to persist.
    furnishing_input = raw.get("furnishing_status") or provenance.get("furnishing_status")
    fs_raw = str(furnishing_input or "").strip().lower()
    fs_raw = fs_raw.replace("/", "_")
    fs_raw = re.sub(r"\s+", "_", fs_raw)
    fs_raw = _FURNISHING_ALIASES.get(fs_raw, {
        "ff": "fully_furnished",
        "sf": "semi_furnished",
        "pf": "semi_furnished",
        "none": "unfurnished",
    }.get(fs_raw, fs_raw))
    result["furnishing_status"] = fs_raw if fs_raw in _VALID_FURNISHING_CANONICAL else None

    # amenities
    amenities = raw.get("amenities", [])
    if isinstance(amenities, list):
        result["amenities"] = [str(a).strip() for a in amenities if a and str(a).strip()]
    else:
        result["amenities"] = []

    # possession_status
    ps = str(raw.get("possession_status") or "").strip().lower()
    ps = re.sub(r"[\s-]+", "_", ps)
    ps = _POSSESSION_ALIASES.get(ps, ps)
    result["possession_status"] = ps if ps in _VALID_POSSESSION else None

    availability = str(raw.get("availability_status") or "").strip().lower()
    availability = re.sub(r"[\s-]+", "_", availability)
    availability = _AVAILABILITY_ALIASES.get(availability, availability)
    result["availability_status"] = availability if availability in _VALID_AVAILABILITY else None

    result["building_id"] = _coerce_int(raw.get("building_id"))
    score = _coerce_float(raw.get("building_resolution_confidence"))
    result["building_resolution_confidence"] = max(0.0, min(1.0, score or 0.0))
    result["field_confidence"] = raw.get("field_confidence") if isinstance(raw.get("field_confidence"), dict) else {}
    result["provenance"] = raw.get("provenance") if isinstance(raw.get("provenance"), dict) else {}
    evidence_tiers = raw.get("evidence_tiers")
    result["evidence_tiers"] = {
        str(key): str(value).strip().lower()
        for key, value in evidence_tiers.items()
        if str(value).strip().lower() in {"explicit", "inferred", "unknown"}
    } if isinstance(evidence_tiers, dict) else {}
    inference_notes = raw.get("inference_notes")
    result["inference_notes"] = {
        str(key): str(value).strip()[:500]
        for key, value in inference_notes.items()
        if value is not None and str(value).strip()
    } if isinstance(inference_notes, dict) else {}
    source_slice = raw.get("source_slice")
    result["source_slice"] = str(source_slice).strip() if source_slice and str(source_slice).strip() else None
    result["message_class"] = raw.get("message_class")
    result["listing_count"] = _coerce_int(raw.get("listing_count"))
    landmarks = raw.get("landmark_options")
    result["landmark_options"] = [str(value).strip() for value in landmarks if str(value).strip()][:12] if isinstance(landmarks, list) else []
    for field in ("public_seo_title", "public_seo_description"):
        value = str(raw.get(field) or "").strip()
        result[field] = value[:4000] if value else None
    score = _coerce_float(raw.get("extraction_confidence_score"))
    if score is None and result["field_confidence"]:
        values = [_coerce_float(value) for value in result["field_confidence"].values()]
        values = [value for value in values if value is not None]
        score = sum(values) / len(values) if values else 0.0
    result["extraction_confidence_score"] = max(0.0, min(1.0, score or 0.0))
    result["confidence"] = result["extraction_confidence_score"]

    # title. Providers sometimes append a JSON/null sentinel to an otherwise
    # useful title (for example ``... — None``). Keep the source-grounded
    # title, but never expose that sentinel as user-facing listing text.
    title = raw.get("title")
    title_text = str(title).strip() if title and str(title).strip() else ""
    title_text = re.sub(r"\s*(?:—|–|-|:)\s*(?:none|null|undefined|n/?a)\s*$", "", title_text, flags=re.IGNORECASE).strip()
    result["title"] = title_text or None

    # extraction_confidence
    ec = str(raw.get("extraction_confidence", "")).strip().lower()
    result["extraction_confidence"] = ec if ec in _VALID_CONFIDENCE else "medium"
    result = canonicalize_extraction_confidence(
        result, force_review=bool(result.get("needs_review"))
    )

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

    # broker_notes is the intentional lossless-ish catch-all for explicit
    # broker facts that do not yet justify a new typed column. Keep it bounded,
    # item-local, and source-grounded so it cannot become an arbitrary model
    # scratchpad or leak unrelated footer content into a listing.
    notes = raw.get("broker_notes", [])
    normalized_notes: list[dict] = []
    seen_notes: set[tuple[str, str, str]] = set()
    if isinstance(notes, list):
        for note in notes:
            if not isinstance(note, dict):
                continue
            category = str(note.get("category") or "other").strip().lower()
            if category not in _VALID_BROKER_NOTE_CATEGORIES:
                category = "other"
            text = str(note.get("text") or "").strip()
            source_text = str(note.get("source_text") or text).strip()
            if not text or not source_text:
                continue
            key = (category, text.casefold(), source_text.casefold())
            if key in seen_notes:
                continue
            seen_notes.add(key)
            normalized_notes.append({
                "category": category,
                "text": text[:1000],
                "source_text": source_text[:1000],
            })
            if len(normalized_notes) >= 32:
                break
    result["broker_notes"] = normalized_notes
    property_intelligence = _normalize_property_intelligence(raw.get("property_intelligence"))
    if property_intelligence:
        result["property_intelligence"] = property_intelligence

    # Preserve valid route-specific schema fields that are not represented by
    # the small common normalisation block above. Previously these fields were
    # silently discarded, which made messages such as "Area 2000 Carpet /
    # Condition Bareshell / Car Park 2" appear empty in the admin UI.
    for field in _PASSTHROUGH_FIELDS:
        if field in result or field not in raw:
            continue
        value = raw.get(field)
        if value is not None and value != "":
            if field in _INTEGER_PASSTHROUGH_FIELDS:
                value = _coerce_int(value)
            elif field in _NUMERIC_PASSTHROUGH_FIELDS:
                value = _coerce_float(value)
            if value is not None and value != "":
                result[field] = value

    return result


def _apply_source_dialect_disambiguation(extraction: dict, source_text: str) -> dict:
    """Resolve the Mumbai ``S/F @ amount`` shorthand before persistence.

    S/F is semi-furnished, not sale. In this exact quote form it is a rental
    convention; keeping the correction here makes the route and the typed
    destination agree before a title or table row is generated.
    """
    corrected = dict(extraction or {})
    source = str(source_text or "")
    sf_rent_quote = bool(re.search(
        r"\b(?:s\s*/\s*f|sf)\b\s*@\s*₹?\s*\d",
        source,
        re.IGNORECASE,
    ))
    explicit_sale = bool(re.search(
        r"\b(?:sale|sell|purchase|outright|outrate|for\s+sale)\b",
        source,
        re.IGNORECASE,
    ))
    if sf_rent_quote and not explicit_sale:
        corrected["listing_type"] = "rent"
        corrected["routing_listing_type"] = "rent"
        corrected["transaction_type"] = "rent"
        corrected["furnishing_status"] = "semi_furnished"
        corrected["validation_flags"] = list(dict.fromkeys(
            list(corrected.get("validation_flags") or [])
            + ["sf_shorthand_source_correction"]
        ))
    return corrected


# These are post-model guardrails, not extraction rules. The model still
# decides what the phrase means; this catches a known unsafe identity that
# must never become a public building record.
_GENERIC_ARRANGEMENT_BUILDING_RE = re.compile(
    r"\b(?:flat|apartment|room)\s+(?:sheer(?:ing)?|shar(?:e|ing))\b|"
    r"\b(?:sharing|shared)\s+(?:flat|apartment|room)\b|"
    r"\b(?:girls?|boys?)\s+(?:accommodation|flat|room)\b",
    re.IGNORECASE,
)
_EXPLICIT_ONE_TIME_PRICE_RE = re.compile(
    r"\b(?:deposit|token|advance|one[- ]?time|lump\s*sum|refundable)\b",
    re.IGNORECASE,
)
_EXPLICIT_MONTHLY_PRICE_RE = re.compile(
    r"(?:/|per\s*)month|monthly|month\s*rent|\bpm\b",
    re.IGNORECASE,
)


def _reconcile_model_semantics(extraction: dict, source_text: str) -> dict:
    """Apply narrow safety reconciliation after the model has interpreted text."""
    corrected = dict(extraction or {})
    source = str(source_text or "")
    flags = list(corrected.get("validation_flags") or [])
    tiers = dict(corrected.get("evidence_tiers") or {})
    notes = dict(corrected.get("inference_notes") or {})

    building = str(corrected.get("building_name") or "").strip()
    if building and _GENERIC_ARRANGEMENT_BUILDING_RE.search(building):
        corrected["building_name_raw_candidate"] = building
        corrected["building_name"] = None
        corrected["building_id"] = None
        corrected["building_resolution_confidence"] = 0.0
        corrected["arrangement"] = "flat_sharing"
        facts = dict(corrected.get("unstructured_facts") or {})
        facts.setdefault("arrangement", "flat sharing")
        corrected["unstructured_facts"] = facts
        intelligence = dict(corrected.get("property_intelligence") or {})
        features = list(intelligence.get("unit_features") or [])
        if not any(isinstance(item, dict) and item.get("label") == "arrangement" for item in features):
            features.append({"label": "arrangement", "value": "flat sharing", "source_text": building})
        intelligence["unit_features"] = features[:24]
        corrected["property_intelligence"] = intelligence
        corrected["needs_review"] = True
        flags.extend(["generic_descriptor_not_building", "building_name_unresolved"])
        field_confidence = dict(corrected.get("field_confidence") or {})
        field_confidence["building_name"] = 0.0
        corrected["field_confidence"] = field_confidence
        tiers["building_name"] = "unknown"
        notes["building_name"] = "Generic sharing descriptor; no named building was stated."

    price = corrected.get("price") if isinstance(corrected.get("price"), dict) else {}
    is_rental = corrected.get("listing_type") in {"rent", "lease", "pg"} or corrected.get("transaction_type") in {"rent", "lease", "pg"}
    if is_rental and price.get("amount") is not None and price.get("unit") != "per_sqft":
        explicit_monthly = bool(_EXPLICIT_MONTHLY_PRICE_RE.search(source))
        explicit_one_time = bool(_EXPLICIT_ONE_TIME_PRICE_RE.search(source))
        if explicit_monthly:
            price["period"] = "per_month"
            tiers["price.period"] = "explicit"
        elif not explicit_one_time and price.get("period") in {None, "one_time"}:
            price["period"] = "per_month"
            tiers["price.period"] = "inferred"
            notes["price.period"] = "Unqualified amount interpreted as recurring rent from rental context."
            flags.append("price_period_inferred_from_rent_context")
        elif explicit_one_time:
            tiers["price.period"] = "explicit"
        corrected["price"] = price

    corrected["evidence_tiers"] = {
        str(key): str(value) for key, value in tiers.items()
        if str(value) in {"explicit", "inferred", "unknown"}
    }
    corrected["inference_notes"] = {str(key): str(value)[:500] for key, value in notes.items() if value}
    corrected["validation_flags"] = list(dict.fromkeys(flags))
    return corrected


def _single_property_document(text: str) -> bool:
    """Identify a long brochure describing one property, not a broadcast."""
    value = str(text or "")
    if not value.strip():
        return False
    repeated_property_headers = len(re.findall(
        r"(?im)^\s*(?:[*_]?\s*)?(?:property overview|asking price|plot area|building carpet area)\b",
        value,
    ))
    explicit_items = len(re.findall(r"(?im)^\s*\d+[.)]\s+\S+", value))
    return repeated_property_headers >= 2 and explicit_items < 2


def _source_ground_asset_category(item: dict, source_text: str) -> dict:
    """Do not turn an unsupported bare plot/land mention into commercial."""
    corrected = dict(item or {})
    if corrected.get("property_category") != "commercial":
        return corrected
    if not re.search(r"\b(?:plot|land)\b", source_text or "", re.I):
        return corrected
    if re.search(
        r"\b(?:office|shop|showroom|warehouse|industrial|commercial|hotel|hospitality|restaurant|banquet|lodging|factory|godown)\b",
        source_text or "",
        re.I,
    ):
        return corrected
    corrected["property_category"] = "residential"
    corrected["needs_review"] = True
    corrected["validation_flags"] = list(dict.fromkeys(
        list(corrected.get("validation_flags") or []) + ["asset_type_unresolved_for_plot"]
    ))
    return corrected


def _source_grounded_furnishing(extraction: dict, raw_text: str) -> dict:
    """Never persist a furnishing state that the WhatsApp source does not say.

    Providers frequently fill enum fields with a plausible default (most
    commonly ``unfurnished``). That is still fabricated inventory data when
    the message contains no furnishing statement, so the safe value is null
    plus a review flag.
    """
    corrected = dict(extraction or {})
    furnishing = str(corrected.get("furnishing_status") or "").strip().lower()
    furnishing = furnishing.replace("/", "_")
    furnishing = re.sub(r"\s+", "_", furnishing)
    furnishing = _FURNISHING_ALIASES.get(furnishing, {
        "ff": "fully_furnished",
        "sf": "semi_furnished",
        "pf": "semi_furnished",
        "none": "unfurnished",
    }.get(furnishing, furnishing))
    if furnishing:
        corrected["furnishing_status"] = furnishing
    if not furnishing:
        return corrected

    evidence_patterns = {
        "fully_furnished": r"\b(?:fully[-_\s]+furnished|furnished|fully[-_\s]+loaded)\b",
        "semi_furnished": r"\bsemi[-_\s]+(?:furnished|finished)\b",
        "unfurnished": r"\bunfurnished\b",
        "bare_shell": r"\bbare[-\s]?shell\b",
        "builder_finish": r"\bbuilder[-\s]?finish(?:ed)?\b",
    }
    if furnishing == "semi_furnished" and re.search(r"\b(?:s\s*/\s*f|sf|semi[-\s]?furnished)\b", str(raw_text or ""), flags=re.IGNORECASE):
        return corrected
    pattern = evidence_patterns.get(furnishing)
    if pattern and re.search(pattern, str(raw_text or ""), flags=re.IGNORECASE):
        return corrected

    corrected["furnishing_status"] = None
    corrected["needs_review"] = True
    corrected["validation_flags"] = list(dict.fromkeys(
        list(corrected.get("validation_flags") or [])
        + ["furnishing_without_source_evidence"]
    ))
    return corrected


def _repair_locality_only_building(extraction: dict, locality_context: list[dict]) -> dict:
    """Move an exact locality misclassified as a building into locality."""
    building = str(extraction.get("building_name") or "").strip()
    if not building or not locality_context:
        return extraction
    key = re.sub(r"[^a-z0-9]+", " ", building.casefold()).strip()
    for item in locality_context:
        candidates = [item.get("locality"), *(item.get("aliases") or [])]
        if any(
            key == re.sub(r"[^a-z0-9]+", " ", str(candidate).casefold()).strip()
            for candidate in candidates
            if candidate
        ):
            locality = extraction.get("locality")
            if not isinstance(locality, dict):
                locality = {"raw_mention": None, "resolved_locality": None, "confidence": "low"}
            locality["raw_mention"] = locality.get("raw_mention") or building
            locality["resolved_locality"] = locality.get("resolved_locality") or item.get("parent")
            locality["confidence"] = locality.get("confidence") or "high"
            extraction["locality"] = locality
            extraction["building_name"] = None
            break
    return extraction


def _source_grounded_price(extraction: dict, raw_text: str) -> dict:
    """Validate provider prices without replacing or deleting their values.

    A provider can return a syntactically valid price even when the broker
    never stated one. The raw WhatsApp message is authoritative, so a price
    is retained only when its quoted number/unit is present in the source.
    """
    return apply_price_plausibility_guard(extraction, raw_text)


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
    bhk_value = _coerce_float(bhk)
    if bhk_value:
        if bhk_value == 0.5:
            pieces.append("1 RK")
        elif bhk_value == int(bhk_value):
            pieces.append(f"{int(bhk_value)} BHK")
        else:
            pieces.append(f"{bhk_value:g} BHK")
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
        price_amount = _coerce_float(price.get("amount"))
        price_raw = price.get("raw_price_text")

    if price_amount is not None and price_amount > 0:
        period = price.get("period") if isinstance(price, dict) else None
        is_per_sqft = isinstance(price, dict) and price.get("unit") == "per_sqft"
        if is_per_sqft:
            price_str = price_raw or f"₹{price_amount:g} PSF"
        else:
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
            if value == int(value):
                formatted_value = str(int(value))
            else:
                # Preserve the source precision needed to distinguish prices
                # such as 8.75 Cr from 8.8 Cr; only remove insignificant zeros.
                formatted_value = f"{value:.2f}".rstrip("0").rstrip(".")
            fmt = f"₹{formatted_value} {label}"
            if is_rent and amount < 10_000_000:
                fmt += "/month"
            return fmt
    fmt = f"₹{int(amount):,}"
    if is_rent and amount < 10_000_000:
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
    timeout: int = _EXTRACTION_PROVIDER_TIMEOUT,
    *,
    source_id: int | None = None,
    tenant_id: str | None = None,
    call_stage: str = "unknown",
    attempt_number: int | None = None,
    retry_reason: str | None = None,
) -> dict | list | None:
    """Call a single LLM provider. Returns a parsed JSON object/array or None.

    Logs every completed API call (success or truncated) to ai_usage_log so
    cost is never silently lost.
    """
    from usage_logger import log_ai_usage

    started = time.monotonic()
    try:
        _wait_for_provider_cooldown(provider["name"])
        client = OpenAI(api_key=provider["api_key"], base_url=provider["base_url"])
        request = dict(
            model=provider["model"],
            messages=messages,
            temperature=0.1,
            max_tokens=int(provider.get("max_tokens") or 4096),
            timeout=timeout,
        )
        # Enable JSON mode for providers that support it (Haiku 4.5, etc.)
        if provider.get("supports_json_mode", True):
            request["response_format"] = {"type": "json_object"}
        # Keep backlog extraction fast and predictable.  Doubleword accepts
        # the OpenAI-compatible reasoning_effort field, not provider-specific
        # `thinking` payloads.
        if provider.get("disable_reasoning"):
            request["reasoning_effort"] = None
        elif provider.get("reasoning_effort"):
            request["reasoning_effort"] = provider["reasoning_effort"]
        resp = client.chat.completions.create(**request)
        rate_headers = _response_headers(resp)
        if rate_headers:
            _logger.info("Provider %s rate-limit headers: %s", provider["name"], rate_headers)
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
                call_stage=call_stage,
                attempt_number=attempt_number,
                retry_reason=retry_reason,
            )
            # A provider-side finish=error is not a transient empty answer.
            # Returning a distinct sentinel prevents the round-robin loop
            # from immediately spending another attempt on the same broken
            # provider for this message.
            return "PROVIDER_FAILED" if finish_reason == "error" else None

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
            call_stage=call_stage,
            attempt_number=attempt_number,
            retry_reason=retry_reason,
        )

        cleaned = raw.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[-1] if "\n" in cleaned else cleaned[3:]
            if cleaned.endswith("```"):
                cleaned = cleaned[:-3].strip()
        parsed = _extract_json_object(cleaned)
        if parsed is None:
            _logger.warning("Provider %s returned unparseable output (%d chars)", provider["name"], len(raw))
            return "MALFORMED"
        # Preserve the structured envelope. `message_class` and `listing_count`
        # are document-level evidence needed by the route-aware second pass
        # and must survive into each normalized item. Legacy array responses
        # remain supported by the caller.
        return parsed
    except json.JSONDecodeError:
        _logger.warning("Provider %s returned malformed JSON", provider["name"])
        return "MALFORMED"
    except Exception as exc:
        status = getattr(exc, "status_code", None) or getattr(exc, "code", None)
        elapsed = time.monotonic() - started
        if status == 429:
            rate_headers = _response_headers(exc)
            cooldown = _retry_after_seconds(rate_headers)
            _cooldown_provider(provider["name"], cooldown)
            _logger.warning(
                "Provider %s rate-limited (429); cooling down %.1fs headers=%s",
                provider["name"], cooldown, rate_headers or "unavailable",
            )
            return "RATE_LIMITED"
        else:
            _logger.warning(
                "Provider %s failed after %.1fs (status=%s, type=%s): %s",
                provider["name"],
                elapsed,
                status or "unknown",
                type(exc).__name__,
                exc,
            )
        return None


def llm_segment_message(raw_text: str, ctx: dict | None = None) -> list[str]:
    """Find independent listing blocks when deterministic boundaries are ambiguous.

    This is deliberately a segmentation-only call. The returned text must be an
    exact contiguous slice of the WhatsApp message; semantic extraction still
    happens in the normal guarded route afterward.
    """
    if not raw_text or len(raw_text) > 30000 or not _PROVIDERS:
        return []
    prompt = """You segment broker WhatsApp inventory into independent actionable blocks.
Return JSON only: {"blocks":[{"source_slice":"exact contiguous source text","kind":"listing|requirement"}]}.
Split every separately priced/property entry, including entries without a BHK.
Exclude shared broker footers, phone/contact instructions, greetings, and separators.
Never rewrite, summarize, merge, or invent text. Each source_slice must be copied
verbatim as one contiguous substring of the source and must contain evidence such
as a price, area, BHK, or explicit property heading. Return [] when this is one
item or segmentation is not certain. Maximum 20 blocks.

SOURCE:
"""
    messages = [
        {"role": "system", "content": prompt},
        {"role": "user", "content": raw_text},
    ]
    for attempt in range(min(2, len(_PROVIDERS))):
        provider = _next_provider(attempt)
        if not provider:
            break
        response = _call_provider(
            provider,
            messages,
            timeout=min(_EXTRACTION_PROVIDER_TIMEOUT, 90),
            source_id=(ctx or {}).get("raw_id"),
            tenant_id=(ctx or {}).get("tenant_id"),
            call_stage="segmentation",
            attempt_number=attempt + 1,
            retry_reason="segmentation_retry" if attempt else None,
        )
        if not isinstance(response, dict) or not isinstance(response.get("blocks"), list):
            continue
        accepted: list[str] = []
        for block in response["blocks"][:20]:
            candidate = block.get("source_slice") if isinstance(block, dict) else None
            if not isinstance(candidate, str):
                continue
            candidate = candidate.strip()
            if not candidate or candidate not in raw_text:
                continue
            # Segmentation is a source-boundary task.  Do not reject a broker
            # block because a regex failed to recognize its vocabulary; the
            # normal AI extraction pass owns semantic interpretation.
            if any(candidate == prior or candidate in prior or prior in candidate for prior in accepted):
                continue
            accepted.append(candidate)
        if len(accepted) >= 2:
            return accepted
    return []


def ai_extract(raw_text: str, ctx: dict | None = None, storage=None) -> dict:
    """Extract one source unit using route-aware AI provider fallbacks.

    Convincing bulk templates are split into child raw messages by the
    orchestrator before this function is called. Ambiguous/mixed prose remains
    supported by the unified first pass here.

    Returns a dict with:
        extraction: dict — first normalized extraction result (compatibility)
        extractions: list[dict] — every normalized opportunity in the message
        extraction_source: "ai" | "ai_unavailable" | "image_unprocessed"
        needs_review: bool
        provider_used: str | None
        provider_model: str | None
        error: str | None
    """
    start = time.time()
    from preflight_classifier import classify_message

    preflight = (ctx or {}).get("preflight")
    if not isinstance(preflight, dict):
        preflight = classify_message(raw_text).as_dict()
    result = {
        "extraction": None,
        "extractions": [],
        "extraction_source": None,
        "needs_review": False,
        "provider_used": None,
        "provider_model": None,
        "error": None,
        "document": None,
        "preflight": preflight,
    }

    # Empty messages with attachment/reply metadata still go through the AI
    # contract; the model may classify them as irrelevant or review-needed.
    if not raw_text and not (ctx or {}).get("attachments") and not (ctx or {}).get("reply_context"):
        result["extraction_source"] = "ai_unavailable"
        result["needs_review"] = True
        result["extraction"] = None
        _logger.info("ai_extract: text too short (%s)", time.time() - start)
        return result

    # Semantic work belongs to the model.  Keep the raw body byte-for-byte in
    # the user message; reply and attachment metadata are separate context.
    alias_context = _building_alias_context(raw_text, ctx, storage=storage)
    locality_context = _locality_reference_context(storage)
    learning_examples = []
    if storage is not None and hasattr(storage, "get_extraction_learning_examples"):
        try:
            learning_examples = storage.get_extraction_learning_examples(
                raw_text,
                tenant_id=(ctx or {}).get("tenant_id"),
                limit=3,
            )
        except Exception:
            _logger.debug("extraction learning examples unavailable", exc_info=True)
    raw_context = {
        "message": raw_text,
        "reply_context": (ctx or {}).get("reply_context") or {},
        "attachments": (ctx or {}).get("attachments") or [],
        "group_name": (ctx or {}).get("group_name") or "",
        "tenant_id": (ctx or {}).get("tenant_id"),
        "known_buildings": alias_context,
        "known_localities": locality_context,
        "preflight": preflight,
        # These are approved, tenant-scoped corrections. They are guidance,
        # never facts: the source message remains authoritative.
        "approved_correction_examples": [
            {
                "source": str(item.get("source_text") or "")[:1600],
                "field": item.get("field_name"),
                "corrected_value": item.get("corrected_value"),
            }
            for item in learning_examples
        ],
    }
    # Keep the structural document view available to callers without
    # changing the raw text sent to the provider. This is metadata only; the
    # source remains untouched and provider extraction remains authoritative.
    result["document"] = _segment_document(raw_text, ctx)
    result["document"]["alias_context_count"] = len(alias_context)
    # Expose the same structural view in the provider context.  The raw
    # message remains the source of truth, while the model gets the document
    # boundaries that callers already receive in the result envelope.
    raw_context["document_type"] = result["document"].get("document_type")
    raw_context["blocks"] = result["document"].get("blocks") or []

    classified_asset, classified_transaction, classified_requirement = _classify_message_flags(raw_text)

    def build_messages(system_prompt: str, message_text: str) -> list[dict]:
        focused_context = dict(raw_context)
        focused_context["message"] = message_text
        return [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": (
                    "Interpret this raw message and return the requested JSON.\n\n"
                    f"{json.dumps(focused_context, ensure_ascii=False)}"
                ),
            },
        ]

    # The first pass must remain route-neutral: a single WhatsApp broadcast
    # can contain residential, commercial, sale, rent, and requirement items.
    messages = build_messages(_UNIFIED_EXTRACTION_PROMPT, raw_text)

    # Try providers in round-robin, up to total provider count attempts
    attempts = 0
    max_attempts = len(_PROVIDERS) * 2  # Allow two full rotations
    last_error = None
    _src_id = ctx.get("raw_id") if ctx else None
    if not isinstance(_src_id, int) and ctx:
        _src_id = ctx.get("message_id")
    if not isinstance(_src_id, int):
        _src_id = None
    _tid = ctx.get("tenant_id") if ctx else None

    def normalize_provider_response(
        raw_response,
        provider_name: str,
        *,
        source_text: str = raw_text,
        fallback_route: tuple[str, str, bool] | None = None,
        message_class_override: str | None = None,
        listing_count_override: int | None = None,
    ) -> tuple[list[dict], str | None]:
        envelope = raw_response if isinstance(raw_response, dict) else {}
        message_class = message_class_override or envelope.get("message_class")
        listing_count = (
            listing_count_override
            if listing_count_override is not None
            else envelope.get("listing_count")
        )
        fallback_asset, fallback_transaction, fallback_requirement = fallback_route or (
            classified_asset, classified_transaction, classified_requirement
        )
        candidates = envelope.get("items") if isinstance(envelope.get("items"), list) else raw_response
        candidates = candidates if isinstance(candidates, list) else [candidates]
        normalized_items: list[dict] = []
        for candidate in candidates:
            if not isinstance(candidate, dict):
                continue
            candidate = dict(candidate)
            if not candidate.get("listing_type"):
                candidate["listing_type"] = "requirement" if fallback_requirement else fallback_transaction
            # Some providers use the equivalent `asset_type` key. Do not
            # overwrite that explicit model decision with the route-neutral
            # fallback before _normalize_extraction can canonicalize it.
            if not candidate.get("property_category") and not candidate.get("asset_type"):
                candidate["property_category"] = fallback_asset
            candidate.update({
                "message_class": message_class,
                "listing_count": listing_count,
            })
            normalized = _normalize_extraction(candidate)
            normalized = _apply_source_dialect_disambiguation(normalized, source_text)
            # The model owns semantic interpretation. This narrow pass only
            # reconciles known unsafe identities and records contextual
            # inference before titles and typed persistence are derived.
            normalized = _reconcile_model_semantics(normalized, source_text)
            # Source-grounding decisions are made once at the shared
            # extraction boundary. These legacy helpers remain available for
            # isolated compatibility tests, but must not mutate provider
            # output before the authority contract sees it.
            normalized["building_context_allowed"] = bool(
                normalized.get("building_id")
                and any(item.get("building_id") == normalized.get("building_id") for item in alias_context)
            )
            if normalized.get("listing_type") is None:
                _logger.warning(
                    "Provider %s: skipped item listing_type=%r transaction_type=%r category=%r keys=%s",
                    provider_name, candidate.get("listing_type"),
                    candidate.get("transaction_type"), candidate.get("property_category"),
                    sorted(candidate.keys()),
                )
                continue
            # These audit fields must describe this item, not the route used
            # for the whole message. Mixed sale/rent and residential/
            # commercial broadcasts otherwise make every row look like the
            # last or fallback route.
            normalized["classified_asset_type"] = normalized.get("property_category") or fallback_asset
            normalized["classified_transaction_type"] = (
                normalized.get("transaction_type")
                or normalized.get("listing_type")
                or fallback_transaction
            )
            normalized["classified_is_requirement"] = normalized.get("listing_type") == "requirement"
            # Titles are presentation data derived from the validated fields;
            # never preserve an LLM-written price or transaction label that
            # disagrees with the normalized extraction.
            normalized["title"] = generate_title(normalized)
            normalized_items.append(normalized)
        return normalized_items, message_class

    failed_providers: set[str] = set()
    while attempts < max_attempts:
        provider = None
        for _ in range(len(_PROVIDERS)):
            candidate = _next_provider(attempts)
            if candidate and candidate["name"] not in failed_providers:
                provider = candidate
                break
        if provider is None:
            last_error = "No providers configured" if not _PROVIDERS else "All providers failed for this message"
            break

        attempts += 1
        raw_extraction = _call_provider(
            provider,
            messages,
            timeout=_EXTRACTION_PROVIDER_TIMEOUT,
            source_id=_src_id,
            tenant_id=_tid,
            call_stage="initial_extraction",
            attempt_number=attempts,
            retry_reason=last_error,
        )

        if raw_extraction == "MALFORMED":
            # Provider returned content but it can't be parsed as JSON.
            # No point sleeping — try the next provider immediately; they
            # produce structurally different outputs so ask Gemini next
            # instead of looping the same lane.
            continue

        if raw_extraction == "RATE_LIMITED":
            last_error = f"Provider {provider['name']} rate limited"
            # The provider-specific cooldown is set from Retry-After above.
            # Keep this worker task from immediately cycling through the same
            # account while another lane is also backing off.
            time.sleep(1.0)
            continue

        if raw_extraction == "PROVIDER_FAILED":
            failed_providers.add(provider["name"])
            last_error = f"Provider {provider['name']} returned finish=error"
            continue

        if raw_extraction is None:
            # Network/429/empty — small backoff suits a few concurrent workers
            # sharing rate-limited headroom without burning the whole timeout.
            import time as _time
            _time.sleep(min(attempts * 1.0, 3))
            continue

        if isinstance(raw_extraction, dict) and isinstance(raw_extraction.get("items"), list) and not raw_extraction["items"]:
            result["extraction_source"] = "ai"
            result["provider_used"] = provider["name"]
            result["provider_model"] = provider.get("model")
            result["message_class"] = raw_extraction.get("message_class")
            return result
        normalized_items, message_class = normalize_provider_response(raw_extraction, provider["name"])

        if not normalized_items:
            _logger.warning("Provider %s: schema validation failed (no valid listings)", provider["name"])
            continue

        if not message_class:
            message_class = "requirement" if classified_requirement else "listing"
            for item in normalized_items:
                item["message_class"] = message_class

        # The unified response is the normal extraction path. Do not routinely
        # call the same provider again for every item: the prompt already
        # requires all listings, route fields, broker notes, and evidence in
        # one response. A single bounded repair is reserved for an exceptional
        # response that explicitly needs review.
        if any(bool(item.get("needs_review")) for item in normalized_items):
            repair_messages = messages + [{
                "role": "user",
                "content": (
                    "Review the extraction below against the raw message. Repair only fields "
                    "that are unsupported, contradictory, or low-confidence. Return the same "
                    "JSON schema, preserving source-grounded values. Candidate:\n"
                    + json.dumps(raw_extraction, ensure_ascii=False, default=str)
                ),
            }]
            repaired_raw = _call_provider(
                provider,
                repair_messages,
                timeout=_EXTRACTION_PROVIDER_TIMEOUT,
                source_id=_src_id,
                tenant_id=_tid,
                call_stage="repair",
                attempt_number=attempts,
                retry_reason="needs_review",
            )
            if isinstance(repaired_raw, (dict, list)):
                repaired_items, repaired_message_class = normalize_provider_response(repaired_raw, provider["name"])
                if repaired_items and sum(bool(item.get("needs_review")) for item in repaired_items) < sum(bool(item.get("needs_review")) for item in normalized_items):
                    normalized_items = repaired_items
                    message_class = repaired_message_class or message_class

        result["extraction"] = normalized_items[0]
        result["extractions"] = normalized_items
        result["extraction_source"] = "ai"
        result["provider_used"] = provider["name"]
        result["provider_model"] = provider.get("model")
        result["message_class"] = message_class
        # A successful provider response is not automatically trustworthy:
        # field-level source guards can quarantine one or more items while the
        # rest of the message remains usable.
        result["needs_review"] = any(
            bool(item.get("needs_review")) for item in normalized_items
        )

        _logger.info(
            "ai_extract: %d item(s) via %s in %.1fs",
            len(normalized_items), provider["name"], time.time() - start,
        )
        return result

    # ── All providers failed — retain raw source for review ───────
    result["extraction_source"] = "ai_unavailable"
    result["needs_review"] = True
    result["error"] = last_error or f"All {len(_PROVIDERS)} providers failed after {attempts} attempts"

    _logger.warning(
        "ai_extract: all providers failed in %.1fs — %s",
        time.time() - start, result["error"],
    )
    return result
