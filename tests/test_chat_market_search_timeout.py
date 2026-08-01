import json
from unittest.mock import Mock, patch

import ai_chat_engine
from routers import ai_chat as ai_chat_router


def _fake_choice(content: str):
    msg = Mock()
    msg.content = content
    choice = Mock()
    choice.message = msg
    resp = Mock()
    resp.choices = [choice]
    return resp


def test_conversational_reply_strips_think_blocks():
    raw = "Public intro. <think>secret chain of thought</think> Public outro."
    fake_client = Mock()
    fake_client.chat.completions.create.return_value = _fake_choice(raw)
    with patch.object(ai_chat_engine, "get_client", return_value=fake_client):
        with patch.object(ai_chat_engine, "_get_fallback_model", return_value="mock-model"):
            with patch.object(ai_chat_engine, "_log_usage"):
                reply = ai_chat_engine.get_conversational_reply(
                    [{"role": "user", "content": "hey"}],
                    api_key="k", model="m", base_url="u",
                )
    assert "<think>" not in reply.content
    assert "</think>" not in reply.content
    assert "secret chain of thought" not in reply.content
    assert "Public intro" in reply.content
    assert "Public outro" in reply.content


def test_conversational_reply_strips_lone_dangling_close_tag():
    raw = "Hey there! How can I help you today? Any property search on my mind?\n</think>Hey there! How can I help you today? Any property search on my mind?"
    fake_client = Mock()
    fake_client.chat.completions.create.return_value = _fake_choice(raw)
    with patch.object(ai_chat_engine, "get_client", return_value=fake_client):
        with patch.object(ai_chat_engine, "_get_fallback_model", return_value="mock-model"):
            with patch.object(ai_chat_engine, "_log_usage"):
                reply = ai_chat_engine.get_conversational_reply(
                    [{"role": "user", "content": "hey"}],
                    api_key="k", model="m", base_url="u",
                )
    assert "</think>" not in reply.content
    assert reply.content.count("Hey there!") == 1


def test_market_search_llm_call_respects_timeout():
    captured = {}

    class SlowCall:
        def __call__(self, *args, **kwargs):
            captured.update(kwargs)
            return _fake_choice("slow")

    fake_client = Mock()
    slow = SlowCall()
    fake_client.chat.completions.create = slow
    with patch.object(ai_chat_engine, "get_client", return_value=fake_client):
        result = ai_chat_engine._llm_market_search_request(
            "any 3 bhk for rent in bandra west?",
            api_key="k",
            model="m",
            base_url="u",
        )
    assert result is None
    assert captured.get("timeout") == 20


def test_market_search_llm_timeout_falls_through_to_regex():
    fake_client = Mock()
    fake_client.chat.completions.create.side_effect = TimeoutError("simulated upstream timeout")
    with patch.object(ai_chat_engine, "get_client", return_value=fake_client):
        result = ai_chat_engine.parse_market_search_request(
            "any 3 bhk for rent in bandra west?",
            api_key="k",
            model="m",
            base_url="u",
        )
    assert result is not None
    assert result.get("bhk") == "3"
    assert result.get("intent") == "RENT"


def test_market_search_allow_llm_false_skips_client():
    fake_client = Mock()
    with patch.object(ai_chat_engine, "get_client", return_value=fake_client) as get_client:
        result = ai_chat_engine.parse_market_search_request(
            "any 3 bhk for rent in bandra west?",
            api_key="k",
            model="m",
            base_url="u",
            allow_llm=False,
        )
    get_client.assert_not_called()
    assert result is not None
    assert result.get("bhk") == "3"


def test_guard_against_raw_markup_swaps_clean_error():
    raw = "<!DOCTYPE html><html><body>Error 524: A timeout occurred</body></html>"
    assert ai_chat_router._guard_against_raw_markup(raw) == ai_chat_router._RAW_MARKUP_ERROR
    assert ai_chat_router._guard_against_raw_markup("normal reply") == "normal reply"


def test_wrap_chat_response_inbox_guards_markup():
    response = {"content": "<html><body>Gateway timeout</body></html>", "blocks": []}
    guarded = ai_chat_router._wrap_chat_response(response, is_inbox=True)
    assert guarded["content"] == ai_chat_router._RAW_MARKUP_ERROR
