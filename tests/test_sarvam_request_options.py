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


def test_call_provider_rejects_truncated_json_that_misses_top_level_close(monkeypatch):
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

    truncated_body = '{"message_class":"listing_broadcast","listing_count":3,"items":[{"listing_type":"sale","price":{"amount":10000000}},{"listing_type":"sale","price":{"amount":20000000}}'

    class FakeCompletions:
        def create(self, **request):
            return type("Response", (), {
                "choices": [type("Choice", (), {
                    "message": type("Message", (), {"content": truncated_body})(),
                    "finish_reason": "length",
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

    assert result == "TRUNCATED"


def test_call_provider_accepts_complete_json_even_at_length_finish(monkeypatch):
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

    # Finish reports "length" but the document is actually closed/complete.
    complete_body = '{"message_class":"listing","listing_count":1,"items":[{"listing_type":"sale","property_category":"residential"}]}'

    class FakeCompletions:
        def create(self, **request):
            return type("Response", (), {
                "choices": [type("Choice", (), {
                    "message": type("Message", (), {"content": complete_body})(),
                    "finish_reason": "length",
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

    assert result == {"message_class": "listing", "listing_count": 1, "items": [{"listing_type": "sale", "property_category": "residential"}]}
