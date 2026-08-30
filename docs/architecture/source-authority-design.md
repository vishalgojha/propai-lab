# Source Authority Design

Status: approved design; implementation intentionally not started.

Approved 2026-08-30 for the P0-3 regex-versus-AI extraction fix. This document
defines the architectural change required before implementation. It supersedes
field-specific source-grounding patches while preserving the existing product
invariants in `docs/DATA_QUALITY.md` and `architecture.md`.

## Problem

Deterministic extraction currently acts as several independent authorities.
Some helpers correctly produce evidence or review flags, but other helpers
replace, clear, default, or regenerate AI values when a regex match is absent,
ambiguous, or narrower than the AI result. The observed failures include:

- listing type being rewritten by requirement and transaction guards;
- useful AI titles being replaced by generic deterministic titles;
- price and budget values being nulled by validation or quarantine;
- building names being replaced by inferred text or moved into locality;
- locality being upgraded from contextual guesses;
- furnishing, category, broker, BHK, area, and route values being independently
  rewritten by separate guards;
- unknown transaction types being defaulted to `sale`.

The unsafe behavior is not a field-specific bug. It is a missing boundary
contract between model output, source evidence, and publication safety.

## Goals

1. Make one source-authority decision per extracted item.
2. Use the same decision contract for listings, requirements, corrections,
   manual ingestion, and typed persistence.
3. Preserve a useful AI value when deterministic evidence is weak or absent.
4. Permit deterministic correction only with explicit, unique, item-scoped,
   stronger evidence.
5. Separate extraction truth from publication eligibility.
6. Make every correction auditable through evidence, rule, span, and provenance.

## Non-goals

- Replacing deterministic parsing with an LLM.
- Automatically merging listings or buildings.
- Making visual or frontend claims.
- Cleaning historical data before a separate blast-radius review.
- Treating read-time presentation derivations as new extraction facts.

## Shared contract

The implementation should add `source_authority.py` with one public item-level
entry point. Deterministic helpers may calculate candidates, but they may not
mutate the AI extraction.

```python
from dataclasses import dataclass
from typing import Any, Literal, Mapping

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

def evaluate_source_authority(
    ai_extraction: Mapping[str, Any],
    source_text: str,
    *,
    source_slice: str | None = None,
    source_candidates: Mapping[str, SourceEvidence | None] | None = None,
    field_confidence: Mapping[str, float] | None = None,
    context: Mapping[str, Any] | None = None,
) -> SourceAuthorityResult:
    ...
```

The function returns a new result and does not mutate its inputs. It evaluates
all source-groundable fields together so route, price, locality, building,
BHK, and title decisions are consistent for one source slice.

## Decision rules

### AI value exists and no source candidate exists

`trust_ai`; retain the AI value. Lack of a regex match is not evidence that the
AI value is wrong.

### AI value exists and the candidate agrees

`trust_ai`; semantic value remains unchanged. Pure formatting and type
canonicalization are allowed only when they preserve meaning.

### AI value exists and the candidate conflicts

Use `correct_from_source` only when the candidate is explicit, unique,
item-scoped, span-backed, permitted by the field policy, and stronger than the
AI field confidence by a configured margin.

Otherwise use `review_preserve_ai`: retain the AI value, set `needs_review`,
and record the conflict. A failed or narrow deterministic match can never make
the result worse than the AI output.

### AI value is missing and evidence is strong

Use `correct_from_source` to fill the value from the explicit source candidate.

### AI value is missing and evidence is weak or ambiguous

Use `missing_needs_review`. Keep the value missing and flag the item. Do not
invent a generic value.

### AI value is malformed

Preserve the raw AI value in provenance, persist only a schema-safe typed value,
and use `review_preserve_ai`. Schema safety must not become a semantic default.

## Extraction truth versus publication safety

Validation must not rewrite extraction truth merely to prevent publication.
For example, an implausible price becomes:

```text
price = AI price
needs_review = true
publication_status = held
validation_flags += ["price_implausible"]
```

It must not become a null price plus a generic title. Publication predicates
may hide or hold unsafe rows while the source-grounded extraction and original
AI value remain reviewable.

## Field policies

