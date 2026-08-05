"""Async extraction pipeline — Layer 2-5 processing.

This module contains the shared extraction logic used by both:
  - The webhook background thread (runs per-message when webhook fires)
  - The extraction worker (poll-based, picks up unprocessed messages)

Extraction contract:
  1. Send the untouched source message to ai_extraction.ai_extract() once.
  2. Persist each AI-returned opportunity with the full source as evidence.

There is intentionally no deterministic classification, splitting, or parsing
path in this module.

Import pattern:
  from extraction import process_raw_message
"""

import json
import logging
import os
import hashlib
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

_logger = logging.getLogger(__name__)

PROJECT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_DIR))

from lab.storage.base import RawMessage, ParsedObservation, ResolverDecision, dict_to_dataclass
from storage import SupabaseStorage
from lab.embedding import create_engine, observation_text, pack_embedding
from lab.events import get_bus
from agents.building_alias_engine import fuzzy_score, normalize_building_name
from deterministic_splitters import parse_message as parse_template_message
from ai_extraction import _classify_message_flags


def get_storage():
    url = os.getenv("SUPABASE_URL", "")
    key = os.getenv("SUPABASE_SERVICE_KEY", "")
    if not url or not key:
        raise RuntimeError("Supabase is required. Set SUPABASE_URL and SUPABASE_SERVICE_KEY.")
    return SupabaseStorage(url, key)


_EMOJI_ICON_RE = re.compile(
    "["
    "\U0001F1E0-\U0001F1FF"
    "\U0001F300-\U0001F5FF"
    "\U0001F600-\U0001F64F"
    "\U0001F680-\U0001F6FF"
    "\U0001F900-\U0001F9FF"
    "\U0001FA00-\U0001FAFF"
    "\u200d"
    "\u20e3"
    "\u231a-\u23ff"
    "\u25a0-\u25ff"
    "\u2600-\u27bf"
    "\u2934-\u2935"
    "\u2b05-\u2b55"
    "\u3030"
    "\u303d"
    "\u3297"
    "\u3299"
    "\ufe00-\ufe0f"
    "]+",
    flags=re.UNICODE,
)


_EXPLICIT_REQUIREMENT_HEADING_RE = re.compile(
    r"^\s*[\W_]*(?:(?:very|urgent|immediate)\s+)*"
    r"(?:(?:buyer|tenant|client)\s+)?"
    # Keep generic "looking for"/"seeking" out of this source guard: brokers
    # commonly use them as marketing hooks ("Looking for the perfect office?").
    # The extraction prompt handles those cues semantically; this guard is for
    # unambiguous request headings only.
    r"(?:requirements?|required|require|wanted|want|"
    r"need(?:s|ed)?|"
    r"any\s+(?:(?:one|1)\s+)?(?:\S+\s+){0,6}(?:available|has|have)\b|"
    r"koi\s+.*\b(?:hai|chahiye|milega|mil\s+sakta)\b|"
    r"(?:chahiye|chaahiye|dhoondh|dhundh|dhoondh\s+rahe)\b)",
    re.IGNORECASE,
)

_EXPLICIT_RENT_LISTING_RE = re.compile(
    r"\b(?:available|for\s+rent|on\s+rent|rent\s*[:\-])\b",
    re.IGNORECASE,
)


def _has_explicit_requirement_heading(text: str) -> bool:
    """Recognize a requirement heading without treating listing copy as one."""
    for line in (text or "").splitlines():
        if _EXPLICIT_REQUIREMENT_HEADING_RE.search(line):
            return True
    return False


def _has_explicit_rent_listing_language(text: str) -> bool:
    """Detect broker listing language that must not become a BUY demand."""
    value = text or ""
    return bool(
        _EXPLICIT_RENT_LISTING_RE.search(value)
        and re.search(r"\b\d+(?:\.\d+)?\s*(?:bhk|rk|bedroom)s?\b", value, re.IGNORECASE)
    )


def _apply_listing_transaction_guard(ai_items: list[dict], full_text: str, slices: list[str]) -> list[dict]:
    """Prefer explicit rent listing evidence over an ambiguous AI label.

    Messages such as ``Available 2 BHK For Rent`` are inventory posts.  The
    AI occasionally labels them as ``requirement`` because of words like
    ``available`` or ``rent``.  A real requirement has an explicit heading;
    absent that heading, source-local listing language is authoritative.
    """
    corrected: list[dict] = []
    for index, item in enumerate(ai_items):
        source = slices[index] if index < len(slices) else full_text
        has_requirement_heading = _has_explicit_requirement_heading(source) or (
            len(ai_items) == 1 and _has_explicit_requirement_heading(full_text)
        )
        if (
            not has_requirement_heading
            and _has_explicit_rent_listing_language(source)
            and item.get("listing_type") in {"requirement", "sale"}
        ):
            item = {**item, "listing_type": "rent"}
        corrected.append(item)
    return corrected


def _apply_requirement_source_guard(ai_items: list[dict], full_text: str, slices: list[str]) -> list[dict]:
    """Correct an LLM listing label when the source explicitly heads a demand.

    A broker can write "VERY URGENT REQUIREMENT" and then mention the asset
    they want to buy. The word "sale" inside that description must not turn
    the buyer demand into inventory. Mixed documents remain item-scoped: only
    an item whose source slice has a requirement heading is corrected, while a
    single-item document may use the full source heading.
    """
    full_requirement = _has_explicit_requirement_heading(full_text)
    corrected: list[dict] = []
    for index, item in enumerate(ai_items):
        source = slices[index] if index < len(slices) else full_text
        is_requirement = _has_explicit_requirement_heading(source) or (
            len(ai_items) == 1 and full_requirement
        )
        if is_requirement and item.get("listing_type") != "requirement":
            item = {**item, "listing_type": "requirement"}
        corrected.append(item)
    return corrected


