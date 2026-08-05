"""Business API management routes — overview, team, sessions, audit, etc."""
import asyncio
import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from routers.common import (
    storage,
    require_user,
    get_tenant_context,
    _resolve_active_organization_id,
)

router = APIRouter(tags=["business_api_admin"])

COMPANION_ROLES = {
    "administrator": {
        "label": "Administrator",
        "permissions": ["full_access", "configure_ai", "configure_waba", "approve_users"],
    },
    "manager": {
        "label": "Manager",
        "permissions": ["read_all", "update_listings", "manage_buyers", "use_ai"],
    },
    "sales_agent": {
        "label": "Sales Agent",
        "permissions": ["view_assigned_inventory", "query_ai", "create_requirements", "promote_listings"],
    },
    "read_only": {
        "label": "Read-only",
        "permissions": ["search_only"],
    },
}

COMPANION_TOOLS = [
    "My Inventory",
    "My Buyers",
    "Market Listings",
    "Market Buyers",
    "Buildings",
    "Brokers",
    "Groups",
    "Markets",
    "Knowledge Graph",
    "Review Center",
    "Promotions",
    "Search",
]

PROPAI_SHARED_WABA_NUMBER = ""

MEDIA_DIR = Path(__file__).resolve().parent.parent / "media" / "listing_photos"

BUSINESS_TIMEZONE = "Asia/Kolkata"
BUSINESS_START_HOUR = 10
BUSINESS_END_HOUR = 19


class BusinessApiTeamMemberRequest(BaseModel):
    name: str
    mobile_number: str
    role: str = "sales_agent"
    assigned_markets: list[str] = []
    active: bool = True
    waba_identity: str = ""


_BUSINESS_API_PERSISTABLE_TYPES: frozenset[str] = frozenset({
    "text", "image", "video", "audio", "document", "sticker",
    "location", "contacts",
})


# ── Placeholders (wired by app.py at startup) ───────────────────
_count_table = lambda table: 0
_today_count = lambda table, column="created_at", where="1=1": 0
_platform_waba_values = lambda: {}
_workspace_waba_values = lambda org_id: {}
_business_api_member = lambda row: {}
_mobile_digits = lambda value="": ""
_is_propai_shared_waba = lambda value="": False
_business_api_get_config_value = lambda key, env_key="": ""
_mask_secret = lambda value="": ""
_waba_callback_url = lambda org_id=None: ""
_waba_session_update = lambda chat_id, direction="inbound": None
_waba_session_status = lambda chat_id: {"active": False, "remaining_seconds": 0, "last_user_at": None, "expired": True}


# ── Routes ─────────────────────────────────────────────────────────

