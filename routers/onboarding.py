"""Broker onboarding controls for WhatsApp groups.

This router deliberately keeps group selection separate from the ingestor's
directory discovery. WhatsMeow may know about every group on the phone, but
only groups explicitly connected here count toward onboarding caps and are
eligible for extraction once an organization has made its first selection.
"""

import asyncio
import json
import logging
import os
import re
from datetime import datetime, timezone
from threading import Lock

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from routers.common import (
    _normalize_real_phone,
    _require_org_permission,
    _resolve_active_organization_id,
    get_tenant_context,
    require_user,
    storage,
)

router = APIRouter(prefix="/api/onboarding", tags=["onboarding"])
_logger = logging.getLogger(__name__)

OVERLAP_WARNING_THRESHOLD = 0.60
SAMPLE_LIMIT = 200
GROUP_BACKFILL_PAGE_SIZE = 250

# Real estate broker pattern keywords for group name matching
REAL_ESTATE_KEYWORDS = [
    "real", "estate", "property", "realty", "broker", "rent", "sale", "buy",
    "lease", "flat", "apartment", "flat", "house", "villa", "plot", "land",
    "llp", "ltd", "developers", "group", "agency", "properties", "realty",
]

# BHK pattern regex (e.g., "2 BHK", "3 BHK", "1 RK", "Studio")
_BHK_PATTERN = re.compile(r'\b(\d+(?:\.\d+)?)\s*(?:bhk|rk|bedroom|b ed|b e d|studio)\b', re.IGNORECASE)

# Price pattern regex (e.g., "₹5 Cr", "4.5 L", "30 L", "₹2.75 L/month")
_PRICE_PATTERN = re.compile(r'₹\s*(\d+(?:\.\d+)?)\s*(?:cr|crore|l|lac|lakh|k|thousand)', re.IGNORECASE)

# Locality keywords for Mumbai
_LOCALITY_KEYWORDS = [
    "bandra", "andheri", "goregaon", "juhu", "powai", "khar", "chembur",
    "thane", "navi", "mumbai", "delhi", "bangalore", "bengaluru",
    "hyderabad", "pune", "chennai", "kolkata", "gurgaon", "gurugram",
    "noida", "vile parle", "santacruz", "vashi", "malad", "kandivali",
    "borivali", "parel", "worli", "dadar",
]


class GroupRequest(BaseModel):
    whatsapp_connection_id: int
    group_jid: str
    confirm_overlap: bool = False
    confirm_cap: bool = False


_ACTIVE_GROUP_BACKFILLS: set[tuple[str, int, str]] = set()
_ACTIVE_GROUP_BACKFILLS_LOCK = Lock()


def _claim_group_backfill(job_key: tuple[str, int, str]) -> bool:
    with _ACTIVE_GROUP_BACKFILLS_LOCK:
        if job_key in _ACTIVE_GROUP_BACKFILLS:
            return False
        _ACTIVE_GROUP_BACKFILLS.add(job_key)
        return True


def _release_group_backfill(job_key: tuple[str, int, str]) -> None:
    with _ACTIVE_GROUP_BACKFILLS_LOCK:
        _ACTIVE_GROUP_BACKFILLS.discard(job_key)


def _raw_row_value(row, key: str, default=None):
    if isinstance(row, dict):
        return row.get(key, default)
    return getattr(row, key, default)


def _row_payload(row) -> dict:
    payload = _raw_row_value(row, "raw_payload", {})
    if isinstance(payload, dict):
        return payload
    if isinstance(payload, str) and payload.strip():
        try:
            parsed = json.loads(payload)
            return parsed if isinstance(parsed, dict) else {}
        except (json.JSONDecodeError, TypeError):
            return {}
    return {}


def _matches_connected_group(row, group_jid: str, group_name: str) -> bool:
    payload = _row_payload(row)
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    key = data.get("key") if isinstance(data, dict) and isinstance(data.get("key"), dict) else {}
    remote_jid = key.get("remoteJid") or payload.get("remoteJid") or payload.get("from") or ""
    raw_group_name = str(_raw_row_value(row, "group_name", "") or "")
    if remote_jid and remote_jid == group_jid:
        return True
    if remote_jid:
        return False
    return raw_group_name == group_name or raw_group_name == group_jid


