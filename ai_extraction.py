"""Structured extraction pipeline for broker WhatsApp messages.

Provider rotation uses the same deployment-configured chain as chat.

The pipeline does a deterministic document pass first:
1) reconstruct the message into logical listing blocks
2) classify the document
3) pass the reconstructed document to the model for field extraction

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
from typing import Optional

from openai import OpenAI
from llm import get_configured_providers
from deterministic_splitters import split_message_into_chunks
from extraction_models import validate_source_semantics
from price_normalization import source_transaction_type

_logger = logging.getLogger(__name__)

_BULK_INVENTORY_RE = re.compile(
    r"(?i)\b(?:direct\s+inventor(?:y|ies)|signature\s+spaces|property\s+portfolio|"
    r"multiple\s+(?:properties|options)|all\s+properties)\b"
)
_BULK_FOOTER_RE = re.compile(
    r"(?im)^\s*(?:[*_~\W]*)(?:client\s+profile\s+required|"
    r"for\s+more\s+details\s+and\s+inspections|"
    r"gurukirpa\s+realtors|harkirat\s+singh)\b"
)


def _trim_bulk_footer(text: str) -> str:
    """Keep broker signatures/CTA text out of the final listing block.

    The complete WhatsApp message remains in ``raw_text`` evidence. This only
    trims the extraction slice so phrases such as ``client profile required``
    cannot turn an inventory broadcast into a requirement.
    """
    value = (text or "").strip()
    match = _BULK_FOOTER_RE.search(value)
    if match and match.start() > 0:
        return value[:match.start()].rstrip(" \t\n-_*~")
    return value


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
_PROVIDERS: list[dict] = list(get_configured_providers())


def _append_extraction_provider(
    providers: list[dict],
    *,
    env_prefix: str,
    name: str,
    default_base_url: str,
) -> None:
    """Append an extraction-only OpenAI-compatible provider, when configured.

    These credentials are intentionally separate from the chat provider chain:
    a temporary backlog-drain budget must not be consumed by interactive chat.
    """
    api_key = os.getenv(f"{env_prefix}_API_KEY", "").strip()
    model = os.getenv(f"{env_prefix}_MODEL", "").strip()
    base_url = os.getenv(f"{env_prefix}_BASE_URL", default_base_url).strip()
    if api_key and model:
        providers.append({
            "name": name,
            "api_key": api_key,
            "base_url": base_url,
            "model": model,
            "reasoning_effort": "none",
        })
    elif api_key or model:
        _logger.warning(
            "Skipping extraction provider %s: set both %s_API_KEY and %s_MODEL",
            name,
            env_prefix,
            env_prefix,
        )


# Doubleword is the dedicated extraction provider. Merge remains available
# to the separate chat/provider chain and must not consume its extraction key.
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
    if _EXTRACTION_MODEL and _EXTRACTION_MODEL in model:
        return 0
    if any(hint in model for hint in _PREMIUM_MODEL_HINTS):
        return 2
    return 1 if _EXTRACTION_MODEL else 0


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


def _next_provider() -> dict | None:
    global _rr_index
    if not _PROVIDERS:
        return None
    with _rr_lock:
        p = _PROVIDERS[_rr_index]
        _rr_index = (_rr_index + 1) % len(_PROVIDERS)
    return p


# ── Extraction prompt ─────────────────────────────────────────────────

# The old all-property prompt was intentionally removed.  Runtime extraction
# uses `_get_extraction_prompt()` below, selected by the deterministic route.

# ── Schema validation ─────────────────────────────────────────────────

_PRICE_PARSING_INSTRUCTIONS = """PRICE PARSING — CRITICAL:
- Convert explicit units to absolute rupees: 1 Cr = 10000000, 1 Lakh = 100000, and K = 1000.
- “8.5 Cr” means 85000000, never 8.5 or 8500000.
- “2.50 Lakhs” means 250000; “75 K” means 75000.
- “8.5.Cr”, “2:25 Cr”, and “75.Lakh” use punctuation as a separator: parse them as 8.5 Cr, 2.25 Cr, and 75 Lakh.
- Preserve raw_price_text exactly as written in the source.
- “60k” or “95k” means thousand. A small “1.20k”/“3.5k” in a Mumbai residential rental commonly means lakh, but do not silently guess: preserve the raw text and set needs_review=true when context does not make the unit clear.
- For PSF/per-sqft quotes use unit “per_sqft” and keep amount as the per-sqft rate; otherwise use unit “total”.
- Never infer a price from unrelated numbers such as floor, parking, area, or phone numbers."""

# This is a compact, production-facing subset of the Mumbai broker glossary.
# Keep high-confidence dialect rules here; the full research document belongs
# in docs, not in every provider request. Deterministic guards remain the
# authority for values that can be normalized without an LLM.
_MUMBAI_BROKER_GLOSSARY = """MUMBAI BROKER DIALECT — FOLLOW STRICTLY:
- “lease” / “on lease” in a property context means monthly RENT, not a long-term contract.
- “outright” and the broker typo “outrate” mean SALE.
- “preleased” / “pre-rented” is SALE with an existing tenant; any rent stated is current tenant yield, not asking monthly rent.
- “sale & rent” or “sale or lease” can describe both availability modes; preserve both in deal_tags and never silently convert one price into the other.
- “budget”, “urgent requirement”, “required”, “looking for”, or “client needs” indicate a REQUIREMENT; budget is not listing price.
- “nego” means negotiable; “nnego” is not a recognized term. “final” means fixed/non-negotiable.
- “cpt” means carpet area; “bup” means built-up area. In NUMBER @ NUMBER, first is area sqft and second is price only when the line is clearly a property price line.
- “1 RK” is not “1 BHK”. Keep BHK/configuration as text, including 2.5 BHK, converted layouts, and jodi flats.
- “converted” means a changed layout: keep current and original configuration. “jodi” is one combined listing, not two listings; keep the original combination too.
- “+N” directly after a rent amount may be a deposit in lakh rupees only when it is plausible (at most six months of rent). Standalone “+1” / “My +1” means co-brokered.
- “builder finish”, “bare shell”, “warm shell”, and “untouched” are furnishing/fitout facts, not transaction types.
- “brand new building” / “new building” is a property-condition fact. Preserve it as the `brand_new_building` deal tag (and use the appropriate age/fitout field when the route exposes one). Do not treat it as a listing boundary or discard it as boilerplate.
- “AI” after a price means all-inclusive; ignore “AI” inside an amenity or project name.
- “company lease” means company-paid residential tenancy in residential context, and company as tenant in commercial context.
- Extract tenant preferences such as family, bachelors, vegetarian, working, student, company lease, and expat as facts; do not filter or omit them.
- “G+N” is context-dependent: building height or a multi-floor unit. Do not guess.
- Indian floors: ground/GF/G is street level; 1st floor is one level above ground.
- Never fabricate or estimate a price. If a unit is genuinely ambiguous, preserve raw_price_text and set needs_review=true.
- If multiple independent listings remain, return one item per listing; never collapse them into one item."""


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

    commercial = bool(re.search(
        r"\b(?:office|shop|showroom|warehouse|godown|industrial|retail|commercial|bare\s*shell|warm\s*shell|plug[- ]and[- ]play|chargeable\s+area|ceiling\s+height|mezzanine|cabin|workstation|conference\s+room|cam|lease\s+deed|power\s+load|food\s+court|otla)\b",
        value,
    ))
    rent = bool(re.search(
        r"\b(?:rent|rental|lease|monthly|per\s+month|deposit|tenancy|lock[- ]in|notice\s+period|lease\s+out)\b",
        value,
    ))
    sale = bool(re.search(
        r"\b(?:sale|sell|buy|purchase|outright|outrate|asking|quote|sale\s+price|crore|cr)\b",
        value,
    ))
    if is_requirement and rent:
        transaction = "rent"
    elif is_requirement and sale:
        transaction = "sale"
    elif rent and not sale:
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
    ("residential", "rent", False): "bhk, carpet_area_sqft, built_up_area_sqft, price, locality, building_name, furnishing_status, possession_status, possession_date, bathroom_count, car_parking_count, parking_type, floor_range, building_amenities, amenities, amenities_unverified_claim, deposit_amount, deposit_months, deposit_raw_text, pet_policy, tenant_type_preference, sharing_allowed, food_preference, lease_term_type, lock_in_period_months, notice_period_months, brokerage_type, deal_tags, title",
    ("commercial", "sale", False): "commercial_use_type, carpet_area_sqft, built_up_area_sqft, chargeable_area_sqft, price, price_basis, locality, building_name, fitout_status, occupancy_status, ceiling_height, floor_range, car_parking_count, power_load_kw, cabin_count, workstation_count, conference_room_count, meeting_room_count, washroom_count, pantry_type, has_central_ac, has_power_backup, has_lift, building_amenities, brokerage_type, deal_tags, title",
    ("commercial", "rent", False): "commercial_use_type, carpet_area_sqft, built_up_area_sqft, chargeable_area_sqft, price, price_basis, locality, building_name, fitout_status, ceiling_height, floor_range, deposit_amount, deposit_months, deposit_raw_text, cam_amount, cam_applicable, cam_unit, power_load_kw, lease_term_type, lock_in_period_months, notice_period_months, escalation_pct, escalation_frequency, rent_free_period_months, fitout_period_months, lease_deed_type, sub_leasing_allowed, building_amenities, brokerage_type, deal_tags, title",
    ("residential", "sale", True): "bhk_options, budget_min, budget_max, area_min_sqft, area_max_sqft, locality_options, building_preferences, furnishing_preference, possession_preference, car_parking_min, buyer_type, transaction_nature, urgency, is_flexible, deal_tags, title",
    ("residential", "rent", True): "bhk_options, budget_min, budget_max, area_min_sqft, area_max_sqft, locality_options, building_preferences, furnishing_preference, possession_preference, deposit_budget_max, tenant_type, nationality, has_pets, car_parking_needed, sharing_acceptable, food_preference, lease_term_preference, company_lease_criteria, urgency, is_flexible, deal_tags, title",
    ("commercial", "sale", True): "commercial_use_type, area_min_sqft, area_max_sqft, budget_min, budget_max, budget_per_sqft_max, locality_options, fitout_preference, car_parking_min, needs_mezzanine, needs_lift, needs_power_backup, needs_central_ac, min_power_load_kw, buyer_type, urgency, is_flexible, deal_tags, title",
    ("commercial", "rent", True): "commercial_use_type, area_min_sqft, area_max_sqft, budget_min, budget_max, budget_per_sqft_max, locality_options, fitout_preference, car_parking_min, needs_mezzanine, needs_lift, needs_power_backup, needs_central_ac, min_power_load_kw, deposit_budget_max, lease_term_preference, max_lock_in_months, max_notice_period_months, company_type, team_size, urgency, is_flexible, deal_tags, title",
}


_RESIDENTIAL_SALE_EXTRACTION_RULES = """
Residential sale listing rules:
- Bulk broadcasts: emit one item per property row/block. If a heading such as
  "3 BHK FOR SALE" or "ANDHERI WEST" applies to following blocks, carry that
  context into each item that uses it. Do not let one block's facts leak into
  another unrelated block.
