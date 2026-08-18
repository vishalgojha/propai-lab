"""Small, bounded OpenAI-compatible runtime for PropAI-owned agents."""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from typing import Any

import httpx


class AgentRuntimeError(RuntimeError):
    """A provider or orchestration failure that is safe to surface upstream."""


def _completion_payload(response: httpx.Response) -> dict[str, Any]:
    """Normalize JSON and providers that return SSE despite stream=false."""
    raw = response.text.strip()
    content_type = (response.headers.get("content-type") or "").lower()
    if "text/event-stream" not in content_type and not raw.startswith("data:"):
        payload = response.json()
        if not isinstance(payload, dict):
            raise AgentRuntimeError("agent returned an invalid completion")
        return payload

    content: list[str] = []
    tool_calls: dict[int, dict[str, Any]] = {}
    model = ""
    usage: dict[str, Any] = {}
    for line in raw.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        value = line[5:].strip()
        if not value or value == "[DONE]":
            continue
        try:
            chunk = json.loads(value)
        except json.JSONDecodeError:
            continue
        if not isinstance(chunk, dict):
            continue
        model = str(chunk.get("model") or model)
        if isinstance(chunk.get("usage"), dict):
            usage = chunk["usage"]
        choices = chunk.get("choices") or []
        choice = choices[0] if choices and isinstance(choices[0], dict) else {}
        delta = choice.get("delta") if isinstance(choice.get("delta"), dict) else {}
        # Deliberately ignore reasoning_content. It must never reach the UI/history.
        text = delta.get("content")
        if isinstance(text, str):
            content.append(text)
        for call in delta.get("tool_calls") or []:
            if not isinstance(call, dict):
                continue
            index = int(call.get("index") or 0)
            current = tool_calls.setdefault(index, {"id": "", "type": "function", "function": {"name": "", "arguments": ""}})
            if call.get("id"):
                current["id"] = str(call["id"])
            function = call.get("function") if isinstance(call.get("function"), dict) else {}
            if function.get("name"):
                current["function"]["name"] = str(function["name"])
            if function.get("arguments"):
                current["function"]["arguments"] += str(function["arguments"])

    message: dict[str, Any] = {"role": "assistant", "content": "".join(content).strip()}
    calls = [tool_calls[index] for index in sorted(tool_calls)]
    if calls:
        message["tool_calls"] = calls
    return {"model": model, "usage": usage, "choices": [{"message": message}]}


def _safe_assistant_message(message: dict[str, Any]) -> dict[str, Any]:
    """Keep only fields accepted in the next tool-loop request."""
    safe: dict[str, Any] = {"role": "assistant", "content": str(message.get("content") or "")}
    calls = message.get("tool_calls")
    if isinstance(calls, list) and calls:
        safe["tool_calls"] = calls
    return safe


async def run_agent(
    *,
    base_url: str,
    api_key: str,
    model: str,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    execute_tool: Callable[[dict[str, Any]], Awaitable[dict[str, Any]]],
    max_steps: int = 4,
    timeout_seconds: float = 120.0,
) -> dict[str, Any]:
    """Run a tenant-scoped agent with hard context and tool-loop boundaries."""
    if len(messages) > 32:
        raise AgentRuntimeError("agent context exceeded the allowed message count")
    endpoint = f"{base_url.rstrip('/')}/chat/completions"
    async with httpx.AsyncClient(timeout=httpx.Timeout(timeout_seconds, connect=10.0)) as client:
        for _ in range(max_steps):
            payload: dict[str, Any] = {"model": model, "messages": messages, "stream": False}
            if tools:
                payload["tools"] = tools
                payload["tool_choice"] = "auto"
            response = await client.post(endpoint, json=payload, headers={"Authorization": f"Bearer {api_key}"})
            response.raise_for_status()
            data = _completion_payload(response)
            choice = (data.get("choices") or [{}])[0]
            assistant = choice.get("message") if isinstance(choice, dict) else None
            if not isinstance(assistant, dict):
                raise AgentRuntimeError("agent returned no assistant message")
            safe_assistant = _safe_assistant_message(assistant)
            messages.append(safe_assistant)
            tool_calls = safe_assistant.get("tool_calls") or []
            if not tool_calls:
                content = str(safe_assistant.get("content") or "").strip()
                if not content:
                    raise AgentRuntimeError("agent returned an empty response")
                return {"content": content, "usage": data.get("usage") or {}, "model": data.get("model") or model}
            for call in tool_calls:
                result = await execute_tool(call)
                messages.append({
                    "role": "tool",
                    "tool_call_id": str(call.get("id") or ""),
                    "content": json.dumps(result, default=str)[:12000],
                })
    raise AgentRuntimeError("agent reached the maximum tool steps")
