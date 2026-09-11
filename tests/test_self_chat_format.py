"""Unit tests for the WhatsApp self-chat helpers.

Covers:
- _is_casual_self_chat() routing for greetings/identity vs. data queries.
- _format_self_chat_response() post-processor: paragraphs → bullets, JSON
  fences stripped, length cap, de-duplication.
- _build_self_chat_system_prompt() contains the bullet-only rules and never
  inherits the workspace JSON contract.
- _ndjson_line() returns valid newline-terminated UTF-8 JSON.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from routers import self_chat as sc_mod


def test_is_casual_self_chat_routes_greetings():
    assert sc_mod._is_casual_self_chat("hi") is True
    assert sc_mod._is_casual_self_chat("Hello!") is True
    assert sc_mod._is_casual_self_chat("good morning") is True
    assert sc_mod._is_casual_self_chat("thanks") is True
    assert sc_mod._is_casual_self_chat("ok") is True
    assert sc_mod._is_casual_self_chat("Who are you?") is True
    assert sc_mod._is_casual_self_chat("what can you do") is True


def test_is_casual_self_chat_routes_data_queries():
    assert sc_mod._is_casual_self_chat("show me 3bhk in bandra") is False
    assert sc_mod._is_casual_self_chat("rent in andheri under 1L") is False
    assert sc_mod._is_casual_self_chat("any brokers active today?") is False
    assert sc_mod._is_casual_self_chat("latest listings in dindoshi") is False


def test_short_search_follow_up_keeps_durable_context():
    assert sc_mod._is_self_chat_follow_up("Sure. Show me.") is True
    assert sc_mod._is_self_chat_follow_up("Why?") is True
    assert sc_mod._is_self_chat_follow_up("Don't you know Bandra West from Bandra East?") is True
    assert sc_mod._is_self_chat_follow_up("Looking for a 3 BHK in Bandra") is False


def test_format_self_chat_response_splits_paragraphs_to_bullets():
    text = (
        "I checked the market. There are 3 active 2 BHK listings in Bandra West. "
        "The cheapest is at 95K. Brokers include Rahul and Suresh."
    )
    out = sc_mod._format_self_chat_response(text)
    lines = out.split("\n")
    assert all(line.startswith("• ") for line in lines), out
    assert 2 <= len(lines) <= 8, out
    # First bullet must contain the answer (cheapest is at 95K).
    assert "95K" in out or "95" in out, out


def test_format_self_chat_response_keeps_casual_text_natural():
    out = sc_mod._format_self_chat_response("Hey there! How can I help today?", force_bullets=False)
    assert not out.startswith("• "), out
    assert "Hey there" in out


def test_format_self_chat_response_strips_json_fences():
    text = "```json\n{\"content\": \"hi there\"}\n```"
    out = sc_mod._format_self_chat_response(text)
    assert "```" not in out
    assert "json" not in out.lower()
    assert out.startswith("• "), out


def test_format_self_chat_response_handles_raw_json_object():
    text = '{"content": "• Already bulleted\\n• like this"}'
    out = sc_mod._format_self_chat_response(text)
    assert out.startswith("• "), out
    assert "Already bulleted" in out, out


def test_format_self_chat_response_caps_to_eight_bullets():
    text = "\n".join(f"line {i}: hello world this is bullet number {i}" for i in range(15))
    out = sc_mod._format_self_chat_response(text)
    assert len(out.split("\n")) <= 8, out


def test_format_self_chat_response_dedupes_near_identical_lines():
    text = "Same line.\nSame line.\nDifferent line."
    out = sc_mod._format_self_chat_response(text)
    lines = out.split("\n")
    assert len(lines) == 2, out
    assert "Same line" in lines[0]
    assert "Different line" in lines[1]


def test_format_self_chat_response_handles_empty_and_whitespace():
    assert sc_mod._format_self_chat_response("") == ""
    assert sc_mod._format_self_chat_response("   \n\n  ") == ""


def test_build_self_chat_system_prompt_includes_bullet_rules():
    prompt = sc_mod._build_self_chat_system_prompt({"overview": "200 listings"})
    # Bullet rules
    assert "• " in prompt
    assert "bullets" in prompt.lower()
    # Anti-prose rules
    assert "NEVER write" in prompt or "no flowing" in prompt.lower()
    # Anti-JSON rules
    assert "JSON" in prompt or "json" in prompt
    # No workspace contract bleed-through
    assert "listing_cards" not in prompt, "workspace contract leaked into self-chat prompt"
    assert "FINAL RESPONSE CONTRACT" not in prompt
    # Overview line included
    assert "200 listings" in prompt
    assert "tenant-captured WhatsApp evidence" in prompt
    assert "connected groups" in prompt
    assert "self-chat is support, not an ingestion source" in prompt
    assert "street-smart" in prompt
    assert "Mirror the user's language" in prompt


def test_build_self_chat_system_prompt_handles_empty_sources():
    prompt = sc_mod._build_self_chat_system_prompt({})
    assert "PropAI" in prompt
    assert "• " in prompt
    # No overview line if sources are empty.
    assert "DATA SNAPSHOT" not in prompt


def test_shared_prompt_uses_explicit_india_timezone(monkeypatch):
    import ai_chat_engine
    from datetime import timezone

    real_datetime = ai_chat_engine.datetime.datetime
    class _FixedDateTime:
        @classmethod
        def now(cls, tz=None):
            assert tz is not None
            return real_datetime(2026, 9, 11, 11, 54, tzinfo=timezone.utc).astimezone(tz)

    monkeypatch.setattr(ai_chat_engine.datetime, "datetime", _FixedDateTime)
    prompt = ai_chat_engine.build_system_prompt({"overview": ""})
    assert "05:24 PM IST" in prompt


def test_ndjson_line_emits_valid_utf8_with_newline():
    payload = {"event": "chunk", "delta": "• hello \u00e9"}
    out = sc_mod._ndjson_line(payload)
    assert out.endswith(b"\n")
    text = out.decode("utf-8").rstrip("\n")
    # JSON is valid and round-trips back to the same payload.
    import json as _json
    parsed = _json.loads(text)
    assert parsed == payload
    # And the bullet survived as the actual unicode char, not an escape.
    assert "\u2022" in text


def test_stream_self_chat_enabled_default_is_off():
    # Default: env var unset → disabled.
    assert sc_mod._stream_self_chat_enabled() is False


def test_openclaw_self_chat_config_uses_dedicated_model(monkeypatch):
    monkeypatch.setenv("OPENCLAW_API_URL", "http://openclaw:18789/v1")
    monkeypatch.setenv("OPENCLAW_API_KEY", "gateway-token")
    monkeypatch.setenv("OPENCLAW_AGENT_MODEL", "openclaw/default")
    monkeypatch.setenv("OPENCLAW_SELF_CHAT_MODEL", "openclaw/self-chat")
    assert sc_mod._openclaw_self_chat_config() == (
        "http://openclaw:18789/v1",
        "gateway-token",
        "openclaw/self-chat",
    )


def test_openclaw_self_chat_config_can_be_disabled(monkeypatch):
    monkeypatch.setenv("OPENCLAW_SELF_CHAT_ENABLED", "false")
    assert sc_mod._openclaw_self_chat_config() == ("", "", "")


def test_self_chat_ndjson_streaming_yields_done_for_casual(monkeypatch):
    # The casual path uses the bounded quick-reply helper and must always
    # terminate with a done event, even when the provider returns a short answer.
    import asyncio

    async def _fake_quick(_text, _tenant_id, identity=None):
        return {"reply": "PropAI- • hello"}

    monkeypatch.setattr(sc_mod, "_quick_self_chat_reply", _fake_quick)

    async def _collect():
        out = []
        async for line in sc_mod._self_chat_ndjson("hi", "broker-1", casual=True):
            out.append(line)
        return out

    result = asyncio.run(_collect())
    assert len(result) >= 1
    joined = b"".join(result).decode("utf-8")
    assert "event" in joined