- Source evidence: each item should be faithful to its listing slice. Shared
  footer contact/company details may be copied to every item, but broker footer
  text must not become building, locality, price, or requirement data.
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


def _get_extraction_prompt(
    asset_type: str,
    transaction_type: str,
    is_requirement: bool = False,
    mixed_transaction: bool = False,
) -> str:
    """Build a small route-specific prompt instead of sending all 85 fields."""
    fields = _FOCUSED_FIELDS[(asset_type, transaction_type, is_requirement)]
    side = "DEMAND/REQUIREMENT" if is_requirement else "SUPPLY/LISTING"
    route_rules = (
        _RESIDENTIAL_SALE_EXTRACTION_RULES
        if (asset_type, transaction_type, is_requirement) == ("residential", "sale", False)
        else ""
    )
    expected_listing_type = "requirement" if is_requirement else transaction_type
    listing_type_rule = (
        f'- listing_type: exactly "{expected_listing_type}".'
        if not mixed_transaction or is_requirement
        else '- listing_type: exactly "sale" or "rent" based on the individual block; never use the transaction type from another block.'
    )
    return f"""You are a deterministic real-estate parser for Indian WhatsApp broker messages.
You are extracting {side} data for {asset_type} {transaction_type}. Return only valid JSON:
{{"items": [{{...}}]}}. Emit one object per independently actionable property or requirement.
Use only facts explicitly present in the reconstructed document. Never invent, average,
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
{_PRICE_PARSING_INSTRUCTIONS}
{_MUMBAI_BROKER_GLOSSARY}
{route_rules}
For listing price, return price={{amount, unit, period, raw_price_text}}. For a requirement,
return budget_min/budget_max instead of pretending the budget is a listing price.
Return no markdown or explanation."""

