"""Shared, source-neutral retrieval normalization and ranking.

Database adapters remain responsible for fetching rows. This module owns the
rules that must be identical in self-chat, Inbox, and raw-evidence responses:
Unicode normalization, source identity, exact-versus-nearby precedence, and
deterministic deduplication.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Iterable
import unicodedata


def normalize_search_text(value: Any) -> str:
    """Normalize WhatsApp formatting without changing the displayed value."""
    return " ".join(
        unicodedata.normalize("NFKC", str(value or "")).casefold().split()
    )


def result_identity(row: dict[str, Any]) -> tuple[str, str, str]:
    """Return a stable identity across typed and raw retrieval projections."""
    raw_id = str(row.get("raw_message_id") or row.get("message_id") or "")
    source_id = str(row.get("listing_id") or row.get("requirement_id") or row.get("id") or "")
    group = normalize_search_text(row.get("group_name") or row.get("group_jid") or "")
    text = normalize_search_text(
        row.get("source_text") or row.get("original_message") or row.get("message") or ""
    )[:240]
    return raw_id, source_id or group, text


def dedupe_results(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Deduplicate while preserving the highest-ranked first occurrence."""
    seen: set[tuple[str, str, str]] = set()
    output: list[dict[str, Any]] = []
    for row in rows:
        key = result_identity(row)
        if key in seen:
            continue
        seen.add(key)
        output.append(row)
    return output


def _timestamp(row: dict[str, Any]) -> str:
    return str(row.get("timestamp") or row.get("last_seen") or row.get("created_at") or "")


_CONFIDENCE_LABELS = {
    "very_low": 20,
    "low": 40,
    "medium": 65,
    "med": 65,
    "moderate": 65,
    "high": 85,
    "very_high": 95,
}


def confidence_score(value: Any) -> int:
    """Score confidence that may arrive as a number or a low/medium/high label."""
    if value is None or isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        number = float(value)
    else:
        label = normalize_search_text(value).replace(" ", "_").replace("-", "_")
        if label in _CONFIDENCE_LABELS:
            return _CONFIDENCE_LABELS[label]
        try:
            number = float(label.rstrip("%")) / 100.0 if label.endswith("%") else float(label)
        except ValueError:
            return 0
    if number > 1.0:
        number = number / 100.0
    return max(0, min(100, int(number * 100)))


def _stable_tiebreaker(row: dict[str, Any]) -> tuple[str, str, str]:
    """Return a total order for rows that rank equally on every other signal.

    Offset pagination is only safe when the ranked order is deterministic:
    without a final tiebreaker, growing the fetch window can reshuffle tied
    rows and make one page repeat records the previous page already returned.
    """
    identifier = str(row.get("raw_message_id") or row.get("message_id") or row.get("id") or "")
    digits = "".join(character for character in identifier if character.isdigit())
    return str(row.get("source_schema") or ""), digits.zfill(12), identifier


def sort_retrieval_results(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Rank exact locality/source matches before nearby and broad matches."""
    def score(row: dict[str, Any]) -> tuple[int, int, int, str, str, str, str]:
        scope = str(row.get("match_scope") or "unspecified").casefold()
        scope_score = {"exact": 3, "nearby": 2, "nearby_or_broad": 1}.get(scope, 0)
        source_score = 1 if row.get("source_text") or row.get("original_message") else 0
        confidence = confidence_score(row.get("confidence") or row.get("extraction_confidence"))
        schema, padded_id, identifier = _stable_tiebreaker(row)
        return scope_score, source_score, confidence, _timestamp(row), schema, padded_id, identifier

    return sorted(dedupe_results(rows), key=score, reverse=True)
