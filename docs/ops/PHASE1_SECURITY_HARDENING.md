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

This commit contains the migration only. Production application could not be
verified from this session because Supabase access was unavailable. The
migration must be applied by the configured Supabase deployment process before
the database state can be marked confirmed.

## Coolify redeployment

No Coolify redeploy is required for this database-only migration. After the
Supabase migration is applied, restart/redeploy the API only if the deployment
process requires it for schema cache refresh; the migration itself does not
require a frontend, worker, or public-site redeploy.

## Verification to run after applying

Confirm `has_function_privilege` is true only for `service_role` and false for
`anon` and `authenticated`, and confirm the three functions have explicit,
immutable schema-qualified search paths.
