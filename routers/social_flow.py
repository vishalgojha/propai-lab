"""Tenant-scoped creative assets and the bounded Social Flow agent."""

import base64
import hashlib
import hmac
import json
import os
import re
import time
from datetime import datetime, timedelta, timezone
import uuid
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request

from routers.common import get_tenant_context, require_user, storage

router = APIRouter(tags=["social-flow"])

_BUCKET = "whatsapp-media"
_MAX_BYTES = 20 * 1024 * 1024
_MAX_ASSETS = 8
_ALLOWED = {
    "image/jpeg": "image", "image/png": "image", "image/webp": "image",
    "image/gif": "image", "video/mp4": "video", "video/quicktime": "video",
    "application/pdf": "document",
}
_READ_ACTIONS = {"realtor_report", "realtor_status", "realtor_list_campaigns"}
_MUTATING_ACTIONS = {
    "realtor_create_campaign",
    "realtor_activate_campaign",
    "realtor_pause_campaign",
    "realtor_update_budget",
    "realtor_upload_creative",
}
_SETUP_FIELDS = {"page_id", "ad_account_id", "destination", "currency", "timezone", "default_daily_budget"}


def _approval_secret() -> bytes:
    value = os.getenv("PROPAI_AGENT_CONFIRMATION_SECRET") or os.getenv("SUPABASE_JWT_SECRET")
    if not value:
        raise RuntimeError("approval secret is not configured")
    return value.encode()


def _approval_token(tenant_id: str, user_id: str, action: str, params: dict, sdk_token: str, nonce: str) -> str:
    payload = {
        "tenant_id": tenant_id,
        "user_id": user_id,
        "action": action,
        "params_hash": hashlib.sha256(json.dumps(params, sort_keys=True, default=str).encode()).hexdigest(),
        "sdk_token": sdk_token,
        "nonce": nonce,
        "exp": int(time.time()) + 900,
    }
    body = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode().rstrip("=")
    signature = hmac.new(_approval_secret(), body.encode(), hashlib.sha256).hexdigest()
    return f"{body}.{signature}"


def _read_approval_token(token: str, tenant_id: str, user_id: str, action: str, params: dict) -> dict:
    try:
        body, signature = token.split(".", 1)
        expected = hmac.new(_approval_secret(), body.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            raise ValueError("invalid approval signature")
        payload = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
        if int(payload.get("exp") or 0) < int(time.time()):
            raise ValueError("approval expired")
        if str(payload.get("tenant_id")) != str(tenant_id) or str(payload.get("user_id")) != str(user_id):
            raise ValueError("approval belongs to another workspace")
        if payload.get("action") != action:
            raise ValueError("approval action mismatch")
        params_hash = hashlib.sha256(json.dumps(params, sort_keys=True, default=str).encode()).hexdigest()
        if payload.get("params_hash") != params_hash:
            raise ValueError("approval parameters changed")
        return payload
    except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise HTTPException(400, str(exc)) from exc


async def _sdk_request(method: str, path: str, payload: dict) -> dict:
    base_url = os.getenv("SOCIAL_FLOW_SDK_URL", "").strip().rstrip("/")
    gateway_key = os.getenv("SOCIAL_FLOW_SDK_API_KEY", "").strip()
    if not base_url:
        raise HTTPException(503, "Social Flow SDK is not configured on the API service")
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if gateway_key:
        headers["X-Gateway-Key"] = gateway_key
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0)) as client:
            response = await client.request(method, f"{base_url}/{path.lstrip('/')}", json=payload, headers=headers)
        data = response.json() if response.content else {}
        if response.status_code >= 400 or data.get("error"):
            raise HTTPException(502, str(data.get("error") or data.get("message") or "Social Flow SDK rejected the request"))
        return data.get("data") or data
    except httpx.HTTPError as exc:
        raise HTTPException(503, "Social Flow SDK is unavailable") from exc


def _signed_url(path: str) -> str:
    result = storage.client.storage.from_(_BUCKET).create_signed_url(path, 900)
    if isinstance(result, dict):
        return str(result.get("signedURL") or result.get("signedUrl") or "")
    return ""


def _asset_view(row: dict) -> dict:
    return {
        "id": int(row["id"]),
        "filename": str(row.get("filename") or ""),
        "mime_type": str(row.get("mime_type") or ""),
        "size_bytes": int(row.get("size_bytes") or 0),
        "asset_kind": str(row.get("asset_kind") or ""),
        "created_at": row.get("created_at"),
        "url": _signed_url(str(row.get("storage_path") or "")),
    }