@router.get("/api/business-api/overview")
async def business_api_overview(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    team_count = _count_table("business_api_team_members")
    active_team = storage.db.execute(
        "SELECT COUNT(*) AS c FROM business_api_team_members WHERE active = 1"
    ).fetchone()["c"]
    pending_conversations = storage.db.execute(
        "SELECT COUNT(*) AS c FROM business_api_conversations WHERE status IN ('needs_human', 'pending_approval')"
    ).fetchone()["c"]
    last_sync_row = storage.db.execute(
        "SELECT MAX(timestamp) AS ts FROM raw_messages"
    ).fetchone()
    last_sync = last_sync_row["ts"] if last_sync_row else None
    inbound_today = _today_count("business_api_messages", where="direction = 'inbound'")
    outbound_today = _today_count("business_api_messages", where="direction = 'outbound'")
    ai_today = _today_count("ai_usage_log")
    messages_today = _today_count("raw_messages", "timestamp")
    is_super_admin = await asyncio.to_thread(storage.is_super_admin, user["id"])
    if is_super_admin:
        waba_values = _platform_waba_values()
    else:
        org_id = _resolve_active_organization_id(user, tenant_id)
        waba_values = await _workspace_waba_values(org_id)
    waba_number = str(waba_values.get("whatsapp_business_number") or "")
    waba_phone_number_id = str(waba_values.get("phone_number_id") or "")
    waba_access_token = str(waba_values.get("access_token") or "")
    waba_verify_token = str(waba_values.get("verify_token") or "")
    waba_is_shared = _is_propai_shared_waba(waba_number)
    outbound_allowed = bool(
        waba_number
        and waba_phone_number_id
        and waba_access_token
        and (is_super_admin or not waba_is_shared)
    )
    webhook_health = "ready" if waba_verify_token else "not_configured"
    token_status = "configured" if waba_access_token else "missing"

    knowledge_base_size = {
        "my_inventory": _count_table("listings_unified"),
        "market_listings": _count_table("listings_unified"),
        "market_buyers": storage.db.execute(
            "SELECT COUNT(*) AS c FROM requirements_unified"
        ).fetchone()["c"],
        "brokers": _count_table("brokers"),
        "groups": _count_table("source_sync_jobs"),
        "markets": storage.db.execute(
            "SELECT COUNT(DISTINCT micro_market) AS c FROM parsed_output_unified WHERE micro_market IS NOT NULL AND micro_market != ''"
        ).fetchone()["c"],
    }

    return {
        "connection_status": "connected" if outbound_allowed else "not_connected",
        "whatsapp_business_number": waba_number,
        "shared_waba_number": waba_number if waba_is_shared else "",
        "waba_owner": "propai" if waba_is_shared else ("broker" if waba_number else "none"),
        "outbound_allowed": outbound_allowed,
        "connected_team_members": active_team,
        "total_team_members": team_count,
        "last_sync": last_sync,
        "messages_today": messages_today,
        "ai_requests_today": ai_today,
        "pending_conversations": pending_conversations,
        "outbound_messages": outbound_today,
        "inbound_messages": inbound_today,
        "webhook_health": webhook_health,
        "token_status": token_status,
        "knowledge_base_size": knowledge_base_size,
        "waba": {
            "phone_number_id": waba_phone_number_id,
            "has_verify_token": bool(waba_verify_token),
            "has_access_token": bool(waba_access_token),
        },
    }


@router.get("/api/business-api/webhook")
async def business_api_webhook_verify(request: Request):
    mode = request.query_params.get("hub.mode", "")
    token = request.query_params.get("hub.verify_token", "")
    challenge = request.query_params.get("hub.challenge", "")
    expected = _business_api_get_config_value("verify_token", "WABA_VERIFY_TOKEN")
    if mode == "subscribe" and expected and token == expected:
        return Response(content=challenge, media_type="text/plain")
    raise HTTPException(403, "Webhook verify token does not match")


@router.get("/api/waba/session/{chat_id:path}")
async def waba_session_status(chat_id: str, user: dict = Depends(require_user)):
    """Check 24h session window for a given chat_id (e.g. '919876543210@s.whatsapp.net')."""
    return _waba_session_status(chat_id)


@router.get("/api/waba/sessions")
async def waba_sessions_bulk(user: dict = Depends(require_user)):
    """Get all active session statuses. Returns list of {chat_id, active, remaining_seconds, last_user_at}."""
    try:
        rows = storage.db.execute(
            "SELECT chat_id, last_user_at, session_active FROM waba_sessions WHERE session_active = true ORDER BY last_user_at DESC"
        ).fetchall()
        results = []
        now = datetime.now(timezone.utc)
        for row in rows:
            last_user_at_str = row["last_user_at"]
            if isinstance(last_user_at_str, str):
                last_user_at = datetime.fromisoformat(last_user_at_str.replace("Z", "+00:00"))
            else:
                last_user_at = last_user_at_str
            elapsed = (now - last_user_at).total_seconds()
            remaining = max(0, 86400 - elapsed)
            results.append({
                "chat_id": row["chat_id"],
                "active": remaining > 0,
                "remaining_seconds": int(remaining),
                "last_user_at": last_user_at_str,
            })
        return results
    except Exception as exc:
        return JSONResponse(status_code=500, content={"error": str(exc)})


@router.get("/api/business-api/team")
async def business_api_team(user: dict = Depends(require_user)):
    rows = storage.db.execute(
        "SELECT * FROM business_api_team_members ORDER BY active DESC, name COLLATE NOCASE"
    ).fetchall()
    return [_business_api_member(row) for row in rows]


@router.patch("/api/business-api/team/{member_id}")
async def business_api_update_team_member(member_id: int, req: BusinessApiTeamMemberRequest, user: dict = Depends(require_user)):
    if req.role not in COMPANION_ROLES:
        raise HTTPException(400, "Invalid role")
    mobile = _mobile_digits(req.mobile_number)
    if len(mobile) < 10:
        raise HTTPException(400, "Valid mobile number is required")
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    storage.db.execute(
        """UPDATE business_api_team_members
           SET name = ?, mobile_number = ?, role = ?, assigned_markets = ?,
               active = ?, waba_identity = ?, updated_at = ?
           WHERE id = ?""",
        (
            req.name.strip(),
            mobile,
            req.role,
            json.dumps(req.assigned_markets),
            1 if req.active else 0,
            req.waba_identity.strip(),
            now,
            member_id,
        ),
    )
    storage.db.execute(
        """INSERT INTO business_api_audit_log
           (team_member_id, action, target_type, target_id, status, details, created_at)
           VALUES (?,?,?,?,?,?,?)""",
        (member_id, "team_member_updated", "team_member", str(member_id), "logged", "{}", now),
    )
    row = storage.db.execute("SELECT * FROM business_api_team_members WHERE id = ?", (member_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Team member not found")
    return _business_api_member(row)


@router.get("/api/business-api/roles")
async def business_api_roles(user: dict = Depends(require_user)):
    return COMPANION_ROLES


@router.get("/api/business-api/tools")
async def business_api_tools(user: dict = Depends(require_user)):
    return {"tools": COMPANION_TOOLS}


@router.get("/api/business-api/conversations")
async def business_api_conversations(limit: int = 20, user: dict = Depends(require_user)):
    rows = storage.db.execute(
        """SELECT c.*, t.name AS team_member_name, t.role AS team_member_role
           FROM business_api_conversations c
           LEFT JOIN business_api_team_members t ON t.id = c.team_member_id
           ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
           LIMIT ?""",
        (limit,),
    ).fetchall()
    return [dict(row) for row in rows]


@router.get("/api/business-api/audit")
async def business_api_audit(limit: int = 30, user: dict = Depends(require_user)):
    rows = storage.db.execute(
        """SELECT a.*, t.name AS team_member_name
           FROM business_api_audit_log a
           LEFT JOIN business_api_team_members t ON t.id = a.team_member_id
           ORDER BY a.created_at DESC
           LIMIT ?""",
        (limit,),
    ).fetchall()
    return [dict(row) for row in rows]
