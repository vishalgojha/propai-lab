"""
Listing routes — listings, parsed sources, listing photos, media serving.
"""
import re
import uuid
from pathlib import Path
from typing import Literal

from pydantic import BaseModel

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse

from routers.common import storage, require_user

router = APIRouter(tags=["listings"])

# ── Media storage for listing photos (wired from app.py) ──
MEDIA_DIR: Path = Path("/tmp")


class HiddenMarketItemPayload(BaseModel):
    item_kind: Literal["listing", "requirement"]
    listing_id: int | None = None
    raw_message_id: int | None = None
    broker_phone: str | None = None
    broker_name: str | None = None
    source_label: str | None = None
    hidden_reason: str | None = None


def _hidden_market_key(payload: HiddenMarketItemPayload) -> str:
    if payload.item_kind == "listing":
        if payload.listing_id is None:
            raise HTTPException(400, "listing_id is required for listing hides")
        return f"listing:{payload.listing_id}"
    if payload.raw_message_id is None:
        raise HTTPException(400, "raw_message_id is required for requirement hides")
    return f"requirement:{payload.raw_message_id}"


def _tenant_id() -> str | None:
    try:
        return getattr(storage, "tenant_id", None) or getattr(storage, "_tenant_id", None)
    except Exception:
        return None


@router.get("/api/listings/hidden-items")
async def list_hidden_market_items(user: dict = Depends(require_user)):
    try:
        tenant_id = _tenant_id()
        params: list[object] = []
        where = ""
        if tenant_id:
            where = "WHERE tenant_id IS NULL OR tenant_id = ?"
            params.append(tenant_id)
        rows = storage.db.execute(
            f"""
            SELECT hidden_key, item_kind, listing_id, raw_message_id, broker_phone,
                   broker_name, source_label, hidden_reason, hidden_at
            FROM hidden_market_items
            {where}
            ORDER BY hidden_at DESC
            """,
            tuple(params),
        ).fetchall()
        return {"items": [dict(row) for row in rows]}
    except Exception as exc:
        raise HTTPException(500, f"Failed to load hidden items: {exc}")


@router.post("/api/listings/hide")
async def hide_market_item(payload: HiddenMarketItemPayload, user: dict = Depends(require_user)):
    try:
        hidden_key = _hidden_market_key(payload)
        row = {
            "hidden_key": hidden_key,
            "tenant_id": _tenant_id(),
            "item_kind": payload.item_kind,
            "listing_id": payload.listing_id,
            "raw_message_id": payload.raw_message_id,
            "broker_phone": payload.broker_phone,
            "broker_name": payload.broker_name,
            "source_label": payload.source_label,
            "hidden_reason": payload.hidden_reason,
            "hidden_by": user.get("id"),
        }
        storage.db.execute(
            """
            insert into hidden_market_items
                (hidden_key, tenant_id, item_kind, listing_id, raw_message_id,
                 broker_phone, broker_name, source_label, hidden_reason, hidden_by, hidden_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now())
            on conflict (hidden_key) do update set
                tenant_id = excluded.tenant_id,
                item_kind = excluded.item_kind,
                listing_id = excluded.listing_id,
                raw_message_id = excluded.raw_message_id,
                broker_phone = excluded.broker_phone,
                broker_name = excluded.broker_name,
                source_label = excluded.source_label,
                hidden_reason = excluded.hidden_reason,
                hidden_by = excluded.hidden_by,
                hidden_at = now()
            """,
            (
                row["hidden_key"],
                row["tenant_id"],
                row["item_kind"],
                row["listing_id"],
                row["raw_message_id"],
                row["broker_phone"],
                row["broker_name"],
                row["source_label"],
                row["hidden_reason"],
                row["hidden_by"],
            ),
        )
        if hasattr(storage.db, "commit"):
            storage.db.commit()
        return {"success": True, **row}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, f"Failed to hide item: {exc}")


@router.post("/api/listings/unhide")
async def unhide_market_item(payload: HiddenMarketItemPayload, user: dict = Depends(require_user)):
    try:
        hidden_key = _hidden_market_key(payload)
        storage.db.execute(
            "delete from hidden_market_items where hidden_key = ?",
            (hidden_key,),
        )
        if hasattr(storage.db, "commit"):
            storage.db.commit()
        return {"success": True, "hidden_key": hidden_key}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, f"Failed to unhide item: {exc}")


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
async def get_parsed(limit: int = 50, offset: int = 0, intent: str = "", classified_only: bool = False, user: dict = Depends(require_user)):
    return storage.get_parsed(limit, offset, intent=intent, classified_only=classified_only)


@router.get("/api/parsed/{parsed_id}/sources")
async def get_parsed_sources(parsed_id: int, user: dict = Depends(require_user)):
    return storage.get_parsed_sources(parsed_id)
