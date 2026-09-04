# PropAI Pipeline Remediation Plan

> **Source-of-truth rule:** Every phase must update this file with its status
> and findings before the next phase begins. This document is the source of
> truth for remediation progress—update it; do not let it go stale like
> `WIRING_AUDIT.md` did.

## Audit conclusion

The locality, extraction, enrichment, review, and search systems do not have
one root cause. They are disconnected pipelines: data is often produced and
stored, but the next consumer is absent, broken, inconsistently applied, or
not operationally monitored. The remediation therefore proceeds in controlled
phases, with production writes requiring explicit approval.

## Findings register

Status values: `Not Started`, `In Progress`, `Done`, `Deferred`.

| # | Finding | Severity | Affected tables/files | Status | Next action |
|---:|---|---|---|---|---|
| 1 | Google Places building evidence is not used by locality resolution | wasted signal | `building_enrichment_sources`; `agents/location_resolver.py`; `storage/supabase.py` | Not Started | Design a bounded, ambiguity-aware evidence path from verified building addresses to locality candidates. |
| 2 | `combined_locality_rules` is schema-only and unused | dead code | `public.combined_locality_rules`; `20260705191720_phase2_remaining.sql` | Deferred | Retire it or document and implement its intended consumer. |
| 3 | `location_aliases` has no seed data or confirmed persistence path | wasted signal | `public.location_aliases`; `agents/location_resolver.py` | Deferred | Decide whether accepted resolver suggestions should persist aliases or the feature should be retired. |
| 4 | `resolver_decisions` is legacy observability not written by typed extraction | dead code | `public.resolver_decisions`; `storage/supabase.py`; `extraction.py` | Deferred | Replace it with a typed-pipeline decision log or formally retire it. |
| 5 | Extraction attempts accumulate high failure and stuck counts | silent failure | `extraction_attempt_log`; admin observability | Not Started | Repair the telemetry consumer and define alerting/SLOs for failed, dead-lettered, and long-running attempts. |
| 6 | Reprocessing run history has open/error states without a complete operational consumer | silent failure | `extraction_reprocessing_runs`; `extraction_reprocessing_jobs` | Deferred | Add terminal-state reconciliation and operator-visible run outcomes. |
| 7 | Low-confidence grounding quarantine has no demonstrable recovery drain | silent failure | typed tables; `validation_flags`; `needs_review`; `extraction_reprocessing_jobs` | Not Started | Determine whether quarantined rows are recoverable and connect them to an accountable recovery workflow. |
| 8 | `needs_review` is near-universal in several listing tables | silent failure | all eight typed listing/requirement tables; `needs_review` | In Progress | Investigate the exact flagging logic and sample flagged rows before changing anything. |
| 9 | Validation flags accumulate without a clean issue lifecycle | wasted signal | typed tables; `validation_flags` | Not Started | Separate active issues from historical flags and add ownership/aging semantics. |
| 10 | Locality backfill logic targets unified views and `micro_market`, not canonical locality fields across all eight tables | spec drift | `scripts/backfill_localities.py`; typed tables | Deferred | Define one authoritative all-eight-table locality backfill contract. |
| 11 | Requirement and listing schemas evolved through inheritance plus uneven additions | spec drift | `20260803020000_typed_extraction_schemas.sql`; `storage/supabase.py` allowlists | Deferred | Generate and test a cross-table extraction-field contract. |
| 12 | Dedupe behavior differs by entity type and feed surface | silent failure | `storage/supabase.py`; `routers/search.py`; listing/requirement tables | Deferred | Establish one canonical feed/dedupe contract for every user-facing surface. |
| 13 | Extraction confidence has multiple semantic sources | spec drift | `extraction_confidence`; `ai_extraction` numeric confidence; grounding migration | Deferred | Define one canonical confidence value and its provenance. |
| 14 | Expired/stale requirements are not consistently excluded by internal/API search | silent failure | four requirement tables; `storage/supabase.py`; `routers/search.py` | Deferred | Apply one freshness predicate contract to every requirement consumer. |
| 15 | AI correction scheduler is implemented but not wired or deployed as an active scheduler | dead code | `correction_layer.py`; `scheduler.py`; `ai_correction_runs` | Deferred | Assign a deployment owner and wire scheduling, locking, and monitoring. |
| 16 | Several audit/learning/operations tables are empty and have no confirmed active consumer | dead code | `data_quality_backfill_runs`; `extraction_backfill_audit`; `locality_assignment_repair_audit`; `learning_cards`; `listing_observations`; `observation_batches`; operations/broker tables | Deferred | Inventory each table and retire or wire it deliberately. |
| 17 | `WIRING_AUDIT.md` is stale and misclassifies current references | spec drift | `WIRING_AUDIT.md`; `storage/supabase.py`; admin/frontend observability paths | Not Started | Regenerate the wiring audit after Phases 1–3 are settled. |
| 18 | Intended locality hierarchy is split across multiple partial authorities | spec drift | `docs/DATA_QUALITY.md`; `architecture.md`; locality resolver/backfill paths | Not Started | Select one canonical locality authority and document every read/write path. |
| 19 | Building enrichment evidence is preserved but disconnected from canonical identity | wasted signal | `building_enrichment_sources`; building enrichment workers; locality fields | Not Started | Design evidence promotion rules with confidence thresholds and ambiguity review. |
| 20 | Reprocessing history is stored but not surfaced as an operational control loop | wasted signal | `extraction_reprocessing_runs`; admin observability | Deferred | Expose completion, error, unresolved, and age metrics to operators. |

## Phase plan

### Phase 0 — DONE

Fixed the admin observability column mismatch in
`storage/supabase.py:11148`:

```diff
- error_message, finished_at
+ reason, completed_at
```

Verification: Python compilation, focused assertion, and `git diff --check`
passed. The full pytest suite could not collect because the environment lacks
the existing `langgraph` dependency. No production data or schema was changed.

### Phase 1 — In Progress

Investigate why `needs_review` is approximately 99% for several listing tables.
Determine whether the flag reflects genuine low-confidence data or an
over-flagging bug. Pull a representative sample of 20 flagged rows across
tables, including source text and validation flags.

This phase is read-only. No remediation is authorized yet.

### Phase 2 — TBD

Choose between fixing a confirmed flagging bug and building a recovery/
reprocessing workflow, based on Phase 1 findings and explicit review.

### Phase 3 — Design first

Connect verified Google Places building evidence to locality resolution using
an evidence hierarchy. Only unambiguous candidates may populate
`locality_resolved` and `locality_id`; ambiguous cases go to review, and
existing matched rows are not silently overwritten. Produce a dry-run count
before any migration.

### Phase 4 — Later

Regenerate `WIRING_AUDIT.md` after Phases 1–3 are settled so it reflects the
post-fix system state.

### Deferred

Do not touch in the current remediation sequence:

- dead table cleanup;
- AI correction scheduler wiring;
- cross-table schema, dedupe, and confidence consistency;
- requirement staleness filtering;
- reprocessing-run observability.

