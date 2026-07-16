"""Async extraction pipeline — Layer 2-5 processing.

This module contains the shared extraction logic used by both:
  - The webhook background thread (runs per-message when webhook fires)
  - The extraction worker (poll-based, picks up unprocessed messages)

Import pattern:
  from extraction import process_raw_message
"""

import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

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
    from evidence.parsers import parse as parse_message
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
        compute_embedding, resolve_parsed,
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

    # ── Parse ───────────────────────────────────────────────────
    try:
        msg_class = multi_listing.classify_message(msg_text)
    except Exception as exc:
        print(f"  [extract] classify_message error for {raw_id}: {exc}", flush=True)
        msg_class = "single"

    parsed_listings = []
    try:
        if msg_class == "multi":
            parsed_listings = multi_listing.parse_multi_message(
                msg_text, profile_name=sender_name or push_name
            )
        else:
            single = parse_message(msg_text)
            parsed_listings = [single] if single else []
    except Exception as exc:
        print(f"  [extract] parse error for {raw_id}: {exc}", flush=True)

    # Filter weak parses
    market_listings = []
    for pl in parsed_listings:
        source_text = _parsed_source_text(pl, msg_text)
        cleaned = _demote_weak_property_parse(pl, source_text)
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
        try:
            storage.mark_raw_processed(raw_id)
        except Exception:
            pass
        return

    # ── Broker attribution ──────────────────────────────────────
    for pl in parsed_listings:
        if not pl.get("broker_name") or not pl.get("broker_phone"):
            if not pl.get("broker_name"):
                if len(sender_phone) >= 10:
                    pl["broker_name"] = f"+91 {sender_phone[-10:]}"
                elif sender_phone:
                    pl["broker_name"] = f"+{sender_phone}"
            if not pl.get("broker_phone"):
                if len(sender_phone) >= 10:
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
            summary_title=generate_summary_title(parsed, source_text),
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
        try:
            resolver_result = resolve_parsed(parsed, source_text)
            resolver_result["parsed_id"] = parsed_id
        except Exception as exc:
            print(f"  [extract] resolve_parsed error: {exc}", flush=True)
            resolver_result = {"parsed_id": parsed_id}

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