def _backfill_connected_group(org_id: str, group_jid: str, group_name: str, connection_id: int) -> dict:
    """Best-effort historical parse for a group that has just been connected."""
    job_key = (org_id, connection_id, group_jid)
    if not _claim_group_backfill(job_key):
        return {"requested": 0, "matched": 0, "processed": 0, "skipped": 0, "failed": 0, "already_running": True}

    from extraction import process_raw_message
    from extraction_worker import context_from_raw

    previous_tenant = storage.tenant_id
    storage.tenant_id = org_id

    requested = 0
    matched = 0
    processed = 0
    skipped = 0
    failed = 0
    offset = 0

    try:
        while True:
            rows = storage.get_raw_messages(
                limit=GROUP_BACKFILL_PAGE_SIZE,
                offset=offset,
                group_name=group_name,
            )
            if not rows:
                break
            requested += len(rows)
            offset += len(rows)

            for row in rows:
                if not _matches_connected_group(row, group_jid, group_name):
                    continue
                matched += 1
                raw_id = _raw_row_value(row, "id")
                if not raw_id:
                    continue
                try:
                    if storage.get_parsed_by_raw(int(raw_id)):
                        skipped += 1
                        continue
                except Exception:
                    failed += 1
                    _logger.exception(
                        "Group backfill lookup failed for org=%s connection=%s group=%s raw_id=%s",
                        org_id, connection_id, group_jid, raw_id,
                    )
                    continue

                ctx = context_from_raw(row)
                ctx["tenant_id"] = org_id
                try:
                    process_raw_message(int(raw_id), ctx, storage=storage)
                    processed += 1
                except Exception:
                    failed += 1
                    _logger.exception(
                        "Group backfill failed for org=%s connection=%s group=%s raw_id=%s",
                        org_id, connection_id, group_jid, raw_id,
                    )
    finally:
        storage.tenant_id = previous_tenant
        _release_group_backfill(job_key)

    return {
        "requested": requested,
        "matched": matched,
        "processed": processed,
        "skipped": skipped,
        "failed": failed,
        "already_running": False,
    }


async def _schedule_group_backfill(org_id: str, connection_id: int, group_jid: str, group_name: str) -> None:
    try:
        result = await asyncio.to_thread(_backfill_connected_group, org_id, group_jid, group_name, connection_id)
        _logger.info(
            "Scheduled group backfill finished for org=%s connection=%s group=%s: %s",
            org_id,
            connection_id,
            group_jid,
            result,
        )
    except Exception:
        _logger.exception(
            "Scheduled group backfill crashed for org=%s connection=%s group=%s",
            org_id,
            connection_id,
            group_jid,
        )


def _tier_cap(org: dict) -> tuple[str, int, bool]:
    override = org.get("group_cap_override")
    if override:
        return "custom", int(override), True

    allowlist = {
        item.strip().lower()
        for item in os.getenv("PROPAI_GROUP_CAP_ALLOWLIST", "").split(",")
        if item.strip()
    }
    identifiers = {
        str(org.get("id") or "").lower(),
        str(org.get("name") or "").lower(),
        str(org.get("slug") or "").lower(),
    }
    if allowlist.intersection(identifiers):
        return "allowlisted", 10_000, True

    tier = str(org.get("subscription_tier") or "starter").lower()
    return tier, {"starter": 5, "growth": 8, "scale": 15}.get(tier, 5), False


