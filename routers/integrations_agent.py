"""Bounded setup agent for PropAI's Instinct and MCP integrations.

This surface owns only the integration handoff. It can verify PropAI endpoints,
prepare a one-time Instinct credential, and start an auditable browser check.
It does not automate third-party login, CAPTCHA, consent, or outbound sending.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel

from browser_runtime import run_browser_command
from routers.common import _resolve_active_organization_id, require_user, storage, get_tenant_context
from routers.external_agent import _digest, KEY_PREFIX
from storage import AgentAuditLog, AgentBrowserSession, AgentBrowserStep


router = APIRouter(prefix="/api/integrations/agent", tags=["integration_agent"])
logger = logging.getLogger(__name__)
MCP_ENDPOINT = "https://mcp.propai.live/mcp"
API_BASE_URL = "https://api.propai.live"
ALLOWED_TASKS = {"instinct", "claude", "gemini", "verify"}


def _check_url(task: str) -> str:
    return f"{API_BASE_URL}/api/external/v1/health" if task == "instinct" else "https://mcp.propai.live/"


class IntegrationAgentTask(BaseModel):
    task: Literal["instinct", "claude", "gemini", "verify"]
    launch_browser_check: bool = True
    create_instinct_token: bool = False


def _issue_instinct_token(tenant_id: str, user_id: str) -> tuple[str, dict]:
    token = KEY_PREFIX + secrets.token_urlsafe(32)
    payload = {
        "tenant_id": tenant_id,
        "created_by": user_id,
        "label": "Instinct",
        "key_prefix": token[:13],
        "key_hash": _digest(token),
    }
    result = storage.client.table("external_agent_api_keys").insert(payload).execute()
    created = (result.data or [None])[0] if result else None
    if not created:
        lookup = storage.client.table("external_agent_api_keys").select(
            "id,label,key_prefix,scopes,created_at"
        ).eq("key_hash", payload["key_hash"]).limit(1).execute()
        created = (lookup.data or [None])[0] if lookup else None
    if not created:
        raise HTTPException(500, "Could not create Instinct API token")
    return token, created


async def _browser_check(task: str, tenant_id: str, user_id: str) -> dict:
    url = _check_url(task)
    session_id = str(uuid4())
    session = AgentBrowserSession(
        tenant_id=tenant_id,
        # This is a browser-runtime identifier, not an ai_chat_sessions FK.
        # Keep the database session_id nullable for standalone setup tasks.
        session_id=None,
        user_id=user_id,
        browser_provider="agent-browser",
        task_label=f"PropAI {task} integration check",
        start_url=url,
        current_url=url,
        context={"source": "integrations_agent", "integration": task},
    )
    created = await asyncio.to_thread(storage.create_agent_browser_session, session, tenant_id)
    if not created:
        raise HTTPException(500, "Could not create integration browser session")
    result = await asyncio.to_thread(run_browser_command, "agent-browser", "open", session_id, url=url)
    await asyncio.to_thread(
        storage.add_agent_browser_step,
        AgentBrowserStep(
            tenant_id=tenant_id,
            browser_session_id=str(created.get("id") or ""),
            step_index=0,
            action="open",
            target=url,
            url=result.url or url,
            status="ok" if result.status == "ok" else "failed",
            metadata={"integration": task, "provider": result.provider, "error": result.error},
        ),
        tenant_id,
    )
    await asyncio.to_thread(
        storage.update_agent_browser_session,
        str(created.get("id") or ""),
        {
            "status": "running" if result.status == "ok" else "failed",
            "current_url": result.url or url,
            "last_error": result.error or "",
            "context": {"integration": task, "summary": result.summary},
        },
        tenant_id,
    )
    return {
        "browser_session_id": session_id,
        "database_browser_session_id": str(created.get("id") or ""),
        "status": result.status,
        "url": result.url or url,
        "title": result.title,
        "summary": result.summary,
        "error": result.error,
    }


async def _background_browser_check(task: str, tenant_id: str, user_id: str) -> None:
    try:
        await _browser_check(task, tenant_id, user_id)
    except Exception:
        logger.exception("Integration browser check failed for task=%s tenant=%s", task, tenant_id)


@router.get("/status")
async def integration_agent_status(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    tenant_id = await asyncio.to_thread(_resolve_active_organization_id, user, tenant_id)
    keys = storage.client.table("external_agent_api_keys").select(
        "id,label,key_prefix,scopes,expires_at,last_used_at,revoked_at,created_at"
    ).eq("tenant_id", tenant_id).order("created_at", desc=True).execute().data or []
    from browser_runtime import _RUNTIME

    browser_health = await asyncio.to_thread(_RUNTIME.health_check)
    return {
        "mcp_endpoint": MCP_ENDPOINT,
        "api_base_url": API_BASE_URL,
        "instinct": {"configured": any(not row.get("revoked_at") for row in keys), "keys": keys},
        "mcp": {"configured": True, "oauth": True},
        "browser": browser_health,
        "supported_tasks": sorted(ALLOWED_TASKS),
    }


@router.post("/tasks")
async def run_integration_agent_task(
    body: IntegrationAgentTask,
    background_tasks: BackgroundTasks,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    tenant_id = await asyncio.to_thread(_resolve_active_organization_id, user, tenant_id)
    user_id = str(user.get("id") or "")
    result: dict = {
        "task": body.task,
        "status": "ready",
        "mcp_endpoint": MCP_ENDPOINT,
        "api_base_url": API_BASE_URL,
        "handoff": "The agent prepared the PropAI side. Third-party login or consent may still be required.",
    }
    if body.task == "instinct" and body.create_instinct_token:
        token, key = await asyncio.to_thread(_issue_instinct_token, tenant_id, user_id)
        result.update({
            "status": "token_created",
            "instinct_token": token,
            "token_metadata": key,
            "setup": {
                "base_url": API_BASE_URL,
                "endpoint": f"{API_BASE_URL}/api/external/v1",
                "health": "/api/external/v1/health",
                "auth_header": "X-API-Key",
                "vault_secret_name": "PROPAI_API_KEY",
                "vault_secret_type": "password",
                "raw_scope_default": "groups",
            },
        })
    if body.launch_browser_check:
        background_tasks.add_task(_background_browser_check, body.task, tenant_id, user_id)
        result["browser"] = {
            "status": "queued",
            "url": _check_url(body.task),
            "message": "The endpoint check is running in the background and is recorded in the browser session trace.",
        }
    await asyncio.to_thread(
        storage.log_agent_audit_event,
        AgentAuditLog(
            tenant_id=tenant_id,
            user_id=user_id,
            browser_session_id=str((result.get("browser") or {}).get("database_browser_session_id") or "") or None,
            event_type="integration_agent_task",
            entity_type="integration",
            entity_id=body.task,
            metadata={"browser_check": bool(body.launch_browser_check), "token_created": "instinct_token" in result},
        ),
        tenant_id,
    )
    return result
