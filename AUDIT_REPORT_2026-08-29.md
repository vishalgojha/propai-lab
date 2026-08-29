# PropAI deep audit — 2026-08-29

Status: code and migration review completed. The confirmed broker-building fix was applied through the authenticated Supabase CLI session and verified in production; the remaining audit items are report-first pending live evidence collection.

## 1. Stale Aug 15 baseline

`AUDIT_REPORT.md` covered repository/deployment static review, public HTTP checks, the prior service-role secret cleanup, the unverified Kapil “Listings 0” question, public SEO deployment ambiguity, generic production-health/RLS uncertainty, Dockerfile/deployment ambiguity, rollback coverage, history-sync/retry paths, and static frontend/mobile review. Its follow-ups included requirement duplicate review, budget repair, deterministic natural-language search, and the public locality BHK route.

It explicitly did not have Coolify, Supabase SQL-console, authenticated browser, or production-log access. The current audit extends the baseline with direct review of post-Aug-15 migrations and the current full extraction, broker graph, typed-table, dedupe, public SEO, and UI projection paths.

## 2. Immediate confirmed defect and fix

### High — broker “Buildings Mentioned” admits locality labels

Evidence: `supabase/migrations/20260825220000_rebuild_broker_graph_from_typed_tables.sql` rebuilds `broker_building_stats` from all eight typed listing/requirement tables using only a nonblank check. `routers/brokers.py` reads that derived table for broker profiles. The Python validator in `extraction_quality.py` is not callable from SQL.

The existing `20260829100000_clean_broker_building_locality_labels.sql` is one-shot: the next graph rebuild reintroduces the rows. Python already handles `Bandra Preferred` and `Bandra / Khar Preferred` through the suffix/segment logic in `building_name_problem()`; the SQL path did not.

Fix prepared: a `BEFORE INSERT/UPDATE` database trigger filters locality names and locality-only slash/to/dash segments, including `Preferred`, using `locality_reference` plus an explicit Mumbai fallback list. A statement-level trigger refreshes `brokers.building_count`. The migration deletes existing polluted aggregate rows, rebuilds the graph, and preserves source typed records.

Verification completed locally: Python checks return `building_name_is_locality` for `Bandra Preferred`, `building_name_is_locality_range` for `Bandra / Khar Preferred`, `building_name_is_locality` for `Bandra East`, and no problem for `Royal Manor`; Python compilation and `git diff --check` pass.

Production verification after apply: 5,211 `broker_building_stats` rows, zero preference-suffix matches, no remaining matching names in the inspected class, and zero broker `building_count` mismatches. The migration version was also recorded in `supabase_migrations.schema_migrations`. The initial broad `db push` remains unsuitable because this checkout lacks many older remote migration files; only this migration was executed directly.

## 3. Prioritized findings

### P0 — production security/health claims remain unverified

The repository cannot prove current Coolify secret propagation, service restart/health, CPU, disk I/O, worker heartbeats, or Supabase audit-log state. The public site is a separate deployment from the checked-in compose. Re-authenticate Supabase/Coolify and collect live evidence before treating the earlier secret rotation and current deployment as closed.

### P1 — SQL/Python parity gaps

These are direct re-derivation sites requiring field-level comparison with Python output:

- `rebuild_broker_graph()` reads raw typed `building_name`, `micro_market`, and timestamps without extraction-quality validation. The building portion is fixed by the pending migration; market stats still deserve a deliberate canonicalization policy.
- `20260803020000_typed_extraction_schemas.sql` and `20260803031000_legacy_compatibility_bridge.sql` derive typed/compatibility rows with SQL `COALESCE`, numeric regex conversion, intent/asset helpers, and legacy `parsed_output` joins. This is a projection boundary, not the Python extraction boundary; mismatches can be created if the source column was persisted before a Python repair.
- `20260808120000_listing_locality_fallbacks.sql` and `20260808190000_fix_listing_insert_statement_timeout.sql` independently resolve locality/building associations from names and aliases. Compare their canonicalization with `location.py`, `extraction_quality.py`, and `storage` resolution.
- `20260808130000_fix_building_counter_trigger_safe_update.sql` counts building mentions by direct lower/trim or alias equality. It can count a locality label unless its upstream registry is already clean.
- `20260804150000_fix_market_inbox_typed_feeds.sql`, `20260804140000_fix_broker_feed_after_typed_cutover.sql`, and `20260821120000_extraction_boundary_repair_jobs.sql` independently aggregate typed fields for cards/jobs. They need a single projection contract and live count comparison with the API surfaces.
- `20260812080000_optimize_locality_summary.sql` derives locality summaries directly from typed fields. It is intentionally SQL-backed but does not visibly share the Python field-quality guards.

### P1 — extraction regex overrides need an explicit evaluation ledger

