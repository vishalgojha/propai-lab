import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ai_chat_engine import (
    strip_think_blocks,
    _drop_echoed_assistant_content,
    _purify_listing_blocks,
    normalize_workspace_response,
)


def test_strip_think_removes_tags():
    text = "Public intro. <think>internal reasoning</think> Public outro."
    out = strip_think_blocks(text)
    assert "<think>" not in out and "</think>" not in out
    assert "internal reasoning" not in out
    assert "Public intro" in out and "Public outro" in out


def test_strip_think_handles_empty_and_clean():
    assert strip_think_blocks("") == ""
    assert strip_think_blocks(None) == ""
    assert strip_think_blocks("no tags here") == "no tags here"


def test_drop_echo_collapses_back_to_back_duplicate():
    messages = [
        {"role": "user", "content": "show 2 bhk"},
        {"role": "assistant", "content": "Found 5 listings. Top: Foo.", "tool_calls": [{"id": "1"}]},
        {"role": "tool", "content": "5 rows", "tool_call_id": "1"},
        {"role": "assistant", "content": "Found 5 listings. Top: Foo.", "tool_calls": [{"id": "2"}]},
    ]
    _drop_echoed_assistant_content(messages)
    assert messages[-1]["content"] == ""


def test_drop_echo_keeps_distinct_content():
    messages = [
        {"role": "user", "content": "show 2 bhk"},
        {"role": "assistant", "content": "Found 5 listings. Top: Foo.", "tool_calls": [{"id": "1"}]},
        {"role": "tool", "content": "5 rows", "tool_call_id": "1"},
        {"role": "assistant", "content": "Found 6 listings. Top: Bar.", "tool_calls": [{"id": "2"}]},
    ]
    _drop_echoed_assistant_content(messages)
    assert "Found 6 listings" in messages[-1]["content"]


def test_purify_drops_listings_without_provenance():
    blocks = [
        {
            "type": "listing_cards",
            "items": [
                {"title": "Hallucinated Villa", "price": "10L"},
                {"title": "Greenview", "price": "1.95L", "listing_id": "real-1"},
            ],
        }
    ]
    cleaned, dropped = _purify_listing_blocks(blocks)
    assert dropped == 1
    assert cleaned[0]["type"] == "listing_cards"
    assert len(cleaned[0]["items"]) == 1
    assert cleaned[0]["items"][0]["listing_id"] == "real-1"


def test_purify_collapses_to_error_when_all_hallucinated():
    blocks = [
        {
            "type": "listing_cards",
            "items": [
                {"title": "Imaginary Tower", "price": "1L"},
                {"title": "Imaginary Tower 2", "price": "2L"},
            ],
        }
    ]
    cleaned, dropped = _purify_listing_blocks(blocks)
    assert dropped == 2
    assert cleaned[0]["type"] == "error_state"


def test_normalize_response_replaces_hallucinated_blocks():
    payload = (
        "```json\n"
        "{\"content\": \"Here are top picks.\", \"blocks\": ["
        "{\"type\": \"listing_cards\", \"items\": ["
        "{\"title\": \"Made-up Building\", \"price\": \"2L\"}"
        "]}]}\n"
        "```"
    )
    response = normalize_workspace_response(payload, sources={"portal_listings": {"df": []}})
    types = [b.get("type") for b in response["blocks"]]
    assert "error_state" in types
    assert "Here are top picks" in response["content"]
