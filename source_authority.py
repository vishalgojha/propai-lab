"""Shared, pure source-authority contract for extracted fields.

This module is intentionally additive.  It does not call parsers, mutate an
extraction, read the database, or decide publication eligibility.  Existing
extraction paths will be migrated to it in a later step.
"""

from dataclasses import dataclass
from typing import Any, Literal, Mapping
import math
import re


DecisionAction = Literal[
    "trust_ai",
    "correct_from_source",
    "review_preserve_ai",
    "missing_needs_review",
]


@dataclass(frozen=True)
class SourceEvidence:
    field: str
    candidate_value: Any
    source_span: tuple[int, int] | None
    rule_id: str
    confidence: float
    explicit: bool
    unique: bool
    source_slice_id: str | None = None


@dataclass(frozen=True)
class FieldDecision:
    field: str
    action: DecisionAction
    ai_value: Any
    final_value: Any
    source_candidate: Any
    evidence: SourceEvidence | None
    confidence: float
    reasons: tuple[str, ...]
    ai_value_preserved: bool


@dataclass(frozen=True)
class SourceAuthorityResult:
    values: Mapping[str, Any]
    decisions: tuple[FieldDecision, ...]
    needs_review: bool
    validation_flags: tuple[str, ...]
    provenance: Mapping[str, Any]


_DEFAULT_CORRECTION_MARGIN = 0.15
_GENERIC_TITLES = {
    "for sale",
    "for rent",
    "sale",
    "rent",
    "lease",
    "property for sale",
    "property for rent",
}


