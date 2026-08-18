"""Tenant-scoped creative assets and the bounded Social Flow agent."""

import base64
import asyncio
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
from fastapi import APIRouter, Depends, HTTPException, Query, Request

from routers.common import get_tenant_context, require_user, storage
from services import meta_mcp
from services import meta_mcp_oauth
from services.propai_ads_skills import ADS_SKILL_TOOLS, execute_ads_skill, is_ads_skill
from services.propai_agent_runtime import AgentRuntimeError, run_agent

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


def _is_closed_listing(row: dict) -> bool:
    status = re.sub(r"[ -]+", "_", str(row.get("availability_status") or "").strip().lower())
    return status in {"closed", "sold", "let_out", "withdrawn", "archived", "inactive", "unavailable"}


def _listing_brief(row: dict) -> dict:
    """Return only campaign-safe fields from an authenticated My Deals row."""
    fields = (
        "summary_title", "building_name", "micro_market", "location_raw", "bhk",
        "configuration_type", "asset_type", "property_type", "transaction_type",
        "price", "price_unit", "area_sqft", "furnishing", "floor_range",
        "parking_type", "car_parking_count", "possession_status", "possession_date",
        "availability_status", "available_from", "commercial_use_type", "fitout_status",
    )
    details = {key: row.get(key) for key in fields if row.get(key) not in (None, "", [], {})}
    return {
        "id": int(row.get("id") or 0),
        "source_schema": str(row.get("source_schema") or ""),
        "title": str(row.get("summary_title") or "Selected My Deals listing"),
        "details": details,
        "brief": json.dumps(details, ensure_ascii=False, indent=2, default=str),
    }


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


def _extract_meta_ids(state: dict[str, Any]) -> dict[str, str]:
    elements = state.get("elements") if isinstance(state.get("elements"), list) else []
    element_text = " ".join(json.dumps(item, default=str) for item in elements[:200])
    text = " ".join(str(state.get(key) or "") for key in ("title", "url", "text", "raw_output")) + " " + element_text
    page_match = re.search(r"(?:page\s*(?:id|identifier)|page_id)\s*[:#=]?\s*(\d{6,})", text, re.IGNORECASE)
    if not page_match:
        page_match = re.search(r"[?&]page_id[=/_-](\d{6,})", text, re.IGNORECASE)
    account_match = re.search(r"(?:ad\s*account\s*(?:id|identifier)|account_id)\s*[:#=]?\s*(?:act[_\s-]?)?(\d{6,})", text, re.IGNORECASE)
    if not account_match:
        account_match = re.search(r"(?:act[_/\s-]?)(\d{6,})", text, re.IGNORECASE)
    return {
        **({"page_id": page_match.group(1)} if page_match else {}),
        **({"ad_account_id": account_match.group(1)} if account_match else {}),
    }


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


