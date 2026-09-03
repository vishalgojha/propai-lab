import asyncio

from services import propai_ops_agent


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
