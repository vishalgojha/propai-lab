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

from routers.common import storage, require_user, get_tenant_context, get_current_team_member, check_permission, _select_reply_broker_id

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

_send_url: object = None
_ingestor_auth_headers: object = None
_notify_broker_of_lead: object = None


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
        ingestor_url = _send_url()
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

        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                f"{ingestor_url}/send-message", json=payload, headers=_ingestor_auth_headers()
            )

        response_body = {}
        if response.text:
            try:
                response_body = response.json()
            except Exception:
                response_body = {"raw": response.text[:1000]}

        try:
            storage.log_activity(
                team_member_id=member["id"],
                action="reply_whatsapp_sent" if response.status_code < 400 else "reply_whatsapp_failed",
                target_type="whatsapp_conversation",
                target_id=req.remote_jid,
                details={
                    "surface": "inbox",
                    "reply_text": text[:500],
                    "quoted_message_id": req.quoted_message_id or "",
                    "quoted_remote_jid": req.quoted_remote_jid or "",
                    "quoted_participant": req.quoted_participant or "",
                    "quoted_from_me": bool(req.quoted_from_me),
                    "transport_status_code": response.status_code,
                    "transport_response": response_body,
                },
            )
        except Exception as exc:
            print(f"[activity-log] failed to record whatsapp reply: {exc}", flush=True)

        return JSONResponse(
            status_code=response.status_code,
            content=response_body if response.text else {"success": False, "error": "empty response"},
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
        ingestor_url = _send_url()
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

        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.post(
                f"{ingestor_url}/send-media",
                data=data,
                files=files,
                headers=_ingestor_auth_headers(),
            )

        response_body = {}
        if response.text:
            try:
                response_body = response.json()
            except Exception:
                response_body = {"raw": response.text[:1000]}

        try:
            storage.log_activity(
                team_member_id=member["id"],
                action="reply_whatsapp_sent" if response.status_code < 400 else "reply_whatsapp_failed",
                target_type="whatsapp_conversation",
                target_id=remote_jid,
                details={
                    "surface": "inbox",
                    "reply_text": caption[:500],
                    "media_type": media_type,
                    "file_name": file_name,
                    "transport_status_code": response.status_code,
                    "transport_response": response_body,
                },
            )
        except Exception as exc:
            print(f"[activity-log] failed to record whatsapp media reply: {exc}", flush=True)

        return JSONResponse(
            status_code=response.status_code,
            content=response_body if response.text else {"success": False, "error": "empty response"},
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
        "SELECT id, broker_name, broker_phone, building_name, micro_market FROM listings WHERE id = $1",
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


@router.post("/api/replay")
async def replay_all(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    from evidence.resolver import CACHE as R_CACHE
    from evidence.resolver import _load_landmarks
    from evidence.resolver import resolve as core_resolve
    from evidence.resolver import resolve_by_street

    raws = storage.get_all_raw_for_replay(tenant_id=tenant_id)

    def parse_message(raw_text: str, profile_name: str | None = None) -> dict:
        from evidence.parsers import parse as broker_parse
        return broker_parse(raw_text, profile_name=profile_name)

    def resolve_parsed(parsed: dict, raw_text: str) -> dict:
        method = "resolved"
        final_confidence = 0.0
        failure_category = ""
        try:
            resolved_from_list = core_resolve(parsed)
            if resolved_from_list:
                final_confidence = resolved_from_list["confidence"]
            resolver_result = resolved_from_list
            if not resolver_result:
                resolver_result = resolve_by_landmark(parsed)
                if resolver_result:
                    final_confidence = resolver_result["confidence"]
            if not resolver_result:
                resolver_result = resolve_by_street(parsed)
                if resolver_result:
                    final_confidence = resolver_result["confidence"]
            if not resolver_result:
                method = "unresolved"
                failure_category = "no_resolver_match"
            return {
                "method": method,
                "final_confidence": final_confidence,
                "failure_category": failure_category,
            }
        except Exception as e:
            return {
                "method": "error",
                "final_confidence": 0.0,
                "failure_category": str(e)[:100],
            }

    def resolve_by_landmark(parsed: dict) -> dict | None:
        try:
            R_CACHE.clear()
            _load_landmarks()
            return core_resolve(parsed)
        except Exception:
            return None

    stats = ReplayStats()
    stats.total = len(raws)
    failure_counts = {}

    for msg in raws:
        raw_text = msg.message
        parsed_result = parse_message(raw_text)
        resolver_result = resolve_parsed(parsed_result, raw_text)

        if resolver_result["method"] == "resolved":
            stats.resolved += 1
            stats.avg_confidence += resolver_result.get("final_confidence", 0.0)
        elif resolver_result["method"] == "unresolved":
            stats.unresolved += 1
        else:
            stats.errors += 1

        fc = resolver_result.get("failure_category") or "unknown"
        failure_counts[fc] = failure_counts.get(fc, 0) + 1

    if stats.resolved > 0:
        stats.avg_confidence = round(stats.avg_confidence / stats.resolved, 4)

    stats.failure_breakdown = dict(sorted(failure_counts.items(), key=lambda x: -x[1]))

    return stats.model_dump()
