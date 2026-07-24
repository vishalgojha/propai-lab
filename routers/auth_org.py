"""Auth, org, and profile routes."""
import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from routers.common import (
    storage,
    require_user,
    get_current_user,
    get_tenant_context,
    _resolve_active_organization_id,
    _require_org_permission,
)

router = APIRouter(tags=["auth"])

# Placeholders set by app.py at startup
_first_ingestor_response = None
_ingestor_urls = None
_ingestor_auth_headers = None


class ProfileUpdate(BaseModel):
    first_name: str
    last_name: str = ""
    email: str = ""
    city: str = ""


# ── Profile ──────────────────────────────────────────────────────────


@router.get("/api/profile")
async def get_profile(user: dict = Depends(require_user), tenant_id: str | None = Depends(get_tenant_context)):
    profile = storage.get_user_profile(auth_user_id=user.get("id", ""), tenant_id=tenant_id)
    return profile or {}


@router.post("/api/profile")
async def save_profile(body: ProfileUpdate, user: dict = Depends(require_user), tenant_id: str | None = Depends(get_tenant_context)):
    phone = user.get("phone", "")
    profile = storage.save_user_profile(phone, body.model_dump(), auth_user_id=user.get("id", ""), tenant_id=tenant_id)
    if not profile:
        raise HTTPException(500, "Profile could not be saved")
    return profile


@router.get("/api/profile-picture/{jid:path}")
async def get_profile_picture(jid: str, broker_id: str = "", user: dict = Depends(require_user), tenant_id: str | None = Depends(get_tenant_context)):
    """Proxy profile picture URL from the WhatsApp ingestor.  Caches in user_profiles."""
    jid = jid.strip()
    if not jid:
        raise HTTPException(400, "jid is required")

    cached = storage.get_profile_photo(jid, tenant_id=tenant_id) if hasattr(storage, "get_profile_photo") else None
    if cached and cached.get("profile_photo_url") and cached.get("profile_photo_fetched_at"):
        try:
            fetched_at = datetime.fromisoformat(str(cached["profile_photo_fetched_at"]))
            if (datetime.now(timezone.utc) - fetched_at).total_seconds() < 6 * 3600:
                return {"ok": True, "url": cached["profile_photo_url"], "jid": jid, "cached": True}
        except Exception:
            pass

    broker_param = f"&broker_id={broker_id}" if broker_id else ""
    existing_param = f"&existing_id={cached['profile_photo_id']}" if cached and cached.get("profile_photo_id") else ""
    _, resp = await _first_ingestor_response(
        "GET",
        f"/profile-picture?jid={jid}{broker_param}{existing_param}",
        timeout=8,
    )
    if resp is None or resp.status_code >= 400:
        if resp is not None and resp.status_code == 404:
            return {"ok": True, "url": "", "jid": jid, "note": "no_profile_picture"}
        raise HTTPException(502, "Profile picture fetch failed")

    try:
        data = resp.json()
    except Exception:
        raise HTTPException(502, "Invalid response from WhatsApp service")

    if not data.get("ok"):
        raise HTTPException(502, data.get("error", "Profile picture fetch failed"))

    if data.get("unchanged"):
        return {"ok": True, "url": cached["profile_photo_url"] if cached else "", "jid": jid, "cached": True}

    pic_url = data.get("url", "")
    pic_id = data.get("id", "")
    if pic_url:
        storage.update_profile_photo(jid, pic_url, pic_id, tenant_id=tenant_id) if hasattr(storage, "update_profile_photo") else None

    return {"ok": True, "url": pic_url, "jid": jid, "id": pic_id}


# ── Auth / Me ────────────────────────────────────────────────────────


