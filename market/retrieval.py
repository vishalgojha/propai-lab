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


def sort_retrieval_results(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Rank exact locality/source matches before nearby and broad matches."""
    def score(row: dict[str, Any]) -> tuple[int, int, int, str]:
        scope = str(row.get("match_scope") or "unspecified").casefold()
        scope_score = {"exact": 3, "nearby": 2, "nearby_or_broad": 1}.get(scope, 0)
        source_score = 1 if row.get("source_text") or row.get("original_message") else 0
        confidence = int(float(row.get("confidence") or row.get("extraction_confidence") or 0) * 100)
        return scope_score, source_score, confidence, _timestamp(row)

    return sorted(dedupe_results(rows), key=score, reverse=True)
