import json

from browser_runtime import (
    AGENT_BROWSER_INSTALL_MESSAGE,
    BrowserRuntimeManager,
    _parse_agent_browser_snapshot,
)


def test_snapshot_preserves_agent_browser_refs_and_metadata():
    elements, url, title = _parse_agent_browser_snapshot(json.dumps({
        "url": "https://example.com",
        "title": "Example",
        "nodes": [
            {"ref": "@e1", "role": "button", "name": "Search"},
            {"ref": "@e2", "role": "textbox", "name": "Query"},
        ],
    }))

    assert (url, title) == ("https://example.com", "Example")
    assert elements[0]["index"] == 1
    assert elements[0]["kind"] == "button"
    assert elements[0]["text"] == "Search"


def test_legacy_provider_names_are_accepted_by_manager():
    manager = BrowserRuntimeManager()
    manager._provider = type("HealthyProvider", (), {
        "health_check": lambda self: {"ok": True},
    })()
    assert manager._provider_impl().health_check()["ok"] is True


def test_missing_binary_has_actionable_error(monkeypatch):
    monkeypatch.setenv("AGENT_BROWSER_BIN", "/definitely/missing/agent-browser")
    manager = BrowserRuntimeManager()
    result = manager.run("browser-use", "open", "test-session", url="https://example.com")
    assert result.status == "error"
    assert AGENT_BROWSER_INSTALL_MESSAGE in result.error
