"""Super-admin-only bridge to the isolated Hermes operations agent.

Hermes is deliberately kept outside the customer chat loop.  This router
owns the PropAI auth boundary and forwards only server-side credentials to a
Hermes OpenAI-compatible API server when explicitly configured.
"""

import asyncio
import os
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException

from routers.common import require_user, storage

router = APIRouter(tags=["admin-hermes"])

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


async def _require_super_admin(user: dict) -> None:
    if not await asyncio.to_thread(storage.is_super_admin, user["id"]):
        raise HTTPException(403, "Super admin access required")


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
async def admin_hermes_chat(body: dict[str, Any], user: dict = Depends(require_user)):
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

    raw_history = body.get("messages") or []
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
    messages.append({"role": "user", "content": prompt})

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
        data = response.json()
        if not isinstance(data, dict):
            raise ValueError("PropAI Operations Agent returned an invalid response")
        choice = (data.get("choices") or [{}])[0]
        if not isinstance(choice, dict):
            raise ValueError("PropAI Operations Agent returned an invalid choice")
        message = choice.get("message") or {}
        if not isinstance(message, dict):
            raise ValueError("PropAI Operations Agent returned an invalid message")
        content = message.get("content")
        if isinstance(content, list):
            content = "\n".join(
                str(part.get("text"))
                for part in content
                if isinstance(part, dict) and isinstance(part.get("text"), str)
            ).strip()
        if not isinstance(content, str):
            raise ValueError("PropAI Operations Agent returned no text content")
        return {
            "content": content,
            "model": data.get("model") or payload["model"],
            "usage": data.get("usage") or {},
        }
    except httpx.HTTPStatusError as exc:
        raise HTTPException(502, "PropAI Operations Agent returned an upstream error") from exc
    except (httpx.HTTPError, ValueError, TypeError, AttributeError, KeyError) as exc:
        raise HTTPException(503, "PropAI Operations Agent is temporarily unavailable") from exc
