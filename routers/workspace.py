"""Workspace and inbox routes."""
import asyncio
import hmac
import json
import logging
import os
import time
import uuid
from dataclasses import asdict
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Request

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
    check_permission(member, "add_team_members")
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
    providers = storage.get_llm_providers(tenant_id=tenant_id)
    for p in providers:
        if p.api_key and len(p.api_key) > 8:
            p.api_key = p.api_key[:4] + "****" + p.api_key[-4:]
        elif p.api_key:
            p.api_key = "****"
    return {"providers": [asdict(p) for p in providers]}


@router.get("/api/workspace/llm-providers/active")
async def get_active_llm_provider(user: dict = Depends(require_user), tenant_id: str | None = Depends(get_tenant_context)):
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
    ok = storage.delete_llm_provider(provider_id, tenant_id=tenant_id)
    return {"deleted": ok}
