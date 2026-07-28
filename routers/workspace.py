"""Workspace and inbox routes."""
import asyncio
import hmac
import json
import logging
import os
import time
import uuid
from dataclasses import asdict
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel

from routers.common import (
    storage,
    get_current_user,
    require_user,
    get_tenant_context,
    get_current_team_member,
    get_current_member,
    check_permission,
    _resolve_active_organization_id,
    _require_org_permission,
)
from storage import LLMProvider

router = APIRouter(tags=["workspace"])

# Placeholder — wired from app.py after _probe_provider definition
_probe_provider = None


_PERMISSION_DEFS = [
    {"key": "view_inbox", "label": "View Market Inbox"},
    {"key": "reply_whatsapp", "label": "Reply from WhatsApp"},
    {"key": "save_requirements", "label": "Save Requirements"},
    {"key": "save_listings", "label": "Save Listings"},
    {"key": "export_contacts", "label": "Export Contacts"},
    {"key": "view_broker_numbers", "label": "View Broker Numbers"},
    {"key": "add_team_members", "label": "Add Team Members"},
    {"key": "remove_team_members", "label": "Remove Team Members"},
    {"key": "delete_data", "label": "Delete Data"},
    {"key": "ai_actions", "label": "AI Actions"},
    {"key": "bulk_broadcast", "label": "Bulk Broadcast"},
]


# ── Inbox ──────────────────────────────────────────────────────────


@router.get("/api/inbox/threads")
async def inbox_threads(
    request: Request,
    user: dict | None = Depends(get_current_user),
    limit: int = 500, offset: int = 0,
    tenant_id: str | None = Depends(get_tenant_context),
):
    if user is None:
        expected = (os.getenv("PROPAI_INTERNAL_TOKEN", "").strip()
                    or os.getenv("SUPABASE_SERVICE_KEY", "").strip())
        supplied = request.headers.get("X-PropAI-Internal-Token", "").strip()
        if not expected or not hmac.compare_digest(supplied, expected):
            raise HTTPException(401, "Authentication required")
    return storage.get_inbox_threads(limit, offset, tenant_id=tenant_id)


@router.get("/api/inbox/slugs")
async def inbox_slugs(user: dict = Depends(require_user)):
    return [
        {"slug": "brokers", "label": "Brokers", "view_type": "brokers", "is_default": True},
    ]


@router.get("/api/inbox/views")
async def get_saved_inbox_views(user: dict = Depends(require_user), tenant_id: str | None = Depends(get_tenant_context)):
    return storage.get_saved_inbox_views(tenant_id=tenant_id)


@router.get("/api/inbox/views/{slug}")
async def get_saved_inbox_view(slug: str, user: dict = Depends(require_user), tenant_id: str | None = Depends(get_tenant_context)):
    view = storage.get_saved_inbox_view(slug, tenant_id=tenant_id)
    if view is None:
        raise HTTPException(status_code=404, detail="View not found")
    return view


@router.post("/api/inbox/views")
async def create_saved_inbox_view(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
    slug: str = "",
    name: str = "",
    filters: dict = {},
    description: str = "",
    is_default: bool = False,
    is_shared: bool = False,
):
    try:
        view_id = storage.create_saved_inbox_view(slug, name, filters, description, is_default, is_shared, tenant_id=tenant_id)
        return {"id": view_id, "slug": slug, "name": name}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.put("/api/inbox/views/{slug}")
async def update_saved_inbox_view(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
    slug: str = "",
    name: str | None = None,
    filters: dict | None = None,
    description: str | None = None,
    is_default: bool | None = None,
    is_shared: bool | None = None,
):
    ok = storage.update_saved_inbox_view(slug, name, filters, description, is_default, is_shared, tenant_id=tenant_id)
    if not ok:
        raise HTTPException(status_code=404, detail="View not found")
    return {"ok": True, "slug": slug}


@router.delete("/api/inbox/views/{slug}")
async def delete_saved_inbox_view(slug: str, user: dict = Depends(require_user), tenant_id: str | None = Depends(get_tenant_context)):
    ok = storage.delete_saved_inbox_view(slug, tenant_id=tenant_id)
    if not ok:
        raise HTTPException(status_code=404, detail="View not found")
    return {"ok": True, "slug": slug}


# ── Workspace ──────────────────────────────────────────────────────


@router.get("/api/workspace/permissions")
async def workspace_permissions(user: dict = Depends(require_user)):
    return {"permissions": _PERMISSION_DEFS}


@router.get("/api/workspace/me")
async def workspace_me(member: dict = Depends(get_current_team_member)):
    return member


@router.get("/api/workspace/members")
async def list_team_members(member: dict = Depends(get_current_member)):
    members = storage.list_team_members()
    for m in members:
        m["permission_keys"] = storage._perm_keys(m["permissions"])
    return {"members": members}


@router.get("/api/workspace/members/{member_id}")
async def get_team_member(member_id: int, member: dict = Depends(get_current_member)):
    m = storage.get_team_member(member_id)
    if not m:
        raise HTTPException(404, "Team member not found")
    m["permission_keys"] = storage._perm_keys(m["permissions"])
    return m