def _suggestion_score(
    org_id: str,
    group_name: str,
    participants: int,
    last_message_at: str | None,
    *,
    group_jid: str = "",
    include_content: bool = False,
) -> dict:
    """Compute a suggestion score and reasons for a WhatsApp group.
    
    Returns a dict with:
    - score: float between 0 and 1
    - reasons: list of human-readable reason strings
    """
    reasons = []
    score = 0.0
    
    # 1. Name-based signal: real estate keywords
    name_lower = group_name.lower()
    keyword_matches = [k for k in REAL_ESTATE_KEYWORDS if k in name_lower]
    if keyword_matches:
        score += 0.25
        reasons.append("Name matches real estate pattern")
    
    # 2. Activity signal: participants count (logarithmic scaling)
    if participants > 0:
        participant_score = min(0.25, participants / 1000)
        score += participant_score
        if participants >= 500:
            reasons.append(f"{participants:,} participants")
        elif participants >= 100:
            reasons.append(f"{participants} participants")
    
    # 3. Activity signal: recency of last_message_at
    if last_message_at:
        try:
            last_ts = datetime.fromisoformat(last_message_at.replace("Z", "+00:00"))
            now = datetime.now(timezone.utc)
            age_hours = (now - last_ts).total_seconds() / 3600
            
            if age_hours < 24:
                score += 0.2
                reasons.append("Active in last 24 hours")
            elif age_hours < 72:
                score += 0.15
                reasons.append("Active in last 3 days")
            elif age_hours < 168:
                score += 0.1
                reasons.append("Active in last week")
            elif age_hours < 720:
                score += 0.05
                reasons.append("Active recently")
        except Exception:
            pass
    
    # 4. Message content signal is intentionally opt-in.  This function is
    # called once per directory row; querying raw_messages for every one of
    # up to 1,000 groups creates an N+1 timeout on onboarding.  Directory
    # ranking must use the already-loaded metadata.  A future detail view can
    # request this richer signal for one selected group only.
    if include_content:
        try:
            recent_messages = []
            seen_ids = set()
            for identity in dict.fromkeys([group_name, group_jid]):
                if not identity:
                    continue
                rows = (
                    storage.client.table("raw_messages")
                    .select("id,message")
                    .eq("tenant_id", org_id)
                    .eq("group_name", identity)
                    .order("created_at", desc=True)
                    .limit(10)
                    .execute()
                    .data
                    or []
                )
                for row in rows:
                    if row.get("id") not in seen_ids:
                        seen_ids.add(row.get("id"))
                        recent_messages.append(row)
            recent_messages = recent_messages[:10]

            has_bhk = False
            has_price = False
            has_locality = False
            for msg_row in recent_messages:
                msg_text = msg_row.get("message") or ""
                has_bhk = has_bhk or bool(_BHK_PATTERN.search(msg_text))
                has_price = has_price or bool(_PRICE_PATTERN.search(msg_text))
                has_locality = has_locality or any(
                    loc in msg_text.lower() for loc in _LOCALITY_KEYWORDS
                )
                if has_bhk and has_price and has_locality:
                    break

            if has_bhk and has_price:
                score += 0.15
                reasons.append("Recent messages contain BHK/price patterns")
            elif has_bhk or has_price:
                score += 0.08
                if has_bhk:
                    reasons.append("Recent messages contain BHK patterns")
                if has_price:
                    reasons.append("Recent messages contain price patterns")
        except Exception:
            pass
    
    # 5. Broker overlap score (lazy - only for top candidates)
    # This is computed on-demand during the check flow, not here
    
    return {
        "score": round(score, 3),
        "reasons": reasons[:4],  # Max 4 reasons
    }


def _connection(org_id: str, connection_id: int) -> dict:
    rows = (
        storage.client.table("org_whatsapp_connections")
        .select("*")
        .eq("id", connection_id)
        .eq("organization_id", org_id)
        .limit(1)
        .execute()
        .data
        or []
    )
    if not rows:
        raise HTTPException(404, "WhatsApp connection not found")
    return rows[0]