| Field | Source correction permitted when | Weak/conflicting evidence |
| --- | --- | --- |
| Route / transaction | Explicit, unique route marker in the item slice | Preserve AI and review; never default to sale |
| Property category | Explicit category evidence beats low-confidence AI | Preserve AI and review |
| Price / budget / rent / PSF | Explicit amount and unit, or AI is missing | Preserve AI; arithmetic is derived only |
| BHK / listing count | Explicit BHK or multi-unit syntax | Preserve AI and review |
| Area | Explicit area syntax in the item slice | Preserve AI and review |
| Building | Named society/project/building plus safe resolver evidence | Never clear AI because regex found no match |
| Locality | Explicit locality or high-confidence resolver candidate | Preserve AI on ambiguity |
| Furnishing | Explicit furnishing phrase | Preserve AI and review |
| Title | Derived from authorized final fields | Preserve a useful AI title; never use a bare label |
| Broker identity | Evidence matching the applicable source or transport provenance | Preserve internally; separately enforce public privacy blocking |

## Mutation sites to retire or replace

The following existing authorities are to be converted in one implementation
pass. Their useful regex/resolver logic can remain as pure candidate producers.

### Extraction path

- `extraction.py:_apply_listing_transaction_guard`
- `extraction.py:_apply_requirement_source_guard`
- `extraction.py:_source_ground_requirement_item`
- `extraction.py:_apply_source_evidence_gates`
- `extraction.py:_ground_locality_to_source`
- `extraction.py:_rescue_core_fields`
- `extraction.py:_source_grounded_title`
- the building-repair block inside `extraction.py:_ai_extraction_to_parsed`
- route/default logic inside `extraction.py:_ai_extraction_to_typed`
- `extraction.py:repair_building_assignment`

### Quality and model normalization

- `extraction_quality.py:apply_broker_field_grounding`
- `extraction_quality.py:apply_price_sanity_guard`
- `ai_extraction.py:_source_ground_asset_category`
- `ai_extraction.py:_source_grounded_furnishing`
- `ai_extraction.py:_repair_locality_only_building`
- `ai_extraction.py:_source_grounded_price`
- `listing_validation.py:ValidationResult.price_override`
- price nullification in `listing_validation.py:apply_validation`
- the independent route behavior in `source_boundary.py:apply_source_boundary`

### Correction, persistence, and presentation

- independent guard/rewrite logic in `correction_layer.py:_apply_pipeline_guards`
- semantic price quarantine mutation in `storage/supabase.py:save_typed_observation`
- read-time requirement title repair around `storage/supabase.py:5158`
- read-time semantic price reconstruction in `storage/supabase.py`
- unknown transaction defaulting in `storage/supabase.py:save_listing`
- fallback title generation at `extraction.py:3718`
- manual title generation at `routers/infra.py:1766`

`routers/infra.py:parse_message`, location parsers, price parsers, BHK
parsers, building resolvers, and `generate_summary_title` may remain as
deterministic-only or candidate-producing helpers. They must not be treated as
post-AI authorities without passing through this contract.

## Required invariants

The implementation is not complete unless tests prove:

1. Deterministic no-match never changes a non-empty AI value.
2. Low-confidence conflicts preserve AI values.
3. Generic titles never replace specific usable AI titles.
4. Unknown transaction type never defaults to `sale`.
5. Missing building evidence never clears a real AI building.
6. Missing furnishing evidence never silently deletes the AI value.
7. Candidates cannot cross source-listing slices.
8. Every source correction records rule ID and source span.
9. Corrected values retain the original AI value in provenance.
10. Validation can hold publication without mutating extraction truth.
11. Correction-layer output follows the same contract as normal extraction.
12. Read-time projections never change semantic persisted facts.
13. Every field decision is inspectable.
14. There is one production authority call per extracted item.
15. No independent AI-field mutation remains after the authority call.

## Implementation and review sequence

The approved implementation will be delivered in reviewable chunks:

1. Typed contract and candidate interfaces.
2. Candidate conversion and extraction-path integration.
3. Correction/manual/persistence integration.
4. Removal of read-time semantic repair and unsafe defaults.
5. Full invariant and regression test coverage.
6. Full test-suite verification and static mutation-site scan.
7. Review report, including any historical rows with provenance indicating
   prior silent replacement.

No implementation work is authorized by this design document alone; each step
will be shown for review before proceeding to the next.
