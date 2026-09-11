"""Provider-specific formatting for OpenAI-compatible chat messages."""

from __future__ import annotations

from typing import Any


def _plain_content(value: Any) -> str:
    """Normalize legacy/history content before an OpenAI-compatible call.

    Older chat rows and provider adapters can leave content as a list or
    object. OpenClaw's gateway accepts only string content for user messages,
    so a single malformed historical row must not make the whole turn fail.
    """
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                text = item.get("text") or item.get("content")
                if text is not None:
                    parts.append(str(text))
        if parts:
            return "\n".join(parts)
    return str(value)


def prepare_messages(messages: list[dict[str, Any]], base_url: str) -> list[dict[str, Any]]:
    """Keep cached blocks where supported; send gateway-safe text content."""
    if "sarvam" not in (base_url or "").lower():
        from ai_chat_engine import _cached_system_blocks

        return [
            {
                **message,
                "content": (
                    _cached_system_blocks(_plain_content(message.get("content")))
                    if message.get("role") == "system" and "openclaw" not in (base_url or "").lower()
                    else _plain_content(message.get("content"))
                ),
            }
            if message.get("role") in {"system", "user", "assistant", "tool"}
            else message
            for message in messages
        ]
    return [
        {**message, "content": _plain_content(message.get("content"))}
        if message.get("role") in {"system", "user"}
        else message
        for message in messages
    ]