@router.get("/api/social-flow/listing-context")
async def get_social_flow_listing_context(
    source_schema: str = Query(..., min_length=1, max_length=80),
    source_id: int = Query(..., ge=1),
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    """Load one user-owned My Deals listing for the Social Flow handoff."""
    if not tenant_id:
        raise HTTPException(403, "A workspace is required to share a listing")
    rows = await asyncio.to_thread(
        storage.get_my_deals, 500, tenant_id, None, str(user.get("id") or "")
    )
    match = next(
        (
            row for row in rows
            if str(row.get("source_schema") or "") == source_schema
            and int(row.get("id") or 0) == source_id
            and str(row.get("message_type") or "listing") == "listing"
        ),
        None,
    )
    if not match:
        raise HTTPException(404, "That listing is not available in your My Deals")
    if _is_closed_listing(match):
        raise HTTPException(409, "Closed listings cannot be sent to Social Flow")
    return _listing_brief(match)


@router.get("/api/social-flow/setup")
async def get_social_flow_setup(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    if not tenant_id:
        raise HTTPException(403, "A workspace is required to use Meta setup")
    return {"setup": _meta_settings(tenant_id)}


@router.get("/api/social-flow/connection")
async def check_social_flow_connection(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    if not tenant_id:
        raise HTTPException(403, "A workspace is required to check Meta connection")
    settings = _meta_settings(tenant_id)
    access_token = meta_mcp_oauth.access_token(tenant_id)
    oauth_connected = bool(access_token) and meta_mcp_oauth.has_connection(tenant_id)
    mcp = await meta_mcp.health(access_token)
    if mcp.get("status") == "connected":
        storage.client.table("social_flow_meta_settings").update({
            "meta_connection_status": "connected",
        }).eq("tenant_id", tenant_id).execute()
        return {
            "status": "connected",
            "message": "Meta is connected to this workspace through PropAI. Page and ad account selection is handled by the connector.",
            "setup": {**settings, "meta_connection_status": "connected"},
            "mcp": mcp,
        }
    if oauth_connected:
        # OAuth and MCP availability are different states. Keep the workspace
        # connected after a successful Meta login even if Meta's MCP endpoint
        # is unavailable or still warming up; agent calls will carry the MCP
        # diagnostic and can retry without forcing the user through OAuth.
        storage.client.table("social_flow_meta_settings").update({
            "meta_connection_status": "connected",
        }).eq("tenant_id", tenant_id).execute()
        mcp_message = str(mcp.get("message") or "Meta Ads tools are temporarily unavailable.")
        return {
            "status": "connected",
            "message": f"Meta is connected to this workspace through PropAI. {mcp_message}",
            "setup": {**settings, "meta_connection_status": "connected"},
            "mcp": mcp,
        }
    if settings.get("setup_status") != "ready":
        return {"status": "needs_setup", "message": "Page ID and Ad Account ID are required before Meta can be verified.", "setup": settings, "mcp": mcp}
    try:
        result = await _sdk_request("POST", "/api/sdk/actions/execute", {
            "action": "realtor_status",
            "params": {
                "page_id": settings.get("page_id"),
                "ad_account_id": settings.get("ad_account_id"),
            },
        })
        storage.client.table("social_flow_meta_settings").update({
            "meta_connection_status": "connected",
        }).eq("tenant_id", tenant_id).execute()
        return {"status": "connected", "message": "Meta connection verified. PropAI can read this ad account.", "setup": {**settings, "meta_connection_status": "connected"}, "result": result, "mcp": mcp}
    except HTTPException as exc:
        storage.client.table("social_flow_meta_settings").update({
            "meta_connection_status": "not_connected",
        }).eq("tenant_id", tenant_id).execute()
        detail = str(exc.detail or "Social Flow could not verify the Meta connection.")
        return {"status": "not_connected", "message": detail, "setup": {**settings, "meta_connection_status": "not_connected"}, "mcp": mcp}
    except Exception:
        storage.client.table("social_flow_meta_settings").update({
            "meta_connection_status": "not_connected",
        }).eq("tenant_id", tenant_id).execute()
        return {"status": "not_connected", "message": "Social Flow is unavailable. Check the SDK URL and gateway key, then retry.", "setup": {**settings, "meta_connection_status": "not_connected"}, "mcp": mcp}


@router.get("/api/social-flow/meta-mcp")
async def get_meta_mcp_status(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    if not tenant_id:
        raise HTTPException(403, "A workspace is required to check Meta MCP")
    return await meta_mcp.health(meta_mcp_oauth.access_token(tenant_id))


@router.post("/api/social-flow/meta-mcp/connect")
async def connect_meta_mcp(
    request: Request,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    if not tenant_id:
        raise HTTPException(403, "A workspace is required to connect Meta")
    if not meta_mcp.enabled():
        raise HTTPException(503, "Meta Ads MCP is not enabled on the API service")
    frontend_url = os.getenv("FRONTEND_URL", "https://app.propai.live").rstrip("/")
    redirect_uri = os.getenv("META_REDIRECT_URI", f"{frontend_url}/api/social-flow/meta/callback").strip()
    # Keep OAuth configuration compatible with the API-mounted callback route.
    # Older Coolify values used /social-flow/... and caused Meta to reject the
    # app domain before the request reached our callback.
    legacy_callback = f"{frontend_url}/social-flow/meta/callback"
    canonical_callback = f"{frontend_url}/api/social-flow/meta/callback"
    if redirect_uri == legacy_callback:
        redirect_uri = canonical_callback
    try:
        return await meta_mcp_oauth.begin(tenant_id, str(user.get("id") or ""), redirect_uri)
    except Exception as exc:
        raise HTTPException(502, "Meta OAuth could not be started") from exc


@router.get("/api/social-flow/meta-mcp/callback")
@router.get("/api/social-flow/meta/callback")
async def complete_meta_mcp(
    state: str = "",
    code: str = "",
    error: str = "",
):
    if error:
        raise HTTPException(400, "Meta OAuth was cancelled")
    if not state or not code:
        raise HTTPException(400, "Meta OAuth callback is missing state or code")
    try:
        result = await meta_mcp_oauth.finish(state, code)
    except Exception as exc:
        raise HTTPException(502, "Meta OAuth could not be completed") from exc
    frontend_url = os.getenv("FRONTEND_URL", "https://app.propai.live").rstrip("/")
    from fastapi.responses import RedirectResponse
    return RedirectResponse(f"{frontend_url}/social-flow?meta=connected", status_code=303)


@router.delete("/api/social-flow/meta-mcp")
async def disconnect_meta_mcp(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    if not tenant_id:
        raise HTTPException(403, "A workspace is required to disconnect Meta")
    storage.client.table("social_flow_meta_mcp_connections").delete().eq("tenant_id", tenant_id).execute()
    return {"ok": True, "status": "disconnected"}


@router.post("/api/social-flow/meta-discovery")
async def discover_social_flow_meta_ids(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    """Use the approved PropAI browser runtime to read Meta setup identifiers."""
    if not tenant_id:
        raise HTTPException(403, "A workspace is required to discover Meta IDs")
    from ai_chat_engine import execute_tool

    browser_session_id = str(uuid.uuid4())
    browser_args = {
        "url": "https://business.facebook.com/settings/accounts",
        "browser_session_id": browser_session_id,
        "session_label": "PropAI Meta setup lookup",
    }
    try:
        opened = await asyncio.to_thread(
            execute_tool, "browser_open", browser_args, {},
            tenant_id=tenant_id, storage_client=storage.client,
            user_id=str(user.get("id") or ""), browser_enabled=True,
            browser_provider="agent-browser",
        )
        if opened.get("status") != "ok":
            raise RuntimeError(str(opened.get("error") or opened.get("raw_output") or "The browser could not open Meta"))
        state = await asyncio.to_thread(
            execute_tool, "browser_state", {"browser_session_id": browser_session_id}, {},
            tenant_id=tenant_id, storage_client=storage.client,
            user_id=str(user.get("id") or ""), browser_enabled=True,
            browser_provider="agent-browser",
        )
        states = [state if isinstance(state, dict) else {}]
        for label_pattern in (r"ad\s*accounts?", r"pages?"):
            current = states[-1]
            elements = current.get("elements") if isinstance(current.get("elements"), list) else []
            candidate = next(
                (item for item in elements if isinstance(item, dict) and re.search(label_pattern, json.dumps(item, default=str), re.IGNORECASE) and str(item.get("index", "")).isdigit()),
                None,
            )
            if not candidate:
                continue
            clicked = await asyncio.to_thread(
                execute_tool, "browser_click", {"browser_session_id": browser_session_id, "index": int(candidate["index"])}, {},
                tenant_id=tenant_id, storage_client=storage.client,
                user_id=str(user.get("id") or ""), browser_enabled=True,
                browser_provider="agent-browser",
            )
            if clicked.get("status") == "ok":
                states.append(clicked)
        ids = {}
        for candidate_state in states:
            ids.update(_extract_meta_ids(candidate_state))
        saved = _save_setup(tenant_id, ids) if ids else _meta_settings(tenant_id)
        title = str(state.get("title") or "Meta Business settings") if isinstance(state, dict) else "Meta Business settings"
        logged_out = bool(re.search(r"log\s*in|create\s+account", f"{title} {state.get('text', '')}", re.IGNORECASE)) if isinstance(state, dict) else False
        if ids:
            message = "I found your Meta setup IDs and saved them to this workspace."
        elif logged_out:
            message = "Meta is asking for a login in PropAI’s secure browser. Log in there, then run the lookup again."
        else:
            message = "I opened Meta setup but could not read the IDs yet. Open the account/page settings there, then run the lookup again."
        return {"status": "found" if ids else "needs_login" if logged_out else "not_found", "message": message, "ids": ids, "setup": saved, "browser_session_id": browser_session_id}
    except Exception as exc:
        return {"status": "unavailable", "message": "PropAI could not open the Meta lookup browser right now.", "detail": str(exc), "browser_session_id": browser_session_id}


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
    mcp_access_token = meta_mcp_oauth.access_token(tenant_id)
    oauth_connected = bool(mcp_access_token) and meta_mcp_oauth.has_connection(tenant_id)
    connection_context = (
        "Meta OAuth is connected for this workspace. Page ID and ad account ID are optional; "
        "never ask the user to provide them for reporting or campaign lookup. Use the connected "
        "Meta Ads tools when available. If those tools are unavailable, explain that live Meta "
        "reporting is temporarily unavailable and ask the user to retry, not for IDs."
        if oauth_connected else
        "Meta OAuth is not connected for this workspace. Ask the user to connect Meta before live reporting."
    )
    messages = [{"role": "system", "content": f"You are PropAI's tenant-scoped Ads Agent. Never introduce yourself as Hermes or mention the underlying service name. Handle the user's full ads workflow in one conversation: property briefs, media analysis, creative copy, campaign planning, reports, optimization recommendations, setup, and approval preparation. Current saved setup (do not repeat questions for values already present): {json.dumps(settings, default=str)}. Connection context: {connection_context} If required setup is missing, ask only for the next smallest missing detail, except that Page ID and ad account ID must not be requested when Meta OAuth is connected. When the user provides Page ID, ad account ID, destination, currency, timezone, or default daily budget, return a concise acknowledgement followed by exactly one marker: [PROPAI_SETUP]{{\"values\":{{\"field\":\"value\"}}}}[/PROPAI_SETUP]. Use only these setup keys: page_id, ad_account_id, destination, currency, timezone, default_daily_budget. For live read-only requests, emit exactly one marker after your explanation: [PROPAI_READ]{{\"action\":\"realtor_report\",\"params\":{{\"preset\":\"last_7d\",\"level\":\"campaign\"}}}}[/PROPAI_READ]. Allowed read actions are realtor_report, realtor_status, realtor_list_campaigns. Never put access tokens, secrets, or phone numbers in a marker. Use only facts supplied by the user, attached media, or tool results. Never invent property facts, never expose credentials or phone numbers, and never claim an ad was published unless an execution tool result confirms it. Publishing, activation, pausing, budget changes, creative uploads, and destructive actions must remain approval-gated. When the user explicitly asks for a Meta mutation, return a concise explanation followed by exactly one machine-readable marker in this format: [PROPAI_ACTION]{{\"action\":\"realtor_create_campaign\",\"params\":{{\"text\":\"the complete campaign brief\"}},\"summary\":\"what will happen\"}}[/PROPAI_ACTION]. Allowed mutation actions are realtor_create_campaign, realtor_activate_campaign, realtor_pause_campaign, realtor_update_budget, and realtor_upload_creative. Do not emit action markers for drafts, previews, or recommendations."}]
    messages[0]["content"] = f"""You are PropAI's tenant-scoped Realtor Ads Strategist and execution assistant. Never introduce yourself as Hermes or mention the underlying service. Be proactive: turn a realtor's plain-language goal into a useful next-step plan instead of only asking setup questions.

Current saved setup (do not repeat values already present): {json.dumps(settings, default=str)}
Connection context: {connection_context}

For a property brief or campaign idea, call the relevant PropAI Ads planning skills before answering when their inputs are available. Then provide a practical draft with these sections when enough information exists:
1. Objective and recommended funnel stage.
2. Target audience: buyer/renter intent, geography, likely life-stage or use-case, and exclusions. Label inferred audience as a hypothesis; never claim Meta targeting availability or performance without tool evidence.
3. Creative direction: 2–3 angles, primary hook, format, proof points, and WhatsApp CTA. Use only verified property facts; clearly mark missing inputs.
4. Campaign structure: campaign/ad-set/ad grouping, placements, lead path, and a sensible test plan.
5. Budget recommendation as an assumption-based range, with what would change it. Do not present a budget as live or approved.
6. The smallest next decision needed from the realtor.

If key property details are missing, still give a useful provisional strategy and ask only for the highest-impact missing detail. Do not block planning just because Meta Page ID, ad account ID, or budget setup is missing. For live reporting, use connected read-only tools when available and distinguish measured results from recommendations. Never invent property facts, audience performance, live campaign data, credentials, or phone numbers.

When setup values are explicitly provided, append exactly one [PROPAI_SETUP]{{\"values\":{{\"field\":\"value\"}}}}[/PROPAI_SETUP] marker using only: page_id, ad_account_id, destination, currency, timezone, default_daily_budget.
For live read-only requests, append exactly one [PROPAI_READ]{{\"action\":\"realtor_report\",\"params\":{{\"preset\":\"last_7d\",\"level\":\"campaign\"}}}}[/PROPAI_READ] marker after the explanation. Allowed read actions: realtor_report, realtor_status, realtor_list_campaigns.
For an explicit request to create, activate, pause, change budget, or upload a creative, explain the proposed action and append exactly one approval-gated [PROPAI_ACTION] marker. Never emit action markers for drafts, previews, recommendations, or strategy."""
    history_budget = 24000
    for item in reversed(raw_history):
        if isinstance(item, dict) and item.get("role") in {"user", "assistant"}:
            history_text = str(item.get("text") or item.get("content") or "").strip()
            if history_text and history_budget > 0:
                bounded = history_text[: min(4000, history_budget)]
                messages.insert(1, {"role": str(item["role"]), "content": bounded})
                history_budget -= len(bounded)
    messages.append({"role": "user", "content": content})
    try:
        mcp_tools = []
        if meta_mcp.configured(mcp_access_token):
            try:
                mcp_tools = await meta_mcp.list_read_tools(mcp_access_token)
            except (httpx.HTTPError, RuntimeError, ValueError, TypeError):
                # Social Flow remains available if Meta MCP is temporarily
                # unavailable; the connection endpoint reports the failure.
                mcp_tools = []
        request_tools = ADS_SKILL_TOOLS + meta_mcp.to_openai_tools(mcp_tools)
        async def execute_meta_tool(call: dict[str, Any]) -> dict[str, Any]:
            function = call.get("function") if isinstance(call, dict) else {}
            raw_name = str(function.get("name") or "")
            tool_name = meta_mcp.tool_name_from_openai(raw_name)
            arguments = json.loads(function.get("arguments") or "{}")
            if is_ads_skill(raw_name):
                return execute_ads_skill(raw_name, arguments if isinstance(arguments, dict) else {})
            known = next((tool for tool in mcp_tools if tool.get("name") == tool_name), None)
            if not known or not meta_mcp._is_read_only(known):
                return {"error": "This Meta tool is not available without PropAI approval."}
            try:
                return await meta_mcp.call_tool(
                    tool_name,
                    arguments if isinstance(arguments, dict) else {},
                    mcp_access_token,
                )
            except (httpx.HTTPError, RuntimeError, ValueError, TypeError) as exc:
                return {"error": f"Meta Ads tool call failed: {str(exc)[:500]}"}

        result_data = await run_agent(
            base_url=base_url,
            api_key=api_key,
            model=os.getenv("HERMES_AGENT_MODEL", "hermes-admin"),
            messages=messages,
            tools=request_tools,
            execute_tool=execute_meta_tool,
            max_steps=4,
            timeout_seconds=120.0,
        )
        result = result_data["content"]
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
                    if oauth_connected and not (settings.get("page_id") and settings.get("ad_account_id")) and not mcp_tools:
                        sdk_result = {"message": "Meta is connected, but live Meta Ads tools are temporarily unavailable. Please retry in a moment."}
                    else:
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
        return {"content": clean_result, "asset_ids": [int(row["id"]) for row in rows], "approval": approval, "setup": setup_saved or settings, "sdk_result": sdk_result, "meta_mcp": {"enabled": bool(mcp_tools), "tools": len(mcp_tools)}}
    except (httpx.HTTPError, AgentRuntimeError, ValueError, TypeError) as exc:
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
        "approvalReason": "User approved the PropAI Ads Agent action.",
    })
    storage.client.table("social_flow_approvals").update({"status": "approved", "approved_at": datetime.now(timezone.utc).isoformat()}).eq("nonce", nonce).eq("status", "pending").execute()
    return {"ok": True, "action": action, "result": result}
