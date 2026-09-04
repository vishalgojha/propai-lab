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
| 7 | Low-confidence grounding quarantine has no demonstrable recovery drain | silent failure | typed tables; `validation_flags`; `needs_review`; `extraction_reprocessing_jobs` | Deferred | Existing backlog remains untouched; revisit only if a later approved decision requires it. |
| 8 | `needs_review` is near-universal in several listing tables | silent failure | all eight typed listing/requirement tables; `needs_review` | In Progress | Logic fix is prepared locally; obtain approval before deployment, then separately decide what to do with historical rows. |
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

### Phase 1 — DONE (investigation only)

Investigate why `needs_review` is approximately 99% for several listing tables.
Determine whether the flag reflects genuine low-confidence data or an
over-flagging bug. Pull a representative sample of 20 flagged rows across
tables, including source text and validation flags.

This phase is read-only. No remediation is authorized yet.

#### Findings

The near-universal rate is not explained by one current default. It is the
combined result of a historical migration bug, broad quarantine logic, and
inconsistent confidence representations.

1. **Confirmed unconditional migration bug for commercial listings.**
   `20260803020000_typed_extraction_schemas.sql` inserts commercial sale rows
   with `true or needs_review or ...` and commercial rent rows with the same
   unconditional `true or ...` expression (lines 129 and 134). The literal
   `true` makes every migrated commercial listing `needs_review = true`,
   regardless of quality. This directly explains the current 100% rate for
   `commercial_sale_listings` and 99.95% rate for
   `commercial_rent_listings`.

2. **Confirmed unconditional migration bug for copied requirements.** The
   same migration inserts all four requirement families with `needs_review =
   true` (including the commercial requirement inserts and the residential
   requirement inserts). This is outside the four listing samples but confirms
   the problem is systemic rather than a UI counting issue.

3. **The grounding backfill is not itself an all-row update, but its predicate
   is too broad for a reliable source-grounding test.**
   `20260830100000_flag_low_confidence_grounding_rows.sql` requires a nested
   numeric confidence below `.2`, then flags a row if *any* populated JSON field
   outside a short provenance exclusion list has zero token overlap with the
   source. The excluded list does not include every derived/control field (for
   example `asset_type`, `transaction_type`, and other promoted metadata), so
   a semantically valid row can fail because a derived value is not literally
   present in source text.

4. **Confidence fields contradict each other.** Among rows carrying
   `grounding_backfill_20260830`, the current top-level confidence breakdown is:

   | Table | Grounding-flagged | Top-level low | medium | high |
   |---|---:|---:|---:|---:|
   | `residential_sale_listings` | 29,733 | 25,293 | 481 | 3,959 |
   | `commercial_rent_listings` | 9,486 | 6,103 | 371 | 3,012 |
   | `residential_rent_listings` | 8,889 | 5,277 | 351 | 3,261 |
   | `commercial_sale_listings` | 1,698 | 1,029 | 83 | 586 |

   The migration used the nested numeric score, while the report and UI use
   the top-level categorical value. Therefore `needs_review = true` cannot be
   interpreted simply as “the stored confidence is low.”

5. **Live review counts at sampling time:**

   | Table | Total | `needs_review = true` | Rate |
   |---|---:|---:|---:|
   | `residential_sale_listings` | 30,349 | 30,323 | 99.91% |
   | `commercial_rent_listings` | 10,041 | 10,036 | 99.95% |
   | `residential_rent_listings` | 9,637 | 9,611 | 99.73% |
   | `commercial_sale_listings` | 1,783 | 1,783 | 100.00% |

   Counts are observational and may move slightly as ingestion continues.

#### Twenty-row production sample

The following is a read-only sample of five flagged rows from each affected
listing table. Rows were selected using independently random offsets within
the flagged population. Phone-number patterns were redacted. Empty locality
and price fields are shown as `null`.

