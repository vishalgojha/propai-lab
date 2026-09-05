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
| 1 | Google Places building evidence is not used by locality resolution | wasted signal | `building_enrichment_sources`; `agents/location_resolver.py`; `storage/supabase.py` | Done | Monitor future building enrichment and add only collision-checked locality vocabulary. |
| 2 | `combined_locality_rules` is schema-only and unused | dead code | `public.combined_locality_rules`; `20260705191720_phase2_remaining.sql` | Deferred | Retire it or document and implement its intended consumer. |
| 3 | `location_aliases` has no seed data or confirmed persistence path | wasted signal | `public.location_aliases`; `agents/location_resolver.py` | Deferred | Decide whether accepted resolver suggestions should persist aliases or the feature should be retired. |
| 4 | `resolver_decisions` is legacy observability not written by typed extraction | dead code | `public.resolver_decisions`; `storage/supabase.py`; `extraction.py` | Deferred | Replace it with a typed-pipeline decision log or formally retire it. |
| 5 | Extraction attempts accumulate high failure and stuck counts | silent failure | `extraction_attempt_log`; admin observability | Not Started | Repair the telemetry consumer and define alerting/SLOs for failed, dead-lettered, and long-running attempts. |
| 6 | Reprocessing run history has open/error states without a complete operational consumer | silent failure | `extraction_reprocessing_runs`; `extraction_reprocessing_jobs` | Deferred | Add terminal-state reconciliation and operator-visible run outcomes. |
| 7 | Low-confidence grounding quarantine has no demonstrable recovery drain | silent failure | typed tables; `validation_flags`; `needs_review`; `extraction_reprocessing_jobs` | Deferred | Existing backlog remains untouched; revisit only if a later approved decision requires it. |
| 8 | `needs_review` is near-universal in several listing tables | silent failure | all eight typed listing/requirement tables; `needs_review` | Done | Monitor newly written rows; historical rows remain a separate approved decision. |
| 9 | Validation flags accumulate without a clean issue lifecycle | wasted signal | typed tables; `validation_flags` | Not Started | Separate active issues from historical flags and add ownership/aging semantics. |
| 10 | Locality backfill logic targets unified views and `micro_market`, not canonical locality fields across all eight tables | spec drift | `scripts/backfill_localities.py`; typed tables | In Progress | Replace the legacy text/backfill path with the structured all-eight-table resolver contract. |
| 11 | Requirement and listing schemas evolved through inheritance plus uneven additions | spec drift | `20260803020000_typed_extraction_schemas.sql`; `storage/supabase.py` allowlists | Deferred | Generate and test a cross-table extraction-field contract. |
| 12 | Dedupe behavior differs by entity type and feed surface | silent failure | `storage/supabase.py`; `routers/search.py`; listing/requirement tables | Deferred | Establish one canonical feed/dedupe contract for every user-facing surface. |
| 13 | Extraction confidence has multiple semantic sources | spec drift | `extraction_confidence`; `ai_extraction` numeric confidence; grounding migration | Deferred | Define one canonical confidence value and its provenance. |
| 14 | Expired/stale requirements are not consistently excluded by internal/API search | silent failure | four requirement tables; `storage/supabase.py`; `routers/search.py` | Deferred | Apply one freshness predicate contract to every requirement consumer. |
| 15 | AI correction scheduler is implemented but not wired or deployed as an active scheduler | dead code | `correction_layer.py`; `scheduler.py`; `ai_correction_runs` | Deferred | Assign a deployment owner and wire scheduling, locking, and monitoring. |
| 16 | Several audit/learning/operations tables are empty and have no confirmed active consumer | dead code | `data_quality_backfill_runs`; `extraction_backfill_audit`; `locality_assignment_repair_audit`; `learning_cards`; `listing_observations`; `observation_batches`; operations/broker tables | Deferred | Inventory each table and retire or wire it deliberately. |
| 17 | `WIRING_AUDIT.md` is stale and misclassifies current references | spec drift | `WIRING_AUDIT.md`; `storage/supabase.py`; admin/frontend observability paths | Not Started | Regenerate the wiring audit after Phases 1–3 are settled. |
| 18 | Intended locality hierarchy is split across multiple partial authorities | spec drift | `docs/DATA_QUALITY.md`; `architecture.md`; locality resolver/backfill paths | In Progress | Make `locality_reference` plus exact structured resolution the canonical write path. |
| 19 | Building enrichment evidence is preserved but disconnected from canonical identity | wasted signal | `building_enrichment_sources`; building enrichment workers; locality fields | Done | Monitor promotion-run audit totals and preserve ambiguous evidence for later review. |
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

