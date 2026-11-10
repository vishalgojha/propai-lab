from routers.integrations_agent import API_BASE_URL, MCP_ENDPOINT, IntegrationAgentTask, _check_url


def test_integration_agent_task_is_bounded_to_supported_providers():
    assert {IntegrationAgentTask(task=value).task for value in ("instinct", "claude", "gemini", "verify")} == {
        "instinct", "claude", "gemini", "verify"
    }


def test_browser_checks_use_only_propai_owned_endpoints():
    assert _check_url("instinct") == f"{API_BASE_URL}/api/external/v1/health"
    assert _check_url("claude") == "https://mcp.propai.live/"
    assert _check_url("gemini") == "https://mcp.propai.live/"
    assert MCP_ENDPOINT == "https://mcp.propai.live/mcp"
