"""Provider-specific formatting for OpenAI-compatible chat messages."""

from __future__ import annotations

from typing import Any


def prepare_messages(messages: list[dict[str, Any]], base_url: str) -> list[dict[str, Any]]:
    """Keep cached blocks where supported; send Sarvam plain text content."""
    if "sarvam" not in (base_url or "").lower():
        from ai_chat_engine import _cached_system_blocks

        return [
            {**message, "content": _cached_system_blocks(message["content"])}
            if message.get("role") == "system" and isinstance(message.get("content"), str)
            else message
            for message in messages
        ]
    return [
        {**message, "content": str(message.get("content") or "")}
        if message.get("role") in {"system", "user"}
        else message
        for message in messages
    ]
