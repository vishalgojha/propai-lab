"""Deterministic multi-listing splitters for broker broadcast messages.

The goal is intentionally narrow:

- recognize recurring broadcast templates;
- split them into per-listing chunks;
- extract the stable, low-variance fields with regexes;
- leave free-form fallback to the main extraction pipeline.

This module is conservative. If a pattern is not convincing, it returns
``None`` and the caller can fall back to the LLM path.
"""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Iterable

PATTERN_DASH_SEPARATOR = "dash_separator"
PATTERN_NUMBERED = "numbered"
PATTERN_EMOJI_BULLET = "emoji_bullet"
PATTERN_BARE_BHK = "bare_bhk_header"

PATTERN_ORDER = [
    PATTERN_DASH_SEPARATOR,
    PATTERN_NUMBERED,
    PATTERN_EMOJI_BULLET,
    PATTERN_BARE_BHK,
]

_BHK_HEADER_RE = re.compile(
    r"(?im)^\s*(?:\*+)?\s*(?:[🏡▪️▫️•]\s*)?(?:\d+(?:\.\d+)?\s*(?:bhk|rk)\b|\brk\b)"
)
_DASH_LINE_RE = re.compile(r"^\s*(?:[-–—_=]{3,}|[─━]{3,}|•{3,}|·{3,})\s*$")
_NUMBERED_LINE_RE = re.compile(r"^\s*\d+[.)]\s+")
_EMOJI_BULLET_LINE_RE = re.compile(r"^\s*(?:🏡|▪️|▫️|•|‣|➤)\s+")
_BHK_LINE_RE = re.compile(r"(?im)^\s*(?:\*+)?\s*(?:\d+(?:\.\d+)?\s*(?:bhk|rk)\b|\brk\b)")

_FURNISHING_RE = re.compile(
    r"(?i)\b("
    r"fully\s*furnished|semi\s*furnished|semi[-\s]?furnished|unfurnished|furnished"
    r")\b"
)
_PARKING_RE = re.compile(r"(?i)\b(\d+)\s*(?:car\s+)?parking\b")
_FLOOR_RE = re.compile(
    r"(?i)\b(?:floor|flr|level)\s*(?:[:\-]?\s*)?(\d+(?:st|nd|rd|th)?(?:\s*[-/]\s*\d+(?:st|nd|rd|th)?)?)"
)
_AREA_RE = re.compile(
    r"(?i)\b(?:carpet|built\s*up|super\s*built\s*up|usable|area|sq\.?\s*ft|sqft)\b"
    r"[^0-9]{0,12}([\d,]+(?:\.\d+)?)\s*(sqft|sq\.?\s*ft|sft)?"
)
_PRICE_RE = re.compile(
    r"(?i)(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d+)?)\s*(cr|crore|crores|lac|lacs|lakh|lakhs|l|k)\b"
)
_INTENT_RENT_RE = re.compile(r"(?i)\b(?:rent|rental|lease|lease\s+out|for\s+rent)\b")
_INTENT_SALE_RE = re.compile(r"(?i)\b(?:sale|sell|selling|for\s+sale)\b")
_INTENT_REQ_RE = re.compile(r"(?i)\b(?:requirement|required|wanted|looking\s+for|need)\b")


def _line_items(text: str) -> list[str]:
    return [line.rstrip() for line in (text or "").replace("\r", "").split("\n")]


def _compact(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip())


def _header_count(text: str) -> int:
    return len(_BHK_HEADER_RE.findall(text or ""))


def _normalize_bhk(text: str) -> str | None:
    if not text:
        return None
    cleaned = str(text).strip().upper()
    if "RK" in cleaned:
        return "1 RK"
    match = re.search(r"(\d+(?:\.\d+)?)", cleaned)
    if not match:
        return None
    value = float(match.group(1))
    if value == 0.5:
        return "1 RK"
    if value.is_integer():
        return f"{int(value)} BHK"
    return f"{value:g} BHK"


def _extract_bhk(text: str) -> str | None:
    match = re.search(r"(?i)\b(\d+(?:\.\d+)?)\s*(bhk|rk)\b", text or "")
    if match:
        return _normalize_bhk(f"{match.group(1)} {match.group(2)}")
    if re.search(r"(?i)\brk\b", text or ""):
        return "1 RK"
    return None