@router.post("/api/workspace/members")
async def create_team_member(body: dict, member: dict = Depends(get_current_member)):
    check_permission(member, "add_team_members")
    if not body.get("name"):
        raise HTTPException(400, "name is required")
    m = storage.create_team_member(
        name=body["name"],
        email=body.get("email", ""),
        phone=body.get("phone", ""),
        role=body.get("role", "member"),
        permission_keys=body.get("permission_keys"),
        linked_broker_phone=body.get("linked_broker_phone"),
    )
    return m


@router.put("/api/workspace/members/{member_id}")
async def update_team_member(member_id: int, body: dict, member: dict = Depends(get_current_member)):
    check_permission(member, "add_team_members")
    m = storage.update_team_member(member_id, **body)
    if not m:
        raise HTTPException(404, "Team member not found")
    m["permission_keys"] = storage._perm_keys(m["permissions"])
    return m


@router.delete("/api/workspace/members/{member_id}")
async def deactivate_team_member(member_id: int, member: dict = Depends(get_current_member)):
    check_permission(member, "remove_team_members")
    ok = storage.deactivate_team_member(member_id)
    return {"deleted": ok}


@router.get("/api/workspace/roles")
async def list_team_roles(user: dict = Depends(require_user)):
    return {"roles": storage.list_team_roles()}


@router.post("/api/workspace/roles")
async def create_team_role(body: dict, member: dict = Depends(get_current_member)):
    check_permission(member, "add_team_members")
    name = body.get("name", "").strip()
    if not name:
        raise HTTPException(400, "Role name is required")
    role = storage.create_team_role(name, body.get("permission_keys", []))
    if not role:
        raise HTTPException(500, "Failed to create role")
    return role


@router.put("/api/workspace/roles/{role_id}")
async def update_team_role(role_id: int, body: dict, member: dict = Depends(get_current_member)):
    check_permission(member, "add_team_members")
    role = storage.get_team_role(role_id)
    if not role:
        raise HTTPException(404, "Role not found")
    if role.get("is_system"):
        raise HTTPException(403, "Cannot edit system roles")
    updated = storage.update_team_role(role_id, body.get("name"), body.get("permission_keys"))
    return updated or {"error": "update failed"}


@router.delete("/api/workspace/roles/{role_id}")
async def delete_team_role(role_id: int, member: dict = Depends(get_current_member)):
    check_permission(member, "add_team_members")
    role = storage.get_team_role(role_id)
    if not role:
        raise HTTPException(404, "Role not found")
    if role.get("is_system"):
        raise HTTPException(403, "Cannot delete system roles")
    ok = storage.delete_team_role(role_id)
    return {"deleted": ok}


@router.get("/api/workspace/activity")
async def list_activity(limit: int = 50, offset: int = 0,
                        action: str = None, team_member_id: int = None,
                        member: dict = Depends(get_current_member)):
    rows = storage.list_activity(
        limit=limit, offset=offset,
        action=action, team_member_id=team_member_id
    )
    return {"activity": rows, "limit": limit, "offset": offset}


@router.post("/api/workspace/activity")
async def log_activity(body: dict, member: dict = Depends(get_current_member)):
    if not body.get("action"):
        raise HTTPException(400, "action is required")
    ident = storage.log_activity(
        team_member_id=member["id"],
        action=body["action"],
        target_type=body.get("target_type", ""),
        target_id=body.get("target_id", ""),
        details=body.get("details"),
        ip_address=body.get("ip_address", ""),
    )
    return {"id": ident}


