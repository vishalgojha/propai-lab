"""LangGraph orchestration for the bounded, read-only Ops agent."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any, Literal, TypedDict

from langgraph.graph import END, START, StateGraph

from services.propai_agent_runtime import AgentRuntimeError, run_agent_step


MAX_STEPS = 6
# A diagnostic tool must never be able to stall the whole Ops run. Supabase
# observability RPCs can hit their statement timeout under load; without a
# bound the graph waits forever and the operator sees a blank, unanswered
# chat. Bound every tool call and hand the model a structured error instead.
TOOL_TIMEOUT_SECONDS = 20.0
# Even with bounded tools, MAX_STEPS model calls plus sequential tools can
# outlast the operator's patience (and the chat UI's 10 minute poll window).
# Cap the whole run below that window so it always ends with a clear answer.
RUN_TIMEOUT_SECONDS = 540.0
_logger = logging.getLogger(__name__)


class OpsGraphState(TypedDict, total=False):
    messages: list[dict[str, Any]]
    steps: int
    usage: dict[str, Any]
    response_model: str
    final: str
    error: str


async def _execute_tool_bounded(execute_tool: Any, call: dict[str, Any], timeout: float = TOOL_TIMEOUT_SECONDS) -> dict[str, Any]:
    """Run one Ops tool under a hard timeout.

    Returns a structured error result when the tool overruns so the model can
    continue instead of the graph hanging until the operator gives up.
    """
    try:
        return await asyncio.wait_for(execute_tool(call), timeout=timeout)
    except asyncio.TimeoutError:
        name = ""
        function = call.get("function") if isinstance(call, dict) else None
        if isinstance(function, dict):
            name = str(function.get("name") or "")
        _logger.warning("Ops tool %r exceeded %.0fs; returning timeout result", name, timeout)
        return {"status": "error", "error": f"tool {name or 'call'} timed out after {timeout:.0f}s"}
    except Exception as exc:
        return {"status": "error", "error": f"tool failed: {str(exc)[:300]}"}


def _build_graph(*, provider: dict[str, str], tools: list[dict[str, Any]], execute_tool: Any, checkpointer: Any = None):
    async def model_node(state: OpsGraphState) -> dict[str, Any]:
        result = await run_agent_step(
            base_url=provider["base_url"],
            api_key=provider["api_key"],
            model=provider["model"],
            messages=state["messages"],
            tools=tools,
            timeout_seconds=45.0,
        )
        message = result["message"]
        next_steps = int(state.get("steps", 0)) + 1
        tool_calls = message.get("tool_calls") or []
        updated_messages = [*state["messages"], message]
        if not tool_calls:
            content = str(message.get("content") or "").strip()
            if not content:
                raise AgentRuntimeError("agent returned an empty response")
            return {"messages": updated_messages, "steps": next_steps, "usage": result["usage"], "response_model": result["model"], "final": content}
        if next_steps >= MAX_STEPS:
            return {"messages": updated_messages, "steps": next_steps, "usage": result["usage"], "response_model": result["model"], "error": "agent reached the maximum tool steps"}
        return {"messages": updated_messages, "steps": next_steps, "usage": result["usage"], "response_model": result["model"]}

    async def execute_tools(calls: list[dict[str, Any]]) -> list[dict[str, Any]]:
        messages: list[dict[str, Any]] = []
        for call in calls:
            result = await _execute_tool_bounded(execute_tool, call)
            messages.append({
                "role": "tool",
                "tool_call_id": str(call.get("id") or ""),
                "content": json.dumps(result, default=str)[:12000],
            })
        return messages

    async def tool_node(state: OpsGraphState) -> dict[str, Any]:
        calls = state["messages"][-1].get("tool_calls") or []
        messages = await execute_tools(calls)
        return {"messages": [*state["messages"], *messages]}

    def route_after_model(state: OpsGraphState) -> Literal["tools", "end"]:
        if state.get("final") or state.get("error"):
            return "end"
        return "tools" if state["messages"][-1].get("tool_calls") else "end"

    builder = StateGraph(OpsGraphState)
    builder.add_node("model", model_node)
    builder.add_node("tools", tool_node)
    def finish_node(state: OpsGraphState) -> dict[str, Any]:
        return {}

    builder.add_node("finish", finish_node)
    builder.add_edge(START, "model")
    builder.add_conditional_edges("model", route_after_model, {"tools": "tools", "end": "finish"})
    builder.add_edge("tools", "model")
    builder.add_edge("finish", END)
    return builder.compile(checkpointer=checkpointer)


async def _run_graph(*, provider: dict[str, str], messages: list[dict[str, Any]], tools: list[dict[str, Any]], execute_tool: Any, thread_id: str | None, checkpointer: Any = None) -> dict[str, Any]:
    graph = _build_graph(provider=provider, tools=tools, execute_tool=execute_tool, checkpointer=checkpointer)
    try:
        result: OpsGraphState = {"messages": messages, "steps": 0}
        # Consume the stream through the graph's finish -> END path. Breaking
        # as soon as a model answer appears cancels the stream before
        # LangGraph records terminal completion, which can surface upstream as
        # a disconnected/incomplete task.
        config: dict[str, Any] = {"recursion_limit": MAX_STEPS * 2 + 1}
        if checkpointer:
            config["configurable"] = {"thread_id": thread_id}
        async with asyncio.timeout(RUN_TIMEOUT_SECONDS):
            async for update in graph.astream({"messages": messages, "steps": 0}, config, stream_mode="updates"):
                if not isinstance(update, dict):
                    continue
                for node_update in update.values():
                    if isinstance(node_update, dict):
                        result.update(node_update)
    except TimeoutError as exc:
        raise AgentRuntimeError(f"Ops run exceeded the {int(RUN_TIMEOUT_SECONDS)}s time budget") from exc
    except Exception as exc:
        if isinstance(exc, AgentRuntimeError):
            raise
        raise AgentRuntimeError(f"Ops graph failed: {str(exc)[:300]}") from exc
    if result.get("error"):
        raise AgentRuntimeError(str(result["error"]))
    return {"content": result["final"], "usage": result.get("usage") or {}, "model": result.get("response_model") or provider["model"]}


async def run_ops_graph(*, provider: dict[str, str], messages: list[dict[str, Any]], tools: list[dict[str, Any]], execute_tool: Any, thread_id: str | None = None) -> dict[str, Any]:
    """Run Ops with durable Redis checkpoints when production wiring is enabled."""
    redis_url = os.getenv("LANGGRAPH_REDIS_URL", "").strip()
    redis_required = os.getenv("LANGGRAPH_REDIS_REQUIRED", "false").strip().lower() in {"1", "true", "yes", "on"}
    redis_fallback = os.getenv("LANGGRAPH_REDIS_FALLBACK", "true").strip().lower() in {"1", "true", "yes", "on"}
    if not redis_url:
        if redis_required:
            raise AgentRuntimeError("LangGraph checkpointing is required but LANGGRAPH_REDIS_URL is not configured")
        return await _run_graph(provider=provider, messages=messages, tools=tools, execute_tool=execute_tool, thread_id=None)
    if not thread_id:
        raise AgentRuntimeError("LangGraph checkpointing requires a session thread id")
    try:
        from langgraph.checkpoint.redis.aio import AsyncRedisSaver
    except ImportError as exc:
        raise AgentRuntimeError("LangGraph Redis checkpoint support is not installed") from exc
    try:
        async with AsyncRedisSaver.from_conn_string(redis_url) as checkpointer:
            await checkpointer.asetup()
            return await _run_graph(provider=provider, messages=messages, tools=tools, execute_tool=execute_tool, thread_id=thread_id, checkpointer=checkpointer)
    except Exception as exc:
        # Keep the agent usable in stateless mode whenever durable checkpoints
        # can't be initialized: unreachable Redis, connection errors, or plain
        # Redis lacking the FT.INFO command the LangGraph checkpointer needs.
        # The Supabase transcript is already the durable user-facing history,
        # so checkpointing is an enhancement, not a correctness requirement. A
        # future Redis Stack endpoint will automatically restore checkpointing
        # without another code change.
        if redis_fallback:
            _logger.warning("LangGraph Redis unavailable; running Ops without durable checkpoints: %s", str(exc)[:240])
            return await _run_graph(provider=provider, messages=messages, tools=tools, execute_tool=execute_tool, thread_id=None, checkpointer=None)
        raise AgentRuntimeError(f"LangGraph Redis checkpointing failed: {str(exc)[:300]}") from exc
