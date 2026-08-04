"""Send routes — send messages, send media, public leads, replay."""
import asyncio
import json
import os
import re
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from routers.common import storage, require_user, get_tenant_context, get_current_team_member, check_permission, _select_reply_broker_id, _first_ingestor_response

router = APIRouter(tags=["send"])


# ── Models ────────────────────────────────────────────────────────

class SendMessageRequest(BaseModel):
    remote_jid: str
    text: str
    quoted_message_id: str = ""
    quoted_remote_jid: str = ""
    quoted_participant: str = ""
    quoted_from_me: bool = False
    broker_id: str = ""


class PublicLeadRequest(BaseModel):
    listing_id: int
    client_name: str
    client_phone: str
    message: str | None = None


class ReplayStats(BaseModel):
    total: int = 0
    resolved: int = 0
    unresolved: int = 0
    errors: int = 0
    avg_confidence: float = 0.0
    failure_breakdown: dict = {}


# ── Placeholders (wired by app.py at startup) ───────────────────

_ingestor_auth_headers: object = None
_notify_broker_of_lead: object = None


def _normalize_upstream_response(response: httpx.Response | None) -> dict:
    if response is None:
        return {"success": False, "error": "WhatsApp service is unavailable. Try again in a moment."}
    if response.text:
        try:
            body = response.json()
            if isinstance(body, dict):
                return body
            return {"success": True, "data": body}
        except Exception:
            if response.status_code < 400:
                return {"success": True, "raw": response.text[:1000]}
    if response.status_code < 400:
        return {"success": True}
    return {"success": False, "error": f"WhatsApp service returned HTTP {response.status_code}. Please try again in a moment."}


# ── Routes ────────────────────────────────────────────────────────

@router.post("/api/send")
async def send_message(req: SendMessageRequest, member: dict = Depends(get_current_team_member)):
    check_permission(member, "reply_whatsapp")
    text = req.text.strip()
    if not text:
        return JSONResponse(status_code=400, content={"success": False, "error": "text is required"})
    if not req.remote_jid:
        return JSONResponse(status_code=400, content={"success": False, "error": "remote_jid is required"})

    try:
        payload = {
            "remoteJid": req.remote_jid,
            "text": text,
        }
        selected_broker_id = await _select_reply_broker_id(member, req.broker_id)
        if selected_broker_id:
            payload["brokerId"] = selected_broker_id
        if req.quoted_message_id:
            payload["quotedMessageId"] = req.quoted_message_id
            payload["quotedRemoteJid"] = req.quoted_remote_jid or req.remote_jid
            payload["quotedParticipant"] = req.quoted_participant
            payload["quotedFromMe"] = req.quoted_from_me

        base_url, response = await _first_ingestor_response(
            "POST",
            "/send-message",
            timeout=30,
            json=payload,
            headers=_ingestor_auth_headers(),
        )
        status_code = response.status_code if response is not None else 502
        response_body = _normalize_upstream_response(response)

        try:
            storage.log_activity(
                team_member_id=member["id"],
                action="reply_whatsapp_sent" if status_code < 400 else "reply_whatsapp_failed",
                target_type="whatsapp_conversation",
                target_id=req.remote_jid,
                details={
                    "surface": "inbox",
                    "reply_text": text[:500],
                    "quoted_message_id": req.quoted_message_id or "",
                    "quoted_remote_jid": req.quoted_remote_jid or "",
                    "quoted_participant": req.quoted_participant or "",
                    "quoted_from_me": bool(req.quoted_from_me),
                    "transport_status_code": status_code,
                    "transport_response": response_body,
                    "transport_base_url": base_url or "",
                },
            )
        except Exception as exc:
            print(f"[activity-log] failed to record whatsapp reply: {exc}", flush=True)

        return JSONResponse(
            status_code=status_code,
            content=response_body,
        )
    except httpx.ConnectError:
        try:
            storage.log_activity(
                team_member_id=member["id"],
                action="reply_whatsapp_failed",
                target_type="whatsapp_conversation",
                target_id=req.remote_jid,
                details={
                    "surface": "inbox",
                    "reply_text": text[:500],
                    "error": "Cannot reach WhatsApp ingestor",
                },
            )
        except Exception as exc:
            print(f"[activity-log] failed to record whatsapp reply error: {exc}", flush=True)
        return JSONResponse(
            status_code=502,
            content={"success": False, "error": "Cannot reach WhatsApp ingestor. Is WhatsApp connected?"},
        )
    except HTTPException:
        raise
    except Exception as exc:
        try:
            storage.log_activity(
                team_member_id=member["id"],
                action="reply_whatsapp_failed",
                target_type="whatsapp_conversation",
                target_id=req.remote_jid,
                details={
                    "surface": "inbox",
                    "reply_text": text[:500],
                    "error": str(exc),
                },
            )
        except Exception as log_exc:
            print(f"[activity-log] failed to record whatsapp reply exception: {log_exc}", flush=True)
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(exc)},
        )


