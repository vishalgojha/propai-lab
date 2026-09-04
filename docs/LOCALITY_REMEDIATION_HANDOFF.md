# Locality Remediation Handoff

Updated: 2026-09-04

This is the handoff for the locality/extraction remediation work. The phase
source of truth remains [`REMEDIATION_PLAN.md`](REMEDIATION_PLAN.md).

## Executive summary

The locality problem is not one missing seed alone. The system has disconnected
stages: WhatsApp evidence is ingested, the LLM extracts structured fields, but
locality identity resolution is not consistently run before typed rows are
written. The website searches persisted locality fields and does not scan raw
messages, so evidence present in WhatsApp is invisible when the extraction-to-
resolver handoff is empty or wrong.

Current production counts across the eight typed listing/requirement tables are
13,378 matched, 48,996 missing, and 9,239 unmatched. Every matched row has a
non-null `locality_id`. Matched rows remain protected.

## Completed

### Phase 0 — extraction attempt observability

- Fixed `storage/supabase.py` to read `reason` and `completed_at` from
  `extraction_attempt_log` instead of nonexistent `error_message` and
  `finished_at`.
- Focused checks and diff validation passed; no production data/schema changed.

### Phase 1 — `needs_review` investigation

- Confirmed over-flagging rather than a genuinely 99%-low-quality dataset.
- Found unconditional `needs_review = true` in historical commercial and
  requirement insert paths.
- Found grounding logic conflicting with top-level `extraction_confidence =
  high` for 10,818 rows.
- Reviewed 20 production samples and documented both genuinely incomplete rows
  and coherent listings suppressed by broad/contradictory flags.

### Phase 2 — future `needs_review` logic

- Replaced blanket commercial/requirement defaults with minimal quality checks.
- Prevented grounding disagreement from suppressing high-confidence rows;
  disagreement is retained as a validation flag.
- Deliberately did not rewrite the existing `needs_review = true` backlog.
- Deployed in commit `78f19710`; API and extraction-worker deploys completed.

### Phase 3 — Google Places evidence promotion

- Applied `20260904123000_promote_places_building_localities.sql` across all
  eight typed tables.
- Results: 2,366 eligible; 1,618 deterministic promotions; 237 ambiguous
  parents; 174 ambiguous children; 337 without a reference candidate.
- No matched rows were overwritten and `needs_review` was unchanged.
- Added the requested Bandra West vocabulary while preserving ambiguous cases.

## Key current finding

The website expects locality to already exist in typed fields. It primarily uses
`micro_market`, `locality_resolved`, and `locality_raw`; it does not use
`raw_messages.message` as a runtime locality source. Thus a message containing
`Location - Juhu Gulmohar Road` is not searchable by locality when the LLM
stores no locality object.

Some building-derived values also conflict with explicit source text, such as a
source naming Mahim while a Places-linked building suggests Kanjurmarg East.
Those cases require conflict handling, not blind promotion.

## Agreed resolver design — pending implementation

The resolver must be deterministic and must not use regex or substring
scanning. Regex-based extraction is rejected because it can interfere with LLM
extraction and creates a second brittle interpretation path.

```text
raw WhatsApp message
  -> LLM structured extraction
  -> locality.raw_mention / locality.resolved_locality
  -> Unicode, case, punctuation, and whitespace normalization
  -> exact lookup in locality_reference and explicit aliases
  -> unique locality_id, or explicit unmatched/ambiguous result
```

Rules:

- The LLM interprets the message; the resolver assigns canonical identity.
- Aliases and abbreviations are data rows, not code patterns.
- A unique match may populate `locality_id`.
- Multiple candidates produce `unmatched` plus an ambiguity flag.
- No match produces `unmatched` plus a no-reference flag.
- Explicit source locality must not be silently overridden by building/Places
  evidence.
- Existing `matched` rows are never automatically overwritten.

For historical rows where locality was lost, the preferred recovery path is to
re-run LLM extraction from the preserved raw message and send the structured
result through this same resolver. A separate regex backfill is not part of the
design.

## Pending work

### 1. Implement and test the canonical resolver

Status: Not Started.

Next action: extend `registry/locality_resolver.py` to accept the LLM locality
object, perform exact normalized gazetteer/alias lookup, return structured
decisions, and cover all eight typed destinations with tests.

### 2. Wire resolver into normal extraction writes

Status: Not Started.

Next action: invoke the resolver after LLM extraction and before typed-row
insert/update, with explicit error/flag outcomes rather than defaulting to
`missing`.

### 3. Historical raw-message recovery preview

Status: In Progress — read-only preview only.

Next action: complete the eight-table dry-run using LLM re-extraction plus the
new resolver, reporting deterministic, ambiguous, conflicting, and unavailable
evidence before any write.

A preliminary raw-text preview of the first 1,000 unresolved rows in each of
the first three tables found 1,407 deterministic candidates, 417 ambiguous
cases, 723 text cases absent from the current gazetteer, and 85 conflicts with
stored locality values. This is directional only, not an apply count.

### 4. Apply deterministic historical repairs

Status: Pending approval.

Next action: show the complete dry-run and exact update statement; apply only
unique, collision-free candidates after explicit approval.

### 5. Raw-message retention decision

Status: Deferred / no action taken.

Next action: separately decide whether raw evidence should be retained,
logically expired, trimmed, or deleted after verifying provenance and
reprocessing requirements.

`raw_messages` does not have an `expires_at` field. Typed-table `expires_at`
fields govern listing/requirement freshness, not raw-message deletion. No raw
message deletion or expiry update has been performed.

## Safety boundaries

- No regex-based locality extraction.
- No guessing for ambiguous locality evidence.
- No automatic changes to existing matched rows.
- No production data/schema writes without showing the exact change and
  receiving explicit approval.
- Raw-message deletion/expiry is a separate destructive-retention decision.

## Relevant files and artifacts

- `docs/REMEDIATION_PLAN.md` — phase source of truth
- `registry/locality_resolver.py` — resolver foundation
- `extraction.py` / `ai_extraction.py` — LLM extraction and row shaping
- `storage/supabase.py` — persistence and application read paths
- `supabase/migrations/20260904123000_promote_places_building_localities.sql`
  — applied Places promotion
- `apps/www/src/lib/localities.ts` and `apps/www/src/lib/natural-search.ts`
  — website locality search fields
- `docs/TASK_COMPLETION_REPORT.md` — task completion records
