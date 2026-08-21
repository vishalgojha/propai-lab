"""Deterministic structured extraction from Crawl4AI page text."""

from __future__ import annotations

import re
from typing import Any


_FIELD_LABELS = {
    "address": r"(?:full\s+)?address|location|located\s+at|situated\s+at",
    "developer": r"developer|developed\s+by|promoter",
    "nearby_metro": r"nearest\s+metro|metro\s+station|metro",
    "nearby_landmarks": r"nearby\s+landmarks?|landmarks?|near\s+by|close\s+to",
    "nearby_roads": r"nearby\s+roads?|roads?|road\s+access",
    "completion_status": r"completion\s+status|possession\s+status|project\s+status",
}

_AMENITIES = (
    "lift", "elevator", "parking", "gym", "fitness centre", "fitness center",
    "swimming pool", "pool", "clubhouse", "security", "cctv", "garden",
    "play area", "children's play area", "power backup", "intercom",
    "rainwater harvesting", "fire safety", "visitor parking", "jogging track",
)


def _clean(value: str, limit: int = 500) -> str:
    value = re.sub(r"\s+", " ", str(value or "")).strip(" \t\r\n:|-•")
    return value[:limit].strip()


def _label_value(text: str, label_pattern: str) -> tuple[str, str] | None:
    match = re.search(rf"(?im)^(?:[-*•]\s*)?(?:{label_pattern})\s*[:\-–]\s*(.+)$", text)
    if not match:
        return None
    value = _clean(match.group(1))
    return (value, match.group(0).strip()) if value else None


def _rera(text: str) -> tuple[str, str] | None:
    match = re.search(
        r"(?i)\b(?:maha)?rera(?:\s+(?:no|number|id))?\s*[:#\-]?\s*([A-Z]{0,4}\s*\d{6,})\b",
        text,
    ) or re.search(r"\b(P\d{8,})\b", text, flags=re.IGNORECASE)
    if not match:
        return None
    value = re.sub(r"\s+", "", match.group(1)).upper()
    return value, _clean(match.group(0))


def _coordinates(text: str) -> dict[str, tuple[float, str]]:
    result: dict[str, tuple[float, str]] = {}
    for field, pattern in {
        "latitude": r"(?i)\b(?:lat|latitude)\s*[:=]\s*(-?\d{1,2}\.\d+)\b",
        "longitude": r"(?i)\b(?:lon|lng|longitude)\s*[:=]\s*(-?\d{1,3}\.\d+)\b",
    }.items():
        match = re.search(pattern, text)
        if not match:
            continue
        value = float(match.group(1))
        if (field == "latitude" and -90 <= value <= 90) or (field == "longitude" and -180 <= value <= 180):
            result[field] = (value, _clean(match.group(0)))
    return result


def _amenities(text: str) -> tuple[list[str], str] | None:
    lowered = text.casefold()
    found: list[str] = []
    for amenity in _AMENITIES:
        if re.search(rf"(?<!\w){re.escape(amenity)}(?!\w)", lowered):
            canonical = "fitness centre" if amenity == "fitness center" else amenity
            if canonical not in found:
                found.append(canonical)
    if not found:
        return None
    evidence = "; ".join(_clean(line) for line in text.splitlines() if any(a in line.casefold() for a in found))
    return found[:20], evidence[:500]


def extract_structured_fields(title: str = "", text: str = "") -> dict[str, dict[str, Any]]:
    """Return explicit claims as ``field -> value/confidence/evidence``."""
    combined = "\n".join(part for part in (title, text) if part)
    labels = {
        "address": r"(?:full\s+)?address|location|located\s+at|situated\s+at",
        "developer": r"developer|developed\s+by|promoter",
        "nearby_metro": r"nearest\s+metro|metro\s+station|metro",
        "nearby_landmarks": r"nearby\s+landmarks?|landmarks?|near\s+by|close\s+to",
        "nearby_roads": r"nearby\s+roads?|roads?|road\s+access",
        "completion_status": r"completion\s+status|possession\s+status|project\s+status",
    }
    extracted: dict[str, dict[str, Any]] = {}
    for field, pattern in labels.items():
        pair = _label_value(combined, pattern)
        if pair:
            extracted[field] = {"value": pair[0], "confidence": 0.82, "evidence": pair[1]}
    pair = _rera(combined)
    if pair:
        extracted["rera_number"] = {"value": pair[0], "confidence": 0.9, "evidence": pair[1]}
    for field, pair in _coordinates(combined).items():
        extracted[field] = {"value": pair[0], "confidence": 0.8, "evidence": pair[1]}
    amenity_result = _amenities(combined)
    if amenity_result:
        values, evidence = amenity_result
        extracted["amenities"] = {"value": values, "confidence": 0.72, "evidence": evidence}
    return extracted