@router.post("/api/send-media")
async def send_media(req: Request, member: dict = Depends(get_current_team_member)):
    check_permission(member, "reply_whatsapp")

    form = await req.form()
    remote_jid = str(form.get("remote_jid") or form.get("remoteJid") or "").strip()
    media_type = str(form.get("media_type") or form.get("mediaType") or "").strip().lower()
    caption = str(form.get("caption") or "").strip()
    file_name = str(form.get("file_name") or form.get("fileName") or "").strip()
    mime_type = str(form.get("mime_type") or form.get("mimeType") or "").strip()
    requested_broker_id = str(form.get("broker_id") or form.get("brokerId") or "").strip()
    file = form.get("file")

    if not remote_jid:
        return JSONResponse(status_code=400, content={"success": False, "error": "remote_jid is required"})
    if media_type not in {"image", "video", "audio", "document"}:
        return JSONResponse(status_code=400, content={"success": False, "error": "media_type must be image, video, audio, or document"})
    if not file or not hasattr(file, "read"):
        return JSONResponse(status_code=400, content={"success": False, "error": "file is required"})

    if not mime_type and hasattr(file, "content_type"):
        mime_type = str(getattr(file, "content_type") or "").strip()
    if not file_name and hasattr(file, "filename"):
        file_name = str(getattr(file, "filename") or "").strip()

    try:
        content = await file.read()
        selected_broker_id = await _select_reply_broker_id(member, requested_broker_id)
        data = {
            "remoteJid": remote_jid,
            "mediaType": media_type,
            "caption": caption,
        }
        if selected_broker_id:
            data["brokerId"] = selected_broker_id
        if mime_type:
            data["mimeType"] = mime_type
        if file_name:
            data["fileName"] = file_name

        files = {
            "file": (
                file_name or "attachment",
                content,
                mime_type or "application/octet-stream",
            )
        }

        base_url, response = await _first_ingestor_response(
            "POST",
            "/send-media",
            timeout=60,
            data=data,
            files=files,
            headers=_ingestor_auth_headers(),
        )
        status_code = response.status_code if response is not None else 502
        response_body = _normalize_upstream_response(response)

        try:
            storage.log_activity(
                team_member_id=member["id"],
                action="reply_whatsapp_sent" if status_code < 400 else "reply_whatsapp_failed",
                target_type="whatsapp_conversation",
                target_id=remote_jid,
                details={
                    "surface": "inbox",
                    "reply_text": caption[:500],
                    "media_type": media_type,
                    "file_name": file_name,
                    "transport_status_code": status_code,
                    "transport_response": response_body,
                    "transport_base_url": base_url or "",
                },
            )
        except Exception as exc:
            print(f"[activity-log] failed to record whatsapp media reply: {exc}", flush=True)

        return JSONResponse(
            status_code=status_code,
            content=response_body,
        )
    except httpx.ConnectError:
        try:
            storage.log_activity(
                team_member_id=member["id"],
                action="reply_whatsapp_failed",
                target_type="whatsapp_conversation",
                target_id=remote_jid,
                details={
                    "surface": "inbox",
                    "reply_text": caption[:500],
                    "error": "Cannot reach WhatsApp ingestor",
                },
            )
        except Exception as exc:
            print(f"[activity-log] failed to record whatsapp media error: {exc}", flush=True)
        return JSONResponse(
            status_code=502,
            content={"success": False, "error": "Cannot reach WhatsApp ingestor. Is WhatsApp connected?"},
        )
    except HTTPException:
        raise
    except Exception as exc:
        try:
            storage.log_activity(
                team_member_id=member["id"],
                action="reply_whatsapp_failed",
                target_type="whatsapp_conversation",
                target_id=remote_jid,
                details={
                    "surface": "inbox",
                    "reply_text": caption[:500],
                    "error": str(exc),
                },
            )
        except Exception as log_exc:
            print(f"[activity-log] failed to record whatsapp media exception: {log_exc}", flush=True)
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(exc)},
        )