def _meta_settings(tenant_id: str) -> dict:
    rows = storage.client.table("social_flow_meta_settings").select(
        "page_id,ad_account_id,destination,currency,timezone,default_daily_budget,setup_status,meta_connection_status"
    ).eq("tenant_id", tenant_id).limit(1).execute().data or []
    return rows[0] if rows else {"setup_status": "needs_setup", "meta_connection_status": "not_connected"}


def _save_setup(tenant_id: str, values: dict[str, Any]) -> dict:
    safe = {key: values[key] for key in _SETUP_FIELDS if key in values and values[key] not in (None, "")}
    if "ad_account_id" in safe:
        safe["ad_account_id"] = str(safe["ad_account_id"]).removeprefix("act_")
    if "page_id" in safe:
        safe["page_id"] = str(safe["page_id"]).strip()
    if "default_daily_budget" in safe:
        safe["default_daily_budget"] = float(safe["default_daily_budget"])
    current = _meta_settings(tenant_id)
    merged = {key: current.get(key) for key in _SETUP_FIELDS if current.get(key) not in (None, "")}
    merged.update(safe)
    merged["tenant_id"] = tenant_id
    merged["setup_status"] = "ready" if merged.get("page_id") and merged.get("ad_account_id") else "needs_setup"
    row = storage.client.table("social_flow_meta_settings").upsert(merged, on_conflict="tenant_id").execute().data or []
    return row[0] if row else _meta_settings(tenant_id)


