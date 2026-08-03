"""Groups, market data, and WhatsApp conversations routes."""
import asyncio
import json
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request

from config import load_excluded_groups, save_excluded_groups
from routers.common import (
    storage,
    require_user,
    get_tenant_context,
    _resolve_active_organization_id,
    _require_org_permission,
    _first_ingestor_response,
    _ingestor_failure_message,
    parse_group_name,
    _audit_rows,
    _audit_row_value,
    _audit_scalar,
    _table_exists,
)

router = APIRouter(tags=["groups"])


@router.get("/api/price-stats")
async def price_stats_endpoint(market: str = "", bhk: str = "", intent: str = "listing", user: dict = Depends(require_user)):
    if market and bhk:
        result = storage.get_price_stats(market, bhk, intent)
        return result or {"error": "not found"}
    rows = storage.db.execute(
        "SELECT * FROM price_stats ORDER BY count DESC LIMIT 100"
    ).fetchall()
    return [dict(r) for r in rows]


@router.get("/api/enrichment-jobs/counts")
async def enrichment_counts(user: dict = Depends(require_user)):
    counts = {}
    for status in ("pending", "running", "completed", "failed"):
        r = storage.db.execute(
            "SELECT COUNT(*) FROM enrichment_jobs WHERE status = ?", (status,)
        ).fetchone()
        counts[status] = r[0]
    return counts


@router.post("/api/aliases/scan")
async def scan_aliases(user: dict = Depends(require_user)):
    from agents.alias_learner import check_for_aliases
    check_for_aliases(storage)
    return {"status": "ok"}


@router.post("/api/price-stats/recompute")
async def recompute_price_stats(user: dict = Depends(require_user)):
    storage.recompute_price_stats()
    return {"status": "ok"}