The current code is better than the Aug 15 baseline: overrides are recorded in `deterministic_overrides`, source transaction guards are limited to exclusive markers, price guards retain review flags, and multi-item source slices are checked for grounding. Still, the audit found override-capable paths in `ai_extraction.py` and `extraction.py` for price shorthand, possession date, parking, locality, transaction type, BHK/area/price rescue, title generation, building repair, and boundary conflict handling. Some fallbacks fill missing values without a confidence threshold; others replace AI values when source regex is considered explicit.

Priority action: emit one normalized audit event per field (`before`, `after`, source span, rule, AI confidence, final review state), sample all overrides for 7–14 days, and only then tighten rules. Do not replace deterministic extraction wholesale.

GLM review: `ai_extraction.py` now supports model-agnostic OpenRouter secondary variables with old DeepSeek variable fallback, uses `response_format: {type: json_object}`, and allows 16,384 output tokens. Code review cannot establish GLM field accuracy. No production sample was available because the live database query was blocked. Required evaluation is 100 GLM rows, manually labeled for BHK, price, locality, transaction type, and building, matched against a DeepSeek sample where available.

### P1 — dedupe is tenant-scoped but production cross-tenant behavior is unverified

The current exact author/content claim key is `(tenant_id, author_content_fingerprint)`, and raw-message UID dedupe is also tenant-scoped. This correctly prevents one tenant’s message from suppressing another tenant’s evidence. Requirement/listing structured fingerprints and near-duplicate candidates must still be checked in production for tenant predicates, especially the compatibility projections and cache paths. Never auto-merge same-building/different-floor or cross-tenant records.

Required live checks: duplicate claim counts by tenant; same fingerprint across tenants; typed rows sharing `(tenant_id, raw_message_id, listing_index)`; requirement/listing candidate pairs crossing tenant IDs; and rows marked duplicate without a corresponding source/evidence row.

### P1 — derived UI fields need source-contract verification

Broker profile buildings are confirmed broken as above. Other surfaces requiring live comparison are broker listing/requirement counts, market counts, active days, broker aliases/phones, group counts, contribution highlights, Market Inbox cards, operating areas, locality/building counts, source mix, parsed contacts, freshness timestamps, and public listing detail fields. `routers/brokers.py` mixes typed-feed fallback with the legacy graph and also reads `parsed_output_unified` for observations; that can produce internally inconsistent profile panels during partial rebuilds.

Priority action: define one source query per displayed metric, add a parity endpoint/test fixture, and compare API JSON against the rendered card. Counters must never silently fall back to a different population.

### P1 — RLS and SECURITY DEFINER require live catalog audit

Static migration review shows tenant policies for the recent private CRM/custom-field/workspace tables and explicit hardening/revokes in `20260809090000_harden_security_linter_functions.sql`. The migration history has multiple generations of grants, including earlier MCP RPC grants later revoked. A final answer requires live catalog queries for every table containing `tenant_id`: `relrowsecurity`, policy count, policy expressions, and anonymous/authenticated grants.

Also query every `pg_proc.prosecdef = true` function in `public`, `app_private`, and related schemas; record `proconfig` search paths and `aclexplode(proacl)` grants. The new broker trigger functions are security-invoker and should not be exposed as client RPCs, but this must be checked after apply.

### High — indexes and database health cannot be certified offline

Recent migrations add indexes for typed feeds, tenant columns, CRM, saved searches, dedupe, matching, and semantic candidates. A complete audit still needs live `pg_indexes` plus foreign-key/filter/order coverage, including all eight typed tables, `raw_messages(tenant_id, created_at)`, `raw_messages(tenant_id, message_uid)`, typed `(tenant_id, raw_message_id, listing_index)`, broker aggregate foreign keys, and public freshness/order queries. CPU/disk I/O are platform metrics unavailable through repository inspection; collect them from Supabase/Coolify for a 24-hour window.

### High — `/explore` PII and service-role rotation need live confirmation

Static public code keeps phone resolution behind `/api/contact-broker/[id]` and does not embed numbers in listing-card HTML. The repository has no authenticated production response evidence for `/explore`; crawl the deployed route and inspect HTML/API payloads for phone/JID/email leakage. Service-role rotation also cannot be verified from source: check every Coolify resource, including the separately deployed `www` site and all workers, and confirm old-key rejection.

### Medium — locality/building page coverage is present but deployment freshness is uncertain

The public app has listing detail, locality, locality segment, building, search, map, and sitemap routes. The separate public deployment’s branch/commit and regeneration behavior remain unverified. Validate SSR data, real timestamps, sitemap `<lastmod>`, and removed-listing behavior in production.

## 4. Fix sequence

1. Re-authenticate Supabase/Coolify and apply the broker-building guard; verify the backfill and profile counters.
2. Run live RLS, SECURITY DEFINER, index, health, dedupe, and derived-field queries; save results with timestamps.
3. Add the extraction override ledger and run the GLM-vs-DeepSeek/manual 100-row evaluation.
4. Consolidate SQL projections only where live parity shows a real divergence; preserve evidence and tenant boundaries.
5. Re-test public PII, sitemap/freshness, and all separate Coolify deployments.

