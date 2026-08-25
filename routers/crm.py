"""Private, tenant-scoped broker CRM inventory routes."""
import csv
import io
import re
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request

from routers.common import require_tenant, require_user, storage

router = APIRouter(tags=["private-crm"])

_FIELDS = {
    "date": "inventory_date",
    "building name": "building_name",
    "location": "location",
    "tower": "tower",
    "bhk": "bhk",
    "floor": "floor",
    "area (sq ft)": "area_sqft",
    "quote": "quote",
    "furnishing": "furnishing",
    "amenities": "amenities",
    "owner name": "owner_name",
    "availability": "availability",
    "pets okay": "pets_okay",
    "contact name": "contact_name",
    "number": "contact_number",
}


def _clean_header(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "").strip().lower()).rstrip(" :")


def _area(value: str):
    text = (value or "").strip().replace(",", "")
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _parse_date(value: str):
    text = (value or "").strip()
    if not text:
        return None
    for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y"):
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            pass
    return None


def _parse_inventory_csv(text: str):
    rows = list(csv.reader(io.StringIO(text)))
    header_index = next((i for i, row in enumerate(rows) if "building name" in {_clean_header(v) for v in row}), None)
    if header_index is None:
        raise ValueError("CSV header must contain Building Name")
    headers = [_FIELDS.get(_clean_header(v)) for v in rows[header_index]]
    records, rejected = [], []
    for row_number, row in enumerate(rows[header_index + 1:], start=header_index + 2):
        if not any(cell.strip() for cell in row):
            continue
        raw = {headers[i]: row[i].strip() for i in range(min(len(headers), len(row))) if headers[i]}
        record = {field: raw.get(field, "") for field in _FIELDS.values()}
        record["inventory_date"] = _parse_date(record["inventory_date"])
        record["area_sqft"] = _area(record["area_sqft"])
        if not record["building_name"] and not record["location"]:
            rejected.append({"row": row_number, "error": "building_name_or_location_required"})
            continue
        records.append(record)
    return records, rejected


def _store():
    if storage is None:
        raise HTTPException(status_code=503, detail="storage_unavailable")
    return storage.client.table("crm_inventory")


@router.get("/api/crm/inventory")
async def list_inventory(q: str = "", limit: int = 100, tenant: str = Depends(require_tenant), user: dict = Depends(require_user)):
    result = (_store().select("*").eq("tenant_id", tenant).order("created_at", desc=True).limit(max(1, min(limit, 500))).execute())
    rows = result.data or []
    needle = q.strip().lower()
    if needle:
        rows = [row for row in rows if needle in " ".join(str(row.get(k) or "") for k in ("building_name", "location", "contact_name", "owner_name", "quote")).lower()]
    return rows


@router.post("/api/crm/inventory/import")
async def import_inventory(request: Request, tenant: str = Depends(require_tenant), user: dict = Depends(require_user)):
    try:
        form = await request.form()
        file = form.get("file")
        if file is None or not hasattr(file, "read"):
            raise ValueError("CSV file is required")
        text = (await file.read()).decode("utf-8-sig")
        records, rejected = _parse_inventory_csv(text)
    except (UnicodeDecodeError, ValueError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if records:
        payload = [{**record, "tenant_id": tenant, "created_by": user.get("id"), "source": "csv_import"} for record in records]
        _store().insert(payload).execute()
    return {"imported": len(records), "rejected": rejected, "private": True}


@router.post("/api/crm/inventory")
async def create_inventory(body: dict, tenant: str = Depends(require_tenant), user: dict = Depends(require_user)):
    payload = {field: body.get(field, "") for field in _FIELDS.values()}
    payload["tenant_id"] = tenant
    payload["created_by"] = user.get("id")
    payload["source"] = "manual"
    result = _store().insert(payload).execute()
    return (result.data or [{}])[0]


@router.delete("/api/crm/inventory/{inventory_id}")
async def delete_inventory(inventory_id: int, tenant: str = Depends(require_tenant), user: dict = Depends(require_user)):
    _store().delete().eq("id", inventory_id).eq("tenant_id", tenant).execute()
    return {"ok": True}
