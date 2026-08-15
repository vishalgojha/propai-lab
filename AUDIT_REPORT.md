# PropAI Full System Audit

Audit date: 2026-08-15

Scope: repository, checked-in deployment configuration, static route/data-flow review, local syntax/tests/builds, and read-only public HTTP checks. Vishal confirmed that the exposed Supabase key was rotated before this audit. No Coolify dashboard, Supabase SQL console, authenticated browser session, or production logs were available, so production-state conclusions are marked accordingly.

## Executive summary

1. The previously exposed Supabase `service_role` credential is absent from the working tree. All seven scripts now fail closed on `SUPABASE_SERVICE_ROLE_KEY`; the invalid TypeScript script was also repaired. Rotation was confirmed by Vishal, but Coolify secret propagation, Supabase audit logs, and historical Git purging were not independently verified.
2. The screenshot’s `Listings 0` cannot be classified as either real inventory absence or a production bug without Kapil’s typed-table/raw-message rows. Static code does not show an obvious counter/filter bug: the API labels rows from the typed source table, and the UI filters that exact label. The required production query remains open.
3. `www.propai.live` is live and returns SSR HTML, `robots.txt`, and `sitemap.xml`, but it is absent from `deploy/coolify/docker-compose.yml`; it is necessarily a separate deployment resource or an externally managed service. Branch/commit freshness is unverified.
4. Local Python syntax passes. The test suite cannot collect in this environment because the pinned runtime dependencies/import path are not installed. Both Next builds reach Next 16.2.9 but Turbopack fails in the sandbox while trying to bind a process port; this is not evidence of a source build failure.

## Findings

### P0 — historical Supabase service-role credential exposure — mitigated, incident follow-up open

- What was broken: a long-lived `service_role` JWT was hardcoded in seven `apps/www/scripts/*backfill*`/`fetch_untagged` scripts.
- Current status: no JWT-shaped literal remains in those scripts. The scripts use `os.environ["SUPABASE_SERVICE_ROLE_KEY"]` or `process.env.SUPABASE_SERVICE_ROLE_KEY`; see `apps/www/scripts/backfill_option_c_dryrun.py:23-24` and `apps/www/scripts/backfill_corrupted_rows_dryrun.ts:9-11`.
- Evidence: repository scan for JWT-shaped values and the old `SUPABASE_SERVICE_ROLE` variable returned no matches in the affected scripts. Vishal confirmed rotation before this audit.
- Remaining risk: no independent evidence that every Coolify resource received the rotated value; no Supabase audit-log review; no verification that the real historical Git repository was rewritten. This zip’s Git state is not sufficient evidence of history purge.
- Required follow-up: verify Coolify secrets for API, ingestor, extraction, enrichment, building enrichment, semantic worker, MCP, dashboard, and public site; review the exposure window in Supabase audit logs; purge the credential from the canonical Git history if present.

### P1 — Kapil My Deals `Listings 0` remains production-unverified

- What is at issue: the screenshot shows `All 33 · Listings 0 · Requirements 33`.
- Static path: WhatsApp raw message → extraction/resolve/evaluate in `routers/infra.py` → `storage.save_typed_observation()` → `_is_market_requirement()` / `_typed_route()` in `storage/supabase.py:389-392,543-584` → eight typed tables → `storage.get_my_deals()` in `storage/supabase.py:4823-4860` → `GET /api/my/deals` in `routers/listings.py:287-320` → exact `message_type` filter in `frontend/src/app/deals/page.tsx:231-233,289-293`.
- Static assessment: the UI count is derived from returned rows, not hardcoded. The API derives `message_type` from whether the source table ends in `_requirements` (`storage/supabase.py:4096-4098`). No display-only conversion from listing to requirement was found.
- Important classification rule: `intent` values `BUY`, `BUYER`, `REQUIREMENT`, `RENTAL_SEEKER`, `TENANT`, and `DEMAND` route to requirements (`storage/supabase.py:384-392`). A real supply post misclassified with one of those intents would be stored in a requirement table and produce exactly this symptom.
- Important read limitation: `get_my_deals()` fetches up to 150 rows per typed table before ownership filtering (`storage/supabase.py:4840-4845`), then returns at most 300. This is a possible completeness issue for a very large workspace, but it does not explain the screenshot without production row counts.
- Severity: P1 until verified because it affects the reference customer’s CRM. Not enough evidence to call it a confirmed extraction bug.
- Required query: for Kapil’s organization, count all four `*_listings` and four `*_requirements` tables; join each row to `raw_messages` by `raw_message_id`; inspect the newest 24–48 hours of group messages for supply markers (`for sale`, `available`, rent/lease inventory, BHK/area/price) whose typed destination is a requirement table. Compare the same rows returned by `/api/my/deals`.

### P1 — public SEO deployment is outside checked-in compose

