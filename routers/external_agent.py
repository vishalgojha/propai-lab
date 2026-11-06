"""Small tenant-scoped REST surface for external agents such as Instinct."""
import asyncio
import hashlib
import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel

from routers.common import require_tenant, require_user, storage
from storage import set_tenant_id

router = APIRouter(prefix="/api/external/v1", tags=["external_agent"])
KEY_PREFIX = "ppai_"


class ApiKeyCreate(BaseModel):
    label: str = "Instinct"


def _digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _key_row(token: str) -> dict:
    if not token.startswith(KEY_PREFIX) or len(token) < 40:
        raise HTTPException(401, "Invalid external API token")
    result = storage.client.table("external_agent_api_keys").select(
        "id,tenant_id,scopes,expires_at,revoked_at"
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
    set_tenant_id(str(row["tenant_id"]))
    return row


async def external_auth(authorization: str | None = Header(default=None)) -> dict:
    scheme, _, token = str(authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(401, "Bearer token required")
    return _key_row(token.strip())


@router.get("/health")
async def external_health(key: dict = Depends(external_auth)):
    return {"ok": True, "tenant_scoped": True, "scopes": key.get("scopes") or []}


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
    result = storage.client.table("external_agent_api_keys").insert({
        "tenant_id": tenant_id,
        "created_by": user["id"],
        "label": body.label.strip()[:80] or "Instinct",
        "key_prefix": token[:13],
        "key_hash": _digest(token),
    }).select("id,label,key_prefix,scopes,created_at").execute()
    created = (result.data or [None])[0] if result else None
    if not created:
        raise HTTPException(500, "Could not create external API key")
    return {"key": created, "token": token, "warning": "Save this token now. It will not be shown again."}


@router.get("/keys")
async def list_external_keys(user: dict = Depends(require_user), tenant_id: str = Depends(require_tenant)):
    result = storage.client.table("external_agent_api_keys").select(
        "id,label,key_prefix,scopes,expires_at,last_used_at,revoked_at,created_at"
    ).eq("tenant_id", tenant_id).order("created_at", desc=True).execute()
    return {"keys": result.data or []}


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
