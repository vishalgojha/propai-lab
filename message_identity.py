"""Stable identity helpers for WhatsApp message observations."""

from __future__ import annotations

import hashlib
import re
import unicodedata


_PROTOCOL_MESSAGE_TYPES = {
    "protocol",
    "protocolmessage",
    "senderkeydistributionmessage",
    "sender_key_distribution_message",
}
_PROTOCOL_PAYLOAD_KEYS = {
    "senderKeyDistributionMessage",
    "protocolMessage",
}


def _payload_has_key(value: object, keys: set[str]) -> bool:
    """Return whether a structured WhatsApp payload contains a control key."""
    if isinstance(value, dict):
        if any(key in value for key in keys):
            return True
        return any(_payload_has_key(child, keys) for child in value.values())
    if isinstance(value, list):
        return any(_payload_has_key(child, keys) for child in value)
    return False


def is_protocol_event(
    *, message: str = "", message_type: str = "", raw_payload: object = None
) -> bool:
    """Identify WhatsApp transport/control events before extraction.

    ``messageContextInfo`` is deliberately not a standalone marker: it can be
    attached to an ordinary text message. A payload key is treated as a
    protocol event only when the projected message body is blank, so real
    listing text always remains eligible for extraction.
    """
    normalized_type = str(message_type or "").strip().casefold().replace(" ", "")
    if normalized_type in _PROTOCOL_MESSAGE_TYPES:
        return True
    if str(message or "").strip():
        return False
    return _payload_has_key(raw_payload, _PROTOCOL_PAYLOAD_KEYS)


def author_identity(sender_phone: str = "", sender_jid: str = "") -> str:
    """Prefer the resolved phone JID, retaining the original JID as fallback."""
    phone = re.sub(r"\D+", "", str(sender_phone or ""))
    if phone:
        return f"phone:{phone}"
    jid = str(sender_jid or "").strip().casefold()
    return f"jid:{jid}" if jid else ""


def normalize_message_content(message: str = "") -> str:
    """Normalize transport-only variation, not broker content.

    We intentionally do not remove dates, prices, emojis, or punctuation: a
    material broker edit must produce a new fingerprint and be re-extracted.
    """
    text = unicodedata.normalize("NFKC", str(message or "")).replace("\r\n", "\n")
    text = "\n".join(re.sub(r"[ \t]+", " ", line).strip() for line in text.split("\n"))
    return re.sub(r"\n{3,}", "\n\n", text).strip().casefold()


def author_content_fingerprint(*, sender_phone: str = "", sender_jid: str = "", message: str = "") -> str:
    identity = author_identity(sender_phone, sender_jid)
    # Keep the exact-copy fingerprint aligned with the extraction cache. This
    # removes transport-only wrapping/whitespace and forwarding banners while
    # preserving prices, dates, punctuation, and broker content.
    from extraction_dedup import normalize_for_hash

    content = normalize_for_hash(message).casefold()
    if not identity or not content:
        return ""
    return hashlib.sha256(f"{identity}\0{content}".encode("utf-8")).hexdigest()