def _group_directory(org_id: str, broker_id: str, connection_id: int) -> list[dict]:
    rows = (
        storage.client.table("whatsapp_conversations")
        .select("conversation_jid,display_name,metadata,last_message_at")
        .eq("tenant_id", org_id)
        .eq("broker_id", broker_id)
        .eq("conversation_type", "group")
        .order("display_name")
        .limit(1000)
        .execute()
        .data
        or []
    )
    connected = {
        row["group_jid"]
        for row in (
            storage.client.table("organization_group_connections")
            .select("group_jid")
            .eq("organization_id", org_id)
            .eq("whatsapp_connection_id", connection_id)
            .eq("is_active", True)
            .execute()
            .data
            or []
        )
    }
    
    # Compute suggestion scores for all groups
    scored_groups = []
    for row in rows:
        group_jid = row.get("conversation_jid") or ""
        group_name = row.get("display_name") or group_jid
        metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
        participants = metadata.get("participants", 0)
        last_message_at = row.get("last_message_at")
        is_connected = group_jid in connected
        
        # Compute suggestion score for unconnected groups
        suggestion = None
        if not is_connected:
            suggestion = _suggestion_score(
                org_id, group_name, participants, last_message_at, group_jid=group_jid
            )
        
        scored_groups.append({
            "group_jid": group_jid,
            "group_name": group_name,
            "participants": participants,
            "last_message_at": last_message_at,
            "connected": is_connected,
            "suggestion": suggestion,
        })
    
    # Rank recommendations first. Connected groups remain visible below them
    # so already-onboarded brokers can compare existing coverage with new reach.
    connected_groups = [g for g in scored_groups if g["connected"]]
    unconnected_groups = [g for g in scored_groups if not g["connected"]]
    unconnected_groups.sort(key=lambda g: g.get("suggestion", {}).get("score", 0), reverse=True)
    ranked = unconnected_groups + connected_groups
    _attach_directory_overlap(org_id, ranked)
    unconnected_groups = [g for g in ranked if not g["connected"]]
    connected_groups = [g for g in ranked if g["connected"]]
    unconnected_groups.sort(key=lambda g: g.get("suggestion", {}).get("score", 0), reverse=True)
    return unconnected_groups + connected_groups


def _sample_senders(org_id: str, group_name: str, group_jid: str = "") -> list[str]:
    rows = []
    for identity in dict.fromkeys([group_name, group_jid]):
        if not identity:
            continue
        rows.extend(
            storage.client.table("raw_messages")
            .select("sender_phone,sender_jid")
            .eq("tenant_id", org_id)
            .eq("group_name", identity)
            .order("created_at", desc=True)
            .limit(SAMPLE_LIMIT)
            .execute()
            .data
            or []
        )
    phones = set()
    for row in rows:
        phone = _normalize_real_phone(row.get("sender_phone"))
        if not phone:
            phone = _normalize_real_phone(row.get("sender_jid"))
        if phone:
            phones.add(phone)
    return sorted(phones)


def _overlap(org_id: str, group_name: str, group_jid: str = "") -> dict:
    sample = _sample_senders(org_id, group_name, group_jid)
    known = set()
    if sample:
        known_rows = (
            storage.client.table("network_broker_registry")
            .select("broker_phone")
            .in_("broker_phone", sample)
            .execute()
            .data
            or []
        )
        known = {row.get("broker_phone") for row in known_rows}
    score = len(known) / len(sample) if sample else 0.0
    return {
        "sample_count": len(sample),
        "shared_count": len(known),
        "overlap_score": round(score, 5),
        "high_overlap": bool(sample) and score >= OVERLAP_WARNING_THRESHOLD,
        "sample_phones": sample,
    }


def _attach_directory_overlap(org_id: str, groups: list[dict], limit: int = 20) -> None:
    """Add duplicate/new-reach signals without scanning every directory row."""
    candidates = [group for group in groups if group["connected"]]
    candidates += [group for group in groups if not group["connected"]][:limit]
    for group in candidates:
        try:
            overlap = _overlap(org_id, group["group_name"], group.get("group_jid", ""))
        except Exception:
            continue
        score = overlap["overlap_score"]
        if not overlap["sample_count"]:
            status = "unknown"
        elif score >= OVERLAP_WARNING_THRESHOLD:
            status = "high_overlap"
        elif score >= 0.30:
            status = "moderate_overlap"
        else:
            status = "new_reach"
        group.update({
            "overlap_score": score,
            "overlap_sample_count": overlap["sample_count"],
            "overlap_shared_count": overlap["shared_count"],
            "overlap_status": status,
        })
        if not group["connected"] and group.get("suggestion"):
            group["suggestion"] = _suggestion_score(
                org_id,
                group["group_name"],
                group.get("participants", 0),
                group.get("last_message_at"),
                group_jid=group.get("group_jid", ""),
                include_content=True,
            )
            suggestion = group["suggestion"]
            if status == "high_overlap":
                suggestion["score"] = round(max(0.0, suggestion["score"] - 0.20), 3)
                suggestion["reasons"] = [
                    "High duplicate overlap with existing broker network",
                    *suggestion["reasons"],
                ][:4]
            elif status == "new_reach":
                suggestion["score"] = round(min(1.0, suggestion["score"] + 0.10), 3)
                suggestion["reasons"] = [
                    "Low overlap — likely new broker reach",
                    *suggestion["reasons"],
                ][:4]


