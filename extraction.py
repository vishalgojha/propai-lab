"""Async extraction pipeline — Layer 2-5 processing.

This module contains the shared extraction logic used by both:
  - The webhook background thread (runs per-message when webhook fires)
  - The extraction worker (poll-based, picks up unprocessed messages)

Extraction order:
  1. AI extraction (primary) — calls ai_extraction.ai_extract()
  2. Regex fallback — existing parse_message() pipeline

Import pattern:
  from extraction import process_raw_message
"""

import json
import logging
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

_logger = logging.getLogger(__name__)

PROJECT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_DIR))

from lab.storage.base import RawMessage, ParsedObservation, ResolverDecision
from storage import SupabaseStorage
from lab.embedding import create_engine, observation_text, pack_embedding
from lab.events import get_bus


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


def _sanitize_parsed_listing(parsed: dict) -> dict:
    return {key: _sanitize_parsed_value(value) for key, value in parsed.items()}


# Defence-in-depth validators for AI-only fields (deal_tags, additional_charges).
# ai_extract() already runs _normalize_extraction in ai_extraction.py, but if
# any code path bypasses that (mocked in tests, future schema migration, raw
# LLM output without normalization), the row should still be safe to save.
_VALID_DEAL_TAGS_STORAGE = frozenset({
    "distress_sale", "urgent_sale", "negotiable", "bank_auction",
    "resale", "exclusive_mandate", "price_drop",
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


def _ai_extraction_to_parsed(ai_extraction: dict, raw_text: str, sender_name: str, push_name: str) -> dict:
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

    category = ai_extraction.get("property_category")
    asset_type = category.upper() if category else None

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
    price_amount = price_info.get("amount") if isinstance(price_info, dict) else None
    price_unit_price = price_info.get("unit") if isinstance(price_info, dict) else None
    price_period = price_info.get("period") if isinstance(price_info, dict) else None

    price = float(price_amount) if price_amount is not None else None
    price_unit = "cr" if price and price >= 1_00_00_000 else ("lac" if price and price >= 1_00_000 else "abs") if price else None
    price_model = "psf" if price_unit_price == "per_sqft" else None

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

    return {
        "intent": intent,
        "principal": None,
        "bhk": bhk_str,
        "configuration": None,
        "price": price,
        "price_unit": price_unit,
        "price_model": price_model,
        "price_per_sqft": None,
        "monthly_rent": price if listing_type == "rent" else None,
        "total_asking_price": price if listing_type in ("sale",) else None,
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
        "transaction_type": None,
        "commercial_use_type": None,
        "fitout_status": None,
        "occupancy_type": None,
        "floor_range": None,
        "rent_per_sqft": None,

        "availability_status": None,
        "possession_status": ai_extraction.get("possession_status") or None,
        "possession_date": None,
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
        "confidence": 1.0 if ai_extraction.get("extraction_confidence") == "high" else 0.7,
        "raw_payload": {"full_text": raw_text},
        "location": None,
        "message_type": listing_type,
    }


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

    from lab import multi_listing
    from lab.location import enrich_parsed_location
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
        classify_conversation, generate_summary_title,
        compute_embedding, resolve_parsed, parse_message,
        _parsed_source_text, _demote_weak_property_parse,
        _parsed_has_market_anchor, _attribution_suffix,
        _process_observations, check_share_eligibility,
    )

    # Skip excluded groups
    try:
        excluded = load_excluded_groups()
        if group in excluded:
            storage.mark_raw_processed(raw_id)
            return
    except Exception:
        pass

    # ── Classify conversation for privacy filtering ──────────────────
    conv_type = None
    org_privacy = {"privacy_mode": "private"}
    try:
        conv_type = classify_conversation(group_name, group, msg_text)
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
    except Exception:
        pass

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

    # ── Parse (AI first, regex fallback) ────────────────────────
    parsed_listings: list[dict] = []
    ai_extraction_raw: dict | None = None
    ai_extractions_raw: list[dict] | None = None
    extraction_source: str | None = None

    # Detect multi-option posts so the AI response can be held to the same
    # one-structured-item-per-listing standard as the deterministic splitter.
    try:
        msg_class = multi_listing.classify_message(msg_text)
    except Exception as exc:
        print(f"  [extract] classify_message error for {raw_id}: {exc}", flush=True)
        msg_class = "single"

    # 1. Try AI extraction. Multi-listing messages require an AI array with at
    # least two validated items; otherwise the deterministic block parser is
    # the safe fallback.
    try:
        from ai_extraction import ai_extract
        ai_result = ai_extract(msg_text, ctx, storage=storage)
        extraction_source = ai_result.get("extraction_source")
        raw_ai_items = ai_result.get("extractions") or ([ai_result["extraction"]] if ai_result.get("extraction") else [])
        ai_items = [item for item in raw_ai_items if isinstance(item, dict)]
        if extraction_source == "ai" and ai_items and (msg_class != "multi" or len(ai_items) >= 2):
            parsed_listings = [
                _ai_extraction_to_parsed(item, msg_text, sender_name, push_name)
                for item in ai_items
            ]
            ai_extractions_raw = ai_items
            ai_extraction_raw = ai_items[0]
            _logger.info("raw_id=%d AI extraction: %d structured item(s) via %s", raw_id, len(ai_items), ai_result.get("provider_used"))
        elif msg_class == "multi" and extraction_source == "ai":
            _logger.warning("raw_id=%d multi-listing AI result had %d item(s); using block parser fallback", raw_id, len(ai_items))
    except Exception as exc:
        _logger.warning("raw_id=%d ai_extract error: %s — falling back to regex", raw_id, exc)
        extraction_source = "regex_fallback"

    # 2. Regex fallback
    if not parsed_listings:
        try:
            if msg_class == "multi":
                parsed_listings = multi_listing.parse_multi_message(
                    msg_text, profile_name=sender_name or push_name
                )
            else:
                single = parse_message(msg_text, profile_name=sender_name or push_name)
                parsed_listings = [single] if single else []
        except Exception as exc:
            print(f"  [extract] parse error for {raw_id}: {exc}", flush=True)

        # Filter weak parses
        market_listings = []
        for pl in parsed_listings:
            source_text = _parsed_source_text(pl, msg_text)
            enriched = enrich_parsed_location(pl, source_text, fallback_text=msg_text)
            cleaned = _demote_weak_property_parse(enriched, source_text)
            if _parsed_has_market_anchor(cleaned, source_text):
                market_listings.append(cleaned)
        parsed_listings = [_sanitize_parsed_listing(pl) for pl in market_listings]

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
        msg_class = msg_class if 'msg_class' in locals() else "unknown"
        try:
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
            )
            storage.save_parsed(stub)
        except Exception as exc:
            print(f"  [extract] save_parsed stub error for {raw_id}: {exc}", flush=True)
        try:
            storage.mark_raw_processed(raw_id)
        except Exception:
            pass
        return

    # ── Broker attribution ──────────────────────────────────────
    # Only store broker_phone from validated Indian mobile numbers (10-12 digits,
    # starting with 6-9, optional +91/91 prefix).  WhatsApp LIDs (15 digits starting
    # with 1-2) are never valid phone numbers — reject them silently.
    for pl in parsed_listings:
        is_valid_mobile = bool(re.fullmatch(r'^(\+?91)?[6-9]\d{9}$', sender_phone or ''))
        if not pl.get("broker_name") or not pl.get("broker_phone"):
            if not pl.get("broker_name"):
                if is_valid_mobile:
                    pl["broker_name"] = f"+91 {sender_phone[-10:]}"
                elif sender_phone:
                    pl["broker_name"] = f"+{sender_phone}"
            if not pl.get("broker_phone"):
                if is_valid_mobile:
                    pl["broker_phone"] = sender_phone[-10:]

    if parsed_listings:
        for pl in parsed_listings:
            suffix = _attribution_suffix(pl.get("broker_name"), pl.get("broker_phone"))
            if suffix:
                rp = pl.get("raw_payload")
                if isinstance(rp, dict) and isinstance(rp.get("full_text"), str):
                    rp["full_text"] = rp["full_text"].rstrip() + suffix

    # ── Save parsed observations ────────────────────────────────
    parsed_ids: list[int] = []
    for idx, parsed in enumerate(parsed_listings):
        ai_item = ai_extractions_raw[idx] if ai_extractions_raw and idx < len(ai_extractions_raw) else ai_extraction_raw
        share_eligible, share_reason = True, "ok"
        try:
            share_eligible, share_reason = check_share_eligibility(parsed, org_privacy, conv_type or "unknown")
        except Exception:
            pass
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
        # text parser cannot. Persist it on parsed_output before listings are
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

        obs = ParsedObservation(
            raw_message_id=raw_id,
            listing_index=idx,
            message_type=parsed.get("message_type"),
            intent=parsed.get("intent"),
            principal=parsed.get("principal"),
            bhk=parsed.get("bhk"),
            price=parsed.get("price"),
            price_unit=parsed.get("price_unit"),
            area_sqft=parsed.get("area_sqft"),
            furnishing=parsed.get("furnishing"),
            location_raw=parsed.get("location_raw"),
            location=json.dumps(parsed.get("location")) if parsed.get("location") else None,
            building_name=parsed.get("building_name"),
            landmark_name=parsed.get("landmark_name"),
            street_name=parsed.get("street_name"),
            area=parsed.get("area"),
            micro_market=parsed.get("micro_market"),
            developer=parsed.get("developer"),
            broker_name=parsed.get("broker_name"),
            broker_phone=parsed.get("broker_phone"),
            profile_name=sender_name or push_name,
            forwarded=parsed.get("forwarded", 0),
            confidence=parsed.get("confidence", 0.0),
            raw_payload=json.dumps(parsed.get("raw_payload", {})),
            embedding=embedding_blob,
            summary_title=ai_item.get("title") if ai_item else generate_summary_title(parsed, source_text),
            ai_extraction=ai_item,
            # deal_tags + additional_charges are AI-only signals (regex parser
            # doesn't know about them). When AI extraction fails/times out we
            # fall back to an empty list so the row still saves. We also
            # re-run the whitelist/dict-shape validator here so a junk value
            # from any code path (LLM drift, future schema changes, mocked
            # ai_extract in tests) can't poison the row.
            deal_tags=_safe_deal_tags(ai_item.get("deal_tags") if ai_item else None),
            additional_charges=_safe_additional_charges(ai_item.get("additional_charges") if ai_item else None),
        )
        try:
            parsed_id = storage.save_parsed(obs)
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
            parser_confidence=resolver_result.get("parser_confidence", 0.0),
            resolver_confidence=resolver_result.get("resolver_confidence", 0.0),
            final_confidence=resolver_result.get("final_confidence", 0.0),
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

        # Bridge the fully enriched observation to listings only after the
        # resolver pass. Fingerprint upsert keeps retries idempotent.
        try:
            storage.upsert_listing_from_parsed(parsed_id)
        except Exception as lexc:
            print(f"  [extract] upsert_listing error: {lexc}", flush=True)

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
    if msg_text and len(msg_text) > 30 and parsed_listings:
        try:
            _process_observations(
                msg_text,
                parsed_listings[0].get("broker_name", ""),
                parsed_listings[0].get("broker_phone", ""),
                parsed_ids,
                raw_id,
            )
        except Exception as exc:
            print(f"  [extract] _process_observations error: {exc}", flush=True)

    # ── Mark processed ──────────────────────────────────────────────
    if parsed_listings and not parsed_ids:
        print(
            f"  [extract] leaving raw message {raw_id} unprocessed: "
            "all parsed_output inserts failed",
            flush=True,
        )
        return
    try:
        storage.mark_raw_processed(raw_id)
    except Exception as exc:
        print(f"  [extract] mark_raw_processed error: {exc}", flush=True)
