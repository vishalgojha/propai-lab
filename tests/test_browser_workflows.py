from browser_workflows import run_igr_property_search, run_maharera_project_status


def _executor_factory(states):
    calls = []

    def execute(name, args):
        calls.append((name, args))
        if name == "browser_open":
            return {"status": "ok", "url": args["url"]}
        if name == "browser_state":
            return states.pop(0)
        if name in {"browser_fill", "browser_click"}:
            return {"status": "ok"}
        raise AssertionError(name)

    return execute, calls


def test_maharera_workflow_uses_search_form_and_visible_steps():
    execute, calls = _executor_factory([
        {"status": "ok", "elements": [
            {"index": 7, "kind": "textbox", "text": "Project Name"},
            {"index": 8, "kind": "button", "text": "Search"},
        ]},
        {"status": "ok", "title": "Search results", "elements": [{"index": 9, "kind": "link", "text": "Kalpataru Magnus"}]},
        {"status": "ok", "title": "Project details", "raw_output": "KALPATARU MAGNUS P51800004029 Proposed Completion 2028"},
    ])

    result = run_maharera_project_status(execute, "browser-session", "Kalpataru Magnus")

    assert result.status == "complete"
    assert [call[0] for call in calls] == ["browser_open", "browser_state", "browser_fill", "browser_click", "browser_state", "browser_click", "browser_state"]
    assert "official result page" in result.content


def test_maharera_workflow_stops_at_human_verification():
    execute, _ = _executor_factory([
        {"status": "ok", "elements": [
            {"index": 7, "kind": "textbox", "text": "Project Name"},
            {"index": 8, "kind": "button", "text": "Search"},
        ]},
        {"status": "ok", "raw_output": "Please enter CAPTCHA"},
    ])

    result = run_maharera_project_status(execute, "browser-session", "Kalpataru Magnus")

    assert result.status == "needs_input"
    assert "verification" in result.content


def test_igr_workflow_does_not_claim_search_without_login():
    execute, calls = _executor_factory([
        {"status": "ok", "raw_output": "LOGIN User Id Password CAPTCHA"},
    ])

    result = run_igr_property_search(execute, "browser-session", {})

    assert result.status == "needs_input"
    assert "login/CAPTCHA" in result.content
    assert [call[0] for call in calls] == ["browser_open", "browser_state"]
