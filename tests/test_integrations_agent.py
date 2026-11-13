from routers.external_agent import DEFAULT_READ_SCOPES, TOOL_READ_SCOPES
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


def test_browser_preflight_reports_missing_runtime():
    from browser_runtime import AGENT_BROWSER_INSTALL_MESSAGE

    assert "agent-browser CLI is not installed" in AGENT_BROWSER_INSTALL_MESSAGE


def test_instinct_and_external_keys_share_explicit_read_scopes():
    assert TOOL_READ_SCOPES.issubset(DEFAULT_READ_SCOPES)
    assert "raw_messages:dms" not in DEFAULT_READ_SCOPES
