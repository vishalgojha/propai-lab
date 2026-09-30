"""Shared market retrieval primitives."""

from .retrieval import (
    dedupe_results,
    normalize_search_text,
    result_identity,
    sort_retrieval_results,
)

__all__ = [
    "dedupe_results",
    "normalize_search_text",
    "result_identity",
    "sort_retrieval_results",
]
