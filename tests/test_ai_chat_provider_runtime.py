from unittest.mock import Mock, patch

import ai_chat_engine


def test_get_client_rebuilds_for_provider_endpoint_changes():
    ai_chat_engine._client = None
    ai_chat_engine._client_key = ""
    ai_chat_engine._client_base_url = ""

    first = Mock(api_key="key-one")
    second = Mock(api_key="key-two")
    with patch.object(ai_chat_engine, "OpenAI", side_effect=[first, second]) as openai:
        assert ai_chat_engine.get_client("key-one", "https://one.example/v1/") is first
        assert ai_chat_engine.get_client("key-one", "https://one.example/v1/") is first
        assert ai_chat_engine.get_client("key-two", "https://two.example/v1") is second

    assert openai.call_count == 2
    openai.assert_any_call(api_key="key-one", base_url="https://one.example/v1")
    openai.assert_any_call(api_key="key-two", base_url="https://two.example/v1")
