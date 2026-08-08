"""
Listing routes — listings, parsed sources, listing photos, media serving.
"""
import asyncio
import re
import uuid
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

from fastapi import APIRouter, Depends, HTTPException, Request, Query
from fastapi.responses import FileResponse, Response
from urllib.parse import quote

from routers.common import storage, require_user, get_tenant_context

router = APIRouter(tags=["listings"])

# ── Media storage for listing photos (wired from app.py) ──
MEDIA_DIR: Path = Path("/tmp")


class ParsedCorrectionPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    summary_title: str | None = Field(default=None, max_length=240)
    building_name: str | None = Field(default=None, max_length=160)
    micro_market: str | None = Field(default=None, max_length=160)
    location_raw: str | None = Field(default=None, max_length=240)
    broker_name: str | None = Field(default=None, max_length=160)
    broker_phone: str | None = Field(default=None, max_length=40)
    bhk: str | None = Field(default=None, max_length=30)
    area_sqft: float | None = Field(default=None, ge=0, le=10_000_000)
    price: float | None = Field(default=None, ge=0, le=10_000_000_000)
    furnishing: str | None = Field(default=None, max_length=80)
    floor_range: str | None = Field(default=None, max_length=80)
    parking_type: str | None = Field(default=None, max_length=80)
    car_parking_count: int | None = Field(default=None, ge=0, le=100)
    commercial_use_type: str | None = Field(default=None, max_length=120)


@router.get("/api/listings")
async def list_listings(limit: int = 50, offset: int = 0, user: dict = Depends(require_user)):
    return storage.get_listings(limit, offset)


@router.get("/api/listings/{listing_id}")
async def get_listing_detail(listing_id: int, user: dict = Depends(require_user), tenant_id: str | None = Depends(get_tenant_context)):
    try:
        # The listing, its sources and its photos only depend on listing_id,
        # so fetch them in parallel (3 round-trips collapsed into 1) instead
        # of 4 sequential Supabase queries.
        def scoped(query):
            return query.eq("tenant_id", tenant_id) if tenant_id else query

        res, src_res, ph_res = await asyncio.gather(
            asyncio.to_thread(lambda: scoped(storage.client.table("listings_unified").select("*").eq("id", listing_id)).limit(1).execute()),
            asyncio.to_thread(lambda: storage.client.table("parsed").select(
                "id, intent, role, message_type, bhk, price, price_unit, "
                "area_sqft, furnishing, building_name, micro_market, confidence, "
                "created_at, raw_message_id"
            ).eq("listing_id", listing_id).order("created_at", desc=True).limit(50).execute()),
            asyncio.to_thread(lambda: scoped(storage.client.table("listing_photos").select(
                "id, media_id, filename, mime_type, caption, sender_phone, sender_name, storage_path, created_at"
            ).eq("listing_id", listing_id)).order("created_at", desc=True).limit(20).execute()),
            return_exceptions=True,
        )
        if isinstance(res, BaseException):
            raise HTTPException(500, f"Failed to fetch listing: {res}")
        if not res.data:
            raise HTTPException(404, "Listing not found")
        listing = res.data[0]
        sources = []
        if not isinstance(src_res, BaseException):
            sources = src_res.data or []
        photos = []
        if not isinstance(ph_res, BaseException):
            photos = [{
                **p,
                "url": f"/api/media/photos/{p['id']}"
            } for p in (ph_res.data or [])]
        raw_msg = None
        raw_msg_id = listing.get("representative_raw_message_id") or listing.get("latest_raw_message_id")
        if raw_msg_id:
            try:
                raw_res = await asyncio.to_thread(lambda: storage.client.table("raw_messages").select(
                    "id, content, sender_name, sender_phone, group_name, "
                    "timestamp, message_type, media_type"
                ).eq("id", raw_msg_id).limit(1).execute())
                if raw_res.data:
                    raw_msg = raw_res.data[0]
                    content = raw_msg.get("content", "")
                    phone_digits_pattern = re.compile(r'[6-9]\d{9}')
                    def mask_phone(match):
                        digits = match.group(0)
                        return digits[:2] + 'XXXXXX' + digits[-2:]
                    content = phone_digits_pattern.sub(mask_phone, content)
                    raw_msg = {**raw_msg, "content": content}
            except Exception:
                pass
        return {**listing, "sources": sources, "photos": photos, "raw_message": raw_msg}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Failed to fetch listing: {e}")


@router.get("/api/listings/{listing_id}/sources")
async def get_listing_sources(listing_id: int, user: dict = Depends(require_user)):
    return storage.get_listing_sources(listing_id)


@router.get("/api/listings/{listing_id}/photos")
async def list_listing_photos(listing_id: int, user: dict = Depends(require_user), tenant_id: str | None = Depends(get_tenant_context)):
    photos = storage.get_listing_photos(listing_id, tenant_id)
    return [{
        "id": p["id"],
        "media_id": p["media_id"],
        "filename": p["filename"],
        "mime_type": p["mime_type"],
        "caption": p["caption"],
        "sender_phone": p["sender_phone"],
        "sender_name": p["sender_name"],
        "storage_path": p.get("storage_path", ""),
        "created_at": p["created_at"],
        "url": f"/api/media/photos/{p['id']}",
    } for p in photos]


