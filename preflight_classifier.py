"""Single ownership point for pre-AI WhatsApp document classification.

This module deliberately classifies structure only. It does not extract facts,
call a provider, resolve buildings, or persist rows. The existing deterministic
splitters remain low-level boundary primitives; callers should use
``classify_message`` when they need the document-level decision.
"""

from __future__ import annotations

import re
from dataclasses import dataclass


_BLOCK_START_KEYWORDS = (
    "available", "requirement", "requirements", "wanted", "looking for",
    "need", "offer", "offering", "for sale", "for rent", "lease",
    "rental", "inventory", "project", "building", "tower", "flat",
    "apartment", "residential", "commercial", "office", "shop", "plot",
    "showroom", "warehouse", "godown", "villa", "bungalow", "duplex",
    "jodi", "pre launch", "prelaunch", "new launch", "market update",
    "update", "broadcast", "group", "broker", "property", "realty",
    "estate", "exclusive", "urgent", "hot", "direct", "with pictures",
)


@dataclass(frozen=True)
class PreflightClassification:
    """Stable structural metadata passed to later extraction stages."""

    document_type: str
    pattern_id: str | None
    block_count: int
    signals: tuple[str, ...]

    def as_dict(self) -> dict[str, object]:
        """Return the provider/persistence-safe representation of the result."""
        return {
            "document_type": self.document_type,
            "pattern_id": self.pattern_id,
            "block_count": self.block_count,
            "signals": list(self.signals),
        }


def is_numbered_item(line: str) -> bool:
    return bool(re.match(r"^\s*\d{1,3}[)\.\-:](?!\d)\s*\S+", line))


def is_explicit_heading(line: str) -> bool:
    stripped = line.strip()
    if not stripped:
        return False
    lowered = stripped.lower()
    if re.fullmatch(r"\d+(?:\.\d+)?\s*(?:bhk|rk)", lowered):
        return False
    if re.fullmatch(r"\d+(?:\.\d+)?\s*(?:carpet|built[- ]?up|super[- ]?built[- ]?up|sq\.?\s*ft\.?|sqft|sq\.?\s*m\.?)", lowered):
        return False
    if re.fullmatch(r"(?:rent|quote|price|deposit)\s*[:\-]?\s*.*", lowered):
        return False
    if re.fullmatch(r"(?:lower|middle|higher)\s+floor", lowered):
        return False
    if re.fullmatch(r"(?:semi|fully)\s*furnished", lowered) or lowered in {"unfurnished", "furnished"}:
        return False
    if lowered.startswith(("available", "requirement", "requirements")):
        return True
    if any(keyword in lowered for keyword in _BLOCK_START_KEYWORDS):
        return len(re.findall(r"\b[\w&/-]+\b", stripped)) <= 12 and len(stripped) <= 96
    if stripped == stripped.upper() and len(stripped) <= 96:
        return sum(1 for char in stripped if char.isalpha()) >= 4
    if len(stripped) <= 64 and stripped[0].isalpha() and stripped[-1] not in ".!?":
        word_count = len(re.findall(r"\b[\w&/-]+\b", stripped))
        titleish = stripped == stripped.title() or any(part.isupper() for part in stripped.split())
        return 1 <= word_count <= 8 and titleish and any(
            keyword in lowered
            for keyword in ("bhk", "rent", "sale", "lease", "group", "tower", "project", "building", "flat", "apartment", "estate", "realty", "properties", "available")
        )
    return False


def is_block_start(line: str) -> bool:
    return bool(line.strip()) and (is_numbered_item(line.strip()) or is_explicit_heading(line.strip()))


def classify_document_type(text: str) -> str:
    """Classify a message without interpreting its property fields."""
    non_empty = [line.strip() for line in (text or "").splitlines() if line.strip()]
    if not non_empty:
        return "Unknown"
    starts = [line for line in non_empty if is_block_start(line)]
    if not starts:
        lowered = " ".join(non_empty).lower()
        if any(word in lowered for word in ("hello", "hi", "thanks", "thank you", "good morning", "good evening", "how are you")):
            return "Discussion"
        if any(word in lowered for word in ("update", "today", "yesterday", "status")):
            return "Update"
        return "Unknown"
    lowered = " ".join(non_empty).lower()
    has_requirement = any(word in lowered for word in ("requirement", "wanted", "looking for", "need "))
    has_listing = any(word in lowered for word in ("available", "for rent", "for sale", "lease", "inventory", "offer"))
    if has_requirement and has_listing:
        return "Mixed Listing + Requirement"
    if has_requirement:
        return "Requirement"
    if len(starts) > 1:
        return "Multi Listing"
    return "Single Listing"


def classify_message(text: str) -> PreflightClassification:
    """Return the shared structural classification used by all callers."""
    from deterministic_splitters import split_message_into_chunks

    pattern_id, chunks = split_message_into_chunks(text or "")
    signals: list[str] = []
    value = text or ""
    if re.search(r"(?im)^\s*\d{1,3}[)\.\-:]\s*\S+", value):
        signals.append("numbered_items")
    if re.search(r"[📍🏠🔑🏡]", value):
        signals.append("emoji_anchors")
    if re.search(r"(?im)^\s*[-•]\s+", value):
        signals.append("bullet_fields")
    if re.search(r"(?i)\b(?:requirement|looking for|wanted|need)\b", value):
        signals.append("requirement_cue")
    if re.search(r"(?i)\b(?:rent|lease|rental)\b", value):
        signals.append("rent_cue")
    if re.search(r"(?i)\b(?:sale|asking)\b", value):
        signals.append("sale_cue")
    if re.search(r"(?i)\b(?:office|shop|commercial|warehouse|showroom|godown)\b", value):
        signals.append("commercial_cue")
    return PreflightClassification(
        document_type=classify_document_type(value),
        pattern_id=pattern_id,
        block_count=len(chunks),
        signals=tuple(signals),
    )
