"""
Dashboard routes — metrics, activity, live-window, feed, heatmap, etc.
"""
import asyncio
import json
import logging
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from lab.events import get_bus
from extraction_dedup import content_hash, should_skip, SKIP_EMPTY, SKIP_PLACEHOLDER

from routers.common import (
    storage,
    require_user,
    require_tenant,
    get_tenant_context,
    _resolve_active_organization_id,
)

router = APIRouter(tags=["dashboard"])
_logger = logging.getLogger(__name__)

# ── Helpers (wired from app.py where they depend on global state) ──
_today_prefix = lambda: datetime.now(timezone.utc).strftime("%Y-%m-%d")
_load_evidence_cache = lambda: {}
_broker_live_statuses: dict[str, tuple[dict, float]] = {}
_merged_ingestor_list = lambda timeout=2: ({}, False, "")
_first_ingestor_response = lambda method, path, **kw: (None, None)
business_window_status = lambda: {}
get_scheduler = lambda: None
_extraction_progress_cache: dict[str, tuple[float, dict]] = {}
_extraction_progress_lock = asyncio.Lock()
_EXTRACTION_PROGRESS_TTL_SECONDS = 60.0


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

def _dashboard_count(table: str, tenant_id: str, start_date: str | None = None, end_date: str | None = None, **filters) -> int:
    """Count current typed evidence without going through the retired SQLite bridge."""
    query = storage.client.table(table).select("id", count="exact").eq("tenant_id", tenant_id)
    if start_date:
        query = query.gte("created_at", f"{start_date}T00:00:00Z")
    if end_date:
        next_day = datetime.strptime(end_date, "%Y-%m-%d") + timedelta(days=1)
        query = query.lt("created_at", f"{next_day.strftime('%Y-%m-%d')}T00:00:00Z")
    for column, value in filters.items():
        query = query.eq(column, value)
    response = query.execute()
    return int(response.count or 0)


