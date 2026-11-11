"""Small tenant-scoped REST surface for external agents such as Instinct."""
import asyncio
import hashlib
import logging
import secrets
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

from routers.common import _require_org_permission, require_tenant, require_user, storage
from storage import set_tenant_id

router = APIRouter(prefix="/api/external/v1", tags=["external_agent"])
KEY_PREFIX = "ppai_"
logger = logging.getLogger(__name__)
RAW_MESSAGE_COLUMNS = "id,group_name,sender,sender_phone,message,message_type,timestamp,source,is_group,processed"
EXTERNAL_AGENT_DOCS = Path(__file__).resolve().parents[1] / "docs" / "EXTERNAL_AGENT_API.md"
WRITE_SCOPES = {"inventory:write", "requirements:write"}


class ApiKeyCreate(BaseModel):
    label: str = "Instinct"
    write_access: bool = False


class ApiKeyWriteAccessUpdate(BaseModel):
    enabled: bool = True


class DmConsentUpdate(BaseModel):
    enabled: bool = Field(description="Allow external agents to read this workspace's private WhatsApp DMs")


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
        query = query.ilike("message", f"%{q.strip()}%")
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
    scopes = ["inventory:read", "requirements:read", "matches:read", "raw_messages:read"]
    if body.write_access:
        scopes.extend(sorted(WRITE_SCOPES))
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
    custom_fields = dict(payload.get("custom_fields") or {})
    custom_fields["_external_agent"] = str(key.get("label") or "external_agent")[:80]
    if idempotency_key:
        normalized_idempotency_key = idempotency_key.strip()
        existing = storage.client.table("crm_inventory").select("*").eq(
            "tenant_id", str(key["tenant_id"])
        ).contains("custom_fields", {"_idempotency_key": normalized_idempotency_key}).limit(1).execute()
        existing_row = (existing.data or [None])[0] if existing else None
        if existing_row:
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
        raise HTTPException(503, "Private inventory could not be saved")
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
        raise HTTPException(503, "Requirement could not be saved")
    return {"ok": True, "private": True, "entity": "client_requirements", "client_id": client_id, "record": row}


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
    scopes = [scope for scope in scopes if scope not in WRITE_SCOPES]
    if body.enabled:
        scopes.extend(sorted(WRITE_SCOPES))
    updated = storage.client.table("external_agent_api_keys").update(
        {"scopes": scopes}
    ).eq("id", key_id).eq("tenant_id", tenant_id).is_("revoked_at", "null").execute()
    if not updated.data:
        raise HTTPException(409, "External API key changed; refresh the key list and retry")
    return {"id": key_id, "scopes": scopes}


@router.delete("/keys/{key_id}")
async def revoke_external_key(key_id: str, user: dict = Depends(require_user), tenant_id: str = Depends(require_tenant)):
    result = storage.client.table("external_agent_api_keys").update(
        {"revoked_at": datetime.now(timezone.utc).isoformat()}
    ).eq("id", key_id).eq("tenant_id", tenant_id).execute()
    if not result.data:
        raise HTTPException(404, "External API key not found")
    return {"ok": True, "revoked": True}


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