@router.post("/public/leads")
async def public_create_lead(req: PublicLeadRequest):
    digits = "".join(ch for ch in req.client_phone if ch.isdigit())
    if len(digits) == 10:
        norm_phone = "91" + digits
    elif len(digits) == 11 and digits.startswith("0"):
        norm_phone = "91" + digits[1:]
    elif len(digits) == 12 and digits.startswith("91"):
        norm_phone = digits
    else:
        return JSONResponse(status_code=400, content={"error": "Invalid client phone number"})

    res = storage.db.execute(
        "SELECT id, broker_name, broker_phone, building_name, micro_market FROM listings_unified WHERE id = $1",
        [req.listing_id]
    )
    listing = res.fetchone()
    if not listing:
        return JSONResponse(status_code=404, content={"error": "Listing not found"})

    broker_phone = listing.get("broker_phone")
    broker_name = listing.get("broker_name")
    broker_id = None
    if not broker_phone and broker_name:
        res = storage.db.execute(
            "SELECT id, primary_phone FROM brokers WHERE canonical_name = $1 AND is_hidden = false",
            [broker_name]
        )
        broker = res.fetchone()
        if broker:
            broker_phone = broker.get("primary_phone")
            broker_id = broker.get("id")
    if not broker_phone and broker_name:
        res = storage.db.execute(
            "SELECT id, primary_phone FROM brokers WHERE canonical_name = $1 AND is_hidden = false",
            [broker_name]
        )
        broker = res.fetchone()
        if broker:
            broker_phone = broker.get("primary_phone")
            broker_id = broker.get("id")
    if broker_phone and not broker_id:
        phone_variants = [
            broker_phone,
            broker_phone.replace("+91", "").replace("+91 ", "").replace(" ", ""),
            "".join(ch for ch in broker_phone if ch.isdigit())
        ]
        for variant in phone_variants:
            res = storage.db.execute(
                "SELECT id FROM brokers WHERE primary_phone = $1",
                [variant]
            )
            broker = res.fetchone()
            if broker:
                broker_id = broker.get("id")
                break

    if not broker_phone:
        return JSONResponse(status_code=500, content={"error": "Listing has no broker phone"})

    res = storage.db.execute(
        """
        INSERT INTO leads (listing_id, broker_id, client_name, client_phone, message, source, status)
        VALUES ($1, $2, $3, $4, $5, 'www_portal', 'new')
        RETURNING id, status, created_at
        """,
        [req.listing_id, broker_id, req.client_name.strip(), norm_phone, (req.message or "").strip()]
    )
    lead = res.fetchone()

    building_or_market = listing.get("building_name") or listing.get("micro_market") or "the listing"
    notify_text = (
        f"New PropAI enquiry — {req.client_name.strip()} ({norm_phone}) "
        f"is interested in your listing at {building_or_market}. "
        f"{(req.message or '').strip()}"
    )
    notify_result = {"ok": False, "error": "not_attempted"}
    try:
        notify_result = await _notify_broker_of_lead(broker_phone, notify_text)
    except Exception as exc:
        notify_result = {"ok": False, "error": f"notify_exception: {exc}"}

    try:
        if notify_result and notify_result.get("ok"):
            storage.db.execute(
                "UPDATE leads SET status = 'notified' WHERE id = $1",
                [lead["id"]]
            )
        else:
            error_msg = "Unknown error"
            if notify_result:
                error_msg = str(notify_result.get("error", "Unknown error"))
            storage.db.execute(
                "UPDATE leads SET status = 'notify_failed', notify_error = $1 WHERE id = $2",
                [error_msg, lead["id"]]
            )
    except Exception as exc:
        pass

    return {"lead_id": lead["id"], "status": "created"}


