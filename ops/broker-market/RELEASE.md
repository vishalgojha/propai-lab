# Shared property search: staged release candidate, NOT deployed

## Scope and order

Approval to implement is not production approval. Do not apply this plan before the final release impact is approved. Keep broad private capture, DM processing, retention and deletion work outside this release.

1. Review and ship the narrow auth request-local read dedup / UI in-flight gate as a prerequisite. No cross-request cache, pool or worker-count change. Verify actual authenticated phones/groups controls with the production app. Local tests do not prove the production latency hypothesis. Stop feature rollout if owner controls remain unusable.
2. Keep `BROKER_PROPERTY_CROSS_SEARCH_ENABLED=false` on API and MCP. Prepare the same explicit `BROKER_MARKET_SIGNING_SECRET` on both services using protected configuration, without printing or placing its value in artifacts. Do not rely on fallback service-key names. Keep this value stable through code rollback so signed references are not invalidated unintentionally.
3. Take the read-only database preflight below immediately before migration. Apply only the small transactional policy and grant migrations. They retain 2-second lock and 10-second statement limits. A lock timeout means stop, not raise the timeout blindly or kill sessions.
4. Build raw-message indexes one at a time with the separate `indexes.concurrent.sql` in autocommit mode, NEVER inside the migration transaction or a migration runner that wraps the file. Each build has 2-second lock / 15-minute statement limits. A timeout can leave an invalid index. Inspect it; do not blindly drop it or assume IF NOT EXISTS proves usable equivalence.
5. Confirm both indexes are ready and valid, exact expressions/predicates match, and inspect EXPLAIN on representative building-only and locality-only searches and source rechecks. Rehearse cleanup/retry locally first. Avoid EXPLAIN ANALYZE on production before approving its load.
6. Deploy API and MCP with feature off, then UI. Verify legacy public/own raw toolset and existing pairing paths stay unchanged. Enable API and MCP together only after the explicit paired configuration and all gates pass. The UI's separate source confirmation and MCP reader switch must remain unchecked by default. No historical tick migration and no new consent on behalf of an owner.
7. Verify production owner consent, post-consent captured property search, contact masking/explicit option interest, source untick/reselection denial and MCP grant/revoke using an owner-approved test source and account. Do not publish a real source merely to smoke-test. Without such authority, keep feature off and report the unverified production path.

## Read-only preflight

- Inspect `pg_index` validity/readiness and `pg_get_indexdef` for raw_messages. Reuse only a genuinely equivalent valid existing index, otherwise reconcile names before building. No unconditional DROP.
- Check pg_stat_activity, lock waits, long transactions and pg_stat_progress_create_index. Do not start another concurrent build on the same table.
- Verify managed-database storage headroom in the database provider dashboard, not host `df`. Budget for two new indexes, concurrent build workspace and ongoing writes. Provider database free space is currently UNVERIFIED and is an execution gate.
- Check provider connection/CPU/I/O headroom and current replication health. Current process counts are not proof of spare I/O.
- Confirm rollback images/commits and protected paired config are available before changing services.

Read-only observation on 2026-11-19 about 14:46 IST at https://coolify.propai.live/terminal: raw_messages heap 315 MB, total 959 MB; no matching FTS/event expression indexes returned; 1 active, 12 idle, 7 background/unspecified sessions; zero transactions older than 60 seconds. Host root disk had 89 GB available, but the database is remote, so that does NOT establish database storage headroom. All these checks expire and must be repeated before execution.

## Rollback and abort

- First disable the shared feature on API and MCP. Stop tests and ensure in-flight tool calls fail closed on their fresh grant/source checks. Keep captured raw history and all source/grant audit rows; never delete raw messages, consent or user history as rollback.
- Revert UI/API/MCP images to the recorded approved versions if required. Auth correction can remain only as its separately approved patch, otherwise revert it independently. No ingestor deployment is part of this shared release.
- Leave additive policy tables/functions and valid indexes in place initially. Old code does not use them. Do not run a destructive schema rollback while newer processes can still reference it.
- If a concurrent build fails, keep feature off, inspect the exact index name/definition/validity and active build. Only an explicitly reviewed cleanup may DROP INDEX CONCURRENTLY for the failed new index, outside any transaction, followed by a reviewed retry. Never terminate arbitrary database sessions.
- Stop for lock/build timeout, rising connection errors, API auth regression, missing paired secret, invalid indexes, grant/source isolation failure, unintended contact disclosure or unusable owner controls. Report observed impact and evidence before retrying.

## Evidence boundary

Real local PostgreSQL plus actual HTTP handlers and actual existing MCP factory/SDK client cover grants, policy search/get, source untick and masking. The Supabase transport is replaced with a parameterized SQL adapter for these tests. Auth provider, production PostgREST transport and deployed UI session are not thereby proven. The SQL fixture is minimal, not a full production schema snapshot.

Literal property criteria may miss relevant properties. Combining-mark Indic names are rejected consistently by the current Python and TypeScript validators; do not advertise unrestricted Hindi-name support. No raw-source extraction/model/embedding call is introduced. This release makes no blanket claim that existing private-account processing is disabled.
