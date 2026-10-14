"""The workspace graph must run model/tool calls on the caller's executor."""

from __future__ import annotations

import asyncio
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

pytest.importorskip("langgraph")

from services.propai_workspace_graph import _build_graph, _run_blocking


def _thread_name() -> str:
    return threading.current_thread().name


def test_run_blocking_uses_supplied_executor():
    pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="probe-exec")
    try:
        name = asyncio.run(_run_blocking(pool, _thread_name))
    finally:
        pool.shutdown(wait=True)
    assert name.startswith("probe-exec")


def test_run_blocking_falls_back_to_default_executor():
    name = asyncio.run(_run_blocking(None, _thread_name))
    assert name
    assert not name.startswith("probe-exec")


class _Message:
    content = "Acknowledged."
    tool_calls = []


class _Response:
    choices = [type("Choice", (), {"message": _Message()})()]


class _Completions:
    def create(self, **kwargs):
        return _Response()


class _Client:
    def __init__(self):
        self.chat = type("Chat", (), {"completions": _Completions()})()


def test_graph_records_stage_timing_and_uses_executor():
    timing: list[dict] = []
    seen_thread: list[str] = []

    def execute_tool(call):
        seen_thread.append(threading.current_thread().name)
        return {"status": "ok"}

    pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="self-chat-agent")
    try:
        graph = _build_graph(
            client=_Client(),
            model="sarvam-105b",
            tools=[],
            execute_tool=execute_tool,
            max_tool_rounds=2,
            require_tool=False,
            tenant_id=None,
            executor=pool,
            timing=timing,
        )
        result = asyncio.run(
            graph.ainvoke(
                {"messages": [{"role": "user", "content": "hello"}], "steps": 0}
            )
        )
    finally:
        pool.shutdown(wait=True)

    assert result.get("final", {}).get("content") == "Acknowledged."
    assert any(entry["stage"] == "model" for entry in timing)
    assert all(entry["seconds"] >= 0 for entry in timing)
