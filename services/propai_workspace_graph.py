"""LangGraph runner for broker workspace and WhatsApp self-chat."""

from __future__ import annotations

import asyncio
import json
from typing import Any, Literal, TypedDict

from langgraph.graph import END, START, StateGraph

from services.propai_agent_runtime import AgentRuntimeError


MAX_TOOL_ROUNDS = 2


class WorkspaceState(TypedDict, total=False):
    messages: list[dict[str, Any]]
    steps: int
    final: dict[str, Any]
    error: str


def _build_graph(*, client: Any, model: str, tools: list[dict[str, Any]], execute_tool: Any, max_tool_rounds: int, require_tool: bool):
    async def model_node(state: WorkspaceState) -> dict[str, Any]:
        response = await asyncio.to_thread(
            client.chat.completions.create,
            model=model,
            messages=state["messages"],
            tools=tools,
            tool_choice="auto",
        )
        msg = response.choices[0].message
        content = str(msg.content or "")
        assistant: dict[str, Any] = {"role": "assistant", "content": content}
        calls: list[dict[str, Any]] = []
        for call in msg.tool_calls or []:
            arguments = str(call.function.arguments or "{}").strip()
            try:
                json.loads(arguments)
            except json.JSONDecodeError:
                arguments = "{}"
            calls.append({"id": str(call.id), "type": "function", "function": {"name": str(call.function.name), "arguments": arguments}})
        if calls:
            assistant["tool_calls"] = calls
        updated = [*state["messages"], assistant]
        next_steps = int(state.get("steps", 0)) + 1
        if not calls:
            if not content.strip():
                raise AgentRuntimeError("workspace provider returned an empty response")
            if require_tool and not any(message.get("role") == "tool" for message in state["messages"]):
                return {"messages": updated, "steps": next_steps, "final": {"content": "I couldn’t verify that against the live PropAI listings right now. Please try the search again.", "status_steps": ["Live listing search could not be completed"], "trace": {"route": "grounding_required_but_no_tool_result"}}}
            return {"messages": updated, "steps": next_steps, "final": {"content": content}}
        if next_steps >= max_tool_rounds:
            return {"messages": updated, "steps": next_steps, "error": "workspace agent reached the tool-round limit"}
        return {"messages": updated, "steps": next_steps}

    async def tool_node(state: WorkspaceState) -> dict[str, Any]:
        tool_messages: list[dict[str, Any]] = []
        for call in state["messages"][-1].get("tool_calls") or []:
            result = await asyncio.to_thread(execute_tool, call)
            if isinstance(result, dict) and result.get("status") == "pending_confirmation":
                return {"final": {"content": result.get("message") or "Confirmation is required before changing workspace data.", "confirmation": result}}
            tool_messages.append({"role": "tool", "tool_call_id": call.get("id") or "", "content": json.dumps(result, default=str)[:12000]})
        return {"messages": [*state["messages"], *tool_messages]}

    def route(state: WorkspaceState) -> Literal["tools", "finish"]:
        if state.get("final") or state.get("error"):
            return "finish"
        return "tools" if state["messages"][-1].get("tool_calls") else "finish"

    builder = StateGraph(WorkspaceState)
    builder.add_node("model", model_node)
    builder.add_node("tools", tool_node)
    builder.add_node("finish", lambda state: {})
    builder.add_edge(START, "model")
    builder.add_conditional_edges("model", route, {"tools": "tools", "finish": "finish"})
    builder.add_conditional_edges("tools", lambda state: "finish" if state.get("final") else "model", {"model": "model", "finish": "finish"})
    builder.add_edge("finish", END)
    return builder.compile()


async def run_workspace_graph(*, messages: list[dict[str, Any]], sources: dict[str, Any], api_key: str, model: str, base_url: str, tenant_id: str | None, storage_client: Any, user_id: str | None = None, browser_enabled: bool = False, browser_provider: str | None = None, activity_sink: list[dict[str, Any]] | None = None, max_tool_rounds: int = MAX_TOOL_ROUNDS, require_tool: bool = False, prefer_supabase_agent: bool = True) -> dict[str, Any]:
    from ai_chat_engine import _add_tool_cache_control, _build_tools, _cached_system_blocks, execute_tool, get_client, normalize_workspace_response

    client = get_client(api_key=api_key, base_url=base_url)
    tools = _add_tool_cache_control(_build_tools(sources, prefer_supabase_agent=prefer_supabase_agent, browser_enabled=browser_enabled))
    cached_messages = [{**message, "content": _cached_system_blocks(message["content"])} if message.get("role") == "system" and isinstance(message.get("content"), str) else message for message in messages]

    def invoke_tool(call: dict[str, Any]) -> dict[str, Any]:
        function = call.get("function") or {}
        try:
            arguments = json.loads(function.get("arguments") or "{}")
        except json.JSONDecodeError:
            arguments = {}
        result = execute_tool(str(function.get("name") or ""), arguments, sources, tenant_id=tenant_id, storage_client=storage_client, user_id=user_id, browser_enabled=browser_enabled, browser_provider=browser_provider)
        if activity_sink is not None:
            activity_sink.append({"tool": function.get("name") or "", "status": result.get("status", "ok") if isinstance(result, dict) else "ok", "summary": f"Ran {str(function.get('name') or '').replace('_', ' ')}"})
        return result if isinstance(result, dict) else {"status": "ok", "result": result}

    bounded_rounds = max(1, min(int(max_tool_rounds or MAX_TOOL_ROUNDS), 16))
    graph = _build_graph(client=client, model=model, tools=tools, execute_tool=invoke_tool, max_tool_rounds=bounded_rounds, require_tool=require_tool)
    try:
        result = await graph.ainvoke({"messages": cached_messages, "steps": 0}, {"recursion_limit": bounded_rounds * 2 + 1})
    except AgentRuntimeError:
        raise
    except Exception as exc:
        raise AgentRuntimeError(f"workspace graph failed: {str(exc)[:300]}") from exc
    if result.get("error"):
        raise AgentRuntimeError(str(result["error"]))
    final = result.get("final") or {}
    if final.get("trace"):
        return {"content": final.get("content", ""), "blocks": [], "status_steps": final.get("status_steps") or [], "trace": final["trace"]}
    confirmation = final.get("confirmation")
    if confirmation:
        return {"content": final.get("content", ""), "blocks": [{"type": "confirmation", "title": confirmation.get("title") or "Confirmation required", "body": confirmation.get("message"), "tool": confirmation.get("tool"), "confirmation_token": confirmation.get("confirmation_token")}], "status_steps": ["Prepared workspace change"], "trace": {"route": "langgraph_workspace", "pending_tool": confirmation.get("tool")}}
    return normalize_workspace_response(final.get("content"), sources)
