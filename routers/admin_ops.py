"""Super-admin-only bridge to the isolated OpenClaw operations agent.

OpenClaw is deliberately kept outside the customer chat loop. This router
owns the PropAI auth boundary and forwards only server-side credentials to an
OpenClaw OpenAI-compatible Gateway when explicitly configured.
"""

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import subprocess
from pathlib import Path
import re
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException

from routers.common import require_user, storage, get_tenant_context, _resolve_active_organization_id
from services.propai_agent_runtime import AgentRuntimeError
from services.propai_ops_agent import native_ops_status, run_propai_ops

# Route names remain stable for UI compatibility; execution is PropAI-owned.
router = APIRouter(tags=["admin-ops"])
logger = logging.getLogger(__name__)

_DB_ACTION_RE = re.compile(r"\[PROPAI_DB_ACTION\](.*?)\[/PROPAI_DB_ACTION\]", re.DOTALL)
_DB_OPERATIONS = {"create_row", "update_row", "delete_row", "run_function"}
_DB_HIDDEN_KEYS = ("phone", "mobile", "whatsapp", "access_token", "api_key", "secret", "password")

_PROPAI_SYSTEM_PROMPT = """You are the PropAI Operations Agent, an internal coding and operations agent for the Super Admin.

Your job is to help operate and improve PropAI, a real-estate intelligence platform. Stay PropAI-scoped: reason about this repository's FastAPI backend, Next.js dashboards, WhatsApp/WhatsMeow ingestion, deterministic extraction, building and listing enrichment, Supabase/Postgres, Coolify deployments, provider costs, and data quality. Do not answer as a generic personal assistant unless the request is clearly unrelated; redirect unrelated requests back to PropAI operations.

For property inventory questions, use PropAI's own parsed market/search systems and repository code; do not launch open-ended web searches unless the Super Admin explicitly asks for external research. If the requested data is not mounted or reachable, say that immediately instead of repeatedly searching.

When investigating, state the evidence and the exact files, services, tables, or deployment variables involved. Follow PropAI's rules: never fabricate inventory or counters, never expose phone numbers, never auto-merge listings, preserve message freshness/source traceability, and do not replace deterministic extraction with an LLM without explicit approval.

You have the PropAI repository checkout plus the `propai-ops` skill. Use that skill for live broker, embedding, extraction, Supabase-backed diagnostics, and Coolify status/deploy operations. Do not ask the Super Admin for Supabase or Coolify credentials: the internal bridge already has scoped server-side access. Never print or expose bridge tokens. Treat production database writes, migrations, deployments, secret changes, destructive commands, and customer-impacting behavior as approval-gated; for deployments, inspect first and ask for confirmation of the exact target and commit before executing."""


def _openclaw_config() -> tuple[str, str, str]:
    base_url = (os.getenv("OPENCLAW_API_URL") or "").strip().rstrip("/")
    api_key = (os.getenv("OPENCLAW_API_KEY") or "").strip()
    model = (os.getenv("OPENCLAW_AGENT_MODEL") or "openclaw/default").strip() or "openclaw/default"
    return base_url, api_key, model


_REPO_QUESTION_RE = re.compile(
    r"\b(?:code|repo(?:sitory)?|extract(?:ion|ed|or)?|data\s+quality|"
    r"building(?:s)?|dedup(?:lication)?|duplicate|parser|worker|migration|"
    r"deployment|deploy|schema|bug|error|log|implementation|fix)\b",
    re.IGNORECASE,
)
_REPO_SEARCH_TERMS = (
    "building_name_problem",
    "repair_building_assignment",
    "source_grounded",
    "validation_flags",
    "needs_review",
    "dedup",
    "extraction_confidence",
)
_REPO_SEARCH_FILES = (
    "extraction_quality.py",
    "extraction.py",
    "ai_extraction.py",
    "storage/supabase.py",
    "docs/DATA_QUALITY.md",
)


