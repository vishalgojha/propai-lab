# Phase 6 — Data Quality and Worker Health Triage

Date: 2026-09-01

## Fresh production measurements

- Typed rows across the eight listing/requirement tables: **70,529**.
- Typed rows whose `raw_message_id` does not resolve: **8,838**.
  - Residential sale requirements: **3,645**
  - Residential rent requirements: **2,533**
  - Commercial sale requirements: **1,230**
  - Commercial rent requirements: **1,430**
- Null `raw_message_id` values: **0**.
- Duplicate `(tenant_id, raw_message_id)` groups: **3,897**, containing
  **11,746 rows**. This is **471 groups above** the previous comparison value
  of 3,426.
- `needs_review = true`: **58,031**.
- `duplicate_status = 'flagged'`: **55,060**.

Queue state:

- Extraction reprocessing: **37,610 queued**, **25 running**, **2,202
  failed**, **11,156 no_source**, **4,885 still_unresolved**, **16 fixed**.
- Extraction attempts: **786 running**, **67,238 failed**, **12,912
  dead_lettered**, **64,307 succeeded**, **8,976 skipped**.
- Tenant-boundary review: **7,952 pending**, **230 repaired**.
- Building enrichment: **46,698 completed**, **23,223 failed**.

Worker heartbeats were present for all four expected workers. The oldest
fresh heartbeat was the extraction worker at approximately 14 minutes old at
query time; the other three were under three minutes old.

## Action taken

No data mutation was performed. The missing raw-message references point to
historical requirement rows whose IDs are no longer present in
`raw_messages`; there is no deterministic source to remap them to. Automatic
repair would fabricate evidence or attach a requirement to the wrong message.

The duplicate-key count also requires row-level deduplication rules before any
delete or merge operation. It was not changed.

## Next remediation requirements

1. Decide the approved handling for historical requirements with missing raw
   evidence (quarantine, archive, or source-recovery import).
2. Drain/retry queues only after failure reasons and idempotency are reviewed.
3. Define a broker-identity matching rule before changing broker rows.

## Coolify redeployment

No Coolify redeploy required. This phase was production measurement and safe
triage only.
