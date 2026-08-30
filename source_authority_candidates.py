"""Candidate-producer adapters for the approved source-authority boundary.

Step 2 is intentionally additive.  These adapters call existing deterministic
parsers/resolvers (or accept an already-computed resolver result) and return
``SourceEvidence``.  The Step 3 boundary adapter below evaluates and projects
only those candidate-backed fields; fields without an adapter remain on their
existing path until their own adapter is migrated.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
import re
from typing import Any

from source_authority import SourceEvidence
from source_authority import SourceAuthorityResult, evaluate_source_authority


def _span_for(source: str, value: object, start: int = 0) -> tuple[int, int] | None:
    text = str(value or "")
    if not text:
        return None
    found = source.casefold().find(text.casefold(), max(0, start))
    return (found, found + len(text)) if found >= 0 else None


def route_candidate(source_text: str, *, source_slice_id: str | None = None) -> SourceEvidence | None:
    """Adapt ``classify_source_boundary`` to source evidence."""
    from extraction import _has_explicit_requirement_heading
    from source_boundary import classify_source_boundary

    source = str(source_text or "")
    result = classify_source_boundary(source)
    explicit_route = result.explicit_route
    if _has_explicit_requirement_heading(source):
        explicit_route = "requirement"
    if not explicit_route:
        return None
    marker_patterns = {
        "rent": r"\b(?:rent|rental|monthly\s+rent|per\s+month|for\s+rent|on\s+rent|for\s+lease|on\s+lease|lease)\b",
        "sale": r"\b(?:sale|selling|for\s+sale|on\s+sale|asking\s+price|outright|outrate)\b",
        "requirement": r"\b(?:buyer|tenant|client\s+)?(?:requirements?|required|require|wanted|want|need(?:s|ed)?)\b",
    }
    match = re.search(marker_patterns[explicit_route], source, re.IGNORECASE)
    span = match.span() if match else None
    return SourceEvidence(
        field="listing_type",
        candidate_value=explicit_route,
        source_span=span,
        rule_id=f"source_boundary.explicit_route.{explicit_route}",
        confidence=0.95,
        explicit=True,
        unique=explicit_route == "requirement" or not (result.rent_explicit and result.sale_explicit),
        source_slice_id=source_slice_id,
    )


def locality_candidate(source_text: str, *, source_slice_id: str | None = None) -> SourceEvidence | None:
    """Adapt the existing explicit-locality parser without moving fields."""
    from extraction import _source_explicit_location

    source = str(source_text or "")
    locality = _source_explicit_location(source)
    span = _span_for(source, locality)
    rule_id = "locality.explicit_label"
    if not locality:
        # In a compact heading, locality is the bounded token between the
        # bold building name and the BHK marker. It is explicit source text,
        # but deliberately does not attempt canonical resolution.
        heading = re.search(
            r"(?im)^\s*\*[^*\n]{2,70}\*\s*(?P<locality>[A-Za-z][A-Za-z .'/&-]{1,48}?)"
            r"\s*(?:[-–—:]\s*)?\d+(?:\.\d+)?\s*(?:bhk|rk)\b",
            source,
        )
        if heading:
            locality = heading.group("locality").strip(" .,;|-_")
            span = heading.span("locality")
            rule_id = "locality.explicit_heading_context"
    if not locality:
        return None
    return SourceEvidence(
        field="locality",
        candidate_value=locality,
        source_span=span,
        rule_id=rule_id,
        confidence=0.9,
        explicit=True,
        unique=True,
        source_slice_id=source_slice_id,
    )


def contextual_locality_candidate(source_text: str, *, source_slice_id: str | None = None) -> SourceEvidence | None:
    """Expose contextual locality as weak evidence, never as an authority."""
    from extraction import _source_contextual_market

    locality = _source_contextual_market(str(source_text or ""))
    if not locality:
        return None
    return SourceEvidence(
        field="locality",
        candidate_value=locality,
        source_span=_span_for(str(source_text or ""), locality),
        rule_id="locality.contextual_mention",
        confidence=0.45,
        explicit=False,
        unique=False,
        source_slice_id=source_slice_id,
    )


def bhk_candidates(source_text: str, *, source_slice_id: str | None = None) -> tuple[SourceEvidence, ...]:
    """Adapt the existing BHK and multi-unit regexes to evidence records."""
    from extraction import _CORE_BHK_RE, _MULTI_UNIT_BHK_RE, _safe_float

    source = str(source_text or "")
    multi = _MULTI_UNIT_BHK_RE.search(source)
    candidates: list[SourceEvidence] = []
    if multi:
        bhk = _safe_float(multi.group("bhk"))
        if bhk is not None:
            candidates.append(SourceEvidence(
                field="bhk", candidate_value=bhk, source_span=multi.span("bhk"),
                rule_id="bhk.explicit_multi_unit", confidence=0.98,
                explicit=True, unique=True, source_slice_id=source_slice_id,
            ))
        candidates.append(SourceEvidence(
            field="listing_count", candidate_value=int(multi.group("count")),
            source_span=multi.span("count"), rule_id="listing_count.explicit_multi_unit",
            confidence=0.98, explicit=True, unique=True, source_slice_id=source_slice_id,
        ))
        return tuple(candidates)
    match = _CORE_BHK_RE.search(source)
    if not match:
        return ()
    bhk = _safe_float(match.group(1))
    if bhk is None:
        return ()
    return (SourceEvidence(
        field="bhk", candidate_value=bhk, source_span=match.span(1),
        rule_id="bhk.explicit", confidence=0.95, explicit=True,
        unique=True, source_slice_id=source_slice_id,
    ),)


def psf_price_candidate(source_text: str, *, source_slice_id: str | None = None) -> SourceEvidence | None:
    """Adapt ``extract_simple_psf_rate`` without changing an AI price."""
    from extraction_quality import extract_simple_psf_rate

    source = str(source_text or "")
    quote = extract_simple_psf_rate(source)
    if not quote:
        return None
    raw_text = str(quote["raw_text"])
    span = _span_for(source, raw_text)
    return SourceEvidence(
        field="price_per_sqft",
        candidate_value=quote["amount"],
        source_span=span,
        rule_id="price.explicit_psf",
        confidence=0.95,
        explicit=True,
        unique=True,
        source_slice_id=source_slice_id,
    )


_FURNISHING_PATTERNS = (
    ("fully_furnished", r"\b(?:fully\s+furnished|furnished|fully\s+loaded)\b"),
    ("semi_furnished", r"\bsemi[-\s]?furnished\b"),
    ("unfurnished", r"\bunfurnished\b"),
    ("bare_shell", r"\bbare[-\s]?shell\b"),
    ("builder_finish", r"\bbuilder[-\s]?finish(?:ed)?\b"),
)


def furnishing_candidate(source_text: str, *, source_slice_id: str | None = None) -> SourceEvidence | None:
    source = str(source_text or "")
    matches = [(value, re.search(pattern, source, re.IGNORECASE)) for value, pattern in _FURNISHING_PATTERNS]
    matches = [(value, match) for value, match in matches if match]
    if len(matches) != 1:
        return None
    value, match = matches[0]
    return SourceEvidence(
        field="furnishing_status", candidate_value=value, source_span=match.span(),
        rule_id="furnishing.explicit_phrase", confidence=0.95, explicit=True,
        unique=True, source_slice_id=source_slice_id,
    )


def category_candidate(source_text: str, *, source_slice_id: str | None = None) -> SourceEvidence | None:
    """Expose only explicit asset-category wording as source evidence."""
    source = str(source_text or "")
    patterns = (
        ("commercial", r"\b(?:commercial|office(?:\s+space)?|shop|showroom|warehouse|industrial)\b"),
        ("residential", r"\b(?:residential|apartment|flat|villa|bungalow|penthouse)\b"),
    )
    matches = [(value, re.search(pattern, source, re.IGNORECASE)) for value, pattern in patterns]
    matches = [(value, match) for value, match in matches if match]
    if len(matches) != 1:
        return None
    value, match = matches[0]
    return SourceEvidence(
        field="property_category", candidate_value=value,
        source_span=match.span(), rule_id="asset_category.explicit_phrase",
        confidence=0.92, explicit=True, unique=True, source_slice_id=source_slice_id,
    )


def area_candidate(source_text: str, *, source_slice_id: str | None = None) -> SourceEvidence | None:
    """Expose one explicit square-foot area quote as evidence."""
    source = str(source_text or "")
    matches = list(re.finditer(
        r"(?<![\w.])(?P<area>[\d,]+(?:\.\d+)?)\s*(?:sq\.?\s*ft|sqft|sft|square\s+feet)\b",
        source, re.IGNORECASE,
    ))
    if len(matches) != 1:
        return None
    match = matches[0]
    return SourceEvidence(
        field="area_sqft", candidate_value=float(match.group("area").replace(",", "")),
        source_span=match.span("area"), rule_id="area.explicit_square_feet",
        confidence=0.96, explicit=True, unique=True, source_slice_id=source_slice_id,
    )


def requirement_budget_candidates(
    source_text: str, *, source_slice_id: str | None = None
) -> tuple[SourceEvidence, ...]:
    """Expose explicit requirement budgets as bounded numeric evidence."""
    source = str(source_text or "")
    if not re.search(r"(?im)^\s*[^\n]*(?:requirement|required|wanted|need)\b", source):
        return ()
    multipliers = {
        "k": 1_000, "thousand": 1_000,
        "l": 100_000, "lac": 100_000, "lakh": 100_000, "lakhs": 100_000,
        "cr": 10_000_000, "crore": 10_000_000, "crores": 10_000_000,
    }
    range_match = re.search(
        r"\b(?:budget|rent|rental|rantal|rant)\s*[:\-]?\s*"
        r"(?:₹|rs\.?\s*)?([\d,.]+)\s*(k|thousand|l|lac|lakh|lakhs|cr|crore|crores)\s*"
        r"(?:-|to|–|—)\s*(?:₹|rs\.?\s*)?([\d,.]+)\s*"
        r"(k|thousand|l|lac|lakh|lakhs|cr|crore|crores)\b",
        source, re.IGNORECASE,
    )
    if range_match:
        low = float(range_match.group(1).replace(",", "")) * multipliers[range_match.group(2).lower()]
        high = float(range_match.group(3).replace(",", "")) * multipliers[range_match.group(4).lower()]
        ordered = sorted((low, high))
        return (
            SourceEvidence("budget_min", ordered[0], range_match.span(1), "requirement.explicit_budget_range", 0.96, True, True, source_slice_id),
            SourceEvidence("budget_max", ordered[1], range_match.span(3), "requirement.explicit_budget_range", 0.96, True, True, source_slice_id),
        )
    capped = re.search(
        r"\bbudget\s*[:\-]?\s*(?:up\s*to|upto|maximum|max)\s*"
        r"(?:₹|rs\.?\s*)?([\d,.]+)\s*(k|thousand|l|lac|lakh|lakhs|cr|crore|crores)\b",
        source, re.IGNORECASE,
    )
    if capped:
        amount = float(capped.group(1).replace(",", "")) * multipliers[capped.group(2).lower()]
        return (SourceEvidence("budget_max", amount, capped.span(1), "requirement.explicit_budget_cap", 0.96, True, True, source_slice_id),)
    return ()


def building_candidate(source_text: str, *, source_slice_id: str | None = None) -> SourceEvidence | None:
    """Expose a directly labelled building/project name without guessing."""
    source = str(source_text or "")
    match = re.search(
        r"(?im)^\s*(?:building|project|society|tower)\s*[:=\-]\s*(?P<name>[^|,\n]+?)\s*$",
        source,
    )
    rule_id = "building.explicit_label"
    if not match:
        # Common inventory heading: *Building* locality - 2 BHK.  Only the
        # bounded bold token is evidence; the adjacent locality is not part
        # of the building identity.
        match = re.search(
            r"(?im)^\s*\*(?P<name>[^*\n]{2,70})\*\s*[^\n]*?"
            r"(?:[-–—:]\s*)?\d+(?:\.\d+)?\s*(?:bhk|rk)\b",
            source,
        )
        rule_id = "building.explicit_bold_heading"
    if not match:
        # Numbered rows can carry a project and locality separated by an
        # em-dash. Keep only the first heading token as source evidence.
        match = re.search(
            r"(?im)^\s*(?:\(\s*\d+\s*\)|\d+[.)])\s*"
            r"(?P<name>[A-Za-z][A-Za-z0-9 &'./]{1,70}?)\s+[–—-]\s+"
            r"[A-Za-z][^\n]*$",
            source,
        )
        rule_id = "building.explicit_numbered_heading"
    if not match:
        return None
    name = match.group("name").strip(" *_~`-:")
    if not name or len(re.findall(r"[A-Za-z0-9]+", name)) < 2:
        return None
    return SourceEvidence(
        field="building_name", candidate_value=name,
        source_span=match.span("name"), rule_id=rule_id,
        confidence=0.94, explicit=True, unique=True, source_slice_id=source_slice_id,
    )


def resolver_candidate(
    field: str,
    candidate_value: Any,
    source_text: str,
    *,
    rule_id: str,
    confidence: float,
    explicit: bool,
    unique: bool,
    source_span: tuple[int, int] | None = None,
    source_slice_id: str | None = None,
) -> SourceEvidence:
    """Wrap a building/broker resolver result at the source boundary.

    Resolvers remain free to use their databases in their own layer; this
    adapter makes the result auditable and prevents the resolver from mutating
    the AI extraction directly.
    """
    return SourceEvidence(
        field=field,
        candidate_value=candidate_value,
        source_span=source_span if source_span is not None else _span_for(source_text, candidate_value),
        rule_id=rule_id,
        confidence=confidence,
        explicit=explicit,
        unique=unique,
        source_slice_id=source_slice_id,
    )


def produce_source_candidates(
    ai_extraction: Mapping[str, Any],
    source_text: str,
    *,
    source_slice_id: str | None = None,
    resolver_results: Iterable[SourceEvidence] = (),
) -> dict[str, SourceEvidence]:
    """Collect current deterministic candidates without mutating ``ai_extraction``.

    One candidate is retained per field.  Ambiguous/multiple candidates are
    omitted here and remain review material for the authority contract rather
    than being resolved by adapter ordering.
    """
    del ai_extraction  # The interface is deliberately uniform; adapters do not rewrite AI values.
    candidates: dict[str, SourceEvidence] = {}
    for candidate in (
        route_candidate(source_text, source_slice_id=source_slice_id),
        locality_candidate(source_text, source_slice_id=source_slice_id),
        psf_price_candidate(source_text, source_slice_id=source_slice_id),
        furnishing_candidate(source_text, source_slice_id=source_slice_id),
        category_candidate(source_text, source_slice_id=source_slice_id),
        area_candidate(source_text, source_slice_id=source_slice_id),
        building_candidate(source_text, source_slice_id=source_slice_id),
    ):
        if candidate is not None:
            candidates[candidate.field] = candidate
    for candidate in bhk_candidates(source_text, source_slice_id=source_slice_id):
        candidates.setdefault(candidate.field, candidate)
    for candidate in requirement_budget_candidates(source_text, source_slice_id=source_slice_id):
        candidates.setdefault(candidate.field, candidate)
    for candidate in resolver_results:
        if candidate.field not in candidates:
            candidates[candidate.field] = candidate
    return candidates


def evaluate_extraction_authority(
    ai_extraction: Mapping[str, Any],
    source_text: str,
    *,
    source_slice_id: str | None = None,
    resolver_results: Iterable[SourceEvidence] = (),
    field_confidence: Mapping[str, float] | None = None,
) -> SourceAuthorityResult:
    """Evaluate the currently supported extraction fields as one item.

    The adapter normalizes nested legacy shapes only at the boundary: locality
    is compared by its resolved/raw label and price by its numeric amount.
    Corrections are projected back by ``apply_authority_result`` below; the
    original AI mapping remains untouched.
    """
    ai = dict(ai_extraction or {})
    authority_input = dict(ai)
    locality = ai.get("locality")
    if isinstance(locality, Mapping):
        authority_input["locality"] = locality.get("resolved_locality") or locality.get("raw_mention")
    price = ai.get("price")
    if isinstance(price, Mapping):
        authority_input["price_per_sqft"] = price.get("amount") if price.get("unit") == "per_sqft" else None
    confidence = dict(field_confidence or ai.get("field_confidence") or {})
    default_confidence = ai.get("extraction_confidence_score", ai.get("confidence"))
    if default_confidence is None:
        # Older provider payloads carry a qualitative label rather than a
        # score. Preserve the contract's confidence comparison instead of
        # treating every labelled high-confidence AI value as zero-confidence.
        label = str(ai.get("extraction_confidence") or "").casefold()
        default_confidence = {
            "high": 0.9,
            "medium": 0.7,
            "low": 0.4,
        }.get(label, 0.0)
    candidates = produce_source_candidates(
        ai,
        source_text,
        source_slice_id=source_slice_id,
        resolver_results=resolver_results,
    )
    # Step 3 only governs fields with an adapter-backed candidate.  An absent
    # candidate is deliberately not treated as missing evidence for every
    # unrelated AI field; that broader review belongs to the later adapter
    # chunks and must not create review noise or change existing fields.
    authority_input = {
        field: authority_input.get(field)
        for field in candidates
    }
    candidate_confidence = {
        field: confidence[field]
        for field in candidates
        if field in confidence
    }
    return evaluate_source_authority(
        authority_input,
        source_text,
        source_slice=source_text,
        source_candidates=candidates,
        field_confidence=candidate_confidence,
        context={
            "source_slice_id": source_slice_id,
            "default_ai_confidence": default_confidence,
        },
    )


def apply_authority_result(
    ai_extraction: Mapping[str, Any],
    result: SourceAuthorityResult,
) -> dict[str, Any]:
    """Project only authority-approved corrections into a new AI mapping."""
    ai = dict(ai_extraction or {})
    for decision in result.decisions:
        if decision.action != "correct_from_source":
            continue
        if decision.field == "listing_type":
            ai["listing_type"] = decision.final_value
            ai["routing_listing_type"] = decision.final_value
        elif decision.field == "locality":
            locality = dict(ai.get("locality") or {})
            locality["raw_mention"] = decision.final_value
            locality["resolved_locality"] = decision.final_value
            ai["locality"] = locality
        elif decision.field == "price_per_sqft":
            price = dict(ai.get("price") or {})
            price.update({"amount": decision.final_value, "unit": "per_sqft", "period": None})
            ai["price"] = price
        elif decision.field in {"budget_min", "budget_max", "transaction_type"}:
            ai[decision.field] = decision.final_value
            if decision.field == "transaction_type":
                ai["classified_transaction_type"] = decision.final_value
        else:
            ai[decision.field] = decision.final_value
    if result.needs_review:
        ai["needs_review"] = True
    ai["validation_flags"] = list(dict.fromkeys(
        list(ai.get("validation_flags") or []) + list(result.validation_flags)
    ))
    ai["source_authority"] = dict(result.provenance)
    return ai
