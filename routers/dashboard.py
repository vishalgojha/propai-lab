"""
Dashboard routes — metrics, activity, live-window, feed, heatmap, etc.
"""
import asyncio
import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from lab.events import get_bus

from routers.common import (
    storage,
    require_user,
    get_tenant_context,
    _resolve_active_organization_id,
)

router = APIRouter(tags=["dashboard"])

# ── Helpers (wired from app.py where they depend on global state) ──
_today_prefix = lambda: datetime.now(timezone.utc).strftime("%Y-%m-%d")
_load_evidence_cache = lambda: {}
_broker_live_statuses: dict[str, tuple[dict, float]] = {}
_merged_ingestor_list = lambda timeout=2: ({}, False, "")
_first_ingestor_response = lambda method, path, **kw: (None, None)
business_window_status = lambda: {}
get_scheduler = lambda: None


def _raw_count_all(tenant_id: str | None = None) -> int:
    try:
        query = storage.client.table("raw_messages").select("id", count="exact")
        if tenant_id:
            query = query.eq("tenant_id", tenant_id)
        res = query.execute()
        return res.count if hasattr(res, "count") else 0
    except Exception:
        return 0


def _raw_count_processed(tenant_id: str | None = None) -> int:
    try:
        query = storage.client.table("raw_messages").select("id", count="exact").eq("processed", True)
        if tenant_id:
            query = query.eq("tenant_id", tenant_id)
        res = query.execute()
        return res.count if hasattr(res, "count") else 0
    except Exception:
        return 0