@router.get("/api/workspace/whatsapp-access")
async def list_whatsapp_access(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    org_id = _resolve_active_organization_id(user, tenant_id)
    await _require_org_permission(user, org_id, "manage_whatsapp")
    rows = await asyncio.to_thread(storage.list_whatsapp_access, org_id)
    return {"access": rows}


@router.put("/api/workspace/whatsapp-access")
async def set_whatsapp_access(
    body: dict,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    org_id = _resolve_active_organization_id(user, tenant_id)
    await _require_org_permission(user, org_id, "manage_whatsapp")
    required = ("team_member_id", "whatsapp_number")
    for k in required:
        if k not in body:
            raise HTTPException(400, f"{k} is required")
    result = storage.set_whatsapp_access(
        team_member_id=body["team_member_id"],
        whatsapp_number=body["whatsapp_number"],
        can_send=body.get("can_send", False),
        can_view_messages=body.get("can_view_messages", True),
        org_id=org_id,
    )
    if not result:
        raise HTTPException(404, "Team member or WhatsApp phone not found")
    return result


@router.get("/api/workspace/chat-assignment")
async def get_chat_assignment(whatsapp_number: str = "", remote_jid: str = "",
                              member: dict = Depends(get_current_member)):
    if not whatsapp_number or not remote_jid:
        raise HTTPException(400, "whatsapp_number and remote_jid are required")
    result = storage.get_chat_assignment(whatsapp_number, remote_jid)
    return result or {"assigned_to": None, "taken_over_by": None}


@router.post("/api/workspace/chat-assignment/assign")
async def assign_chat(body: dict, member: dict = Depends(get_current_member)):
    check_permission(member, "add_team_members")
    required = ("whatsapp_number", "remote_jid", "team_member_id")
    for k in required:
        if k not in body:
            raise HTTPException(400, f"{k} is required")
    result = storage.assign_chat(
        body["whatsapp_number"], body["remote_jid"], body["team_member_id"]
    )
    return result


@router.post("/api/workspace/chat-assignment/take-over")
async def take_over_chat(body: dict, member: dict = Depends(get_current_member)):
    check_permission(member, "reply_whatsapp")
    required = ("whatsapp_number", "remote_jid", "team_member_id")
    for k in required:
        if k not in body:
            raise HTTPException(400, f"{k} is required")
    result = storage.take_over_chat(
        body["whatsapp_number"], body["remote_jid"], body["team_member_id"]
    )
    return result


@router.post("/api/workspace/chat-assignment/release")
async def release_chat(body: dict, member: dict = Depends(get_current_member)):
    check_permission(member, "reply_whatsapp")
    required = ("whatsapp_number", "remote_jid")
    for k in required:
        if k not in body:
            raise HTTPException(400, f"{k} is required")
    result = storage.release_chat(
        body["whatsapp_number"], body["remote_jid"]
    )
    return result or {}


@router.get("/api/workspace/llm-providers")
async def list_llm_providers(user: dict = Depends(require_user), tenant_id: str | None = Depends(get_tenant_context)):
    tenant_id = await asyncio.to_thread(_resolve_active_organization_id, user, tenant_id)
    providers = storage.get_llm_providers(tenant_id=tenant_id)
    for p in providers:
        if p.api_key and len(p.api_key) > 8:
            p.api_key = p.api_key[:4] + "****" + p.api_key[-4:]
        elif p.api_key:
            p.api_key = "****"
    return {"providers": [asdict(p) for p in providers]}


@router.get("/api/workspace/llm-providers/active")
async def get_active_llm_provider(user: dict = Depends(require_user), tenant_id: str | None = Depends(get_tenant_context)):
    tenant_id = await asyncio.to_thread(_resolve_active_organization_id, user, tenant_id)
    import llm as _llm
    try:
        active = _llm.get_provider_info()
        if active.get("provider_name") and active.get("provider_name") != "none":
            active["source"] = "runtime_env"
            active["source_label"] = "Runtime config (Coolify / env)"
            return active
    except Exception:
        pass
    provider = storage.get_active_llm_provider(tenant_id=tenant_id)
    if not provider:
        return {"provider_name": "none", "base_url": "", "model_name": "", "source": "none", "source_label": "Unconfigured"}
    if provider.api_key:
        provider.api_key = ""
    data = asdict(provider)
    data["source"] = "database"
    data["source_label"] = "Workspace DB"
    return data


@router.post("/api/workspace/llm-providers")
async def save_llm_provider(body: dict, user: dict = Depends(require_user), tenant_id: str | None = Depends(get_tenant_context)):
    tenant_id = await asyncio.to_thread(_resolve_active_organization_id, user, tenant_id)
    required = ("provider_name",)
    for k in required:
        if k not in body:
            raise HTTPException(400, f"{k} is required")
    api_key = str(body.get("api_key", "") or "")
    if "****" in api_key or "••••" in api_key or "●●●●" in api_key:
        api_key = ""
    provider = LLMProvider(
        id=body.get("id", 0),
        provider_name=str(body.get("provider_name", "")),
        provider_type=str(body.get("provider_type", "openai")),
        api_key=api_key,
        base_url=str(body.get("base_url", "")),
        model_name=str(body.get("model_name", "")),
        is_active=1 if body.get("is_active") else 0,
    )
    provider_id = storage.save_llm_provider(provider, tenant_id=tenant_id)
    return {"id": provider_id}


@router.post("/api/workspace/llm-providers/test")
async def test_llm_provider(body: dict, user: dict = Depends(require_user)):
    api_key = str(body.get("api_key", "") or "")
    base_url = str(body.get("base_url", "") or "")
    model_name = str(body.get("model_name", "") or "")
    result = await _probe_provider(api_key, base_url, model_name)
    success = result["status"] in ("ok", "slow")
    out = {"success": success, "status": result["status"],
           "latency_ms": result["latency_ms"], "latency": round(result["latency_ms"] / 1000.0, 2)}
    if result["http_status"] is not None:
        out["http_status"] = result["http_status"]
    if not success:
        out["error"] = result["error_msg"]
    return out


@router.delete("/api/workspace/llm-providers/{provider_id}")
async def delete_llm_provider(provider_id: int, user: dict = Depends(require_user), tenant_id: str | None = Depends(get_tenant_context)):
    tenant_id = await asyncio.to_thread(_resolve_active_organization_id, user, tenant_id)
    ok = storage.delete_llm_provider(provider_id, tenant_id=tenant_id)
    return {"deleted": ok}


# ── Placeholders (wired by app.py at startup) ──────────────────
_connection_details = lambda: {}
_market_sync_ready = lambda details: False
_merged_ingestor_list = lambda timeout=2: ({}, False, "")
_broker_live_statuses: dict[str, tuple[dict, float]] = {}
_first_ingestor_response = lambda method, path, **kw: (None, None)
_table_exists = lambda table: False
_count_table = lambda table: 0
_business_api_get_config_value = lambda key, env_key="": ""


# ── Chat Suggestion Cache ──────────────────────────────────────────
_chip_cache: dict = {}
_chip_cache_at: float = 0.0


# ── Capabilities constants ─────────────────────────────────────────
_CAPTURED_UNUSED_CAPS = frozenset({"Read Receipts", "Typing Presence"})

_ALWAYS_ON_CAPS = frozenset({
    "Outgoing Messages",
    "History Sync",
    "Profile Pictures",
    "Group Directory",
    "Media Download",
    "Media Upload",
    "Self-Chat Agent",
})

_CAPABILITY_TYPE_KEY: dict[str, str] = {
    "Text Messages": "text",
    "Images": "image",
    "Video": "video",
    "Audio": "audio",
    "Documents": "document",
    "Stickers": "sticker",
    "Location": "location",
    "Live Location": "live_location",
    "Contact Cards": "contact",
    "Contact Arrays": "contacts_array",
    "Reactions": "reaction",
    "Poll Creation": "poll_creation",
    "Poll Updates": "poll_update",
    "Edited Messages": "edited",
}

_FALLBACK_CAPABILITIES: list[dict] = [
    {"name": "Text Messages", "icon": "MessageSquare", "description": "Plain text from any group, with sender, group, and timestamp."},
    {"name": "Images", "icon": "Image", "description": "Image messages: caption and sender captured; full media downloaded on demand."},
    {"name": "Video", "icon": "Video", "description": "Video messages: caption plus thumbnail; full download on demand."},
    {"name": "Audio", "icon": "Mic", "description": "Voice notes and audio files; transcribed automatically."},
    {"name": "Documents", "icon": "FileText", "description": "PDFs and file attachments; filename and mimetype captured."},
    {"name": "Stickers", "icon": "Smile", "description": "Sticker messages: metadata captured, sticker image not stored."},
    {"name": "Location", "icon": "MapPin", "description": "Static shared locations: latitude, longitude, label, and address."},
    {"name": "Live Location", "icon": "Navigation", "description": "Real-time location streams from any participant."},
    {"name": "Contact Cards", "icon": "Users", "description": "Shared vCards: phone, name, and organisation extracted."},
    {"name": "Contact Arrays", "icon": "Contact", "description": "Multi-contact shares parsed into individual cards."},
    {"name": "Reactions", "icon": "SmilePlus", "description": "Emoji reactions on any observed message."},
    {"name": "Poll Creation", "icon": "BarChart3", "description": "Polls created in groups: options and voters captured."},
    {"name": "Poll Updates", "icon": "Vote", "description": "Per-option vote tally updates as votes come in."},
    {"name": "Edited Messages", "icon": "Pencil", "description": "Edit events re-linked to the original message."},
    {"name": "Outgoing Messages", "icon": "ArrowUpRight", "description": "Messages your phone sends, kept in sync for your own listings."},
    {"name": "History Sync", "icon": "Clock", "description": "Initial backfill of recent messages on first connect."},
    {"name": "Read Receipts", "icon": "CheckCheck", "description": "Blue-tick events captured but not yet surfaced in the UI."},
    {"name": "Typing Presence", "icon": "Pencil", "description": "Typing indicators captured but not yet surfaced in the UI."},
    {"name": "Profile Pictures", "icon": "Camera", "description": "Profile picture changes tracked per JID."},
    {"name": "Group Directory", "icon": "Users", "description": "Group metadata: name, participants, admins, and subject changes."},
    {"name": "Media Download", "icon": "Download", "description": "On-demand download of incoming media to workspace storage."},
    {"name": "Media Upload", "icon": "Upload", "description": "Outbound media uploads for sending files, images, and video."},
    {"name": "Self-Chat Agent", "icon": "Bot", "description": "Sends structured replies to your Message Yourself chat so PropAI can act on them."},
]

_CAPABILITY_WINDOW_DAYS = 7


# ── Capabilities helpers ───────────────────────────────────────────

def _capability_type_counts(tenant_id: str | None) -> dict[str, dict]:
    if not _table_exists("raw_messages"):
        return {}
    try:
        rows = storage.db.execute(
            """
            SELECT COALESCE(message_type, 'text') AS t,
                   COUNT(*) AS c,
                   MAX(created_at) AS last_seen
            FROM raw_messages
            WHERE tenant_id = ?
              AND created_at >= now() - interval '7 days'
            GROUP BY t
            """,
            (tenant_id,),
        ).fetchall()
    except Exception as exc:
        print(f"[capabilities] type-count query failed: {exc}", flush=True)
        return {}
    counts: dict[str, dict] = {}
    for row in rows or []:
        try:
            last_seen = row["last_seen"]
            if last_seen and hasattr(last_seen, "isoformat"):
                last_seen_str = last_seen.isoformat()
            else:
                last_seen_str = str(last_seen) if last_seen else None
            counts[str(row["t"])] = {
                "count": int(row["c"] or 0),
                "last_seen": last_seen_str,
            }
        except (KeyError, TypeError, ValueError, AttributeError):
            continue
    return counts


def _capability_coverage(tenant_id: str | None) -> dict:
    empty = {"total_messages": 0, "unique_chats": 0, "unique_groups": 0,
             "unique_broadcasts": 0, "oldest_message": None, "newest_message": None}
    if not _table_exists("raw_messages"):
        return empty
    try:
        rows = storage.db.execute(
            """
            SELECT COUNT(*) AS total,
                   COUNT(DISTINCT remote_jid) AS chats,
                   COUNT(DISTINCT CASE WHEN remote_jid LIKE '%@g.us' THEN remote_jid END) AS groups,
                   COUNT(DISTINCT CASE WHEN remote_jid LIKE '%@broadcast' THEN remote_jid END) AS broadcasts,
                   MIN(created_at) AS oldest,
                   MAX(created_at) AS newest
            FROM (
                SELECT raw_payload->'data'->'key'->>'remoteJid' AS remote_jid, created_at
                FROM raw_messages
                WHERE tenant_id = ?
                  AND created_at >= now() - interval '7 days'
            ) sub
            """,
            (tenant_id,),
        ).fetchall()
    except Exception as exc:
        print(f"[capabilities] coverage query failed: {exc}", flush=True)
        return empty
    if not rows:
        return empty
    row = rows[0]
    try:
        oldest = row["oldest"]
        newest = row["newest"]
        return {
            "total_messages": int(row["total"] or 0),
            "unique_chats": int(row["chats"] or 0),
            "unique_groups": int(row["groups"] or 0),
            "unique_broadcasts": int(row["broadcasts"] or 0),
            "oldest_message": oldest.isoformat() if hasattr(oldest, "isoformat") else (str(oldest) if oldest else None),
            "newest_message": newest.isoformat() if hasattr(newest, "isoformat") else (str(newest) if newest else None),
        }
    except (KeyError, TypeError, ValueError, AttributeError):
        return empty


def _compute_capability_status(
    name: str,
    type_data: dict[str, dict],
    any_phone: bool,
    any_connected: bool,
) -> tuple[str, int, str | None]:
    if name in _CAPTURED_UNUSED_CAPS:
        return "captured_unused", 0, None
    if name in _ALWAYS_ON_CAPS:
        if any_connected:
            return "active", 0, None
        if any_phone:
            return "partial", 0, None
        return "not_available", 0, None
    type_key = _CAPABILITY_TYPE_KEY.get(name)
    data = type_data.get(type_key) if type_key else None
    count = int(data["count"]) if data else 0
    last_seen = data["last_seen"] if data else None
    if count > 0:
        return "active", count, last_seen
    if any_phone:
        return "partial", 0, None
    return "not_available", 0, None


# ── Routes ─────────────────────────────────────────────────────────

@router.get("/api/raw")
async def get_raw_messages(user: dict = Depends(require_user), limit: int = 50, offset: int = 0,
                           group_name: str = "", sender: str = "",
                           sender_phone: str = "", sender_jid: str = "", raw_id: int = 0,
                           tenant_id: str | None = Depends(get_tenant_context)):
    if raw_id:
        row = storage.get_raw_message(raw_id)
        if row is None or (tenant_id and str(row.tenant_id or "") != str(tenant_id)):
            raise HTTPException(404, f"Raw message {raw_id} not found")
        return asdict(row)
    rows = storage.get_raw_messages(limit, offset, group_name=group_name,
                                    sender=sender, sender_phone=sender_phone,
                                    sender_jid=sender_jid)
    payload = [asdict(r) for r in rows]
    raw_ids = [row["id"] for row in payload]
    if raw_ids:
        try:
            parsed_res = storage.client.table("parsed_output").select(
                "raw_message_id,id,intent,broker_name,broker_phone,"
                "building_name,micro_market,landmark_name,location_raw,confidence"
            ).in_("raw_message_id", raw_ids).order("confidence", desc=True).order("id", desc=True).execute()
            parsed_rows = parsed_res.data or []
            parsed_by_raw: dict[int, dict] = {}
            for row in parsed_rows:
                raw_id = row.get("raw_message_id")
                if raw_id and raw_id not in parsed_by_raw:
                    has_value = any(
                        (row.get(f) or "").strip()
                        for f in ("broker_phone","broker_name","building_name",
                                  "micro_market","landmark_name","location_raw")
                    )
                    if has_value:
                        parsed_by_raw[raw_id] = row
            for row in payload:
                parsed = parsed_by_raw.get(row["id"])
                if parsed:
                    row["broker_name"] = parsed.get("broker_name") or ""
                    row["broker_phone"] = parsed.get("broker_phone") or ""
                    row["parsed_id"] = parsed.get("parsed_id")
                    row["parsed_intent"] = parsed.get("intent") or ""
                    row["building_name"] = parsed.get("building_name") or ""
                    row["micro_market"] = parsed.get("micro_market") or ""
                    row["landmark_name"] = parsed.get("landmark_name") or ""
                    row["location_raw"] = parsed.get("location_raw") or ""
        except Exception as e:
            import logging
            logging.warning(f"[api/raw] parsed_output enrichment failed: {e}")
    return payload


@router.get("/api/chats")
async def list_chats(user: dict = Depends(require_user), limit: int = 500, offset: int = 0,
                     tenant_id: str | None = Depends(get_tenant_context)):
    return storage.get_chats(limit, offset, tenant_id=tenant_id)


@router.get("/api/chats/{chat_id}/messages")
async def chat_messages(chat_id: str, user: dict = Depends(require_user), limit: int = 200, offset: int = 0,
                        tenant_id: str | None = Depends(get_tenant_context)):
    rows = storage.get_chat_messages(chat_id, limit, offset, tenant_id=tenant_id)
    return [asdict(r) for r in rows]


@router.get("/api/chats/{chat_id}")
async def get_chat(chat_id: str, tenant_id: str | None = Depends(get_tenant_context), user: dict = Depends(require_user)):
    for chat in storage.get_chats(1000, 0, tenant_id=tenant_id):
        if str(chat.get("chat_id") or chat.get("conversation_key") or "") == chat_id:
            return chat
    messages = storage.get_chat_messages(chat_id, 1, 0, tenant_id=tenant_id)
    if not messages:
        raise HTTPException(status_code=404, detail="Chat not found")
    row = asdict(messages[0])
    row["chat_id"] = chat_id
    row["conversation_key"] = chat_id
    row["conversation_name"] = row.get("group_name") or row.get("sender") or chat_id
    row["message_count"] = 1
    return row


@router.get("/api/stats")
async def get_stats(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    return await asyncio.to_thread(storage.get_stats)


@router.get("/api/markets/{market_name:path}")
async def get_market_detail(market_name: str, user: dict = Depends(require_user)):
    name = market_name.strip()
    if not name:
        raise HTTPException(400, "Market name is required")
    like_q = f"%{name}%"

    buildings = [dict(r) for r in storage.db.execute("""
        SELECT building_name, COUNT(*) AS observation_count,
               COUNT(DISTINCT broker_name) AS broker_count
        FROM parsed_output
        WHERE micro_market LIKE ? AND building_name IS NOT NULL AND building_name != ''
        GROUP BY building_name
        ORDER BY observation_count DESC
        LIMIT 20
    """, (like_q,)).fetchall()]

    brokers = [dict(r) for r in storage.db.execute("""
        SELECT b.id, b.canonical_name AS name, b.primary_phone,
               bms.observation_count, bms.listing_count, bms.requirement_count
        FROM broker_market_stats bms
        JOIN brokers b ON b.id = bms.broker_id
        WHERE bms.micro_market LIKE ?
        ORDER BY bms.observation_count DESC
        LIMIT 20
    """, (like_q,)).fetchall()]

    intents = [dict(r) for r in storage.db.execute("""
        SELECT intent, COUNT(*) AS c
        FROM parsed_output
        WHERE micro_market LIKE ? AND intent IS NOT NULL
        GROUP BY intent
        ORDER BY c DESC
    """, (like_q,)).fetchall()]

    groups = [dict(r) for r in storage.db.execute("""
        SELECT r.group_name, COUNT(*) AS observation_count, MAX(r.timestamp) AS last_seen
        FROM parsed_output p
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE p.micro_market LIKE ? AND r.group_name IS NOT NULL
        GROUP BY r.group_name
        ORDER BY last_seen DESC
        LIMIT 10
    """, (like_q,)).fetchall()]

    price_ranges = [dict(r) for r in storage.db.execute("""
        SELECT bhk, COUNT(*) AS sample_count,
               ROUND(AVG(price), 0) AS avg_price,
               MIN(price) AS min_price, MAX(price) AS max_price
        FROM parsed_output
        WHERE micro_market LIKE ? AND price IS NOT NULL AND price > 0 AND bhk IS NOT NULL
        GROUP BY bhk
        ORDER BY sample_count DESC
    """, (like_q,)).fetchall()]

    return {
        "name": name,
        "building_count": len(buildings),
        "broker_count": len(brokers),
        "observation_count": sum(b.get("observation_count", 0) for b in buildings) if buildings else 0,
        "buildings": buildings,
        "brokers": brokers,
        "intents": intents,
        "groups": groups,
        "price_ranges": price_ranges,
    }


@router.get("/api/ingestor/capabilities")
async def get_ingestor_capabilities(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    """Return what message types the whatsmeow ingestor captures, with live per-workspace status."""
    org_id = _resolve_active_organization_id(user, tenant_id)
    phones = await asyncio.to_thread(storage.list_org_whatsapp_connections, org_id)
    any_phone = bool(phones)

    statuses_map, _, _ = await _merged_ingestor_list(timeout=2)
    statuses: list[dict] = list(statuses_map.values())
    now = time.time()
    statuses.extend(
        status for status, seen_at in _broker_live_statuses.values()
        if now - seen_at <= 45
    )
    broker_ids = {str(phone.get("broker_id") or "") for phone in phones}
    broker_ids.discard("")
    any_connected = any(
        bool(status.get("connected"))
        for status in statuses
        if str(status.get("broker_id") or "") in broker_ids
    )

    ingestor_payload: dict | None = None
    _, resp = await _first_ingestor_response("GET", "/capabilities", timeout=3)
    if resp is not None and resp.status_code == 200:
        try:
            ingestor_payload = resp.json()
        except Exception:
            ingestor_payload = None
    canonical = (ingestor_payload or {}).get("capabilities") or _FALLBACK_CAPABILITIES

    type_data = _capability_type_counts(tenant_id)

    out: list[dict] = []
    for cap in canonical:
        entry = {k: v for k, v in cap.items() if k in {"name", "icon", "description"}}
        status, evidence, last_seen = _compute_capability_status(
            cap.get("name", ""), type_data, any_phone, any_connected
        )
        entry["status"] = status
        entry["evidence_count"] = evidence
        if last_seen:
            entry["last_seen"] = last_seen
        out.append(entry)

    return {
        "capabilities": out,
        "instance": (ingestor_payload or {}).get("instance", "unknown"),
        "version": (ingestor_payload or {}).get("version", "unknown"),
        "any_connected": any_connected,
        "any_phone": any_phone,
        "window_days": _CAPABILITY_WINDOW_DAYS,
        "source": "ingestor" if ingestor_payload else "fallback",
        "coverage": _capability_coverage(tenant_id),
    }


@router.get("/api/market/access")
async def market_access_status(
    user: dict | None = Depends(get_current_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    """Access gate for shared market intelligence."""
    details = await asyncio.to_thread(_connection_details)
    connected = bool(details.get("connected"))
    sync_ready = await asyncio.to_thread(_market_sync_ready, details)
    paid_active = False
    trial_active = sync_ready
    unlocked = paid_active or trial_active

    reason = "ready"
    message = "Market Inbox is available for this connected workspace."
    if sync_ready and not connected:
        reason = "offline_data_available"
        message = "WhatsApp is temporarily disconnected. Previously synced market data remains available."
    elif not connected:
        reason = "connect_whatsapp"
        message = "Connect WhatsApp and start your trial to unlock your personalized broker market feed."
    elif not sync_ready:
        reason = "sync_pending"
        message = "WhatsApp is connected. PropAI is waiting for the first sync record before opening Market Inbox."

    waba_configured = bool(await asyncio.to_thread(_business_api_get_config_value, "access_token", "WABA_ACCESS_TOKEN"))

    return {
        "authenticated": bool(user),
        "tenant_id": tenant_id,
        "whatsapp_connected": connected,
        "waba_configured": waba_configured,
        "initial_sync_complete": sync_ready,
        "trial_active": trial_active,
        "paid_active": paid_active,
        "market_unlocked": unlocked,
        "trial_started_at": details.get("connected_since") if trial_active else None,
        "trial_ends_at": None,
        "reason": reason,
        "message": message,
    }


# ── Chat Suggestion Chips ──────────────────────────────────────────

@router.get("/api/chat/suggestions")
async def chat_suggestions(user: dict = Depends(require_user)):
    now = time.time()
    if _chip_cache and (now - _chip_cache_at) < 3600:
        return _chip_cache

    week_ago = (datetime.utcnow() - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")

    top_building = storage.db.execute("""
        SELECT p.building_name, COUNT(*) AS cnt FROM parsed_output p
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE p.building_name IS NOT NULL AND p.building_name != ''
          AND r.timestamp >= ?
        GROUP BY p.building_name ORDER BY cnt DESC LIMIT 1
    """, (week_ago,)).fetchone()

    top_supply_market = storage.db.execute("""
        SELECT p.micro_market, COUNT(*) AS cnt FROM parsed_output p
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE p.intent IN ('SELL','RENT','COMMERCIAL')
          AND p.micro_market IS NOT NULL AND p.micro_market != ''
          AND r.timestamp >= ?
        GROUP BY p.micro_market ORDER BY cnt DESC LIMIT 1
    """, (week_ago,)).fetchone()

    top_demand_market = storage.db.execute("""
        SELECT p.micro_market, COUNT(*) AS cnt FROM parsed_output p
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE p.intent IN ('BUY','RENTAL_SEEKER')
          AND p.micro_market IS NOT NULL AND p.micro_market != ''
          AND r.timestamp >= ?
        GROUP BY p.micro_market ORDER BY cnt DESC LIMIT 1
    """, (week_ago,)).fetchone()

    top_commercial_market = storage.db.execute("""
        SELECT p.micro_market, COUNT(*) AS cnt FROM parsed_output p
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE p.intent = 'COMMERCIAL'
          AND p.micro_market IS NOT NULL AND p.micro_market != ''
          AND r.timestamp >= ?
        GROUP BY p.micro_market ORDER BY cnt DESC LIMIT 1
    """, (week_ago,)).fetchone()

    top_rental_market = storage.db.execute("""
        SELECT p.micro_market, COUNT(*) AS cnt FROM parsed_output p
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE p.intent = 'RENT'
          AND p.micro_market IS NOT NULL AND p.micro_market != ''
          AND r.timestamp >= ?
        GROUP BY p.micro_market ORDER BY cnt DESC LIMIT 1
    """, (week_ago,)).fetchone()

    def _val(row):
        return row[0] if row else None

    def _with_fallback(seven_day_result, fallback_query, params=()):
        v = _val(seven_day_result)
        if v is not None:
            return v
        row = storage.db.execute(fallback_query, params).fetchone()
        return row[0] if row else None

    result = {
        "top_building": _with_fallback(
            top_building,
            "SELECT p.building_name, COUNT(*) AS cnt FROM parsed_output p "
            "JOIN raw_messages r ON r.id = p.raw_message_id "
            "WHERE p.building_name IS NOT NULL AND p.building_name != '' "
            "GROUP BY p.building_name ORDER BY cnt DESC LIMIT 1"
        ),
        "top_supply_market": _with_fallback(
            top_supply_market,
            "SELECT p.micro_market, COUNT(*) AS cnt FROM parsed_output p "
            "JOIN raw_messages r ON r.id = p.raw_message_id "
            "WHERE p.intent IN ('SELL','RENT','COMMERCIAL') "
            "AND p.micro_market IS NOT NULL AND p.micro_market != '' "
            "GROUP BY p.micro_market ORDER BY cnt DESC LIMIT 1"
        ),
        "top_demand_market": _with_fallback(
            top_demand_market,
            "SELECT p.micro_market, COUNT(*) AS cnt FROM parsed_output p "
            "JOIN raw_messages r ON r.id = p.raw_message_id "
            "WHERE p.intent IN ('BUY','RENTAL_SEEKER') "
            "AND p.micro_market IS NOT NULL AND p.micro_market != '' "
            "GROUP BY p.micro_market ORDER BY cnt DESC LIMIT 1"
        ),
        "top_commercial_market": _with_fallback(
            top_commercial_market,
            "SELECT p.micro_market, COUNT(*) AS cnt FROM parsed_output p "
            "JOIN raw_messages r ON r.id = p.raw_message_id "
            "WHERE p.intent = 'COMMERCIAL' "
            "AND p.micro_market IS NOT NULL AND p.micro_market != '' "
            "GROUP BY p.micro_market ORDER BY cnt DESC LIMIT 1"
        ),
        "top_rental_market": _with_fallback(
            top_rental_market,
            "SELECT p.micro_market, COUNT(*) AS cnt FROM parsed_output p "
            "JOIN raw_messages r ON r.id = p.raw_message_id "
            "WHERE p.intent = 'RENT' "
            "AND p.micro_market IS NOT NULL AND p.micro_market != '' "
            "GROUP BY p.micro_market ORDER BY cnt DESC LIMIT 1"
        ),
    }
    result["top_broker_building"] = result["top_building"]

    _chip_cache.clear()
    _chip_cache.update(result)
    _chip_cache_at = now
    return result


# ── AI Suggestions Queue ───────────────────────────────────────────

class SuggestionAction(BaseModel):
    status: str = "approved"


@router.get("/api/suggestions")
async def list_suggestions(status: str = "pending", limit: int = 50, offset: int = 0, user: dict = Depends(require_user)):
    return storage.get_suggestions(status=status, limit=limit, offset=offset)


@router.post("/api/suggestions/{sug_id}/{action}")
async def act_on_suggestion(sug_id: int, action: str, request: Request, user: dict = Depends(require_user)):
    if action not in ("approve", "reject", "ignore"):
        raise HTTPException(400, "action must be approve, reject, or ignore")
    status_map = {"approve": "approved", "reject": "rejected", "ignore": "ignored"}
    rejection_reason = ""
    try:
        body = await request.json()
        rejection_reason = body.get("rejection_reason", "") if isinstance(body, dict) else ""
    except Exception:
        pass
    storage.update_suggestion_status(sug_id, status_map[action], rejection_reason=rejection_reason)
    return {"status": "ok"}


@router.post("/api/suggestions/batch")
async def batch_suggestions(request: Request, user: dict = Depends(require_user)):
    body = await request.json()
    ids = body.get("ids", [])
    action = body.get("action", "approve")
    if action not in ("approve", "reject", "ignore"):
        raise HTTPException(400, "action must be approve, reject, or ignore")
    status_map = {"approve": "approved", "reject": "rejected", "ignore": "ignored"}
    rejection_reason = body.get("rejection_reason", "")
    storage.batch_update_suggestions(ids, status_map[action], rejection_reason=rejection_reason)
    return {"status": "ok", "count": len(ids)}