def _strip_icons(text):
    if text is None:
        return None
    cleaned = _EMOJI_ICON_RE.sub("", str(text))
    cleaned = re.sub(r"[ \t]+", " ", cleaned)
    cleaned = re.sub(r" *\n *", "\n", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def _sanitize_parsed_value(value):
    if isinstance(value, str):
        return _strip_icons(value)
    if isinstance(value, list):
        return [_sanitize_parsed_value(item) for item in value]
    if isinstance(value, dict):
        return {key: _sanitize_parsed_value(item) for key, item in value.items()}
    return value


# ── Building name normalization against known buildings ────────────
# The LLM often extracts ad text, locality names, or broker phrases as
# building_name.  We fuzzy-match against the canonical building names
# and aliases already in the DB to normalize to the correct name.

_BUILDING_DICT: dict | None = None  # {normalized_name: canonical_name}


def _load_building_dict() -> dict:
    """Load buildings + aliases into a fuzzy-matchable dict.

    Returns {normalized_name: canonical_name} for all known buildings
    and their aliases.  Cached for the lifetime of the worker.
    """
    global _BUILDING_DICT
    if _BUILDING_DICT is not None:
        return _BUILDING_DICT

    try:
        url = os.getenv("SUPABASE_URL", "")
        key = os.getenv("SUPABASE_SERVICE_KEY", "")
        if not url or not key:
            _BUILDING_DICT = {}
            return _BUILDING_DICT

        # Use PropAI's REST client.  The worker image intentionally does not
        # depend on supabase-py, and a top-level ``supabase`` import can also
        # resolve to an unrelated namespace in slim deployments.
        client = SupabaseStorage(url, key).client

        # Load canonical names
        resp = client.table("buildings").select("canonical_name").execute()
        rows = resp.data or []

        # Load aliases
        alias_resp = client.table("building_name_aliases").select("alias,canonical_name").execute()
        alias_rows = alias_resp.data or []

        d: dict[str, str] = {}
        for r in rows:
            cn = (r.get("canonical_name") or "").strip()
            if len(cn) >= 3:
                d[normalize_building_name(cn)] = cn
        for r in alias_rows:
            alias = (r.get("alias") or "").strip()
            cn = (r.get("canonical_name") or "").strip()
            if len(alias) >= 3 and len(cn) >= 3:
                d[normalize_building_name(alias)] = cn

        _BUILDING_DICT = d
        _logger.info("Loaded %d normalized building name entries", len(d))
    except Exception as exc:
        _logger.warning("Failed to load building dict: %s", exc)
        _BUILDING_DICT = {}

    return _BUILDING_DICT


def _normalize_building_to_canonical(name: str) -> str | None:
    """Match an extracted building name against known buildings.

    Returns the canonical name if a close match is found (>=0.80 score),
    or the original name unchanged if no match — never silently drops it.
    """
    if not name or len(name.strip()) < 3:
        return name

    bdict = _load_building_dict()
    if not bdict:
        return name

    norm = normalize_building_name(name)

    # 1. Exact match after normalization
    if norm in bdict:
        return bdict[norm]

    # 2. Fuzzy match against all known names
    best_canonical = None
    best_score = 0.0
    for norm_cn, canonical in bdict.items():
        score = fuzzy_score(name, canonical)
        if score > best_score:
            best_score = score
            best_canonical = canonical

    if best_score >= 0.80 and best_canonical:
        _logger.debug(
            "Building name normalized: %r -> %r (score %.2f)",
            name, best_canonical, best_score,
        )
        return best_canonical

    # 3. No good match — return original unchanged
    return name


def _message_hash(text: str) -> str:
    return hashlib.md5((text or "").encode("utf-8")).hexdigest()


def _sender_template_key(sender_phone: str = "", sender_jid: str = "") -> str:
    phone = re.sub(r"\D+", "", sender_phone or "")
    if phone:
        if len(phone) >= 12 and phone.startswith("91"):
            phone = phone[-10:]
        if len(phone) >= 10:
            return f"phone:{phone[-10:]}"
    jid = (sender_jid or "").strip()
    if jid:
        return f"jid:{jid}"
    return ""


def _clone_parsed_rows(storage, source_raw_id: int, target_raw_id: int) -> tuple[list[int], list[int], list[int]]:
    """Copy typed extraction rows for a duplicate raw message."""
    try:
        rows = storage._fetch_typed_rows(
            raw_message_id=source_raw_id, requirements=None, limit_per_table=1000
        )
    except Exception:
        return [], [], []
    if not rows:
        return [], [], []

    parsed_ids: list[int] = []
    listing_ids: list[int] = []
    requirement_ids: list[int] = []
    for row in rows:
        payload = dict(row)
        table_name = payload.pop("_typed_table", "")
        if not table_name:
            continue
        payload.pop("id", None)
        payload.pop("created_at", None)
        payload.pop("updated_at", None)
        payload["raw_message_id"] = target_raw_id
        source_fp = hashlib.sha256(
            f"typed-observation:{target_raw_id}:{payload.get('listing_index') or 0}".encode()
        ).hexdigest()[:32]
        payload["source_fingerprint"] = source_fp
        try:
            new_id = storage.save_typed_listing(
                table_name, payload, _already_filtered=True, _source_id=target_raw_id
            )
            if new_id:
                parsed_ids.append(new_id)
                if table_name.endswith("_requirements"):
                    requirement_ids.append(new_id)
                else:
                    listing_ids.append(new_id)
        except Exception as exc:
            print(f"  [extract] duplicate typed extraction clone error for {target_raw_id}: {exc}", flush=True)
    return parsed_ids, listing_ids, requirement_ids


def _run_template_splitter(
    storage,
    msg_text: str,
    *,
    tenant_id: str | None,
    sender_phone: str = "",
    sender_jid: str = "",
) -> tuple[str | None, list[dict]]:
    """Try the per-sender cached splitter first, then the full pattern set."""
    sender_key = _sender_template_key(sender_phone, sender_jid)
    cache_row = None
    if sender_key:
        try:
            cache_row = storage.get_sender_splitter_cache(sender_key, tenant_id=tenant_id)
        except Exception:
            cache_row = None

    # Fast path: cached pattern, revalidated only every 50th hit.
    if cache_row and cache_row.get("pattern_id"):
        try:
            message_count = int(cache_row.get("message_count") or 0)
        except (TypeError, ValueError):
            message_count = 0
        should_revalidate = (message_count + 1) % 50 == 0
        if not should_revalidate:
            selected_pattern, parsed = parse_template_message(msg_text, preferred_pattern=str(cache_row.get("pattern_id") or ""))
            if selected_pattern == cache_row.get("pattern_id") and parsed:
                if len(parsed) > 1:
                    try:
                        storage.upsert_sender_splitter_cache(
                            sender_key=sender_key,
                            pattern_id=selected_pattern,
                            tenant_id=tenant_id,
                            sender_phone=sender_phone,
                            sender_jid=sender_jid,
                            message_hash=_message_hash(msg_text),
                            revalidated=True,
                        )
                    except Exception:
                        pass
                return selected_pattern, parsed

    selected_pattern, parsed = parse_template_message(msg_text)
    if selected_pattern and parsed and sender_key:
        try:
            storage.upsert_sender_splitter_cache(
                sender_key=sender_key,
                pattern_id=selected_pattern,
                tenant_id=tenant_id,
                sender_phone=sender_phone,
                sender_jid=sender_jid,
                message_hash=_message_hash(msg_text),
                revalidated=len(parsed) > 1,
            )
        except Exception:
            pass
    return selected_pattern, parsed


def _materialize_split_raw_messages(storage, parent_raw_id: int, ctx: dict, chunks: list[dict]) -> list[int]:
    """Persist deterministic broadcast chunks as child raw evidence rows.

    The parent stays as the immutable WhatsApp event. Children are the units
    sent through extraction, so each parsed item has one raw source slice and
    broker identity never needs to be rediscovered by the LLM.
    """
    if not parent_raw_id or len(chunks) < 2 or ctx.get("parent_message_id"):
        return []
    parent_uid = str(ctx.get("message_uid") or parent_raw_id)
    parent_payload = ctx.get("raw_payload")
    if not isinstance(parent_payload, dict):
        parent_payload = {
            "data": {
                "key": {
                    "id": ctx.get("message_id") or "",
                    "remoteJid": ctx.get("group") or "",
                    "participant": ctx.get("sender_jid") or "",
                },
                "pushName": ctx.get("push_name") or "",
                "sender": {
                    "id": ctx.get("sender_jid") or "",
                    "name": ctx.get("sender_name") or "",
                },
            }
        }
    child_ids: list[int] = []
    for index, parsed in enumerate(chunks, start=1):
        payload = json.loads(json.dumps(parent_payload))
        slice_text = ""
        raw_payload = parsed.get("raw_payload") if isinstance(parsed, dict) else None
        if isinstance(raw_payload, dict):
            slice_text = str(raw_payload.get("full_text") or raw_payload.get("slice_text") or "").strip()
        if not slice_text:
            slice_text = str(parsed.get("normalized_message") or "").strip()
        if not slice_text:
            continue
        payload["split"] = {
            "parent_message_id": parent_raw_id,
            "split_index": index,
            "pattern_id": ctx.get("split_pattern") or "",
            "slice_text": slice_text,
        }
        child_uid = f"{parent_uid}:split:{index}"
        try:
            existing = storage.get_raw_by_uid(child_uid)
            if existing:
                child_ids.append(int(existing.id))
                continue
            child = RawMessage(
                group_name=ctx.get("group_name") or "",
                sender=ctx.get("sender_name") or "",
                sender_jid=ctx.get("sender_jid") or "",
                sender_phone=ctx.get("sender_phone") or "",
                message=slice_text,
                message_type="text",
                attachments="[]",
                reply_context="{}",
                timestamp=ctx.get("timestamp") or "",
                source=ctx.get("source") or "WHATSAPP",
                raw_payload=json.dumps(payload),
                message_uid=child_uid,
                pipeline_version=ctx.get("pipeline_version"),
                synced_at=ctx.get("synced_at"),
                event_id=ctx.get("event_id") or ctx.get("message_id") or "",
                is_group=bool(ctx.get("is_group", not ctx.get("is_dm"))),
                processed=False,
                tenant_id=ctx.get("tenant_id") or None,
                parent_message_id=parent_raw_id,
                split_index=index,
            )
            child_id = storage.save_raw_message(child)
            if child_id:
                child_ids.append(int(child_id))
        except Exception as exc:
            _logger.warning("raw_id=%s split child %s failed: %s", parent_raw_id, index, exc)
    return child_ids


def _sanitize_parsed_listing(parsed: dict) -> dict:
    cleaned = {key: _sanitize_parsed_value(value) for key, value in parsed.items()}

    # Multi-listing parsers historically used ``floor`` or
    # ``floor_description`` while parsed_output stores ``floor_range``. Keep
    # one canonical save key for residential and commercial observations so a
    # reviewed split cannot lose the option that made it a separate card.
    if not cleaned.get("floor_range"):
        cleaned["floor_range"] = (
            cleaned.get("floor_description") or cleaned.get("floor")
        )

    # A project heading is the building identity for Market Inbox purposes.
    # Tower/wing remain evidence metadata; they must never be promoted to a
    # locality or allowed to replace an explicit sibling building.
    if not cleaned.get("building_name") and cleaned.get("project_name"):
        cleaned["building_name"] = cleaned["project_name"]

    # Normalize building_name against known buildings in the DB.
    # The LLM often extracts ad text, locality names, or broker phrases;
    # fuzzy-matching against the 4,000+ canonical names catches most of these.
    if cleaned.get("building_name"):
        cleaned["building_name"] = _normalize_building_to_canonical(cleaned["building_name"])

    payload = cleaned.get("raw_payload")
    if isinstance(payload, dict):
        hierarchy = {
            key: cleaned.get(key)
            for key in ("project_name", "tower_name", "wing_name")
            if cleaned.get(key)
        }
        if hierarchy:
            payload = dict(payload)
            payload.setdefault("hierarchy", {}).update(hierarchy)
            cleaned["raw_payload"] = payload

    return cleaned


# Defence-in-depth validators for AI-only fields (deal_tags, additional_charges).
# ai_extract() already runs _normalize_extraction in ai_extraction.py, but if
# any code path bypasses that (mocked in tests, future schema migration, raw
# LLM output without normalization), the row should still be safe to save.
_VALID_DEAL_TAGS_STORAGE = frozenset({
    "distress_sale", "urgent_sale", "negotiable", "bank_auction",
    "resale", "exclusive_mandate", "price_drop", "brand_new_building",
})
_VALID_CHARGE_TYPES_STORAGE = frozenset({"fixed", "percent_of_price"})


def _safe_deal_tags(raw) -> list[str]:
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    for t in raw:
        if not isinstance(t, str):
            continue
        key = t.strip().lower()
        if key and key in _VALID_DEAL_TAGS_STORAGE:
            out.append(key)
    return out


def _safe_additional_charges(raw) -> list[dict]:
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for c in raw:
        if not isinstance(c, dict):
            continue
        label = c.get("label")
        amount = c.get("amount")
        amount_type = c.get("amount_type")
        if not isinstance(label, str) or not label.strip():
            continue
        if not isinstance(amount_type, str) or amount_type.strip().lower() not in _VALID_CHARGE_TYPES_STORAGE:
            continue
        try:
            amount_f = float(amount)
        except (TypeError, ValueError):
            continue
        if not (amount_f == amount_f):  # NaN check
            continue
        out.append({"label": label.strip(), "amount": amount_f, "amount_type": amount_type.strip().lower()})
    return out


import re as _re

_UNIT_TO_ABS = {
    "cr": 10_000_000, "crore": 10_000_000,
    "lac": 100_000, "lakh": 100_000, "l": 100_000,
    "k": 1_000, "thousand": 1_000,
}

def _parse_raw_price_to_abs(raw_price_text: str) -> float | None:
    """Best-effort parse of raw_price_text into absolute rupees.

    Returns None if the text is unparseable.  Used to cross-check the AI
    extraction amount which sometimes returns 10x/100x the correct value.
    """
    if not raw_price_text:
        return None
    # Brokers commonly write prices as `1.15.Cr`, `75.Lakh`, or
    # `₹2.80 to 3.35 Crore`.  The old expression stopped at the decimal
    # punctuation and therefore could validate the AI value against `1.15`
    # rupees instead of 1.15 crore.
    m = _re.search(
        r'([\d,]+(?:(?:\.\d+)|(?::\d+))?)\s*[.\-/]*\s*'
        r'(cr|crores?|crore|lac?s?|lakhs?|l|k|thousands?|thousand)\b',
        raw_price_text.lower(),
    )
    if not m:
        return None
    try:
        amount = float(m.group(1).replace(",", "").replace(":", "."))
    except ValueError:
        return None
    unit = (m.group(2) or "").rstrip("s")
    multiplier = _UNIT_TO_ABS.get(unit, 1)
    return amount * multiplier


def _parse_raw_price_native(raw_price_text: str) -> tuple[float, str] | None:
    """Return the first explicitly stated broker price in its native unit.

    This is deliberately source-grounded.  The model is asked for absolute
    rupees, but persisted inbox values use native units (Cr/Lac/K).  If the
    source contains an explicit unit, it is safer to use that source value
    than to trust a model conversion which can be off by 10x/1000x.
    """
    if not raw_price_text:
        return None
    m = _re.search(
        r'([\d,]+(?:\.\d+)?)\s*[.:/\-]*\s*'
        r'(cr|crores?|crore|lac?s?|lakhs?|l|k|thousands?|thousand)\b',
        raw_price_text.lower(),
    )
    if not m:
        return None
    try:
        amount = float(m.group(1).replace(",", ""))
    except ValueError:
        return None
    unit = m.group(2).rstrip("s")
    if unit in {"crore", "cr"}:
        return amount, "cr"
    if unit in {"lac", "lakh", "l"}:
        return amount, "lac"
    return amount, "K"


def _price_from_ai_and_raw(price_info: dict) -> tuple[float | None, str | None]:
    """Return an absolute rupee amount, using the source phrase as a guardrail.

    Models occasionally return ``8.5`` for ``8.5 Cr`` or shift a decimal.
    When the source contains an explicit money unit, that literal source value
    wins.  PSF remains a rate and is deliberately not converted here.
    """
    if not isinstance(price_info, dict):
        return None, None
    raw = str(price_info.get("raw_price_text") or "").strip()
    unit = str(price_info.get("unit") or "").strip().lower()
    # A model can mislabel a normal rent quote such as ``₹2.00 Lakhs`` as
    # per-square-foot.  An explicit lakh/crore/thousand quote is authoritative
    # unless the source itself contains a PSF marker.
    has_explicit_native_unit = bool(re.search(
        r"\d+(?:[.,]\d+)?\s*(?:cr|crores?|lac?s?|lakhs?|l|k|thousands?)\b",
        raw.lower(),
    ))
    has_psf_marker = bool(re.search(r"\b(?:psf|per\s+sq\.?\s*ft)\b", raw.lower()))
    if has_psf_marker or (unit in {"per_sqft", "psf"} and not has_explicit_native_unit):
        try:
            return float(price_info.get("amount")), "per_sqft"
        except (TypeError, ValueError):
            return None, "per_sqft"
    source_amount = _parse_raw_price_to_abs(raw)
    if source_amount is not None:
        return source_amount, "abs"
    try:
        return float(price_info.get("amount")), "abs"
    except (TypeError, ValueError):
        return None, None


def _parse_deposit(raw_text: str, monthly_rent: float | None = None) -> dict:
    """Parse the compact deposit conventions used in broker messages."""
    text = str(raw_text or "")
    lower = text.lower()
    if not re.search(r"\bdeposit\b|\d+(?:\.\d+)?\s*[kkl]?(?:\s*[+/&/]\s*\d+)?", lower):
        return {}
    amount = None
    months = None
    needs_review = False
    explicit = re.search(
        r"\bdeposit\b\s*[:\-]?\s*(?:rs\.?|₹)?\s*"
        r"([\d,.]+)(?:\s*(lac|lakh|lacs|k|cr|crore|thousand|months?|mo))?",
        lower,
    )
    if explicit:
        value = float(explicit.group(1).replace(",", ""))
        unit = (explicit.group(2) or "").rstrip("s")
        if unit in {"month", "mo"} or (not unit and value <= 12):
            months = value
        else:
            amount = _price_from_ai_and_raw({
                "amount": value,
                "unit": unit,
                "raw_price_text": f"{value} {unit}".strip(),
            })[0]
    combined = re.search(
        r"([\d,.]+)\s*(lac|lakh|lacs|k|cr|crore|thousand)?\s*[+/&/]\s*"
        r"([\d,.]+)\s*(lac|lakh|lacs|k|cr|crore|thousand|months?|mo)?",
        lower,
    )
    if combined:
        value = float(combined.group(3).replace(",", ""))
        unit = (combined.group(4) or "").rstrip("s")
        if unit in {"month", "mo"} or (not unit and value <= 12):
            months = value
        elif unit or value > 12:
            amount = _price_from_ai_and_raw({
                "amount": value, "unit": unit, "raw_price_text": f"{value} {unit}".strip(),
            })[0]
    range_match = re.search(r"(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*months?", lower)
    if range_match:
        months = (float(range_match.group(1)) + float(range_match.group(2))) / 2
        needs_review = True
    if months is not None and monthly_rent is not None and amount is None:
        amount = monthly_rent * months
    result = {
        "deposit_amount": amount,
        "deposit_months": months,
        "deposit_applicable": True,
        "deposit_raw_text": text.strip(),
    }
    if needs_review:
        result["needs_review"] = True
    return result


def _ai_extraction_to_parsed(ai_extraction: dict, raw_text: str, sender_name: str, push_name: str, slice_text: str | None = None) -> dict:
    """Convert AI extraction schema to the existing parsed dict format.

    This bridges the new AI extraction result to the legacy parsed_observation
    columns so the rest of the pipeline (resolver, listing upsert, etc.)
    remains unchanged. The full AI result is stored separately in the
    `ai_extraction` JSONB column.
    """
    listing_type = ai_extraction.get("listing_type")
    if listing_type == "sale":
        intent = "SELL"
    elif listing_type == "rent":
        intent = "RENT"
    elif listing_type == "requirement":
        intent = "BUY"
    else:
        intent = None

    category = ai_extraction.get("classified_asset_type") or ai_extraction.get("property_category")
    asset_type = category.upper() if category else None
    classified_transaction = ai_extraction.get("classified_transaction_type")
    if classified_transaction not in {"sale", "rent"}:
        classified_transaction = "rent" if re.search(r"\b(?:rent|rental|lease|monthly|deposit)\b", raw_text or "", re.I) else "sale"

    bhk_val = ai_extraction.get("bhk")
    bhk_str = None
    if bhk_val is not None:
        if bhk_val == 0.5:
            bhk_str = "1 RK"
        elif bhk_val == int(bhk_val):
            bhk_str = f"{int(bhk_val)} BHK"
        else:
            bhk_str = f"{bhk_val} BHK"

    price_info = ai_extraction.get("price", {})
    price_unit_price = price_info.get("unit") if isinstance(price_info, dict) else None
    price_period = price_info.get("period") if isinstance(price_info, dict) else None
    price, price_unit = _price_from_ai_and_raw(price_info)
    # Use the source-grounded unit returned above, not the provider's raw unit.
    price_model = "psf" if price_unit == "per_sqft" else None

    locality = ai_extraction.get("locality", {})
    if isinstance(locality, dict):
        rl = locality.get("resolved_locality")
        micro_market = rl if rl and str(rl).strip().lower() != "none" else None
        rm = locality.get("raw_mention")
        location_raw = rm if rm and str(rm).strip().lower() != "none" else None
    else:
        micro_market = None
        location_raw = None

    title = ai_extraction.get("title") or None

    # ── v2 schema fields — physical / deal attributes ──────────────
    bathroom_count = ai_extraction.get("bathroom_count")
    car_parking_count = ai_extraction.get("car_parking_count")
    parking_type = ai_extraction.get("parking_type")
    deposit_amount = ai_extraction.get("deposit_amount")
    oc_status = ai_extraction.get("oc_status")
    interior_value = ai_extraction.get("interior_value")
    ceiling_height = ai_extraction.get("ceiling_height")
    price_basis = ai_extraction.get("price_basis")
    configuration_type = ai_extraction.get("configuration_type")
    lease_term_type = ai_extraction.get("lease_term_type")

    # ── v2 schema — amenities split ────────────────────────────────
    # building_amenities → routed to buildings.amenities via building_amenities key
    building_amenities = ai_extraction.get("building_amenities") or []
    # amenities → unit-specific items
    unit_amenities = ai_extraction.get("amenities") or []
    # vague claims → plain text, never structured
    amenities_unverified_claim = ai_extraction.get("amenities_unverified_claim") or None

    # ── v2 schema — rental / tenancy policy ────────────────────────
    pet_policy = ai_extraction.get("pet_policy") or None
    tenant_type_preference = ai_extraction.get("tenant_type_preference") or None
    sharing_allowed = ai_extraction.get("sharing_allowed") or None
    company_lease_criteria = ai_extraction.get("company_lease_criteria") or None
    # IMPORTANT: tenant_nationality_preference is INTERNAL/BROKER-FACING ONLY.
    # Must NEVER appear in any public-facing API response, search filter,
    # or badge on propai.live / consumer surfaces.
    tenant_nationality_preference = ai_extraction.get("tenant_nationality_preference") or None
    brokerage_type = ai_extraction.get("brokerage_type") or None

    deposit_fields = _parse_deposit(
        str(ai_extraction.get("deposit_raw_text") or raw_text),
        price if listing_type == "rent" and price_unit != "per_sqft" else None,
    )
    if deposit_amount is not None:
        deposit_fields["deposit_amount"] = float(deposit_amount)
        deposit_fields["deposit_applicable"] = True
    if ai_extraction.get("deposit_months") is not None:
        deposit_fields["deposit_months"] = ai_extraction.get("deposit_months")

    return {
        "intent": intent,
        "principal": None,
        "bhk": bhk_str,
        "configuration": None,
        "price": price,
        "price_unit": price_unit,
        "price_model": price_model,
        "price_per_sqft": price if listing_type == "sale" and price_unit == "per_sqft" else None,
        "monthly_rent": price if listing_type == "rent" and price_unit != "per_sqft" else None,
        "total_asking_price": price if listing_type in ("sale",) and price_unit != "per_sqft" else None,
        "area_sqft": ai_extraction.get("carpet_area_sqft"),

        "furnishing": ai_extraction.get("furnishing_status") or None,
        "furnishing_canonical": None,

        "location_raw": location_raw,
        "building_name": ai_extraction.get("building_name") or None,
        "landmark_name": None,
        "street_name": None,
        "area": None,
        "micro_market": micro_market,
        "developer": None,

        "asset_type": asset_type,
        "property_type": None,
        "transaction_type": listing_type if listing_type in ("sale", "rent") else classified_transaction,
        "commercial_use_type": ai_extraction.get("commercial_use_type"),
        "fitout_status": ai_extraction.get("fitout_status"),
        "occupancy_type": ai_extraction.get("occupancy_status") or None,
        "floor_range": None,
        "rent_per_sqft": price if listing_type == "rent" and price_unit == "per_sqft" else None,

        "availability_status": None,
        "possession_status": ai_extraction.get("possession_status") or None,
        "possession_date": ai_extraction.get("possession_date") or None,
        "available_from": None,
        "ready_by": None,
        "construction_stage": None,
        "launch_timeline": None,
        "expected_possession": None,

        "deposit": None,
        "lock_in_period": None,

        "broker_name": None,
        "broker_phone": None,
        "forwarded": 0,
        "confidence": 1.0,
        "raw_payload": {"full_text": raw_text, "slice_text": slice_text or raw_text},
        "normalized_message": _redact_indian_mobiles(slice_text or raw_text),
        "location": None,
        "message_type": listing_type,

        # v2 schema — physical / deal attributes
        "carpet_area_sqft": ai_extraction.get("carpet_area_sqft"),
        "built_up_area_sqft": ai_extraction.get("built_up_area_sqft"),
        "bathroom_count": int(bathroom_count) if bathroom_count is not None else None,
        "car_parking_count": int(car_parking_count) if car_parking_count is not None else None,
        "parking_type": parking_type,
        **deposit_fields,
        "deposit_amount": float(deposit_amount) if deposit_amount is not None else deposit_fields.get("deposit_amount"),
        "deposit_months": ai_extraction.get("deposit_months") or deposit_fields.get("deposit_months"),
        "deposit_raw_text": ai_extraction.get("deposit_raw_text") or deposit_fields.get("deposit_raw_text"),
        "oc_status": oc_status,
        "interior_value": float(interior_value) if interior_value is not None else None,
        "ceiling_height": ceiling_height,
        "price_basis": price_basis,
        "brokerage_type": brokerage_type,
        "configuration_type": configuration_type,
        "lease_term_type": lease_term_type,

        # v2 schema — amenities
        "amenities": unit_amenities if isinstance(unit_amenities, list) else [],
        "amenities_unverified_claim": amenities_unverified_claim,
        "building_amenities": building_amenities if isinstance(building_amenities, list) else [],

        # v2 schema — rental / tenancy policy
        "pet_policy": pet_policy,
        "tenant_type_preference": tenant_type_preference,
        "sharing_allowed": sharing_allowed,
        "company_lease_criteria": company_lease_criteria,
        "tenant_nationality_preference": tenant_nationality_preference,
    }


def _ai_extraction_to_typed(
    ai_extraction: dict,
    raw_text: str,
    sender_name: str = "",
    push_name: str = "",
    slice_text: str | None = None,
    *,
    raw_message_id: int | None = None,
    tenant_id: str | None = None,
    broker_id: int | None = None,
    broker_phone: str | None = None,
    listing_index: int = 0,
) -> tuple[str, dict]:
    """Convert one normalized LLM item into a row for a typed table.

    This is deliberately pure: it does not perform I/O and therefore can be
    tested before a worker is allowed to write to Supabase.  ``save_parsed``
    remains a compatibility wrapper for the existing resolver flow, while new
    callers can use this explicit table/row contract directly.
    """
    ai = dict(ai_extraction or {})
    asset, classified_tx, classified_requirement = _classify_message_flags(raw_text)
    asset = str(ai.get("classified_asset_type") or ai.get("property_category") or asset).lower()
    if asset not in {"residential", "commercial"}:
        asset = "residential"
    tx = str(ai.get("classified_transaction_type") or classified_tx).lower()
    if tx not in {"sale", "rent"}:
        tx = "rent" if re.search(r"\b(?:rent|rental|lease|monthly|deposit)\b", raw_text or "", re.I) else "sale"
    is_requirement = bool(
        ai.get("classified_is_requirement")
        or ai.get("listing_type") == "requirement"
        or classified_requirement
    )
    table_map = {
        ("residential", "sale", False): "residential_sale_listings",
        ("residential", "rent", False): "residential_rent_listings",
        ("commercial", "sale", False): "commercial_sale_listings",
        ("commercial", "rent", False): "commercial_rent_listings",
        ("residential", "sale", True): "residential_sale_requirements",
        ("residential", "rent", True): "residential_rent_requirements",
        ("commercial", "sale", True): "commercial_sale_requirements",
        ("commercial", "rent", True): "commercial_rent_requirements",
    }
    table = table_map[(asset, tx, is_requirement)]
    flat = _ai_extraction_to_parsed(ai, raw_text, sender_name, push_name, slice_text)
    locality = ai.get("locality") if isinstance(ai.get("locality"), dict) else {}
    raw_locality = locality.get("raw_mention") or flat.get("location_raw")
    resolved_locality = locality.get("resolved_locality") or flat.get("micro_market")
    source_text = (slice_text or raw_text or "").strip()
    fingerprint = hashlib.sha256(source_text.lower().encode("utf-8")).hexdigest()
    row = {
        "raw_message_id": raw_message_id,
        "tenant_id": tenant_id,
        "listing_index": listing_index,
        "asset_type": asset,
        "transaction_type": tx,
        "source_fingerprint": fingerprint,
        "building_name": ai.get("building_name"),
        "locality_raw": raw_locality,
        "locality_resolved": resolved_locality,
        "micro_market": resolved_locality,
        "landmark_name": ai.get("landmark_name"),
        "street_name": ai.get("street_name"),
        "broker_id": broker_id,
        "broker_name": ai.get("broker_name") or sender_name or push_name,
        "broker_phone": broker_phone,
        "group_name": ai.get("group_name"),
        "summary_title": ai.get("title"),
        "normalized_message": _redact_indian_mobiles(source_text),
        "raw_payload": {"full_text": raw_text, "slice_text": slice_text or raw_text},
        "ai_extraction": ai,
        "deal_tags": ai.get("deal_tags") or [],
        "additional_charges": ai.get("additional_charges") or [],
        "validation_flags": ai.get("validation_flags") or [],
        "needs_review": bool(ai.get("needs_review")),
        "extraction_confidence": ai.get("extraction_confidence") or "medium",
    }
    price_info = ai.get("price") if isinstance(ai.get("price"), dict) else {}
    price_value, price_unit = _price_from_ai_and_raw(price_info)
    area = ai.get("carpet_area_sqft")
    bhk = _normalized_bhk(ai.get("bhk") or ai.get("bhk_options"))
    if not is_requirement:
        row.update({
            "bhk": bhk,
            "carpet_area_sqft": area,
            "built_up_area_sqft": ai.get("built_up_area_sqft"),
            "area_raw_text": ai.get("area_raw_text"),
            "price_raw_text": price_info.get("raw_price_text"),
            "price_basis": ai.get("price_basis"),
            "furnishing_status": ai.get("furnishing_status"),
            "possession_status": ai.get("possession_status"),
            "possession_date": ai.get("possession_date"),
            "bathroom_count": ai.get("bathroom_count"),
            "car_parking_count": ai.get("car_parking_count"),
            "parking_type": ai.get("parking_type"),
            "floor_range": ai.get("floor_range"),
            "building_amenities": ai.get("building_amenities") or [],
            "unit_amenities": ai.get("amenities") or [],
            "amenities_unverified_claim": ai.get("amenities_unverified_claim"),
            "brokerage_type": ai.get("brokerage_type"),
        })
        if tx == "sale":
            row["total_asking_price"] = price_value if price_unit != "per_sqft" else None
            row["price_per_sqft"] = price_value if price_unit == "per_sqft" else None
            if price_unit == "per_sqft" and area:
                row["total_asking_price"] = price_value * area
        else:
            row["monthly_rent"] = price_value if price_unit != "per_sqft" else None
            row["rent_per_sqft"] = price_value if price_unit == "per_sqft" else None
            if price_unit == "per_sqft" and area:
                row["monthly_rent"] = price_value * area
        if asset == "commercial":
            row["commercial_use_type"] = ai.get("commercial_use_type") or "mixed_use"
            row["fitout_status"] = ai.get("fitout_status")
            row["ceiling_height"] = ai.get("ceiling_height")
            row["power_load_kw"] = ai.get("power_load_kw")
            row["cam_amount"] = ai.get("cam_amount")
            row["cam_applicable"] = ai.get("cam_applicable")
            row["cam_unit"] = ai.get("cam_unit")
        if tx == "rent":
            rent = row.get("monthly_rent")
            row.update(_parse_deposit(str(ai.get("deposit_raw_text") or raw_text), rent))
    else:
        row.update({
            "intent": "BUY",
            "bhk_options": [bhk] if bhk is not None else [],
            "budget_min": ai.get("budget_min"),
            "budget_max": ai.get("budget_max") or price_value,
            "budget_currency": "INR",
            "area_min_sqft": ai.get("area_min_sqft") or area,
            "area_max_sqft": ai.get("area_max_sqft") or area,
            "locality_options": ai.get("locality_options") or ([resolved_locality] if resolved_locality else []),
            "is_flexible": bool(ai.get("is_flexible")),
            "urgency": ai.get("urgency") or "normal",
            "status": "active",
            "furnishing_preference": ai.get("furnishing_preference"),
            "possession_preference": ai.get("possession_preference"),
            "amenity_requirements": ai.get("amenity_requirements") or [],
        })
        if asset == "commercial":
            row["commercial_use_type"] = ai.get("commercial_use_type") or []
        elif tx == "rent":
            row.update({
                "tenant_type": ai.get("tenant_type"),
                "has_pets": ai.get("has_pets"),
                "sharing_acceptable": ai.get("sharing_acceptable"),
                "lease_term_preference": ai.get("lease_term_preference"),
                "deposit_budget_max": ai.get("deposit_budget_max"),
            })
    return table, {k: v for k, v in row.items() if v is not None}


def _normalized_bhk(value) -> float | None:
    """Return a comparable BHK value without guessing when none is present."""
    if value is None:
        return None
    text = str(value).strip().lower()
    if "rk" in text:
        return 0.5
    match = re.search(r"\d+(?:\.\d+)?", text)
    if not match:
        return None
    try:
        return float(match.group(0))
    except ValueError:
        return None


def _deterministic_price_rupees(item: dict) -> float | None:
    """Convert a deterministic boundary price to absolute rupees."""
    raw_price = item.get("price")
    if raw_price in (None, ""):
        return None
    try:
        value = float(raw_price)
    except (TypeError, ValueError):
        return None

    unit = str(item.get("price_unit") or "").strip().lower()
    if unit in {"cr", "crore", "crores"}:
        return value * 1_00_00_000 if value < 1_00_000 else value
    if unit in {"lac", "lacs", "lakh", "lakhs", "l"}:
        return value * 1_00_000 if value < 10_000 else value
    if unit in {"k", "thousand"}:
        return value * 1_000 if value < 10_000 else value
    return value


def _meaningful_name_tokens(value) -> set[str]:
    if not value:
        return set()
    generic = {
        "apartment", "apartments", "building", "bungalow", "commercial",
        "flat", "office", "project", "residential", "residency", "society",
        "tower", "towers",
    }
    return {
        token
        for token in re.findall(r"[a-z0-9]+", str(value).lower())
        if len(token) >= 3 and token not in generic
    }


def _ai_item_matches_boundary(ai_item: dict, boundary: dict, source_text: str) -> tuple[bool, list[str]]:
    """Reject explicit cross-unit conflicts between AI output and a split block.

    Missing fields are allowed because AI may legitimately recover an anchor the
    regex splitter missed. Explicitly conflicting BHK, area, price, or building
    values are not allowed: those are the common signs that sibling properties
    were merged or reordered.
    """
    parsed = _ai_extraction_to_parsed(ai_item, source_text, "", "")
    conflicts: list[str] = []

    boundary_bhk = _normalized_bhk(boundary.get("bhk"))
    ai_bhk = _normalized_bhk(parsed.get("bhk"))
    if boundary_bhk is not None and ai_bhk is not None and boundary_bhk != ai_bhk:
        conflicts.append(f"bhk {ai_bhk:g}!={boundary_bhk:g}")

    try:
        boundary_area = float(boundary.get("area_sqft")) if boundary.get("area_sqft") not in (None, "") else None
        ai_area = float(parsed.get("area_sqft")) if parsed.get("area_sqft") not in (None, "") else None
    except (TypeError, ValueError):
        boundary_area = ai_area = None
    if boundary_area is not None and ai_area is not None:
        tolerance = max(25.0, boundary_area * 0.03)
        if abs(ai_area - boundary_area) > tolerance:
            conflicts.append(f"area {ai_area:g}!={boundary_area:g}")

    boundary_price = _deterministic_price_rupees(boundary)
    try:
        ai_price = float(parsed.get("price")) if parsed.get("price") not in (None, "") else None
    except (TypeError, ValueError):
        ai_price = None
    if boundary_price is not None and ai_price is not None:
        tolerance = max(25_000.0, boundary_price * 0.02)
        if abs(ai_price - boundary_price) > tolerance:
            conflicts.append(f"price {ai_price:g}!={boundary_price:g}")

    boundary_building = _meaningful_name_tokens(
        boundary.get("building_name") or boundary.get("project_name")
    )
    ai_building = _meaningful_name_tokens(parsed.get("building_name"))
    if boundary_building and ai_building and boundary_building.isdisjoint(ai_building):
        conflicts.append("building mismatch")

    return not conflicts, conflicts


def check_share_eligibility(parsed: dict, org_privacy: dict, conv_type: str = "unknown") -> tuple[bool, str]:
    """Return whether a parsed item may participate in shared-market views.

    Raw messages and tenant-owned observations are always retained. This flag
    only controls cross-tenant sharing/materialized market surfaces.
    """
    mode = str(org_privacy.get("privacy_mode") or "private").lower()
    if mode in {"private", "tenant_private"}:
        return False, "organization_privacy_private"

    intent = str(parsed.get("intent") or conv_type or "").upper()
    is_requirement = intent in {"BUY", "REQUIREMENT", "RENTAL_SEEKER", "TENANT", "DEMAND"}
    if is_requirement and not org_privacy.get("share_requirements", False):
        return False, "requirements_sharing_disabled"
    if not is_requirement and not org_privacy.get("share_listings", False):
        return False, "listing_sharing_disabled"
    return True, "eligible"


_INDIAN_MOBILE_IN_TEXT = re.compile(r'(?<!\d)(?:\+?91[-.\s]?)?[6-9]\d{9}(?!\d)')

_REDACTED_MARKER = "[Contact redacted — see agent]"
_INDIAN_MOBILE_LOOSE = re.compile(r'(?<!\d)(?:\+?91[-.\s]?)?[6-9]\d{4}[-\s.]?\d{5}(?!\d)')
# 11-digit bare phones (with optional '0' STD prefix) that real brokers paste
# without separators. The strict LOOSE pattern misses them because its
# 5-trailing-digit lookahead hits the leftover 11th digit. Lookbehind/lookahead
# keep the digit boundary tight (no embedding in longer runs).
_INDIAN_MOBILE_LONG = re.compile(r'(?<!\d)(?:0[6-9]\d{9}|[6-9]\d{10})(?!\d)')

def _redact_indian_mobiles(text: str) -> str:
    """Replace Indian mobile numbers with a redaction marker for display.

    Catches standard 10-digit (9876543210, +91 9876543210, 98765-43210),
    11-digit bare phones (90048427759, 84335469487) and 12-digit STD-prefixed
    numbers (09004842775). The original digits still live in
    raw_payload.full_text for audit and broker-resolution paths.

    Note: 3+3+4 / 2+2+2+2+2 obfuscation is intentionally NOT covered —
    a pre-cleaning regex would mangle prices like "Rs8.5L" into "Rs85L".
    """
    if not text:
        return ""
    cleaned = _INDIAN_MOBILE_LOOSE.sub(_REDACTED_MARKER, text)
    cleaned = _INDIAN_MOBILE_LONG.sub(_REDACTED_MARKER, cleaned)
    cleaned = _INDIAN_MOBILE_IN_TEXT.sub(_REDACTED_MARKER, cleaned)
    while _REDACTED_MARKER + " " + _REDACTED_MARKER in cleaned:
        cleaned = cleaned.replace(_REDACTED_MARKER + " " + _REDACTED_MARKER, _REDACTED_MARKER)
    while "  " in cleaned:
        cleaned = cleaned.replace("  ", " ")
    return cleaned.strip()


def _slice_blocks_for_ai_items(msg_text: str, ai_items: list) -> list[str]:
    """Assign per-listing slice text from the document segmenter output.

    Pairs ai_items[i] with _segment_document(msg_text).blocks[i] when the
    counts match; otherwise every item falls back to the full message so
    bad slicing can never render wrong text. Both lists are returned in
    document order by their respective pipelines.
    """
    if not ai_items:
        return []
    try:
        from ai_extraction import _segment_document
        segments = _segment_document(msg_text or "")
    except Exception:
        return [msg_text] * len(ai_items)
    blocks = (segments or {}).get("blocks") or []
    if len(blocks) == len(ai_items):
        out = []
        for b in blocks:
            t = (b.get("text") or "").strip()
            out.append(t if t else msg_text)
        return out
    return [msg_text] * len(ai_items)


def _extract_broker_contact_from_text(text: str) -> tuple[str | None, str | None]:
    """Extract Indian mobile number and optional broker name from message body text.

    Returns (phone, name) where phone is the 10-digit validated number (first
    match), and name is any text on the same line immediately before the number
    that doesn't look like another number.
    """
    if not text:
        return None, None
    # Do not remove newlines between separate phone numbers. Bulk broker
    # footers commonly put one contact per line; collapsing those lines turns
    # two valid 10-digit numbers into one invalid 20-digit number.
    cleaned = re.sub(r'(?<=\d)[-. ]+(?=\d)', '', text)
    phone = None
    name = None
    for m in _INDIAN_MOBILE_IN_TEXT.finditer(cleaned):
        num = m.group()
        num_clean = num[-10:] if re.match(r'^\+?91', num) else num
        if not re.fullmatch(r'[6-9]\d{9}', num_clean):
            continue
        if phone is None:
            phone = num_clean
            line_start = cleaned.rfind('\n', 0, m.start()) + 1
            preceding = cleaned[line_start:m.start()].strip().rstrip(':,').strip()
            if not preceding or re.search(r'\d', preceding):
                lines_before = cleaned[:line_start].rstrip('\n').split('\n')
                if lines_before:
                    candidate = lines_before[-1].strip().rstrip(':,').strip()
                    if candidate and not re.search(r'\d', candidate) and 1 < len(candidate) <= 60:
                        preceding = candidate
            if preceding and not re.search(r'\d', preceding) and len(preceding) > 1:
                name = re.sub(r"[^\w.' &-]", " ", _strip_icons(preceding))
                name = re.sub(r"\s+", " ", name).strip() or None
        elif num_clean != phone:
            break
    return phone, name


def process_raw_message(raw_id: int, ctx: dict, storage=None):
    """Process a single raw message through the full extraction pipeline.

    This is the async workhorse — called from both webhook background threads
    and the extraction worker.  It never touches the webhook request; all
    context is passed explicitly via `ctx`.

    ctx keys:
      sender_name, push_name, sender_jid, sender_phone,
      group, group_name, msg_text, instance, is_dm,
      message_uid, message_id, msg (raw message dict with image/video flags)
    """
    if storage is None:
        storage = get_storage()

    # Ensure tenant context is set for this extraction run
    if ctx.get("tenant_id"):
        storage.tenant_id = ctx["tenant_id"]

    from lab.config import load_excluded_groups

    msg_text = ctx["msg_text"]
    sender_name = ctx["sender_name"]
    push_name = ctx["push_name"]
    sender_jid = ctx["sender_jid"]
    sender_phone = ctx["sender_phone"]
    group = ctx["group"]
    group_name = ctx["group_name"]
    instance = ctx["instance"]
    is_dm = ctx["is_dm"]
    message_uid = ctx["message_uid"]
    message_id = ctx["message_id"]
    msg = ctx.get("msg", {})

    # Re-import app-level helpers (they depend on app.py globals)
    from app import (
        generate_summary_title, compute_embedding, resolve_parsed,
    )
    # Share eligibility is deterministic and evaluated before persistence. It
    # keeps private tenant output out of shared-market consumers while leaving
    # the raw observation available to the owning tenant.

    # Skip excluded groups
    try:
        excluded = load_excluded_groups()
        if group in excluded:
            storage.mark_raw_processed(raw_id)
            return {
                "raw_id": raw_id,
                "parsed_ids": [],
                "listing_ids": [],
                "requirement_ids": [],
                "storage_status": "skipped",
                "extraction_source": "excluded_group",
            }
    except Exception:
        pass

    # ── Classify conversation for privacy filtering ──────────────────
    conv_type = None
    org_privacy = {"privacy_mode": "private"}
    # classify_conversation removed (dead code) — skip privacy filtering
    org_id = ctx.get("tenant_id") or storage._tenant_id or "00000000-0000-0000-0000-000000000010"
    org = storage.get_organization(org_id)
    if org:
        org_privacy = {
            "privacy_mode": org.get("privacy_mode", "private"),
            "share_listings": org.get("share_listings", False),
            "share_requirements": org.get("share_requirements", False),
            "share_price_trends": org.get("share_price_trends", False),
            "share_market_activity": org.get("share_market_activity", False),
            "share_building_intelligence": org.get("share_building_intelligence", False),
            "share_broker_network": org.get("share_broker_network", False),
            "share_broker_reputation": org.get("share_broker_reputation", False),
            "share_demand_signals": org.get("share_demand_signals", False),
        }

    # ── Knowledge Record ────────────────────────────────────────
    kr_source_type = "dm" if is_dm else "whatsapp"
    kr_conversation_name = (
        sender_name
        or (f"+{sender_phone}" if sender_phone else "")
        or group
        if is_dm
        else group_name
    )
    knowledge_record_id = None
    if not ctx.get("skip_knowledge_record"):
        try:
            now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            knowledge_record_id = storage.create_knowledge_record({
                "source_type": kr_source_type,
                "source_id": message_uid,
                "raw_content": msg_text,
                "sender_jid": sender_jid,
                "sender_name": sender_name,
                "sender_phone": sender_phone,
                "conversation_id": group,
                "conversation_name": kr_conversation_name,
                "message_timestamp": now,
                "content_type": "unknown",
                "metadata": json.dumps({
                    "raw_id": raw_id,
                    "message_id": message_id,
                    "instance": instance,
                    "has_image": bool(msg.get("imageMessage")),
                    "has_video": bool(msg.get("videoMessage")),
                    "has_document": bool(msg.get("documentMessage")),
                }),
            })
        except Exception as exc:
            print(f"  [extract] create_knowledge_record error for {raw_id}: {exc}", flush=True)

    # ── Parse (dedup first, deterministic splitter second, AI last) ───
    preparsed_input = ctx.get("preparsed_listings")
    parsed_listings: list[dict] = (
        [
            _sanitize_parsed_listing(dict(item))
            for item in preparsed_input
            if isinstance(item, dict)
        ]
        if isinstance(preparsed_input, list)
        else []
    )
    ai_extractions_raw: list[dict | None] = []
    extraction_source: str | None = None
    ai_result: dict | None = None
    message_hash = (ctx.get("message_hash") or "").strip() or _message_hash(msg_text)
    if message_hash:
        try:
            storage.set_raw_message_hash(raw_id, message_hash)
        except Exception:
            pass

    if isinstance(preparsed_input, list):
        extraction_source = "reviewed_reparse_preview"
        ai_result = {"extraction_source": extraction_source, "extractions": []}
    elif not parsed_listings:
        duplicate_source = None
        if message_hash:
            try:
                duplicate_source = storage.get_raw_message_by_hash(
                    message_hash,
                    tenant_id=org_id,
                    processed=True,
                    exclude_raw_id=raw_id,
                    with_parsed=True,
                )
            except Exception:
                duplicate_source = None
            if duplicate_source and duplicate_source.get("raw") and duplicate_source.get("parsed"):
                cloned = _clone_parsed_rows(storage, int(duplicate_source["raw"]["id"]), raw_id)
                # Keep test/plugin callers that still return the old two-item
                # tuple compatible while the clone path now reports demand IDs.
                if len(cloned) == 2:
                    parsed_ids, listing_ids = cloned
                    requirement_ids = []
                else:
                    parsed_ids, listing_ids, requirement_ids = cloned
                if parsed_ids:
                    try:
                        storage.mark_raw_processed(raw_id)
                    except Exception:
                        pass
                    return {
                        "raw_id": raw_id,
                        "parsed_ids": parsed_ids,
                        "listing_ids": listing_ids,
                        "requirement_ids": requirement_ids,
                        "storage_status": "stored",
                        "extraction_source": "hash_duplicate",
                    }

        selected_pattern, parsed_chunks = _run_template_splitter(
            storage,
            msg_text,
            tenant_id=org_id,
            sender_phone=sender_phone or "",
            sender_jid=sender_jid or "",
        )
        if selected_pattern and parsed_chunks:
            if len(parsed_chunks) > 1 and not ctx.get("parent_message_id"):
                split_ctx = {
                    **ctx,
                    "split_pattern": selected_pattern,
                }
                split_ids = _materialize_split_raw_messages(storage, raw_id, split_ctx, parsed_chunks)
                if len(split_ids) == len(parsed_chunks):
                    storage.mark_raw_processed(raw_id)
                    return {
                        "raw_id": raw_id,
                        "split_raw_ids": split_ids,
                        "parsed_ids": [],
                        "listing_ids": [],
                        "requirement_ids": [],
                        "storage_status": "split",
                        "extraction_source": f"deterministic:{selected_pattern}",
                    }
            parsed_listings = [
                _sanitize_parsed_listing(dict(item))
                for item in parsed_chunks
                if isinstance(item, dict)
            ]
            ai_extractions_raw = [None] * len(parsed_listings)
            extraction_source = f"deterministic:{selected_pattern}"
            ai_result = {"extraction_source": extraction_source, "extractions": []}

    if not parsed_listings:
        # AI receives the original message exactly once. Do not classify, split,
        # rank, rewrite, or retry deterministic fragments before extraction.
        # The model owns semantic boundaries and returns one item per opportunity.
        # Every item retains the complete original message as its source evidence.
        try:
            from ai_extraction import ai_extract
            from extraction_dedup import cache_lookup, cache_store

            _tenant_for_cache = ctx.get("tenant_id") or getattr(storage, "_tenant_id", "") or ""
            ai_result = cache_lookup(storage, _tenant_for_cache, msg_text)
            cache_needs_store = ai_result is None
            if ai_result is not None:
                _logger.info("raw_id=%d extraction cache hit", raw_id)
            else:
                ai_result = ai_extract(msg_text, ctx, storage=storage)
            extraction_source = ai_result.get("extraction_source")
            raw_ai_items = ai_result.get("extractions") or ([ai_result["extraction"]] if ai_result.get("extraction") else [])
            ai_items = [item for item in raw_ai_items if isinstance(item, dict)]
            if extraction_source == "ai" and ai_items:
                slice_texts = _slice_blocks_for_ai_items(msg_text, ai_items)
                guarded_items = _apply_requirement_source_guard(ai_items, msg_text, slice_texts)
                guarded_items = _apply_listing_transaction_guard(guarded_items, msg_text, slice_texts)
                if guarded_items != ai_items:
                    cache_needs_store = True
                    ai_items = guarded_items
                    if ai_result.get("extractions") is not None:
                        ai_result = {**ai_result, "extractions": ai_items}
                    else:
                        ai_result = {**ai_result, "extraction": ai_items[0]}
                parsed_listings = [
                    _ai_extraction_to_parsed(item, msg_text, sender_name, push_name, slice_text=sl)
                    for item, sl in zip(ai_items, slice_texts)
                ]
                ai_extractions_raw = ai_items
                _logger.info("raw_id=%d AI extraction: %d structured item(s) via %s", raw_id, len(ai_items), ai_result.get("provider_used"))
            if cache_needs_store:
                cache_store(
                    storage,
                    _tenant_for_cache,
                    msg_text,
                    ai_result,
                    provider_used=ai_result.get("provider_used"),
                )
        except Exception as exc:
            _logger.warning("raw_id=%d ai_extract error: %s", raw_id, exc)

        # Provider failure is never a "no anchor". When every provider is down
        # (or the AI call itself raised), the message must stay unprocessed so a
        # later cycle retries it. Treating it as a non-listing here would mark a
        # real listing as consumed with a NO_ANCHOR stub and lose it forever.
        if ai_result is None or ai_result.get("extraction_source") == "ai_unavailable":
            raise RuntimeError(
                f"raw_id={raw_id} extraction unavailable — "
                f"{ai_result.get('error') if ai_result else 'no provider response'}"
            )

    if not parsed_listings:
        try:
            get_bus().publish("extraction.skipped", {
                "raw_id": raw_id, "reason": "no_real_estate_anchor", "message": msg_text[:200],
            })
        except Exception:
            pass
        # Save a no-anchor stub so the message still surfaces in the inbox
        # feed (broker cards show message_count, not just listing_count).
        # Without this, [Image]/[Video] placeholders get marked processed
        # silently and brokers that only share images/videos appear empty.
        msg_class = "unstructured"
        try:
            broker_id = storage.resolve_broker(
                broker_phone=sender_phone or "",
                sender_phone=sender_phone or "",
                sender_jid=sender_jid or "",
                broker_name=sender_name or push_name or "",
                profile_name=sender_name or push_name or "",
                sender=sender_name or push_name or "",
            )
            stub = ParsedObservation(
                raw_message_id=raw_id,
                message_type=msg_class,
                intent="NO_ANCHOR",
                broker_name=sender_name or push_name or "",
                broker_phone=sender_phone or "",
                profile_name=sender_name or push_name or "",
                confidence=0.0,
                raw_payload=json.dumps({
                    "note": "no_real_estate_anchor",
                    "message_class": msg_class,
                    "message_preview": msg_text[:200],
                }),
                summary_title=f"[{msg_class}] {sender_name or push_name or 'unknown'}",
                ai_extraction={"reason": "no_real_estate_anchor", "class": msg_class},
                broker_id=broker_id,
                group_name=group_name,
            )
            storage.save_typed_observation(stub)
        except Exception as exc:
            print(f"  [extract] save_parsed stub error for {raw_id}: {exc}", flush=True)
        try:
            storage.mark_raw_processed(raw_id)
        except Exception:
            pass
        return {
            "raw_id": raw_id,
            "parsed_ids": [],
            "listing_ids": [],
            "requirement_ids": [],
            "storage_status": "skipped",
            "extraction_source": "no_anchor",
        }

    # ── Listing validation (price / locality / general) ────────────
    # Runs AFTER AI extraction + _ai_extraction_to_parsed() and BEFORE
    # broker attribution + typed observation persistence. Flags are stored on
    # each parsed dict so they flow through to the typed table's validation_flags.
    try:
        from listing_validation import validate_listing, apply_validation
        for idx, pl in enumerate(parsed_listings):
            vr = validate_listing(pl)
            if vr.flags:
                _logger.info(
                    "raw_id=%d validation flags: %s",
                    raw_id, ", ".join(vr.flags),
                )
            parsed_listings[idx] = apply_validation(pl, vr)
    except Exception as vexc:
        _logger.warning("raw_id=%d validation error: %s", raw_id, vexc)

    # ── Broker attribution ──────────────────────────────────────
    # Only store broker_phone from validated Indian mobile numbers (10-12 digits,
    # starting with 6-9, optional +91/91 prefix).  WhatsApp LIDs (15 digits starting
    # with 1-2) are never valid phone numbers — reject them silently.
    # When sender_phone is empty (e.g. @lid senders), fall back to scanning the
    # message body text for explicitly stated contact numbers — brokers routinely
    # self-publish their number in posts.
    sender_label = (sender_name or push_name or "").strip()
    sender_label_is_name = bool(
        sender_label
        and sender_label.lower() not in {"unknown", "unknown sender", "whatsapp"}
        and not re.fullmatch(r"[+\d\s().:@_-]+", sender_label)
    )
    sender_digits = re.sub(r"\D+", "", sender_phone or "")
    if sender_digits.startswith("91") and len(sender_digits) >= 12:
        sender_digits = sender_digits[-10:]
    sender_phone_from_label = None
    if sender_label_is_name:
        # Bulk posters often append several inspection contacts. Prefer the
        # number explicitly printed beside the WhatsApp sender's name rather
        # than assigning every listing to the first unrelated contact.
        lower_body = (msg_text or "").lower()
        label_pos = lower_body.find(sender_label.lower())
        if label_pos >= 0:
            label_window = (msg_text or "")[label_pos:label_pos + 140]
            sender_phone_from_label, _ = _extract_broker_contact_from_text(label_window)

    # A broker broadcast often ends with a signature containing the contact
    # name and phone. This is source evidence already present in WhatsMeow's
    # captured message; attach it to every split item without another LLM call.
    signature_phone, signature_name = _extract_broker_contact_from_text(msg_text or "")

    def apply_source_price_guard(parsed: dict, source_text: str) -> None:
        # For a single listing, or a correctly isolated split block, an
        # explicit native price in the source outranks an LLM conversion.
        if not source_text or (len(parsed_listings) > 1 and source_text.strip() == (msg_text or "").strip()):
            return
        native = _parse_raw_price_native(source_text)
        if not native:
            return
        amount, unit = native
        absolute = _deterministic_price_rupees({"price": amount, "price_unit": unit})
        if absolute is None:
            return
        parsed["price"] = absolute
        parsed["price_unit"] = "abs"
        parsed["price_model"] = None
        if parsed.get("intent") == "RENT":
            parsed["monthly_rent"] = absolute
        elif parsed.get("intent") == "SELL":
            parsed["total_asking_price"] = absolute

    for pl in parsed_listings:
        block_text = (pl.get("raw_payload") or {}).get("full_text") if isinstance(pl.get("raw_payload"), dict) else ""
        apply_source_price_guard(pl, block_text or msg_text or "")
        is_valid_mobile = bool(re.fullmatch(r'^(\+?91)?[6-9]\d{9}$', sender_phone or ''))
        if sender_label_is_name:
            pl["broker_name"] = sender_label
            if sender_phone_from_label:
                pl["broker_phone"] = sender_phone_from_label
            elif len(sender_digits) == 10 and sender_digits[0] in "6789":
                pl["broker_phone"] = sender_digits
        if not pl.get("broker_name") or not pl.get("broker_phone"):
            if not pl.get("broker_name"):
                if is_valid_mobile:
                    pl["broker_name"] = f"+91 {sender_phone[-10:]}"
                elif sender_phone:
                    pl["broker_name"] = f"+{sender_phone}"
            if not pl.get("broker_phone"):
                if is_valid_mobile:
                    pl["broker_phone"] = sender_phone[-10:]

        # Text-based fallback: if broker_phone is still missing, scan the message
        # body for explicitly stated Indian mobile numbers.
        if not pl.get("broker_phone"):
            raw_text_body = ""
            rp = pl.get("raw_payload")
            if isinstance(rp, dict):
                raw_text_body = rp.get("full_text") or ""
            if not raw_text_body:
                raw_text_body = msg_text if msg_text else ""
            phone_from_text, name_from_text = _extract_broker_contact_from_text(raw_text_body)
            if phone_from_text:
                pl["broker_phone"] = phone_from_text
                if name_from_text and not pl.get("broker_name"):
                    pl["broker_name"] = name_from_text
                existing_flags = list(pl.get("validation_flags") or [])
                existing_flags.append("broker_phone_text_extracted")
                pl["validation_flags"] = existing_flags
        if signature_phone and not pl.get("broker_phone"):
            pl["broker_phone"] = signature_phone
        if signature_name and not pl.get("broker_name"):
            pl["broker_name"] = signature_name

    if parsed_listings:
        for pl in parsed_listings:
            # _attribution_suffix removed (dead code) — skip suffix appending
            pass
            # suffix = _attribution_suffix(pl.get("broker_name"), pl.get("broker_phone"))
            # if suffix:
            #     rp = pl.get("raw_payload")
            #     if isinstance(rp, dict) and isinstance(rp.get("full_text"), str):
            #         rp["full_text"] = rp["full_text"].rstrip() + suffix

    # Preview mode deliberately stops before save_parsed, listing upserts,
    # graph writes, processed flags, or any deletion. The caller can validate
    # the exact proposed cards and later pass them back as preparsed_listings.
    if ctx.get("preview_only"):
        return {
            "raw_id": raw_id,
            "parsed_listings": parsed_listings,
            "proposed_count": len(parsed_listings),
            "storage_status": "preview",
            "message_class": "ai_structured" if parsed_listings else "unstructured",
            "extraction_source": extraction_source or "ai_unavailable",
        }

    # ── Save parsed observations ────────────────────────────────
    parsed_ids: list[int] = []
    listing_ids: list[int] = []
    requirement_ids: list[int] = []
    for idx, parsed in enumerate(parsed_listings):
        ai_item = ai_extractions_raw[idx] if idx < len(ai_extractions_raw) else None
        share_eligible, share_reason = check_share_eligibility(
            parsed, org_privacy, conv_type or parsed.get("intent") or "unknown"
        )
        if not share_eligible:
            parsed["_can_share_to_market"] = False
            parsed["_share_reason"] = share_reason
        else:
            parsed["_can_share_to_market"] = True
            parsed["_share_reason"] = share_reason

        try:
            embedding_blob = compute_embedding(parsed) if idx == 0 else None
        except Exception as exc:
            print(f"  [extract] compute_embedding error: {exc}", flush=True)
            embedding_blob = None
        block_text = None
        if isinstance(parsed.get("raw_payload"), dict):
            block_text = parsed["raw_payload"].get("full_text")
        source_text = block_text or msg_text

        # Resolver evidence can supply a canonical building market that the
        # text parser cannot. Persist it on the typed observation before listings are
        # materialized so every downstream surface sees the same locality.
        try:
            resolver_result = resolve_parsed(parsed, source_text)
            for field in (
                "building_name", "landmark_name", "street_name",
                "project_name", "developer_name", "micro_market",
            ):
                parsed_field = "developer" if field == "developer_name" else field
                if not parsed.get(parsed_field) and resolver_result.get(field):
                    parsed[parsed_field] = resolver_result[field]
        except Exception as exc:
            print(f"  [extract] resolve_parsed error: {exc}", flush=True)
            resolver_result = {}

        # Resolve broker identity for this observation
        try:
            broker_id = storage.resolve_broker(
                broker_phone=parsed.get("broker_phone") or "",
                sender_phone=sender_phone or "",
                sender_jid=sender_jid or "",
                broker_name=parsed.get("broker_name") or "",
                profile_name=sender_name or push_name or "",
                sender=sender_name or push_name or "",
            )
        except Exception as exc:
            print(f"  [extract] resolve_broker error: {exc}", flush=True)
            broker_id = None

        obs = ParsedObservation(
            raw_message_id=raw_id,
            listing_index=idx,
            message_type=parsed.get("message_type"),
            intent=parsed.get("intent"),
            principal=parsed.get("principal"),
            bhk=parsed.get("bhk"),
            configuration=parsed.get("configuration"),
            price=parsed.get("price"),
            price_unit=parsed.get("price_unit"),
            price_model=parsed.get("price_model"),
            price_per_sqft=parsed.get("price_per_sqft"),
            monthly_rent=parsed.get("monthly_rent"),
            total_asking_price=parsed.get("total_asking_price"),
            area_sqft=parsed.get("area_sqft"),
            furnishing=parsed.get("furnishing"),
            furnishing_canonical=parsed.get("furnishing_canonical"),
            location_raw=parsed.get("location_raw"),
            location=json.dumps(parsed.get("location")) if parsed.get("location") else None,
            building_name=parsed.get("building_name"),
            landmark_name=parsed.get("landmark_name"),
            street_name=parsed.get("street_name"),
            area=parsed.get("area"),
            micro_market=parsed.get("micro_market"),
            developer=parsed.get("developer"),
            asset_type=parsed.get("asset_type"),
            property_type=parsed.get("property_type"),
            transaction_type=parsed.get("transaction_type"),
            commercial_use_type=parsed.get("commercial_use_type"),
            fitout_status=parsed.get("fitout_status"),
            occupancy_type=parsed.get("occupancy_type"),
            floor_range=parsed.get("floor_range"),
            rent_per_sqft=parsed.get("rent_per_sqft"),
            availability_status=parsed.get("availability_status"),
            possession_status=parsed.get("possession_status"),
            possession_date=parsed.get("possession_date"),
            available_from=parsed.get("available_from"),
            ready_by=parsed.get("ready_by"),
            construction_stage=parsed.get("construction_stage"),
            launch_timeline=parsed.get("launch_timeline"),
            expected_possession=parsed.get("expected_possession"),
            broker_name=parsed.get("broker_name"),
            broker_phone=parsed.get("broker_phone"),
            profile_name=sender_name or push_name,
            forwarded=parsed.get("forwarded", 0),
            confidence=parsed.get("confidence", 0.0),
            raw_payload=json.dumps(parsed.get("raw_payload", {})),
            embedding=embedding_blob,
            summary_title=ai_item.get("title") if ai_item else generate_summary_title(parsed, source_text),
            normalized_message=parsed.get("normalized_message"),
            ai_extraction=ai_item,
            # deal_tags + additional_charges are AI-only signals (regex parser
            # doesn't know about them). When AI extraction fails/times out we
            # fall back to an empty list so the row still saves. We also
            # re-run the whitelist/dict-shape validator here so a junk value
            # from any code path (LLM drift, future schema changes, mocked
            # ai_extract in tests) can't poison the row.
            deal_tags=_safe_deal_tags(
                ai_item.get("deal_tags") if ai_item else parsed.get("deal_tags")
            ),
            additional_charges=_safe_additional_charges(
                ai_item.get("additional_charges") if ai_item else parsed.get("additional_charges")
            ),
            broker_id=broker_id,
            group_name=group_name,
            validation_flags=parsed.get("validation_flags", []),
        )
        try:
            parsed_id = storage.save_typed_observation(obs)
            parsed_ids.append(parsed_id)
        except Exception as exc:
            print(f"  [extract] save_parsed error: {exc}", flush=True)
            continue

        # ── Tags on knowledge record ──────────────────────────────
        if knowledge_record_id:
            tags = {}
            if parsed.get("intent"):
                tags["intent"] = [parsed["intent"]]
            if parsed.get("bhk"):
                tags["bhk"] = [f"{parsed['bhk']} BHK" if parsed['bhk'] != 0.5 else "1 RK"]
            if parsed.get("building_name"):
                tags["building"] = [parsed["building_name"]]
            if parsed.get("micro_market"):
                tags["market"] = [parsed["micro_market"]]
            if parsed.get("furnishing"):
                tags["furnishing"] = [parsed["furnishing"]]
            if parsed.get("price"):
                tags["price"] = [str(parsed["price"])]
            if tags:
                try:
                    storage.bulk_add_knowledge_tags(knowledge_record_id, tags, source="parser")
                except Exception:
                    pass

            intent = parsed.get("intent")
            try:
                if intent in ("SELL", "RENT"):
                    storage.update_knowledge_record(knowledge_record_id, {"content_type": "listing", "intent": intent})
                elif intent in ("BUY", "BUYER", "RENTAL_SEEKER"):
                    storage.update_knowledge_record(knowledge_record_id, {"content_type": "requirement", "intent": intent})
            except Exception:
                pass

        # ── Resolve ──────────────────────────────────────────────
        resolver_result["parsed_id"] = parsed_id

        dec = ResolverDecision(
            parsed_id=parsed_id,
            building_id=resolver_result.get("building_id"),
            building_name=resolver_result.get("building_name"),
            landmark_id=resolver_result.get("landmark_id"),
            landmark_name=resolver_result.get("landmark_name"),
            street_id=resolver_result.get("street_id"),
            street_name=resolver_result.get("street_name"),
            project_id=resolver_result.get("project_id"),
            project_name=resolver_result.get("project_name"),
            developer_name=resolver_result.get("developer_name"),
            parser_confidence=1.0,
            resolver_confidence=1.0,
            final_confidence=1.0,
            method=resolver_result.get("method", "unresolved"),
            method_detail=resolver_result.get("method_detail"),
            candidates=json.dumps(resolver_result.get("candidates", [])),
            failure_category=resolver_result.get("failure_category"),
            error=resolver_result.get("error"),
        )
        try:
            storage.save_resolver_decision(dec)
        except Exception as exc:
            print(f"  [extract] save_resolver_decision error: {exc}", flush=True)

        # Bridge the fully enriched observation to its correct market
        # destination only after the resolver pass. Supply and demand are
        # separate projections; a requirement must never become a listing.
        try:
            observation = dict(parsed)
            observation["id"] = parsed_id
            if str(observation.get("message_type") or "").upper() in {"REQUIREMENT", "BUY"} or str(observation.get("intent") or "").upper() in {"BUY", "BUYER", "REQUIREMENT", "RENTAL_SEEKER", "TENANT", "DEMAND"}:
                requirement_id = storage.upsert_market_requirement_from_parsed(parsed_id)
                if requirement_id:
                    requirement_ids.append(requirement_id)
            else:
                listing_id = storage.upsert_listing_from_parsed(parsed_id)
                if listing_id:
                    listing_ids.append(listing_id)
        except Exception as lexc:
            print(f"  [extract] market destination upsert error: {lexc}", flush=True)

        # ── Merge building amenities into buildings table ───────────
        # building_amenities are building-shared (gym, pool, etc.) and go
        # to buildings.amenities, not listings.amenities.
        bldg_amenities = parsed.get("building_amenities") or []
        if bldg_amenities and parsed.get("building_name"):
            try:
                storage.merge_building_amenities(parsed["building_name"], bldg_amenities)
            except Exception as bexc:
                print(f"  [extract] merge_building_amenities error: {bexc}", flush=True)

    # ── Publish events ─────────────────────────────────────────────
    try:
        get_bus().publish("extraction.completed", {
            "parsed_ids": parsed_ids, "raw_id": raw_id, "count": len(parsed_ids),
            "intent": parsed_listings[0].get("intent") if parsed_listings else None,
            "broker": parsed_listings[0].get("broker_name") if parsed_listings else None,
        })
    except Exception:
        pass
    if parsed_ids:
        try:
            get_bus().publish("resolution.completed", {
                "parsed_ids": parsed_ids, "raw_id": raw_id,
                "building": resolver_result.get("building_name"),
                "method": resolver_result.get("method", "unresolved"),
                "confidence": resolver_result.get("final_confidence", 0),
            })
        except Exception:
            pass

    # ── Extract implicit observations ─────────────────────────────
    # _process_observations removed (dead code) — skip
    if msg_text and len(msg_text) > 30 and parsed_listings:
        pass
        # try:
        #     _process_observations(
        #         msg_text,
        #         parsed_listings[0].get("broker_name", ""),
        #         parsed_listings[0].get("broker_phone", ""),
        #         parsed_ids,
        #         raw_id,
        #     )
        # except Exception as exc:
        #     print(f"  [extract] _process_observations error: {exc}", flush=True)

    # ── Mark processed ──────────────────────────────────────────────
    if parsed_listings and not parsed_ids:
        print(
            f"  [extract] leaving raw message {raw_id} unprocessed: "
            "all typed parsed-row inserts failed",
            flush=True,
        )
        return {"raw_id": raw_id, "parsed_ids": [], "listing_ids": [], "requirement_ids": [], "storage_status": "failed", "extraction_source": extraction_source or "no_anchor"}
    try:
        storage.mark_raw_processed(raw_id)
    except Exception as exc:
        print(f"  [extract] mark_raw_processed error: {exc}", flush=True)
    return {
        "raw_id": raw_id,
        "parsed_ids": parsed_ids,
        "listing_ids": listing_ids,
        "requirement_ids": requirement_ids,
        "storage_status": "stored",
        "extraction_source": extraction_source or "ai",
    }
