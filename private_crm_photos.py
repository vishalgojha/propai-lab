"""Private CRM photos. No market mutation, signed links, or public objects."""
import hashlib
import io
import warnings

from fastapi import HTTPException
from fastapi.responses import Response
from PIL import Image, ImageOps, UnidentifiedImageError

BUCKET = "private-crm"
PHOTO_SCOPE = "photos:write"
MAX_BYTES = 10 * 1024 * 1024
MAX_PIXELS = 30_000_000


def private_bucket(client):
    """Fail closed against the live bucket configuration before any media I/O."""
    try:
        response = client._http.get(f"{client._base_url}/storage/v1/bucket/{BUCKET}")
        response.raise_for_status()
        if response.json().get("public") is not False:
            raise ValueError("not private")
    except Exception as exc:
        raise HTTPException(503, "Private photo storage could not be verified") from exc


def inventory_target(client, tenant, inventory_id):
    rows = client.table("crm_inventory").select("id,tenant_id,building_name,location,contact_name,contact_number").eq("tenant_id", tenant).eq("id", inventory_id).limit(1).execute().data or []
    if not rows:
        raise HTTPException(404, "Private inventory record not found")
    return rows[0]


def normalize_photo(content):
    if not content or len(content) > MAX_BYTES:
        raise HTTPException(413, "Photo must be nonempty and at most 10 MB")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(content)) as image:
                if image.format not in {"JPEG", "PNG", "WEBP"} or getattr(image, "n_frames", 1) != 1:
                    raise ValueError("unsupported image")
                if image.width * image.height > MAX_PIXELS:
                    raise ValueError("too many pixels")
                image.load()
                clean = ImageOps.exif_transpose(image).convert("RGB")
                output = io.BytesIO()
                clean.save(output, format="JPEG", quality=92)
                data = output.getvalue()
                if len(data) > MAX_BYTES:
                    raise ValueError("normalized photo too large")
                return data
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise HTTPException(422, "Use a valid, non-animated JPEG, PNG or WebP photo under 30 megapixels") from exc


def photo_path(tenant, inventory_id, content):
    digest = hashlib.sha256(content).hexdigest()
    return f"{tenant}/photos/{inventory_id}/{digest}.jpg"


def photo_rows(client, tenant, inventory_id):
    inventory_target(client, tenant, inventory_id)
    prefix = f"{tenant}/photos/{inventory_id}/"
    rows = client.table("crm_inventory_attachments").select("id,inventory_id,file_name,mime_type,size_bytes,storage_path,created_at").eq("tenant_id", tenant).eq("inventory_id", inventory_id).order("created_at").limit(200).execute().data or []
    return [{"id": row["id"], "filename": row["file_name"], "created_at": row["created_at"], "url": f"/api/crm/inventory/{inventory_id}/photos/{row['id']}"} for row in rows if row.get("mime_type") == "image/jpeg" and str(row.get("storage_path") or "").startswith(prefix)]


def save_photo(client, tenant, inventory_id, created_by, content):
    inventory_target(client, tenant, inventory_id)
    clean = normalize_photo(content)
    path = photo_path(tenant, inventory_id, clean)
    private_bucket(client)
    query = lambda: client.table("crm_inventory_attachments").select("id").eq("tenant_id", tenant).eq("inventory_id", inventory_id).eq("storage_path", path).limit(1).execute().data or []
    existing = query()
    if existing:
        return {"id": existing[0]["id"], "private": True, "duplicate": True}
    try:
        client.storage.from_(BUCKET).upload(path, clean, {"content-type": "image/jpeg", "upsert": "false"})
    except Exception as exc:
        # A previous retry or concurrent upload may already own this exact path.
        # Only accept it after verifying identical bytes, not merely a 409.
        try:
            response = client._http.get(f"{client._base_url}/storage/v1/object/{BUCKET}/{path}")
            response.raise_for_status()
            if response.content != clean:
                raise ValueError("object differs")
        except Exception:
            raise HTTPException(503, "Private photo upload failed; retry safely") from exc
    payload = {"tenant_id": tenant, "inventory_id": inventory_id, "created_by": created_by, "storage_bucket": BUCKET, "storage_path": path, "file_name": path.rsplit("/", 1)[-1], "mime_type": "image/jpeg", "size_bytes": len(clean), "extracted_text": "", "text_supported": False}
    # storage_path has an existing global unique constraint. Ignore a concurrent
    # identical insert, then re-read with tenant AND target filters.
    client.table("crm_inventory_attachments").upsert(payload, on_conflict="storage_path", ignore_duplicates=True).execute()
    rows = query()
    if not rows:
        raise HTTPException(503, "Photo metadata could not be saved; retry safely")
    return {"id": rows[0]["id"], "private": True, "duplicate": False}


def read_photo(client, tenant, inventory_id, photo_id):
    inventory_target(client, tenant, inventory_id)
    rows = client.table("crm_inventory_attachments").select("storage_bucket,storage_path,mime_type").eq("tenant_id", tenant).eq("inventory_id", inventory_id).eq("id", photo_id).limit(1).execute().data or []
    row = rows[0] if rows else {}
    prefix = f"{tenant}/photos/{inventory_id}/"
    path = str(row.get("storage_path") or "")
    if row.get("storage_bucket") != BUCKET or not path.startswith(prefix) or row.get("mime_type") != "image/jpeg":
        raise HTTPException(404, "Private photo not found")
    private_bucket(client)
    try:
        response = client._http.get(f"{client._base_url}/storage/v1/object/{BUCKET}/{path}")
        response.raise_for_status()
    except Exception as exc:
        raise HTTPException(503, "Private photo is temporarily unavailable") from exc
    return Response(content=response.content, media_type="image/jpeg", headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline; filename=property-photo.jpg"})


PHOTO_AUDIT_TABLE = 'external_agent_photo_audit_log'


def photo_audit_start(client, tenant, key_id, operation, payload):
    try:
        result = client.table(PHOTO_AUDIT_TABLE).insert({
            'tenant_id': tenant, 'api_key_id': key_id,
            'operation': operation, 'status': 'started', 'payload': payload,
        }).execute()
        audit_id = ((result.data or [{}])[0]).get('id')
        if not audit_id:
            raise ValueError('missing audit id')
        return str(audit_id)
    except Exception as exc:
        raise HTTPException(503, 'Private photo audit is unavailable; no photo mutation was performed') from exc


def photo_audit_finish(client, tenant, audit_id, status, result=None):
    from datetime import datetime, timezone
    client.table(PHOTO_AUDIT_TABLE).update({
        'status': status, 'result': result or {},
        'completed_at': datetime.now(timezone.utc).isoformat(),
    }).eq('tenant_id', tenant).eq('id', audit_id).execute()
