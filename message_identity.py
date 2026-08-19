"""Stable identity helpers for WhatsApp message observations."""

from __future__ import annotations

import hashlib
import re
import unicodedata


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
    content = normalize_message_content(message)
    if not identity or not content:
        return ""
    return hashlib.sha256(f"{identity}\0{content}".encode("utf-8")).hexdigest()