- What is observed: `deploy/coolify/docker-compose.yml` defines seven services: `api`, `app`, `ingestor`, `extraction-worker`, `enrichment-worker`, `building-enrichment-worker`, and `semantic-embedding-worker`.
- Evidence: no `apps/www` service or `Dockerfile.www` reference appears in the compose. `Dockerfile.www` exists at repository root.
- Live evidence: `https://www.propai.live/` returned HTTP 200 with `text/html` and `x-powered-by: Next.js`; `robots.txt` and `sitemap.xml` returned HTTP 200. Therefore the public site is active, but not through this compose definition.
- Remaining risk: the separate Coolify resource’s repository, branch, commit, build hook, and deployment history were not accessible. A push to this repository may not update the public site.

### P1 — full production health is unverified

- Coolify service inventory, restart loops, OOM kills, 24–48 hour logs, env completeness, WhatsMeow session stability, queue depth, and worker heartbeats could not be inspected without dashboard/host access.
- `app.propai.live/deals` returned HTTP 307 to `/chat` without an authenticated browser session, then `/deals` returned HTTP 200 HTML when requested directly. This confirms reachability, not authenticated data correctness.
- No live FastAPI route smoke test was possible. Static AST inventory found 20 router modules with routes; production status/expected response shapes remain unverified.

### P1 — Supabase RLS/function privileges require live-state verification

- Migration review shows broad tenant-isolation repair code in `supabase/migrations/20260719000000_live_tenant_isolation_repair.sql`, typed-table RLS generation in `20260803020000_typed_extraction_schemas.sql`, and explicit revokes for the SQL bridge in `20260716000003_harden_supabase_security.sql:80-83`.
- The migration history also contains an earlier grant of `propai_query_sql`/`propai_run_sql` to `authenticated` (`20260713000000_fix_mcp_rpc_security_definer.sql:87-88`) that is later revoked. This needs a live `pg_proc`/`information_schema` privilege check after all migrations; migration text alone cannot prove the deployed final state.
- Public `SECURITY DEFINER` RPCs such as counts/locality summary appear intentional for the SEO site, but their final `search_path`, row filtering, and grants require live verification.

### P2 — orphaned Dockerfiles create deployment ambiguity

- `Dockerfile.worker` and `Dockerfile.semantic-worker` are not referenced by the checked-in compose or source deployment scripts. Workers use `Dockerfile.api` with command overrides (`deploy/coolify/docker-compose.yml:93-202`).
- `Dockerfile.www` is also not referenced by the compose, although the public site is live separately.
- Action: confirm external Coolify resources before deleting any of these files; document ownership or remove them in a separate cleanup change.

### P2 — root web-looking config is ambiguous

- Root `package.json` is a CLI helper, while root `public/`, `tsconfig.json`, `postcss.config.mjs`, and `eslint.config.mjs` resemble an older Next layout. The actual web apps are `frontend/` and `apps/www/`.
- No source change was made because external tooling ownership is unverified.

### P2 — rollback coverage is incomplete

- `supabase/rollback/` contains one manual rollback file for the ambiguous-locality repair, not a rollback for the 187 migration files.
- The existing rollback is evidence-aware and conditionally restores rows, but it is not a general reversible migration system. Treat rollback capability as migration-specific, not guaranteed.

## Data integrity review

- History-sync handling exists in `services/whatsmeow-ingestor/raw_ingest.go:185-190` and `main.go:1798-1840`; it marks history-sync data as `history-sync-suppressed`. Production row distributions and live-facing metric exclusion were not queried.
- Extraction failure handling has explicit retry/dead-letter paths in `extraction_worker.py:326-378,497-513`, and enrichment reporting maps failed jobs in `routers/audit.py:318-319`. Production queue/job samples were unavailable.
- The repository has deterministic extraction and typed-routing regression tests, but they could not be executed here because imports such as `pandas`, `app`, `storage`, and `routers` were unavailable to the current Python interpreter.
- No production sample was available to calculate garbage rates for building/title/broker fields or to verify Kapil’s recent supply messages.

## Frontend and mobile review

- Static review confirms My Deals has an explicit loading/error path, exact listing/requirement filters, edit persistence through `PATCH /api/parsed/{id}`, and source-evidence display. This is not a substitute for click-through.
- The browser-control surface was unavailable in this session. The following remain unverified: primary-nav click-through, Market Map, Market Inbox freshness/locality display, edit persistence in production, AI Chat save flow, console errors, 375/390/412px layouts, WhatsApp in-app browser behavior, tap targets, and hover independence.
- Static My Deals source handling suppresses JIDs/raw account identifiers from the visible source label (`frontend/src/app/deals/page.tsx:90-96`). Contact resolution must still be checked in authenticated rendered HTML.

## Changes made during this audit

