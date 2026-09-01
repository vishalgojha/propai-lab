# Phase 2 — Building Identity Function Security

Date: 2026-09-01

## Achieved

- Locked down three internal building-identity maintenance functions:
  - `reconcile_enriched_building_identity(bigint)`
  - `refresh_building_identity_review_queue()`
  - `requeue_building_enrichment_for_context()`
- Revoked execution from `public`, `anon`, and `authenticated`.
- Retained execution for `service_role`.
- Set explicit `search_path=pg_catalog, public` on all three functions.

## Production verification

The pre-change Supabase advisor/catalog check found all three functions were
`SECURITY DEFINER` and executable by all public roles. The migration was then
applied to production and verified through `pg_proc` and
`has_function_privilege`.

Post-change verification confirmed that only `service_role` can execute these
functions. Supabase's remaining security advisor findings are unrelated RLS
no-policy notices and the `pg_net` extension placement warning; these are
tracked for the next phases.

## Coolify redeployment

No Coolify redeploy is required. This is a Supabase-only privilege migration.
The building-enrichment worker already uses the service role; restart it only
if the deployment process requires a connection refresh.
