"""Broker-controlled Google Drive inventory exports."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse

from routers.common import require_tenant, require_user, storage
from services.google_drive import begin, finish

router = APIRouter(tags=["google-drive"])

MARKET_LISTING_TABLES = {
    "residential_sale_listings", "residential_rent_listings",
    "commercial_sale_listings", "commercial_rent_listings",
}


def _market_refs_for_export(raw_refs) -> list[dict]:
    if not isinstance(raw_refs, list) or not raw_refs:
        raise HTTPException(400, "Select at least one Market Inbox listing")
    grouped: dict[str, set[int]] = {}
    for value in raw_refs:
        if not isinstance(value, dict):
            raise HTTPException(400, "Market listing references are invalid")
        table = str(value.get("source_schema") or "")
        try:
            row_id = int(value.get("source_id"))
        except (TypeError, ValueError) as exc:
            raise HTTPException(400, "Market listing references are invalid") from exc
        if table not in MARKET_LISTING_TABLES or row_id <= 0:
            raise HTTPException(400, "Only visible Market Inbox listings can be exported")
        grouped.setdefault(table, set()).add(row_id)
    if sum(len(ids) for ids in grouped.values()) > 5000:
        raise HTTPException(400, "An export can contain at most 5,000 records")
    refs: list[dict] = []
    for table, ids in grouped.items():
        rows = storage.client.table(table).select("*").in_("id", sorted(ids)).execute().data or []
        for raw in rows:
            if raw.get("needs_review") or storage.broker_is_workspace_blocked(
                phone=str(raw.get("broker_phone") or ""), name=str(raw.get("broker_name") or "")
            ):
                continue
            refs.append({"source_schema": table, "source_id": int(raw["id"])})
    requested = {(table, row_id) for table, ids in grouped.items() for row_id in ids}
    found = {(item["source_schema"], item["source_id"]) for item in refs}
    if requested != found:
        raise HTTPException(403, "One or more Market Inbox listings are no longer visible")
    return sorted(refs, key=lambda item: (item["source_schema"], item["source_id"]))


def _connection(tenant: str):
    return (storage.client.table("google_drive_connections").select(
        "id,google_email,status,scopes,last_validated_at,revoked_at"
    ).eq("tenant_id", tenant).limit(1).execute().data or [None])[0]


def _queue_export(tenant: str, export_id: int, reason: str) -> None:
    open_job = (storage.client.table("google_drive_sync_jobs").select("id").eq(
        "export_id", export_id
    ).in_("status", ["pending", "running"]).limit(1).execute().data or [])
    if not open_job:
        storage.client.table("google_drive_sync_jobs").insert({
            "tenant_id": tenant, "export_id": export_id, "reason": reason,
        }).execute()


def queue_tenant_exports(tenant: str, reason: str = "inventory_changed") -> int:
    exports = storage.client.table("google_drive_exports").select("id").eq(
        "tenant_id", tenant
    ).eq("status", "active").execute().data or []
    for export in exports:
        _queue_export(tenant, int(export["id"]), reason)
    return len(exports)


@router.get("/api/google-drive/connect")
async def connect_google_drive(tenant: str = Depends(require_tenant), user: dict = Depends(require_user)):
    try:
        return {"authorization_url": await begin(tenant, str(user["id"]))}
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from exc


@router.get("/api/google-drive/callback")
async def google_drive_callback(state: str, code: str = "", error: str = ""):
    if error:
        return RedirectResponse("https://app.propai.live/account?tab=google-drive&drive=cancelled")
    if not code:
        return RedirectResponse("https://app.propai.live/account?tab=google-drive&drive=failed")
    try:
        result = await finish(state, code)
        queue_tenant_exports(str(result["tenant_id"]), "drive_connected")
        return RedirectResponse("https://app.propai.live/account?tab=google-drive&drive=connected")
    except Exception:
        return RedirectResponse("https://app.propai.live/account?tab=google-drive&drive=failed")


@router.get("/api/google-drive")
async def google_drive_status(tenant: str = Depends(require_tenant), user: dict = Depends(require_user)):
    connection = _connection(tenant)
    exports = storage.client.table("google_drive_exports").select(
        "id,file_name,status,inventory_ids,market_item_refs,last_row_count,last_success_at,last_error"
    ).eq("tenant_id", tenant).order("created_at").execute().data or []
    return {"connected": bool(connection and connection.get("status") == "connected"), "connection": connection, "exports": exports}


@router.post("/api/google-drive/exports")
async def create_google_drive_export(body: dict, tenant: str = Depends(require_tenant), user: dict = Depends(require_user)):
    connection = storage.client.table("google_drive_connections").select("id").eq("tenant_id", tenant).eq("status", "connected").limit(1).execute().data or []
    if not connection:
        raise HTTPException(409, "Connect Google Drive before creating an export")
    inventory_ids: list[int] = []
    market_item_refs: list[dict] = []
    if body.get("market_item_refs") is not None:
        market_item_refs = _market_refs_for_export(body.get("market_item_refs"))
    else:
        raw_ids = body.get("inventory_ids")
        if not isinstance(raw_ids, list) or not raw_ids:
            raise HTTPException(400, "Select at least one private inventory record or Market Inbox listing")
        try:
            inventory_ids = sorted({int(value) for value in raw_ids})
        except (TypeError, ValueError) as exc:
            raise HTTPException(400, "inventory_ids must contain numeric IDs") from exc
        if len(inventory_ids) > 5000:
            raise HTTPException(400, "An export can contain at most 5,000 records")
        rows = storage.client.table("crm_inventory").select("id").eq("tenant_id", tenant).in_("id", inventory_ids).execute().data or []
        if {int(row["id"]) for row in rows} != set(inventory_ids):
            raise HTTPException(403, "One or more inventory records are outside this workspace")
    file_name = str(body.get("file_name") or "PropAI Inventory - Current").strip()[:120]
    if not file_name:
        raise HTTPException(400, "file_name cannot be empty")
    result = storage.client.table("google_drive_exports").upsert({
        "tenant_id": tenant, "connection_id": connection[0]["id"], "file_name": file_name,
        "inventory_ids": inventory_ids, "market_item_refs": market_item_refs,
        "status": "active", "created_by": user.get("id"),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }, on_conflict="tenant_id,file_name").execute()
    export = (result.data or [None])[0]
    if not export:
        raise HTTPException(503, "Could not create Drive export")
    _queue_export(tenant, int(export["id"]), "export_created")
    return export


@router.post("/api/google-drive/exports/{export_id}/sync")
async def sync_google_drive_export(export_id: int, tenant: str = Depends(require_tenant), user: dict = Depends(require_user)):
    export = storage.client.table("google_drive_exports").select("id").eq("id", export_id).eq("tenant_id", tenant).eq("status", "active").limit(1).execute().data or []
    if not export:
        raise HTTPException(404, "Drive export not found")
    _queue_export(tenant, export_id, "manual_sync")
    return {"queued": True, "export_id": export_id}


@router.delete("/api/google-drive/exports/{export_id}")
async def disable_google_drive_export(export_id: int, tenant: str = Depends(require_tenant), user: dict = Depends(require_user)):
    result = storage.client.table("google_drive_exports").update({"status": "disabled", "updated_at": datetime.now(timezone.utc).isoformat()}).eq("id", export_id).eq("tenant_id", tenant).execute()
    if not result.data:
        raise HTTPException(404, "Drive export not found")
    return {"ok": True}
