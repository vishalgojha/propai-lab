def test_sarvam_reasoning_is_explicitly_disabled(monkeypatch):
    import ai_extraction

    provider = {
        "name": "extraction-sarvam",
        "api_key": "key",
        "base_url": "https://api.sarvam.ai/v1",
        "model": "sarvam-105b",
        "supports_json_mode": True,
        "max_tokens": 8192,
        "disable_reasoning": True,
    }

    captured = {}

    class FakeCompletions:
        def create(self, **request):
            captured.update(request)
            return type("Response", (), {
                "choices": [type("Choice", (), {
                    "message": type("Message", (), {"content": '{"asset_type":"residential"}'})(),
                    "finish_reason": "stop",
                })()],
                "usage": None,
            })()

    class FakeClient:
        def __init__(self, **kwargs):
            self.chat = type("Chat", (), {"completions": FakeCompletions()})()

    monkeypatch.setattr(ai_extraction, "OpenAI", FakeClient)
    monkeypatch.setattr(ai_extraction, "_wait_for_provider_cooldown", lambda name: None)
    monkeypatch.setattr(ai_extraction, "_response_headers", lambda response: {})
    monkeypatch.setattr(ai_extraction, "_logger", ai_extraction._logger)

    result = ai_extraction._call_provider(
        provider,
        [{"role": "user", "content": "extract"}],
        timeout=1,
    )

    assert result == {"asset_type": "residential"}
    assert captured["reasoning_effort"] is None
