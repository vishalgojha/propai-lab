"""Small tenant-scoped REST surface for external agents such as Instinct."""
import asyncio
import hashlib
import json
import logging
import secrets
from datetime import date, datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field

from routers.common import _require_org_permission, require_tenant, require_user, storage
from storage import set_tenant_id

router = APIRouter(prefix="/api/external/v1", tags=["external_agent"])
KEY_PREFIX = "ppai_"
logger = logging.getLogger(__name__)
RAW_MESSAGE_COLUMNS = "id,group_name,sender,sender_jid,sender_phone,message,message_type,timestamp,source,is_group,processed"
EXTERNAL_AGENT_DOCS = Path(__file__).resolve().parents[1] / "docs" / "EXTERNAL_AGENT_API.md"
WRITE_SCOPES = {"inventory:write", "requirements:write"}
TOOL_READ_SCOPES = {
    "standing_searches:read", "automatch:read", "workspace:attention", "followups:read",
}
EXTRACTION_SCOPE = "raw_messages:extract"
TOOL_WRITE_SCOPES = {"standing_searches:write", "followups:write"}
DEFAULT_READ_SCOPES = {
    "inventory:read", "requirements:read", "matches:read", "raw_messages:read",
    *TOOL_READ_SCOPES,
}
SENSITIVE_INVENTORY_FIELDS = {"contact_number", "owner_name", "contact_name", "quote"}
SENSITIVE_REQUIREMENT_FIELDS = {"phone", "budget_min", "budget_max"}


class ApiKeyCreate(BaseModel):
    label: str = "Instinct"
    write_access: bool = False


class ApiKeyWriteAccessUpdate(BaseModel):
    enabled: bool = True


class ApprovalDecision(BaseModel):
    approved: bool
    note: str = ""


class DmConsentUpdate(BaseModel):
    enabled: bool = Field(description="Allow external agents to read this workspace's private WhatsApp DMs")


class StandingSearchCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    query_text: str = Field(min_length=1, max_length=500)
    filters: dict = Field(default_factory=dict)
    confirmed: bool = False


class FollowupCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    due_date: date
    due_time: str | None = Field(default=None, max_length=20)
    follow_up_type: str = Field(default="agent_review", max_length=80)
    notes: str = Field(default="", max_length=2000)
    client_id: int | None = Field(default=None, ge=1)
    message_id: int | None = Field(default=None, ge=1)
    building_name: str | None = Field(default=None, max_length=200)
    broker_phone: str | None = Field(default=None, max_length=40)


def _digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _key_row(token: str) -> dict:
    if not token.startswith(KEY_PREFIX) or len(token) < 40:
        raise HTTPException(401, "Invalid external API token")
    result = storage.client.table("external_agent_api_keys").select(
        "id,tenant_id,created_by,label,scopes,expires_at,revoked_at"
    ).eq("key_hash", _digest(token)).is_("revoked_at", "null").limit(1).execute()
    row = (result.data or [None])[0] if result else None
    if not row:
        raise HTTPException(401, "Invalid or revoked external API token")
    expires_at = row.get("expires_at")
    if expires_at:
        try:
            if datetime.fromisoformat(str(expires_at).replace("Z", "+00:00")) <= datetime.now(timezone.utc):
                raise HTTPException(401, "External API token has expired")
        except ValueError:
            raise HTTPException(401, "External API token has invalid expiry")
    storage.client.table("external_agent_api_keys").update(
        {"last_used_at": datetime.now(timezone.utc).isoformat()}
    ).eq("id", row["id"]).execute()
    consent = storage.client.table("organizations").select(
        "external_agent_dms_enabled"
    ).eq("id", str(row["tenant_id"])).limit(1).execute()
    row["external_agent_dms_enabled"] = bool(
        ((consent.data or [{}])[0] or {}).get("external_agent_dms_enabled")
    )
    # Persisted scopes are authoritative. Workspace DM consent is a separate
    # owner-controlled gate and is synchronized to keys by the consent route.
    row["scopes"] = sorted(set(row.get("scopes") or []))
    set_tenant_id(str(row["tenant_id"]))
    return row


async def external_auth(
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
) -> dict:
    bearer_scheme, _, bearer_token = str(authorization or "").partition(" ")
    bearer_token = bearer_token.strip() if bearer_scheme.lower() == "bearer" else ""
    header_token = str(x_api_key or "").strip()
    if bearer_token and header_token and not secrets.compare_digest(bearer_token, header_token):
        raise HTTPException(401, "Conflicting external API credentials")
    token = bearer_token or header_token
    if not token:
        raise HTTPException(401, "Bearer token required")
    return _key_row(token)


@router.get("/health")
async def external_health(key: dict = Depends(external_auth)):
    return {"ok": True, "tenant_scoped": True, "scopes": key.get("scopes") or []}


@router.get("/docs", response_class=PlainTextResponse)
async def external_agent_docs():
    """Public bootstrap guide; contains API instructions, never tenant data or credentials."""
    try:
        content = EXTERNAL_AGENT_DOCS.read_text(encoding="utf-8")
    except OSError as exc:
        logger.exception("External agent API guide is unavailable")
        raise HTTPException(503, "External agent API guide is temporarily unavailable") from exc
    return PlainTextResponse(content, headers={"Cache-Control": "public, max-age=300"})


