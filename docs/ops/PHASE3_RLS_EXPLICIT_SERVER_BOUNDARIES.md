# Phase 3 — Explicit Server-Only RLS Boundaries

Date: 2026-09-01

## Scope

Supabase Advisor reported 60 public tables with RLS enabled and no policies.
This phase adds one explicit `service_role`-only policy to each of those 60
tables. Existing tenant-scoped and public policies were not changed.

## Safety behavior

- `service_role` retains server access.
- `anon` and `authenticated` receive no access through these policies.
- No rows were inserted, updated, deleted, or transformed.
- RLS remains enabled on every target table.

## Production verification

The migration was applied to production. Live verification reported:

- `rls_tables_without_policies = 0` (previously 60).
- `explicit_service_role_policies = 121` across the public tables.
- No public-role access was added by this migration.
- The Advisor's RLS-no-policy findings are resolved.

The remaining security Advisor warning is unrelated: `pg_net` is installed in
the `public` schema and is tracked for a later extension-placement phase.

## Coolify redeployment

No Coolify redeploy is required. This is a Supabase-only policy migration.