def _extract_price(text: str) -> tuple[float | None, str | None]:
    match = _PRICE_RE.search(text or "")
    if not match:
        return None, None
    try:
        amount = float(match.group(1).replace(",", ""))
    except ValueError:
        return None, None
    unit = match.group(2).lower()
    if unit in {"crore", "crores"}:
        unit = "cr"
    elif unit in {"lac", "lacs", "lakh", "lakhs"}:
        unit = "lac"
    elif unit == "l":
        unit = "lac"
    elif unit == "k":
        unit = "K"
    return amount, unit


def _extract_area_sqft(text: str) -> float | None:
    match = _AREA_RE.search(text or "")
    if not match:
        return None
    try:
        return float(match.group(1).replace(",", ""))
    except ValueError:
        return None


def _extract_furnishing(text: str) -> str | None:
    match = _FURNISHING_RE.search(text or "")
    if not match:
        return None
    value = match.group(1).lower().replace(" ", "_").replace("-", "_")
    if value == "semi_furnished":
        return "semi_furnished"
    if value == "fully_furnished":
        return "fully_furnished"
    if value == "furnished":
        return "fully_furnished"
    if value == "unfurnished":
        return "unfurnished"
    return None


def _extract_parking(text: str) -> int | None:
    match = _PARKING_RE.search(text or "")
    if not match:
        return None
    try:
        return int(match.group(1))
    except ValueError:
        return None


def _extract_floor(text: str) -> str | None:
    match = _FLOOR_RE.search(text or "")
    if not match:
        return None
    return match.group(1).strip()


def _extract_intent(text: str) -> str | None:
    if _INTENT_REQ_RE.search(text or ""):
        return "BUY"
    if _INTENT_RENT_RE.search(text or ""):
        return "RENT"
    if _INTENT_SALE_RE.search(text or ""):
        return "SELL"
    return None


def _is_signal_line(line: str) -> bool:
    cleaned = line.strip()
    if not cleaned:
        return False
    if _DASH_LINE_RE.match(cleaned):
        return True
    if _NUMBERED_LINE_RE.match(cleaned):
        return True
    if _EMOJI_BULLET_LINE_RE.match(cleaned):
        return True
    if _BHK_LINE_RE.match(cleaned):
        return True
    return False


def _choose_text_line(lines: list[str]) -> str | None:
    for line in lines:
        cleaned = line.strip(" \t*•▪️▫️🏡")
        if not cleaned:
            continue
        if _is_signal_line(cleaned):
            continue
        if re.search(r"(?i)\b(?:floor|parking|carpet|sqft|rent|sale|lakh|lac|crore|cr|k|furnished|unfurnished)\b", cleaned):
            continue
        if len(cleaned.split()) <= 1:
            continue
        return cleaned
    return None


def _strip_markers(line: str) -> str:
    cleaned = line.strip()
    cleaned = re.sub(r"^\d+[.)]\s+", "", cleaned)
    cleaned = re.sub(r"^(?:🏡|▪️|▫️|•|‣|➤)\s+", "", cleaned)
    cleaned = re.sub(r"^\*+", "", cleaned)
    cleaned = re.sub(r"\*+$", "", cleaned)
    return cleaned.strip()


def _split_on_predicate(lines: list[str], predicate) -> list[str]:
    chunks: list[list[str]] = []
    current: list[str] = []
    for line in lines:
        if predicate(line) and current:
            chunks.append(current)
            current = [line]
            continue
        current.append(line)
    if current:
        chunks.append(current)
    return ["\n".join(chunk).strip() for chunk in chunks if "\n".join(chunk).strip()]


def _split_dash_separator(text: str) -> list[str] | None:
    lines = _line_items(text)
    if not any(_DASH_LINE_RE.match(line or "") for line in lines):
      return None
    chunks: list[str] = []
    current: list[str] = []
    for line in lines:
        if _DASH_LINE_RE.match(line or ""):
            if current:
                chunks.append("\n".join(current).strip())
                current = []
            continue
        current.append(line)
    if current:
        chunks.append("\n".join(current).strip())
    chunks = [chunk for chunk in chunks if _extract_bhk(chunk) or _PRICE_RE.search(chunk) or _AREA_RE.search(chunk)]
    return chunks or None


def _split_numbered(text: str) -> list[str] | None:
    lines = _line_items(text)
    if not any(_NUMBERED_LINE_RE.match(line or "") for line in lines):
        return None
    chunks = _split_on_predicate(lines, lambda line: bool(_NUMBERED_LINE_RE.match(line or "")))
    chunks = [chunk for chunk in chunks if _extract_bhk(chunk) or _PRICE_RE.search(chunk) or _AREA_RE.search(chunk)]
    return chunks or None