def _has_value(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    return True


def _normalise_for_compare(value: Any) -> Any:
    if isinstance(value, str):
        return re.sub(r"\s+", " ", value.strip()).casefold()
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    return value


def _values_agree(left: Any, right: Any) -> bool:
    left_normalised = _normalise_for_compare(left)
    right_normalised = _normalise_for_compare(right)
    if isinstance(left_normalised, float) and isinstance(right_normalised, float):
        return math.isclose(left_normalised, right_normalised, rel_tol=1e-9, abs_tol=1e-9)
    return left_normalised == right_normalised


def _span_is_valid(span: tuple[int, int] | None, source: str) -> bool:
    if span is None or len(span) != 2:
        return False
    start, end = span
    return isinstance(start, int) and isinstance(end, int) and 0 <= start < end <= len(source)


def _is_generic_title(field: str, value: Any) -> bool:
    if field not in {"title", "summary_title"} or not isinstance(value, str):
        return False
    return re.sub(r"\s+", " ", value.strip()).casefold() in _GENERIC_TITLES


def _candidate_is_strong(
    evidence: SourceEvidence,
    source: str,
    *,
    expected_slice_id: str | None,
    ai_confidence: float,
    correction_margin: float,
) -> tuple[bool, tuple[str, ...]]:
    reasons: list[str] = []
    if not evidence.explicit:
        reasons.append("source_candidate_not_explicit")
    if not evidence.unique:
        reasons.append("source_candidate_ambiguous")
    if not _span_is_valid(evidence.source_span, source):
        reasons.append("source_span_missing_or_invalid")
    if (
        expected_slice_id is not None
        and evidence.source_slice_id is not None
        and evidence.source_slice_id != expected_slice_id
    ):
        reasons.append("source_candidate_crossed_item_slice")
    if evidence.confidence < ai_confidence + correction_margin:
        reasons.append("source_candidate_not_stronger_than_ai")
    return not reasons, tuple(reasons)


def evaluate_source_authority(
    ai_extraction: Mapping[str, Any],
    source_text: str,
    *,
    source_slice: str | None = None,
    source_candidates: Mapping[str, SourceEvidence | None] | None = None,
    field_confidence: Mapping[str, float] | None = None,
    context: Mapping[str, Any] | None = None,
) -> SourceAuthorityResult:
    """Evaluate one extracted item without mutating its AI extraction.

    A deterministic candidate is evidence, not an authority.  It can replace
    an AI value only when it is explicit, unique, span-backed, item-scoped,
    and materially stronger than the AI confidence.  Otherwise the original
    AI value is retained and the item is marked for review.
    """

    context = context or {}
    candidates = source_candidates or {}
    confidences = field_confidence or {}
    source = source_slice if source_slice is not None else source_text
    expected_slice_id = context.get("source_slice_id")
    correction_margin = float(context.get("correction_margin", _DEFAULT_CORRECTION_MARGIN))
    malformed_fields = set(context.get("malformed_fields", ()))
    schema_safe_values = context.get("schema_safe_values", {})

    fields = tuple(dict.fromkeys((*ai_extraction.keys(), *candidates.keys(), *confidences.keys())))
    values: dict[str, Any] = {}
    decisions: list[FieldDecision] = []
    flags: list[str] = []
    provenance: dict[str, Any] = {"ai_values": dict(ai_extraction), "field_decisions": {}}

    for field in fields:
        ai_value = ai_extraction.get(field)
        evidence = candidates.get(field)
        ai_exists = _has_value(ai_value)
        ai_confidence = float(confidences.get(field, context.get("default_ai_confidence", 0.0)))
        candidate_value = evidence.candidate_value if evidence is not None else None
        reasons: list[str] = []

        if field in malformed_fields:
            final_value = schema_safe_values.get(field, ai_value)
            action: DecisionAction = "review_preserve_ai"
            reasons.append("ai_value_malformed_schema_safe_only")
            flags.append(f"{field}_malformed")
        elif evidence is None:
            if ai_exists:
                action = "trust_ai"
                final_value = ai_value
                reasons.append("no_source_candidate_is_not_evidence_of_error")
            else:
                action = "missing_needs_review"
                final_value = None
                reasons.append("missing_ai_value_and_source_candidate")
                flags.append(f"{field}_missing_source_evidence")
        elif ai_exists and _values_agree(ai_value, candidate_value):
            action = "trust_ai"
            final_value = ai_value
            reasons.append("source_candidate_agrees_with_ai")
        else:
            strong, strength_reasons = _candidate_is_strong(
                evidence,
                source,
                expected_slice_id=expected_slice_id,
                ai_confidence=ai_confidence,
                correction_margin=correction_margin,
            )
            if ai_exists and _is_generic_title(field, candidate_value) and not _is_generic_title(field, ai_value):
                strong = False
                strength_reasons = (*strength_reasons, "generic_title_cannot_replace_specific_ai_title")
            if strong:
                action = "correct_from_source"
                final_value = candidate_value
                reasons.append("explicit_unique_item_scoped_source_is_stronger")
            elif ai_exists:
                action = "review_preserve_ai"
                final_value = ai_value
                reasons.extend(strength_reasons or ("source_candidate_conflicts_with_ai",))
                flags.append(f"{field}_source_conflict")
            else:
                action = "missing_needs_review"
                final_value = None
                reasons.extend(strength_reasons or ("source_candidate_is_not_strong_enough",))
                flags.append(f"{field}_missing_strong_evidence")

        values[field] = final_value
        ai_preserved = _values_agree(final_value, ai_value) if ai_exists else False
        decision = FieldDecision(
            field=field,
            action=action,
            ai_value=ai_value,
            final_value=final_value,
            source_candidate=candidate_value,
            evidence=evidence,
            confidence=evidence.confidence if evidence is not None else ai_confidence,
            reasons=tuple(dict.fromkeys(reasons)),
            ai_value_preserved=ai_preserved,
        )
        decisions.append(decision)
        provenance["field_decisions"][field] = {
            "action": action,
            "ai_value": ai_value,
            "source_candidate": candidate_value,
            "rule_id": evidence.rule_id if evidence is not None else None,
            "source_span": evidence.source_span if evidence is not None else None,
            "source_slice_id": evidence.source_slice_id if evidence is not None else None,
            "reasons": decision.reasons,
        }

    needs_review = bool(flags) or any(
        decision.action in {"review_preserve_ai", "missing_needs_review"}
        for decision in decisions
    )
    provenance["source_text_available"] = bool(source_text.strip())
    provenance["source_slice"] = source_slice
    return SourceAuthorityResult(
        values=dict(values),
        decisions=tuple(decisions),
        needs_review=needs_review,
        validation_flags=tuple(dict.fromkeys(flags)),
        provenance=provenance,
    )
