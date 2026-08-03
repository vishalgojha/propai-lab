"""Audit routes."""
import json
import re
from datetime import datetime, timedelta, timezone
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from routers.common import storage, require_user, require_tenant
from lab import ai_chat_engine as chat_engine

router = APIRouter(tags=["audit"])

# Placeholder names populated by app.py after helper definitions.
_group_jid_to_name = None
_table_exists = None
_audit_rows = None
_audit_row_value = None
_audit_scalar = None
_audit_count = None
_audit_timestamp = None
_audit_group_display_name = None
_audit_buildings_for_group = None
_clean_audit_building_name = None
_AUDIT_BUILDING_LABEL_PATTERN = None
_AUDIT_BUILDING_PLACEHOLDERS = None
_count_table = None
parse_group_name = None


class SearchCoverageRequest(BaseModel):
    query: str
    response: dict | None = None
    source_mode: str = "parsed"


def _rendered_listing_ids(response: dict | None) -> list[str]:
    blocks = (response or {}).get("blocks") or []
    listing_ids: list[str] = []
    for block in blocks:
        if not isinstance(block, dict) or block.get("type") != "listing_cards":
            continue
        for item in block.get("items") or []:
            if not isinstance(item, dict):
                continue
            for field in ("listing_id", "message_id", "cluster_id", "raw_message_id", "whatsapp_message_id"):
                value = item.get(field)
                if value is not None and str(value).strip():
                    listing_ids.append(str(value))
                    break
    return listing_ids


def _expected_listing_ids_for_query(query: str, tenant_id: str) -> tuple[dict | None, list[str]]:
    parsed = chat_engine.parse_market_search_request(
        query,
        api_key="",
        model="",
        base_url="",
        db_path=getattr(storage, "db", None),
        allow_llm=False,
    )
    if not parsed:
        return None, []

    expected_raw = chat_engine.execute_tool(
        "market_search",
        parsed,
        {},
        db_path=getattr(storage, "db", None),
        tenant_id=tenant_id,
    )
    try:
        expected_payload = json.loads(expected_raw)
    except Exception:
        return parsed, []

    expected_ids: list[str] = []
    for row in expected_payload.get("results") or []:
        if not isinstance(row, dict):
            continue
        for field in ("listing_id", "message_id", "cluster_id", "raw_message_id", "whatsapp_message_id"):
            value = row.get(field)
            if value is not None and str(value).strip():
                expected_ids.append(str(value))
                break
    return parsed, expected_ids


@router.post("/api/audit/search-coverage")
def audit_search_coverage(
    payload: SearchCoverageRequest,
    user: dict = Depends(require_user),
    tenant_id: str = Depends(require_tenant),
):
    """Compare an agent response against the database truth for a search query."""
    parsed, expected_ids = _expected_listing_ids_for_query(payload.query, tenant_id)
    if not parsed:
        return {
            "auditable": False,
            "reason": "query_not_parseable",
            "query": payload.query,
            "source_mode": payload.source_mode,
            "rendered_count": len(_rendered_listing_ids(payload.response)),
            "expected_count": 0,
            "complete": False,
            "missing_ids": [],
            "extra_ids": [],
        }

    rendered_ids = _rendered_listing_ids(payload.response)
    expected_set = set(expected_ids)
    rendered_set = set(rendered_ids)
    missing_ids = [listing_id for listing_id in expected_ids if listing_id not in rendered_set]
    extra_ids = [listing_id for listing_id in rendered_ids if listing_id not in expected_set]
    complete = not missing_ids and not extra_ids
    coverage_pct = round((len(rendered_set & expected_set) / max(1, len(expected_set))) * 100, 1) if expected_set else 100.0

    return {
        "auditable": True,
        "query": payload.query,
        "source_mode": payload.source_mode,
        "parsed": parsed,
        "expected_count": len(expected_ids),
        "rendered_count": len(rendered_ids),
        "coverage_pct": coverage_pct,
        "complete": complete,
        "missing_count": len(missing_ids),
        "extra_count": len(extra_ids),
        "missing_ids": missing_ids[:50],
        "extra_ids": extra_ids[:50],
    }


