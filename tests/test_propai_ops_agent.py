import asyncio
import sys
import types

import pytest

from services import propai_ops_agent, propai_ops_graph
from services.propai_agent_runtime import AgentRuntimeError


def _install_broken_redis_saver(monkeypatch):
    class _BrokenCtx:
        async def __aenter__(self):
            raise ConnectionError("Error -3 connecting to fake:6379")

        async def __aexit__(self, *args):
            return None

    class _FakeRedisSaver:
        @staticmethod
        def from_conn_string(url):
            return _BrokenCtx()

    parent = types.ModuleType("langgraph.checkpoint.redis")
    parent.__path__ = []
    aio = types.ModuleType("langgraph.checkpoint.redis.aio")
    aio.AsyncRedisSaver = _FakeRedisSaver
    monkeypatch.setitem(sys.modules, "langgraph.checkpoint.redis", parent)
    monkeypatch.setitem(sys.modules, "langgraph.checkpoint.redis.aio", aio)


def _fake_run_path(monkeypatch, expected_checkpointer):
    sentinel = {"content": "stateless ok", "model": "fake"}

    async def fake_run(**kwargs):
        assert kwargs.get("checkpointer") is expected_checkpointer
        assert kwargs.get("thread_id") is (None if expected_checkpointer is None else "s1")
        return sentinel

    monkeypatch.setattr(propai_ops_graph, "_run_graph", fake_run)
    return sentinel


def _call_ops_graph(monkeypatch, fallback="true"):
    _install_broken_redis_saver(monkeypatch)
    monkeypatch.setenv("LANGGRAPH_REDIS_URL", "redis://default:pw@fake:6379/0")
    monkeypatch.setenv("LANGGRAPH_REDIS_REQUIRED", "true")
    monkeypatch.setenv("LANGGRAPH_REDIS_FALLBACK", fallback)
    return asyncio.run(
        propai_ops_graph.run_ops_graph(
            provider={"base_url": "https://fake/v1", "api_key": "k", "model": "m"},
            messages=[{"role": "user", "content": "hi"}],
            tools=[],
            execute_tool=lambda call: None,
            thread_id="s1",
        )
    )


def test_ops_redis_checkpoint_failure_falls_back_stateless(monkeypatch):
    sentinel = _fake_run_path(monkeypatch, expected_checkpointer=None)
    assert _call_ops_graph(monkeypatch, fallback="true") == sentinel


def test_ops_redis_checkpoint_failure_raises_when_fallback_disabled(monkeypatch):
    with pytest.raises(AgentRuntimeError) as excinfo:
        _call_ops_graph(monkeypatch, fallback="false")
    assert "LangGraph Redis checkpointing failed" in str(excinfo.value)


def test_ops_stateless_when_redis_unset_and_not_required(monkeypatch):
    sentinel = _fake_run_path(monkeypatch, expected_checkpointer=None)
    monkeypatch.setenv("LANGGRAPH_REDIS_URL", "")
    monkeypatch.setenv("LANGGRAPH_REDIS_REQUIRED", "false")
    result = asyncio.run(
        propai_ops_graph.run_ops_graph(
            provider={"base_url": "https://fake/v1", "api_key": "k", "model": "m"},
            messages=[{"role": "user", "content": "hi"}],
            tools=[],
            execute_tool=lambda call: None,
            thread_id="s1",
        )
    )
    assert result == sentinel


def test_native_ops_status_uses_provider_configuration(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    monkeypatch.setenv("OPENROUTER_OPS_MODEL", "test/model")
    status = propai_ops_agent.native_ops_status()
    assert status["configured"] is True
    assert status["mode"] == "langgraph_bounded_read_only"
    assert status["max_steps"] == 6


def test_repo_search_is_bounded_and_read_only():
    result = propai_ops_agent._repo_search("propai_ops_agent")
    assert result["status"] == "ok"
    assert len(result["matches"]) <= 20


def test_unknown_ops_tool_fails_closed():
    result = asyncio.run(propai_ops_agent._execute_tool({"function": {"name": "delete_everything", "arguments": "{}"}}, object()))
    assert result["status"] == "error"