| Table / row | Locality / building | BHK | Price | Confidence | Flags | Source text |
|---|---|---:|---:|---|---|---|
| residential sale / 20157 | null / null | 3 | ₹7.81 Cr | low | `furnishing_without_source_evidence`, `ai_needs_review`, `grounding_backfill_20260830` | `3 BHK - 1117 Carpet @7.81 Cr` |
| residential sale / 20158 | Bandra East / Serendipity | 3 | ₹7.58 Cr | low | `title_evidence_mismatch`, `ai_needs_review`, `grounding_backfill_20260830` | `3 BHK; SERENDIPITY – BKC; 1467 Sqft; Quote – 7.58 Cr` |
| residential sale / 20159 | Santacruz (West) / Veena Solace | 3 | ₹4.25 Cr | low | `furnishing_without_source_evidence`, `ai_needs_review`, `grounding_backfill_20260830` | `3 BHK; VEENA SOLACE – SANTACRUZ WEST; 945 Sq Ft; Quote – 4.25 Cr` |
| residential sale / 20160 | Bandra East / RNA AZZURE | 3 | ₹6.00 Cr | low | `title_evidence_mismatch`, `ai_needs_review`, `grounding_backfill_20260830` | `3 BHK; RNA AZZURE – BANDRA EAST; 1400 Carpet; Quote – 6.00 Cr` |
| residential sale / 20161 | null / GHOGARI MANSION | 3 | ₹4.10 Cr | low | `grounding_backfill_20260830`, `locality_unresolved` | `3 BHK; GHOGARI MANSION – SANTACRUZ WEST; 832 Carpet; Quote – 4.10 Cr` |
| commercial rent / 6330 | null / Raymond Park Avenue | null | ₹2.56 lakh/mo | low | `ai_needs_review`, `broker_phone_text_extracted`, `building_name_is_locality`, `building_name_source_repaired`, `commercial_source_evidence`, `grounding_backfill_20260830` | `COMMERCIAL PROPERTY AVAILABLE FOR RENT; Raymond Park Avenue; 986 Sq Ft; Monthly Rent ₹2.56 Lakh` |
| commercial rent / 6331 | Thane / null | null | null | low | `ai_needs_review`, `broker_phone_text_extracted`, `commercial_source_evidence`, `grounding_backfill_20260830`, `missing_price`, `title_evidence_mismatch` | `AVAILABLE FOR RESTAURANT LEASE; Location: Vasant Vihar, Thane` |
| commercial rent / 6332 | null / THE PRESIDENTIAL | null | null | low | `ai_needs_review`, `grounding_backfill_20260830`, `missing_price`, `title_evidence_mismatch` | `BLDG: THE PRESIDENTIAL` |
| commercial rent / 6333 | Thane / null | null | null | low | `ai_needs_review`, `broker_phone_text_extracted`, `commercial_source_evidence`, `grounding_backfill_20260830`, `missing_price`, `title_evidence_mismatch` | `AVAILABLE FOR RESTAURANT LEASE; Location: Vasant Vihar, Thane` |
| commercial rent / 6334 | null / Raymond Park Avenue | null | ₹2.56 lakh/mo | low | `ai_needs_review`, `broker_phone_text_extracted`, `building_name_is_locality`, `building_name_source_repaired`, `commercial_source_evidence`, `grounding_backfill_20260830`, `title_evidence_mismatch` | `COMMERCIAL PROPERTY AVAILABLE FOR RENT; Raymond Park Avenue; 986 Sq Ft; Monthly Rent ₹2.56 Lakh` |
| residential rent / 1572 | null / Family client | 2 | ₹85,000/mo | high | `unrecognised_asset_type:residential`, `grounding_backfill_20260830` | `RENTAL REQUIREMENT; 1-2bhk; Family client; 70-85k budget` |
| residential rent / 1573 | null / Family client | 2 | ₹85,000/mo | high | `title_evidence_mismatch`, `ai_needs_review`, `unrecognised_asset_type:residential`, `grounding_backfill_20260830` | `RENTAL REQUIREMENT; 1-2bhk; Family client; 70-85k budget` |
| residential rent / 1574 | null / null | 3 | null | high | `ai_needs_review`, `furnishing_without_source_evidence`, `grounding_backfill_20260830`, `locality_unresolved`, `missing_building_or_locality`, `missing_price`, `price_source_missing`, `title_evidence_mismatch`, `unrecognised_asset_type:residential` | `3 BHK ON LEAVE & LICENSE – KHAR WEST` |
| residential rent / 1575 | Bandra West / K L ASTORIA | 2 | ₹1.75 lakh/mo | high | `title_evidence_mismatch`, `ai_needs_review`, `unrecognised_asset_type:residential`, `grounding_backfill_20260830` | `2BHK L/L; K L ASTORIA; PERRY CROSS ROAD; BANDRA WEST; RENT - 175K` |
| residential rent / 1576 | Khar West / Bandra Olympic | 3 | ₹1.95 lakh/mo | high | `title_evidence_mismatch`, `ai_needs_review`, `unrecognised_asset_type:residential`, `grounding_backfill_20260830` | `3BHK ON RENT; BANDRA OLYMPIC; 16TH ROAD; RENT: 1.95L` |
| commercial sale / 70 | null / null | null | null | high | `ai_needs_review`, `grounding_backfill_20260830`, `missing_building_or_locality`, `missing_price`, `title_evidence_mismatch` | `SALE – COMMERCIAL UNIT; Area – 460 sqft` |
| commercial sale / 71 | Khar West / Amore Edge | null | null | high | `ai_needs_review`, `grounding_backfill_20260830`, `invalid_price_unit:per_sqft`, `title_evidence_mismatch` | `SALE – COMMERCIAL UNIT; Area – 575 sqft; Quote – ₹70,000 psf; Amore Edge, SV Road, Khar` |
| commercial sale / 72 | null / null | null | null | low | `grounding_backfill_20260830`, `missing_building_or_locality`, `missing_price` | `SALE – COMMERCIAL SPACE; Area – 27,000 sqft` |
| commercial sale / 73 | null / Udyog Mandir | null | ₹3 Cr | high | `ai_needs_review`, `grounding_backfill_20260830`, `locality_unresolved`, `title_evidence_mismatch` | `SALE – OFFICE SPACE; Area – 1000 sqft; Quote – ₹3 Cr; Udyog Mandir, Mahim` |
| commercial sale / 74 | null / Udyog Mandir | null | ₹4 Cr | high | `ai_needs_review`, `grounding_backfill_20260830`, `locality_unresolved`, `title_evidence_mismatch` | `SALE – OFFICE SPACE; Area – 1000 sqft; Quote – ₹4 Cr; Udyog Mandir, Mahim` |

