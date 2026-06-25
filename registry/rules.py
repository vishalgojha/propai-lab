"""
Normalization Rules Engine — delegates to the YAML-based strategy manager.

Legacy adapter that re-exports the strategy manager API so existing
code in build.py continues to work without changes.
"""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from knowledge.normalization import (
    apply_strategies,
    canonicalize as _canonicalize,
    building_fingerprint as _fingerprint,
    get_strategies,
    summarize_strategies,
)


def apply_rules(name: str, area: str = "", developer: str = "") -> list[tuple[str, str, str]]:
    """Apply all auto-apply strategies. Returns list of (strategy_id, before, after)."""
    result = name
    changes = []
    for s in get_strategies():
        if not s.auto_apply:
            continue
        if not s.applies(result, area, developer):
            continue
        before = result
        after = s.transform(result)
        if before != after:
            changes.append((s.id, before, after))
            result = after
    return changes


def canonicalize(name: str, area: str = "", developer: str = "") -> str:
    """Apply all auto-apply rules and return the canonical form."""
    result, _ = apply_strategies(name, area, developer)
    return result


def building_fingerprint(canonical_name: str, developer: str | None,
                         area: str, lat: float | None, lng: float | None) -> str:
    """Stable SHA256 fingerprint for a building."""
    return _fingerprint(canonical_name, developer, area, lat, lng)


def save_rules():
    """Save is a no-op — strategies are YAML files tracked in Git."""
    pass


from knowledge.normalization import summarize_knowledge_base as _summarize_kb, is_negative_knowledge as _is_neg


def get_knowledge_summary() -> dict:
    return _summarize_kb()


def is_known_different(name_a: str, name_b: str, area: str = "") -> bool:
    return _is_neg(name_a, name_b, area)


# Re-export for compatibility
RULES = get_strategies()