@router.get("/api/groups/health")
async def groups_health(user: dict = Depends(require_user), tenant_id: str = Depends(get_tenant_context)):
    """Per-group health metrics with exit confidence scoring.

    Returns every group with activity breakdown (7d/30d/total), extraction
    value, and an actionable exit recommendation.
    """
    now = datetime.now(timezone.utc)
    seven_ago = (now - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")
    thirty_ago = (now - timedelta(days=30)).strftime("%Y-%m-%dT%H:%M:%SZ")

    if not _table_exists("raw_messages"):
        return {"groups": [], "summary": _empty_summary()}

    # ── 1. Per-group activity (uses composite index, <1s) ──
    # NOTE: COUNT(DISTINCT sender) is excluded — it forces a hash aggregate
    # that prevents index-only scans and blows the query past 30s.
    activity_rows = _audit_rows(
        "SELECT group_name, "
        "COUNT(*) AS total, "
        "COUNT(CASE WHEN created_at >= ? THEN 1 END) AS msgs_7d, "
        "COUNT(CASE WHEN created_at >= ? THEN 1 END) AS msgs_30d, "
        "MAX(created_at) AS last_msg "
        "FROM raw_messages "
        "WHERE is_group = true AND group_name IS NOT NULL AND group_name != '' "
        "AND group_name NOT LIKE '%@g.us' "
        "GROUP BY group_name",
        (seven_ago, thirty_ago),
    )

    groups: dict[str, dict] = {}
    for row in activity_rows:
        gn = str(_audit_row_value(row, ("group_name", 0), "") or "")
        if not gn:
            continue
        total = int(_audit_row_value(row, ("total", 1), 0) or 0)
        msgs_7d = int(_audit_row_value(row, ("msgs_7d", 2), 0) or 0)
        msgs_30d = int(_audit_row_value(row, ("msgs_30d", 3), 0) or 0)
        last_msg = _audit_row_value(row, ("last_msg", 4), None)

        days_since = 999
        if last_msg:
            if isinstance(last_msg, str):
                try:
                    last_msg_dt = datetime.fromisoformat(last_msg.replace("Z", "+00:00"))
                except Exception:
                    last_msg_dt = now
            else:
                last_msg_dt = last_msg if last_msg.tzinfo else last_msg.replace(tzinfo=timezone.utc)
            days_since = max(0, int((now - last_msg_dt).total_seconds() / 86400))

        groups[gn] = {
            "name": gn,
            "total": total,
            "msgs_7d": msgs_7d,
            "msgs_30d": msgs_30d,
            "senders": 0,
            "last_msg": last_msg.isoformat() if hasattr(last_msg, "isoformat") else str(last_msg or ""),
            "days_since_msg": days_since,
            "listings": 0,
            "requirements": 0,
            "extracted": 0,
        }

    # ── 2. Per-group extraction value ──
    # Use denormalized group_name on parsed_output when available (fast, no JOIN).
    # Falls back to raw_messages JOIN if column is empty (slow but correct).
    if groups and _table_exists("typed_parsed_output"):
        has_denorm = _audit_scalar(
            "SELECT EXISTS(SELECT 1 FROM typed_parsed_output WHERE group_name IS NOT NULL LIMIT 1)"
        )
        if has_denorm:
            value_rows = _audit_rows(
                "SELECT group_name, "
                "COUNT(*) AS extracted, "
                "COUNT(CASE WHEN UPPER(intent) IN ('BUY','REQUIREMENT','RENTAL_SEEKER','TENANT') THEN 1 END) AS requirements, "
                "COUNT(CASE WHEN intent IS NOT NULL AND UPPER(intent) NOT IN ('BUY','REQUIREMENT','RENTAL_SEEKER','TENANT') THEN 1 END) AS listings "
                "FROM typed_parsed_output "
                "WHERE group_name IS NOT NULL AND group_name != '' AND group_name NOT LIKE '%@g.us' "
                "GROUP BY group_name",
            )
        else:
            value_rows = _audit_rows(
                "SELECT rm.group_name, "
                "COUNT(DISTINCT po.id) AS extracted, "
                "COUNT(DISTINCT CASE WHEN UPPER(po.intent) IN ('BUY','REQUIREMENT','RENTAL_SEEKER','TENANT') THEN po.id END) AS requirements, "
                "COUNT(DISTINCT CASE WHEN po.id IS NOT NULL AND UPPER(po.intent) NOT IN ('BUY','REQUIREMENT','RENTAL_SEEKER','TENANT') THEN po.id END) AS listings "
                "FROM typed_parsed_output po "
                "JOIN raw_messages rm ON po.raw_message_id = rm.id "
                "WHERE rm.is_group = true AND rm.group_name IS NOT NULL AND rm.group_name != '' "
                "AND rm.group_name NOT LIKE '%@g.us' "
                "GROUP BY rm.group_name",
            )
        for row in value_rows:
            gn = str(_audit_row_value(row, ("group_name", 0), "") or "")
            if gn not in groups:
                continue
            groups[gn]["extracted"] = int(_audit_row_value(row, ("extracted", 1), 0) or 0)
            groups[gn]["requirements"] = int(_audit_row_value(row, ("requirements", 2), 0) or 0)
            groups[gn]["listings"] = int(_audit_row_value(row, ("listings", 3), 0) or 0)

    # ── 3. Score and classify ──
    scored = []
    for g in groups.values():
        g["recommendation"] = _exit_confidence(g)
        scored.append(g)

    scored.sort(key=lambda g: (
        {"safe_exit": 0, "probably_exit": 1, "noise": 2, "low_value": 3, "keep": 4, "essential": 5}.get(g["recommendation"], 3),
        -g["total"],
    ))

    safe = sum(1 for g in scored if g["recommendation"] == "safe_exit")
    probably = sum(1 for g in scored if g["recommendation"] == "probably_exit")
    noise_count = sum(1 for g in scored if g["recommendation"] == "noise")
    low = sum(1 for g in scored if g["recommendation"] == "low_value")
    keep = sum(1 for g in scored if g["recommendation"] == "keep")
    essential = sum(1 for g in scored if g["recommendation"] == "essential")

    return {
        "groups": scored,
        "summary": {
            "total": len(scored),
            "safe_exit": safe,
            "probably_exit": probably,
            "noise": noise_count,
            "low_value": low,
            "keep": keep,
            "essential": essential,
            "total_7d": sum(g["msgs_7d"] for g in scored),
            "total_30d": sum(g["msgs_30d"] for g in scored),
            "total_listings": sum(g["listings"] for g in scored),
            "total_requirements": sum(g["requirements"] for g in scored),
        },
    }


def _exit_confidence(g: dict) -> str:
    """Classify a group into an exit confidence bucket.

    Categories:
      safe_exit  — Dead. No activity in 14+ days, few total messages.
      probably_exit — Fading. <10 msgs in 7d AND no extraction value.
      noise — Generic/placeholder name (WhatsApp Group XXXX) with minimal activity.
      low_value — Active but producing zero extraction value.
      keep — Active with extraction value OR high unique sender count.
      essential — High volume + extraction value + many unique brokers.
    """
    days = g["days_since_msg"]
    total = g["total"]
    m7 = g["msgs_7d"]
    m30 = g["msgs_30d"]
    listings = g["listings"]
    reqs = g["requirements"]
    extracted = g["extracted"]
    senders = g["senders"]
    name = g["name"]

    is_noise_name = (
        name.startswith("WhatsApp Group ")
        or (len(name) < 5 and total < 10)
        or name in ("General", "PropAI", "PropAI One")
    )

    if days >= 14 and total < 50:
        return "safe_exit"
    if days >= 30:
        return "safe_exit"
    if is_noise_name and total < 20:
        return "noise"
    if m7 < 10 and extracted == 0:
        return "probably_exit"
    if extracted == 0 and m7 < 20:
        return "low_value"
    if extracted > 0 and senders >= 10 and total >= 200:
        return "essential"
    if extracted > 0 or (m7 >= 50 and senders >= 5):
        return "keep"
    if m7 < 20:
        return "probably_exit"
    return "keep"


def _empty_summary() -> dict:
    return {
        "total": 0, "safe_exit": 0, "probably_exit": 0, "noise": 0,
        "low_value": 0, "keep": 0, "essential": 0,
        "total_7d": 0, "total_30d": 0, "total_listings": 0, "total_requirements": 0,
    }


@router.get("/api/groups")
async def list_groups(user: dict = Depends(require_user)):
    jobs = storage.get_sync_jobs(limit=500, source="whatsapp")
    group_markets = storage.get_group_markets()
    opt_out_list = load_excluded_groups()
    groups = []
    for j in jobs:
        try:
            meta = json.loads(j.meta) if isinstance(j.meta, str) else (j.meta or {})
        except (json.JSONDecodeError, TypeError):
            meta = {}
        participants = j.participants or meta.get("participants", 0) or 0
        parsed = parse_group_name(j.group_name)
        derived = group_markets.get(j.group_name) or []
        merged_markets = list(dict.fromkeys([*parsed.get("markets", []), *derived]))
        enriched = {**parsed, "markets": merged_markets}
        excluded = any(
            entry.lower() in j.group_name.lower() or entry.lower() == str(j.group_id).lower()
            for entry in opt_out_list
        ) if opt_out_list else False
        groups.append({
            "jid": j.group_id,
            "name": j.group_name,
            "participants": participants,
            "parsed": enriched,
            "records_found": j.records_found or 0,
            "records_processed": j.records_processed or 0,
            "status": j.status,
            "error": j.error,
            "allowed": not excluded,
            "excluded": excluded,
        })
    return sorted(groups, key=lambda g: g["name"].lower())


@router.get("/api/groups/{jid}/members")
async def list_group_members(jid: str, user: dict = Depends(require_user)):
    tenant_id = await asyncio.to_thread(
        _resolve_active_organization_id, user, None,
    )
    if not tenant_id:
        return []

    def _fetch():
        rows = (
            storage.client.table("group_members")
            .select("display_name,member_phone,member_jid,is_admin,last_seen_at")
            .eq("tenant_id", tenant_id)
            .eq("group_id", jid)
            .order("display_name", desc=False)
            .limit(500)
            .execute()
            .data
        )
        seen = set()
        members = []
        for r in rows:
            key = r.get("member_jid") or r.get("member_phone") or ""
            if key in seen:
                continue
            seen.add(key)
            name = (r.get("display_name") or "").strip()
            phone = (r.get("member_phone") or "").strip()
            if not name and phone:
                name = phone
            elif not name:
                name = "Unknown"
            members.append({
                "name": name,
                "phone": phone,
                "jid": str(r.get("member_jid") or ""),
                "is_admin": bool(r.get("is_admin")),
                "last_seen": r.get("last_seen_at"),
            })
        return members

    return await asyncio.to_thread(_fetch)


@router.get("/api/whatsapp/conversations")
async def list_whatsapp_conversations(
    types: str = "group,broadcast",
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    allowed = {"group", "broadcast", "direct"}
    requested = [value.strip() for value in types.split(",") if value.strip() in allowed]
    active_org_id = await asyncio.to_thread(
        _resolve_active_organization_id, user, tenant_id,
    )
    return await asyncio.to_thread(
        storage.get_whatsapp_conversations,
        active_org_id,
        requested or ["group", "broadcast"],
        1000,
    )


@router.post("/api/whatsapp/conversations/refresh")
async def refresh_whatsapp_group_directory(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    """Ask each connected workspace phone to republish its live group directory."""
    org_id = await asyncio.to_thread(_resolve_active_organization_id, user, tenant_id)
    if not org_id:
        raise HTTPException(403, "No organization membership found")
    await _require_org_permission(user, org_id, "manage_whatsapp")
    phones = await asyncio.to_thread(storage.list_org_whatsapp_connections, org_id)
    requested: list[str] = []
    unavailable: list[str] = []
    for phone in phones:
        broker_id = str(phone.get("broker_id") or "").strip()
        if not broker_id:
            continue
        _, response = await _first_ingestor_response(
            "POST", "/sync-groups", timeout=4, headers={"X-Broker-Id": broker_id},
        )
        if response is not None and response.status_code == 202:
            requested.append(broker_id)
        else:
            unavailable.append(broker_id)
    if not requested:
        detail = _ingestor_failure_message(None)
        if unavailable:
            detail = "No linked WhatsApp phone is currently connected. Reconnect a phone, then refresh groups."
        raise HTTPException(409, detail)
    return {"ok": True, "state": "refreshing", "requested": requested, "unavailable": unavailable}


@router.get("/api/groups/opt-out")
async def get_opt_out_list(user: dict = Depends(require_user)):
    return load_excluded_groups()


@router.post("/api/groups/opt-out")
async def set_opt_out_list(request: Request, user: dict = Depends(require_user)):
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON")
    if not isinstance(body, list):
        raise HTTPException(400, "Expected a JSON array of strings")
    entries = [str(x).strip() for x in body if x and str(x).strip()]
    save_excluded_groups(entries)
    return {"status": "ok", "count": len(entries)}


@router.delete("/api/groups/opt-out")
async def clear_opt_out_list(user: dict = Depends(require_user)):
    save_excluded_groups([])
    return {"status": "ok"}


@router.get("/api/groups/allowlist")
async def get_allowlist(user: dict = Depends(require_user)):
    return load_excluded_groups()


@router.post("/api/groups/allowlist")
async def set_allowlist(request: Request, user: dict = Depends(require_user)):
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON")
    if not isinstance(body, list):
        raise HTTPException(400, "Expected a JSON array of strings")
    entries = [str(x).strip() for x in body if x and str(x).strip()]
    save_excluded_groups(entries)
    return {"status": "ok", "count": len(entries)}


@router.delete("/api/groups/allowlist")
async def clear_allowlist(user: dict = Depends(require_user)):
    save_excluded_groups([])
    return {"status": "ok"}