- Updated all seven affected ad-hoc scripts to use `SUPABASE_SERVICE_ROLE_KEY`.
- Repaired `apps/www/scripts/backfill_corrupted_rows_dryrun.ts` so it defines `SERVICE_ROLE` and no longer contains the stray backslash/undefined variable.
- Deleted the confirmed dead, invalid Python scratch file `app/api/admin/super-admins/route.py`. Repository-wide Python compilation passed afterward.
- Verified the existing `.pre-commit-config.yaml` gitleaks hook remains at `v8.24.3`.
- Preserved unrelated dirty worktree changes, including `app.py`/`storage/supabase.py` policy from the repository instructions; no changes were made to those files.

## Verification commands and results

- `python3 -m py_compile $(rg --files -g '*.py')`: passed.
- `git diff --check`: passed.
- JWT/old-variable scan in affected scripts: no matches.
- `pytest --collect-only -q`: 448 tests collected, 8 collection errors because the current interpreter lacks required imports/dependencies (`pandas`, `app`, `agent_tools`). Full suite was not runnable in this environment.
- Focused typed-routing/My Deals tests: collection failed for the same missing import-path/dependency condition.
- `npm run build` in both `frontend/` and `apps/www/`: Next 16.2.9 started, then Turbopack failed with `Operation not permitted` while creating a process/binding a port in the sandbox. Re-run in CI/Coolify or a normal dev host.
- Public HTTP: `www.propai.live` root/robots/sitemap returned 200; `app.propai.live` root redirected 307 to `/chat`, and `/deals` returned 200 HTML. Authenticated behavior remains unverified.

## Required next actions

1. Verify the rotated secret in every Coolify resource and review Supabase audit logs for the exposure window.
2. Run the Kapil typed-table/raw-message query and compare its counts with `/api/my/deals`; this is the shortest path to resolving `Listings 0`.
3. Run the test suite in the pinned development/CI environment and run both Next builds outside the restricted sandbox.
4. Inspect Coolify resources/logs/heartbeats and the separate `www.propai.live` deployment commit.
5. Perform authenticated desktop/mobile/WhatsApp-in-app-browser click-through and capture console/network failures.
6. Query deployed RLS and function privileges directly; do not treat migration text as proof of production security state.

## Follow-up change after the audit

The My Deals duplicate gap was implemented after the initial audit:

- `supabase/migrations/20260815160000_requirement_duplicate_review.sql` adds review metadata to all four requirement tables.
- `extraction.py` now flags conservative exact structured requirement repeats while preserving both WhatsApp source records.
- `storage/supabase.py` exposes the candidate metadata and allows the existing explicit merge endpoint to operate on requirements as well as listings.
- `frontend/src/app/deals/page.tsx` now shows `Possible duplicate — review` and an explicit `Merge requirements` action.

This remains a broker-confirmed workflow. It is not active in production until the migration is applied and the extraction worker/API are redeployed. No automatic merge was added.

## Follow-up: source-grounded budget repair

### P1 — capped requirement budget was expanded into a fabricated range

- Evidence: production rows `residential_sale_requirements.id IN (10792, 10793, 10794)` link to raw messages whose preserved text says `Budget: Up to ₹6 Cr`, while their typed values were `budget_min=6000000` and `budget_max=6000000000`. The stored `ai_extraction` contained the same incorrect values. This is an extraction/data-quality defect, not a My Deals formatter defect.
- Fix: `extraction.py` now deterministically interprets `Budget: Up to <amount><unit>` as an absolute upper bound (`budget_min=NULL`, `budget_max=<amount in rupees>`), before persistence. A regression test was added in `tests/test_extraction_pipeline.py`.
- Production repair: `supabase/migrations/20260815180000_repair_up_to_budget_scaling.sql` corrected the three verified Kapil rows to `budget_min=NULL`, `budget_max=60000000`, updated the AI payload, and marked the corrected fields while retaining the original WhatsApp evidence.
- Verification: live query after repair returned all three rows with `budget_min=NULL`, `budget_max=60000000`, and `corrected_fields=["budget_min","budget_max"]`.

### P1 — natural-language rental search bypassed deterministic inventory search

- Evidence: the request `Find 3 BHK rentals in Kandivali West between ₹80,000 and ₹1.2 lakh per month` fell through to the generic `AI search is temporarily unavailable` response.
- Cause: `ai_chat_engine.py` did not include Kandivali West in `_MARKET_LOCALITIES`, and its range parser did not support comma-separated absolute rupee values joined by `and`.
- Fix: Kandivali West/East were added to the locality registry, and the deterministic parser now accepts mixed-unit ranges such as `₹80,000 and ₹1.2 lakh`. This keeps fully specified searches out of the provider/tool clarification path.
- Verification: Python syntax compilation passed. The focused test could not collect in this checkout because the environment lacks the pinned `pandas` dependency.