@router.get("/public/listings")
async def public_listings(
    micro_market: str | None = None,
    bhk: str | None = None,
    intent: str | None = None,
    min_price: float | None = None,
    max_price: float | None = None,
    limit: int = 20,
    offset: int = 0,
):
    """
    Public listings endpoint for www.propai.live.
    No auth required. Filters: micro_market, bhk, intent, min_price, max_price.
    Returns listings without broker_name/broker_phone.
    """
    try:
        query = """
            SELECT l.id, l.fingerprint, l.intent, l.bhk, l.price, l.price_unit,
                   l.price_per_sqft, l.area_sqft, l.furnishing, l.location_label,
                   l.building_name, l.landmark_name, l.micro_market, l.street_name,
                   l.developer, l.floor_description, l.view, l.orientation,
                   l.pic_token, l.listing_source, l.first_seen, l.last_seen,
                   l.observation_count, l.group_count
            FROM listings_unified l
            LEFT JOIN brokers b ON l.broker_name = b.canonical_name
            WHERE l.last_seen > now() - interval '30 days'
              AND l.observation_count >= 2
              AND (b.is_hidden = false OR b.is_hidden IS NULL)
        """
        params = []

        if micro_market:
            params.append(micro_market)
            query += f" AND l.micro_market = ${len(params)}"
        if bhk:
            params.append(bhk)
            query += f" AND l.bhk = ${len(params)}"
        if intent:
            params.append(intent)
            query += f" AND l.intent = ${len(params)}"
        if min_price is not None:
            params.append(min_price)
            query += f" AND l.price >= ${len(params)}"
        if max_price is not None:
            params.append(max_price)
            query += f" AND l.price <= ${len(params)}"

        query += f" ORDER BY l.last_seen DESC LIMIT {limit} OFFSET {offset}"

        rows = storage.db.execute(query, params)
        return {"listings": rows.fetchall(), "count": len(rows.fetchall())}
    except Exception as exc:
        return JSONResponse(status_code=500, content={"error": str(exc)})


async def replay_raw_messages(tenant_id: str | None = None, *, batch_size: int = 200) -> dict:
    from extraction import process_raw_message
    from extraction_worker import context_from_raw

    cols = (
        "id, group_name, sender, sender_jid, sender_phone, message, message_hash, message_type, "
        "attachments, reply_context, timestamp, source, raw_payload, message_uid, "
        "is_group, pipeline_version, synced_at, event_id, processed, processed_at, tenant_id, created_at"
    )

    stats = ReplayStats()
    failure_counts: dict[str, int] = {}
    scanned = 0
    skipped_existing = 0
    offset = 0

    while True:
        query = storage.client.table("raw_messages").select(cols).order("timestamp", desc=True).limit(batch_size).offset(offset)
        if tenant_id:
            query = query.eq("tenant_id", tenant_id)
        res = query.execute()
        rows = res.data or []
        if not rows:
            break

        scanned += len(rows)
        offset += len(rows)

        for row in rows:
            raw_id = row.get("id")
            if not raw_id:
                continue

            try:
                if storage.get_parsed_by_raw(int(raw_id)):
                    skipped_existing += 1
                    continue
            except Exception as exc:
                stats.errors += 1
                failure_counts[exc.__class__.__name__] = failure_counts.get(exc.__class__.__name__, 0) + 1
                continue

            try:
                ctx = context_from_raw(row)
                if tenant_id:
                    ctx["tenant_id"] = tenant_id
                result = await asyncio.to_thread(process_raw_message, int(raw_id), ctx, storage)
                parsed_ids = result.get("parsed_ids") or []
                if parsed_ids:
                    stats.resolved += 1
                    try:
                        parsed_rows = storage.get_parsed_by_message(int(raw_id))
                        if parsed_rows:
                            confs = [float(getattr(p, "confidence", 0.0) or 0.0) for p in parsed_rows]
                            if confs:
                                stats.avg_confidence += sum(confs) / len(confs)
                    except Exception:
                        pass
                else:
                    stats.unresolved += 1
            except Exception as exc:
                stats.errors += 1
                failure_counts[exc.__class__.__name__] = failure_counts.get(exc.__class__.__name__, 0) + 1

    stats.total = scanned
    if stats.resolved > 0:
        stats.avg_confidence = round(stats.avg_confidence / stats.resolved, 4)
    stats.failure_breakdown = dict(sorted(failure_counts.items(), key=lambda x: -x[1]))
    return {
        **stats.model_dump(),
        "scanned": scanned,
        "skipped_existing": skipped_existing,
        "replayed": stats.resolved + stats.unresolved + stats.errors,
    }


@router.post("/api/replay")
async def replay_all(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    return await replay_raw_messages(tenant_id=tenant_id)
