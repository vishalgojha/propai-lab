"""Super-admin-only bridge to the isolated Hermes operations agent.

Hermes is deliberately kept outside the customer chat loop.  This router
owns the PropAI auth boundary and forwards only server-side credentials to a
Hermes OpenAI-compatible API server when explicitly configured.
"""

import asyncio
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

router = APIRouter(tags=["admin-hermes"])
logger = logging.getLogger(__name__)

_PROPAI_SYSTEM_PROMPT = """You are the PropAI Operations Agent, an internal coding and operations agent for the Super Admin.

Your job is to help operate and improve PropAI, a real-estate intelligence platform. Stay PropAI-scoped: reason about this repository's FastAPI backend, Next.js dashboards, WhatsApp/WhatsMeow ingestion, deterministic extraction, building and listing enrichment, Supabase/Postgres, Coolify deployments, provider costs, and data quality. Do not answer as a generic personal assistant unless the request is clearly unrelated; redirect unrelated requests back to PropAI operations.

For property inventory questions, use PropAI's own parsed market/search systems and repository code; do not launch open-ended web searches unless the Super Admin explicitly asks for external research. If the requested data is not mounted or reachable, say that immediately instead of repeatedly searching.

When investigating, state the evidence and the exact files, services, tables, or deployment variables involved. Follow PropAI's rules: never fabricate inventory or counters, never expose phone numbers, never auto-merge listings, preserve message freshness/source traceability, and do not replace deterministic extraction with an LLM without explicit approval.

You have the full PropAI-enabled coding and operations toolset available in this environment. Use it whenever relevant: inspect and edit code, investigate schemas, prepare migrations, run tests, research documentation, and coordinate bounded tasks. Treat production database writes, migrations, deployments, secret changes, destructive commands, and customer-impacting behavior as approval-gated. For those actions, prepare the change and explain the exact approval needed; do not silently apply it."""


def _hermes_config() -> tuple[str, str, str]:
    base_url = os.getenv("HERMES_API_URL", "").strip().rstrip("/")
    api_key = os.getenv("HERMES_API_KEY", "").strip()
    model = os.getenv("HERMES_AGENT_MODEL", "hermes-admin").strip() or "hermes-admin"
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

    The operations agent must not depend on Hermes being available to answer
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
        logger.exception("Hermes super-admin check failed")
        raise HTTPException(503, "PropAI admin authorization is temporarily unavailable") from exc
    if not allowed:
        raise HTTPException(403, "Super admin access required")


def _ops_tenant(user: dict, tenant_id: str | None) -> str:
    return str(_resolve_active_organization_id(user, tenant_id) or "").strip()


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