@router.get("/api/auth/me")
async def auth_me(
    user: dict | None = Depends(get_current_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    if not user:
        return {"authenticated": False}
    orgs = storage.get_user_organizations(user["id"]) if user else []
    return {
        "authenticated": True,
        "user": user,
        "organizations": orgs,
        "active_tenant": tenant_id,
        "is_super_admin": storage.is_super_admin(user["id"]) if user else False,
    }


# ── Organizations ────────────────────────────────────────────────────


@router.get("/api/orgs")
async def list_organizations(
    limit: int = 100, offset: int = 0,
    user: dict | None = Depends(get_current_user),
):
    if user and storage.is_super_admin(user["id"]):
        return storage.list_organizations(limit, offset)
    if not user:
        raise HTTPException(401, "Authentication required")
    return storage.get_user_organizations(user["id"])


@router.get("/api/orgs/current")
async def current_organization(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    if not tenant_id:
        raise HTTPException(404, "No organization found")
    org = storage.get_organization(tenant_id)
    if org:
        return org
    orgs = storage.get_user_organizations(user["id"])
    if not orgs:
        raise HTTPException(404, "No organization found")
    return orgs[0]


@router.get("/api/orgs/{org_id}")
async def get_organization(org_id: str, user: dict = Depends(require_user)):
    org = storage.get_organization(org_id)
    if not org:
        raise HTTPException(404, "Organization not found")
    return org


@router.patch("/api/orgs/{org_id}")
async def update_organization(org_id: str, body: dict, user: dict = Depends(require_user)):
    allowed = {"name", "is_active"}
    updates = {k: v for k, v in body.items() if k in allowed}
    if not updates:
        raise HTTPException(400, "No valid fields to update")
    ok = storage.update_organization(org_id, **updates)
    if not ok:
        raise HTTPException(404, "Organization not found")
    return {"ok": True}


@router.get("/api/orgs/{org_id}/members")
async def list_members(org_id: str, user: dict = Depends(require_user)):
    return storage.list_organization_members(org_id)


@router.post("/api/orgs/{org_id}/members")
async def add_member(org_id: str, body: dict, user: dict = Depends(require_user)):
    user_id = body.get("user_id")
    role_id = body.get("role_id")
    if not user_id:
        raise HTTPException(400, "user_id is required")
    result = storage.add_organization_member(org_id, user_id, role_id)
    if not result:
        raise HTTPException(400, "Failed to add member")
    return result


@router.delete("/api/orgs/{org_id}/members/{user_id}")
async def remove_member(org_id: str, user_id: str, user: dict = Depends(require_user)):
    ok = storage.remove_organization_member(org_id, user_id)
    if not ok:
        raise HTTPException(404, "Member not found")
    return {"ok": True}


@router.patch("/api/orgs/{org_id}/members/{user_id}/role")
async def update_member_role(org_id: str, user_id: str, body: dict, user: dict = Depends(require_user)):
    role_id = body.get("role_id")
    if not role_id:
        raise HTTPException(400, "role_id is required")
    ok = storage.update_member_role(org_id, user_id, role_id)
    if not ok:
        raise HTTPException(404, "Member not found")
    return {"ok": True}


@router.get("/api/orgs/{org_id}/roles")
async def list_org_roles(org_id: str, user: dict = Depends(require_user)):
    system_roles = storage.list_roles(org_id=None)
    org_roles = storage.list_roles(org_id=org_id)
    return {"system_roles": system_roles, "org_roles": org_roles}


@router.post("/api/orgs/{org_id}/roles")
async def create_org_role(org_id: str, body: dict, user: dict = Depends(require_user)):
    name = body.get("name")
    slug = body.get("slug")
    if not name or not slug:
        raise HTTPException(400, "name and slug are required")
    result = storage.create_role(org_id, name, slug, body.get("description", ""))
    if not result:
        raise HTTPException(400, "Failed to create role")
    return result


@router.get("/api/orgs/{org_id}/whatsapp")
async def list_org_whatsapp(org_id: str, user: dict = Depends(require_user)):
    active_org_id = _resolve_active_organization_id(user, org_id)
    if org_id and str(org_id) != str(active_org_id) and not storage.is_super_admin(user["id"]):
        raise HTTPException(404, "Organization not found")
    org_id = active_org_id
    return storage.list_org_whatsapp_connections(org_id)


@router.post("/api/orgs/{org_id}/whatsapp")
async def add_org_whatsapp(org_id: str, body: dict, user: dict = Depends(require_user)):
    phone = body.get("phone_number")
    if not phone:
        raise HTTPException(400, "phone_number is required")
    if not org_id or not storage.get_organization(org_id):
        org_id = _resolve_active_organization_id(user, org_id)
    await _require_org_permission(user, org_id, "manage_whatsapp")
    count = storage.count_org_phones(org_id)
    if count >= 3:
        raise HTTPException(400, "Maximum 3 phones per organization")
    import uuid as _uuid
    broker_id = f"phone-{_uuid.uuid4().hex[:12]}"
    result = storage.add_org_whatsapp_connection(org_id, phone, body.get("instance_name", ""), broker_id)
    if not result:
        raise HTTPException(400, "Failed to add WhatsApp connection")
    async with httpx.AsyncClient(timeout=10) as client:
        for base_url in _ingestor_urls():
            try:
                resp = await client.post(
                    f"{base_url}/connect?broker_id={broker_id}", headers=_ingestor_auth_headers()
                )
                if resp.status_code == 200:
                    break
            except httpx.RequestError:
                continue
    return result