@router.get("/api/audit/dashboard")
async def audit_dashboard(user: dict = Depends(require_user)):
    now = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    today_start = datetime.utcnow().strftime("%Y-%m-%dT00:00:00Z")
    five_min_ago = (datetime.utcnow() - timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%SZ")
    day_ago = (datetime.utcnow() - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ")

    def _scalar(sql: str, params=(), default=0):
        try:
            row = storage.db.execute(sql, params).fetchone()
            if row is None:
                return default
            return row[0]
        except Exception:
            return default

    total_groups = _scalar("SELECT COUNT(DISTINCT group_name) FROM raw_messages")
    live_groups = _scalar("SELECT COUNT(DISTINCT group_name) FROM raw_messages WHERE created_at >= ?", (five_min_ago,))
    msgs_today = _scalar("SELECT COUNT(*) FROM raw_messages WHERE created_at >= ?", (today_start,))
    last_msg = _scalar("SELECT MAX(created_at) FROM raw_messages", default=None)

    duplicate_groups = _scalar("""
        SELECT COUNT(*) FROM (
            SELECT group_name FROM raw_messages
            WHERE group_name IS NOT NULL AND group_name != ''
            GROUP BY group_name
            HAVING COUNT(*) > 1
        )
    """)

    inactive_count = _scalar("""
        SELECT COUNT(*) FROM (
            SELECT group_name FROM raw_messages
            GROUP BY group_name
            HAVING MAX(created_at) < ?
        )
    """, (day_ago,))

    unnamed_count = _scalar("""
        SELECT COUNT(DISTINCT group_name) FROM raw_messages
        WHERE group_name IS NULL OR group_name = ''
    """)
    error_groups = 0

    attention_required = error_groups + inactive_count
    attention_breakdown = {
        "inactive": inactive_count,
        "duplicate": duplicate_groups,
        "unnamed": unnamed_count,
        "error": error_groups,
    }

    groups_discovered = total_groups
    groups_monitored = total_groups

    # Webhook healthy
    webhook_ok = last_msg is not None and last_msg >= five_min_ago

    # Capture health metrics
    failed_events = 0
    pending_enrichment = 0
    pending_ai = 0
    avg_process = None

    # Messages per minute today
    msgs_per_min = msgs_today / max(1, (datetime.utcnow().hour * 60 + datetime.utcnow().minute))

    # Parser success rate
    total_parsed_today = storage.db.execute(
        "SELECT COUNT(*) FROM typed_parsed_output WHERE created_at >= ?", (today_start,)
    ).fetchone()[0]
    parser_success_rate = round((total_parsed_today / max(1, msgs_today)) * 100, 1) if msgs_today > 0 else 0

    return {
        # New header structure
        "whatsapp_session": "connected",  # would need actual session check
        "webhook_status": "live" if webhook_ok else "offline",
        "groups_discovered": groups_discovered,
        "groups_monitored": groups_monitored,
        "total_groups": total_groups,
        "live_groups": live_groups,
        "msgs_today": msgs_today,
        "last_webhook": last_msg or "never",
        "webhook_healthy": webhook_ok,
        "error_groups": error_groups,
        "duplicate_groups": duplicate_groups,
        "attention_required": attention_required,
        "attention_breakdown": attention_breakdown,
        "inactive_groups": inactive_count,
        "unnamed_groups": unnamed_count,
        "failed_events": failed_events,
        "pending_enrichment": pending_enrichment,
        "pending_ai_suggestions": pending_ai,
        "avg_process_secs": round(avg_process, 1) if avg_process else None,
        # New capture health metrics
        "msgs_per_min": round(msgs_per_min, 1),
        "parser_success_rate": parser_success_rate,
        "queue_backlog": pending_enrichment,
    }


@router.get("/api/audit/timeline")
async def audit_timeline(limit: int = 50, user: dict = Depends(require_user)):
    """Mixed operational events across the WhatsApp pipeline."""
    events = []
    day_ago = (datetime.utcnow() - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ")

    # Recent webhook messages (sample, not every message)
    raw_rows = storage.db.execute("""
        SELECT 'webhook' as source, created_at as ts, 'message' as subtype,
               group_name as group_jid, sender,
               'Message from ' || sender as label
        FROM raw_messages
        WHERE created_at >= ?
        ORDER BY created_at DESC
        LIMIT 20
    """, (day_ago,)).fetchall()
    for r in raw_rows:
        d = dict(r)
        d["ts"] = d.pop("ts")
        d["group_name"] = _group_jid_to_name(d.pop("group_jid"))
        events.append(d)

    # New groups discovered (first message from a new JID)
    new_group_rows = storage.db.execute("""
        SELECT 'group' as source, MIN(created_at) as ts, 'discovered' as subtype,
               group_name as group_jid, sender,
               'New group discovered' as label
        FROM raw_messages
        WHERE created_at >= ?
        GROUP BY group_name
        ORDER BY MIN(created_at) DESC
        LIMIT 10
    """, (day_ago,)).fetchall()
    for r in new_group_rows:
        d = dict(r)
        d["ts"] = d.pop("ts")
        d["group_name"] = _group_jid_to_name(d.pop("group_jid"))
        events.append(d)

    # Group renamed (groups with multiple display names)
    renamed_rows = storage.db.execute("""
        SELECT 'group' as source, MAX(updated_at) as ts, 'renamed' as subtype,
               group_id as group_jid, group_name,
               'Group renamed: ' || group_name as label
        FROM source_sync_jobs
        WHERE group_name != '' AND group_id IS NOT NULL
        GROUP BY group_id
        HAVING COUNT(DISTINCT group_name) > 1
        ORDER BY MAX(updated_at) DESC
        LIMIT 5
    """).fetchall()
    for r in renamed_rows:
        d = dict(r)
        d["ts"] = d.pop("ts")
        d["group_name"] = d.pop("group_name")
        events.append(d)

    # Duplicate group detected
    dupe_rows = storage.db.execute("""
        SELECT 'duplicate' as source, sj.updated_at as ts, 'detected' as subtype,
               sj.group_id as group_jid, sj.group_name,
               'Duplicate group detected: ' || sj.group_name as label
        FROM source_sync_jobs sj
        WHERE sj.group_name IN (
            SELECT group_name FROM source_sync_jobs
            WHERE group_name != '' AND group_name IS NOT NULL
            GROUP BY group_name HAVING COUNT(*) > 1
        )
        ORDER BY sj.updated_at DESC
        LIMIT 5
    """).fetchall()
    for r in dupe_rows:
        d = dict(r)
        d["ts"] = d.pop("ts")
        d["group_name"] = _group_jid_to_name(d.pop("group_jid"))
        events.append(d)

    # Enrichment events
    enrich_rows = storage.db.execute("""
        SELECT 'enrichment' as source, ej.created_at as ts, ej.status as subtype,
               CASE WHEN ej.status = 'completed' THEN 'Building/location enrichment completed'
                    WHEN ej.status = 'failed' THEN 'Enrichment failed: ' || ej.last_error
                    ELSE 'Enrichment job created' END as label,
               ej.parsed_id as ref
        FROM enrichment_jobs ej ORDER BY ej.created_at DESC LIMIT 15
    """).fetchall()
    for r in enrich_rows:
        events.append(dict(r))

    # AI suggestion events
    sug_rows = storage.db.execute("""
        SELECT 'suggestion' as source, created_at as ts, status as subtype,
               agent, title
        FROM ai_suggestions ORDER BY created_at DESC LIMIT 10
    """).fetchall()
    for r in sug_rows:
        d = dict(r)
        agent = d.pop("agent", "")
        title = d.pop("title", "")
        if agent == "building":
            d["label"] = "AI suggested building: " + title
        elif agent == "location":
            d["label"] = "AI suggested location: " + title
        elif agent == "alias":
            d["label"] = "AI learned alias: " + title
        elif agent == "duplicate_listing":
            d["label"] = "Duplicate listing detected: " + title
        else:
            d["label"] = "AI " + agent + ": " + title
        events.append(d)

    # Parser restarts (enrichment worker cycles)
    restart_rows = storage.db.execute("""
        SELECT 'system' as source, created_at as ts, 'restart' as subtype,
               'Parser/enrichment worker restarted' as label
        FROM enrichment_jobs
        WHERE status = 'pending' AND attempts = 0
        ORDER BY created_at DESC LIMIT 3
    """).fetchall()
    for r in restart_rows:
        events.append(dict(r))

    # Live capture status changes (approximate from message gaps)
    # Sort by time descending, take top N
    events.sort(key=lambda e: e.get("ts", ""), reverse=True)
    return events[:limit]


@router.get("/api/audit/top-contributors")
async def audit_top_contributors(limit: int = 10, user: dict = Depends(require_user)):
    """Top WhatsApp groups by message volume today."""
    today_start = datetime.utcnow().strftime("%Y-%m-%dT00:00:00Z")

    rows = storage.db.execute("""
        SELECT group_name, COUNT(*) as msg_count,
               COUNT(DISTINCT sender) as unique_senders,
               MAX(created_at) as last_msg
        FROM raw_messages
        WHERE created_at >= ?
        GROUP BY group_name
        ORDER BY msg_count DESC
        LIMIT ?
    """, (today_start, limit)).fetchall()

    result = []
    for r in rows:
        d = dict(r)
        d["group_name"] = _group_jid_to_name(d["group_name"])
        d["last_msg"] = d["last_msg"] or "never"
        result.append(d)
    return result


@router.get("/api/audit/groups")
def audit_groups_v2(
    q: str = "",
    status: str = "",
    user: dict = Depends(require_user),
    tenant_id: str = Depends(require_tenant),
):
    """Fresh group audit backed by raw_messages and typed parsed observations.

    Uses SQL aggregation instead of fetching all rows into Python.
    Returns ~163 rows (one per group) instead of 400K+ rows.
    """
    day_ago = (datetime.utcnow() - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ")
    query = (q or "").strip().lower()

    if not _table_exists("raw_messages"):
        return {
            "groups": [],
            "total_unique_senders": 0,
            "total_unique_participants": 0,
            "total_membership_rows": 0,
            "duplicate_memberships": 0,
            "connected_groups": 0,
            "posting_groups_24h": 0,
            "errors": [],
        }

    has_parsed = _table_exists("typed_parsed_output")
    has_group_members = _table_exists("group_members")
    has_sync_jobs = _table_exists("sync_jobs")
    errors: list[str] = []

    # ── Query 1: aggregate raw_messages by group_name ──
    try:
        rm_rows = _audit_rows(
            "SELECT group_name, COUNT(*) AS messages, "
            "COUNT(DISTINCT sender) AS senders_count, "
            "MAX(created_at) AS last_activity "
            "FROM raw_messages "
            "WHERE tenant_id = ? AND group_name IS NOT NULL AND group_name != '' "
            "GROUP BY group_name",
            (tenant_id,),
        )
    except Exception as exc:
        errors.append(f"raw_messages aggregate failed: {exc}")
        rm_rows = []

    stats: dict[str, dict] = {}
    for row in rm_rows:
        # Supabase's SQL bridge serializes rows through JSONB. JSON object key
        # order is not a SQL column-order contract, so always read by alias.
        gn = _audit_row_value(row, ("group_name", 0), "") or ""
        if not gn:
            continue
        stats[gn] = {
            "messages": int(_audit_row_value(row, ("messages", 1), 0) or 0),
            "senders_count": int(_audit_row_value(row, ("senders_count", 2), 0) or 0),
            "last_activity": _audit_row_value(row, ("last_activity", 3), "") or "",
            "observations": 0, "requirements": 0, "listings": 0,
            "markets_count": 0, "unknown_locations": 0, "identities_count": 0,
        }

    # ── Query 2: aggregate typed parsed observations by group_name ──
    if has_parsed and stats:
        try:
            po_rows = _audit_rows(
                "SELECT rm.group_name, "
                "COUNT(DISTINCT rm.id) AS observations, "
                "COUNT(DISTINCT CASE WHEN UPPER(po.intent) IN ('BUY','BUYER','REQUIREMENT','RENTAL_SEEKER','TENANT') THEN (po.raw_message_id::text || ':' || COALESCE(po.listing_index, 0)::text) END) AS requirements, "
                "COUNT(DISTINCT CASE WHEN po.id IS NOT NULL AND UPPER(po.intent) NOT IN ('BUY','BUYER','REQUIREMENT','RENTAL_SEEKER','TENANT') THEN (po.raw_message_id::text || ':' || COALESCE(po.listing_index, 0)::text) END) AS listings, "
                "COUNT(DISTINCT CASE WHEN po.micro_market IS NOT NULL AND po.micro_market != '' THEN po.micro_market END) AS markets_count, "
                "COUNT(DISTINCT CASE WHEN (po.location_raw IS NOT NULL AND po.location_raw != '') AND (po.micro_market IS NULL OR po.micro_market = '') THEN (po.raw_message_id::text || ':' || COALESCE(po.listing_index, 0)::text) END) AS unknown_locations, "
                "COUNT(DISTINCT COALESCE(NULLIF(po.broker_name, ''), NULLIF(po.profile_name, ''), NULLIF(rm.sender, ''))) AS identities "
                "FROM typed_parsed_output po "
                "JOIN raw_messages rm ON po.raw_message_id = rm.id "
                "WHERE rm.tenant_id = ? AND rm.group_name IS NOT NULL AND rm.group_name != '' "
                "GROUP BY rm.group_name",
                (tenant_id,),
            )
            for row in po_rows:
                gn = _audit_row_value(row, ("group_name", 0), "") or ""
                if gn not in stats:
                    continue
                g = stats[gn]
                g["observations"] = int(_audit_row_value(row, ("observations", 1), 0) or 0)
                g["requirements"] = int(_audit_row_value(row, ("requirements", 2), 0) or 0)
                g["listings"] = int(_audit_row_value(row, ("listings", 3), 0) or 0)
                g["markets_count"] = int(_audit_row_value(row, ("markets_count", 4), 0) or 0)
                g["unknown_locations"] = int(_audit_row_value(row, ("unknown_locations", 5), 0) or 0)
                g["identities_count"] = int(_audit_row_value(row, ("identities", 6), 0) or 0)
        except Exception as exc:
            errors.append(f"parsed_output aggregate failed: {exc}")

    # ── Query 3: total unique senders across all groups ──
    # Use resolved identities (broker_name > profile_name > sender) to match
    # per-group identities_count and avoid raw JID inflation / deflation.
    total_unique_senders = 0
    try:
        if has_parsed:
            sender_row = _audit_rows(
                "SELECT COUNT(DISTINCT COALESCE(NULLIF(po.broker_name, ''), "
                "NULLIF(po.profile_name, ''), NULLIF(rm.sender, ''))) "
                "AS total_unique_senders "
                "FROM typed_parsed_output po "
                "JOIN raw_messages rm ON po.raw_message_id = rm.id "
                "WHERE rm.tenant_id = ? AND rm.group_name IS NOT NULL AND rm.group_name != ''",
                (tenant_id,),
            )
        else:
            sender_row = _audit_rows(
                "SELECT COUNT(DISTINCT sender) AS total_unique_senders FROM raw_messages "
                "WHERE tenant_id = ? AND group_name IS NOT NULL AND group_name != ''",
                (tenant_id,),
            )
        if sender_row:
            total_unique_senders = int(
                _audit_row_value(sender_row[0], ("total_unique_senders", 0), 0) or 0
            )
    except Exception:
        pass

    total_membership_rows = 0
    total_unique_participants = 0
    duplicate_memberships = 0
    connected_groups = 0
    if has_group_members:
        try:
            member_row = _audit_rows(
                "SELECT COUNT(*) AS total_membership_rows, "
                "COUNT(DISTINCT COALESCE(NULLIF(member_phone, ''), NULLIF(member_jid, ''))) AS total_unique_participants, "
                "COUNT(DISTINCT group_id) AS connected_groups "
                "FROM group_members "
                "WHERE tenant_id = ?",
                (tenant_id,),
            )
            if member_row:
                total_membership_rows = int(_audit_row_value(member_row[0], ("total_membership_rows", 0), 0) or 0)
                total_unique_participants = int(_audit_row_value(member_row[0], ("total_unique_participants", 1), 0) or 0)
                connected_groups = int(_audit_row_value(member_row[0], ("connected_groups", 2), 0) or 0)
                duplicate_memberships = max(0, total_membership_rows - total_unique_participants)
        except Exception as exc:
            errors.append(f"group_members aggregate failed: {exc}")
    elif has_sync_jobs:
        try:
            sync_row = _audit_rows(
                "SELECT COUNT(DISTINCT group_id) AS connected_groups, "
                "COALESCE(SUM(participants), 0) AS total_membership_rows "
                "FROM sync_jobs "
                "WHERE source = ? AND group_id IS NOT NULL AND group_id != ''",
                ("whatsapp",),
            )
            if sync_row:
                connected_groups = int(_audit_row_value(sync_row[0], ("connected_groups", 0), 0) or 0)
                total_membership_rows = int(_audit_row_value(sync_row[0], ("total_membership_rows", 1), 0) or 0)
        except Exception:
            pass
    # Fallback: compute unique participants from raw_messages when group_members is absent
    if not has_group_members and not total_unique_participants:
        try:
            up_row = _audit_rows(
                "SELECT COUNT(DISTINCT sender) AS total_unique_participants FROM raw_messages "
                "WHERE tenant_id = ? AND group_name IS NOT NULL AND group_name != ''",
                (tenant_id,),
            )
            if up_row:
                total_unique_participants = int(
                    _audit_row_value(up_row[0], ("total_unique_participants", 0), 0) or 0
                )
                if not duplicate_memberships and total_membership_rows > total_unique_participants:
                    duplicate_memberships = total_membership_rows - total_unique_participants
        except Exception:
            pass

    groups = []
    for gn, g in stats.items():
        name = _audit_group_display_name(gn)
        messages = g["messages"]
        last_activity = _audit_timestamp(g["last_activity"])
        observations = g["observations"]
        unknown_locations = g["unknown_locations"]
        is_live = bool(last_activity and last_activity >= day_ago)
        coverage = round(((observations - unknown_locations) / max(1, observations)) * 100, 1) if observations else 0
        group_status = "live" if is_live else "inactive"
        health = "healthy" if is_live and unknown_locations == 0 else ("degraded" if is_live else "stale")

        if query and query not in name.lower() and query not in gn.lower():
            continue
        if status == "live" and group_status != "live":
            continue
        if status == "inactive" and group_status != "inactive":
            continue
        if status == "error":
            continue

        groups.append({
            "jid": gn,
            "name": name,
            "status": group_status,
            "health": health,
            "error": "",
            "messages": messages,
            "last_activity": last_activity,
            "observations": observations,
            "listings": g["listings"],
            "requirements": g["requirements"],
            "markets_count": g["markets_count"],
            "unknown_locations": unknown_locations,
            "coverage": coverage,
            "active_brokers": g["identities_count"],
            "senders_count": g["senders_count"],
            "duplicate_pct": 0,
            "parsed": parse_group_name(name),
        })

    posting_groups_24h = sum(1 for group in groups if group["status"] == "live")

    return {
        "groups": groups,
        "total_unique_senders": total_unique_senders,
        "total_unique_participants": total_unique_participants,
        "total_membership_rows": total_membership_rows,
        "duplicate_memberships": duplicate_memberships,
        "connected_groups": connected_groups,
        "posting_groups_24h": posting_groups_24h,
        "errors": errors,
    }


@router.get("/api/audit/groups/{jid}")
async def audit_group_detail(
    jid: str,
    user: dict = Depends(require_user),
    tenant_id: str = Depends(require_tenant),
):
    group_name = _group_jid_to_name(jid)
    lookup_values = (tenant_id, jid, group_name)

    # Raw stats
    raw_info = storage.db.execute("""
        SELECT COUNT(*) as msg_count, MIN(created_at) as first_seen,
               MAX(created_at) as last_seen
        FROM raw_messages
        WHERE tenant_id = ? AND (group_name = ? OR group_name = ?)
    """, lookup_values).fetchone()

    # Observation stats
    obs_rows = storage.db.execute("""
        SELECT p.id, p.intent, p.broker_name, p.building_name, p.micro_market,
               p.bhk, p.price, p.price_unit, p.confidence, r.message, r.timestamp
        FROM typed_parsed_output p
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE r.tenant_id = ? AND (r.group_name = ? OR r.group_name = ?)
        ORDER BY r.created_at DESC LIMIT 50
    """, lookup_values).fetchall()

    # Brokers seen
    broker_count = storage.db.execute("""
        SELECT COUNT(DISTINCT p.broker_name) FROM typed_parsed_output p
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE r.tenant_id = ? AND (r.group_name = ? OR r.group_name = ?)
          AND p.broker_name IS NOT NULL AND p.broker_name != ''
    """, lookup_values).fetchone()[0]

    # Markets seen
    markets = storage.db.execute("""
        SELECT DISTINCT p.micro_market FROM typed_parsed_output p
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE r.tenant_id = ? AND (r.group_name = ? OR r.group_name = ?)
          AND p.micro_market IS NOT NULL AND p.micro_market != ''
        ORDER BY p.micro_market
    """, lookup_values).fetchall()

    # Buildings mentioned — use explicit source labels, not parser guesses.
    buildings = _audit_buildings_for_group(tenant_id, jid, group_name)

    # AI suggestions for this group
    suggestions = storage.db.execute("""
        SELECT s.id, s.agent, s.title, s.description, s.status, s.confidence, s.created_at
        FROM ai_suggestions s
        WHERE s.tenant_id = ?
        ORDER BY s.created_at DESC LIMIT 20
    """, (tenant_id,)).fetchall()

    # Resolver quality
    resolved = storage.db.execute("""
        SELECT COUNT(*) FROM resolver_decisions rd
        JOIN typed_parsed_output p ON p.id = rd.parsed_id
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE r.tenant_id = ? AND (r.group_name = ? OR r.group_name = ?)
          AND rd.method != 'unresolved'
    """, lookup_values).fetchone()[0]

    unresolved = storage.db.execute("""
        SELECT COUNT(*) FROM resolver_decisions rd
        JOIN typed_parsed_output p ON p.id = rd.parsed_id
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE r.tenant_id = ? AND (r.group_name = ? OR r.group_name = ?)
          AND rd.method = 'unresolved'
    """, lookup_values).fetchone()[0]

    total_resolved = resolved + unresolved
    quality_score = round(resolved / total_resolved * 100, 1) if total_resolved > 0 else 0

    # Sync job info
    sync_job = storage.db.execute("""
        SELECT * FROM source_sync_jobs WHERE group_id = ? LIMIT 1
    """, (jid,)).fetchone()

    return {
        "jid": jid,
        "name": group_name,
        "first_seen": raw_info["first_seen"] if raw_info else "",
        "last_seen": raw_info["last_seen"] if raw_info else "",
        "messages": raw_info["msg_count"] if raw_info else 0,
        "observations": len(obs_rows),
        "brokers": broker_count,
        "markets": [dict(m)["micro_market"] for m in markets],
        "buildings": buildings,
        "listings": sum(1 for r in obs_rows if r["intent"] in ("SELL", "RENT", "COMMERCIAL", "PRE-LAUNCH")),
        "requirements": sum(1 for r in obs_rows if r["intent"] in ("BUY", "RENTAL_SEEKER")),
        "quality_score": quality_score,
        "resolved": resolved,
        "unresolved": unresolved,
        "recent_observations": [dict(r) for r in obs_rows[:20]],
        "suggestions": [dict(s) for s in suggestions[:10]],
        "sync_status": dict(sync_job) if sync_job else None,
    }


@router.get("/api/audit/groups/{jid}/timeline")
async def audit_group_timeline(
    jid: str,
    user: dict = Depends(require_user),
    tenant_id: str = Depends(require_tenant),
):
    """Per-group event timeline."""
    events = []
    group_name = _group_jid_to_name(jid)
    lookup_values = (tenant_id, jid, group_name)

    # Messages
    raw_rows = storage.db.execute("""
        SELECT created_at as ts, message_type, SUBSTR(message, 1, 60) as msg_preview
        FROM raw_messages
        WHERE tenant_id = ? AND (group_name = ? OR group_name = ?)
        ORDER BY created_at DESC LIMIT 30
    """, lookup_values).fetchall()
    for r in raw_rows:
        events.append({"ts": r["ts"], "label": "Message received (" + (r["msg_preview"] or "") + ")", "type": "message"})

    # Resolver decisions
    res_rows = storage.db.execute("""
        SELECT rd.created_at as ts, rd.method,
               COALESCE(rd.building_name, rd.landmark_name, rd.street_name, 'location') as resolved_to
        FROM resolver_decisions rd
        JOIN typed_parsed_output p ON p.id = rd.parsed_id
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE r.tenant_id = ? AND (r.group_name = ? OR r.group_name = ?)
          AND rd.method != 'unresolved'
        ORDER BY rd.created_at DESC LIMIT 20
    """, lookup_values).fetchall()
    for r in res_rows:
        events.append({"ts": r["ts"], "label": "Resolved: " + (r["resolved_to"] or "location"), "type": "resolve"})

    events.sort(key=lambda e: e.get("ts", ""), reverse=True)
    return events[:50]


@router.get("/api/audit/duplicates")
def audit_duplicates(
    user: dict = Depends(require_user),
    tenant_id: str = Depends(require_tenant),
):
    """Find potential duplicate groups (same or very similar name)."""
    jobs = _audit_rows(
        "SELECT group_name AS group_id, group_name, '' AS error, 'captured' AS status "
        "FROM raw_messages "
        "WHERE tenant_id = ? AND COALESCE(group_name, '') != '' "
        "GROUP BY group_name ORDER BY group_name",
        (tenant_id,),
    )

    from collections import defaultdict
    by_name = defaultdict(list)
    for j in jobs:
        by_name[j["group_name"]].append(dict(j))

    dupes = []
    seen_pairs = set()
    names = list(by_name.keys())
    for i, name_a in enumerate(names):
        for name_b in names[i+1:]:
            # Simple similarity: one name contains the other or very similar
            a_lower = name_a.lower()
            b_lower = name_b.lower()
            if a_lower in b_lower or b_lower in a_lower:
                for ga in by_name[name_a]:
                    for gb in by_name[name_b]:
                        pair_key = tuple(sorted([ga["group_id"], gb["group_id"]]))
                        if pair_key not in seen_pairs:
                            seen_pairs.add(pair_key)
                            dupes.append({
                                "group_a": {"jid": ga["group_id"], "name": ga["group_name"]},
                                "group_b": {"jid": gb["group_id"], "name": gb["group_name"]},
                                "match_type": "name_similarity",
                            })

    # Also detect same-JID groups (shouldn't happen but guard)
    return dupes


@router.get("/api/audit/group-overlap")
def audit_group_overlap(
    limit: int = 20,
    user: dict = Depends(require_user),
    tenant_id: str = Depends(require_tenant),
):
    """Rank groups by shared senders so users can avoid parsing duplicate groups."""
    if not _table_exists("raw_messages"):
        return {"pairs": [], "groups": []}

    try:
        rows = _audit_rows(
            "SELECT group_name, sender "
            "FROM raw_messages "
            "WHERE COALESCE(group_name, '') != '' "
            "  AND COALESCE(sender, '') != '' "
            "  AND tenant_id = ? "
            "GROUP BY group_name, sender",
            (tenant_id,),
        )
    except Exception as exc:
        return {"pairs": [], "groups": [], "error": str(exc)}

    from collections import defaultdict
    sender_groups: dict[str, set[str]] = defaultdict(set)
    group_senders: dict[str, set[str]] = defaultdict(set)

    for row in rows:
        group_name = str(_audit_row_value(row, ("group_name", 0), "") or "").strip()
        sender = str(_audit_row_value(row, ("sender", 1), "") or "").strip()
        if not group_name or not sender:
            continue
        sender_groups[sender].add(group_name)
        group_senders[group_name].add(sender)

    pair_counts: dict[tuple[str, str], int] = defaultdict(int)
    for groups in sender_groups.values():
        if len(groups) < 2:
            continue
        ordered = sorted(groups)
        for i, a in enumerate(ordered):
            for b in ordered[i + 1:]:
                pair_counts[(a, b)] += 1

    pairs = []
    for (group_a, group_b), shared in pair_counts.items():
        a_total = len(group_senders.get(group_a, set()))
        b_total = len(group_senders.get(group_b, set()))
        if a_total == 0 or b_total == 0:
            continue
        overlap_pct = round((shared / max(1, min(a_total, b_total))) * 100, 1)
        if shared < 2 and overlap_pct < 25:
            continue
        keep_group, skip_group = (group_a, group_b)
        keep_total, skip_total = (a_total, b_total)
        if b_total > a_total or (b_total == a_total and group_b < group_a):
            keep_group, skip_group = group_b, group_a
            keep_total, skip_total = b_total, a_total
        pairs.append({
            "group_a": {"jid": group_a, "name": _audit_group_display_name(group_a), "senders": a_total},
            "group_b": {"jid": group_b, "name": _audit_group_display_name(group_b), "senders": b_total},
            "shared_senders": shared,
            "overlap_pct": overlap_pct,
            "keep": {"jid": keep_group, "name": _audit_group_display_name(keep_group), "senders": keep_total},
            "skip": {"jid": skip_group, "name": _audit_group_display_name(skip_group), "senders": skip_total},
            "reason": "highest sender overlap",
        })

    pairs.sort(key=lambda p: (p["shared_senders"], p["overlap_pct"]), reverse=True)
    return {
        "pairs": pairs[: max(1, min(limit, 50))],
        "groups": [
            {
                "jid": jid,
                "name": _audit_group_display_name(jid),
                "senders": len(senders),
            }
            for jid, senders in sorted(group_senders.items(), key=lambda item: len(item[1]), reverse=True)
        ][: max(1, min(limit, 50))],
    }


@router.get("/api/audit/capture-health")
def audit_capture_health(
    user: dict = Depends(require_user),
    tenant_id: str = Depends(require_tenant),
):
    """Operational diagnostics for the ingestion pipeline."""
    now_dt = datetime.utcnow()
    today_start = now_dt.strftime("%Y-%m-%dT00:00:00Z")
    five_min_ago = (now_dt - timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%SZ")

    errors: list[str] = []
    row = None
    try:
        row = storage.db.execute(
            "WITH scope AS (SELECT ?::uuid AS tenant_id, ?::timestamptz AS today_start) "
            "SELECT "
            "COUNT(*) AS total_raw, "
            "COUNT(*) FILTER (WHERE rm.created_at >= scope.today_start) AS raw_today, "
            "MAX(created_at) AS last_msg, "
            "(SELECT COUNT(DISTINCT raw_message_id) FROM typed_parsed_output WHERE tenant_id = scope.tenant_id) AS total_parsed, "
            "(SELECT COUNT(DISTINCT raw_message_id) FROM typed_parsed_output WHERE tenant_id = scope.tenant_id AND created_at >= scope.today_start) AS parsed_today, "
            "(SELECT COUNT(*) FROM knowledge_records WHERE tenant_id = scope.tenant_id) AS total_kr, "
            "(SELECT COUNT(*) FROM observations WHERE tenant_id = scope.tenant_id) AS total_obs, "
            "(SELECT COUNT(*) FROM observation_evidence WHERE tenant_id = scope.tenant_id) AS total_oe, "
            "(SELECT COUNT(*) FROM brokers WHERE tenant_id = scope.tenant_id) AS total_brokers, "
            "(SELECT COUNT(*) FROM enrichment_jobs WHERE tenant_id = scope.tenant_id AND status = 'pending') AS pending_enrich, "
            "(SELECT COUNT(*) FROM ai_suggestions WHERE tenant_id = scope.tenant_id AND status = 'pending') AS pending_ai "
            "FROM raw_messages rm CROSS JOIN scope WHERE rm.tenant_id = scope.tenant_id "
            "GROUP BY scope.tenant_id, scope.today_start",
            (tenant_id, today_start),
        ).fetchone()
    except Exception as exc:
        errors.append(f"capture metrics unavailable: {exc}")

    total_raw = int(_audit_row_value(row, "total_raw", 0) or 0)
    raw_today = int(_audit_row_value(row, "raw_today", 0) or 0)
    total_parsed = int(_audit_row_value(row, "total_parsed", 0) or 0)
    parsed_today = int(_audit_row_value(row, "parsed_today", 0) or 0)
    total_kr = int(_audit_row_value(row, "total_kr", 0) or 0)
    total_obs = int(_audit_row_value(row, "total_obs", 0) or 0)
    total_oe = int(_audit_row_value(row, "total_oe", 0) or 0)
    total_brokers = int(_audit_row_value(row, "total_brokers", 0) or 0)
    # Fallback: when the brokers table is empty (identity resolution not yet run),
    # count unique resolved identities from parsed_output so "Brokers Overall"
    # is never a misleading zero while data exists.
    if total_brokers == 0:
        try:
            fb = storage.db.execute(
                "SELECT COUNT(DISTINCT COALESCE(NULLIF(po.broker_name, ''), "
                "NULLIF(po.profile_name, ''), NULLIF(rm.sender, ''))) "
                "FROM typed_parsed_output po "
                "JOIN raw_messages rm ON po.raw_message_id = rm.id "
                "WHERE rm.tenant_id = ?",
                (tenant_id,),
            ).fetchone()
            if fb:
                total_brokers = int(fb[0] or 0)
        except Exception:
            pass
    last_msg = _audit_row_value(row, "last_msg")
    pending_enrich = int(_audit_row_value(row, "pending_enrich", 0) or 0)
    pending_ai = int(_audit_row_value(row, "pending_ai", 0) or 0)

    webhook_ok = bool(last_msg and _audit_timestamp(last_msg) >= five_min_ago)
    mins_today = max(1, now_dt.hour * 60 + now_dt.minute)
    msgs_per_min = round(raw_today / mins_today, 1)
    parser_success_rate = round(min(100.0, total_parsed / max(1, total_raw) * 100), 1)

    return {
        "stage": {
            "raw_messages": total_raw,
            "parsed_output": total_parsed,
            "knowledge_records": total_kr,
            "observations": total_obs,
            "observation_evidence": total_oe,
            "brokers": total_brokers,
        },
        "today": {
            "raw_messages": raw_today,
            "parsed_output": parsed_today,
        },
        "msgs_per_min": msgs_per_min,
        "parser_success_rate": parser_success_rate,
        "last_webhook": _audit_timestamp(last_msg) or "never",
        "webhook_ok": webhook_ok,
        "queue_backlog": (pending_enrich or 0) + (pending_ai or 0),
        "pending_enrichment": pending_enrich,
        "pending_ai_suggestions": pending_ai,
        "total_msgs_today": raw_today,
        "total_parsed_today": parsed_today,
        "avg_process_secs": None,
        "errors": errors,
        "degraded": bool(errors),
    }


@router.get("/api/audit/intelligence")
async def audit_intelligence_v2(user: dict = Depends(require_user)):
    """Fresh WhatsApp audit read model backed by current PropAI tables."""
    now_dt = datetime.utcnow()
    today = now_dt.strftime("%Y-%m-%d")
    today_start = now_dt.strftime("%Y-%m-%dT00:00:00Z")
    five_min_ago = (now_dt - timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%SZ")
    day_ago = (now_dt - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ")
    week_ago = (now_dt - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")

    total_raw = _audit_scalar("SELECT COUNT(*) FROM raw_messages WHERE tenant_id = ?", (tenant_id,), 0) if _table_exists("raw_messages") else 0
    total_parsed = _audit_scalar("SELECT COUNT(DISTINCT raw_message_id) FROM typed_parsed_output WHERE tenant_id = ?", (tenant_id,), 0) if _table_exists("typed_parsed_output") else 0
    total_groups = _audit_scalar("SELECT COUNT(DISTINCT group_name) FROM raw_messages WHERE tenant_id = ? AND COALESCE(group_name, '') != ''", (tenant_id,), 0) if _table_exists("raw_messages") else 0
    active_groups_24h = _audit_scalar("SELECT COUNT(DISTINCT group_name) FROM raw_messages WHERE tenant_id = ? AND created_at >= ? AND COALESCE(group_name, '') != ''", (tenant_id, day_ago), 0) if _table_exists("raw_messages") else 0
    msgs_today = _audit_scalar("SELECT COUNT(*) FROM raw_messages WHERE tenant_id = ? AND created_at >= ?", (tenant_id, today_start), 0) if _table_exists("raw_messages") else 0
    parsed_today = _audit_scalar("SELECT COUNT(DISTINCT raw_message_id) FROM typed_parsed_output WHERE tenant_id = ? AND created_at >= ?", (tenant_id, today_start), 0) if _table_exists("typed_parsed_output") else 0
    last_msg = _audit_scalar("SELECT MAX(created_at) FROM raw_messages WHERE tenant_id = ?", (tenant_id,), None) if _table_exists("raw_messages") else None
    webhook_ok = bool(last_msg and str(last_msg) >= five_min_ago)
    parser_success = round(min(100.0, (total_parsed / max(1, total_raw)) * 100), 1)

    knowledge_records = _audit_scalar("SELECT COUNT(*) FROM knowledge_records WHERE tenant_id = ?", (tenant_id,), 0) if _table_exists("knowledge_records") else total_raw
    searchable_records = _audit_count("knowledge_records_fts") or knowledge_records
    embeddings_count = _audit_count("embeddings")
    indexed_records = searchable_records or knowledge_records
    recall_ready_pct = round(min(100.0, (indexed_records / max(1, knowledge_records)) * 100), 1) if knowledge_records else 0

    attachment_count = _audit_scalar("SELECT COUNT(*) FROM raw_messages WHERE tenant_id = ? AND COALESCE(message_type, 'text') != 'text'", (tenant_id,), 0) if _table_exists("raw_messages") else 0
    communities_count = _audit_scalar("SELECT COUNT(DISTINCT group_name) FROM raw_messages WHERE tenant_id = ? AND lower(group_name) LIKE '%community%'", (tenant_id,), 0) if _table_exists("raw_messages") else 0
    broadcast_count = _audit_scalar("""
        SELECT COUNT(DISTINCT group_name) FROM raw_messages
        WHERE tenant_id = ?
          AND (group_name LIKE '%@broadcast'
               OR group_name = 'status@broadcast'
               OR lower(group_name) LIKE '%broadcast%')
    """, (tenant_id,), 0) if _table_exists("raw_messages") else 0
    direct_message_count = _audit_scalar("""
        SELECT COUNT(*) FROM raw_messages
        WHERE tenant_id = ?
          AND (group_name LIKE '%@s.whatsapp.net'
               OR group_name LIKE '%@lid')
    """, (tenant_id,), 0) if _table_exists("raw_messages") else 0

    total_brokers = _audit_scalar("SELECT COUNT(*) FROM brokers WHERE tenant_id = ?", (tenant_id,), 0) if _table_exists("brokers") else 0
    total_jids = _audit_scalar("SELECT COUNT(*) FROM jid_profiles WHERE tenant_id = ?", (tenant_id,), 0) if _table_exists("jid_profiles") else 0
    unique_phones = _audit_scalar("SELECT COUNT(DISTINCT phone) FROM jid_profiles WHERE tenant_id = ? AND phone IS NOT NULL AND phone != ''", (tenant_id,), 0) if _table_exists("jid_profiles") else 0
    named_contacts = _audit_scalar("SELECT COUNT(*) FROM jid_profiles WHERE tenant_id = ? AND COALESCE(display_name, '') NOT IN ('', 'Unknown')", (tenant_id,), 0) if _table_exists("jid_profiles") else 0
    unnamed_contacts = max(0, total_jids - named_contacts)
    new_brokers_today = _audit_scalar("SELECT COUNT(*) FROM brokers WHERE tenant_id = ? AND date(first_seen_at) = ?", (tenant_id, today), 0) if _table_exists("brokers") else 0
    new_brokers_week = _audit_scalar("SELECT COUNT(*) FROM brokers WHERE tenant_id = ? AND first_seen_at >= ?", (tenant_id, week_ago), 0) if _table_exists("brokers") else 0
    recently_active = _audit_scalar("SELECT COUNT(*) FROM brokers WHERE tenant_id = ? AND last_seen_at >= ?", (tenant_id, week_ago), 0) if _table_exists("brokers") else 0
    jids_no_phone = _audit_scalar("SELECT COUNT(*) FROM jid_profiles WHERE tenant_id = ? AND (phone IS NULL OR phone = '')", (tenant_id,), 0) if _table_exists("jid_profiles") else 0

    total_listings = _audit_scalar("SELECT COUNT(*) FROM typed_listings_index WHERE tenant_id = ?", (tenant_id,), 0) if _table_exists("typed_listings_index") else 0
    sell_count = _audit_scalar("SELECT COUNT(*) FROM typed_listings_index WHERE tenant_id = ? AND upper(COALESCE(intent, '')) IN ('SELL','SELLER','SALE','COMMERCIAL_SALE','PRE-LAUNCH')", (tenant_id,), 0) if _table_exists("typed_listings_index") else 0
    rent_count = _audit_scalar("SELECT COUNT(*) FROM typed_listings_index WHERE tenant_id = ? AND upper(COALESCE(intent, '')) IN ('RENT','RENTAL','LEASE','COMMERCIAL_RENTAL')", (tenant_id,), 0) if _table_exists("typed_listings_index") else 0
    commercial_count = _audit_scalar("SELECT COUNT(*) FROM typed_listings_index WHERE tenant_id = ? AND upper(COALESCE(intent, '')) LIKE '%COMMERCIAL%'", (tenant_id,), 0) if _table_exists("typed_listings_index") else 0
    total_requirements = _audit_scalar("""
        SELECT COUNT(DISTINCT raw_message_id) FROM typed_parsed_output
        WHERE tenant_id = ? AND upper(COALESCE(intent, '')) IN ('BUY','BUYER','REQUIREMENT','RENTAL_SEEKER','TENANT')
    """, (tenant_id,), 0) if _table_exists("typed_parsed_output") else 0

    markets_observed = _audit_scalar("SELECT COUNT(DISTINCT micro_market) FROM typed_parsed_output WHERE tenant_id = ? AND COALESCE(micro_market, '') != ''", (tenant_id,), 0) if _table_exists("typed_parsed_output") else 0
    buildings_observed = _audit_scalar("SELECT COUNT(*) FROM buildings WHERE tenant_id = ?", (tenant_id,), 0) if _table_exists("buildings") else 0
    buildings_with_data = _audit_scalar("SELECT COUNT(*) FROM buildings WHERE tenant_id = ? AND COALESCE(observed_listings, 0) > 0", (tenant_id,), 0) if _table_exists("buildings") else 0
    developers_observed = _audit_scalar("SELECT COUNT(DISTINCT developer) FROM typed_parsed_output WHERE tenant_id = ? AND COALESCE(developer, '') != ''", (tenant_id,), 0) if _table_exists("typed_parsed_output") else 0
    localities_observed = _audit_scalar("SELECT COUNT(DISTINCT area) FROM typed_parsed_output WHERE tenant_id = ? AND COALESCE(area, '') != ''", (tenant_id,), 0) if _table_exists("typed_parsed_output") else 0
    landmarks_observed = _audit_scalar("SELECT COUNT(DISTINCT landmark_name) FROM typed_parsed_output WHERE tenant_id = ? AND COALESCE(landmark_name, '') != ''", (tenant_id,), 0) if _table_exists("typed_parsed_output") else 0

    latest_records = _audit_rows("""
        SELECT id, created_at, group_name, sender, message
        FROM raw_messages
        WHERE tenant_id = ?
        ORDER BY created_at DESC
        LIMIT 12
    """, (tenant_id,)) if _table_exists("raw_messages") else []

    group_rows = []
    if _table_exists("raw_messages") and _table_exists("typed_parsed_output"):
        group_rows = _audit_rows("""
            SELECT rm.group_name,
                   COUNT(DISTINCT rm.id) AS messages,
                   COUNT(DISTINCT rm.sender) AS unique_senders,
                   MAX(rm.created_at) AS last_seen,
                   COUNT(DISTINCT CASE WHEN po.id IS NOT NULL THEN (po.raw_message_id::text || ':' || COALESCE(po.listing_index, 0)::text) END) AS observations,
                   COUNT(DISTINCT CASE WHEN upper(COALESCE(po.intent, '')) IN ('BUY','BUYER','REQUIREMENT','RENTAL_SEEKER','TENANT') THEN (po.raw_message_id::text || ':' || COALESCE(po.listing_index, 0)::text) END) AS requirements,
                   COUNT(DISTINCT CASE WHEN po.id IS NOT NULL AND upper(COALESCE(po.intent, '')) NOT IN ('BUY','BUYER','REQUIREMENT','RENTAL_SEEKER','TENANT') THEN (po.raw_message_id::text || ':' || COALESCE(po.listing_index, 0)::text) END) AS listings,
                   COUNT(DISTINCT NULLIF(po.micro_market, '')) AS markets,
                   COUNT(DISTINCT NULLIF(po.building_name, '')) AS buildings
            FROM raw_messages rm
            LEFT JOIN typed_parsed_output po ON po.raw_message_id = rm.id
            WHERE rm.tenant_id = ? AND COALESCE(rm.group_name, '') != ''
            GROUP BY rm.group_name
            ORDER BY messages DESC
            LIMIT 20
        """, (tenant_id,))
    elif _table_exists("raw_messages"):
        group_rows = _audit_rows("""
            SELECT group_name, COUNT(*) AS messages, COUNT(DISTINCT sender) AS unique_senders,
                   MAX(created_at) AS last_seen, 0 AS observations, 0 AS requirements,
                   0 AS listings, 0 AS markets, 0 AS buildings
            FROM raw_messages
            WHERE tenant_id = ?
            GROUP BY group_name
            ORDER BY messages DESC
            LIMIT 20
        """, (tenant_id,))

    top_brokers = _audit_rows("""
        SELECT canonical_name, primary_phone, observation_count, listing_count,
               requirement_count, group_count, first_seen_at, last_seen_at
        FROM brokers
        WHERE tenant_id = ?
        ORDER BY observation_count DESC
        LIMIT 15
    """, (tenant_id,)) if _table_exists("brokers") else []

    broker_reach = _audit_rows("""
        SELECT broker_name,
               COUNT(DISTINCT rm.group_name) AS groups,
               COUNT(DISTINCT rm.id) AS observations,
               MIN(rm.created_at) AS first_seen,
               MAX(rm.created_at) AS last_seen
        FROM typed_parsed_output po
        JOIN raw_messages rm ON po.raw_message_id = rm.id
        WHERE rm.tenant_id = ? AND COALESCE(broker_name, '') != ''
        GROUP BY broker_name
        ORDER BY groups DESC, observations DESC
        LIMIT 10
    """, (tenant_id,)) if _table_exists("typed_parsed_output") and _table_exists("raw_messages") else []

    market_stats = _audit_rows("""
        SELECT micro_market,
               COUNT(DISTINCT rm.id) AS total,
               SUM(CASE WHEN upper(COALESCE(intent, '')) NOT IN ('BUY','BUYER','REQUIREMENT','RENTAL_SEEKER','TENANT') THEN 1 ELSE 0 END) AS residential,
               SUM(CASE WHEN upper(COALESCE(intent, '')) LIKE '%COMMERCIAL%' THEN 1 ELSE 0 END) AS commercial,
               COUNT(DISTINCT broker_name) AS brokers
        FROM typed_parsed_output po
        JOIN raw_messages rm ON po.raw_message_id = rm.id
        WHERE rm.tenant_id = ? AND COALESCE(micro_market, '') != ''
        GROUP BY micro_market
        ORDER BY total DESC
        LIMIT 20
    """, (tenant_id,)) if _table_exists("typed_parsed_output") and _table_exists("raw_messages") else []

    top_markets = _audit_rows("""
        SELECT micro_market, COUNT(DISTINCT broker_name) AS brokers
        FROM typed_parsed_output po
        JOIN raw_messages rm ON po.raw_message_id = rm.id
        WHERE rm.tenant_id = ? AND COALESCE(micro_market, '') != ''
        GROUP BY micro_market
        ORDER BY brokers DESC
        LIMIT 10
    """, (tenant_id,)) if _table_exists("typed_parsed_output") and _table_exists("raw_messages") else []

    suggestions = []
    if total_raw == 0:
        suggestions.append({"type": "capture_empty", "message": "No WhatsApp messages captured yet.", "action": "connect_whatsapp", "count": 1})
    if total_parsed and parser_success < 30:
        suggestions.append({"type": "parser_health", "message": "Parser success is low. Review message format issues.", "action": "review_format", "count": total_parsed})
    if unnamed_contacts:
        suggestions.append({"type": "contact_cleanup", "message": f"{unnamed_contacts} WhatsApp identities have no saved name.", "action": "review_unnamed", "count": unnamed_contacts})

    return {
        "network": {
            "total_groups": total_groups,
            "active_groups_24h": active_groups_24h,
            "total_messages": total_raw,
            "knowledge_records": knowledge_records,
            "attachments": attachment_count,
            "communities": communities_count,
            "broadcasts": broadcast_count,
            "direct_messages": direct_message_count,
            "messages_today": msgs_today,
            "parsed_today": parsed_today,
            "parser_success": parser_success,
            "last_message": str(last_msg or "never"),
            "webhook_healthy": webhook_ok,
        },
        "brokers": {
            "total": total_brokers,
            "total_jids": total_jids,
            "unique_phones": unique_phones,
            "named_contacts": named_contacts,
            "unnamed_contacts": unnamed_contacts,
            "new_today": new_brokers_today,
            "new_this_week": new_brokers_week,
            "recently_active": recently_active,
            "jids_no_phone": jids_no_phone,
            "top": [
                {
                    "name": _audit_row_value(r, 0, ""),
                    "phone": _audit_row_value(r, 1, ""),
                    "observations": _audit_row_value(r, 2, 0) or 0,
                    "listings": _audit_row_value(r, 3, 0) or 0,
                    "requirements": _audit_row_value(r, 4, 0) or 0,
                    "groups": _audit_row_value(r, 5, 0) or 0,
                    "first_seen": _audit_row_value(r, 6, ""),
                    "last_seen": _audit_row_value(r, 7, ""),
                }
                for r in top_brokers
            ],
        },
        "cleanup": {"duplicate_phones": [], "duplicate_names": [], "brokers_no_market": 0},
        "listings": {
            "total": total_listings,
            "sell": sell_count,
            "rent": rent_count,
            "commercial": commercial_count,
            "requirements": total_requirements,
        },
        "coverage": {
            "markets": markets_observed,
            "buildings": buildings_observed,
            "buildings_with_data": buildings_with_data,
            "developers": developers_observed,
            "localities": localities_observed,
            "landmarks": landmarks_observed,
            "market_stats": [
                {"name": r[0], "total": r[1] or 0, "residential": r[2] or 0, "commercial": r[3] or 0, "brokers": r[4] or 0}
                for r in market_stats
            ],
            "top_markets": [{"name": r[0], "brokers": r[1] or 0} for r in top_markets],
            "coverage_gaps": [],
        },
        "capture": {
            "status": "connected" if webhook_ok else ("stale" if total_raw else "empty"),
            "last_message": str(last_msg or "never"),
            "messages_captured": total_raw,
            "knowledge_records": knowledge_records,
            "attachments": attachment_count,
            "communities": communities_count,
            "groups": total_groups,
            "broadcasts": broadcast_count,
            "direct_messages": direct_message_count,
            "latest_records": [
                {
                    "id": r[0],
                    "time": str(r[1] or ""),
                    "conversation": _audit_group_display_name(str(r[2] or "")),
                    "sender": str(r[3] or ""),
                    "preview": str(r[4] or "")[:180],
                    "stored": True,
                }
                for r in latest_records
            ],
        },
        "search_coverage": {
            "messages": total_raw,
            "indexed": indexed_records,
            "searchable": searchable_records,
            "embeddings": embeddings_count,
            "recall_ready": recall_ready_pct,
        },
        "learning": {"unknown_terms": 0, "needs_review": 0, "recently_learned": []},
        "groups": [
            {
                "name": _audit_group_display_name(str(r[0] or "")),
                "jid": str(r[0] or ""),
                "messages": r[1] or 0,
                "unique_senders": r[2] or 0,
                "listings": r[6] or 0,
                "requirements": r[5] or 0,
                "markets": r[7] or 0,
                "buildings": r[8] or 0,
                "signal_ratio": round(((r[4] or 0) / max(1, r[1] or 0)) * 100, 1),
                "last_seen": str(r[3] or ""),
            }
            for r in group_rows
        ],
        "broker_reach": [
            {"name": r[0], "groups": r[1] or 0, "observations": r[2] or 0, "first_seen": r[3], "last_seen": r[4]}
            for r in broker_reach
        ],
        "suggestions": suggestions,
    }


@router.get("/api/audit/insights")
def audit_insights(
    user: dict = Depends(require_user),
    tenant_id: str = Depends(require_tenant),
):
    """Compact, tenant-scoped intelligence used by the broker audit dashboard."""
    empty = {
        "daily_flow": [],
        "markets": [],
        "brokers": [],
        "exclusive_members": {},
        "total_unique_brokers": 0,
        "total_broker_appearances": 0,
    }
    try:
        week_ago = (datetime.utcnow() - timedelta(days=6)).strftime("%Y-%m-%dT00:00:00Z")

        flow_rows = _audit_rows(
            "SELECT (rm.created_at)::date AS day, COUNT(DISTINCT rm.id) AS posts, "
            "COUNT(DISTINCT CASE WHEN UPPER(COALESCE(po.intent, '')) IN "
            "('BUY','BUYER','REQUIREMENT','RENTAL_SEEKER','TENANT') THEN (po.raw_message_id::text || ':' || COALESCE(po.listing_index, 0)::text) END) AS requirements, "
            "COUNT(DISTINCT CASE WHEN UPPER(COALESCE(po.intent, '')) NOT IN "
            "('BUY','BUYER','REQUIREMENT','RENTAL_SEEKER','TENANT') THEN (po.raw_message_id::text || ':' || COALESCE(po.listing_index, 0)::text) END) AS listings "
            "FROM raw_messages rm JOIN typed_parsed_output po ON po.raw_message_id = rm.id "
            "WHERE rm.tenant_id = $1 AND rm.created_at >= $2 "
            "GROUP BY (rm.created_at)::date ORDER BY day",
            (tenant_id, week_ago),
        ) if _table_exists("raw_messages") and _table_exists("typed_parsed_output") else []

        market_rows = _audit_rows(
            "SELECT po.micro_market, COUNT(DISTINCT rm.id) AS posts, "
            "COUNT(DISTINCT CASE WHEN UPPER(COALESCE(po.intent, '')) IN "
            "('BUY','BUYER','REQUIREMENT','RENTAL_SEEKER','TENANT') THEN (po.raw_message_id::text || ':' || COALESCE(po.listing_index, 0)::text) END) AS requirements, "
            "COUNT(DISTINCT CASE WHEN UPPER(COALESCE(po.intent, '')) NOT IN "
            "('BUY','BUYER','REQUIREMENT','RENTAL_SEEKER','TENANT') THEN (po.raw_message_id::text || ':' || COALESCE(po.listing_index, 0)::text) END) AS listings, "
            "COUNT(DISTINCT COALESCE(NULLIF(po.broker_phone, ''), NULLIF(po.broker_name, ''), rm.sender)) AS brokers "
            "FROM typed_parsed_output po JOIN raw_messages rm ON po.raw_message_id = rm.id "
            "WHERE rm.tenant_id = $1 AND rm.created_at >= $2 AND COALESCE(po.micro_market, '') != '' "
            "GROUP BY po.micro_market ORDER BY posts DESC LIMIT 8",
            (tenant_id, week_ago),
        ) if _table_exists("raw_messages") and _table_exists("typed_parsed_output") else []

        broker_rows = _audit_rows(
            "SELECT canonical_name, observation_count, listing_count, requirement_count, "
            "group_count, market_count, last_seen_at FROM brokers "
            "WHERE tenant_id = $1 ORDER BY observation_count DESC LIMIT 8",
            (tenant_id,),
        ) if _table_exists("brokers") else []

        exclusive_rows = _audit_rows(
            "WITH memberships AS ("
            "SELECT sender, COUNT(DISTINCT group_name) AS group_count "
            "FROM raw_messages WHERE tenant_id = $1 AND COALESCE(group_name, '') != '' GROUP BY sender), "
            "exclusive AS ("
            "SELECT rm.group_name, COUNT(DISTINCT rm.sender) AS exclusive_members "
            "FROM raw_messages rm JOIN memberships m ON m.sender = rm.sender "
            "WHERE rm.tenant_id = $2 AND m.group_count = 1 GROUP BY rm.group_name) "
            "SELECT group_name, exclusive_members FROM exclusive "
            "ORDER BY exclusive_members DESC LIMIT 12",
            (tenant_id, tenant_id),
        ) if _table_exists("raw_messages") else []

        total_unique_brokers = _audit_scalar(
            "SELECT COUNT(DISTINCT COALESCE(NULLIF(broker_phone, ''), NULLIF(broker_name, ''), rm.sender)) "
            "FROM typed_parsed_output po JOIN raw_messages rm ON po.raw_message_id = rm.id "
            "WHERE rm.tenant_id = $1",
            (tenant_id,),
        ) if _table_exists("typed_parsed_output") else 0
        total_broker_appearances = _audit_scalar(
            "SELECT COUNT(DISTINCT po.raw_message_id || ':' || COALESCE(po.listing_index, 0)) "
            "FROM typed_parsed_output po JOIN raw_messages rm ON po.raw_message_id = rm.id "
            "WHERE rm.tenant_id = $1 AND COALESCE(NULLIF(po.broker_phone, ''), NULLIF(po.broker_name, ''), rm.sender) != ''",
            (tenant_id,),
        ) if _table_exists("typed_parsed_output") else 0

        return {
            "daily_flow": [
                {
                    "date": str(_audit_row_value(r, ("day", 0), "")),
                    "posts": _audit_row_value(r, ("posts", 1), 0) or 0,
                    "requirements": _audit_row_value(r, ("requirements", 2), 0) or 0,
                    "listings": _audit_row_value(r, ("listings", 3), 0) or 0,
                }
                for r in flow_rows
            ],
            "markets": [
                {
                    "name": _audit_row_value(r, ("micro_market", 0), ""),
                    "posts": _audit_row_value(r, ("posts", 1), 0) or 0,
                    "requirements": _audit_row_value(r, ("requirements", 2), 0) or 0,
                    "listings": _audit_row_value(r, ("listings", 3), 0) or 0,
                    "brokers": _audit_row_value(r, ("brokers", 4), 0) or 0,
                }
                for r in market_rows
            ],
            "brokers": [
                {
                    "name": _audit_row_value(r, ("canonical_name", 0), "") or "Unknown broker",
                    "posts": _audit_row_value(r, ("observation_count", 1), 0) or 0,
                    "listings": _audit_row_value(r, ("listing_count", 2), 0) or 0,
                    "requirements": _audit_row_value(r, ("requirement_count", 3), 0) or 0,
                    "groups": _audit_row_value(r, ("group_count", 4), 0) or 0,
                    "markets": _audit_row_value(r, ("market_count", 5), 0) or 0,
                    "last_seen": _audit_timestamp(_audit_row_value(r, ("last_seen_at", 6))),
                }
                for r in broker_rows
            ],
            "exclusive_members": {
                str(_audit_row_value(r, ("group_name", 0), "")): (
                    int(_audit_row_value(r, ("exclusive_members", 1), 0) or 0)
                )
                for r in exclusive_rows
            },
            "total_unique_brokers": int(total_unique_brokers or 0),
            "total_broker_appearances": int(total_broker_appearances or 0),
        }
    except Exception as exc:
        print(f"[audit] insights failed: {exc}", flush=True)
        return empty


@router.get("/api/audit/search-evidence")
def audit_search_evidence(user: dict = Depends(require_user), q: str = ""):
    """Exact evidence summary for a term in captured WhatsApp knowledge."""
    term = (q or "").strip()
    if not term:
        return {
            "query": "",
            "count": 0,
            "first_seen": "",
            "last_seen": "",
            "groups": 0,
            "unique_senders": 0,
            "top_groups": [],
            "recent": [],
        }

    tokens = re.findall(r"[\w]+", term.lower(), flags=re.UNICODE)
    if not tokens:
        return {
            "query": term,
            "count": 0,
            "first_seen": "",
            "last_seen": "",
            "groups": 0,
            "unique_senders": 0,
            "top_groups": [],
            "recent": [],
        }

    filters = " AND ".join(["(message LIKE $%d OR sender LIKE $%d OR group_name LIKE $%d)" % (i * 3 + 1, i * 3 + 2, i * 3 + 3) for i in range(len(tokens))])
    params = [value for token in tokens for value in (f"%{token}%", f"%{token}%", f"%{token}%")]

    summary = storage.db.execute(f"""
        SELECT COUNT(*) AS count,
               MIN(timestamp) AS first_seen,
               MAX(timestamp) AS last_seen,
               COUNT(DISTINCT group_name) AS groups,
               COUNT(DISTINCT COALESCE(NULLIF(sender_phone, ''), NULLIF(sender_jid, ''), sender)) AS unique_senders
        FROM raw_messages
        WHERE {filters}
    """, params).fetchone()

    top_groups = storage.db.execute(f"""
        SELECT group_name, COUNT(*) AS count
        FROM raw_messages
        WHERE {filters}
        GROUP BY group_name
        ORDER BY count DESC
        LIMIT 6
    """, params).fetchall()

    recent = storage.db.execute(f"""
        SELECT id, timestamp, group_name, sender, message
        FROM raw_messages
        WHERE {filters}
        ORDER BY timestamp DESC
        LIMIT 6
    """, params).fetchall()
    return {
        "query": term,
        "count": summary["count"] if summary else 0,
        "first_seen": summary["first_seen"] if summary else "",
        "last_seen": summary["last_seen"] if summary else "",
        "groups": summary["groups"] if summary else 0,
        "unique_senders": summary["unique_senders"] if summary else 0,
        "top_groups": [
            {"name": _group_jid_to_name(r["group_name"]), "count": r["count"]}
            for r in top_groups
        ],
        "recent": [
            {
                "id": r["id"],
                "time": r["timestamp"],
                "conversation": _group_jid_to_name(r["group_name"]),
                "sender": r["sender"],
                "preview": (r["message"] or "")[:180],
            }
            for r in recent
        ],
    }
