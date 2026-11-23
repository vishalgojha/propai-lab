"""Usage summary: real broker usage shown separately from automated checks.

Per workspace: setup stage, last real (interactive)
search, searches this week and days the broker came back. Assistant calls and
automation are counted in separate blocks and never added to the human
numbers. Counts cover only events recorded since this tracking shipped; an
empty summary is not proof a broker never used the product before that.
"""
import asyncio
import logging
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException

from routers.common import require_tenant, require_user, storage

logger = logging.getLogger(__name__)
router = APIRouter(tags=["usage"])

WINDOW_DAYS = 30
WEEK_DAYS = 7
EVENT_CAP = 10000


def _day(value: str) -> str:
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(ZoneInfo("Asia/Kolkata")).date().isoformat()
    except (ValueError, TypeError):
        return "unknown"


def _linked(connection: dict) -> bool:
    # A saved active number is a setup milestone, not proof it is online now.
    phone = str(connection.get("phone_number") or "").strip()
    return bool(connection.get("is_active") and phone and not phone.startswith("Unpaired"))


def _stage(days_active: int, ever_searched: bool, connected: bool | None) -> str:
    if days_active >= 2:
        return "returning"
    if ever_searched:
        return "first_search"
    if connected is None:
        return "setup_unknown"
    if connected:
        return "whatsapp_connected"
    return "signed_up"


def _empty_block() -> dict:
    return {"searches_last_7_days": 0, "last_at": None}


@router.get("/api/admin/usage/brokers")
async def admin_broker_usage(user: dict = Depends(require_user)):
    """Per-broker product usage for the owner, across every workspace.

    Every organization appears, including ones with no recorded usage, so an
    untouched workspace is visible rather than silently absent. Automation
    and unlabeled assistant traffic are separate blocks and are never added
    to the human numbers. Counts cover only events recorded since tracking
    shipped.
    """
    if not storage.is_super_admin(user["id"]):
        raise HTTPException(403, "Super admin access required")
    now = datetime.now(timezone.utc)
    cutoff = (now - timedelta(days=WINDOW_DAYS)).isoformat()
    week_cutoff = (now - timedelta(days=WEEK_DAYS)).isoformat()

    def _load():
        # Page below PostgREST's default row cap, never silently truncate.
        events = []
        for offset in range(0, 100000, 500):
            page = storage.client.table("broker_usage_events").select(
                "tenant_id,origin,created_at,id"
            ).gte("created_at", cutoff).order(
                "id", desc=True
            ).limit(500).offset(offset).execute().data or []
            events.extend(page)
            if len(page) < 500:
                break
        orgs = []
        for offset in range(0, 100000, 500):
            page = storage.list_organizations(limit=500, offset=offset) or []
            orgs.extend(page)
            if len(page) < 500:
                break
        # Usage needs only setup facts, not the global admin helper's embedded
        # organizations relation (which can be ambiguous with multiple FKs).
        connections = []
        for offset in range(0, 100000, 500):
            page = storage.client.table("org_whatsapp_connections").select(
                "id,organization_id,phone_number,is_active"
            ).order("id").limit(500).offset(offset).execute().data or []
            connections.extend(page)
            if len(page) < 500:
                break
        latest = {}
        for org in orgs:
            tid = str(org["id"])
            row = storage.client.table("broker_usage_events").select(
                "created_at"
            ).eq("tenant_id", tid).eq("origin", "app").order(
                "created_at", desc=True
            ).limit(1).execute().data or []
            latest[tid] = row[0]["created_at"] if row else None
        return events, orgs, connections, latest

    events, orgs, connections, latest = await asyncio.to_thread(_load)
    connected_tenants = {str(c.get("organization_id")) for c in connections if _linked(c)}

    by_tenant: dict[str, list] = {}
    for e in events:
        tid = str(e.get("tenant_id") or "")
        if tid:
            by_tenant.setdefault(tid, []).append(e)

    org_rows = {str(o.get("id")): o for o in orgs if isinstance(o, dict) and o.get("id")}
    tenants = []
    for tid in sorted(set(org_rows) | set(by_tenant)):
        rows = by_tenant.get(tid, [])
        app_events = [e for e in rows if e.get("origin") == "app"]
        app_days = {_day(e.get("created_at")) for e in app_events if e.get("created_at")}
        def _block(origin: str) -> dict:
            o_rows = [e for e in rows if e.get("origin") == origin]
            if not o_rows:
                return _empty_block()
            return {
                "searches_last_7_days": sum(1 for e in o_rows if str(e.get("created_at")) >= week_cutoff),
                "last_at": max((str(e.get("created_at")) for e in o_rows), default=None),
            }

        org = org_rows.get(tid, {})
        tenants.append({
            "tenant_id": tid,
            "org_name": org.get("name"),
            "org_created_at": org.get("created_at"),
            "setup_stage": _stage(len(app_days), bool(app_events or latest.get(tid)), tid in connected_tenants),
            "last_real_search_at": latest.get(tid) or max((str(e.get("created_at")) for e in app_events), default=None),
            "searches_last_7_days": sum(1 for e in app_events if str(e.get("created_at")) >= week_cutoff),
            "days_with_real_search_last_30_days": len(app_days),
            "automation": _block("automation"),
            "assistant_unlabeled": _block("assistant_unlabeled"),
        })

    tenants.sort(key=lambda t: str(t["last_real_search_at"] or ""), reverse=True)
    return {
        "generated_at": now.isoformat(),
        "window_days": WINDOW_DAYS,
        "tenants": tenants,
        "partial": len(events) >= 100000 or len(orgs) >= 100000 or len(connections) >= 100000,
        "day_timezone": "Asia/Kolkata",
        "notes": [
            "App usage counts completed authenticated product search requests, not proven human initiation; automation and assistant_unlabeled are kept separate.",
            "assistant_unlabeled is assistant/API traffic with unknown initiator; it is not human usage.",
            "Counts cover only events recorded since this tracking shipped; an empty summary is not proof of no earlier use.",
        ],
    }


