"""Shared filters for building-name extraction and display."""

from __future__ import annotations

import re

_PHRASES = {
    "with amenities",
    "for visit",
    "ready to move",
    "multiple options",
    "with parking",
    "with lift",
    "with gym",
    "with pool",
    "for sale",
    "for rent",
    "for lease",
    "available now",
    "new listing",
    "best price",
    "prime location",
    "good deal",
    "urgent sale",
    "quick sale",
    "direct owner",
    "no broker",
    "under construction",
    "immediate possession",
    "verified",
    "verified listing",
    "premium",
    "luxury",
    "spacious",
    "well maintained",
    "well ventilated",
    "good view",
    "good location",
    "contact for",
    "call for",
}

_PLACEHOLDERS = {
    "extracted message",
    "extracted building",
    "unknown building",
    "unknown",
    "observation",
    "building",
    "property",
    "listing",
    "message",
}


def _normalize(text: str | None) -> str:
    value = " ".join((text or "").strip().split()).lower()
    value = re.sub(r"[\u2013\u2014–—]", "-", value)
    return value


def is_descriptive_building_candidate(text: str | None) -> bool:
    value = _normalize(text)
    if not value:
        return False
    return any(phrase in value for phrase in _PHRASES)


def is_placeholder_building_name(text: str | None) -> bool:
    value = _normalize(text)
    if not value:
        return False
    return value in _PLACEHOLDERS or value.startswith("extracted ")


def is_valid_building_candidate(text: str | None) -> bool:
    value = " ".join((text or "").strip().split())
    if not value or len(value) < 3:
        return False
    if is_placeholder_building_name(value) or is_descriptive_building_candidate(value):
        return False
    if sum(c.isdigit() for c in value) > len(value) * 0.5:
        return False
    return True


def clean_building_candidate(text: str | None) -> str | None:
    if not is_valid_building_candidate(text):
        return None
    value = " ".join((text or "").strip().split()).strip(" .,:;!?")
    value = re.sub(r"^(the|a|an)\s+", "", value, flags=re.IGNORECASE)
    return value or None
