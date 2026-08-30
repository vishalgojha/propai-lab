"""Database-backed locality resolution used by correction workflows."""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def resolve_locality(raw_mention: str | None, storage=None) -> dict:
    """Resolve a locality mention without mutating extracted data."""
    if not raw_mention or not raw_mention.strip():
        return {"resolved_locality": None, "confidence": "low", "raw_mention": raw_mention}

    mention = raw_mention.strip()
    if storage is None:
        return {"resolved_locality": None, "confidence": "low", "raw_mention": mention}

    try:
        db = storage.client if hasattr(storage, "client") else None
        if not db:
            return {"resolved_locality": None, "confidence": "low", "raw_mention": mention}
        columns = "sub_locality, parent_locality, canonical_locality, alternate_names, confidence"
        result = db.table("locality_reference").select(columns).eq(
            "sub_locality", mention
        ).limit(1).execute()
        if not result.data:
            result = db.table("locality_reference").select(columns).contains(
                "alternate_names", [mention]
            ).limit(1).execute()
        if not result.data:
            result = db.table("locality_reference").select(columns).ilike(
                "sub_locality", mention
            ).limit(1).execute()
        if result.data:
            row = result.data[0]
            return {
                "resolved_locality": row.get("canonical_locality") or row.get("parent_locality"),
                "confidence": row.get("confidence") or "medium",
                "raw_mention": mention,
            }
    except Exception:
        logger.warning("locality_reference query failed for %r", mention, exc_info=True)
    return {"resolved_locality": None, "confidence": "low", "raw_mention": mention}
