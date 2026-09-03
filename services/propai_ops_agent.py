"""PropAI-owned multi-step operations agent.

The Ops surface deliberately owns its orchestration and tool boundary.  The
model may choose among a small set of read-only diagnostics, but it cannot
execute arbitrary SQL, shell commands, URLs, or production mutations.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
from pathlib import Path
from typing import Any

import httpx

from services.propai_agent_runtime import AgentRuntimeError
from services.propai_ops_graph import run_ops_graph


OPS_TOOLS = [
    {"type": "function", "function": {"name": "repository_search", "description": "Search curated PropAI source files for a specific operational term. Use for code-grounded diagnosis.", "parameters": {"type": "object", "properties": {"term": {"type": "string"}}, "required": ["term"], "additionalProperties": False}}},
    {"type": "function", "function": {"name": "pipeline_status", "description": "Read live PropAI pipeline counts and worker heartbeats from Supabase.", "parameters": {"type": "object", "properties": {}, "additionalProperties": False}}},
    {"type": "function", "function": {"name": "database_catalog", "description": "Read the live bounded Supabase table and function catalog. No SQL or writes.", "parameters": {"type": "object", "properties": {}, "additionalProperties": False}}},
    {"type": "function", "function": {"name": "database_table", "description": "Read up to 50 sanitized rows from one live Supabase table for diagnosis. No writes.", "parameters": {"type": "object", "properties": {"table": {"type": "string"}}, "required": ["table"], "additionalProperties": False}}},
    {"type": "function", "function": {"name": "coolify_status", "description": "Read the configured Coolify deployment resources. Never deploy or mutate.", "parameters": {"type": "object", "properties": {}, "additionalProperties": False}}},
]

_SYSTEM = """You are PropAI Ops, a reliable internal operations agent.
Investigate in bounded steps and state evidence, timestamps, and exact files or
services. Use tools when live evidence is needed; never invent runtime facts.
You are read-only in this version. Do not request credentials, arbitrary URLs,
SQL, shell commands, deployments, restarts, deletes, migrations, or WhatsApp
actions. If a mutation is needed, explain the exact proposed target and stop.
Keep answers concise and actionable. Never expose phone numbers or secrets.