_VALID_LISTING_TYPES = frozenset({"sale", "rent", "requirement"})
_VALID_CATEGORIES = frozenset({"residential", "commercial"})
_VALID_FURNISHING = frozenset({"unfurnished", "semi_furnished", "fully_furnished"})
_VALID_CONFIDENCE = frozenset({"high", "medium", "low"})
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
_FURNISHING_ALIASES = {
    "unfurnished": "unfurnished",
    "bare": "unfurnished",
    "semi_furnished": "semi_furnished",
    "semi-furnished": "semi_furnished",
    "semifurnished": "semi_furnished",
    "semi": "semi_furnished",
    "fully_furnished": "fully_furnished",
    "fully-furnished": "fully_furnished",
    "fully_loaded": "fully_furnished",
    "fully-loaded": "fully_furnished",
    "full_furnished": "fully_furnished",
    "furnished": "fully_furnished",
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

# Fields are intentionally copied after the discriminator-specific
# normalisation below.  Keeping this allow-list explicit prevents arbitrary
# provider output from reaching storage while ensuring the eight route schemas
# do not silently lose valid commercial/residential attributes.
_PASSTHROUGH_FIELDS = frozenset({
    "built_up_area_sqft", "chargeable_area_sqft", "area_raw_text",
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
    "showing_instructions", "contact_instructions", "unstructured_facts",
    "possession_date", "oc_status", "brokerage_type", "token_amount",
    "payment_plan", "transaction_nature", "deposit_amount", "deposit_months",
    "deposit_raw_text", "cam_amount", "cam_applicable", "cam_unit",
    "lease_term_type", "lock_in_period_months", "notice_period_months", "occupancy_status",
    "deal_tags", "title",
    # Requirement-only fields. These must survive normalization so the
    # typed requirement tables receive ranges, budgets, and preferences.
    "area_min_sqft", "area_max_sqft", "budget_min", "budget_max",
    "budget_per_sqft_max", "locality_options", "fitout_preference",
    "car_parking_min", "needs_mezzanine", "needs_lift", "needs_power_backup",
    "needs_central_ac", "min_power_load_kw", "buyer_type", "urgency",
    "is_flexible", "transaction_nature", "building_preferences",
    "bhk_options", "furnishing_preference", "tenant_type",
    "sharing_acceptable", "food_preference", "amenity_requirements",
    "company_lease_criteria", "lease_term_preference", "nationality",
})

_NUMERIC_PASSTHROUGH_FIELDS = frozenset({
    "built_up_area_sqft", "chargeable_area_sqft", "car_parking_count",
    "power_load_kw", "cabin_count", "workstation_count",
    "conference_room_count", "meeting_room_count", "washroom_count",
    "bathroom_count", "parking_count", "token_amount", "deposit_amount",
    "deposit_months", "cam_amount", "lock_in_period_months",
    "notice_period_months", "area_min_sqft", "area_max_sqft",
    "budget_min", "budget_max", "budget_per_sqft_max", "car_parking_min",
    "min_power_load_kw", "original_bhk", "current_bhk", "floor_min",
    "floor_max", "balcony_area_sqft", "terrace_area_sqft",
    "covered_terrace_area_sqft", "sellable_area_sqft",
    "computed_total_asking_price",
})

_INTEGER_PASSTHROUGH_FIELDS = frozenset({
    "car_parking_count", "cabin_count", "workstation_count",
    "conference_room_count", "meeting_room_count", "washroom_count",
    "bathroom_count", "parking_count", "deposit_months",
    "lock_in_period_months", "notice_period_months", "car_parking_min",
    "floor_min", "floor_max",
})


_BLOCK_START_KEYWORDS = (
    "available", "requirement", "requirements", "wanted", "looking for",
    "need", "offer", "offering", "for sale", "for rent", "lease",
    "rental", "inventory", "project", "building", "tower", "flat",
    "apartment", "residential", "commercial", "office", "shop", "plot",
    "showroom", "warehouse", "godown", "villa", "bungalow", "duplex",
    "jodi", "pre launch", "prelaunch", "new launch", "market update",
    "update", "broadcast", "group", "broker", "property", "realty",
    "estate", "exclusive", "urgent", "hot", "direct", "with pictures",
)


def _document_lines(raw_text: str) -> list[str]:
    return [line.rstrip() for line in raw_text.splitlines()]


def _is_separator_line(line: str) -> bool:
    stripped = line.strip()
    if not stripped:
        return False
    return bool(re.fullmatch(r"[-=*_•\s]{3,}", stripped))


def _is_numbered_item(line: str) -> bool:
    return bool(re.match(r"^\s*\d{1,3}[\)\.\-:](?!\d)\s*\S+", line))


def _is_explicit_heading(line: str) -> bool:
    stripped = line.strip()
    if not stripped:
        return False
    lowered = stripped.lower()
    if re.fullmatch(r"\d+(?:\.\d+)?\s*(?:bhk|rk)", lowered):
        return False
    if re.fullmatch(r"\d+(?:\.\d+)?\s*(?:carpet|built[- ]?up|super[- ]?built[- ]?up|sq\.?\s*ft\.?|sqft|sq\.?\s*m\.?)", lowered):
        return False
    if re.fullmatch(r"(?:rent|quote|price|deposit)\s*[:\-]?\s*.*", lowered):
        return False
    if re.fullmatch(r"(?:lower|middle|higher)\s+floor", lowered):
        return False
    if re.fullmatch(r"(?:semi|fully)\s*furnished", lowered) or lowered in {"unfurnished", "furnished"}:
        return False
    if lowered.startswith(("available", "requirement", "requirements")):
        return True
    if any(keyword in lowered for keyword in _BLOCK_START_KEYWORDS):
        # Keep the heuristic conservative: short title-like lines only.
        word_count = len(re.findall(r"\b[\w&/-]+\b", stripped))
        if word_count <= 12 and len(stripped) <= 96:
            return True
    if stripped == stripped.upper() and len(stripped) <= 96:
        # Uppercase broker headings and project names.
        alpha_count = sum(1 for ch in stripped if ch.isalpha())
        return alpha_count >= 4
    if len(stripped) <= 64 and stripped[0].isalpha() and stripped[-1] not in ".!?":
        # Title-case / project-name lines like "Bandra Broker Group".
        word_count = len(re.findall(r"\b[\w&/-]+\b", stripped))
        if 1 <= word_count <= 8:
            titleish = stripped == stripped.title() or any(part.isupper() for part in stripped.split())
            if titleish and any(keyword in lowered for keyword in ("bhk", "rent", "sale", "lease", "group", "tower", "project", "building", "flat", "apartment", "estate", "realty", "properties", "available")):
                return True
    return False


def _is_block_start(line: str) -> bool:
    stripped = line.strip()
    if not stripped:
        return False
    return _is_numbered_item(stripped) or _is_explicit_heading(stripped)


def _classify_document(lines: list[str]) -> str:
    """Classify the WhatsApp document before extraction."""
    non_empty = [line.strip() for line in lines if line.strip()]
    if not non_empty:
        return "Unknown"

    starts = [line for line in non_empty if _is_block_start(line)]
    if not starts:
        lowered = " ".join(non_empty).lower()
        if any(word in lowered for word in ("hello", "hi", "thanks", "thank you", "good morning", "good evening", "how are you")):
            return "Discussion"
        if any(word in lowered for word in ("update", "today", "yesterday", "status")):
            return "Update"
        return "Unknown"

    lowered = " ".join(non_empty).lower()
    has_requirement = any(word in lowered for word in ("requirement", "wanted", "looking for", "need "))
    has_listing = any(word in lowered for word in ("available", "for rent", "for sale", "lease", "inventory", "offer"))
    if has_requirement and has_listing:
        return "Mixed Listing + Requirement"
    if has_requirement:
        return "Requirement"
    if len(starts) > 1:
        return "Multi Listing"
    return "Single Listing"


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


def _segment_document(raw_text: str) -> dict:
    """Reconstruct a WhatsApp message into logical blocks."""
    inline_pattern, inline_chunks = split_message_into_chunks(raw_text)
    # Do not discard deterministic boundaries just because they came from a
    # non-inline pattern. Previously dash-separated broadcasts were correctly
    # detected here, then thrown away and sent to the model as one flat blob.
    if inline_pattern and len(inline_chunks) >= 2:
        cleaned_chunks = [_trim_bulk_footer(chunk) for chunk in inline_chunks]
        cleaned_chunks = [chunk for chunk in cleaned_chunks if chunk]
        blocks = [
            {
                "index": index,
                "start_line": None,
                "line_count": len(chunk.splitlines()) or 1,
                "text": chunk.strip(),
                "lines": chunk.splitlines() or [chunk.strip()],
            }
            for index, chunk in enumerate(cleaned_chunks)
        ]
        return {
            "document_type": "Multi Listing",
            "header": None,
            "block_count": len(blocks),
            "blocks": blocks,
            "raw_text": raw_text,
        }

    lines = _document_lines(raw_text)
    header_lines: list[str] = []
    blocks: list[dict] = []
    current: list[str] = []
    current_start_index: int | None = None

    def flush() -> None:
        nonlocal current, current_start_index
        if current:
            blocks.append({
                "index": len(blocks),
                "start_line": current_start_index,
                "line_count": len(current),
                "text": _trim_bulk_footer("\n".join(current)),
                "lines": current[:],
            })
            current = []
            current_start_index = None

    for idx, line in enumerate(lines):
        stripped = line.strip()
        if not stripped:
            if current:
                current.append(line)
            elif header_lines:
                header_lines.append(line)
            continue

        if _is_separator_line(stripped):
            flush()
            continue

        if _is_block_start(stripped):
            flush()
            current = [line]
            current_start_index = idx
            continue

        if current:
            current.append(line)
        else:
            header_lines.append(line)

    flush()

    document_type = _classify_document(lines)
    return {
        "document_type": document_type,
        "header": "\n".join(header_lines).strip() or None,
        "block_count": len(blocks),
        "blocks": blocks,
        "raw_text": raw_text,
    }


def _normalize_extraction(raw: dict) -> dict:
    """Normalize and validate LLM extraction response."""
    result = {}

    # listing_type — accept enum value directly, then map common LLM variants
    # to the canonical set.  Without this normalization step, providers often
    # emit "for_sale"/"rental"/"wanted" which currently drop the entire
    # candidate as "no valid listings".
    lt_raw = str(raw.get("listing_type", "")).strip().lower()
    lt_raw = lt_raw.replace(" ", "_").replace("-", "_")
    result["listing_type"] = _LISTING_TYPE_ALIASES.get(lt_raw)

    # property_category — same alias pattern
    pc_raw = str(raw.get("property_category", "")).strip().lower()
    pc_raw = pc_raw.replace(" ", "_").replace("-", "_")
    result["property_category"] = _CATEGORY_ALIASES.get(pc_raw)

    # bhk
    result["bhk"] = _coerce_float(raw.get("bhk"))

    # carpet_area_sqft
    result["carpet_area_sqft"] = _coerce_float(raw.get("carpet_area_sqft"))

    # price
    price = raw.get("price", {})
    if isinstance(price, dict):
        amount = price.get("amount")
        result["price"] = {
            "amount": _coerce_float(amount),
            "unit": str(price.get("unit", "")).strip().lower() if price.get("unit") else None,
            "period": str(price.get("period", "")).strip().lower() if price.get("period") else None,
            "raw_price_text": str(price.get("raw_price_text", "")).strip() or None,
        }
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
            "rental inventory", "inventory", "direct inventor",
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

    # furnishing_status — enum + aliases (LLM writes "semi-furnished",
    # "fully furnished", "bare" etc.)
    fs_raw = str(raw.get("furnishing_status", "")).strip().lower()
    fs_raw = fs_raw.replace(" ", "_").replace("-", "_")
    if fs_raw in _FURNISHING_ALIASES:
        result["furnishing_status"] = _FURNISHING_ALIASES[fs_raw]
    elif fs_raw and fs_raw != "null":
        result["furnishing_status"] = fs_raw
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


def _source_grounded_price(extraction: dict, raw_text: str) -> dict:
    """Drop provider prices that have no matching money quote in the source.

    A provider can return a syntactically valid price even when the broker
    never stated one. The raw WhatsApp message is authoritative, so a price
    is retained only when its quoted number/unit is present in the source.
    """
    price = extraction.get("price")
    if not isinstance(price, dict) or price.get("amount") is None:
        return extraction
    source = str(raw_text or "")
    source_numbers = {
        value.replace(",", "")
        for value in re.findall(r"\d+(?:[.,]\d+)?", source)
    }
    raw_quote = str(price.get("raw_price_text") or "")
    quote_numbers = {
        value.replace(",", "")
        for value in re.findall(r"\d+(?:[.,]\d+)?", raw_quote)
    }
    quote_units = re.findall(r"\b(?:cr|crore|crores|lac|lakh|lakhs|l|k)\b", raw_quote.lower())
    source_lower = source.lower()
    quote_is_present = bool(quote_numbers) and quote_numbers.issubset(source_numbers)
    units_are_present = all(re.search(rf"\b{re.escape(unit)}\b", source_lower) for unit in quote_units)
    has_explicit_money = bool(re.search(
        r"(?:₹|rs\.?|inr)\s*\d|\d+(?:[.,]\d+)?\s*"
        r"(?:cr|crore|crores|lac|lakh|lakhs|l|k)\b",
        source,
        re.I,
    ))
    if not (has_explicit_money and quote_is_present and units_are_present):
        extraction["price"] = {"amount": None, "unit": None, "period": None, "raw_price_text": None}
        extraction["needs_review"] = True
    return extraction


def _apply_deterministic_field_fallbacks(extraction: dict, raw_text: str) -> dict:
    """Recover unambiguous schema facts when a provider omits them.

    Intent is corrected here when the raw WhatsApp text contains an
    unambiguous transaction marker.  This protects the database from an LLM
    guessing ``rent`` for messages such as ``Available Sale ... Price 1.90
    Cr``.  The correction is deliberately limited to exclusive markers; a
    message advertising both sale and rent still needs item-level parsing.
    """
    text = raw_text or ""
    lowered = text.lower()

    # Mumbai rental broadcasts commonly write a lakh amount after ``Rent``
    # without spelling out the unit (for example ``Rent Rs.1.50 neqt``).
    # Treating the model's absolute-rupee guess as authoritative can turn this
    # into 15 L instead of 1.5 L.  This is limited to an explicit rent marker
    # and a decimal rupee quote, so unrelated numbers are never reinterpreted.
    if extraction.get("listing_type") == "rent":
        rent_shorthand = re.search(
            r"\b(?:rent|monthly\s+rent)\s*[:\-]?\s*(?:₹|rs\.?|inr)\s*"
            r"(\d+(?:\.\d{1,2})?)\b",
            text,
            re.I,
        )
        if rent_shorthand and "." in rent_shorthand.group(1):
            amount_lakh = _coerce_float(rent_shorthand.group(1))
            if amount_lakh is not None and 0 < amount_lakh <= 20:
                raw_quote = rent_shorthand.group(0).strip()
                extraction["price"] = {
                    "amount": amount_lakh * 100_000,
                    "unit": "total",
                    "period": "per_month",
                    "raw_price_text": raw_quote,
                }
                extraction["needs_review"] = False

    # Recover high-signal facts that are often omitted by providers despite
    # being plainly present in the source message.
    if extraction.get("possession_date") is None:
        possession_match = re.search(
            r"\bpossession\s*[:\-]?\s*(\d{1,2})(?:st|nd|rd|th)?\s+"
            r"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|"
            r"jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|"
            r"dec(?:ember)?)\s+(20\d{2})",
            text,
            re.I,
        )
        if possession_match:
            months = {
                "jan": 1, "january": 1, "feb": 2, "february": 2,
                "mar": 3, "march": 3, "apr": 4, "april": 4, "may": 5,
                "jun": 6, "june": 6, "jul": 7, "july": 7, "aug": 8,
                "august": 8, "sep": 9, "september": 9, "oct": 10,
                "october": 10, "nov": 11, "november": 11, "dec": 12,
                "december": 12,
            }
            month = months[possession_match.group(2).lower()]
            extraction["possession_date"] = (
                f"{possession_match.group(3)}-{month:02d}-{int(possession_match.group(1)):02d}"
            )
            extraction["possession_status"] = extraction.get("possession_status") or "available"

    if extraction.get("car_parking_count") is None and re.search(
        r"\bno\s+(?:car\s+)?parking\b", lowered
    ):
        extraction["car_parking_count"] = 0
        extraction["parking_type"] = extraction.get("parking_type") or "none"

    locality = extraction.get("locality")
    if not isinstance(locality, dict):
        locality = {"raw_mention": None, "resolved_locality": None, "confidence": "low"}
        extraction["locality"] = locality
    if not locality.get("raw_mention"):
        # A common compact format is ``Building, Ahimsa marg Khar``. Keep the
        # source wording; locality resolution later can canonicalize it.
        comma_match = re.search(r"(?im)^.*?,\s*([^\n,]+)$", text)
        if comma_match:
            candidate = comma_match.group(1).strip(" *.,")
            if re.search(
                r"\b(?:andheri|bandra|khar|juhu|santacruz|bkc|powai|worli|"
                r"goregaon|malad|thane|mulund|mahim|pali\s+hill|marg|road|"
                r"nagar|station|metro)\b",
                candidate,
                re.I,
            ):
                locality["raw_mention"] = candidate
                locality["confidence"] = "high"

    explicit_sale = re.search(
        r"\b(?:available\s+(?:for\s+)?sale|for\s+sale|sale\s+price|outright|outrate)\b",
        lowered,
    )
    explicit_rent = re.search(
        r"\b(?:available\s+(?:for\s+)?rent|for\s+rent|monthly\s+rent|rent\s*[-:])\b",
        lowered,
    )
    if explicit_sale and not explicit_rent and extraction.get("listing_type") in {"rent", "sale"}:
        extraction["listing_type"] = "sale"
        extraction["needs_review"] = False
    elif explicit_rent and not explicit_sale and extraction.get("listing_type") in {"rent", "sale"}:
        extraction["listing_type"] = "rent"
        extraction["needs_review"] = False
    if extraction.get("listing_type") in {"rent", "sale"}:
        extraction["listing_type"] = source_transaction_type(text, extraction.get("listing_type"))

    # Requirement messages often contain unambiguous ranges/budgets but the
    # provider may omit the route-specific fields. Recover only explicit
    # values; never infer a budget or area from a listing-like phrase.
    if extraction.get("listing_type") == "requirement" or re.search(
        r"\b(?:require|required|requirement|looking\s+for|need|wanted)\b", lowered
    ):
        if extraction.get("bhk") is None and not extraction.get("bhk_options"):
            bhk_match = re.search(r"\b(\d+(?:\.\d+)?)\s*bhk\b", text, re.I)
            if bhk_match:
                extraction["bhk"] = _coerce_float(bhk_match.group(1))

        if extraction.get("area_min_sqft") is None:
            range_match = re.search(
                r"\b([\d,]+)\s*[-–]\s*([\d,]+)\s*(?:sq\.?\s*ft\.?|sqft|sft)\b",
                text, re.I,
            )
            if range_match:
                extraction["area_min_sqft"] = _coerce_float(range_match.group(1))
                extraction["area_max_sqft"] = _coerce_float(range_match.group(2))

        if extraction.get("budget_max") is None:
            budget_match = re.search(
                r"\bbudget\s*[:\-]?\s*(?:up\s+to\s*)?(?:₹|rs\.?\s*)?([\d,.]+)\s*(cr|crore|crores|lac|lakh|lakhs|l|k)?\b",
                text, re.I,
            )
            if budget_match:
                amount = _coerce_float(budget_match.group(1))
                if amount is not None:
                    unit = (budget_match.group(2) or "").lower()
                    multiplier = 1
                    if unit in {"cr", "crore", "crores"}:
                        multiplier = 1_00_00_000
                    elif unit in {"l", "lac", "lakh", "lakhs"}:
                        multiplier = 1_00_000
                    elif unit == "k":
                        multiplier = 1_000
                    extraction["budget_max"] = amount * multiplier

        if not extraction.get("locality_options"):
            locality_match = re.search(
                r"\b(?:anywhere\s+in|location|preferred\s+locations?)\s*[:\-]?\s*([^\n]+)",
                text, re.I,
            )
            if locality_match:
                locality_text = locality_match.group(1).strip(" *")
                parts = re.split(r"\s*(?:,|&|\band\b)\s*", locality_text, flags=re.I)
                if len(parts) == 1 and re.search(r"\b(?:anywhere|preferred|location)\b", locality_match.group(0), re.I):
                    known = re.findall(
                        r"\b(?:Santacruz|Khar|Bandra|Thane(?:\s+West)?|Naupada|Teen\s+Petrol\s+Pump|Panch\s+Pakhadi|Ram\s+Maruti\s+Road)\b",
                        locality_text,
                        re.I,
                    )
                    if known:
                        parts = known
                extraction["locality_options"] = [p.strip() for p in parts if p.strip()]

        # Preserve ordered locality alternatives from compact broker phrasing
        # such as ``Bandra or max Khar``. In this market, bare Bandra and Khar
        # have deterministic west-side defaults.
        if not extraction.get("locality_options"):
            locality_line = next(
                (line for line in text.splitlines() if re.search(r"\b(?:bandra|khar)\b", line, re.I)),
                "",
            )
            locality_names = re.findall(r"\b(?:Bandra\s+(?:East|West)|Khar\s+(?:East|West)|Bandra|Khar)\b", locality_line, re.I)
            locality_options = []
            for name in locality_names:
                key = name.lower()
                canonical = {"bandra": "Bandra West", "khar": "Khar West"}.get(key, name.title())
                if canonical not in locality_options:
                    locality_options.append(canonical)
            if locality_options:
                extraction["locality_options"] = locality_options

        furnishing_preference = str(extraction.get("furnishing_preference") or "").strip().lower().replace(" ", "_").replace("-", "_")
        if furnishing_preference in _FURNISHING_ALIASES:
            extraction["furnishing_preference"] = _FURNISHING_ALIASES[furnishing_preference]
        elif re.search(r"\bfully\s+loaded\b", lowered):
            extraction["furnishing_preference"] = "fully_furnished"

        if extraction.get("tenant_type") is None:
            tenant_match = re.search(r"\btenant\s*[:\-]?\s*([^\n]+)", text, re.I)
            if tenant_match:
                extraction["tenant_type"] = tenant_match.group(1).strip(" *")

        if re.search(r"\bexpat\b", lowered) and not extraction.get("tenant_type"):
            extraction["tenant_type"] = "expat"
        if re.search(r"\bcompany\s+lease\b", lowered):
            extraction["company_lease_criteria"] = True
            extraction["lease_term_preference"] = extraction.get("lease_term_preference") or "company_lease"

        if extraction.get("car_parking_min") is None and re.search(
            r"\b(?:open|covered)?\s*car\s*parking\s+required\b|\bparking\s+required\b",
            lowered,
        ):
            extraction["car_parking_min"] = 1

        amenity_requirements = list(extraction.get("amenity_requirements") or [])
        if re.search(r"\bmodular\s+kitchen|kitchen\s+trolley\b", lowered):
            if "modular_kitchen" not in amenity_requirements:
                amenity_requirements.append("modular_kitchen")
        if re.search(r"\bgas\s+pipeline\b", lowered):
            if "gas_pipeline" not in amenity_requirements:
                amenity_requirements.append("gas_pipeline")
        if amenity_requirements:
            extraction["amenity_requirements"] = amenity_requirements

        if not extraction.get("commercial_use_type"):
            use_match = re.search(r"\bfor\s+a\s+([a-z][a-z ]{2,40}?)\s+(?:on|basis|in)\b", text, re.I)
            if use_match:
                extraction["commercial_use_type"] = use_match.group(1).strip().lower()

    if extraction.get("carpet_area_sqft") is None:
        area_match = re.search(
            r"(?i)\b(?:carpet\s*)?area\s*[:\-]?\s*([\d,]+(?:\.\d+)?)\s*(?:sq\.?\s*ft\.?|sqft|sft|carpet)?",
            text,
        )
        if area_match:
            extraction["carpet_area_sqft"] = _coerce_float(area_match.group(1))
            extraction["area_raw_text"] = area_match.group(0).strip()

    if not extraction.get("fitout_status"):
        if re.search(r"\bbare\s*shell\b|\bbareshell\b", lowered):
            extraction["fitout_status"] = "bare_shell"
        elif re.search(r"\bwarm\s*shell\b", lowered):
            extraction["fitout_status"] = "warm_shell"
        elif re.search(r"\bbuilder(?:'s)?\s*finish\b", lowered):
            extraction["fitout_status"] = "builder_finish"

    if extraction.get("occupancy_status") is None and re.search(
        r"\bpre[-\s]?leased\b|\bpre[-\s]?rented\b", lowered
    ):
        extraction["occupancy_status"] = "pre_leased"

    if extraction.get("car_parking_count") is None:
        parking_match = re.search(
            r"(?i)\b(?:car\s*)?park(?:ing)?\s*[:\-]?\s*(\d+)\b|\b(\d+)\s*car\s*parks?\b",
            text,
        )
        if parking_match:
            extraction["car_parking_count"] = _coerce_int(next(g for g in parking_match.groups() if g))

    tags = list(extraction.get("deal_tags") or [])
    if re.search(r"\b(?:brand\s*new|new)\s+building\b", lowered) and "brand_new_building" not in tags:
        tags.append("brand_new_building")
    extraction["deal_tags"] = tags
    return extraction


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


def _canonical_locality_from_mention(raw_mention: str | None) -> str | None:
    """Resolve embedded locality mentions through the shared Mumbai rules.

    ``locality_reference`` is intentionally conservative and may not contain
    street + locality phrases such as ``Ahimsa Marg Khar``. The deterministic
    location module can still identify the unique locality, then apply the
    existing implied-direction rule (Khar -> Khar West).
    """
    if not raw_mention or not str(raw_mention).strip():
        return None
    try:
        from location import canonical_micro_market_slug, infer_unique_micro_market

        inferred = infer_unique_micro_market(str(raw_mention))
        slug = canonical_micro_market_slug(inferred or str(raw_mention))
        if slug:
            return slug.replace("-", " ").title()
    except Exception:
        _logger.debug("deterministic locality inference failed for %r", raw_mention, exc_info=True)
    return None


def locality_from_building_name(building_name: str | None, storage=None) -> dict:
    """Look up a building's known locality from the buildings table.

    Used as a fallback when the raw message didn't mention a locality but
    the LLM extracted a building name. Returns the building's
    micro_market if found, so the listing gets the correct locality
    instead of inheriting one from the WhatsApp group name.
    """
    if not building_name or not building_name.strip():
        return {"resolved_locality": None, "confidence": "low"}

    if storage is None:
        return {"resolved_locality": None, "confidence": "low"}

    try:
        db = storage.client if hasattr(storage, "client") else None
        if not db:
            return {"resolved_locality": None, "confidence": "low"}

        name = building_name.strip()
        res = db.table("buildings").select("micro_market").eq(
            "canonical_name", name
        ).limit(1).execute()
        if res.data and res.data[0].get("micro_market"):
            return {
                "resolved_locality": res.data[0]["micro_market"],
                "confidence": "high",
                "source": "buildings_table",
            }

        # Case-insensitive fallback
        res = db.table("buildings").select("micro_market").ilike(
            "canonical_name", name
        ).limit(1).execute()
        if res.data and res.data[0].get("micro_market"):
            return {
                "resolved_locality": res.data[0]["micro_market"],
                "confidence": "high",
                "source": "buildings_table",
            }

        # Try building_name_aliases
        res = db.table("building_name_aliases").select("canonical_name").ilike(
            "alias", name
        ).limit(1).execute()
        if res.data:
            canonical = res.data[0].get("canonical_name")
            if canonical:
                res2 = db.table("buildings").select("micro_market").eq(
                    "canonical_name", canonical
                ).limit(1).execute()
                if res2.data and res2.data[0].get("micro_market"):
                    return {
                        "resolved_locality": res2.data[0]["micro_market"],
                        "confidence": "medium",
                        "source": "building_name_aliases",
                    }

    except Exception:
        _logger.warning("building_name locality lookup failed for %r", building_name, exc_info=True)

    return {"resolved_locality": None, "confidence": "low"}


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
_MAX_PLAUSIBLE_MONTHLY_RENT = 15_00_000


def _format_price_amount(amount: float, is_rent: bool = False) -> str:
    if amount <= 0:
        return "Price on request"
    if is_rent and amount > _MAX_PLAUSIBLE_MONTHLY_RENT:
        _logger.warning(
            "Rent price exceeds plausibility ceiling; formatting as non-monthly amount: %s",
            amount,
        )
        is_rent = False
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
    timeout: int = _EXTRACTION_PROVIDER_TIMEOUT,
    *,
    source_id: int | None = None,
    tenant_id: str | None = None,
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
            max_tokens=4096,
            timeout=timeout,
        )
        # Enable JSON mode for providers that support it (Haiku 4.5, etc.)
        request["response_format"] = {"type": "json_object"}
        # Keep backlog extraction fast and predictable.  Doubleword accepts
        # the OpenAI-compatible reasoning_effort field, not provider-specific
        # `thinking` payloads.
        if provider.get("reasoning_effort"):
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
        parsed = _extract_json_object(cleaned)
        if parsed is None:
            _logger.warning("Provider %s returned unparseable output (%d chars)", provider["name"], len(raw))
            return "MALFORMED"
        # The structured-output envelope keeps JSON mode compatible with both
        # single and multi-listing broker posts.  Keep accepting the legacy
        # object/array shape from non-Doubleword providers during rollout.
        if isinstance(parsed, dict) and isinstance(parsed.get("items"), list):
            return parsed["items"]
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