## 5. Evidence limitations

The confirmed broker-building migration is production-applied and verified. CPU/disk percentages and Coolify service-secret propagation remain unavailable from the current checks; the live catalog, dedupe, advisor, and public PII results are recorded below. No production phone numbers or secrets are included.

## 6. Live audit results — 2026-08-29

### Resolved — three SECURITY DEFINER RPCs were publicly executable

The live Supabase advisor and `pg_proc` catalog initially confirmed anonymous/authenticated execute grants on `claim_extraction_repair_jobs(integer)`, `get_workspace_extraction_progress(uuid, integer)`, and `rebuild_broker_team_intelligence()`. Repository callers are server-side worker/dashboard storage paths. Migration `20260829170000_revoke_public_security_definer_rpc_grants.sql` revoked client-role access and retained `service_role` access; production verification shows only `postgres` and `service_role` grants. The advisor no longer reports these three findings.

### Resolved — internal views were SECURITY DEFINER and publicly granted

`parsed_output_unified` includes broker contact fields and `extraction_needs_review` exposes internal review rows. Migration `20260829180000_harden_security_definer_views.sql` changed both to `security_invoker=true` and removed `anon`/`authenticated` grants, retaining `service_role`. Production verification and the security advisor confirm both view findings are gone.

### High — requirement tenant assignments need investigation

Live comparison of each typed row to its `raw_messages.tenant_id` found mismatches in all four requirement tables: 3,339 residential-sale, 1,657 residential-rent, 1,572 commercial-sale, and 1,129 commercial-rent rows. This may reflect intentional network fan-out, but it is not safe to assume that. There were 199 raw message IDs represented by typed rows in more than one tenant; `requirement_matches` had zero cross-tenant requirement/listing pairs in the tested query. No repair was made because the intended sharing model must be confirmed from ingestion/fan-out semantics first.

The deeper trace found that mismatched `WHATSAPP` rows extend through 2026-08-28. A sample showed typed requirement records whose `created_at` predates the current raw row's insert time and raw rows still unprocessed, so existing records cannot safely be repaired by copying either side's tenant ID. Migration `20260829190000_enforce_typed_raw_tenant_match.sql` now adds a trigger to all eight typed tables. It rejects future inserts or retargeting updates when a non-null typed tenant differs from the source raw tenant, while leaving the existing mismatches untouched for a source/ownership investigation.

The group-directory comparison found 5,395 distinct affected raw IDs: 2,035 belong to groups represented in multiple tenant directories and 1,068 have no directory row, so group name alone cannot identify ownership. The application save paths now pass the source tenant explicitly in `extraction.py`, `scheduler.py`, and the manual ingest route; the database trigger is the final fail-closed check. Existing rows still require an ownership-safe replay or quarantine decision.

### Medium — duplicate typed-source keys are widespread

There are 3,850 `(tenant_id, raw_message_id)` keys repeated across the eight typed tables. The breakdown includes every listing and requirement class, so this is not automatically a bug: a single broadcast may produce multiple units or a listing plus a requirement projection. It needs a second key including the item/listing index or source fingerprint before dedupe changes are considered.

### Medium — missing foreign-key indexes

The live FK/index check found 17 columns without an index, including `agent_audit_log.browser_session_id/user_id`, browser-session `session_id/user_id`, `broker_team_members.broker_id`, developer crawl `source_id`, `extraction_repair_jobs.tenant_id`, `leads.client_id`, operations-agent session links, `raw_messages.repeat_of_raw_message_id`, and several Social Flow ownership/tenant links. Add only indexes confirmed by query plans and workload.

### Medium — performance advisor findings

Supabase reports four duplicate locality indexes on the typed listing tables, repeated auth/current-setting evaluation in seven RLS policies, and multiple permissive CRM policies. PostgreSQL statistics show 16 backends, 4,375,513,524 block reads, 56,466,893,174 block hits, 1,099,109 temp files, and 2,135,038,330,704 temp bytes since reset. These are cumulative counters, not CPU/disk percentages; platform metrics are still required.

### Public PII smoke test

`https://www.propai.live/explore` currently returns a production 404, and the downloaded HTML contained no phone-number-shaped values. This supports that the old `/explore` response is not leaking PII, but it also means the route itself is absent; confirm whether that is intentional before treating the security test as fully closed.

### GLM provider evidence

The production `extraction_attempt_log` currently records `fast` and `backlog` lanes but no provider/model metadata, and persisted `parsed_output_legacy.ai_extraction` has no `provider_used` values. A reliable GLM-vs-DeepSeek accuracy comparison cannot be reconstructed from current production telemetry. Instrumentation is required before spending the 100-row evaluation budget.

### Remaining security advisor findings

Only two warnings remain: `get_building_enrichment_worker_evidence` and `touch_social_flow_meta_settings_updated_at` have mutable search paths. Their callers and exact signatures should be checked before pinning `search_path` in a separate migration.
