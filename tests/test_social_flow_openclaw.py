from routers.admin_ops import _openclaw_config
from routers.social_flow import _openclaw_agent_config


def test_agent_surfaces_use_openclaw_configuration(monkeypatch):
    monkeypatch.setenv("RETIRED_AGENT_API_URL", "http://legacy-agent")
    monkeypatch.setenv("RETIRED_AGENT_API_KEY", "legacy")
    monkeypatch.setenv("OPENCLAW_API_URL", "http://openclaw/")
    monkeypatch.setenv("OPENCLAW_API_KEY", "new")
    monkeypatch.setenv("OPENCLAW_AGENT_MODEL", "openclaw/default")

    expected = ("http://openclaw", "new", "openclaw/default")
    assert _openclaw_agent_config() == expected
    assert _openclaw_config() == expected


def test_agent_surfaces_do_not_fallback_to_retired_gateway(monkeypatch):
    monkeypatch.delenv("OPENCLAW_API_URL", raising=False)
    monkeypatch.delenv("OPENCLAW_API_KEY", raising=False)
    monkeypatch.delenv("OPENCLAW_AGENT_MODEL", raising=False)
    monkeypatch.setenv("RETIRED_AGENT_API_URL", "http://legacy-agent")
    monkeypatch.setenv("RETIRED_AGENT_API_KEY", "legacy")
    monkeypatch.setenv("RETIRED_AGENT_MODEL", "legacy-model")

    expected = ("", "", "openclaw/default")
    assert _openclaw_agent_config() == expected
    assert _openclaw_config() == expected