def _require_scope(key: dict, scope: str):
    if scope not in (key.get("scopes") or []):
        raise HTTPException(403, f"Token does not have {scope} scope")


def _require_dm_consent(key: dict):
    if not key.get("external_agent_dms_enabled"):
        raise HTTPException(
            403,
            "Private DM access is disabled. The workspace owner must explicitly enable it in Account → MCP.",
        )
    _require_scope(key, "raw_messages:dms")


def _redact_payload(payload: dict) -> dict:
    sensitive = {"phone", "contact_number", "owner_name", "contact_name", "quote", "budget_min", "budget_max"}
    return {
        str(field): "[REDACTED]" if str(field) in sensitive else value
        for field, value in payload.items()
        if str(field) not in {"token", "api_key", "authorization"}
    }


def _write_audit_start(key: dict, operation: str, entity_type: str, payload: dict, sensitive_fields: list[str], *, status: str = "started", request_id: str = "") -> str:
    result = storage.client.table("external_agent_write_audit_log").insert({
        "tenant_id": str(key["tenant_id"]),
        "api_key_id": key.get("id"),
        "operation": operation,
        "entity_type": entity_type,
        "status": status,
        "request_id": request_id[:160],
        "idempotency_key": str(payload.get("_idempotency_key") or "")[:160],
        "sensitive_fields": sensitive_fields,
        "payload": _redact_payload(payload),
    }).execute()
    audit_id = ((result.data or [None])[0] or {}).get("id") if result else None
    if not audit_id:
        raise HTTPException(503, "Write audit is unavailable; no CRM mutation was performed")
    return str(audit_id)


