"""Deterministic identities for durable enrichment results.

The cache is deliberately separate from listing identity.  It can prevent
repeat provider calls for an entity, but it can never merge or create a
listing.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any


CACHE_VERSION = "entity-enrichment-v1"


def normalize_entity_part(value: Any) -> str:
    """Normalize a cache-key component without changing its meaning."""
    return re.sub(r"\s+", " ", str(value or "").strip().casefold())


def entity_cache_key(
    entity_type: str,
    *,
    entity_id: Any = None,
    name: Any = None,
    locality: Any = None,
) -> str:
    """Return a stable, locality-scoped identity for an enrichment entity."""
    kind = normalize_entity_part(entity_type)
    if kind == "building" and entity_id is not None:
        identity = f"id:{int(entity_id)}"
    else:
        identity = normalize_entity_part(name)
    market = normalize_entity_part(locality) or "mumbai"
    if not identity:
        raise ValueError("enrichment entity needs an id or name")
    return f"{kind}:{identity}|locality:{market}"


def evidence_fingerprint(evidence: dict | None) -> str:
    """Hash bounded source evidence so changed evidence invalidates the cache."""
    packet = evidence or {}
    encoded = json.dumps(packet, sort_keys=True, ensure_ascii=False, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()
