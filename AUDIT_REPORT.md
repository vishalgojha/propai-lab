# PropAI Full-Stack Health Audit

Audit date: 2026-08-14. This is a diagnostic pass. Repository changes made during the pass are limited to removing exposed credentials from seven ad-hoc scripts and adding a gitleaks pre-commit hook. Existing unrelated worktree changes were preserved.

## Executive summary

There is one confirmed P0 security incident: a Supabase `service_role` JWT was committed in seven scripts. The literals have been removed from the working tree and the legacy Supabase API keys have been disabled. Because the committed `HEAD` versions contained the JWT, normal deletion was insufficient; all ordinary GitHub branches were rewritten. GitHub-managed hidden pull-request refs cannot be updated through Git transport and remain the only known historical-copy limitation.

The other confirmed issue is a P1 build/lint hazard: `app/api/admin/super-admins/route.py` is invalid Python. Static review also confirms that the Coolify compose file does not deploy `www.propai.live`, while three root Dockerfiles are not referenced by that compose file. These deployment facts require dashboard verification before concluding that traffic is stale or broken.

Live Coolify status/logs, Supabase production state, browser rendering, mobile behavior, SSL, WhatsApp device connectivity, and customer-specific flows could not be verified in this session: no Coolify/Supabase dashboard access or connected browser was available. They are explicitly listed as unverified below.

## Findings

### P0 — exposed Supabase service-role credential

- What is broken: a long-lived Supabase `service_role` JWT for project `jsoiuzfwohtfkctlkozw` was hardcoded in seven scripts under `apps/www/scripts/`. This role bypasses RLS and must be treated as fully compromised.
- Where: `backfill_option_c_dryrun.py`, `backfill_junk_buildings_dryrun.py`, `apply_deterministic_backfill.py`, `backfill_deterministic_dryrun.py`, `backfill_corrupted_rows_dryrun.ts`, `apply_option_c.py`, and `fetch_untagged.ts`.
- Evidence: each file in `HEAD` matched a JWT-shaped token scan before remediation. The current working tree has no JWT-shaped literals and the scripts now require `SUPABASE_SERVICE_ROLE` (for example `apps/www/scripts/backfill_option_c_dryrun.py:24` and `apps/www/scripts/backfill_corrupted_rows_dryrun.ts:10-11`).
- Impact: full database read/write exposure, including possible tenant data and PII access.
- Remediation evidence: a replacement Supabase secret key returned HTTP 200 against the REST gateway; the old exposed key returned HTTP 401 after legacy keys were disabled. Coolify updated eight resources and queued deployments for API, ingestor, extraction, enrichment, semantic worker, MCP, dashboard, and public site. Audit database/auth/storage activity from the exposure window. Do not use the old token.

### P1 — invalid Python file can break repository-wide checks

- What is broken: `app/api/admin/super-admins/route.py` contains JavaScript import syntax.
- Evidence: `/usr/bin/python3 -m py_compile app/api/admin/super-admins/route.py` fails at line 1 with `SyntaxError: invalid syntax`.
- Impact: compileall, broad lint, packaging, or deployment checks that traverse `app/` can fail even though the file is not imported by the running application.
- Suggested action: delete the abandoned scratch file or replace it with valid Python only after confirming it is not used. The live admin implementation appears to be `routers/admin.py`.

### P1 — public-site deployment is not represented in the checked-in Coolify compose

- What is observed: `deploy/coolify/docker-compose.yml` defines seven services (`api`, `app`, `ingestor`, `extraction-worker`, `enrichment-worker`, `building-enrichment-worker`, and `semantic-embedding-worker`) but no `www` service.
- Evidence: compose starts `api` at lines 2-42 and the dashboard `app` at lines 44-71; no `apps/www` or `Dockerfile.www` reference exists in the file. `Dockerfile.www` exists at repo root.
- Impact: either the public SEO site is a separate Coolify resource and must be checked for branch/image freshness, or changes to `apps/www` are not deployed by this compose resource.
- Required verification: inspect Coolify resources, domains, deployment commit, and recent deployment logs for `www.propai.live`.

### P2 — orphaned deployment artifacts create architecture ambiguity

