# Supabase Production Audit — 2026-09-12

This is a read-only audit of the production project `propai-lab`, performed
after the compute resize and the `parsed_output_unified` repair. No production
rows, policies, indexes, or settings were changed during this audit.

## Executive conclusion

The database is operational, but the production schema is not governed by one
reliable migration state. The most urgent risks are migration drift, a large
failed/dead-lettered processing backlog, semantic embedding jobs repeatedly
calling an unpaid provider, broad client-role table grants, and excessive
storage/index overhead on operational tables.

The recent timeout was a symptom of these conditions rather than one isolated
bad query.

## Evidence collected

- Production connectivity: `select 1` succeeded after the resize.
- 176 public tables and 15 public views are present.
- Live `supabase_migrations.schema_migrations` ends at
  `20260907193000_expand_commercial_office_facts`.
- The repository contains 26 later migrations, from `20260908120000` through
  `20260912150000`. Several were applied manually or are otherwise absent from
  the production migration ledger. This is the primary schema-governance fault.
- `parsed_output_unified` now exposes `normalized_message` and `listing_index`;
  the compatibility repair is verified.
- `idx_raw_messages_expiry_queue_created_at_id` exists with the intended
  partial predicate; `ANALYZE public.raw_messages` completed.
- One invalid index remains live: `idx_raw_messages_progress_covering`.

## Critical findings

### 1. Production migration drift — critical

The application/repository contract and the migration ledger are out of sync by
26 migrations. This explains how the application could request columns absent
from a production view and why dashboard SQL results differed from checked-in
migrations.

Required remedy:

1. Freeze ad-hoc production DDL.
2. Reconcile every post-`20260907193000` migration against live catalog state.
3. Mark only verified, already-applied changes as reconciled; do not blindly
   replay data-repair migrations.
4. Restore one authoritative deployment path for migrations, with a preflight
   check that blocks application deploys when required schema objects are absent.

### 2. Processing backlog and provider failure — critical

Live counts:

- `raw_messages`: 855,437 rows; 30,095 unprocessed group messages remain.
- `extraction_attempt_log`: 17,080 dead-lettered and 89,137 failed attempts;
  1,016 attempts still marked running.
- `semantic_embedding_jobs`: 24,315 failed jobs, of which 24,314 report HTTP
  402 from OpenRouter embeddings; 184 jobs are still running.
- The dominant historical extraction failure is 25,334 dedupe-claim HTTP 409s.

This is not a healthy queue. Failed embedding jobs are being retried or
reconsidered while the provider has no credit, and extraction telemetry has a
large population of stale/failed state.

Required remedy:

- Disable semantic enqueue/retry until a funded provider is configured and a
  bounded canary succeeds.
- Add explicit provider-billing failure classification with a long cooldown;
  HTTP 402 must not be treated as a transient worker failure.
- Reconcile or close stale `running` extraction attempts using bounded age
  rules, preserving audit history.
- Keep dead-lettered rows out of hot polling and provide an explicit replay
  command with a batch limit.
- Continue using conflict-safe dedupe claims; do not replay the old 409 storm.

### 3. Security grants are far too broad — high

All inspected tables have RLS enabled, and typed listing rows had zero missing
raw-message references and zero tenant mismatches. That is good.

However, `anon` and `authenticated` collectively hold 2,242 table-grant rows,
including direct privileges on sensitive tables such as `raw_messages`,
`whatsmeow_message_secrets`, `ai_chat_messages`, `ai_chat_sessions`,
`ai_usage_log`, `brokers`, `group_members`, and audit tables. RLS currently
blocks most client-role access because their policies are service-role-only,
but the grant surface violates least privilege and makes future policy mistakes
dangerous.

Required remedy:

- Revoke table DML/DDL privileges from `anon` and `authenticated` by default.
- Grant only `SELECT` on deliberately public projection views.
- Grant authenticated access only to the small set of tenant-scoped tables
  backed by reviewed membership policies.
- Keep raw WhatsApp evidence, secrets, audit logs, AI transcripts, and worker
  tables service-role-only.
