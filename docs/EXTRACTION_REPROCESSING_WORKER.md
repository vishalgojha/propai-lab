# Extraction reprocessing worker

## Purpose

`extraction_reprocessing_worker.py` is a standing, source-gated queue consumer
for all eight typed extraction tables. It is separate from the live
`extraction_worker.py` and from `extraction_repair_worker.py`, which handles
split-parent repairs.

The migration `20260830113000_generic_extraction_reprocessing_queue.sql`:

- creates one idempotent job per `(source_table, source_row_id)` for existing
  `needs_review=true` rows;
- adds `locality_unresolved` only when locality fields are empty and an exact
  canonical locality/alias is present in recoverable source text;
- leaves the locality unassigned for the worker's normal source-grounded
  extraction to decide; and
- records terminal `fixed`, `still_unresolved`, `no_source`, and `failed`
  outcomes so terminal rows are not retried forever.

## Runtime design

Defaults are intentionally conservative:

| Setting | Default | Meaning |
| --- | ---: | --- |
| `EXTRACTION_REPROCESSING_POLL_SECONDS` | `30` | Delay between queue polls |
| `EXTRACTION_REPROCESSING_BATCH_SIZE` | `10` | Maximum claimed jobs per cycle |
| `EXTRACTION_REPROCESSING_CONCURRENCY` | `2` | Concurrent normal extraction calls |
| `EXTRACTION_REPROCESSING_RATE_PER_MINUTE` | `6` | Process-wide call rate; `0` disables the limiter |
| `EXTRACTION_REPROCESSING_DRY_RUN` | `false` | Claim/log without changing typed facts |

The rate limiter is shared by all worker threads. Setting concurrency to `1`
and rate to `1` is a safe incident mode; setting rate to `0` removes only the
worker-side limiter and should not be used while provider spend is uncertain.

Each run writes `extraction_reprocessing_runs` and logs `attempted`, `fixed`,
`still_unresolved`, `no_source_available`, and `failed`. Each job is claimed by
`FOR UPDATE SKIP LOCKED`, increments its attempt count, and is terminal after
one result. An operator can explicitly requeue a failed or still-unresolved
job after changing the evidence or extraction policy; the worker never loops
on those states automatically.

Source recovery accepts `raw_messages.message`, then retained payload text. It
rejects empty text and media-only markers. Recoverable rows are sent through
`process_raw_message()`, which uses the existing source-scoped extraction,
broker grounding, persistence write-gate, and source-fingerprint upsert. A
clean result clears only this worker's quarantine flags and releases the row
from review; unrelated validation flags are preserved.

## Deployment and health integration

Build from `Dockerfile.reprocessing-worker` as a separate Coolify process using
the same Supabase and provider secrets as the existing extraction worker. Do
not replace or scale down the live extraction worker. Deploy the database
migration first, then start one reprocessing process with the defaults and
observe `worker_heartbeats` and `extraction_reprocessing_runs` before increasing
capacity.

This worker does not depend on the existing repair-worker RPCs. That is
intentional because the extraction-worker infrastructure has previously shown
503/502 RPC health-visibility gaps. The worker reports a DB heartbeat, but the
deployment is not considered healthy until the underlying RPC/API health checks
are independently verified. A missing heartbeat, stale `updated_at`, provider
error, or growing `failed` count must pause the queue rather than trigger an
unbounded retry.

No deployment is performed by this change.
