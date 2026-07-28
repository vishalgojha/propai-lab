"""WhatsApp sync routes — webhooks, phones CRUD, WABA config, sync control."""
import asyncio
import hmac
import json
import os
import re
import time
import uuid
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from storage import set_tenant_id, get_tenant_id
from routers.common import (
    storage, require_user, get_tenant_context, _resolve_active_organization_id,
    _scoped_phone, _require_org_permission,
)

router = APIRouter(tags=["whatsapp_sync"])

_logger = __import__("logging").getLogger(__name__)


# ── Models ────────────────────────────────────────────────────────

class BusinessApiConfigRequest(BaseModel):
    whatsapp_business_number: str = ""
    phone_number_id: str = ""
    access_token: str = ""
    verify_token: str = ""
    clear_access_token: bool = False
    clear_verify_token: bool = False


class BusinessApiTeamMemberRequest(BaseModel):
    name: str
    mobile_number: str
    role: str = "sales_agent"
    assigned_markets: list[str] = []
    active: bool = True
    waba_identity: str = ""


class WabaSendRequest(BaseModel):
    to: str
    text: str
    remote_jid: str = ""


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

PROPAI_SHARED_WABA_NUMBER = "+917021045254"
PIC_TOKEN_RE = re.compile(r'\bPIC-(\d+)-([A-F0-9]+)\b')
_BUSINESS_API_PERSISTABLE_TYPES: frozenset[str] = frozenset({
    "text", "image", "video", "audio", "document", "sticker",
    "location", "contacts",
})


# ── Placeholders (wired by app.py at startup) ───────────────────

_broker_live_statuses: object = None
_ingestor_urls: object = None
_ingestor_auth_headers: object = None
_first_ingestor_response: object = None
_best_ingestor_status_for_broker: object = None
_merged_ingestor_list: object = None
_ingestor_failure_message: object = None
_memory_status: object = None
_previous_status: object = None
_cache_connection_snapshot: object = None
_platform_waba_values: object = None
_workspace_waba_values: object = None
_resolve_waba_webhook_config: object = None
_process_business_api_webhook: object = None
_waba_session_update: object = None
_waba_session_status: object = None
_waba_send_message: object = None
_business_api_config_for: object = None
_business_api_set_config_value: object = None
_business_api_member: object = None
_is_propai_shared_waba: object = None
_mobile_digits: object = None
_business_api_get_config_value: object = None
_mask_secret: object = None
_waba_callback_url: object = None
_download_waba_media: object = None
_display_phone_from_whatsapp_id: object = None
get_scheduler: object = None
_get_org_waba_connection_by_phone_number_id: object = None


# ── Routes ────────────────────────────────────────────────────────

async def _request_organization_id(user: dict, tenant_id: str | None) -> str:
    """Resolve the request organization without blocking the event loop."""
    try:
        org_id = await asyncio.to_thread(_resolve_active_organization_id, user, tenant_id)
    except Exception as exc:
        _logger.error("WhatsApp organization lookup failed for user %s: %s", user.get("id"), exc)
        raise HTTPException(503, "Workspace lookup is temporarily unavailable") from exc
    if not org_id:
        raise HTTPException(403, "No organization membership found")
    return str(org_id)


@router.post("/api/sources/stop")
async def scheduler_stop(user: dict = Depends(require_user)):
    scheduler = get_scheduler()
    scheduler.stop()
    return {"status": "stopping", "message": "Scheduler stop requested"}


@router.post("/api/sources/{source_name}/sync")
async def source_sync(source_name: str, user: dict = Depends(require_user)):
    if source_name == "whatsapp":
        raise HTTPException(
            410,
            "WhatsApp history sync is automatic after QR pairing. PropAI stores live and historical messages through the WhatsApp ingestor.",
        )
    scheduler = get_scheduler()
    if scheduler.is_running:
        raise HTTPException(409, "Scheduler already running")
    from lab.ingestion.registry import get_registry
    if not get_registry().get(source_name):
        raise HTTPException(404, f"Unknown source: {source_name}")
    started = scheduler.start(source=source_name)
    if not started:
        raise HTTPException(400, "Failed to start scheduler")
    return {"status": "started", "source": source_name, "message": f"Sync started for {source_name}"}


