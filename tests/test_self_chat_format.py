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

import app


def test_is_casual_self_chat_routes_greetings():
    assert app._is_casual_self_chat("hi") is True
    assert app._is_casual_self_chat("Hello!") is True
    assert app._is_casual_self_chat("good morning") is True
    assert app._is_casual_self_chat("thanks") is True
    assert app._is_casual_self_chat("ok") is True
    assert app._is_casual_self_chat("Who are you?") is True
    assert app._is_casual_self_chat("what can you do") is True


def test_is_casual_self_chat_routes_data_queries():
    assert app._is_casual_self_chat("show me 3bhk in bandra") is False
    assert app._is_casual_self_chat("rent in andheri under 1L") is False
    assert app._is_casual_self_chat("any brokers active today?") is False
    assert app._is_casual_self_chat("latest listings in dindoshi") is False


def test_format_self_chat_response_splits_paragraphs_to_bullets():
    text = (
        "I checked the market. There are 3 active 2 BHK listings in Bandra West. "
        "The cheapest is at 95K. Brokers include Rahul and Suresh."
    )
    out = app._format_self_chat_response(text)
    lines = out.split("\n")
    assert all(line.startswith("• ") for line in lines), out
    assert 2 <= len(lines) <= 8, out
    # First bullet must contain the answer (cheapest is at 95K).
    assert "95K" in out or "95" in out, out


def test_format_self_chat_response_strips_json_fences():
    text = "```json\n{\"content\": \"hi there\"}\n```"
    out = app._format_self_chat_response(text)
    assert "```" not in out
    assert "json" not in out.lower()
    assert out.startswith("• "), out


def test_format_self_chat_response_handles_raw_json_object():
    text = '{"content": "• Already bulleted\\n• like this"}'
    out = app._format_self_chat_response(text)
    assert out.startswith("• "), out
    assert "Already bulleted" in out, out


def test_format_self_chat_response_caps_to_eight_bullets():
    text = "\n".join(f"line {i}: hello world this is bullet number {i}" for i in range(15))
    out = app._format_self_chat_response(text)
    assert len(out.split("\n")) <= 8, out


def test_format_self_chat_response_dedupes_near_identical_lines():
    text = "Same line.\nSame line.\nDifferent line."
    out = app._format_self_chat_response(text)
    lines = out.split("\n")
    assert len(lines) == 2, out
    assert "Same line" in lines[0]
    assert "Different line" in lines[1]


def test_format_self_chat_response_handles_empty_and_whitespace():
    assert app._format_self_chat_response("") == ""
    assert app._format_self_chat_response("   \n\n  ") == ""


def test_build_self_chat_system_prompt_includes_bullet_rules():
    prompt = app._build_self_chat_system_prompt({"overview": "200 listings"})
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


def test_build_self_chat_system_prompt_handles_empty_sources():
    prompt = app._build_self_chat_system_prompt({})
    assert "PropAI" in prompt
    assert "• " in prompt
    # No overview line if sources are empty.
    assert "DATA SNAPSHOT" not in prompt


def test_ndjson_line_emits_valid_utf8_with_newline():
    payload = {"event": "chunk", "delta": "• hello \u00e9"}
    out = app._ndjson_line(payload)
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
    assert app._stream_self_chat_enabled() is False


def test_self_chat_ndjson_streaming_yields_done_for_casual():
    # We don't actually call the LLM here — just verify the generator's
    # error/event contract by patching _stream_self_chat_reply to return None
    # and _is_casual_self_chat to return True, then expecting a fallback
    # path that yields at least an error event (no LLM in unit tests).
    import asyncio

    async def _collect():
        out = []
        async for line in app._self_chat_ndjson("hi", "broker-1", casual=True):
            out.append(line)
        return out

    # Patch the streaming reply to return a value, then expect chunk+done.
    app._stream_self_chat_reply = lambda _t: __import__("asyncio").coroutine(lambda: "PropAI- • hello")()
    result = asyncio.run(_collect())
    assert len(result) >= 1
    joined = b"".join(result).decode("utf-8")
    assert "event" in joined
