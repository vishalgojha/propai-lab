"""One narrow, typed boundary between source evidence and AI output."""
from __future__ import annotations

from dataclasses import dataclass
import re


@dataclass(frozen=True)
class SourceBoundaryResult:
    explicit_route: str | None
    rent_explicit: bool
    sale_explicit: bool
    reasons: tuple[str, ...] = ()


_RENT_RE = re.compile(r"\b(?:rent|rental|monthly\s+rent|per\s+month|for\s+rent|on\s+rent|for\s+lease|on\s+lease|lease)\b", re.I)
_SALE_RE = re.compile(r"\b(?:sale|selling|for\s+sale|on\s+sale|asking\s+price|outright|outrate)\b", re.I)
_REQUIREMENT_RE = re.compile(r"(?im)^\s*[\W_]*(?:very\s+|urgent\s+|immediate\s+)?(?:(?:buyer|tenant|client)\s+)?(?:requirements?|required|require|wanted|want|need(?:s|ed)?)\b")
_UNIT_RE = re.compile(r"\b\d+(?:\.\d+)?\s*(?:bhk|rk|bedroom)s?\b", re.I)


def classify_source_boundary(source_text: str) -> SourceBoundaryResult:
    """Report explicit source signals; never decide against AI output."""
    source = str(source_text or "")
    rent = bool(_RENT_RE.search(source))
    sale = bool(_SALE_RE.search(source))
    requirement = bool(_REQUIREMENT_RE.search(source))
    inventory_unit = bool(_UNIT_RE.search(source))
    explicit_route = None
    reasons: list[str] = []
    if requirement and not inventory_unit:
        explicit_route = "requirement"
    elif rent and not sale and inventory_unit:
        explicit_route = "rent"
    elif sale and not rent and inventory_unit:
        explicit_route = "sale"
    if rent and sale:
        reasons.append("mixed_rent_sale_source_signals")
    if explicit_route:
        reasons.append(f"explicit_source_route:{explicit_route}")
    return SourceBoundaryResult(explicit_route, rent, sale, tuple(reasons))


def apply_source_boundary(item: dict, source_text: str) -> dict:
    """Attach evidence and flag conflicts without silently rewriting fields."""
    checked = dict(item or {})
    result = classify_source_boundary(source_text)
    model_route = str(checked.get("routing_listing_type") or checked.get("listing_type") or "").strip().lower()
    flags = list(checked.get("validation_flags") or [])
    if result.explicit_route:
        if model_route and model_route != result.explicit_route:
            flags.append("source_route_conflict_review")
            checked["needs_review"] = True
            checked["source_boundary_conflict"] = {
                "field": "listing_type", "model_value": model_route,
                "source_value": result.explicit_route, "reasons": list(result.reasons),
            }
        elif not model_route:
            checked["listing_type"] = result.explicit_route
            checked["routing_listing_type"] = result.explicit_route
    if result.reasons:
        checked["source_boundary"] = {
            "explicit_route": result.explicit_route,
            "rent_explicit": result.rent_explicit,
            "sale_explicit": result.sale_explicit,
            "reasons": list(result.reasons),
        }
    if result.rent_explicit and result.sale_explicit:
        checked["needs_review"] = True
        flags.append("mixed_rent_sale_source_signals")
    checked["validation_flags"] = list(dict.fromkeys(flags))
    return checked