### Phase 2 — DONE (logic fix deployed)

The Phase 1 evidence confirmed an over-flagging bug. The agreed scope is a
small logic fix only: no review team, assignment model, queue, triage UI, or
historical backlog rewrite.

Changes implemented and deployed:

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

Deployment: commit `78f19710` was pushed to `origin/main`. Coolify `api`
deployment `ltab6d3zsorxq42horiv8xow` and extraction-worker deployment
`ybcyy2k4isqe62s9kaicktbh` both finished successfully. The worker's reported
source revision contains the approved commit.

These edits contain no backfill or data-repair operation. Existing production
rows were deliberately unchanged: before/after data-row impact is `0 / 0`.
The `needs_review = true` backlog remains a separate decision. The initial API
deployment attempt failed while building an unrelated older revision; it was
discarded, and the successful retry used the production `main` branch.

### Phase 3 — DONE (migration applied)

The existing code has a partial, non-authoritative building signal: during
`link_typed_observation_to_building`, `storage/supabase.py` can copy a
high-confidence building `micro_market` into an empty row's
`locality_resolved`, but it does not resolve `locality_id`, does not inspect
`building_enrichment_sources.address`, and is not a locality backfill. The
feed code only attaches verified building addresses for display. There is no
current path that promotes a verified Places address into the canonical
locality fields.

#### Proposed evidence hierarchy

1. **Eligibility:** only rows in the eight typed listing/requirement tables
   whose status is `missing` or `unmatched`, with a non-null `building_id`,
   are candidates. Existing `matched` rows are read-only in this phase and
   must never be overwritten automatically.
2. **Building evidence:** require a `building_enrichment_sources` row from
   provider `google_places` for `address`, a non-empty address, and source
   confidence at least `0.90`. The canonical `buildings` record may be used
   as a consistency check, but source evidence remains the provenance.
3. **Reference matching:** normalize punctuation and common road suffixes,
   then match the full address against `locality_reference.sub_locality`,
   `alternate_names`, and `landmarks`. A parent locality label is eligible
   only through its explicit parent row (`sub_locality = parent_locality`);
   it must not fan out to every child row.
4. **Promotion rule:** populate `locality_resolved` with the reference
   parent and `locality_id` with one unique reference row only when all
   matched evidence yields exactly one parent and one reference row. Preserve
   `locality_raw`, `micro_market`, and the source address.
5. **Non-guessing rule:** multiple parent localities become ambiguous; one
   parent with multiple possible child reference rows is not safe for a
   `locality_id` write; no reference hit remains unmatched. These outcomes
   should be reported/flagged by the eventual migration, not guessed.
6. **Precedence:** a future implementation may use an existing non-empty
   locality signal as corroboration, but it must not override an existing
   matched row. If building evidence disagrees with a matched row, emit a
   review/validation record for a later explicit decision.

#### Live dry-run (read-only)

The preview used the current production `locality_reference` (152 rows) and
all eight typed tables. It joined unresolved rows to verified
`google_places` address sources at confidence `>= 0.90`; no production row was
written. The current source data has 9,703 qualifying address records, all in
the `>= 0.95` confidence band.

| Outcome | All eight tables | Confidence band |
|---|---:|---|
| Unique parent + unique reference row | 1,270 | all `>= 0.95` |
| Multiple parent localities (ambiguous) | 309 | all `>= 0.95` |
| One parent, multiple child reference rows | 173 | all `>= 0.95` |
| No current reference candidate | 614 | all `>= 0.95` |
| **Eligible unresolved rows** | **2,366** | **all `>= 0.95`** |