def _local_repo_evidence(prompt: str) -> str:
    """Collect bounded, read-only repository evidence before model reasoning.

    The operations agent must not depend on OpenClaw being available to answer
    questions whose evidence is already in the PropAI checkout. The query is
    passed as an argument to ``rg`` (never through a shell), and only curated
    source files/terms are searched.
    """
    if not _REPO_QUESTION_RE.search(prompt or ""):
        return ""
    repo_root = Path(__file__).resolve().parents[1]
    sections: list[str] = []
    try:
        commit = subprocess.run(
            ["git", "-C", str(repo_root), "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, timeout=2, check=False,
        ).stdout.strip()
        if commit:
            sections.append(f"Repository checkout: {repo_root} (commit {commit})")
    except (OSError, subprocess.SubprocessError):
        sections.append(f"Repository checkout: {repo_root}")

    for term in _REPO_SEARCH_TERMS:
        try:
            result = subprocess.run(
                [
                    "rg", "-n", "-S", "--max-count", "12", "--fixed-strings",
                    term, *_REPO_SEARCH_FILES,
                ],
                cwd=repo_root,
                capture_output=True,
                text=True,
                timeout=3,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            continue
        lines = [line for line in result.stdout.splitlines() if line.strip()][:12]
        if lines:
            sections.append(f"rg {term!r}:\n" + "\n".join(lines))
    if not sections:
        return "No local repository evidence was found for this request."
    return "\n\n".join(sections)[:16000]


def _extract_completion(response: httpx.Response) -> tuple[str, dict[str, Any]]:
    """Accept normal JSON and providers that return SSE chunks despite stream=false."""
    content_type = (response.headers.get("content-type") or "").lower()
    raw = response.text.strip()
    if "text/event-stream" not in content_type and not raw.startswith("data:"):
        data = response.json()
        if not isinstance(data, dict):
            raise ValueError("invalid completion response")
        choices = data.get("choices")
        if not isinstance(choices, list) or not choices:
            raise ValueError("completion response contained no choices")
        message = choices[0].get("message") if isinstance(choices[0], dict) else None
        content = message.get("content") if isinstance(message, dict) else None
        if isinstance(content, list):
            content = "\n".join(
                str(part.get("text")) for part in content
                if isinstance(part, dict) and isinstance(part.get("text"), str)
            ).strip()
        if not isinstance(content, str):
            raise ValueError("completion response contained no text content")
        return content, data

    parts: list[str] = []
    last: dict[str, Any] = {}
    for line in raw.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if not payload or payload == "[DONE]":
            continue
        chunk = json.loads(payload)
        if not isinstance(chunk, dict):
            continue
        last = chunk
        choices = chunk.get("choices") or []
        delta = choices[0].get("delta") if isinstance(choices[0], dict) else None
        text = delta.get("content") if isinstance(delta, dict) else None
        if isinstance(text, str):
            parts.append(text)
    content = "".join(parts).strip()
    if not content:
        raise ValueError("stream response contained no text content")
    return content, last


async def _require_super_admin(user: dict) -> None:
    user_id = str(user.get("id") or "").strip()
    if not user_id:
        raise HTTPException(401, "Authenticated user id is missing")
    try:
        allowed = await asyncio.to_thread(storage.is_super_admin, user_id)
    except Exception as exc:
        logger.exception("OpenClaw super-admin check failed")
        raise HTTPException(503, "PropAI admin authorization is temporarily unavailable") from exc
    if not allowed:
        raise HTTPException(403, "Super admin access required")


def _ops_tenant(user: dict, tenant_id: str | None) -> str:
    return str(_resolve_active_organization_id(user, tenant_id) or "").strip()


def _approval_secret() -> bytes:
    value = os.getenv("PROPAI_AGENT_CONFIRMATION_SECRET") or os.getenv("SUPABASE_JWT_SECRET")
    if not value:
        raise RuntimeError("approval secret is not configured")
    return value.encode()


def _json_hash(value: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()


def _make_db_approval_token(tenant_id: str, user_id: str, action: dict[str, Any]) -> str:
    payload = {"tenant_id": tenant_id, "user_id": user_id, "action": action, "action_hash": _json_hash(action), "exp": int(datetime.now(timezone.utc).timestamp()) + 900}
    body = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode().rstrip("=")
    signature = hmac.new(_approval_secret(), body.encode(), hashlib.sha256).hexdigest()
    return f"{body}.{signature}"


def _read_db_approval_token(token: str, tenant_id: str, user_id: str) -> dict[str, Any]:
    try:
        body, signature = token.split(".", 1)
        if not hmac.compare_digest(signature, hmac.new(_approval_secret(), body.encode(), hashlib.sha256).hexdigest()):
            raise ValueError("invalid approval signature")
        payload = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
        if int(payload.get("exp") or 0) < int(datetime.now(timezone.utc).timestamp()):
            raise ValueError("approval expired")
        if str(payload.get("tenant_id")) != tenant_id or str(payload.get("user_id")) != user_id:
            raise ValueError("approval belongs to another workspace or user")
        action = payload.get("action")
        if not isinstance(action, dict) or payload.get("action_hash") != _json_hash(action):
            raise ValueError("approval payload is invalid")
        return action
    except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise HTTPException(400, str(exc)) from exc


def _extract_db_action(content: str) -> tuple[str, dict[str, Any] | None]:
    match = _DB_ACTION_RE.search(content or "")
    if not match:
        return content, None
    try:
        action = json.loads(match.group(1).strip())
    except json.JSONDecodeError:
        return content.replace(match.group(0), "").strip(), None
    if not isinstance(action, dict) or action.get("operation") not in _DB_OPERATIONS:
        return content.replace(match.group(0), "").strip(), None
    operation = str(action["operation"])
    normalized: dict[str, Any] = {"operation": operation, "summary": str(action.get("summary") or "Review this proposed database action")[:300]}
    if operation in {"create_row", "update_row"}:
        normalized["table"] = str(action.get("table") or "").strip()
        normalized["values"] = action.get("values") if isinstance(action.get("values"), dict) else {}
        if operation == "update_row": normalized["row_id"] = str(action.get("row_id") or "").strip()
    elif operation == "delete_row":
        normalized["table"] = str(action.get("table") or "").strip()
        normalized["row_id"] = str(action.get("row_id") or "").strip()
    else:
        normalized["function_name"] = str(action.get("function_name") or "").strip()
        normalized["arguments"] = action.get("arguments") if isinstance(action.get("arguments"), dict) else {}
    if any(any(token in str(key).lower() for token in _DB_HIDDEN_KEYS) for key in (normalized.get("values") or normalized.get("arguments") or {}).keys()):
        return content.replace(match.group(0), "").strip(), None
    required = (normalized.get("table") and (normalized.get("row_id") if operation in {"update_row", "delete_row"} else True)) if operation != "run_function" else normalized.get("function_name")
    if not required or (operation in {"create_row", "update_row"} and not normalized["values"]):
        return content.replace(match.group(0), "").strip(), None
    return content.replace(match.group(0), "").strip(), normalized


def _ops_session(session_id: str, user_id: str, tenant_id: str) -> dict | None:
    if not session_id or not tenant_id or not user_id:
        return None
    rows = storage.client.table("operations_agent_sessions").select(
        "id,title,created_at,updated_at"
    ).eq("id", session_id).eq("tenant_id", tenant_id).eq("user_id", user_id).limit(1).execute().data or []
    return dict(rows[0]) if rows else None


def _operations_storage_error(exc: Exception) -> HTTPException:
    """Turn persistence failures into an actionable, non-leaky API error."""
    logger.exception("Operations Agent persistence failed", exc_info=exc)
    return HTTPException(
        503,
        "Operations Agent history storage is unavailable. Apply the operations-agent persistence migration and retry.",
    )


@router.get("/api/admin/ops/sessions")
async def list_admin_ops_sessions(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    await _require_super_admin(user)
    tenant = _ops_tenant(user, tenant_id)
    rows = storage.client.table("operations_agent_sessions").select(
        "id,title,created_at,updated_at"
    ).eq("tenant_id", tenant).eq("user_id", str(user.get("id") or "")).order(
        "updated_at", desc=True
    ).limit(30).execute().data or []
    return rows


@router.post("/api/admin/ops/sessions")
async def create_admin_ops_session(
    body: dict[str, Any] | None = None,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    await _require_super_admin(user)
    tenant = _ops_tenant(user, tenant_id)
    payload = {
        "tenant_id": tenant,
        "user_id": str(user.get("id") or ""),
        "title": str((body or {}).get("title") or "New session")[:120],
    }
    rows = storage.client.table("operations_agent_sessions").insert(payload).execute().data or []
    if not rows:
        raise HTTPException(500, "Could not create Operations Agent session")
    return rows[0]


@router.get("/api/admin/ops/sessions/{session_id}/messages")
async def list_admin_ops_messages(
    session_id: str,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    await _require_super_admin(user)
    tenant = _ops_tenant(user, tenant_id)
    if not _ops_session(session_id, str(user.get("id") or ""), tenant):
        raise HTTPException(404, "Operations Agent session not found")
    return storage.client.table("operations_agent_messages").select(
        "id,role,content,metadata,created_at"
    ).eq("tenant_id", tenant).eq("session_id", session_id).order("created_at").limit(200).execute().data or []


@router.get("/api/admin/ops/status")
async def admin_ops_status(user: dict = Depends(require_user)):
    await _require_super_admin(user)
    return {**native_ops_status(), "reachable": bool(native_ops_status().get("configured")), "health_error": None}


@router.post("/api/admin/ops/chat")
async def admin_ops_chat(
    body: dict[str, Any],
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    """Run one bounded, read-only multi-step PropAI Ops request."""
    await _require_super_admin(user)
    prompt = str(body.get("prompt") or "").strip()
    raw_attachments = body.get("attachments") or []
    if not isinstance(raw_attachments, list) or len(raw_attachments) > 4:
        raise HTTPException(400, "attachments must contain at most 4 images")
    attachments: list[dict[str, str]] = []
    total_attachment_bytes = 0
    for item in raw_attachments:
        if not isinstance(item, dict):
            raise HTTPException(400, "invalid attachment")
        mime_type = str(item.get("mime_type") or "").strip().lower()
        data_url = str(item.get("data_url") or "").strip()
        file_name = str(item.get("file_name") or "image").strip()[:160]
        if not mime_type.startswith("image/") or not data_url.startswith(f"data:{mime_type};base64,"):
            raise HTTPException(400, "only base64 image attachments are supported")
        encoded = data_url.split(",", 1)[1]
        try:
            decoded = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError):
            raise HTTPException(400, "invalid image attachment") from None
        if len(decoded) > 8 * 1024 * 1024:
            raise HTTPException(413, "each image must be 8 MB or smaller")
        total_attachment_bytes += len(decoded)
        attachments.append({"file_name": file_name, "mime_type": mime_type, "data_url": data_url})
    if total_attachment_bytes > 20 * 1024 * 1024:
        raise HTTPException(413, "attachments must total 20 MB or less")
    if attachments:
        raise HTTPException(400, "image inspection is not enabled in native PropAI Ops yet")
    if not prompt and not attachments:
        raise HTTPException(400, "prompt or an image attachment is required")
    if len(prompt) > 12000:
        raise HTTPException(400, "prompt must be 12,000 characters or fewer")

    tenant = _ops_tenant(user, tenant_id)
    user_id = str(user.get("id") or "")
    session_id = str(body.get("session_id") or "").strip()
    try:
        session = _ops_session(session_id, user_id, tenant) if session_id else None
        if not session:
            created = storage.client.table("operations_agent_sessions").insert({
                "tenant_id": tenant,
                "user_id": user_id,
                "title": prompt[:120] or "New session",
            }).execute().data or []
            if not created:
                raise RuntimeError("session insert returned no row")
            session = created[0]
            session_id = str(session["id"])

        # The database transcript is authoritative. Client-supplied history is
        # retained only as a migration bridge for old localStorage sessions.
        stored_history = storage.client.table("operations_agent_messages").select(
            "role,content"
        ).eq("tenant_id", tenant).eq("session_id", session_id).order("created_at").limit(40).execute().data or []
        raw_history = stored_history or body.get("messages") or []
        if not isinstance(raw_history, list) or len(raw_history) > 20:
            raise HTTPException(400, "messages must contain at most 20 items")
        for item in raw_history:
            if not isinstance(item, dict) or item.get("role") not in {"user", "assistant"}:
                raise HTTPException(400, "messages contain an invalid role")

        storage.client.table("operations_agent_messages").insert({
            "tenant_id": tenant,
            "session_id": session_id,
            "role": "user",
            "content": prompt or f"Attached {len(attachments)} image(s) for inspection.",
        }).execute()
        storage.client.table("operations_agent_sessions").update({
            "title": (session.get("title") or prompt[:120])[:120],
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", session_id).eq("tenant_id", tenant).execute()
    except HTTPException:
        raise
    except Exception as exc:
        raise _operations_storage_error(exc) from exc

    try:
        result = await run_propai_ops(prompt=prompt, history=raw_history, storage=storage, thread_id=session_id)
        content, proposed_action = _extract_db_action(str(result.get("content") or ""))
        approval = None
        if proposed_action:
            try:
                approval = {"token": _make_db_approval_token(tenant, user_id, proposed_action), **proposed_action}
            except RuntimeError:
                content += "\n\nA database change was requested, but the approval service is not configured. No change was made."
        try:
            storage.client.table("operations_agent_messages").insert({
                "tenant_id": tenant,
                "session_id": session_id,
                "role": "assistant",
                "content": content,
                "metadata": {"model": result.get("model") or "native", "usage": result.get("usage") or {}, "steps": 6, "approval": bool(approval)},
            }).execute()
        except Exception:
            # A successful agent response should remain usable even if history
            # persistence is temporarily degraded. The next request will still
            # have the client transcript as a bounded migration bridge.
            logger.exception("Native Ops response succeeded but assistant history could not be saved")
        return {
            "content": content,
            "session_id": session_id,
            "model": result.get("model") or "native",
            "usage": result.get("usage") or {},
            "approval": approval,
        }
    except (httpx.HTTPError, AgentRuntimeError, ValueError, TypeError) as exc:
        logger.warning("Native PropAI Ops failed: %s", exc)
        # Keep the Ops surface usable during provider outages. This is a
        # diagnostic response, not an invented answer and never authorizes a
        # write; the provider error remains server-side in logs.
        return {
            "content": (
                "PropAI Ops could not complete this request because its model "
                "providers are unavailable. No action was taken. Check the Ops "
                "provider configuration and try again."
            ),
            "session_id": session_id,
            "model": "unavailable",
            "usage": {},
            "degraded": True,
        }
    except Exception as exc:
        logger.exception("Unexpected native PropAI Ops failure")
        raise HTTPException(503, "PropAI Operations Agent is temporarily unavailable") from exc


@router.post("/api/admin/ops/database/approve")
async def approve_admin_ops_database_action(
    body: dict[str, Any],
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    """Execute exactly one Ops Agent proposal after an explicit approval click."""
    await _require_super_admin(user)
    token = str(body.get("token") or "").strip()
    if not token:
        raise HTTPException(400, "Approval token is required")
    action = _read_db_approval_token(token, _ops_tenant(user, tenant_id), str(user.get("id") or ""))
    operation = action.get("operation")
    try:
        if operation == "create_row":
            row = await asyncio.to_thread(storage.create_supabase_table_row, action["table"], action["values"])
            return {"ok": True, "operation": operation, "row": storage._admin_safe_row(row)}
        if operation == "update_row":
            row = await asyncio.to_thread(storage.update_supabase_table_row, action["table"], action["row_id"], action["values"])
            return {"ok": True, "operation": operation, "row": storage._admin_safe_row(row)}
        if operation == "delete_row":
            await asyncio.to_thread(storage.delete_supabase_table_row, action["table"], action["row_id"])
            return {"ok": True, "operation": operation, "deleted": action["row_id"]}
        if operation == "run_function":
            result = await asyncio.to_thread(storage.run_supabase_function, action["function_name"], action["arguments"])
            return {"ok": True, "operation": operation, "result": result}
        raise HTTPException(400, "Unsupported database action")
    except HTTPException:
        raise
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        logger.exception("Approved Ops database action failed")
        raise HTTPException(422, "Approved database action could not be completed") from exc