#### Phase 1 conclusion

This is a genuine over-flagging bug, not merely a dataset that happens to be
poor. The strongest proof is the unconditional `true` in the historical
commercial migration and the 10,818 grounding-flagged rows whose current
top-level confidence is `high`. The sample also shows a mixed population:
some rows are genuinely incomplete, while others have coherent source text,
locality, BHK, and price but remain suppressed by broad or contradictory
flags.

No fixes were made. Before Phase 2, the owner must choose whether to correct
historical flag state, redesign the grounding predicate, build recovery, or
use a staged combination. The Phase 1 before/after data impact is 0/0 rows;
this phase changed documentation only.

### Phase 2 — In Progress (logic fix prepared, not deployed)

The Phase 1 evidence confirmed an over-flagging bug. The agreed scope is a
small logic fix only: no review team, assignment model, queue, triage UI, or
historical backlog rewrite.

Changes prepared locally:

- `20260803020000_typed_extraction_schemas.sql` removes unconditional `true`
  from commercial listing inserts and replaces unconditional requirement flags
  with confidence, price, and locality checks consistent with the existing
  residential migration logic.
- `20260830100000_flag_low_confidence_grounding_rows.sql` preserves the
  existing `needs_review` and `duplicate_status` for top-level `high`
  confidence rows. If the nested grounding score disagrees, it records
  `grounding_confidence_disagreement` in `validation_flags` instead.
- The active typed write path in `storage/supabase.py` applies the same guard
  for any future row carrying the historical grounding marker, so deploying
  the API/worker makes the protection effective even though the historical
  migration itself is already recorded as applied in production.

These edits contain no backfill or data-repair operation and have not been
deployed or run against production. The existing `needs_review = true`
backlog remains unchanged by design. Approval is required before deployment.

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