| Table | Deterministic | Ambiguous | Same-parent multiple | No candidate | Eligible |
|---|---:|---:|---:|---:|---:|
| `residential_sale_listings` | 707 | 145 | 100 | 255 | 1,207 |
| `residential_rent_listings` | 410 | 123 | 70 | 197 | 800 |
| `commercial_sale_listings` | 54 | 14 | 1 | 80 | 149 |
| `commercial_rent_listings` | 77 | 25 | 0 | 65 | 167 |
| `residential_sale_requirements` | 3 | 0 | 1 | 4 | 8 |
| `residential_rent_requirements` | 16 | 1 | 0 | 11 | 28 |
| `commercial_sale_requirements` | 1 | 1 | 0 | 0 | 2 |
| `commercial_rent_requirements` | 2 | 0 | 1 | 2 | 5 |

The earlier 1,224 figure is therefore stale or used a narrower population
definition; the reproducible current preview is 2,366 across all eight
tables (2,323 listings and 43 requirements). Examples of ambiguity include
addresses containing both `Bandra East` and a locality label currently mapped
to `Malad West`, and addresses containing `Santacruz West` plus `Sion`. An
address such as `Imperial Heights, 16th Rd, Bandra West` remains no-candidate
under the current reference because the prior repair intentionally removed an
unsafe 16th Road alias. That is correct non-guessing behavior pending an
explicit, locality-safe reference decision.

The current Bandra West reference already contains 17 rows covering Pali
Hill, Carter Road, Hill Road, Linking Road, Turner Road, St. Andrews Road,
Bandstand, Mount Mary, Ranwar, Chimbai Road, Bandra Reclamation, Waterfield
Road, and Perry Road, plus related areas. It does not currently provide a
safe 20th Road or Perry Cross Road alias, and 16th Road was deliberately
removed by the ambiguity repair migration. Any expansion should add explicit
aliases with provenance and collision checks, not broad parent aliases.

#### Implementation prepared

Migration `20260904123000_promote_places_building_localities.sql` is now
authored locally. It is generic across all eight typed tables, adds only the
missing Bandra West parent/road vocabulary, promotes only deterministic
building-address candidates, and appends validation flags for ambiguous or
unmapped candidates without changing `needs_review`. It does not select rows
already carrying `locality_id` or `locality_match_status = 'matched'`.

#### Phase 3 status and next action

The migration `20260904123000_promote_places_building_localities.sql` was
applied to the linked production database on 2026-09-04. The isolated CLI
ledger targeted only this migration; the production ledger records the
migration as applied. No application service redeployment was required.

#### Production result

The run recorded 2,366 eligible unresolved rows, all with Places evidence at
confidence `>= 0.95`:

| Outcome | Rows | Production action |
|---|---:|---|
| Deterministic unique parent/reference | 1,618 | Promoted to `locality_resolved`/`locality_id`; status set to `matched` |
| Ambiguous parent | 237 | Left unresolved; appended `building_places_locality_ambiguous` |
| Ambiguous child under one parent | 174 | Left unresolved; appended `building_places_locality_child_ambiguous` |
| No reference candidate | 337 | Left unresolved; appended `building_places_locality_no_reference` |
| **Total eligible** | **2,366** | **No `needs_review` assignment** |

Post-migration status counts were verified read-only across all eight tables:

| Table | Missing | Unmatched | Matched | Matched with locality_id |
|---|---:|---:|---:|---:|
| `residential_sale_listings` | 26,381 | 1,403 | 2,605 | 2,605 |
| `residential_rent_listings` | 6,404 | 1,315 | 1,931 | 1,931 |
| `commercial_sale_listings` | 1,179 | 327 | 277 | 277 |
| `commercial_rent_listings` | 2,269 | 2,999 | 4,776 | 4,776 |
| `residential_sale_requirements` | 5,853 | 1,008 | 1,506 | 1,506 |
| `residential_rent_requirements` | 2,746 | 1,229 | 1,001 | 1,001 |
| `commercial_sale_requirements` | 2,344 | 355 | 736 | 736 |
| `commercial_rent_requirements` | 1,820 | 603 | 546 | 546 |
| **Total** | **48,996** | **9,239** | **13,378** | **13,378** |

The migration's update predicates require both `locality_id is null` and
`locality_match_status in ('missing', 'unmatched')`; matched rows were not
selected. No `matched` row without a locality ID was found after the run.
The run was recorded in `data_quality_backfill_runs` as
`places_building_locality_promotion_20260904`.

Phase 3 production data impact: `1,618` locality promotions and `748`
ambiguity/no-reference validation-flag additions. Existing matched rows and
the `needs_review` field were not changed by this migration.

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
