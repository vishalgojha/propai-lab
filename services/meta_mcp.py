"""Small remote MCP client for the Meta Ads connector.

The API owns this connection.  The browser never receives the MCP bearer
token.  Only tools that are explicitly read-only are exposed to the ads agent;
write tools stay behind PropAI's approval executor.
"""

from __future__ import annotations

import os
import uuid
import json
from typing import Any

import httpx


def enabled() -> bool:
    return os.getenv("META_ADS_MCP_ENABLED", "false").lower() == "true"


def configured(access_token: str = "") -> bool:
    return enabled() and bool(access_token.strip())


def endpoint() -> str:
    return os.getenv("META_ADS_MCP_URL", "https://mcp.facebook.com/ads").strip().rstrip("/")


def _is_read_only(tool: dict[str, Any]) -> bool:
    annotations = tool.get("annotations") if isinstance(tool.get("annotations"), dict) else {}
    if annotations.get("readOnlyHint") is True or annotations.get("destructiveHint") is False:
        return True
    name = str(tool.get("name") or "").lower()
    description = str(tool.get("description") or "").lower()
    write_words = ("create", "update", "edit", "delete", "pause", "resume", "activate", "budget", "upload", "publish")
    return not any(word in f"{name} {description}" for word in write_words)


async def list_read_tools(access_token: str) -> list[dict[str, Any]]:
    if not configured(access_token):
        return []
    async with httpx.AsyncClient(timeout=httpx.Timeout(45.0, connect=10.0)) as client:
        session_id, _ = await _initialize(client, access_token)
        response = await _rpc(client, session_id, "tools/list", {}, access_token)
    tools = response.get("tools") if isinstance(response, dict) else []
    return [tool for tool in tools if isinstance(tool, dict) and _is_read_only(tool)]


async def call_tool(name: str, arguments: dict[str, Any], access_token: str) -> dict[str, Any]:
    if not configured(access_token):
        raise RuntimeError("Meta Ads MCP is not configured")
    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0)) as client:
        session_id, _ = await _initialize(client, access_token)
        result = await _rpc(client, session_id, "tools/call", {"name": name, "arguments": arguments}, access_token)
    return result if isinstance(result, dict) else {"content": result}


async def health(access_token: str = "") -> dict[str, Any]:
    if not enabled():
        return {"enabled": False, "configured": False, "status": "disabled"}
    if not configured(access_token):
        return {"enabled": True, "configured": False, "status": "needs_oauth", "message": "Connect Meta to authorize this workspace."}
    try:
        tools = await list_read_tools(access_token)
        return {"enabled": True, "configured": True, "status": "connected", "tool_count": len(tools), "endpoint": endpoint()}
    except Exception as exc:
        # Keep this safe for the browser: the exception deliberately never
        # contains the bearer token, but does include the remote status and a
        # short response hint so deployment issues are diagnosable.
        return {"enabled": True, "configured": True, "status": "unavailable", "message": str(exc), "endpoint": endpoint()}


async def _initialize(client: httpx.AsyncClient, access_token: str) -> tuple[str, dict[str, Any]]:
    response = await _rpc(client, None, "initialize", {
        "protocolVersion": os.getenv("META_ADS_MCP_PROTOCOL_VERSION", "2025-06-18"),
        "capabilities": {},
        "clientInfo": {"name": "propai-ads-agent", "version": "1.0"},
    }, access_token)
    # The current Meta endpoint uses a short-lived MCP session.  A fresh
    # session is created per request so tenant credentials are never cached in
    # process-global state.
    session_id = str(response.get("_session_id") or "")
    return session_id, response


async def _rpc(client: httpx.AsyncClient, session_id: str | None, method: str, params: dict[str, Any], access_token: str) -> dict[str, Any]:
    protocol_version = os.getenv("META_ADS_MCP_PROTOCOL_VERSION", "2025-06-18").strip()
    headers = {
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
        "Authorization": f"Bearer {access_token.strip()}",
        "MCP-Protocol-Version": protocol_version,
    }
    if session_id:
        headers["MCP-Session-Id"] = session_id
    response = await client.post(endpoint(), headers=headers, json={
        "jsonrpc": "2.0", "id": uuid.uuid4().hex, "method": method, "params": params,
    })
    if response.is_error:
        hint = " ".join(response.text.split())[:500]
        raise RuntimeError(f"Meta Ads MCP {method} returned HTTP {response.status_code} ({response.headers.get('content-type', 'unknown')}): {hint}")
    data = _decode_response(response)
    if isinstance(data, dict) and data.get("error"):
        raise RuntimeError(str(data["error"]))
    result = data.get("result") if isinstance(data, dict) else data
    if isinstance(result, dict):
        session_from_header = response.headers.get("mcp-session-id")
        if session_from_header:
            result["_session_id"] = session_from_header
    return result if isinstance(result, dict) else {"value": result}


def _decode_response(response: httpx.Response) -> Any:
    """Decode an MCP JSON response or an SSE response containing JSON-RPC."""
    content_type = response.headers.get("content-type", "").lower()
    if "text/event-stream" not in content_type:
        try:
            return response.json()
        except ValueError as exc:
            hint = " ".join(response.text.split())[:500]
            raise RuntimeError(f"Meta Ads MCP returned non-JSON ({content_type or 'unknown'}): {hint}") from exc

    events: list[str] = []
    for line in response.text.splitlines():
        if line.startswith("data:"):
            value = line[5:].strip()
            if value and value != "[DONE]":
                events.append(value)
    if not events:
        raise RuntimeError("Meta Ads MCP returned an empty SSE response")
    for value in reversed(events):
        try:
            return json.loads(value)
        except ValueError:
            continue
    raise RuntimeError("Meta Ads MCP returned SSE without a JSON-RPC payload")


def to_openai_tools(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result = []
    for tool in tools:
        name = str(tool.get("name") or "").strip()
        if not name:
            continue
        result.append({
            "type": "function",
            "function": {
                "name": f"meta_mcp__{name}",
                "description": str(tool.get("description") or "Read Meta Ads data via PropAI.")[:1000],
                "parameters": tool.get("inputSchema") if isinstance(tool.get("inputSchema"), dict) else {"type": "object", "properties": {}},
            },
        })
    return result


def tool_name_from_openai(name: str) -> str:
    return name.removeprefix("meta_mcp__")
