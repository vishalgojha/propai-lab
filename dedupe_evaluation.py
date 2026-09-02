"""Metrics for a human-reviewed dedupe evaluation corpus.

This module evaluates the dedupe decision, not listing identity. A reviewed
case must say whether two observations are truly the same repost. No semantic
merge is performed here and no production rows are touched.
"""

from collections.abc import Iterable, Mapping
from typing import Any


def evaluate_reviewed_cases(cases: Iterable[Mapping[str, Any]]) -> dict[str, int | float]:
    """Summarize reviewed duplicate decisions with explicit denominators."""
    rows = list(cases)
    eligible = len(rows)
    expected_duplicates = sum(bool(row.get("expected_duplicate")) for row in rows)
    reused = sum(bool(row.get("observed_reused")) for row in rows)
    false_merges = sum(
        bool(row.get("observed_reused")) and not bool(row.get("expected_duplicate"))
        for row in rows
    )
    missed_duplicates = sum(
        bool(row.get("expected_duplicate")) and not bool(row.get("observed_reused"))
        for row in rows
    )
    return {
        "reviewed_cases": eligible,
        "expected_duplicates": expected_duplicates,
        "suppressed_duplicates": reused,
        "model_calls_avoided": reused,
        "false_merges": false_merges,
        "missed_duplicates": missed_duplicates,
        "suppression_rate": round(reused / eligible, 4) if eligible else 0.0,
        "duplicate_recall": round(
            (expected_duplicates - missed_duplicates) / expected_duplicates, 4
        ) if expected_duplicates else 0.0,
    }