@router.get("/api/media/photos/{photo_id}")
async def serve_listing_photo(photo_id: int, user: dict = Depends(require_user), tenant_id: str | None = Depends(get_tenant_context)):
    query = storage.client.table("listing_photos").select(
        "id,filepath,storage_path,mime_type,tenant_id"
    ).eq("id", photo_id).limit(1)
    if tenant_id:
        query = query.eq("tenant_id", tenant_id)
    rows = query.execute().data or []
    if not rows:
        raise HTTPException(404, "Photo not found")
    p = rows[0]
    storage_path = str(p.get("storage_path") or "").strip()
    if storage_path:
        base_url = str(getattr(storage.client, "_base_url", "")).rstrip("/")
        if not base_url:
            raise HTTPException(503, "Media storage is unavailable")
        try:
            upstream = storage.client._http.get(
                f"{base_url}/storage/v1/object/whatsapp-media/{quote(storage_path, safe='/')}",
                timeout=30,
            )
            upstream.raise_for_status()
        except Exception:
            raise HTTPException(404, "Photo file not found")
        return Response(content=upstream.content, media_type=p.get("mime_type") or "image/jpeg")
    filepath = p.get("filepath", "")
    if not filepath or not Path(filepath).exists():
        raise HTTPException(404, "Photo file not found on disk")
    mime = p.get("mime_type", "image/jpeg")
    return FileResponse(filepath, media_type=mime)


@router.post("/api/listings/{listing_id}/photos")
async def upload_listing_photo(listing_id: int, request: Request, user: dict = Depends(require_user), tenant_id: str | None = Depends(get_tenant_context)):
    pic_token = storage.get_or_create_pic_token(listing_id)
    if not pic_token:
        raise HTTPException(500, "Could not generate PIC token")
    form = await request.form()
    file = form.get("file")
    if not file or not hasattr(file, "filename") or not file.filename:
        raise HTTPException(400, "No file provided")
    content = await file.read()
    ext = Path(file.filename).suffix or ".jpg"
    media_id = f"upload_{uuid.uuid4().hex[:12]}"
    filename = f"{media_id}{ext}"
    filepath = str(MEDIA_DIR / filename)
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    Path(filepath).write_bytes(content)
    mime = file.content_type or "image/jpeg"
    caption = form.get("caption", "")
    sender_phone = form.get("sender_phone", "")
    sender_name = form.get("sender_name", "")
    photo_id = storage.save_listing_photo(
        listing_id=listing_id,
        pic_token=pic_token,
        media_id=media_id,
        filename=filename,
        filepath=filepath,
        mime_type=mime,
        caption=caption,
        sender_phone=sender_phone,
        sender_name=sender_name,
        tenant_id=tenant_id,
    )
    return {"id": photo_id, "filename": filename, "url": f"/api/media/photos/{photo_id}"}


@router.get("/api/parsed")
async def get_parsed(
    limit: int = 50,
    offset: int = 0,
    intent: str = "",
    classified_only: bool = False,
    asset_type: str = Query(default="", pattern="^(|residential|commercial)$"),
    kind: str = Query(default="", pattern="^(|listing|requirement)$"),
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    # Super-admins use this page as a platform-wide audit. Everyone else
    # must have an active organization before typed rows are returned.
    if not tenant_id:
        try:
            if not await asyncio.to_thread(storage.is_super_admin, user.get("id")):
                raise HTTPException(403, "A workspace is required to view extractions")
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(403, "A workspace is required to view extractions") from exc
    return storage.get_parsed(limit, offset, intent=intent, classified_only=classified_only, asset_type=asset_type, kind=kind)


@router.get("/api/parsed/{parsed_id}/sources")
async def get_parsed_sources(parsed_id: int, user: dict = Depends(require_user)):
    return storage.get_parsed_sources(parsed_id)


@router.get("/api/my/deals")
async def get_my_deals(
    limit: int = 200,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    """Broker CRM view over this workspace's connected-number inventory."""
    if not tenant_id:
        raise HTTPException(403, "A workspace is required to view My Deals")
    return await asyncio.to_thread(storage.get_my_deals, limit)


@router.patch("/api/parsed/{parsed_id}")
async def correct_parsed_observation(
    parsed_id: int,
    payload: ParsedCorrectionPayload,
    schema: str = Query(default=""),
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    """Save a tenant-scoped correction without changing WhatsApp evidence."""
    updates = payload.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(400, "At least one correction is required")
    if not tenant_id:
        raise HTTPException(403, "A workspace is required to edit an extraction")
    try:
        is_admin = await asyncio.to_thread(storage.is_super_admin, user.get("id"))
    except Exception:
        is_admin = False
    if not is_admin and not await asyncio.to_thread(storage.parsed_owned_by_connected_phone, parsed_id, tenant_id, schema):
        raise HTTPException(403, "Only records sent by your connected WhatsApp number can be edited")
    try:
        updated = storage.update_parsed_fields(parsed_id, updates, schema)
    except Exception as exc:
        raise HTTPException(500, "Could not save extraction correction") from exc
    if not updated:
        raise HTTPException(404, "Extraction not found in this workspace")
    return {"success": True, "id": parsed_id, "updated_fields": sorted(updates)}