- Add automated catalog tests that fail if a sensitive table is granted to a
  client role or if a public view exposes broker contact/raw evidence.

Do not solve this by changing the four public listing views to
`security_invoker` without first replacing their public access/RLS design; that
can silently empty the public site.

### 4. Storage and index shape is unhealthy — high

Largest live relations observed:

- `raw_messages`: 3.57 GiB total; 1.12 GiB indexes.
- `semantic_embeddings`: 1.83 GiB total; 1.02 GiB indexes despite zero live
  rows.
- `whatsapp_events`: 1.37 GiB total for 2,111 live rows.
- `whatsmeow_message_secrets`: 880 MiB total for 1,439 live rows.
- `group_members`: 254 MiB with 54,368 dead tuples.
- `extraction_attempt_log`: 217 MiB with 2,093 live rows.
- `whatsapp_webhook_outbox`: 216 MiB with zero live rows and 203 MiB indexes.

Several large tables showed no recorded `last_autoanalyze` in the audit view.
This can produce bad plans after queue/state changes. The large per-row sizes
also indicate retained payloads, TOAST-like operational data, or index/bloat
overhead that needs table-level inspection before deletion.

Required remedy:

- Inspect `pg_relation_size`, index usage, and retention ownership for the four
  oversized relations before any cleanup.
- Add retention/partitioning for append-only events, secrets, attempts, and
  webhook history where product requirements permit.
- Rebuild or drop only the invalid index after confirming no concurrent build
  is active; do not drop valid indexes based on size alone.
- Confirm autovacuum/analyze settings for `raw_messages`, `group_members`,
  `whatsapp_events`, and queue tables.
- Treat `semantic_embeddings` as a separate incident: zero rows plus 1.83 GiB
  means the vector storage lifecycle is not trustworthy.

### 5. Query performance remains structurally weak — high

`pg_stat_statements` shows:

- 2,569 building-alias lookups averaging 154 ms total 395.5 s.
- 18,630 building lookups averaging 18.3 ms total 341.2 s.
- 86 listing searches averaging 3.93 s.
- 56 listing searches averaging 2.68 s.
- 28 listing searches averaging 2.05 s.
- Workspace extraction progress RPC: 14 calls, 2.11 s average, 186,412
  shared blocks read and 9,539 written blocks cumulatively.
- Listing matching/search paths include wide `listings_unified_public` view
  reads and repeated multi-column text predicates.

Required remedy:

- Replace full/wide public view reads with purpose-specific narrow projections.
- Make search filters tenant/market/transaction-first and use keyset
  pagination.
- Keep trigram indexes only where substring search is required; otherwise use
  normalized exact-search columns.
- Replace repeated full-history progress aggregation with a bounded summary
  table or short-lived cache.
- Capture `EXPLAIN (ANALYZE, BUFFERS)` for the three worst listing queries before
  adding more indexes.

## What is currently healthy

- RLS is enabled on all inspected public tables; no tenant-bearing table was
  found with RLS disabled.
- Typed listing tables had zero orphaned raw-message references and zero tenant
  mismatches in the integrity probe.
- Worker heartbeats for extraction, semantic embedding, matching, enrichment,
  and tenant-boundary repair were current at audit time.
- The repaired view and expiry queue index are present in production.

## Recommended execution order

1. Freeze migration drift and produce a verified live-vs-repo schema ledger.
2. Stop semantic embedding retries until billing/provider configuration is fixed.
3. Reduce client-role grants and add security catalog tests.
4. Quarantine stale extraction attempts and dead-letter retry storms.
5. Inspect/retire oversized event, secret, vector, and outbox storage using an
   approved retention policy.
6. Tune the progress RPC and listing search from real execution plans.
7. Re-enable workers gradually with queue depth, timeout, and error-rate SLOs.

## Audit limitations

This audit was read-only. It did not run `EXPLAIN ANALYZE` on production queries,
delete/archive data, revoke grants, rebuild indexes, or validate an end-to-end
anonymous/authenticated request using a real user JWT. Those are follow-up
remediation tasks, not assumptions hidden in this report.