@router.get("/api/business-api/config")
async def business_api_config(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    return await _business_api_config_for(user, tenant_id)


@router.post("/api/business-api/config")
async def business_api_save_config(
    req: BusinessApiConfigRequest,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    is_super_admin = await asyncio.to_thread(storage.is_super_admin, user["id"])
    org_id = None if is_super_admin else _resolve_active_organization_id(user, tenant_id)
    if org_id:
        await _require_org_permission(user, org_id, "manage_whatsapp")

    requested_number = req.whatsapp_business_number.strip()
    if requested_number and _is_propai_shared_waba(requested_number) and not is_super_admin:
        raise HTTPException(
            403,
            "PropAI shared WABA is reserved for the assistant. Connect a number owned by your workspace.",
        )

    if is_super_admin:
        if requested_number:
            _business_api_set_config_value("whatsapp_business_number", requested_number)
        if req.phone_number_id.strip():
            _business_api_set_config_value("phone_number_id", req.phone_number_id.strip())
        if req.clear_access_token:
            _business_api_set_config_value("access_token", "")
        elif req.access_token.strip():
            _business_api_set_config_value("access_token", req.access_token.strip())
        if req.clear_verify_token:
            _business_api_set_config_value("verify_token", "")
        elif req.verify_token.strip():
            _business_api_set_config_value("verify_token", req.verify_token.strip())
    else:
        current = await _workspace_waba_values(org_id)
        values = {
            "whatsapp_business_number": requested_number or current.get("whatsapp_business_number"),
            "phone_number_id": req.phone_number_id.strip() or current.get("phone_number_id"),
            "access_token": (
                "" if req.clear_access_token else req.access_token.strip() or current.get("access_token")
            ),
            "verify_token": (
                "" if req.clear_verify_token else req.verify_token.strip() or current.get("verify_token")
            ),
            "is_active": True,
        }
        missing = [
            label
            for key, label in (
                ("whatsapp_business_number", "WhatsApp Business Number"),
                ("phone_number_id", "Phone Number ID"),
                ("access_token", "Access Token"),
                ("verify_token", "Verify Token"),
            )
            if not values.get(key)
        ]
        if missing:
            raise HTTPException(400, f"Missing: {', '.join(missing)}")
        upsert = getattr(storage, "upsert_org_waba_connection", None)
        if not upsert:
            raise HTTPException(503, "Workspace WABA storage is not available")
        try:
            await asyncio.to_thread(upsert, org_id, values)
        except Exception as exc:
            print(f"[waba-config] workspace save failed org={org_id}: {exc}", flush=True)
            raise HTTPException(503, "Could not save workspace WABA configuration") from exc

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    storage.db.execute(
        """INSERT INTO business_api_audit_log
           (action, target_type, target_id, status, details, created_at)
           VALUES (?,?,?,?,?,?)""",
        (
            "waba_config_updated",
            "org_waba_connection" if org_id else "business_api_config",
            org_id or "platform",
            "logged",
            json.dumps({
                "business_number_set": bool(req.whatsapp_business_number.strip()),
                "phone_number_id_set": bool(req.phone_number_id.strip()),
                "access_token_changed": bool(req.access_token.strip() or req.clear_access_token),
                "verify_token_changed": bool(req.verify_token.strip() or req.clear_verify_token),
            }),
            now,
        ),
    )
    return await _business_api_config_for(user, tenant_id)


@router.post("/api/business-api/webhook")
async def business_api_webhook_receive(request: Request):
    return await _process_business_api_webhook(await request.json())


@router.get("/api/whatsapp/cloud/webhook")
async def whatsapp_cloud_webhook_verify(request: Request):
    mode = request.query_params.get("hub.mode", "")
    token = request.query_params.get("hub.verify_token", "")
    challenge = request.query_params.get("hub.challenge", "")
    expected = _business_api_get_config_value("verify_token", "WABA_VERIFY_TOKEN")
    if mode == "subscribe" and expected and token == expected:
        return Response(content=challenge, media_type="text/plain")
    raise HTTPException(403, "Webhook verify token does not match")


@router.post("/api/whatsapp/cloud/webhook")
async def whatsapp_cloud_webhook_receive(request: Request):
    return await _process_business_api_webhook(await request.json())


@router.get("/api/whatsapp/cloud/webhook/{org_id}")
async def whatsapp_workspace_cloud_webhook_verify(org_id: str, request: Request):
    values = await _workspace_waba_values(org_id)
    expected = str(values.get("verify_token") or "")
    mode = request.query_params.get("hub.mode", "")
    supplied = request.query_params.get("hub.verify_token", "")
    challenge = request.query_params.get("hub.challenge", "")
    if mode == "subscribe" and expected and hmac.compare_digest(supplied, expected):
        return Response(content=challenge, media_type="text/plain")
    raise HTTPException(403, "Webhook verify token does not match")


@router.post("/api/whatsapp/cloud/webhook/{org_id}")
async def whatsapp_workspace_cloud_webhook_receive(org_id: str, request: Request):
    body = await request.json()
    values, resolved_org_id = await _resolve_waba_webhook_config(body, org_id)
    return await _process_business_api_webhook(
        body, org_id=resolved_org_id, resolved_config=values
    )


@router.post("/api/waba/send")
async def waba_send_message(
    req: WabaSendRequest,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    text = req.text.strip()
    if not text:
        raise HTTPException(400, "text is required")
    if not req.to:
        raise HTTPException(400, "to (phone number) is required")

    digits_raw = req.to.replace("+", "").replace(" ", "").replace("-", "").strip()
    if digits_raw.startswith("0"):
        digits_raw = digits_raw[1:]
    chat_id = f"{digits_raw}@s.whatsapp.net"
    session = _waba_session_status(chat_id)
    if session.get("expired"):
        return JSONResponse(
            status_code=403,
            content={
                "success": False,
                "error": "session_expired",
                "message": "24-hour reply window has expired. The customer must message you first before you can send.",
                "remaining_seconds": 0,
            },
        )

    is_super_admin = await asyncio.to_thread(storage.is_super_admin, user["id"])
    org_id = _resolve_active_organization_id(user, tenant_id)
    if not is_super_admin:
        await _require_org_permission(user, org_id, "reply_whatsapp")
        waba_config = await _workspace_waba_values(org_id)
        if not waba_config:
            raise HTTPException(409, "Connect your workspace WABA before sending")
    else:
        waba_config = _platform_waba_values()

    result = await _waba_send_message(req.to, text, waba_config=waba_config)

    try:
        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        digits = req.to.replace("+", "").replace(" ", "").replace("-", "").strip()
        if digits.startswith("0"):
            digits = digits[1:]
        sender_jid = f"{digits}@s.whatsapp.net"

        storage.db.execute(
            """INSERT INTO raw_messages
               (tenant_id, group_name, sender, sender_jid, sender_phone, message, message_type,
                source, timestamp, raw_payload, message_uid, delivery_status, synced_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                org_id,
                req.remote_jid or sender_jid,
                "You",
                sender_jid,
                digits,
                text,
                "text",
                "WABA_OUTBOUND",
                now_iso,
                json.dumps({"waba_message_id": result.get("message_id", ""), "to": digits}),
                f"waba-{result.get('message_id', '') or int(time.time() * 1000)}",
                "sent" if result.get("success") else None,
                now_iso,
                now_iso,
            ),
        )
    except Exception as exc:
        print(f"[waba-send] failed to store outbound message: {exc}", flush=True)

    try:
        _waba_session_update(chat_id, direction="outbound")
    except Exception:
        pass

    try:
        storage.log_activity(
            action="waba_message_sent" if result.get("success") else "waba_message_failed",
            target_type="waba_outbound",
            target_id=req.to,
            status="sent" if result.get("success") else "failed",
            details={
                "to": req.to,
                "text_preview": text[:200],
                "message_id": result.get("message_id", ""),
                "error": result.get("error", ""),
            },
        )
    except Exception:
        pass

    status_code = 200 if result.get("success") else 502
    return JSONResponse(status_code=status_code, content=result)


@router.post("/api/business-api/team")
async def business_api_add_team_member(req: BusinessApiTeamMemberRequest, user: dict = Depends(require_user)):
    name = req.name.strip()
    mobile = _mobile_digits(req.mobile_number)
    if not name:
        raise HTTPException(400, "Name is required")
    if len(mobile) < 10:
        raise HTTPException(400, "Valid mobile number is required")
    if req.role not in COMPANION_ROLES:
        raise HTTPException(400, "Invalid role")
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        cur = storage.db.execute(
            """INSERT INTO business_api_team_members
               (name, mobile_number, role, assigned_markets, active, waba_identity, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (
                name,
                mobile,
                req.role,
                json.dumps(req.assigned_markets),
                1 if req.active else 0,
                req.waba_identity.strip(),
                now,
                now,
            ),
        )
        storage.db.execute(
            """INSERT INTO business_api_audit_log
               (team_member_id, action, target_type, target_id, status, details, created_at)
               VALUES (?,?,?,?,?,?,?)""",
            (cur.lastrowid, "team_member_registered", "team_member", str(cur.lastrowid), "logged", "{}", now),
        )
    except Exception as exc:
        raise HTTPException(400, f"Could not add team member: {exc}")
    row = storage.db.execute("SELECT * FROM business_api_team_members WHERE id = ?", (cur.lastrowid,)).fetchone()
    return _business_api_member(row)


@router.post("/api/sync/history-backfill")
async def sync_history_backfill(limit: int = 25, count: int = 50, user: dict = Depends(require_user)):
    limit = max(1, min(int(limit or 25), 100))
    count = max(1, min(int(count or 50), 50))
    errors = []
    async with httpx.AsyncClient(timeout=35) as client:
        for base_url in _ingestor_urls():
            try:
                resp = await client.post(
                    f"{base_url}/history/backfill",
                    params={"broker_id": "default", "limit": limit, "count": count},
                    headers=_ingestor_auth_headers(),
                )
                payload = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {"message": resp.text}
                return {"ok": resp.status_code < 300, "status_code": resp.status_code, "ingestor_url": base_url, **payload}
            except httpx.RequestError as e:
                errors.append(f"{base_url}: {e}")
    return {"ok": False, "message": "Cannot reach ingestor", "errors": errors}


@router.delete("/api/whatsapp/{conn_id}")
async def remove_org_whatsapp(conn_id: int, user: dict = Depends(require_user)):
    row = storage.get_whatsapp_connection_unscoped(conn_id)
    if not row:
        raise HTTPException(404, "Connection not found")
    await _require_org_permission(user, str(row["organization_id"]), "manage_whatsapp")
    broker_id = row.get("broker_id", "")
    if broker_id:
        async with httpx.AsyncClient(timeout=10) as client:
            for base_url in _ingestor_urls():
                try:
                    await client.post(
                        f"{base_url}/disconnect?broker_id={broker_id}", headers=_ingestor_auth_headers()
                    )
                    break
                except httpx.RequestError:
                    continue
    ok = storage.remove_org_whatsapp_connection(conn_id)
    return {"ok": ok}


@router.get("/api/phones")
async def list_phones(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
    include_live: bool = True,
):
    org_id = await _request_organization_id(user, tenant_id)
    try:
        phones = await asyncio.to_thread(storage.list_org_whatsapp_connections, org_id)
    except Exception as exc:
        _logger.error("WhatsApp phone lookup failed for org %s: %s", org_id, exc)
        raise HTTPException(503, "Phone list is temporarily unavailable") from exc
    ingestor_statuses = {}
    ingestor_reachable = False
    ingestor_error = ""
    if include_live:
        ingestor_statuses, ingestor_reachable, ingestor_error = await _merged_ingestor_list(timeout=2)
        now = time.time()
        for broker_id, (cached_status, seen_at) in _broker_live_statuses.items():
            if broker_id not in ingestor_statuses and now - seen_at <= 45:
                ingestor_statuses[broker_id] = cached_status
    result = []
    for phone in phones:
        broker_id = phone.get("broker_id", "")
        status = ingestor_statuses.get(broker_id)
        has_live_status = ingestor_reachable or status is not None
        status = status or {}
        result.append({
            **phone,
            "connected": bool(status.get("connected")) if has_live_status else None,
            "connection_state": status.get(
                "connection_state", "stopped" if ingestor_reachable else "unavailable"
            ),
            "phone_number_live": status.get("phone_number") or phone.get("phone_number", ""),
            "display_name": status.get("display_name") or phone.get("instance_name", ""),
            "connected_since": status.get("connected_since", ""),
            "last_message_at": status.get("last_message_at", ""),
            "qr_available": status.get("qr_available", False),
            "total_messages_received": status.get("total_messages_received", 0),
            "live_status_available": has_live_status,
            "live_status_error": "" if has_live_status else ingestor_error,
        })
    return {"phones": result}


@router.post("/api/phones")
async def create_phone(
    body: dict,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    try:
        import uuid as _uuid
        phone_number = body.get("phone_number", "").strip()
        instance_name = body.get("instance_name", "").strip()
        org_id = await _request_organization_id(user, tenant_id)
        await _require_org_permission(user, org_id, "manage_whatsapp")
        existing_phones = await asyncio.to_thread(storage.list_org_whatsapp_connections, org_id)
        if not phone_number:
            placeholder = next((row for row in existing_phones if (
                not str(row.get("phone_number") or "").strip()
                or str(row.get("phone_number") or "").startswith("Unpaired")
            )), None)
            if placeholder:
                updates: dict = {}
                if instance_name and not placeholder.get("instance_name"):
                    updates["instance_name"] = instance_name
                if updates:
                    updated = storage.update_org_whatsapp_connection(placeholder["id"], updates)
                    if updated:
                        placeholder = updated
                broker_id = placeholder.get("broker_id", "")
                if broker_id:
                    await _first_ingestor_response("POST", "/connect", timeout=10, params={"broker_id": broker_id})
                return placeholder
        if len(existing_phones) >= 3:
            raise HTTPException(400, "Maximum 3 phones per organization")
        broker_id = f"phone-{_uuid.uuid4().hex[:12]}"
        if not phone_number:
            phone_number = f"Unpaired:{broker_id}"
        result = storage.add_org_whatsapp_connection(org_id, phone_number, instance_name, broker_id)
        if not result:
            raise HTTPException(400, "Failed to create phone")
        await _first_ingestor_response("POST", "/connect", timeout=10, params={"broker_id": broker_id})
        return result
    except HTTPException:
        raise
    except Exception as e:
        if "unique" in str(e).lower() or "duplicate" in str(e).lower():
            raise HTTPException(400, "A phone with this number already exists in your organization")
        raise HTTPException(500, f"Failed to create phone: {str(e)}")


@router.get("/api/phones/{phone_id}")
async def get_phone(
    phone_id: int,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    org_id = await _request_organization_id(user, tenant_id)
    phone = await _scoped_phone(phone_id, org_id)
    broker_id = phone.get("broker_id", "")
    status = await _best_ingestor_status_for_broker(broker_id, timeout=2)
    has_live_status = bool(status)
    return {
        **phone,
        "connected": bool(status.get("connected")) if has_live_status else None,
        "connection_state": status.get("connection_state", "unknown"),
        "phone_number_live": status.get("phone_number") or phone.get("phone_number", ""),
        "display_name": status.get("display_name") or phone.get("instance_name", ""),
        "connected_since": status.get("connected_since", ""),
        "last_message_at": status.get("last_message_at", ""),
        "qr_available": status.get("qr_available", False),
        "qr": status.get("qr", ""),
        "total_messages_received": status.get("total_messages_received", 0),
        "live_status_available": has_live_status,
    }


@router.patch("/api/phones/{phone_id}")
async def update_phone(
    phone_id: int,
    body: dict,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    org_id = await _request_organization_id(user, tenant_id)
    await _require_org_permission(user, org_id, "manage_whatsapp")
    await _scoped_phone(phone_id, org_id)
    allowed = {"instance_name", "self_chat_enabled"}
    updates = {key: body[key] for key in allowed if key in body}
    if "instance_name" in updates:
        updates["instance_name"] = str(updates["instance_name"]).strip()[:100]
    if "self_chat_enabled" in updates and not isinstance(updates["self_chat_enabled"], bool):
        raise HTTPException(400, "self_chat_enabled must be a boolean")
    if not updates:
        raise HTTPException(400, "No valid fields to update")
    updates["updated_at"] = datetime.now(timezone.utc).isoformat()
    result = await asyncio.to_thread(storage.update_org_whatsapp_connection, phone_id, updates)
    if not result:
        raise HTTPException(404, "Phone not found")
    return result


@router.delete("/api/phones/{phone_id}")
async def delete_phone(
    phone_id: int,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    org_id = await _request_organization_id(user, tenant_id)
    await _require_org_permission(user, org_id, "manage_whatsapp")
    phone = await _scoped_phone(phone_id, org_id)
    broker_id = phone.get("broker_id", "")
    if broker_id:
        _, cleanup_response = await _first_ingestor_response(
            "POST", "/delete-session", timeout=10, params={"broker_id": broker_id}
        )
        if cleanup_response is not None and cleanup_response.status_code == 404:
            await _first_ingestor_response(
                "POST", "/disconnect", timeout=10, params={"broker_id": broker_id}
            )
    ok = await asyncio.to_thread(storage.remove_org_whatsapp_connection, phone_id)
    if not ok:
        raise HTTPException(500, "Phone could not be removed from the workspace")
    return {"ok": True}


@router.post("/api/phones/{phone_id}/reset")
async def reset_phone(
    phone_id: int,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    org_id = await _request_organization_id(user, tenant_id)
    await _require_org_permission(user, org_id, "manage_whatsapp")
    phone = await _scoped_phone(phone_id, org_id)
    broker_id = phone.get("broker_id", "")
    _, resp = await _first_ingestor_response("POST", "/reset", timeout=10, params={"broker_id": broker_id})
    if resp is not None and resp.status_code == 200:
        return {"ok": True, "message": "Session cleared, QR should appear shortly"}
    raise HTTPException(502, _ingestor_failure_message(resp))


@router.post("/api/phones/{phone_id}/disconnect")
async def disconnect_phone(
    phone_id: int,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    org_id = await _request_organization_id(user, tenant_id)
    await _require_org_permission(user, org_id, "manage_whatsapp")
    phone = await _scoped_phone(phone_id, org_id)
    broker_id = phone.get("broker_id", "")
    try:
        _, resp = await _first_ingestor_response("POST", "/disconnect", timeout=10, params={"broker_id": broker_id})
    except Exception as exc:
        raise HTTPException(502, f"WhatsApp service error: {exc}") from exc
    if resp is not None and resp.status_code == 200:
        return {"ok": True, "message": "Phone disconnected"}
    raise HTTPException(502, _ingestor_failure_message(resp))


@router.post("/api/phones/{phone_id}/connect")
async def connect_phone(
    phone_id: int,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    org_id = await _request_organization_id(user, tenant_id)
    await _require_org_permission(user, org_id, "manage_whatsapp")
    phone = await _scoped_phone(phone_id, org_id)
    broker_id = phone.get("broker_id", "")
    if not broker_id:
        raise HTTPException(400, "Phone is missing broker_id")
    _, resp = await _first_ingestor_response("POST", "/connect", timeout=10, params={"broker_id": broker_id})
    if resp is not None and resp.status_code == 200:
        return resp.json()
    raise HTTPException(502, _ingestor_failure_message(resp))


@router.post("/api/sync/status")
async def sync_status_update(request: Request):
    """Receive connection status from the WhatsApp ingestor."""
    global _memory_status, _previous_status
    expected_token = (
        os.getenv("PROPAI_INTERNAL_TOKEN", "").strip()
        or os.getenv("SUPABASE_SERVICE_KEY", "").strip()
    )
    supplied_token = request.headers.get("X-PropAI-Internal-Token", "").strip()
    if not expected_token:
        raise HTTPException(503, "Internal service authentication is not configured")
    if not hmac.compare_digest(supplied_token, expected_token):
        raise HTTPException(401, "Invalid internal service token")
    try:
        body = await request.json()
        _previous_status = _memory_status
        _memory_status = body
        _cache_connection_snapshot(body)
        broker_id = str(body.get("broker_id") or "").strip()
        if broker_id:
            _broker_live_statuses[broker_id] = (body, time.time())
        phone_number = str(body.get("phone_number") or "").strip()
        display_name = str(body.get("display_name") or "").strip()
        if storage and broker_id and (phone_number or display_name):
            updates: dict[str, object] = {"is_active": True}
            if phone_number:
                updates["phone_number"] = phone_number
            if display_name:
                updates["instance_name"] = display_name
            try:
                await asyncio.to_thread(
                    storage.update_org_whatsapp_connection_by_broker_id,
                    broker_id,
                    updates,
                )
            except Exception as exc:
                print(f"[sync/status] persist failed for broker {broker_id}: {exc}", flush=True)
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@router.post("/api/phones/{phone_id}/pair-code")
async def pair_code_phone(
    phone_id: int,
    body: dict,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    org_id = await _request_organization_id(user, tenant_id)
    await _require_org_permission(user, org_id, "manage_whatsapp")
    phone = await _scoped_phone(phone_id, org_id)
    broker_id = phone.get("broker_id", "")
    if not broker_id:
        raise HTTPException(400, "Phone is missing broker_id")
    phone_number = body.get("phone", "").strip()
    if not phone_number:
        raise HTTPException(400, "phone number is required")
    try:
        _, resp = await _first_ingestor_response(
            "POST", "/pair-code", timeout=55,
            params={"broker_id": broker_id},
            json={"phone": phone_number},
        )
    except Exception as exc:
        raise HTTPException(502, f"Ingestor unreachable: {exc}")
    if resp is not None and resp.status_code == 200:
        return resp.json()
    raise HTTPException(502, _ingestor_failure_message(resp))