@router.get("/api/usage/summary")
async def usage_summary(user: dict = Depends(require_user), tenant_id: str = Depends(require_tenant)):
    now = datetime.now(timezone.utc)
    cutoff = (now - timedelta(days=WINDOW_DAYS)).isoformat()
    week_cutoff = (now - timedelta(days=WEEK_DAYS)).isoformat()

    def _load():
        events = []
        for offset in range(0, 100000, 500):
            page = storage.client.table("broker_usage_events").select(
                "origin,created_at,id"
            ).eq("tenant_id", tenant_id).gte("created_at", cutoff).order("id", desc=True).limit(500).offset(offset).execute().data or []
            events.extend(page)
            if len(page) < 500:
                break
        latest_app = storage.client.table("broker_usage_events").select(
            "created_at"
        ).eq("tenant_id", tenant_id).eq("origin", "app").order(
            "created_at", desc=True
        ).limit(1).execute().data or []
        try:
            connections = storage.list_org_whatsapp_connections(tenant_id) or []
        except Exception:
            connections = None
        return events, latest_app, connections

    events, latest_app, connections = await asyncio.to_thread(_load)
    connected = None if connections is None else any(_linked(c) for c in connections if isinstance(c, dict))

    app_events = [e for e in events if e.get("origin") == "app"]
    app_days = {_day(e.get("created_at")) for e in app_events if e.get("created_at")}
    ever_searched = bool(app_events or latest_app)

    def _block(origin: str) -> dict:
        rows = [e for e in events if e.get("origin") == origin]
        return {
            "searches_last_7_days": sum(1 for e in rows if str(e.get("created_at")) >= week_cutoff),
            "last_at": max((str(e.get("created_at")) for e in rows), default=None),
        }

    return {
        "tenant_id": tenant_id,
        "partial": len(events) >= 100000,
        "day_timezone": "Asia/Kolkata",
        "generated_at": now.isoformat(),
        "window_days": WINDOW_DAYS,
        "setup_stage": _stage(len(app_days), ever_searched, connected),
        "last_real_search_at": (latest_app[0].get("created_at") if latest_app else None),
        "searches_last_7_days": sum(1 for e in app_events if str(e.get("created_at")) >= week_cutoff),
        "days_with_real_search_last_30_days": len(app_days),
        "automation": _block("automation"),
        "assistant_unlabeled": _block("assistant_unlabeled"),
        "notes": [
            "App usage counts completed authenticated product search requests, not proven human initiation; automation and assistant_unlabeled are kept separate.",
            "assistant_unlabeled is assistant/API traffic with unknown initiator; it is not human usage.",
            "Counts cover only events recorded since this tracking shipped; an empty summary is not proof of no earlier use.",
        ],
    }