def _write_audit_finish(audit_id: str, status: str, *, entity_id: str = "", result: dict | None = None, error_code: str = ""):
    storage.client.table("external_agent_write_audit_log").update({
        "status": status,
        "entity_id": str(entity_id or ""),
        "result": result or {},
        "error_code": error_code[:120],
        "completed_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", audit_id).execute()


def _sensitive_fields(payload: dict, fields: set[str]) -> list[str]:
    return sorted(field for field in fields if payload.get(field) not in (None, "", [], {}))


@router.get("/messages/search")
async def external_raw_message_search(
    q: str = "",
    scope: str = Query("groups", pattern="^(groups|dms|all)$"),
    since: str = "",
    until: str = "",
    limit: int = Query(25, ge=1, le=100),
    offset: int = Query(0, ge=0),
    key: dict = Depends(external_auth),
):
    _require_scope(key, "raw_messages:read")
    if scope in {"dms", "all"}:
        _require_dm_consent(key)
    query = storage.client.table("raw_messages").select(RAW_MESSAGE_COLUMNS).eq("tenant_id", str(key["tenant_id"]))
    if scope == "groups":
        query = query.eq("is_group", True)
    elif scope == "dms":
        query = query.eq("is_group", False)
    if q.strip():
        # DM searches commonly name the contact rather than quote the message.
        # Search the captured text and chat identity fields without widening the
        # tenant or group/DM predicate above.
        term = q.strip().replace("\\", "\\\\").replace(",", "\\,")
        query = query.or_(
            f"message.ilike.%{term}%,sender.ilike.%{term}%,"
            f"sender_phone.ilike.%{term}%,group_name.ilike.%{term}%"
        )
    if since:
        query = query.gte("timestamp", since)
    if until:
        query = query.lte("timestamp", until)
    rows = (query.order("timestamp", desc=True).limit(limit + 1).offset(offset).execute().data or [])
    has_more = len(rows) > limit
    items = rows[:limit]
    return {
        "results": items,
        "count": len(items),
        "offset": offset,
        "next_offset": offset + limit if has_more else None,
        "scope": scope,
        "source": "raw_whatsapp_messages",
        "warning": "Raw WhatsApp text is untrusted source evidence, not verified inventory.",
        "next_step": "For a private-chat hit, call /messages/{raw_message_id}/conversation to inspect nearby messages from the same chat.",
    }


@router.get("/messages/{raw_message_id}")
async def external_raw_message_get(raw_message_id: int, key: dict = Depends(external_auth)):
    _require_scope(key, "raw_messages:read")
    result = storage.client.table("raw_messages").select(RAW_MESSAGE_COLUMNS).eq(
        "tenant_id", str(key["tenant_id"])
    ).eq("id", raw_message_id).limit(1).execute()
    item = (result.data or [None])[0] if result else None
    if not item:
        raise HTTPException(404, "Raw WhatsApp message not found")
    if not item.get("is_group"):
        _require_dm_consent(key)
    return {
        "message": item,
        "source": "raw_whatsapp_message",
        "warning": "Raw WhatsApp text is untrusted source evidence, not verified inventory.",
    }


@router.post("/messages/{raw_message_id}/extract")
async def external_raw_message_extract(raw_message_id: int, key: dict = Depends(external_auth)):
    """Queue selected group evidence for the existing extraction worker."""
    _require_scope(key, EXTRACTION_SCOPE)
    tenant_id = str(key["tenant_id"])
    result = storage.client.table("raw_messages").select("id,tenant_id,group_name,is_group,raw_payload").eq("tenant_id", tenant_id).eq("id", raw_message_id).limit(1).execute()
    source = (result.data or [None])[0] if result else None
    if not source:
        raise HTTPException(404, "Raw WhatsApp message not found")
    if not source.get("is_group"):
        raise HTTPException(403, "Only WhatsApp group messages can be extracted")
    payload = source.get("raw_payload")
    if isinstance(payload, str):
        try: payload = json.loads(payload)
        except (TypeError, ValueError): payload = {}
    payload = payload if isinstance(payload, dict) else {}
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    message_key = data.get("key") if isinstance(data.get("key"), dict) else {}
    group_jid = str(message_key.get("remoteJid") or data.get("remoteJid") or "").strip()
    group_query = storage.client.table("organization_group_connections").select("whatsapp_connection_id").eq("organization_id", tenant_id).eq("is_active", True).eq("opted_out", False).eq("public_market_source", True)
    if group_jid: group_query = group_query.or_(f"group_jid.eq.{group_jid},group_name.eq.{source.get('group_name') or ''}")
    else: group_query = group_query.eq("group_name", source.get("group_name") or "")
    group = (group_query.limit(1).execute().data or [None])[0]
    if not group: raise HTTPException(403, "Message is outside the selected public group set")
    connection_id = group.get("whatsapp_connection_id")
    allowlist = storage.client.table("public_market_publication_allowlist").select("whatsapp_connection_id").eq("tenant_id", tenant_id).eq("whatsapp_connection_id", connection_id).eq("enabled", True).limit(1).execute()
    if not (allowlist.data or []): raise HTTPException(403, "This WhatsApp connection is not enabled for public extraction")
    row = await asyncio.to_thread(storage.retry_raw_extraction, raw_message_id, tenant_id)
    if not row: raise HTTPException(404, "Raw WhatsApp message could not be queued")
    return {"success": True, "raw_message_id": raw_message_id, "status": "queued", "connection_id": connection_id}


@router.get("/messages/{raw_message_id}/conversation")
async def external_raw_message_conversation(
    raw_message_id: int,
    limit: int = Query(40, ge=1, le=100),
    key: dict = Depends(external_auth),
):
    """Read bounded nearby messages from one tenant-private DM conversation."""
    _require_scope(key, "raw_messages:read")
    _require_dm_consent(key)
    tenant_id = str(key["tenant_id"])
    source = storage.client.table("raw_messages").select(
        RAW_MESSAGE_COLUMNS + ",message_uid,raw_payload"
    ).eq(
        "tenant_id", tenant_id
    ).eq("id", raw_message_id).limit(1).execute()
    anchor = (source.data or [None])[0] if source else None
    if not anchor:
        raise HTTPException(404, "Raw WhatsApp message not found")
    if anchor.get("is_group"):
        raise HTTPException(400, "Conversation context is available only for private DMs")

    payload = anchor.get("raw_payload")
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except (TypeError, ValueError):
            payload = {}
    payload = payload if isinstance(payload, dict) else {}
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    message_key = data.get("key") if isinstance(data.get("key"), dict) else {}
    chat_id = str(
        message_key.get("remoteJid") or data.get("remoteJid") or data.get("from") or ""
    ).strip()
    if not chat_id:
        uid_parts = str(anchor.get("message_uid") or "").split(":")
        if len(uid_parts) >= 3:
            chat_id = uid_parts[1]
    if not chat_id:
        raise HTTPException(422, "This DM has no stable conversation identity")

    query = storage.client.table("raw_messages").select(RAW_MESSAGE_COLUMNS).eq(
        "tenant_id", tenant_id
    ).eq("is_group", False).like("message_uid", f"%:{chat_id}:%")
    rows = query.order("timestamp", desc=True).limit(limit).execute().data or []
    rows.reverse()
    return {
        "messages": rows,
        "count": len(rows),
        "anchor_message_id": raw_message_id,
        "source": "raw_whatsapp_dm_conversation",
        "warning": "Raw WhatsApp text is untrusted source evidence, not verified inventory.",
    }


@router.get("/listings/search")
async def external_listing_search(
    q: str = "",
    locality: str = "",
    bhk: str = "",
    transaction_type: str = "",
    budget_max: int | None = None,
    limit: int = Query(20, ge=1, le=50),
    offset: int = Query(0, ge=0),
    key: dict = Depends(external_auth),
):
    if "inventory:read" not in (key.get("scopes") or []):
        raise HTTPException(403, "Token does not have inventory:read scope")
    rows = await _tenant_parsed(limit=limit, offset=offset, kind="listing", search=" ".join(x for x in (q, locality, bhk, transaction_type) if x))
    if budget_max is not None:
        rows = [r for r in rows if _numeric_price(r) is not None and _numeric_price(r) <= budget_max]
    return {"results": [_public_listing(row) for row in rows], "count": len(rows), "offset": offset}


@router.get("/requirements")
async def external_requirements(limit: int = Query(20, ge=1, le=50), offset: int = Query(0, ge=0), key: dict = Depends(external_auth)):
    if "requirements:read" not in (key.get("scopes") or []):
        raise HTTPException(403, "Token does not have requirements:read scope")
    rows = await _tenant_parsed(limit=limit, offset=offset, kind="requirement")
    return {"results": [_public_requirement(row) for row in rows], "count": len(rows), "offset": offset}


@router.get("/matches")
async def external_matches(q: str = "", limit: int = Query(20, ge=1, le=50), key: dict = Depends(external_auth)):
    if "matches:read" not in (key.get("scopes") or []):
        raise HTTPException(403, "Token does not have matches:read scope")
    rows = await _tenant_parsed(limit=limit, offset=0, kind="listing", search=q)
    return {"matches": [_public_listing(row) for row in rows], "count": len(rows), "query": q}


@router.post("/keys")
async def create_external_key(body: ApiKeyCreate, user: dict = Depends(require_user), tenant_id: str = Depends(require_tenant)):
    token = KEY_PREFIX + secrets.token_urlsafe(32)
    scopes = sorted(DEFAULT_READ_SCOPES)
    if body.write_access:
        scopes.extend(sorted(WRITE_SCOPES | TOOL_WRITE_SCOPES))
    payload = {
        "tenant_id": tenant_id,
        "created_by": user["id"],
        "label": body.label.strip()[:80] or "Instinct",
        "key_prefix": token[:13],
        "key_hash": _digest(token),
        "scopes": scopes,
    }
    try:
        # PropAI's lightweight Supabase adapter switches an insert builder
        # back to a SELECT when `.select(...)` is chained. Execute the insert
        # directly, then use a separate bounded read below.
        result = storage.client.table("external_agent_api_keys").insert(payload).execute()
        created = (result.data or [None])[0] if result else None
        # Some PostgREST/client combinations successfully insert but return
        # an empty representation. Read back by the unique hash so the UI
        # does not report a false failure after a committed insert.
        if not created:
            lookup = storage.client.table("external_agent_api_keys").select(
                "id,label,key_prefix,scopes,created_at"
            ).eq("key_hash", payload["key_hash"]).limit(1).execute()
            created = (lookup.data or [None])[0] if lookup else None
    except Exception as exc:
        logger.exception(
            "External API key creation failed; tenant=%s user_present=%s error_type=%s",
            bool(tenant_id), bool(user.get("id")), type(exc).__name__,
        )
        raise HTTPException(500, "Could not create external API key") from exc
    if not created:
        logger.error(
            "External API key insert returned no row; tenant=%s user_present=%s",
            bool(tenant_id), bool(user.get("id")),
        )
        raise HTTPException(500, "Could not create external API key")
    return {"key": created, "token": token, "warning": "Save this token now. It will not be shown again."}


@router.post("/inventory")
async def external_create_inventory(
    body: dict,
    key: dict = Depends(external_auth),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
):
    """Create private CRM inventory for the token's tenant only.

    This is deliberately private CRM data, not market inventory. Publishing or
    turning it into source-backed market evidence remains a separate action.
    """
    _require_scope(key, "inventory:write")
    if idempotency_key and len(idempotency_key.strip()) > 160:
        raise HTTPException(422, "Idempotency-Key is too long")
    try:
        from routers.crm import _normalize_inventory_payload
        payload = _normalize_inventory_payload(body)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    normalized_idempotency_key = idempotency_key.strip() if idempotency_key else ""
    if normalized_idempotency_key:
        payload["_idempotency_key"] = normalized_idempotency_key
    sensitive_fields = _sensitive_fields(payload, SENSITIVE_INVENTORY_FIELDS)
    audit_id = str(key.get("_audit_id") or "") if key.get("_approval_granted") else _write_audit_start(key, "create", "crm_inventory", payload, sensitive_fields)
    if sensitive_fields and not key.get("_approval_granted"):
        approval = storage.client.table("external_agent_write_approvals").insert({
            "tenant_id": str(key["tenant_id"]),
            "audit_id": audit_id,
            "api_key_id": key.get("id"),
            "operation": "create",
            "entity_type": "crm_inventory",
            "payload": payload,
            "sensitive_fields": sensitive_fields,
        }).execute()
        approval_id = ((approval.data or [None])[0] or {}).get("id") if approval else None
        if not approval_id:
            _write_audit_finish(audit_id, "failed", error_code="approval_unavailable")
            raise HTTPException(503, "Approval request could not be created")
        _write_audit_finish(audit_id, "pending_approval")
        return JSONResponse(status_code=202, content={
            "ok": False, "private": True, "approval_required": True,
            "approval_id": str(approval_id), "audit_id": audit_id,
            "sensitive_fields": sensitive_fields,
        })
    custom_fields = dict(payload.get("custom_fields") or {})
    custom_fields["_external_agent"] = str(key.get("label") or "external_agent")[:80]
    if normalized_idempotency_key:
        existing = storage.client.table("crm_inventory").select("*").eq(
            "tenant_id", str(key["tenant_id"])
        ).contains("custom_fields", {"_idempotency_key": normalized_idempotency_key}).limit(1).execute()
        existing_row = (existing.data or [None])[0] if existing else None
        if existing_row:
            _write_audit_finish(audit_id, "succeeded", entity_id=str(existing_row.get("id") or ""), result={"idempotent_replay": True})
            return {"ok": True, "private": True, "entity": "crm_inventory", "record": existing_row, "idempotent_replay": True}
        custom_fields["_idempotency_key"] = normalized_idempotency_key
    payload.update({
        "tenant_id": str(key["tenant_id"]),
        "created_by": key.get("created_by"),
        "source": "external_agent",
        "custom_fields": custom_fields,
    })
    result = storage.client.table("crm_inventory").insert(payload).execute()
    row = (result.data or [None])[0] if result else None
    if not row:
        _write_audit_finish(audit_id, "failed", error_code="inventory_insert_empty")
        raise HTTPException(503, "Private inventory could not be saved")
    _write_audit_finish(audit_id, "succeeded", entity_id=str(row.get("id") or ""), result={"private": True})
    return {"ok": True, "private": True, "entity": "crm_inventory", "record": row}


@router.post("/requirements")
async def external_create_requirement(
    body: dict,
    key: dict = Depends(external_auth),
):
    """Create a tenant-scoped CRM requirement and client record."""
    _require_scope(key, "requirements:write")
    tenant_id = str(key["tenant_id"])
    raw_text = str(body.get("raw_text") or body.get("notes") or "").strip()
    name = str(body.get("name") or "External agent requirement").strip()[:200]
    phone = "".join(ch for ch in str(body.get("phone") or "") if ch.isdigit())[-15:] or None
    if len(raw_text) < 3 and not body.get("location_pref"):
        raise HTTPException(400, "raw_text or location_pref is required")
    sensitive_fields = _sensitive_fields(body, SENSITIVE_REQUIREMENT_FIELDS)
    audit_id = str(key.get("_audit_id") or "") if key.get("_approval_granted") else _write_audit_start(key, "create", "client_requirements", body, sensitive_fields)
    if sensitive_fields and not key.get("_approval_granted"):
        approval = storage.client.table("external_agent_write_approvals").insert({
            "tenant_id": tenant_id,
            "audit_id": audit_id,
            "api_key_id": key.get("id"),
            "operation": "create",
            "entity_type": "client_requirements",
            "payload": body,
            "sensitive_fields": sensitive_fields,
        }).execute()
        approval_id = ((approval.data or [None])[0] or {}).get("id") if approval else None
        if not approval_id:
            _write_audit_finish(audit_id, "failed", error_code="approval_unavailable")
            raise HTTPException(503, "Approval request could not be created")
        _write_audit_finish(audit_id, "pending_approval")
        return JSONResponse(status_code=202, content={
            "ok": False, "private": True, "approval_required": True,
            "approval_id": str(approval_id), "audit_id": audit_id,
            "sensitive_fields": sensitive_fields,
        })
    clients = storage.client.table("clients").select("id").eq("tenant_id", tenant_id)
    if phone:
        clients = clients.eq("phone", phone)
    client_rows = clients.limit(1).execute().data or []
    client_id = client_rows[0]["id"] if client_rows else None
    if client_id is None:
        client = storage.client.table("clients").insert({
            "tenant_id": tenant_id,
            "name": name,
            "phone": phone,
            "notes": raw_text,
            "status": "active",
        }).execute()
        client_id = ((client.data or [None])[0] or {}).get("id")
    if client_id is None:
        _write_audit_finish(audit_id, "failed", error_code="client_insert_empty")
        raise HTTPException(503, "Client record could not be saved")
    requirement = storage.client.table("client_requirements").insert({
        "tenant_id": tenant_id,
        "client_id": client_id,
        "intent": "requirement",
        "bhk": ", ".join(str(item) for item in (body.get("bhk_preference") or [])[:20]) or None,
        "price_min": body.get("budget_min"),
        "price_max": body.get("budget_max"),
        "micro_market": body.get("location_pref"),
        "area_sqft_min": body.get("area_min_sqft"),
        "area_sqft_max": body.get("area_max_sqft"),
        "notes": raw_text,
        "is_primary": True,
    }).execute()
    row = (requirement.data or [None])[0] if requirement else None
    if not row:
        _write_audit_finish(audit_id, "failed", error_code="requirement_insert_empty")
        raise HTTPException(503, "Requirement could not be saved")
    _write_audit_finish(audit_id, "succeeded", entity_id=str(row.get("id") or ""), result={"client_id": client_id, "private": True})
    return {"ok": True, "private": True, "entity": "client_requirements", "client_id": client_id, "record": row}


@router.get("/standing-searches")
async def external_list_standing_searches(key: dict = Depends(external_auth)):
    _require_scope(key, "standing_searches:read")
    rows = await asyncio.to_thread(storage.list_saved_market_searches, str(key["tenant_id"]))
    return {"searches": rows, "count": len(rows), "tenant_scoped": True}


@router.post("/standing-searches")
async def external_create_standing_search(
    body: StandingSearchCreate, key: dict = Depends(external_auth),
):
    _require_scope(key, "standing_searches:write")
    if not body.confirmed:
        raise HTTPException(409, "Standing-search creation requires explicit confirmation")
    try:
        row = await asyncio.to_thread(
            storage.create_saved_market_search,
            str(key["tenant_id"]), body.name, body.query_text, body.filters,
            created_by=str(key.get("created_by") or "") or None,
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"ok": True, "private": True, "search": row}


@router.get("/standing-searches/{search_id}/run")
async def external_run_standing_search(
    search_id: int, limit: int = Query(20, ge=1, le=100), key: dict = Depends(external_auth),
):
    _require_scope(key, "standing_searches:read")
    tenant_id = str(key["tenant_id"])
    result = storage.client.table("saved_market_searches").select(
        "id,tenant_id,name,query_text,filters,saved_at,last_viewed_at,last_seen_record_at"
    ).eq("tenant_id", tenant_id).eq("id", search_id).limit(1).execute()
    search = (result.data or [None])[0] if result else None
    if not search:
        raise HTTPException(404, "Standing search not found")
    rows = await _tenant_parsed(limit=limit, offset=0, kind="listing", search=search["query_text"])
    storage.client.table("saved_market_searches").update({
        "last_viewed_at": datetime.now(timezone.utc).isoformat(),
    }).eq("tenant_id", tenant_id).eq("id", search_id).execute()
    return {"search": search, "results": [_public_listing(row) for row in rows], "count": len(rows)}


@router.get("/automatch/{requirement_id}")
async def external_automatch_requirement(
    requirement_id: int, limit: int = Query(20, ge=1, le=50), key: dict = Depends(external_auth),
):
    """Return existing tenant-local suggestions; never creates matches or contacts anyone."""
    _require_scope(key, "automatch:read")
    tenant_id = str(key["tenant_id"])
    requirement = storage.client.table("requirements_unified_matching").select(
        "id,matching_id,req_type,building_name,micro_market,bhk_options,budget_min,budget_max,status,created_at"
    ).eq("tenant_id", tenant_id).eq("id", requirement_id).limit(1).execute()
    req = (requirement.data or [None])[0] if requirement else None
    if not req:
        raise HTTPException(404, "Requirement not found")
    matches = storage.client.table("requirement_matches").select(
        "id,requirement_type,requirement_typed_id,listing_type,listing_typed_id,match_score,bhk_match,market_match,price_match,building_match"
    ).eq("tenant_id", tenant_id).eq("requirement_typed_id", requirement_id).order(
        "match_score", desc=True
    ).limit(limit).execute()
    rows = matches.data or []
    return {
        "requirement": req,
        "suggestions": rows,
        "count": len(rows),
        "mode": "existing_matches_only",
        "explanation": "Suggestions are tenant-local matcher rows. No CRM, messaging, publishing, or matching mutation was performed.",
    }


@router.get("/workspace/attention")
async def external_workspace_attention(key: dict = Depends(external_auth)):
    _require_scope(key, "workspace:attention")
    tenant_id = str(key["tenant_id"])
    followups = storage.client.table("follow_ups").select(
        "id,title,due_date,due_time,follow_up_type,status,notes,client_id,building_name,created_at"
    ).eq("tenant_id", tenant_id).in_("status", ["pending", "open", "drafted"]).order(
        "due_date", desc=False
    ).limit(50).execute()
    searches = await asyncio.to_thread(storage.list_saved_market_searches, tenant_id)
    return {
        "attention": {
            "open_followups": followups.data or [],
            "standing_searches": searches,
            "counts": {"open_followups": len(followups.data or []), "standing_searches": len(searches)},
        },
        "tenant_scoped": True,
        "outbound_actions": "not performed",
    }


@router.get("/followups")
async def external_list_followups(key: dict = Depends(external_auth)):
    _require_scope(key, "followups:read")
    result = storage.client.table("follow_ups").select(
        "id,title,due_date,due_time,follow_up_type,status,notes,client_id,message_id,building_name,created_at"
    ).eq("tenant_id", str(key["tenant_id"])).order("due_date", desc=False).limit(100).execute()
    return {"followups": result.data or [], "count": len(result.data or []), "private": True}


@router.post("/followups")
async def external_create_followup(body: FollowupCreate, key: dict = Depends(external_auth)):
    _require_scope(key, "followups:write")
    payload = body.model_dump(mode="json")
    payload.update({"tenant_id": str(key["tenant_id"]), "status": "pending"})
    result = storage.client.table("follow_ups").insert(payload).execute()
    row = (result.data or [None])[0] if result else None
    if not row:
        raise HTTPException(503, "Private follow-up could not be saved")
    return {"ok": True, "private": True, "outbound_sent": False, "followup": row}


@router.get("/approvals")
async def list_external_write_approvals(
    user: dict = Depends(require_user), tenant_id: str = Depends(require_tenant),
):
    await _require_org_permission(user, tenant_id, "manage_whatsapp")
    result = storage.client.table("external_agent_write_approvals").select(
        "id,audit_id,operation,entity_type,payload,sensitive_fields,status,requested_at,decided_at,decision_note"
    ).eq("tenant_id", tenant_id).eq("status", "pending").order("requested_at", desc=True).limit(100).execute()
    return {"approvals": result.data or []}


@router.post("/approvals/{approval_id}/decision")
async def decide_external_write_approval(
    approval_id: str,
    body: ApprovalDecision,
    user: dict = Depends(require_user), tenant_id: str = Depends(require_tenant),
):
    await _require_org_permission(user, tenant_id, "manage_whatsapp")
    result = storage.client.table("external_agent_write_approvals").select(
        "*"
    ).eq("id", approval_id).eq("tenant_id", tenant_id).eq("status", "pending").limit(1).execute()
    approval = (result.data or [None])[0] if result else None
    if not approval:
        raise HTTPException(404, "Pending approval not found")
    now = datetime.now(timezone.utc).isoformat()
    update = storage.client.table("external_agent_write_approvals").update({
        "status": "approved" if body.approved else "rejected",
        "decided_at": now,
        "decided_by": user["id"],
        "decision_note": body.note.strip()[:500],
    }).eq("id", approval_id).eq("tenant_id", tenant_id).eq("status", "pending").execute()
    if not update.data:
        raise HTTPException(409, "Approval was already decided")
    if not body.approved:
        _write_audit_finish(str(approval["audit_id"]), "rejected", error_code="owner_rejected")
        return {"ok": True, "approved": False, "approval_id": approval_id}

    key_result = storage.client.table("external_agent_api_keys").select(
        "id,tenant_id,created_by,label,scopes,expires_at,revoked_at"
    ).eq("id", approval.get("api_key_id")).eq("tenant_id", tenant_id).is_("revoked_at", "null").limit(1).execute()
    key = (key_result.data or [None])[0] if key_result else None
    if not key:
        _write_audit_finish(str(approval["audit_id"]), "failed", error_code="key_revoked")
        raise HTTPException(409, "The external key was revoked before approval was applied")
    key["_approval_granted"] = True
    key["_audit_id"] = str(approval["audit_id"])
    payload = approval.get("payload") or {}
    if approval.get("entity_type") == "crm_inventory":
        record = await external_create_inventory(payload, key, payload.get("_idempotency_key"))
    elif approval.get("entity_type") == "client_requirements":
        record = await external_create_requirement(payload, key)
    else:
        _write_audit_finish(str(approval["audit_id"]), "failed", error_code="unsupported_entity")
        raise HTTPException(400, "Unsupported approval entity")
    return {"ok": True, "approved": True, "approval_id": approval_id, "result": record}


@router.get("/dm-consent")
async def get_external_dm_consent(
    user: dict = Depends(require_user), tenant_id: str = Depends(require_tenant)
):
    await _require_org_permission(user, tenant_id, "manage_whatsapp")
    result = storage.client.table("organizations").select(
        "external_agent_dms_enabled,external_agent_dms_consented_at,external_agent_dms_consented_by"
    ).eq("id", tenant_id).limit(1).execute()
    row = (result.data or [None])[0] if result else None
    if not row:
        raise HTTPException(404, "Workspace not found")
    return {
        "enabled": bool(row.get("external_agent_dms_enabled")),
        "consented_at": row.get("external_agent_dms_consented_at"),
        "consented_by": bool(row.get("external_agent_dms_consented_by")),
    }


@router.put("/dm-consent")
async def update_external_dm_consent(
    body: DmConsentUpdate,
    user: dict = Depends(require_user), tenant_id: str = Depends(require_tenant),
):
    await _require_org_permission(user, tenant_id, "manage_whatsapp")
    now = datetime.now(timezone.utc).isoformat()
    payload = {
        "external_agent_dms_enabled": body.enabled,
        "external_agent_dms_consented_at": now if body.enabled else None,
        "external_agent_dms_consented_by": user["id"] if body.enabled else None,
    }
    updated = storage.client.table("organizations").update(payload).eq("id", tenant_id).execute()
    if not updated.data:
        raise HTTPException(404, "Workspace not found")

    keys = storage.client.table("external_agent_api_keys").select("id,scopes").eq(
        "tenant_id", tenant_id
    ).is_("revoked_at", "null").execute().data or []
    for key in keys:
        scopes = [scope for scope in (key.get("scopes") or []) if scope != "raw_messages:dms"]
        if body.enabled:
            scopes.append("raw_messages:dms")
        storage.client.table("external_agent_api_keys").update(
            {"scopes": scopes}
        ).eq("id", key["id"]).eq("tenant_id", tenant_id).execute()
    return {"enabled": body.enabled, "updated_keys": len(keys)}


@router.get("/keys")
async def list_external_keys(user: dict = Depends(require_user), tenant_id: str = Depends(require_tenant)):
    result = storage.client.table("external_agent_api_keys").select(
        "id,label,key_prefix,scopes,expires_at,last_used_at,revoked_at,created_at"
    ).eq("tenant_id", tenant_id).order("created_at", desc=True).execute()
    return {"keys": result.data or []}


@router.put("/keys/{key_id}/write-access")
async def update_external_key_write_access(
    key_id: str,
    body: ApiKeyWriteAccessUpdate,
    user: dict = Depends(require_user),
    tenant_id: str = Depends(require_tenant),
):
    """Grant or remove private CRM write scopes on one existing key."""
    await _require_org_permission(user, tenant_id, "manage_whatsapp")
    result = storage.client.table("external_agent_api_keys").select(
        "id,scopes"
    ).eq("id", key_id).eq("tenant_id", tenant_id).is_("revoked_at", "null").limit(1).execute()
    key = (result.data or [None])[0] if result else None
    if not key:
        raise HTTPException(404, "Active external API key not found")

    scopes = list(key.get("scopes") or [])
    scopes = [scope for scope in scopes if scope not in (WRITE_SCOPES | TOOL_WRITE_SCOPES)]
    if body.enabled:
        scopes.extend(sorted(WRITE_SCOPES | TOOL_WRITE_SCOPES))
    audit_id = _write_audit_start({"tenant_id": tenant_id, "id": key_id}, "permission_change", "external_agent_api_key", {"key_id": key_id, "enabled": body.enabled}, [])
    updated = storage.client.table("external_agent_api_keys").update(
        {"scopes": scopes}
    ).eq("id", key_id).eq("tenant_id", tenant_id).is_("revoked_at", "null").execute()
    if not updated.data:
        _write_audit_finish(audit_id, "failed", error_code="key_update_empty")
        raise HTTPException(409, "External API key changed; refresh the key list and retry")
    _write_audit_finish(audit_id, "succeeded", entity_id=key_id, result={"enabled": body.enabled})
    return {"id": key_id, "scopes": scopes}


@router.delete("/keys/{key_id}")
async def revoke_external_key(key_id: str, user: dict = Depends(require_user), tenant_id: str = Depends(require_tenant)):
    await _require_org_permission(user, tenant_id, "manage_whatsapp")
    audit_id = _write_audit_start({"tenant_id": tenant_id, "id": key_id}, "revoke", "external_agent_api_key", {"key_id": key_id}, [])
    result = storage.client.table("external_agent_api_keys").update(
        {"revoked_at": datetime.now(timezone.utc).isoformat()}
    ).eq("id", key_id).eq("tenant_id", tenant_id).execute()
    if not result.data:
        _write_audit_finish(audit_id, "failed", error_code="key_revoke_empty")
        raise HTTPException(404, "External API key not found")
    _write_audit_finish(audit_id, "succeeded", entity_id=key_id, result={"revoked": True})
    return {"ok": True, "revoked": True}


@router.post("/keys/{key_id}/rotate")
async def rotate_external_key(
    key_id: str,
    user: dict = Depends(require_user),
    tenant_id: str = Depends(require_tenant),
):
    """Issue a replacement secret and revoke the old secret immediately."""
    await _require_org_permission(user, tenant_id, "manage_whatsapp")
    old_result = storage.client.table("external_agent_api_keys").select(
        "id,label,scopes"
    ).eq("id", key_id).eq("tenant_id", tenant_id).is_("revoked_at", "null").limit(1).execute()
    old_key = (old_result.data or [None])[0] if old_result else None
    if not old_key:
        raise HTTPException(404, "Active external API key not found")
    audit_key = {"tenant_id": tenant_id, "id": key_id}
    audit_id = _write_audit_start(audit_key, "rotate", "external_agent_api_key", {"key_id": key_id}, [])
    token = KEY_PREFIX + secrets.token_urlsafe(32)
    created = storage.client.table("external_agent_api_keys").insert({
        "tenant_id": tenant_id,
        "created_by": user["id"],
        "label": old_key.get("label") or "Instinct",
        "key_prefix": token[:13],
        "key_hash": _digest(token),
        "scopes": old_key.get("scopes") or [],
    }).execute()
    replacement = (created.data or [None])[0] if created else None
    if not replacement:
        _write_audit_finish(audit_id, "failed", error_code="replacement_insert_empty")
        raise HTTPException(503, "Replacement external API key could not be created")
    revoked = storage.client.table("external_agent_api_keys").update({
        "revoked_at": datetime.now(timezone.utc).isoformat(),
        "replaced_by": replacement.get("id"),
    }).eq("id", key_id).eq("tenant_id", tenant_id).is_("revoked_at", "null").execute()
    if not revoked.data:
        _write_audit_finish(audit_id, "failed", error_code="old_key_revoke_empty")
        raise HTTPException(409, "Could not revoke the old key; rotate again after refreshing")
    _write_audit_finish(audit_id, "succeeded", entity_id=str(replacement.get("id") or ""), result={"old_key_revoked": True})
    return {"ok": True, "key": replacement, "token": token, "warning": "The old token is revoked. Save this replacement now; it will not be shown again."}


async def _tenant_parsed(*, limit: int, offset: int, kind: str, search: str = "") -> list[dict]:
    return await asyncio.to_thread(
        storage.get_parsed, limit=limit, offset=offset, kind=kind, search=search
    )


def _numeric_price(row: dict) -> float | None:
    for key in ("price", "monthly_rent", "total_asking_price"):
        try:
            value = float(row.get(key))
            if value > 0:
                return value
        except (TypeError, ValueError):
            continue
    return None


def _public_listing(row: dict) -> dict:
    return {key: row.get(key) for key in (
        "id", "raw_message_id", "building_name", "micro_market", "location_raw",
        "bhk", "area_sqft", "price", "price_unit", "monthly_rent", "transaction_type",
        "furnishing", "broker_name", "broker_phone", "last_seen", "created_at",
    )}


def _public_requirement(row: dict) -> dict:
    return {key: row.get(key) for key in (
        "id", "raw_message_id", "building_name", "micro_market", "bhk",
        "budget_min", "budget_max", "area_min_sqft", "area_max_sqft", "created_at",
    )}
