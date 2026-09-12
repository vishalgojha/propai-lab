"""Provider-specific request options for the native workspace agent."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

pytest.importorskip("langgraph")

from services.propai_workspace_graph import _build_graph


class _Message:
    content = "Acknowledged."
    tool_calls = []


class _Response:
    choices = [type("Choice", (), {"message": _Message()})()]


class _Completions:
    def __init__(self):
        self.requests = []

    def create(self, **kwargs):
        self.requests.append(kwargs)
        return _Response()


class _Client:
    def __init__(self):
        self.chat = type("Chat", (), {"completions": _Completions()})()


def _run(disable_reasoning: bool):
    client = _Client()
    graph = _build_graph(
        client=client,
        model="sarvam-105b",
        tools=[],
        execute_tool=lambda call: {},
        max_tool_rounds=1,
        require_tool=False,
        tenant_id=None,
        disable_reasoning=disable_reasoning,
    )
    asyncio.run(graph.ainvoke({"messages": [{"role": "user", "content": "hello"}], "steps": 0}))
    return client.chat.completions.requests[0]


def test_sarvam_request_omits_reasoning_option():
    request = _run(True)
    assert "reasoning_effort" not in request
    assert "extra_body" not in request


def test_other_provider_keeps_reasoning_hint():
    request = _run(False)
    assert request["extra_body"] == {"reasoning_effort": "medium"}
