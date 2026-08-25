"""Scoped operations bridge used by the internal OpenClaw agent.

OpenClaw must not receive Supabase service keys or a broad Coolify token.  It
calls this small allowlist instead; credentials remain in the API container.
Mutating operations require an explicit confirmation field and an allowlisted
Coolify resource UUID.
"""

import asyncio
import hmac
import os
from typing import Any

import httpx
from fastapi import APIRouter, Header, HTTPException

from routers.common import storage

router = APIRouter(prefix="/api/internal/openclaw", tags=["openclaw-ops"])


def _authorize(token: str | None) -> None:
    expected = os.getenv("OPENCLAW_OPS_TOKEN", "").strip()
    if not expected or not token or not hmac.compare_digest(token.strip(), expected):
        raise HTTPException(401, "OpenClaw operations authentication required")


def _coolify_config() -> tuple[str, str]:
    return (
        os.getenv("COOLIFY_API_URL", "").strip().rstrip("/"),
        os.getenv("COOLIFY_API_TOKEN", "").strip(),
    )


def _allowed_coolify_scope() -> tuple[str, str]:
    return (
        os.getenv("COOLIFY_ALLOWED_PROJECT_UUID", "").strip(),
        os.getenv("COOLIFY_ALLOWED_ENVIRONMENT_UUID", "").strip(),
    )


async def _coolify_get(path: str) -> Any:
    base, token = _coolify_config()
    if not base or not token:
        raise HTTPException(503, "Coolify operations are not configured")
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get(f"{base}/api/v1/{path.lstrip('/')}", headers={"Authorization": f"Bearer {token}"})
        if response.status_code >= 400:
            raise HTTPException(502, f"Coolify returned HTTP {response.status_code}")
        return response.json()
    except httpx.HTTPError as exc:
        raise HTTPException(503, "Coolify is temporarily unreachable") from exc


@router.post("/ops")
async def openclaw_operation(body: dict[str, Any], x_openclaw_ops_token: str | None = Header(default=None)):
    """Execute one named, bounded operation; never accepts arbitrary SQL/URLs."""
    _authorize(x_openclaw_ops_token)
    action = str(body.get("action") or "").strip().lower()

    if action == "broker_counts":
        return {"action": action, "data": await asyncio.to_thread(storage.get_stats)}
    if action == "embedding_status":
        return {"action": action, "data": await asyncio.to_thread(storage.get_semantic_embedding_status)}
    if action == "extraction_repair_status":
        return {"action": action, "data": await asyncio.to_thread(storage.get_extraction_repair_status)}
    if action == "coolify_servers":
        return {"action": action, "data": await _coolify_get("servers")}
    if action == "coolify_deployments":
        return {"action": action, "data": await _coolify_get("deployments")}
    if action == "coolify_project":
        project_uuid, _ = _allowed_coolify_scope()
        if not project_uuid:
            raise HTTPException(503, "COOLIFY_ALLOWED_PROJECT_UUID is not configured")
        return {"action": action, "project_uuid": project_uuid, "data": await _coolify_get(f"projects/{project_uuid}/environments")}

    if action == "coolify_deploy":
        if body.get("confirm") is not True:
            raise HTTPException(409, "Deployment requires confirm=true after presenting the target and commit")
        base, token = _coolify_config()
        resource_uuid = str(body.get("resource_uuid") or "").strip()
        project_uuid, environment_uuid = _allowed_coolify_scope()
        if not base or not token:
            raise HTTPException(503, "Coolify operations are not configured")
        if not project_uuid:
            raise HTTPException(403, "Project-level Coolify scope is not configured")
        requested_project = str(body.get("project_uuid") or project_uuid).strip()
        requested_environment = str(body.get("environment_uuid") or "").strip()
        if requested_project != project_uuid:
            raise HTTPException(403, "Project UUID is outside the configured Coolify scope")
        if environment_uuid and requested_environment and requested_environment != environment_uuid:
            raise HTTPException(403, "Environment UUID is outside the configured Coolify scope")
        if not resource_uuid:
            raise HTTPException(400, "resource_uuid is required for a Coolify deploy")
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                response = await client.get(
                    f"{base}/api/v1/deploy", params={"uuid": resource_uuid},
                    headers={"Authorization": f"Bearer {token}"},
                )
            if response.status_code >= 400:
                raise HTTPException(502, f"Coolify returned HTTP {response.status_code}")
            return {"action": action, "resource_uuid": resource_uuid, "data": response.json()}
        except httpx.HTTPError as exc:
            raise HTTPException(503, "Coolify is temporarily unreachable") from exc

    raise HTTPException(400, "Unsupported OpenClaw operation")
