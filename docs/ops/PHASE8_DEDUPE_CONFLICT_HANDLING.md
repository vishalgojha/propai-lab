# Phase 8 — Dedupe Conflict Handling

Date: 2026-09-01

## Finding

The dominant extraction-reprocessing failure was a Supabase REST `409
Conflict` from the `raw_message_dedupe_claims` insert. The storage adapter
already intended to treat unique-claim races as normal, but only recognized
`httpx.HTTPStatusError`. Production surfaced the same response as a generic
exception containing `409 Conflict`, so the worker incorrectly recorded it as
an extraction failure.

## Achieved

- Recognized the generic Supabase REST `409 Conflict` form as the expected
  concurrent dedupe-claim path.
- Preserved the existing read-after-conflict reconciliation behavior.
- Added a regression test covering the production-shaped exception.
- Focused test result: **1 passed**.

## Production status

Code is committed and pushed. The fix takes effect after the services below
are redeployed from the new `main` commit.

## Coolify redeployment required

Redeploy these PropAI services:

- `api` — `djbbkdp28uhoc5p8cfnjr642`
- `extraction-worker` — `fpmr99xoi9qc7bdclals8jzb`
- `extraction-reprocessing-worker` — `nwk9fcgtn4mb7kiutvaxfl8i`

No Supabase migration is required. No public site, app frontend, matcher,
ingestor, enrichment, or semantic-worker redeploy is required for this code
path.
