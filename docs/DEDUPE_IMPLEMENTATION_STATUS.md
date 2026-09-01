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
