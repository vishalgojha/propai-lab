# Phase 1 — Operational Function Security

Date: 2026-09-01

## Achieved in this task

- Added an idempotent Supabase migration that reasserts `service_role`-only
  execution for:
  - `claim_extraction_reprocessing_jobs(integer)`
  - `get_building_enrichment_worker_evidence()`
  - `touch_social_flow_meta_settings_updated_at()`
- Hardened all three functions' `search_path` settings to explicit schemas.
- Revoked execution from `public`, `anon`, and `authenticated`.
- Did not modify application data, table contents, layout, or runtime code.

## Production status

Applied successfully to the production Supabase project on 2026-09-01.
Live verification confirmed for all three functions:

- `search_path` is `pg_catalog, public`.
- `public`, `anon`, and `authenticated` do not have execute permission.
- `service_role` has execute permission.
- `claim_extraction_reprocessing_jobs(integer)` remains `SECURITY DEFINER`.

## Coolify redeployment

No Coolify redeploy is required for this database-only migration. After the
Supabase migration is applied, restart/redeploy the API only if the deployment
process requires it for schema cache refresh; the migration itself does not
require a frontend, worker, or public-site redeploy.

## Verification performed after applying

The Supabase catalog was queried with `pg_proc` and
`has_function_privilege`. The result matched the expected grant matrix for all
three functions.
