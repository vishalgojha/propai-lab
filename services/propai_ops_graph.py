"""LangGraph orchestration for the bounded, read-only Ops agent."""

from __future__ import annotations

import json
import asyncio
from typing import Any, Literal, TypedDict

from langgraph.graph import END, START, StateGraph

from services.propai_agent_runtime import AgentRuntimeError, run_agent_step


MAX_STEPS = 6


class OpsGraphState(TypedDict, total=False):
    messages: list[dict[str, Any]]
    steps: int
    usage: dict[str, Any]
    response_model: str
    final: str
    error: str


def _build_graph(*, provider: dict[str, str], tools: list[dict[str, Any]], execute_tool: Any):
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
            result = await execute_tool(call)
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
    return builder.compile()


async def run_ops_graph(*, provider: dict[str, str], messages: list[dict[str, Any]], tools: list[dict[str, Any]], execute_tool: Any) -> dict[str, Any]:
    graph = _build_graph(provider=provider, tools=tools, execute_tool=execute_tool)
    try:
        result: OpsGraphState = {"messages": messages, "steps": 0}
        # Consume until the model has produced a terminal answer. Stopping at
        # the terminal state also avoids waiting on the graph's END task after
        # a request is already complete.
        async for update in graph.astream({"messages": messages, "steps": 0}, {"recursion_limit": MAX_STEPS * 2 + 1}, stream_mode="updates"):
            if not isinstance(update, dict):
                continue
            for node_update in update.values():
                if isinstance(node_update, dict):
                    result.update(node_update)
            if result.get("final") or result.get("error"):
                break
    except Exception as exc:
        if isinstance(exc, AgentRuntimeError):
            raise
        raise AgentRuntimeError(f"Ops graph failed: {str(exc)[:300]}") from exc
    if result.get("error"):
        raise AgentRuntimeError(str(result["error"]))
    return {"content": result["final"], "usage": result.get("usage") or {}, "model": result.get("response_model") or provider["model"]}