def _split_emoji_bullet(text: str) -> list[str] | None:
    lines = _line_items(text)
    if not any(_EMOJI_BULLET_LINE_RE.match(line or "") for line in lines):
        return None
    chunks = _split_on_predicate(lines, lambda line: bool(_EMOJI_BULLET_LINE_RE.match(line or "")))
    chunks = [chunk for chunk in chunks if _extract_bhk(chunk) or _PRICE_RE.search(chunk) or _AREA_RE.search(chunk)]
    return chunks or None


def _split_bare_bhk(text: str) -> list[str] | None:
    lines = _line_items(text)
    start_indices = [idx for idx, line in enumerate(lines) if _BHK_LINE_RE.match(line or "")]
    if len(start_indices) < 2:
        return None
    chunks: list[str] = []
    for pos, start in enumerate(start_indices):
        end = start_indices[pos + 1] if pos + 1 < len(start_indices) else len(lines)
        chunk = "\n".join(lines[start:end]).strip()
        if chunk:
            chunks.append(chunk)
    chunks = [chunk for chunk in chunks if _extract_bhk(chunk) or _PRICE_RE.search(chunk) or _AREA_RE.search(chunk)]
    return chunks or None


def split_message_into_chunks(text: str, preferred_pattern: str | None = None) -> tuple[str | None, list[str]]:
    """Return the best splitter pattern and the resulting chunks.

    The first accepted pattern in :data:`PATTERN_ORDER` wins. A pattern is
    accepted when it yields at least two chunks and the chunk count matches
    the number of BHK-style headers in the message.
    """
    if not text or len(text.strip()) < 10:
        return None, []

    pattern_to_splitter = {
        PATTERN_DASH_SEPARATOR: _split_dash_separator,
        PATTERN_NUMBERED: _split_numbered,
        PATTERN_EMOJI_BULLET: _split_emoji_bullet,
        PATTERN_BARE_BHK: _split_bare_bhk,
    }
    headers = _header_count(text)
    pattern_ids = [preferred_pattern] if preferred_pattern in PATTERN_ORDER else []
    pattern_ids.extend(pid for pid in PATTERN_ORDER if pid != preferred_pattern)
    for pattern_id in pattern_ids:
        splitter = pattern_to_splitter[pattern_id]
        chunks = splitter(text) or []
        if len(chunks) >= 2 and (headers == 0 or len(chunks) == headers):
            return pattern_id, chunks
    return None, []


def parse_chunk(chunk: str) -> dict:
    """Extract stable fields from one listing chunk."""
    lines = [line.strip() for line in _line_items(chunk) if line.strip()]
    first_text_line = _choose_text_line(lines)
    # Remove the header marker before scanning the rest of the chunk.
    body = "\n".join(_strip_markers(line) for line in lines)
    bhk = _extract_bhk(body)
    price, price_unit = _extract_price(body)
    intent = _extract_intent(body)
    area_sqft = _extract_area_sqft(body)
    furnishing = _extract_furnishing(body)
    parking = _extract_parking(body)
    floor = _extract_floor(body)

    building_name = None
    location_raw = None
    if first_text_line:
        if "," in first_text_line:
            left, right = [part.strip() for part in first_text_line.split(",", 1)]
            if left and len(left.split()) >= 2:
                building_name = left
            if right:
                location_raw = right
        elif re.search(r"(?i)\b(?:near|at|location|loc\.?)\b", first_text_line):
            location_raw = first_text_line
        else:
            building_name = first_text_line

    result = {
        "intent": intent,
        "bhk": bhk,
        "price": price,
        "price_unit": price_unit,
        "area_sqft": area_sqft,
        "furnishing": furnishing,
        "car_parking_count": parking,
        "floor_range": floor,
        "building_name": building_name,
        "location_raw": location_raw,
        "micro_market": location_raw,
        "message_type": intent.lower() if intent else "listing",
        "raw_payload": {"full_text": chunk, "slice_text": chunk},
        "normalized_message": _compact(chunk),
        "confidence": 1.0,
        "summary_title": first_text_line or bhk or "Listing",
        "monthly_rent": price if intent == "RENT" else None,
        "total_asking_price": price if intent == "SELL" else None,
    }
    return result


def parse_message(text: str, preferred_pattern: str | None = None) -> tuple[str | None, list[dict]]:
    """Parse a text into structured chunks, or return ``(None, [])``."""
    pattern_id, chunks = split_message_into_chunks(text, preferred_pattern=preferred_pattern)
    if not pattern_id:
        return None, []
    return pattern_id, [parse_chunk(chunk) for chunk in chunks]