def _raw_extraction_lag(tenant_id: str | None = None) -> dict:
    now = datetime.now(timezone.utc)
    cutoff_15m = (now - timedelta(minutes=15)).isoformat()
    cutoff_60m = (now - timedelta(hours=1)).isoformat()
    pending_over_15m = 0
    pending_over_60m = 0
    oldest_pending_at = None
    try:
        query = storage.client.table("raw_messages").select("created_at", count="exact").eq("processed", False).filter("created_at", "lt", cutoff_15m)
        if tenant_id:
            query = query.eq("tenant_id", tenant_id)
        res = query.execute()
        pending_over_15m = res.count if hasattr(res, "count") else 0
    except Exception:
        pass
    try:
        query = storage.client.table("raw_messages").select("created_at", count="exact").eq("processed", False).filter("created_at", "lt", cutoff_60m)
        if tenant_id:
            query = query.eq("tenant_id", tenant_id)
        res = query.execute()
        pending_over_60m = res.count if hasattr(res, "count") else 0
    except Exception:
        pass
    try:
        query = storage.client.table("raw_messages").select("created_at").eq("processed", False).order("created_at", desc=False).limit(1)
        if tenant_id:
            query = query.eq("tenant_id", tenant_id)
        res = query.execute()
        if res.data:
            oldest_pending_at = res.data[0].get("created_at")
    except Exception:
        pass
    oldest_pending_age_minutes = None
    if oldest_pending_at:
        try:
            oldest_dt = datetime.fromisoformat(str(oldest_pending_at).replace("Z", "+00:00"))
            oldest_pending_age_minutes = max(0, int((now - oldest_dt).total_seconds() // 60))
        except Exception:
            oldest_pending_age_minutes = None
    if pending_over_60m > 0:
        status = "error"
    elif pending_over_15m > 0:
        status = "warning"
    else:
        status = "healthy"
    return {
        "status": status,
        "pending_over_15m": pending_over_15m,
        "pending_over_60m": pending_over_60m,
        "oldest_pending_at": oldest_pending_at,
        "oldest_pending_age_minutes": oldest_pending_age_minutes,
    }


def _select_workspace_whatsapp_status(phones: list[dict], statuses: list[dict]) -> dict:
    broker_ids = {str(phone.get("broker_id") or "") for phone in phones}
    broker_ids.discard("")
    owned_statuses = [
        status
        for status in statuses
        if str(status.get("broker_id") or "") in broker_ids
    ]
    return next((status for status in owned_statuses if status.get("connected")), None) or (
        owned_statuses[0] if owned_statuses else {}
    )


# ── Routes ─────────────────────────────────────────────────────────

@router.get("/api/dashboard/time-window")
async def dashboard_time_window(window: str = "today", user: dict = Depends(require_user)):
    now = datetime.now(timezone.utc)
    windows = {
        "today":      (now.strftime("%Y-%m-%d"), now.strftime("%Y-%m-%d")),
        "yesterday":  ((now - timedelta(days=1)).strftime("%Y-%m-%d"), (now - timedelta(days=1)).strftime("%Y-%m-%d")),
        "7d":         ((now - timedelta(days=6)).strftime("%Y-%m-%d"), now.strftime("%Y-%m-%d")),
        "30d":        ((now - timedelta(days=29)).strftime("%Y-%m-%d"), now.strftime("%Y-%m-%d")),
    }
    labels = {
        "today": "Today",
        "yesterday": "Yesterday",
        "7d": "Last 7 Days",
        "30d": "Last 30 Days",
        "all": "All Time",
    }
    if window == "all":
        start_date, end_date = None, None
    elif window in windows:
        start_date, end_date = windows[window]
    else:
        start_date, end_date = windows["today"]

    if start_date:
        msg_count = storage.db.execute(
            "SELECT COUNT(*) FROM raw_messages WHERE date(timestamp) >= ? AND date(timestamp) <= ?",
            (start_date, end_date),
        ).fetchone()[0]
        total_msgs = storage.db.execute("SELECT COUNT(*) FROM raw_messages").fetchone()[0]
        listings_in_window = storage.db.execute(
            """SELECT COALESCE(p.intent, p.message_type, 'UNKNOWN') as intent, COUNT(DISTINCT l.id) as c
               FROM listings l
               JOIN listing_observations lo ON lo.listing_id = l.id
               LEFT JOIN parsed_output p ON p.id = lo.parsed_id
               WHERE date(lo.seen_at) >= ? AND date(lo.seen_at) <= ?
               GROUP BY 1""",
            (start_date, end_date),
        ).fetchall()
        total_listings = storage.db.execute("SELECT COUNT(*) FROM listings").fetchone()[0]
        needs_review = storage.db.execute(
            "SELECT COUNT(*) FROM parsed_output WHERE date(created_at) >= ? AND date(created_at) <= ? AND confidence < 0.5",
            (start_date, end_date),
        ).fetchone()[0]
        total_needs_review = storage.db.execute(
            "SELECT COUNT(*) FROM parsed_output WHERE confidence < 0.5"
        ).fetchone()[0]
    else:
        msg_count = storage.db.execute("SELECT COUNT(*) FROM raw_messages").fetchone()[0]
        total_msgs = msg_count
        listings_in_window = storage.db.execute(
            """SELECT COALESCE(p.intent, p.message_type, 'UNKNOWN') as intent, COUNT(DISTINCT l.id) as c
               FROM listings l
               JOIN listing_observations lo ON lo.listing_id = l.id
               LEFT JOIN parsed_output p ON p.id = lo.parsed_id
               GROUP BY 1""",
        ).fetchall()
        total_listings = storage.db.execute("SELECT COUNT(*) FROM listings").fetchone()[0]
        needs_review = storage.db.execute("SELECT COUNT(*) FROM parsed_output WHERE confidence < 0.5").fetchone()[0]
        total_needs_review = needs_review

    intents = {r["intent"]: r["c"] for r in listings_in_window}

    return {
        "window": window,
        "label": labels.get(window, "Today"),
        "messages": msg_count,
        "total_messages": total_msgs,
        "supply": intents.get("SELL", 0),
        "total_supply": intents.get("SELL", 0) if window == "all" else storage.db.execute("SELECT COUNT(*) FROM listings WHERE intent='SELL'").fetchone()[0],
        "demand": intents.get("BUY", 0),
        "total_demand": intents.get("BUY", 0) if window == "all" else storage.db.execute("SELECT COUNT(*) FROM listings WHERE intent='BUY'").fetchone()[0],
        "rentals": intents.get("RENT", 0) + intents.get("COMMERCIAL", 0),
        "total_rentals": (intents.get("RENT", 0) + intents.get("COMMERCIAL", 0)) if window == "all" else storage.db.execute("SELECT COUNT(*) FROM listings WHERE intent IN ('RENT','COMMERCIAL')").fetchone()[0],
        "needs_review": needs_review,
        "total_needs_review": total_needs_review,
        "start_date": start_date,
        "end_date": end_date,
    }


@router.get("/api/dashboard/activity")
async def dashboard_activity(user: dict = Depends(require_user)):
    today = _today_prefix()
    activity = storage.dashboard_activity(today)
    types = storage.dashboard_message_types_today(today)
    type_map = {}
    for t in types:
        type_map[t["intent"]] = t["c"]
    activity["message_types"] = type_map
    obs_types = storage.dashboard_obs_types_today(today)
    obs_map = {}
    for t in obs_types:
        obs_map[t["message_type"]] = t["c"]
    activity["observation_types"] = obs_map
    return activity


@router.get("/api/dashboard/listings")
async def dashboard_listings(limit: int = 20, user: dict = Depends(require_user)):
    return storage.dashboard_listings(limit)


@router.get("/api/dashboard/requirements")
async def dashboard_requirements(limit: int = 20, user: dict = Depends(require_user)):
    return storage.dashboard_requirements(limit)


@router.get("/api/dashboard/signals")
async def dashboard_signals(user: dict = Depends(require_user)):
    return storage.dashboard_signals()


@router.get("/api/dashboard/coverage")
async def dashboard_coverage(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    stats = storage.get_stats()
    cache = _load_evidence_cache()
    buildings = cache.get("buildings", {})
    landmarks = cache.get("landmarks_by_name", {})
    dev_buildings = cache.get("dev_buildings", {})
    micro_markets = set()
    for lm in cache.get("landmarks_list", []):
        mm = lm.get("micro_market")
        if mm:
            micro_markets.add(mm)
    jobs = storage.get_sync_jobs(limit=500)
    group_ids = set(j.group_id for j in jobs)
    synced_jobs = [j for j in jobs if j.records_processed and j.records_processed > 0]
    messages_from_groups = sum(j.records_processed or 0 for j in jobs)
    listings_known = storage.db.execute("SELECT COUNT(*) AS c FROM listings").fetchone()["c"]
    return {
        "groups_connected": len(group_ids),
        "messages_stored": stats["total_raw"],
        "listings_known": listings_known,
        "messages_from_groups": 0,
        "capture_mode": "live_webhook_only",
        "business_window": business_window_status(),
        "buildings_known": len(buildings),
        "landmarks_known": len(landmarks),
        "developers_known": len(dev_buildings),
        "micro_markets_known": len(micro_markets),
    }


@router.get("/api/action/dashboard")
async def action_dashboard(user: dict = Depends(require_user)):
    stats = storage.get_stats()
    today = datetime.utcnow().strftime("%Y-%m-%d")
    unresolved_count = stats.get("unresolved", 0)
    suggestions_pending = storage.db.execute(
        "SELECT COUNT(*) AS c FROM ai_suggestions WHERE status = 'pending'"
    ).fetchone()["c"]
    new_buildings_today = storage.db.execute("""
        SELECT COUNT(*) AS c FROM (
            SELECT DISTINCT rd.building_name
            FROM resolver_decisions rd
            JOIN parsed_output p ON p.id = rd.parsed_id
            WHERE DATE(p.created_at) = ? AND rd.building_name IS NOT NULL
        )
    """, (today,)).fetchone()["c"]
    dup_brokers = storage.db.execute("""
        SELECT COUNT(*) AS c FROM ai_suggestions
        WHERE agent = 'merge_broker' AND status IN ('pending', 'approved')
    """).fetchone()["c"]
    dup_listings = storage.db.execute("""
        SELECT COUNT(*) AS c FROM ai_suggestions
        WHERE suggestion_type = 'duplicate' AND status IN ('pending', 'approved')
    """).fetchone()["c"]
    low_confidence = storage.db.execute("""
        SELECT COUNT(*) AS c FROM parsed_output
        WHERE confidence < 0.5
    """).fetchone()["c"]
    disconnected_groups = storage.db.execute("""
        SELECT COUNT(*) AS c FROM sync_checkpoints
        WHERE status IN ('error', 'disconnected')
    """).fetchone()["c"]
    unknown_locations = storage.db.execute("""
        SELECT COUNT(*) AS c FROM resolver_decisions
        WHERE method = 'unresolved'
    """).fetchone()["c"]
    pending_buildings = storage.db.execute("""
        SELECT COUNT(*) AS c FROM ai_suggestions
        WHERE agent = 'building' AND status = 'pending'
    """).fetchone()["c"]
    top_failures = [dict(r) for r in storage.db.execute("""
        SELECT failure_category, COUNT(*) AS c
        FROM resolver_decisions
        WHERE failure_category IS NOT NULL AND failure_category != ''
        GROUP BY failure_category
        ORDER BY c DESC
        LIMIT 5
    """).fetchall()]
    return {
        "pending_review_unresolved": unresolved_count,
        "pending_ai_suggestions": suggestions_pending,
        "new_buildings_today": new_buildings_today,
        "duplicate_brokers_detected": dup_brokers,
        "duplicate_listings_detected": dup_listings,
        "low_confidence_parses": low_confidence,
        "disconnected_groups": disconnected_groups,
        "unknown_locations": unknown_locations,
        "buildings_pending_approval": pending_buildings,
        "top_parser_failures": top_failures,
    }


@router.get("/api/dashboard/live-window")
async def dashboard_live_window(user: dict = Depends(require_user)):
    return business_window_status()


@router.get("/api/dashboard/feed")
async def dashboard_feed(limit: int = 20, user: dict = Depends(require_user)):
    return storage.dashboard_feed(limit)


@router.get("/api/dashboard/heatmap")
async def dashboard_heatmap(user: dict = Depends(require_user)):
    return storage.dashboard_heatmap()


@router.get("/api/dashboard/sync-activity")
async def dashboard_sync_activity(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    try:
        overall = get_scheduler().status().get("overall", "idle")
    except Exception:
        overall = "idle"
    jobs = []
    all_jobs = []
    try:
        all_jobs = await asyncio.to_thread(storage.get_sync_jobs, limit=500, source="whatsapp") if storage else []
        jobs = [j for j in all_jobs if getattr(j, "status", "") == "running"]
    except Exception as exc:
        print(f"[sync-activity] sync_jobs unavailable: {exc}", flush=True)
    running = None
    if jobs:
        j = jobs[0]
        running = {
            "group_name": getattr(j, "group_name", "") or getattr(j, "group_id", ""),
            "group_id": getattr(j, "group_id", ""),
            "records_found": getattr(j, "records_found", 0) or 0,
            "records_processed": getattr(j, "records_processed", 0) or 0,
        }
    raw_total = 0
    raw_processed = 0
    try:
        raw_total, raw_processed = await asyncio.gather(
            asyncio.to_thread(_raw_count_all, tenant_id),
            asyncio.to_thread(_raw_count_processed, tenant_id),
        )
    except Exception:
        pass
    lag = await asyncio.to_thread(_raw_extraction_lag, tenant_id)
    return {
        "overall": overall,
        "total_jobs": len(all_jobs),
        "running": running,
        "extraction": {
            "total_raw": raw_total,
            "processed": raw_processed,
            "pending": raw_total - raw_processed,
            "pct": round(raw_processed / raw_total * 100, 1) if raw_total else 0,
            "lag": lag,
        },
    }


@router.get("/api/extraction/progress")
async def extraction_progress(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    total, processed = await asyncio.gather(
        asyncio.to_thread(_raw_count_all, tenant_id),
        asyncio.to_thread(_raw_count_processed, tenant_id),
    )
    pending = total - processed
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    recent_processed = 0
    try:
        res = storage.client.table("raw_messages").select("id", count="exact").eq("processed", True).gte("processed_at", cutoff).execute()
        recent_processed = res.count if hasattr(res, "count") else 0
    except Exception:
        pass
    lag = await asyncio.to_thread(_raw_extraction_lag, tenant_id)
    return {
        "total_raw_messages": total,
        "processed": processed,
        "pending": pending,
        "progress_pct": round(processed / total * 100, 1) if total else 0,
        "recently_processed_1h": recent_processed,
        "lag": lag,
    }


@router.get("/api/dashboard/graph-growth")
async def dashboard_graph_growth(user: dict = Depends(require_user)):
    today = _today_prefix()
    growth = storage.dashboard_growth(today)
    cache = _load_evidence_cache()
    known_buildings = set(k.lower() for k in cache.get("buildings", {}))
    known_landmarks = set(k.lower() for k in cache.get("landmarks_by_name", {}))
    today_timeline = growth["timeline"][-1] if growth["timeline"] else None
    today_new = {"buildings": [], "landmarks": [], "developers": []}
    if today_timeline and today_timeline["day"] == today:
        for b in today_timeline.get("buildings", []):
            today_new["buildings"].append({"name": b, "known_in_evidence": b in known_buildings})
        for l in today_timeline.get("landmarks", []):
            today_new["landmarks"].append({"name": l, "known_in_evidence": l in known_landmarks})
        for d in today_timeline.get("developers", []):
            today_new["developers"].append({"name": d, "known_in_evidence": False})
    return {
        "timeline": growth["timeline"],
        "totals": {
            "buildings": growth["total_buildings"],
            "landmarks": growth["total_landmarks"],
            "developers": growth["total_developers"],
        },
        "today_new": today_new,
    }


# ── Placeholders (wired by app.py at startup) ──────────────────
_count_table = lambda table: 0
_today_count = lambda table, column="created_at", where="1=1": 0


@router.get("/api/events")
async def event_stream(request: Request, user: dict = Depends(require_user)):
    """Server-Sent Events endpoint. Subscribe to pipeline events."""
    bus = get_bus()
    queue = bus.sse_queue()

    async def generate():
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15)
                    yield f"event: {event['type']}\ndata: {json.dumps(event)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            bus.remove_queue(queue)

    return StreamingResponse(generate(), media_type="text/event-stream")


@router.get("/api/usage")
async def get_usage(user: dict = Depends(require_user)):
    """System-wide usage stats for the sidebar page."""
    stats = storage.get_stats()
    groups = _count_table("source_sync_jobs")
    chat_sessions = _count_table("ai_chat_sessions")
    chat_messages = _count_table("ai_chat_messages")
    ai_today = _today_count("ai_usage_log")
    messages_today = _today_count("raw_messages", "timestamp")
    last_sync_row = storage.db.execute(
        "SELECT MAX(timestamp) AS ts FROM raw_messages"
    ).fetchone()
    last_sync = last_sync_row["ts"] if last_sync_row else None
    broker_phone = None
    try:
        row = storage.db.execute(
            "SELECT value FROM business_api_config WHERE key = 'whatsapp_business_number'"
        ).fetchone()
        if row and row["value"]:
            broker_phone = row["value"]
    except Exception:
        pass
    return {
        "total_messages": stats.get("total_messages", 0),
        "total_parsed": stats.get("total_parsed", 0),
        "total_listings": stats.get("total_listings", 0),
        "total_requirements": stats.get("total_requirements", 0),
        "total_brokers": stats.get("total_brokers", 0),
        "total_buildings": stats.get("total_buildings", 0),
        "total_groups": groups,
        "total_chat_sessions": chat_sessions,
        "total_chat_messages": chat_messages,
        "ai_requests_today": ai_today,
        "messages_today": messages_today,
        "last_sync": last_sync,
        "broker_phone": broker_phone,
    }


@router.get("/api/dashboard/whatsapp-status")
async def dashboard_whatsapp_status(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    try:
        org_id = _resolve_active_organization_id(user, tenant_id)
        phones = await asyncio.to_thread(storage.list_org_whatsapp_connections, org_id)
    except Exception as exc:
        print(f"[dashboard] whatsapp-status filter failed: {exc}", flush=True)
        org_id = ""
        phones = []
    details: dict = {}
    if phones:
        statuses_map, ingestor_reachable, ingestor_error = await _merged_ingestor_list(timeout=2)
        statuses: list[dict] = list(statuses_map.values())
        now = time.time()
        statuses.extend(
            status
            for status, seen_at in _broker_live_statuses.values()
            if now - seen_at <= 45
        )
        details = _select_workspace_whatsapp_status(phones, statuses)
        if not details and ingestor_reachable:
            details = {"connection_state": "stopped", "connected": False}
        elif not details and ingestor_error:
            details = {"connection_state": "unavailable", "connected": False}
    phone = details.get("phone_number") or ""
    return {
        "connected": details.get("connected", False),
        "instance": details.get("instance_name", "propai-whatsmeow"),
        "phone": phone,
        "profile": details.get("display_name") or "",
        "status": details.get("connection_state") or "",
        "state": details.get("connection_state") or "",
        "status_stale": bool(details.get("status_stale")),
        "connected_since": details.get("connected_since") or None,
    }
