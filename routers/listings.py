"""
Listing routes — listings, parsed sources, listing photos, media serving.
"""
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse

from routers.common import storage, require_user

router = APIRouter(tags=["listings"])

# ── Media storage for listing photos (wired from app.py) ──
MEDIA_DIR: Path = Path("/tmp")


@router.get("/api/listings")
async def list_listings(limit: int = 50, offset: int = 0, user: dict = Depends(require_user)):
    return storage.get_listings(limit, offset)


@router.get("/api/listings/{listing_id}")
async def get_listing_detail(listing_id: int, user: dict = Depends(require_user)):
    try:
        res = storage.client.table("listings").select("*").eq("id", listing_id).limit(1).execute()
        if not res.data:
            raise HTTPException(404, "Listing not found")
        listing = res.data[0]
        sources = []
        try:
            src_res = storage.client.table("parsed").select(
                "id, intent, role, message_type, bhk, price, price_unit, "
                "area_sqft, furnishing, building_name, micro_market, confidence, "
                "created_at, raw_message_id"
            ).eq("listing_id", listing_id).order("created_at", desc=True).limit(50).execute()
            sources = src_res.data or []
        except Exception:
            pass
        photos = []
        try:
            ph_res = storage.client.table("listing_photos").select(
                "id, media_id, filename, mime_type, caption, sender_phone, sender_name, created_at"
            ).eq("listing_id", listing_id).order("created_at", desc=True).limit(20).execute()
            photos = [{
                **p,
                "url": f"/api/media/photos/{p['id']}"
            } for p in (ph_res.data or [])]
        except Exception:
            pass
        raw_msg = None
        raw_msg_id = listing.get("representative_raw_message_id") or listing.get("latest_raw_message_id")
        if raw_msg_id:
            try:
                raw_res = storage.client.table("raw_messages").select(
                    "id, content, sender_name, sender_phone, group_name, "
                    "timestamp, message_type, media_type"
                ).eq("id", raw_msg_id).limit(1).execute()
                if raw_res.data:
                    raw_msg = raw_res.data[0]
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
async def list_listing_photos(listing_id: int, user: dict = Depends(require_user)):
    photos = storage.get_listing_photos(listing_id)
    return [{
        "id": p["id"],
        "media_id": p["media_id"],
        "filename": p["filename"],
        "mime_type": p["mime_type"],
        "caption": p["caption"],
        "sender_phone": p["sender_phone"],
        "sender_name": p["sender_name"],
        "created_at": p["created_at"],
        "url": f"/api/media/photos/{p['id']}",
    } for p in photos]


@router.get("/api/media/photos/{photo_id}")
async def serve_listing_photo(photo_id: int, user: dict = Depends(require_user)):
    row = storage.db.execute(
        "SELECT * FROM listing_photos WHERE id = ?", (photo_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "Photo not found")
    p = dict(row)
    filepath = p.get("filepath", "")
    if not filepath or not Path(filepath).exists():
        raise HTTPException(404, "Photo file not found on disk")
    mime = p.get("mime_type", "image/jpeg")
    return FileResponse(filepath, media_type=mime)


@router.post("/api/listings/{listing_id}/photos")
async def upload_listing_photo(listing_id: int, request: Request, user: dict = Depends(require_user)):
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
    )
    return {"id": photo_id, "filename": filename, "url": f"/api/media/photos/{photo_id}"}


@router.get("/api/parsed")
async def get_parsed(limit: int = 50, offset: int = 0, intent: str = "", user: dict = Depends(require_user)):
    return storage.get_parsed(limit, offset, intent=intent)


@router.get("/api/parsed/{parsed_id}/sources")
async def get_parsed_sources(parsed_id: int, user: dict = Depends(require_user)):
    return storage.get_parsed_sources(parsed_id)
