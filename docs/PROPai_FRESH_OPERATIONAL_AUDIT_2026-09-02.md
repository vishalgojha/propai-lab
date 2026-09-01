# PropAI fresh operational audit — 2026-09-02

Status: read-only audit. No production rows, migrations, deployments, or source files were changed for this audit.

This is an independent “good cop / bad cop” review. The good-cop pass checked which paths have positive production evidence. The bad-cop pass challenged every claim of health against source wiring, live queues, worker heartbeats, and UI state. One bad-cop agent timed out; its checklist was completed manually against the repository and live Supabase evidence.

Live database snapshot used for this report: 2026-09-01 22:34 UTC (2026-09-02 04:04 IST), unless a finding states otherwise.

## Executive decision

The ingestion → extraction → storage chain is alive. PropAI is not broadly “broken”. However, the following paths must not be treated as complete merely because code, a dashboard, or a Coolify resource exists:

1. Matching / Auto Matched
2. Historical extraction reprocessing
3. Extraction boundary repair
4. Building enrichment completion
5. Requirement source-evidence preservation
6. Production health monitoring

The operating rule for the next audit is simple: a subsystem is green only when its code, database queue, production consumer, recent heartbeat, row progress, and UI status all agree.

## Priority queue

### P0 — establish truthful production operation

#### P0.1 Verify or repair the matcher service

Evidence:

- `requirement_matches` contains `0` rows in the checked snapshot.
- `matching/worker.py` and the compose command exist.
- The live matcher logs did not show the expected `[match-worker] started` signature; they showed an API/Uvicorn-style startup instead.

Impact: Auto Matched can appear available while producing no matches.

Next action:

1. Confirm the live Coolify resource command and deployed commit.
2. Capture matcher heartbeat and one successful match-run log.
3. Create one safe requirement/listing test pair in a controlled tenant and verify save → claim → score → `requirement_matches` → UI.
4. Do not call the feature operational until that path is observed end-to-end.

#### P0.2 Restore a measurable reprocessing path

Current queue:

| Status | Rows |
| --- | ---: |
| queued | 36,688 |
| running | 27 |
| fixed | 16 |
| still_unresolved | 5,270 |
| no_source | 11,692 |
| failed | 2,202 |

Impact: historical extraction is technically running but not clearing the backlog at a meaningful success rate. Repeated `asset_type` failures also risk wasting paid LLM calls and leaving malformed records unresolved.

Next action:

1. Measure queue deltas over a 30-minute window, not just worker heartbeat.
2. Group failures by error code and source/provider.
3. Fix the `asset_type` validation/repair contract and reprocess a bounded sample.
4. Add success-rate, oldest-queued-age, and terminal-reason metrics to the worker health surface.

### P1 — unblock usable, source-grounded inventory

#### P1.1 Deploy and prove extraction boundary repair

Evidence:

- `extraction_repair_worker.py` exists and `deploy/coolify/docker-compose.yml` defines `extraction-repair-worker`.
- The live heartbeat query returned no current repair-worker heartbeat.
- `extraction_repair_jobs`: `280 completed`, `708 queued`.
- Queued jobs had a latest update of Aug 29 in the checked snapshot.

Important correction: this is not a missing-code problem. The repair consumer exists in the repository. It is a production wiring/consumption problem until a live heartbeat and a job transition are observed.

UI risk: the repair screen maps `completed` to “Repaired” even when a job may have zero child slices. “Completed with no split” must not be presented as “repaired into listings”.

Next action: verify the Coolify resource, start command, heartbeat, and one queued → running → completed/no-split transition. Then split the UI states into `repaired`, `no split needed`, `failed`, and `stale`.

#### P1.2 Reduce the review quarantine without weakening safety

Good-cop evidence confirms the safety boundary is active. Bad-cop evidence shows the business result is severe:

- Listings: `51,076`
- Listings marked `needs_review`: `51,021`
- Recently usable/non-review listings: approximately `56`

Impact: roughly 99.9% of listing rows are quarantined. This protects against bad public data, but it leaves the buyer-facing inventory nearly empty.

Next action: classify review flags by reason, identify systemic false-positive rules, and define an evidence-backed auto-clear policy. Never clear review flags solely to improve counters.

#### P1.3 Repair requirement evidence coverage

`8,838` requirement rows reference a `raw_message_id` that does not currently resolve to a raw message. Equivalent listing source checks were clean in the same audit.

Impact: the source-evidence guarantee is asymmetric: listings are traceable, but a large historical requirement population is not.

Next action: classify deleted/migrated/orphaned causes, preserve the requirement row, and either restore the source link or explicitly quarantine the row. Do not fabricate replacement source evidence.

#### P1.4 Audit building-enrichment failures

Live queue counts reported by the independent audit:

- Completed: `46,764`
- Failed: `23,240`

The building-enrichment worker heartbeat was current, but the failed population’s retry and resolution behavior was not proven.

Next action: report failures by reason, age, retry count, and building; verify that retryable failures move back to queued and terminal failures are explained in the UI.

### P2 — remove false confidence and performance drift

#### P2.1 Make health monitoring operationally meaningful

Current heartbeat evidence showed current rows for:

- `extraction-worker`
- `extraction-reprocessing-worker`
- `building-enrichment-worker`
- `semantic-embedding-worker`

No current heartbeat was returned for matcher, extraction repair, tenant-boundary repair, or normal enrichment. Absence of a current heartbeat is not proof of a dead service, but it is proof that the monitoring surface cannot certify those services.

Next action: every worker must publish service name, runtime version, heartbeat time, last successful work time, queue age, last error, and rows processed in the last interval. Coolify “running” alone is insufficient.

#### P2.2 Fix semantic backfill maintenance

The semantic worker is storing vectors, but backfill/enqueue paths have produced Supabase statement-timeout errors. A live worker does not prove that maintenance queues are healthy.

Next action: inspect the timed-out query plan, bound backfill batches, add the required index/RPC path, and alert on stale `running` embedding jobs.

#### P2.3 Review database advisor findings

The independent pass found remaining advisor warnings including an unindexed foreign key, per-row `auth.*` policy evaluation, multiple permissive policies, fixed Auth connection allocation, `pg_net` placement, and unused indexes.

Next action: separate actionable latency/I/O findings from informational warnings; measure before removing indexes or changing RLS. Record each decision and its observed query impact.

## Good-cop findings: controls that are working

- WhatsApp ingestion and webhook delivery are live.
- The extraction worker is processing and storing rows.
- Exact author/content repost claims are atomically tenant-scoped.
- Raw WhatsApp evidence is retained.
- Listing rows currently have intact raw-message source links.
- Semantic search is separate from structured inventory creation.
- Public inventory excludes review-held/stale rows.
- Tenant IDs are populated on the checked listing/requirement read models.
- Private CRM inventory remains separate from public market inventory.

These controls reduce the risk of fabricated or cross-tenant public inventory. They do not close the backlog and completeness findings above.

## What “done” means for the next session

Do not mark a priority complete from a code diff or a green container alone. Attach all of the following to the task:

- deployed Coolify resource and commit
- current worker heartbeat
- before/after queue counts
- one representative successful row transition
- relevant error-rate change
- UI state matching the underlying row state
- tenant/source-evidence verification where applicable

## Source map

- `matching/worker.py`
- `extraction_repair_worker.py`
- `extraction_reprocessing_worker.py`
- `semantic_embedding_worker.py`
- `deploy/coolify/docker-compose.yml`
- `WIRING_AUDIT.md`
- `docs/DATA_QUALITY.md`
- `architecture.md` (known landmines and verification contract)