@router.get("/api/admin/hermes/sessions")
async def list_admin_hermes_sessions(
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


@router.post("/api/admin/hermes/sessions")
async def create_admin_hermes_session(
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


@router.get("/api/admin/hermes/sessions/{session_id}/messages")
async def list_admin_hermes_messages(
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


@router.get("/api/admin/hermes/status")
async def admin_hermes_status(user: dict = Depends(require_user)):
    await _require_super_admin(user)
    base_url, api_key, model = _hermes_config()
    reachable = False
    health_error = None
    if base_url and api_key:
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(3.0, connect=1.0)) as client:
                response = await client.get(
                    f"{base_url.removesuffix('/v1')}/health",
                    headers={"Authorization": f"Bearer {api_key}"},
                )
            reachable = response.is_success
            if not reachable:
                health_error = f"upstream_http_{response.status_code}"
        except httpx.HTTPError as exc:
            health_error = exc.__class__.__name__
    return {
        "configured": bool(base_url and api_key),
        "reachable": reachable,
        "health_error": health_error,
        "api_url": base_url,
        "model": model,
        "approval_required": True,
        "scope": "super_admin_only",
    }


@router.post("/api/admin/hermes/chat")
async def admin_hermes_chat(
    body: dict[str, Any],
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    """Forward one bounded admin prompt to Hermes.

    The Hermes service must be separately isolated and configured with its own
    workspace/MCP allowlist.  This endpoint never accepts an arbitrary target
    URL and never exposes the Hermes API key to the browser.
    """
    await _require_super_admin(user)
    base_url, api_key, default_model = _hermes_config()
    if not base_url or not api_key:
        raise HTTPException(503, "PropAI Operations Agent is not configured")

    prompt = str(body.get("prompt") or "").strip()
    if not prompt:
        raise HTTPException(400, "prompt is required")
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
        messages: list[dict[str, str]] = [{"role": "system", "content": _PROPAI_SYSTEM_PROMPT}]
        history_budget = 24000
        for item in raw_history:
            if not isinstance(item, dict) or item.get("role") not in {"user", "assistant"}:
                raise HTTPException(400, "messages contain an invalid role")
            content = str(item.get("content") or "").strip()
            if content and history_budget > 0:
                bounded = content[:history_budget]
                messages.append({"role": str(item["role"]), "content": bounded})
                history_budget -= len(bounded)
        repo_evidence = _local_repo_evidence(prompt)
        if repo_evidence:
            messages.append({
                "role": "system",
                "content": (
                    "Deterministic local repository evidence follows. Treat it as "
                    "the source of truth, cite the relevant paths, and do not "
                    "claim runtime/database facts that are not present here.\n\n"
                    + repo_evidence
                )[:18000],
            })
        messages.append({"role": "user", "content": prompt})

        storage.client.table("operations_agent_messages").insert({
            "tenant_id": tenant,
            "session_id": session_id,
            "role": "user",
            "content": prompt,
        }).execute()
        storage.client.table("operations_agent_sessions").update({
            "title": (session.get("title") or prompt[:120])[:120],
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", session_id).eq("tenant_id", tenant).execute()
    except HTTPException:
        raise
    except Exception as exc:
        raise _operations_storage_error(exc) from exc

    payload = {
        "model": str(body.get("model") or default_model)[:120],
        "messages": messages,
        "stream": False,
    }
    endpoint = f"{base_url}/chat/completions"
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=10.0)) as client:
            response = await client.post(
                endpoint,
                json=payload,
                headers={"Authorization": f"Bearer {api_key}"},
            )
        response.raise_for_status()
        content, data = _extract_completion(response)
        storage.client.table("operations_agent_messages").insert({
            "tenant_id": tenant,
            "session_id": session_id,
            "role": "assistant",
            "content": content,
            "metadata": {"model": data.get("model") or payload["model"], "usage": data.get("usage") or {}},
        }).execute()
        return {
            "content": content,
            "session_id": session_id,
            "model": data.get("model") or payload["model"],
            "usage": data.get("usage") or {},
        }
    except httpx.HTTPStatusError as exc:
        raise HTTPException(502, "PropAI Operations Agent returned an upstream error") from exc
    except (httpx.HTTPError, ValueError, TypeError, AttributeError, KeyError, IndexError) as exc:
        logger.warning("Hermes response could not be used: %s", exc)
        if repo_evidence:
            fallback_content = (
                "Hermes is unavailable, so I used the local PropAI checkout "
                "for this repository-grounded question.\n\n" + repo_evidence
            )
            storage.client.table("operations_agent_messages").insert({
                "tenant_id": tenant, "session_id": session_id,
                "role": "assistant", "content": fallback_content,
                "metadata": {"model": "local-repository-evidence"},
            }).execute()
            return {
                "content": fallback_content,
                "session_id": session_id,
                "model": "local-repository-evidence",
                "usage": {},
            }
        raise HTTPException(503, "PropAI Operations Agent is temporarily unavailable") from exc
    except Exception:
        logger.exception("Unexpected Hermes operations-agent failure")
        if repo_evidence:
            fallback_content = (
                "Hermes encountered an internal error, so I used the local "
                "PropAI checkout for this repository-grounded question.\n\n"
                + repo_evidence
            )
            storage.client.table("operations_agent_messages").insert({
                "tenant_id": tenant, "session_id": session_id,
                "role": "assistant", "content": fallback_content,
                "metadata": {"model": "local-repository-evidence"},
            }).execute()
            return {
                "content": fallback_content,
                "session_id": session_id,
                "model": "local-repository-evidence",
                "usage": {},
            }
        raise HTTPException(503, "PropAI Operations Agent is temporarily unavailable")