Database access policy: read-only inspection is allowed through the bounded
diagnostic tools. You may propose a database action, but you must never claim
that it ran and you must not execute it. For an explicit request to create,
update, delete a row, or run a catalogued function, append exactly one marker
after your explanation in this format:
[PROPAI_DB_ACTION]{"operation":"update_row","table":"table_name","row_id":"123","values":{"field":"value"},"summary":"Exact change and reason"}[/PROPAI_DB_ACTION]
Allowed operations are create_row, update_row, delete_row, and run_function.
create_row uses table and values; update_row uses table, row_id, and values;
delete_row uses table and row_id; run_function uses function_name and
arguments. Keep values/arguments JSON objects, never include secrets or phone
numbers, and never propose broad deletes, SQL, migrations, triggers, or DDL.
The server will show the proposal for explicit Super Admin approval."""


def _provider_candidates() -> list[dict[str, str]]:
    candidates: list[dict[str, str]] = []
    key = os.getenv("OPENROUTER_API_KEY", "").strip()
    # The generic OpenRouter free router is not a reliable tool-calling
    # provider. Use it for Ops only when an explicit Ops/model choice exists.
    explicit_model = os.getenv("OPENROUTER_OPS_MODEL", "").strip() or os.getenv("OPENROUTER_MODEL", "").strip()
    if key and explicit_model:
        candidates.append({
            "provider": "openrouter",
            "base_url": os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1").strip().rstrip("/"),
            "api_key": key,
            "model": explicit_model,
        })
    try:
        from llm import get_configured_providers
        candidates.extend(get_configured_providers())
    except Exception:
        pass
    unique: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for item in candidates:
        base = str(item.get("base_url") or "").strip().rstrip("/")
        api_key = str(item.get("api_key") or "").strip()
        model = str(item.get("model") or "").strip()
        key_tuple = (base, model)
        if base and api_key and model and key_tuple not in seen:
            seen.add(key_tuple)
            unique.append({"base_url": base, "api_key": api_key, "model": model, "provider": str(item.get("provider") or item.get("name") or "unknown")})
    return unique


def _is_retryable_provider_error(exc: BaseException) -> bool:
    """Retry transient transport/provider failures, not bad credentials/models."""
    response = getattr(exc, "response", None)
    status_code = getattr(response, "status_code", None)
    return status_code is None or status_code in {408, 425, 429, 500, 502, 503, 504}


def _repo_search(term: str) -> dict[str, Any]:
    term = str(term or "").strip()[:120]
    if not term:
        return {"status": "error", "error": "term is required"}
    root = Path(__file__).resolve().parents[1]
    files = ["app.py", "routers", "services", "storage", "docs/DATA_QUALITY.md", "architecture.md", "deploy/coolify"]
    result = subprocess.run(["rg", "-n", "-S", "--max-count", "20", "--fixed-strings", term, *files], cwd=root, capture_output=True, text=True, timeout=4, check=False)
    return {"status": "ok", "term": term, "matches": result.stdout.splitlines()[:20]}


async def _coolify_status() -> dict[str, Any]:
    base = os.getenv("COOLIFY_API_URL", "").strip().rstrip("/")
    token = os.getenv("COOLIFY_API_TOKEN", "").strip()
    if not base or not token:
        return {"status": "unavailable", "reason": "Coolify read access is not configured on the API"}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=3.0)) as client:
            response = await client.get(f"{base}/api/v1/applications", headers={"Authorization": f"Bearer {token}"})
        response.raise_for_status()
        resources = response.json() if isinstance(response.json(), list) else []
        return {"status": "ok", "resources": [{"uuid": r.get("uuid"), "name": r.get("name"), "status": r.get("status"), "fqdn": r.get("fqdn")} for r in resources if isinstance(r, dict)]}
    except (httpx.HTTPError, ValueError, TypeError) as exc:
        return {"status": "error", "error": f"Coolify read failed: {str(exc)[:300]}"}


async def _execute_tool(call: dict[str, Any], storage: Any) -> dict[str, Any]:
    function = call.get("function") if isinstance(call, dict) else {}
    name = str(function.get("name") or "")
    try:
        args = json.loads(function.get("arguments") or "{}")
    except json.JSONDecodeError:
        return {"status": "error", "error": "tool arguments were invalid JSON"}
    if name == "repository_search":
        return await asyncio.to_thread(_repo_search, args.get("term"))
    if name == "pipeline_status":
        try:
            stats = await asyncio.to_thread(storage.get_stats)
            embedding = await asyncio.to_thread(storage.get_semantic_embedding_status)
            extraction = await asyncio.to_thread(storage.get_extraction_repair_status)
            heartbeats = await asyncio.to_thread(lambda: storage.client.table("worker_heartbeats").select("worker_name,status,heartbeat_at,runtime_version,last_error").order("heartbeat_at", desc=True).limit(30).execute().data or [])
            return {"status": "ok", "stats": stats, "embedding": embedding, "extraction": extraction, "heartbeats": heartbeats}
        except Exception as exc:
            return {"status": "error", "error": f"pipeline status failed: {str(exc)[:400]}"}
    if name == "database_catalog":
        try:
            snapshot = await asyncio.to_thread(storage.get_supabase_observability)
            return {"status": "ok", "tables": snapshot.get("tables") or [], "functions": snapshot.get("functions") or []}
        except Exception as exc:
            return {"status": "error", "error": f"database catalog failed: {str(exc)[:400]}"}
    if name == "database_table":
        try:
            table = str(args.get("table") or "").strip()
            snapshot = await asyncio.to_thread(storage.get_supabase_table_rows, table, 50, 0)
            return {"status": "ok", "table_name": snapshot.get("table_name"), "columns": snapshot.get("columns") or [], "rows": snapshot.get("rows") or [], "total": snapshot.get("total", 0)}
        except Exception as exc:
            return {"status": "error", "error": f"database table read failed: {str(exc)[:400]}"}
    if name == "coolify_status":
        return await _coolify_status()
    return {"status": "error", "error": f"unknown Ops tool: {name}"}


async def run_propai_ops(*, prompt: str, history: list[dict[str, Any]], storage: Any, thread_id: str | None = None) -> dict[str, Any]:
    bounded_history = [{"role": str(item.get("role")), "content": str(item.get("content") or "")[:4000]} for item in history[-20:] if isinstance(item, dict) and item.get("role") in {"user", "assistant"}]
    messages = [{"role": "system", "content": _SYSTEM}, *bounded_history, {"role": "user", "content": str(prompt or "").strip()[:12000]}]
    errors: list[str] = []
    providers = _provider_candidates()
    for provider in providers:
        for attempt in range(2):
            try:
                return await run_ops_graph(provider=provider, messages=messages.copy(), tools=OPS_TOOLS, execute_tool=lambda call: _execute_tool(call, storage), thread_id=thread_id)
            except (httpx.HTTPError, AgentRuntimeError, ValueError, TypeError) as exc:
                errors.append(f"{provider['provider']}#{attempt + 1}: {str(exc)[:240]}")
                if attempt == 0 and _is_retryable_provider_error(exc):
                    await asyncio.sleep(0.4)
                else:
                    break
    if not providers:
        raise AgentRuntimeError("no Ops model provider is configured")
    raise AgentRuntimeError("all Ops model providers failed: " + "; ".join(errors))


def native_ops_status() -> dict[str, Any]:
    providers = _provider_candidates()
    redis_configured = bool(os.getenv("LANGGRAPH_REDIS_URL", "").strip())
    redis_required = os.getenv("LANGGRAPH_REDIS_REQUIRED", "false").strip().lower() in {"1", "true", "yes", "on"}
    redis_fallback = os.getenv("LANGGRAPH_REDIS_FALLBACK", "true").strip().lower() in {"1", "true", "yes", "on"}
    return {
        "configured": bool(providers) and (redis_configured or not redis_required),
        "provider_count": len(providers),
        "providers": [p["provider"] for p in providers],
        "mode": "langgraph_bounded_read_only",
        "max_steps": 6,
        "approval_required": True,
        "scope": "super_admin_only",
        "checkpointing": "redis_with_stateless_fallback" if redis_configured and redis_fallback else ("redis" if redis_configured else ("required_unconfigured" if redis_required else "disabled")),
        "checkpoint_fallback": redis_fallback,
    }