def _upsert_registry(org_id: str, group_jid: str, phones: list[str]) -> None:
    now = datetime.now(timezone.utc).isoformat()
    for phone in phones:
        storage.client.table("network_broker_registry").upsert({
            "broker_phone": phone,
            "last_seen_at": now,
            "updated_at": now,
        }, on_conflict="broker_phone").execute()
        storage.client.table("network_broker_group_presence").upsert({
            "broker_phone": phone,
            "organization_id": org_id,
            "group_jid": group_jid,
            "last_seen_at": now,
            "source": "onboarding_sample",
        }, on_conflict="broker_phone,organization_id,group_jid").execute()

        presence = (
            storage.client.table("network_broker_group_presence")
            .select("organization_id,group_jid")
            .eq("broker_phone", phone)
            .execute()
            .data
            or []
        )
        tenants = {row.get("organization_id") for row in presence}
        groups = {(row.get("organization_id"), row.get("group_jid")) for row in presence}
        storage.client.table("network_broker_registry").update({
            "tenant_count": len(tenants),
            "group_count": len(groups),
            "confidence": min(1.0, len(groups) / 5),
            "last_seen_at": now,
            "updated_at": now,
        }).eq("broker_phone", phone).execute()


def _cap_state(org_id: str, connection_id: int) -> dict:
    """Opt-out model: the cap is the number of groups the broker has excluded from
    extraction on this WhatsApp connection. Extracting groups are uncapped."""
    org = storage.get_organization(org_id) or {"id": org_id}
    tier, cap, overridden = _tier_cap(org)
    rows = (
        storage.client.table("organization_group_connections")
        .select("id", count="exact")
        .eq("organization_id", org_id)
        .eq("whatsapp_connection_id", connection_id)
        .eq("opted_out", True)
        .execute()
    )
    count = int(getattr(rows, "count", None) or len(rows.data or []))
    return {
        "tier": tier,
        "cap": cap,
        "opted_out_count": count,
        "remaining": max(0, cap - count),
        "overridden": overridden,
        "soft_warning_at_cap": not overridden and count >= cap,
        "hard_block": not overridden and count >= cap * 2,
    }


def extraction_allowed_for_group(org_id: str, group_jid: str, group_name: str) -> bool:
    """Default-on semantics: every connected WhatsApp group is eligible for
    extraction unless the broker tenant has explicitly opted it out. Only an
    explicit `opted_out=true` row on (org, group_jid) suppresses extraction;
    a fallback to `group_name` covers older raw records whose JID was not
    preserved."""
    opted_out = (
        storage.client.table("organization_group_connections")
        .select("id")
        .eq("organization_id", org_id)
        .eq("group_jid", group_jid)
        .eq("opted_out", True)
        .limit(1)
        .execute()
        .data
        or []
    )
    if opted_out:
        return False
    return not bool(
        storage.client.table("organization_group_connections")
        .select("id")
        .eq("organization_id", org_id)
        .eq("group_name", group_name)
        .eq("opted_out", True)
        .limit(1)
        .execute()
        .data
    )