@router.get("/api/dashboard/time-window")
async def dashboard_time_window(
    window: str = "today",
    user: dict = Depends(require_user),
    tenant_id: str = Depends(require_tenant),
):
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

    try:
        listing_tables = (
            ("residential_sale_listings", "commercial_sale_listings"),
            ("residential_rent_listings", "commercial_rent_listings"),
        )
        requirement_tables = (
            "residential_sale_requirements", "residential_rent_requirements",
            "commercial_sale_requirements", "commercial_rent_requirements",
        )
        listing_tables_all = listing_tables[0] + listing_tables[1]
        listing_tables_sale = listing_tables[0]
        listing_tables_rent = listing_tables[1]

        def count_tables(tables: tuple[str, ...], **filters) -> int:
            return sum(_dashboard_count(table, tenant_id, start_date, end_date, **filters) for table in tables)

        msg_count = _dashboard_count("raw_messages", tenant_id, start_date, end_date)
        total_msgs = _dashboard_count("raw_messages", tenant_id)
        supply = count_tables(listing_tables_sale)
        demand = count_tables(requirement_tables)
        rentals = count_tables(listing_tables_rent)
        total_supply = sum(_dashboard_count(table, tenant_id) for table in listing_tables_sale)
        total_demand = sum(_dashboard_count(table, tenant_id) for table in requirement_tables)
        total_rentals = sum(_dashboard_count(table, tenant_id) for table in listing_tables_rent)
        needs_review = count_tables(listing_tables_all, needs_review=True) + count_tables(requirement_tables, needs_review=True)
        total_needs_review = sum(_dashboard_count(table, tenant_id, needs_review=True) for table in listing_tables_all + requirement_tables)
    except Exception as exc:
        _logger.exception("Dashboard time-window query failed for tenant %s", tenant_id)
        raise HTTPException(status_code=503, detail="Dashboard metrics are temporarily unavailable") from exc

    return {
        "window": window,
        "label": labels.get(window, "Today"),
        "messages": msg_count,
        "total_messages": total_msgs,
        "supply": supply,
        "total_supply": total_supply,
        "demand": demand,
        "total_demand": total_demand,
        "rentals": rentals,
        "total_rentals": total_rentals,
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
    listings_known = storage.db.execute("SELECT COUNT(*) AS c FROM listings_unified").fetchone()["c"]
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
            JOIN parsed_output_unified p ON p.id = rd.parsed_id
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
        SELECT COUNT(*) AS c FROM parsed_output_unified
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
    hours: int = 24,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    window_hours = min(max(int(hours or 24), 1), 168)
    # This broker-facing endpoint is always workspace scoped. Passing a
    # missing tenant through as ``None`` asks the canonical RPC for the
    # platform-wide aggregate, which is both misleading in the Connections
    # UI and needlessly expensive on a large raw_messages table. The separate
    # super-admin endpoint owns platform-wide reporting.
    effective_tenant_id = await asyncio.to_thread(
        _resolve_active_organization_id, user, tenant_id
    )
    if not effective_tenant_id:
        raise HTTPException(403, "No organization membership found")
    cache_key = f"{effective_tenant_id}:{window_hours}"
    cached = _extraction_progress_cache.get(cache_key)
    if cached and time.monotonic() - cached[0] < _EXTRACTION_PROGRESS_TTL_SECONDS:
        return cached[1]

    async with _extraction_progress_lock:
        cached = _extraction_progress_cache.get(cache_key)
        if cached and time.monotonic() - cached[0] < _EXTRACTION_PROGRESS_TTL_SECONDS:
            return cached[1]
        try:
            canonical = await asyncio.to_thread(
                storage.get_workspace_extraction_progress, window_hours, effective_tenant_id
            )
        except Exception as exc:
            _logger.exception(
                "Extraction progress unavailable for tenant=%s hours=%s: %s",
                effective_tenant_id,
                window_hours,
                exc,
            )
            # Observability must not take the dashboard down. Reuse the last
            # known snapshot when available; otherwise return an explicit
            # degraded response with null metrics rather than fake zeros.
            if cached:
                stale = dict(cached[1])
                stale["status"] = "stale"
                stale["degraded"] = True
                stale["warning"] = "Live extraction progress is temporarily unavailable; showing the last captured snapshot."
                return stale
            return {
                "status": "degraded",
                "degraded": True,
                "warning": "Live extraction progress is temporarily unavailable. No counts are being shown until the database check succeeds.",
                "total_raw_messages": None,
                "processed": None,
                "pending": None,
                "suppressed": None,
                "eligible_pending": None,
                "progress_pct": None,
                "recently_processed": None,
                "rate_window_hours": window_hours,
                "lag": {},
            }
        total = int(canonical.get("total_raw_messages") or 0)
        processed = int(canonical.get("processed") or 0)
        pending = int(canonical.get("unprocessed") or 0)
        suppressed = int(canonical.get("suppressed") or 0)
        eligible_pending = int(canonical.get("eligible_pending") or max(pending - suppressed, 0))
        recent_processed = int(canonical.get("processed_recent") or 0)
        result = {
            "total_raw_messages": total,
            "processed": processed,
            "pending": pending,
            "suppressed": suppressed,
            "eligible_pending": eligible_pending,
            "progress_pct": round(processed / total * 100, 1) if total else 0,
            "recently_processed": recent_processed,
            "rate_window_hours": window_hours,
            "lag": {},
        }
        _extraction_progress_cache[cache_key] = (time.monotonic(), result)
        return result


@router.get("/api/extraction/recent-parsed")
async def recent_parsed_messages(
    limit: int = 10,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    """Return the newest typed extraction rows with their raw evidence."""
    limit = min(max(limit, 1), 20)
    try:
        # A bulk WhatsApp message can legitimately produce several typed
        # opportunities. The connection panel is a message activity view,
        # though, so do not render the same raw source once per opportunity.
        # Read a bounded window and keep the newest parsed row for each raw
        # message, while exposing how many opportunities came from it.
        query = storage.client.table("parsed_output_unified").select(
            "id,raw_message_id,created_at,broker_name,broker_phone,"
            "building_name,micro_market,transaction_type,bhk,price,area_sqft"
        ).order("created_at", desc=True).limit(min(limit * 10, 100))
        if tenant_id:
            query = query.eq("tenant_id", tenant_id)
        candidate_rows = query.execute().data or []
        parsed_rows = []
        seen_raw_ids: set[int] = set()
        opportunity_counts: dict[int, int] = {}
        for row in candidate_rows:
            raw_id = row.get("raw_message_id")
            if raw_id is None:
                continue
            raw_id = int(raw_id)
            opportunity_counts[raw_id] = opportunity_counts.get(raw_id, 0) + 1
            if raw_id not in seen_raw_ids:
                parsed_rows.append(row)
                seen_raw_ids.add(raw_id)
        raw_ids = [row.get("raw_message_id") for row in parsed_rows if row.get("raw_message_id")]
        raw_by_id: dict[int, dict] = {}
        if raw_ids:
            raw_query = storage.client.table("raw_messages").select(
                "id,message,group_name,timestamp"
            ).in_("id", raw_ids)
            raw_by_id = {
                int(row["id"]): row
                for row in (raw_query.execute().data or [])
                if row.get("id") is not None
            }
        # The same broadcast is often forwarded into many groups. Keep raw
        # provenance in storage, but collapse byte-identical activity rows in
        # this compact dashboard feed and report the source-group count.
        collapsed: dict[str, dict] = {}
        for row in parsed_rows:
            raw_id = int(row.get("raw_message_id") or 0)
            raw = raw_by_id.get(raw_id) or {}
            message = str(raw.get("message") or "").strip()
            if should_skip(message) in {SKIP_EMPTY, SKIP_PLACEHOLDER}:
                continue
            key = content_hash(message)
            item = collapsed.get(key)
            group_name = str(raw.get("group_name") or "").strip()
            if item is None:
                item = {
                    **row,
                    "opportunity_count": 0,
                    "source_group_count": 0,
                    "source_groups": [],
                    "raw_message": message,
                    "group_name": group_name,
                    "raw_timestamp": raw.get("timestamp") or "",
                }
                collapsed[key] = item
            item["opportunity_count"] += opportunity_counts.get(raw_id, 1)
            if group_name and group_name not in item["source_groups"]:
                item["source_groups"].append(group_name)
                item["source_group_count"] = len(item["source_groups"])
        result = list(collapsed.values())[:limit]
        for item in result:
            groups = item.pop("source_groups", [])
            if len(groups) > 1:
                item["group_name"] = f"{len(groups)} source groups"
        return result
    except Exception:
        return []


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
    # Event delivery is an enhancement to the dashboard, not a prerequisite
    # for loading it.  A stale/reloaded event-bus singleton must never turn the
    # whole endpoint into a 500 (which also makes the browser report a CORS
    # error).  Keep the stream alive and let the normal polling paths continue
    # if the bus cannot be initialized.
    bus = None
    queue = None
    try:
        bus = get_bus()
        queue = bus.sse_queue()
    except Exception:
        import logging
        logging.getLogger(__name__).exception("Could not initialize dashboard event stream")

    async def generate():
        try:
            if queue is None:
                yield 'event: system\ndata: {"type":"events_unavailable","data":{}}\n\n'
                while not await request.is_disconnected():
                    await asyncio.sleep(15)
                    yield ": keepalive\n\n"
                return
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15)
                    yield f"event: {event['type']}\ndata: {json.dumps(event)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            if bus is not None and queue is not None:
                bus.remove_queue(queue)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


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
