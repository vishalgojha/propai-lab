# Dedupe implementation status

Updated: 2026-09-01

This log records the safe, pre-LLM dedupe work completed so far. The system continues to keep
each tenant's raw WhatsApp message, source evidence, and typed rows separate.

## Phase 1 — protocol-message boundary

- Added protocol-event detection for sender-key distribution and protocol messages.
- Protocol events are quarantined before extraction attempts in the extraction worker.
- Real messages carrying `messageContextInfo` are not discarded when they contain text.
- Exact-copy fingerprints now use the same whitespace/forwarding-banner normalization as the
  extraction cache.
- Commit: `1e16522b` (`guard protocol events before extraction`)
- Tests: 63 focused tests passed.
- Coolify: redeploy `extraction-worker` for the worker guard. The shared identity helper is also
  used by backend extraction code, so redeploy `api` if that code path is served there.

## Phase 2 — cross-tenant exact-copy reuse

- Added service-role-only `shared_extraction_results`, keyed by the conservative normalized
  content hash.
- Added `shared_extraction_observations` so every tenant/raw-message reuse is auditable.
- Successful AI extraction output can be reused for an exact copy instead of calling the model
  again; tenant-local cache rows are still warmed for normal tenant-scoped operation.
- Shared results never merge brokers, teams, listings, or tenants.
- Added a service-role-only hit counter RPC with a fixed `search_path`.
- Migration applied to Supabase: `20260901100000_shared_extraction_results.sql`.
- Focused tests: 65 passed across shared dedupe, identity, protocol filtering, cache, and worker
  suites.
- Coolify: redeploy `extraction-worker` and `api` after the phase commit.

## Remaining work

- Test the normalizer and reuse path against a broader live-message sample before enabling wider
  ingestion.

## Phase 5 — operational metrics

- Added service-role-only `get_dedupe_metrics()` for shared-result count, origin/reuse counts,
  reuse rate, model calls avoided, protocol events filtered, and deterministic pre-LLM skips.
- The report intentionally does not label false merges or missed duplicates without a reviewed
  truth set; those require sampled human review.
- Migration: `20260901110000_dedupe_metrics.sql`.
- Coolify: no application redeploy for the SQL-only metrics function; use the migration before
  querying it.

## Phase 3 — direct-call protocol boundary

- Added the same protocol-event quarantine at the start of `process_raw_message`, covering direct
  webhook/background callers that do not pass through the polling worker.
- Added the raw `message_type` to worker contexts so both structured type and payload evidence are
  available to the boundary check.
- Test: direct-call, worker, identity, cache, and extraction regression suites passed (71 tests).
- Coolify: redeploy `api` and `extraction-worker` after this phase commit.

## Phase 4 — deterministic pre-LLM skip boundary

- Applied the existing conservative `should_skip` filter before extraction in
  both worker and direct-call paths.
- Blank, media-placeholder, chatter, too-short, and no-property-signal messages now receive an
  auditable `pre_llm:<reason>` outcome and do not create extraction attempts or model calls.
- The raw WhatsApp row is retained; this is suppression from extraction, not deletion.
- Test: 73 focused tests passed, including worker-lane and direct-call regressions.
- Coolify: redeploy `api` and `extraction-worker` after this phase commit.

## Phase 6 — broker-signature and title safety

- Added a shared guard for residential and commercial extraction: a person/team name
  attached to a trailing WhatsApp phone signature cannot become a building name.
- The rejected candidate is retained only as an internal review candidate; it is omitted
  from the typed row and from the listing title, with the row marked for review.
- Typed conversion no longer falls back to the raw provider building candidate after the
  shared source-grounding guard clears it.
- Titles now use the deterministic source-grounded title when furnishing is present but the
  provider title omits it. Absence markers such as `null`, `none`, and `not specified` stay
  out of presentation copy.
- Regression coverage includes the Radhakishan-style residential case and a commercial
  furnished office case.
- Coolify: redeploy `extraction-worker` and `api`; no migration is required.

## Phase 7 — concurrent shared-call coordination

- Added service-role-only `shared_extraction_claims`, keyed by the versioned
  normalized content hash, so simultaneous exact-copy misses cannot each call
  the LLM.
- A losing worker waits briefly for the origin result and fails closed if the
  result is still unavailable; it never falls through to a second model call.
- Stale claims older than ten minutes can be reclaimed after a worker crash.
- Shared-cache reuse warms only the observing tenant's local cache; it is not
  recorded as a second shared origin.
- Added a local reviewed-corpus evaluator for suppression rate, avoided model
  calls, false merges, missed duplicates, and duplicate recall. These metrics
  remain unmeasured for production until a real reviewed WhatsApp sample is
  available.
- Migration: `20260903100000_shared_extraction_claims.sql` (not applied from
  this workspace because the configured Supabase management credential
  returned HTTP 401).
- Tests: claim race/stale recovery and evaluator tests pass locally.
- Coolify: redeploy `extraction-worker` and `api` only after applying the
  migration; do not enable wider ingestion before the real corpus review.

## Phase 8 — deterministic pre-LLM exact-copy batches

- The worker now partitions eligible rows by the same versioned content hash
  used by the extraction cache and processes each exact-copy group in source
  timestamp/ID order.
- Every raw observation is still handled independently, preserving tenant,
  WhatsApp group, sender, and evidence links. Only the model-call opportunity
  is shared.
- Different message bodies retain parallel provider capacity.
- Coolify: redeploy `extraction-worker` after migration and commit rollout;
  `api` is needed for direct webhook extraction paths.

## Team relationship safety audit

- Existing team inference is limited to explicit agency-signature evidence in
  raw WhatsApp messages, scoped by tenant, with each broker phone/name kept as
  a separate member row.
- Added `20260903110000_preserve_team_relationships_on_rebuild.sql` so a
  rebuild does not delete confirmed memberships or their evidence. This is a
  safety correction to the relationship layer, not a broker-identity merge.