@router.get("/group-cap")
async def group_cap(
    whatsapp_connection_id: int,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    org_id = _resolve_active_organization_id(user, tenant_id)
    await _require_org_permission(user, org_id, "manage_whatsapp")
    _connection(org_id, whatsapp_connection_id)
    return _cap_state(org_id, whatsapp_connection_id)


@router.get("/groups")
async def onboarding_groups(
    whatsapp_connection_id: int,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    org_id = _resolve_active_organization_id(user, tenant_id)
    await _require_org_permission(user, org_id, "manage_whatsapp")
    connection = _connection(org_id, whatsapp_connection_id)
    return {"groups": _group_directory(org_id, str(connection.get("broker_id") or ""), whatsapp_connection_id), **_cap_state(org_id, whatsapp_connection_id)}


@router.post("/groups/check")
async def check_group(
    body: GroupRequest,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    org_id = _resolve_active_organization_id(user, tenant_id)
    await _require_org_permission(user, org_id, "manage_whatsapp")
    connection = _connection(org_id, body.whatsapp_connection_id)
    groups = _group_directory(org_id, str(connection.get("broker_id") or ""), body.whatsapp_connection_id)
    group = next((item for item in groups if item["group_jid"] == body.group_jid), None)
    if not group:
        raise HTTPException(404, "Group is not available on this WhatsApp connection")
    overlap = _overlap(org_id, group["group_name"], group["group_jid"])
    return {"group": group, **overlap, "threshold": OVERLAP_WARNING_THRESHOLD, "cap": _cap_state(org_id, body.whatsapp_connection_id)}


@router.post("/groups/connect")
async def connect_group(
    body: GroupRequest,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    """Deprecated: opt-in model has been replaced by opt-out. Kept as a 410-style
    no-op for one release so any stale cache/client surface returns a clear
    explanation instead of a 404."""
    raise HTTPException(
        status_code=410,
        detail="Group connection is no longer supported. Every connected WhatsApp group is now extracted by default; use POST /api/onboarding/groups/opt-out to suppress a group.",
    )


@router.post("/groups/opt-out")
async def opt_out_group(
    body: GroupRequest,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    """Mark a WhatsApp group as opted-out from extraction. Default is all groups
    eligible; this endpoint only creates a suppression row capped at the tenant
    subscription tier."""
    try:
        org_id = _resolve_active_organization_id(user, tenant_id)
        await _require_org_permission(user, org_id, "manage_whatsapp")
        connection = _connection(org_id, body.whatsapp_connection_id)
        groups = _group_directory(org_id, str(connection.get("broker_id") or ""), body.whatsapp_connection_id)
        group = next((item for item in groups if item["group_jid"] == body.group_jid), None)
        if not group:
            raise HTTPException(404, "Group is not available on this WhatsApp connection")

        cap = _cap_state(org_id, body.whatsapp_connection_id)
        overlap = _overlap(org_id, group["group_name"], group["group_jid"])
        warnings = []
        if cap["soft_warning_at_cap"] and not body.confirm_cap:
            warnings.append("You are at the default tier cap for opted-out groups on this connection.")
        if cap["hard_block"]:
            return JSONResponse(status_code=409, content={"message": "Opted-out cap reached on this WhatsApp connection.", "hard_block": True, "cap": cap, "overlap": overlap})
        if warnings:
            return JSONResponse(status_code=409, content={"message": "Confirmation required before opting out.", "warnings": warnings, "cap": cap, "overlap": overlap, "requires_confirmation": True})

        now = datetime.now(timezone.utc).isoformat()
        row = storage.client.table("organization_group_connections").upsert({
            "organization_id": org_id,
            "whatsapp_connection_id": body.whatsapp_connection_id,
            "group_jid": body.group_jid,
            "group_name": group["group_name"],
            "opted_out": True,
            "is_active": False,
            "updated_at": now,
            "connected_at": now,
        }, on_conflict="organization_id,whatsapp_connection_id,group_jid").execute()
        return {
            "ok": True,
            "group": group,
            "connection": (row.data or [None])[0],
            "cap": _cap_state(org_id, body.whatsapp_connection_id),
            "overlap": overlap,
            "opted_out": True,
        }
    except HTTPException:
        raise
    except Exception:
        _logger.exception("opt_out_group crashed for org=%s connection=%s group=%s", org_id, body.whatsapp_connection_id, body.group_jid)
        raise


@router.post("/groups/opt-in")
async def opt_in_group(
    body: GroupRequest,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    """Clear an opt-out suppression. The group returns to the default extract-everything state."""
    org_id = _resolve_active_organization_id(user, tenant_id)
    await _require_org_permission(user, org_id, "manage_whatsapp")
    _connection(org_id, body.whatsapp_connection_id)
    result = (
        storage.client.table("organization_group_connections")
        .update({"opted_out": False, "is_active": False, "updated_at": datetime.now(timezone.utc).isoformat()})
        .eq("organization_id", org_id)
        .eq("whatsapp_connection_id", body.whatsapp_connection_id)
        .eq("group_jid", body.group_jid)
        .eq("opted_out", True)
        .execute()
    )
    if not result.data:
        raise HTTPException(404, "Opted-out group not found")
    return {"ok": True, "message": "Group re-enabled for extraction", "cap": _cap_state(org_id, body.whatsapp_connection_id)}