def ai_extract(raw_text: str, ctx: dict | None = None, storage=None) -> dict:
    """Main entry point: try AI providers in rotation, never deterministic parsing.

    Returns a dict with:
        extraction: dict — first normalized extraction result (compatibility)
        extractions: list[dict] — every normalized opportunity in the message
        extraction_source: "ai" | "ai_unavailable" | "image_unprocessed"
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
        "document": None,
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
        result["extraction_source"] = "ai_unavailable"
        result["needs_review"] = True
        result["extraction"] = None
        _logger.info("ai_extract: text too short (%s)", time.time() - start)
        return result

    document = _segment_document(raw_text)
    result["document"] = document

    classified_asset, classified_transaction, classified_requirement = _classify_message_flags(raw_text)
    mixed_transaction = (
        not classified_requirement
        and bool(re.search(r"(?i)\b(?:rent|lease)\b", raw_text))
        and bool(re.search(r"(?i)\b(?:sale|sell|outright|outrate)\b", raw_text))
    )
    focused_prompt = _get_extraction_prompt(
        classified_asset,
        classified_transaction,
        classified_requirement,
        mixed_transaction=mixed_transaction,
    )

    # ── Build messages ────────────────────────────────────────────
    messages = [
        {"role": "system", "content": focused_prompt},
        {
            "role": "user",
            "content": (
                "Extract structured listing data from this reconstructed WhatsApp document.\n"
                "Use the block boundaries and document_type exactly as given.\n\n"
                f"{json.dumps(document, ensure_ascii=False)}"
            ),
        },
    ]

    # Try providers in round-robin, up to total provider count attempts
    attempts = 0
    max_attempts = len(_PROVIDERS) * 2  # Allow two full rotations
    last_error = None
    _src_id = ctx.get("message_id") if ctx else None
    if not isinstance(_src_id, int):
        _src_id = None
    _tid = ctx.get("tenant_id") if ctx else None

    while attempts < max_attempts:
        provider = _next_provider()
        if provider is None:
            last_error = "No providers configured"
            break

        attempts += 1
        raw_extraction = _call_provider(
            provider,
            messages,
            timeout=_EXTRACTION_PROVIDER_TIMEOUT,
            source_id=_src_id,
            tenant_id=_tid,
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

        if raw_extraction is None:
            # Network/429/empty — small backoff suits a few concurrent workers
            # sharing rate-limited headroom without burning the whole timeout.
            import time as _time
            _time.sleep(min(attempts * 1.0, 3))
            continue

        candidates = raw_extraction if isinstance(raw_extraction, list) else [raw_extraction]
        normalized_items: list[dict] = []
        for candidate in candidates:
            if not isinstance(candidate, dict):
                continue
            normalized = _normalize_extraction(candidate)
            normalized = _apply_deterministic_field_fallbacks(normalized, raw_text)
            normalized = validate_source_semantics(normalized, raw_text)
            normalized = _source_grounded_price(normalized, raw_text)
            if normalized.get("listing_type") is None:
                _logger.warning("Provider %s: skipped an item without listing_type", provider["name"])
                continue

            normalized["classified_asset_type"] = classified_asset
            normalized["classified_transaction_type"] = classified_transaction
            normalized["classified_is_requirement"] = classified_requirement

            # Locality resolution against reference table
            loc = normalized.get("locality", {})
            if isinstance(loc, dict) and loc.get("raw_mention") and not loc.get("resolved_locality"):
                resolved = resolve_locality(loc["raw_mention"], storage=storage)
                if resolved["resolved_locality"]:
                    loc["resolved_locality"] = resolved["resolved_locality"]
                    loc["confidence"] = resolved["confidence"]
                else:
                    canonical = _canonical_locality_from_mention(loc["raw_mention"])
                    if canonical:
                        loc["resolved_locality"] = canonical
                        loc["confidence"] = "high"

            # ── Link-only / ultra-short message guard ────────────────
            # When the source message is just a URL or under 30 chars,
            # the LLM cannot have extracted any real property data.
            # Null the locality and furnishing to prevent hallucinated
            # values from leaking through. Keep building_name — the
            # building-name cross-reference fallback below needs it to
            # resolve the correct locality from the buildings table.
            _msg_lower = raw_text.strip().lower()
            _is_link_only = bool(re.match(r"^https?://\S+$", _msg_lower))
            _is_ultra_short = len(raw_text.strip()) < 30
            if _is_link_only or _is_ultra_short:
                if isinstance(loc, dict):
                    loc["raw_mention"] = None
                    loc["resolved_locality"] = None
                    loc["confidence"] = "low"
                normalized["furnishing_status"] = None

            # ── Building-name locality fallback ──────────────────────
            # When the message didn't mention a locality but the LLM
            # extracted a building name, look up the building in our
            # database to get the correct locality. This prevents
            # link-only messages (e.g. YouTube links to Kalpataru
            # Vivante) from inheriting a wrong locality from the
            # extraction hallucination.
            if (
                isinstance(loc, dict)
                and not loc.get("resolved_locality")
                and normalized.get("building_name")
                and storage is not None
            ):
                bld_result = locality_from_building_name(
                    normalized["building_name"], storage=storage
                )
                if bld_result.get("resolved_locality"):
                    loc["resolved_locality"] = bld_result["resolved_locality"]
                    loc["confidence"] = bld_result["confidence"]

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
        result["needs_review"] = False

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


def ai_extract_sync(raw_text: str, ctx: dict | None = None, storage=None) -> dict:
    """Synchronous wrapper for ai_extract (calls the async-compatible sync code directly)."""
    return ai_extract(raw_text, ctx, storage)