@router.get("/api/social-flow/assets")
async def list_social_flow_assets(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    if not tenant_id:
        raise HTTPException(403, "A workspace is required to use the creative lab")
    rows = storage.client.table("social_flow_assets").select(
        "id,filename,mime_type,size_bytes,asset_kind,storage_path,created_at"
    ).eq("tenant_id", tenant_id).order("created_at", desc=True).limit(_MAX_ASSETS).execute().data or []
    return {"assets": [_asset_view(row) for row in rows]}


@router.get("/api/social-flow/setup")
async def get_social_flow_setup(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    if not tenant_id:
        raise HTTPException(403, "A workspace is required to use Meta setup")
    return {"setup": _meta_settings(tenant_id)}


@router.post("/api/social-flow/assets")
async def upload_social_flow_asset(
    request: Request,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    if not tenant_id:
        raise HTTPException(403, "A workspace is required to use the creative lab")
    form = await request.form()
    file = form.get("file")
    if not file or not getattr(file, "filename", ""):
        raise HTTPException(400, "A media file is required")
    mime_type = str(getattr(file, "content_type", "") or "application/octet-stream").lower()
    asset_kind = _ALLOWED.get(mime_type)
    if not asset_kind:
        raise HTTPException(415, "Upload a JPG, PNG, WEBP, GIF, MP4, MOV, or PDF file")
    content = await file.read()
    if not content:
        raise HTTPException(400, "The uploaded file is empty")
    if len(content) > _MAX_BYTES:
        raise HTTPException(413, "Files must be 20 MB or smaller")
    suffix = Path(str(file.filename)).suffix.lower()[:10] or ".bin"
    path = f"social-flow/{tenant_id}/{uuid.uuid4().hex}{suffix}"
    storage.client.storage.from_(_BUCKET).upload(
        path, content, {"content-type": mime_type, "upsert": "false"}
    )
    try:
        row = storage.client.table("social_flow_assets").insert({
            "tenant_id": tenant_id,
            "storage_path": path,
            "filename": str(file.filename)[:240],
            "mime_type": mime_type,
            "size_bytes": len(content),
            "asset_kind": asset_kind,
            "created_by": user.get("id"),
        }).execute().data
    except Exception:
        try:
            storage.client.storage.from_(_BUCKET).remove([path])
        except Exception:
            pass
        raise HTTPException(500, "The asset metadata could not be saved")
    return {"asset": _asset_view((row or [{}])[0])}


@router.post("/api/social-flow/agent")
async def social_flow_agent(
    body: dict[str, Any],
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    """Ask the isolated Hermes service for a creative brief using uploaded media.

    This phase deliberately sends no Meta mutation tools. Publishing and budget
    changes remain in the approval-gated Social Flow executor.
    """
    if not tenant_id:
        raise HTTPException(403, "A workspace is required to use the creative lab")
    if os.getenv("SOCIAL_FLOW_AGENT_ENABLED", "false").lower() != "true":
        raise HTTPException(503, "The Social Flow creative agent is not enabled")
    base_url = os.getenv("HERMES_API_URL", "").strip().rstrip("/")
    api_key = os.getenv("HERMES_API_KEY", "").strip()
    prompt = str(body.get("prompt") or "").strip()
    asset_ids = [int(value) for value in (body.get("asset_ids") or []) if str(value).isdigit()][: _MAX_ASSETS]
    raw_history = body.get("messages") or []
    if not base_url or not api_key:
        raise HTTPException(503, "The creative agent is not configured")
    if not prompt or len(prompt) > 6000:
        raise HTTPException(400, "prompt is required and must be 6,000 characters or fewer")
    if not isinstance(raw_history, list) or len(raw_history) > 12:
        raise HTTPException(400, "messages must contain at most 12 items")
    rows = []
    if asset_ids:
        rows = storage.client.table("social_flow_assets").select(
            "id,filename,mime_type,asset_kind,storage_path"
        ).eq("tenant_id", tenant_id).in_("id", asset_ids).execute().data or []
    content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
    for row in rows:
        url = _signed_url(str(row.get("storage_path") or ""))
        if url and str(row.get("mime_type") or "").startswith("image/"):
            content.append({"type": "image_url", "image_url": {"url": url}})
        else:
            content.append({"type": "text", "text": f"Attached asset: {row.get('filename')} ({row.get('mime_type')})"})
    settings = _meta_settings(tenant_id)
    messages = [{"role": "system", "content": f"You are Hermes, PropAI's tenant-scoped Meta Ads agent. Handle the user's full ads workflow in one conversation: property briefs, media analysis, creative copy, campaign planning, reports, optimization recommendations, setup, and approval preparation. Current saved setup (do not repeat questions for values already present): {json.dumps(settings, default=str)}. If required setup is missing, ask only for the next smallest missing detail. When the user provides Page ID, ad account ID, destination, currency, timezone, or default daily budget, return a concise acknowledgement followed by exactly one marker: [PROPAI_SETUP]{{\"values\":{{\"field\":\"value\"}}}}[/PROPAI_SETUP]. Use only these setup keys: page_id, ad_account_id, destination, currency, timezone, default_daily_budget. For live read-only requests, emit exactly one marker after your explanation: [PROPAI_READ]{{\"action\":\"realtor_report\",\"params\":{{\"preset\":\"last_7d\",\"level\":\"campaign\"}}}}[/PROPAI_READ]. Allowed read actions are realtor_report, realtor_status, realtor_list_campaigns. Never put access tokens, secrets, or phone numbers in a marker. Use only facts supplied by the user, attached media, or tool results. Never invent property facts, never expose credentials or phone numbers, and never claim an ad was published unless an execution tool result confirms it. Publishing, activation, pausing, budget changes, creative uploads, and destructive actions must remain approval-gated. When the user explicitly asks for a Meta mutation, return a concise explanation followed by exactly one machine-readable marker in this format: [PROPAI_ACTION]{{\"action\":\"realtor_create_campaign\",\"params\":{{\"text\":\"the complete campaign brief\"}},\"summary\":\"what will happen\"}}[/PROPAI_ACTION]. Allowed mutation actions are realtor_create_campaign, realtor_activate_campaign, realtor_pause_campaign, realtor_update_budget, and realtor_upload_creative. Do not emit action markers for drafts, previews, or recommendations."}]
    for item in raw_history:
        if isinstance(item, dict) and item.get("role") in {"user", "assistant"}:
            history_text = str(item.get("text") or item.get("content") or "").strip()
            if history_text:
                messages.append({"role": str(item["role"]), "content": history_text[:6000]})
    messages.append({"role": "user", "content": content})
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0)) as client:
            response = await client.post(
                f"{base_url}/chat/completions",
                json={"model": os.getenv("HERMES_AGENT_MODEL", "hermes-admin"), "messages": messages, "stream": False},
                headers={"Authorization": f"Bearer {api_key}"},
            )
        response.raise_for_status()
        data = response.json()
        result = ((data.get("choices") or [{}])[0].get("message") or {}).get("content")
        if not isinstance(result, str) or not result.strip():
            raise ValueError("empty agent response")
        clean_result = result
        approval = None
        setup_saved = None
        sdk_result = None
        setup_marker = re.search(r"\[PROPAI_SETUP\](.*?)\[/PROPAI_SETUP\]", clean_result, re.DOTALL)
        if setup_marker:
            try:
                proposed_setup = json.loads(setup_marker.group(1))
                setup_values = proposed_setup.get("values") if isinstance(proposed_setup.get("values"), dict) else {}
                setup_saved = _save_setup(tenant_id, setup_values)
                clean_result = (clean_result[:setup_marker.start()] + clean_result[setup_marker.end():]).strip()
            except (json.JSONDecodeError, TypeError, ValueError):
                pass
        read_marker = re.search(r"\[PROPAI_READ\](.*?)\[/PROPAI_READ\]", clean_result, re.DOTALL)
        if read_marker:
            try:
                proposed_read = json.loads(read_marker.group(1))
                read_action = str(proposed_read.get("action") or "")
                read_params = proposed_read.get("params") if isinstance(proposed_read.get("params"), dict) else {}
                if read_action in _READ_ACTIONS:
                    sdk_result = await _sdk_request("POST", "/api/sdk/actions/execute", {
                        "action": read_action,
                        "params": read_params,
                    })
                clean_result = (clean_result[:read_marker.start()] + clean_result[read_marker.end():]).strip()
            except json.JSONDecodeError:
                pass
        marker = re.search(r"\[PROPAI_ACTION\](.*?)\[/PROPAI_ACTION\]", clean_result, re.DOTALL)
        if marker:
            try:
                proposed = json.loads(marker.group(1))
                action = str(proposed.get("action") or "")
                params = proposed.get("params") if isinstance(proposed.get("params"), dict) else {}
                if action in _MUTATING_ACTIONS:
                    plan = await _sdk_request("POST", "/api/sdk/actions/plan", {"action": action, "params": params})
                    sdk_token = str(
                        (plan.get("approvalToken") or plan.get("approval_token") or (plan.get("meta") or {}).get("approvalToken"))
                        if isinstance(plan, dict) else ""
                    )
                    if not sdk_token:
                        raise HTTPException(502, "Social Flow did not return an approval token")
                    nonce = uuid.uuid4().hex
                    params_hash = hashlib.sha256(json.dumps(params, sort_keys=True, default=str).encode()).hexdigest()
                    storage.client.table("social_flow_approvals").insert({
                        "nonce": nonce,
                        "tenant_id": tenant_id,
                        "user_id": user.get("id"),
                        "action": action,
                        "params_hash": params_hash,
                        "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat(),
                    }).execute()
                    approval = {
                        "token": _approval_token(tenant_id, str(user.get("id") or ""), action, params, sdk_token, nonce),
                        "action": action,
                        "params": params,
                        "summary": str(proposed.get("summary") or "This action will create a paused Meta campaign."),
                    }
                clean_result = (clean_result[:marker.start()] + clean_result[marker.end():]).strip()
            except json.JSONDecodeError:
                pass
        return {"content": clean_result, "asset_ids": [int(row["id"]) for row in rows], "approval": approval, "setup": setup_saved or settings, "sdk_result": sdk_result}
    except (httpx.HTTPError, ValueError, TypeError) as exc:
        raise HTTPException(502, "The creative agent could not complete this request") from exc


@router.post("/api/social-flow/actions/execute")
async def execute_social_flow_action(
    body: dict[str, Any],
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    if not tenant_id:
        raise HTTPException(403, "A workspace is required to execute Meta actions")
    action = str(body.get("action") or "")
    params = body.get("params") if isinstance(body.get("params"), dict) else {}
    if action not in _MUTATING_ACTIONS:
        raise HTTPException(400, "This Meta action is not enabled yet")
    token = str(body.get("approval_token") or "")
    payload = _read_approval_token(token, tenant_id, str(user.get("id") or ""), action, params)
    nonce = str(payload.get("nonce") or "")
    rows = storage.client.table("social_flow_approvals").select("nonce,status,expires_at").eq("nonce", nonce).eq("tenant_id", tenant_id).eq("user_id", user.get("id")).eq("status", "pending").limit(1).execute().data or []
    if not rows:
        raise HTTPException(400, "This approval is expired, cancelled, or already used")
    result = await _sdk_request("POST", "/api/sdk/actions/execute", {
        "action": action,
        "params": params,
        "approvalToken": payload["sdk_token"],
        "approvalReason": "User approved the Hermes Ads Agent action in PropAI.",
    })
    storage.client.table("social_flow_approvals").update({"status": "approved", "approved_at": datetime.now(timezone.utc).isoformat()}).eq("nonce", nonce).eq("status", "pending").execute()
    return {"ok": True, "action": action, "result": result}