- What is observed: `Dockerfile.worker` and `Dockerfile.semantic-worker` exist but are not referenced by the compose; worker services instead use `Dockerfile.api` with command overrides (for example lines 184-191).
- Impact: operators may edit or deploy the wrong Dockerfile, and stale architecture assumptions can hide missing runtime dependencies.
- Suggested action: confirm whether the files are historical. Remove or document them in a separate cleanup change after checking external Coolify resources.

### P2 — root Next-style configuration is confusing but not itself a web app

- What is observed: root `package.json` is a `propai` CLI package, while root `public/`, `tsconfig.json`, `postcss.config.mjs`, and `eslint.config.mjs` resemble a former Next app. The actual web surfaces are `frontend/` and `apps/www/`.
- Impact: contributors and automated agents can target the wrong app or run the wrong build/lint commands.
- Suggested action: document ownership or remove stale config after checking whether any scripts/package tooling still consumes it.

## 1. Coolify / infrastructure layer

Static evidence confirms the seven compose services and their environment-variable wiring. The compose passes `SUPABASE_SERVICE_KEY` to API, dashboard, ingestor, and workers (for example lines 11-12, 52-53, 81-84, and 157-158).

Not verified: live service count, image/branch freshness, container health, 24–48 hour logs, CPU/RAM/disk, SSL/domain routing, four WhatsApp device connections, cron/scheduler state, or production enrichment status. These require Coolify/Supabase access. The code does contain heartbeat and bounded retry paths for building enrichment, but code presence is not proof that production workers are running.

## 2. Backend API layer

The repository contains 20 router modules under `routers/` plus the invalid scratch file under `app/api/admin/super-admins/`. Static migration review found the SQL bridge hardening migration revokes `propai_query_sql` and `propai_run_sql` from `public`, `anon`, and `authenticated`, granting execution only to `service_role` (`supabase/migrations/20260716000003_harden_supabase_security.sql:80-83`). RLS enablement for `ai_usage_log` is present in the multi-tenant migration path.

Not verified: live smoke responses for every route, normal-traffic exceptions, tenant resolution/Sanjay behavior, MCP response correctness, production RPC privileges after all migrations, and live RLS state. Migration text is not equivalent to database state.

## 3. Desktop frontend

Static inventory confirms public routes for home, search, map, listings, localities, buildings, contact, sitemap, robots, AI chat, public requirements, search, latest listing, tracking, and server-side broker contact resolution. The contact endpoint exists at `apps/www/src/app/api/contact-broker/[id]/route.ts`.

Not verified: Market Inbox freshness/pagination, Market Map rendering, Pulse answers/timeouts, My Deals CRUD, onboarding group cap and tenant isolation, PII leakage in rendered HTML, commercial-field persistence/rendering, console errors, or primary-nav click-through. These require live authenticated/browser tests and production data.

## 4. Mobile view

Not verified. No connected browser was available, so 375px, 390px, 412px, WhatsApp in-app browser behavior, tap targets, horizontal overflow, modal sizing, and hover assumptions remain open.

## 5. Data integrity spot-checks

Static code shows explicit `is_backfill` references, building-enrichment retry methods, and extraction retry handling. This does not verify row distributions, recent `building_name` garbage rate, history-sync contamination, completion-state correctness, or `place_id`/`building_id` mappings in production.

Not verified: the requested 50-row recent listing sample, raw-message contamination percentages, live retry/backoff outcomes, and new dedup mappings. These require read-only production queries after key rotation using a newly issued credential.

## 6. Remediation completed during this pass

- Removed all seven hardcoded JWT literals from the working tree.
- Made the seven scripts fail closed unless `SUPABASE_SERVICE_ROLE` is explicitly supplied.
- Added `.pre-commit-config.yaml` with a gitleaks hook.
- Preserved unrelated pre-existing worktree changes.
- Ran `git diff --check` successfully.

## Immediate operator checklist

1. Review Supabase audit/database/auth/storage logs for unauthorized activity.
2. Remove or rewrite GitHub-managed hidden pull-request refs 1 and 2 using GitHub administrator/API access; ordinary branches are already rewritten.
3. Confirm the gitleaks hook runs in CI as well as developer pre-commit.
4. Re-run the unverified production, browser, and mobile checks with fresh credentials.
