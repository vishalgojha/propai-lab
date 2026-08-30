# RLS Migration Maintenance Plan

Status: prepared; not scheduled and not executed.

This plan covers the reviewed service-role-only RLS policy batch for 39
internal tables. It does not cover tenant-scoped or public/reference tables.

## Traffic assessment

The query used `raw_messages.created_at`, converted to `Asia/Kolkata`, over
the most recent 30 calendar days available at the time of review. There were
453,398 messages, but only 15 calendar days contained messages. Therefore the
first estimate of 69–71 messages/hour was diluted by inactive days and was not
a safe representation of normal traffic.

The table below excludes zero-message days and shows the distribution on days
where ingestion was active. Values are messages in that IST clock-hour per
day.

| IST hour | Active days | Minimum | Median | Mean | Maximum |
|---:|---:|---:|---:|---:|---:|
| 00 | 14 | 31 | 858 | 919 | 2,815 |
| 01 | 13 | 17 | 442 | 725 | 1,949 |
| 02 | 14 | 1 | 100 | 368 | 1,617 |
| 03 | 14 | 1 | 73 | 148 | 929 |
| 04 | 14 | 4 | 56 | 152 | 487 |
| 05 | 14 | 12 | 268 | 464 | 2,680 |
| 06 | 14 | 38 | 318 | 628 | 2,671 |
| 07 | 14 | 204 | 517 | 791 | 2,772 |
| 08 | 14 | 47 | 573 | 944 | 2,689 |
| 09 | 14 | 30 | 1,495 | 1,520 | 2,388 |
| 10 | 14 | 222 | 2,347 | 2,146 | 3,180 |
| 11 | 14 | 2,028 | 2,833 | 3,200 | 5,172 |
| 12 | 14 | 1,641 | 3,064 | 3,550 | 8,370 |
| 13 | 14 | 1,398 | 2,390 | 2,731 | 5,962 |
| 14 | 14 | 502 | 1,912 | 2,002 | 3,995 |
| 15 | 14 | 346 | 1,680 | 1,975 | 3,985 |
| 16 | 14 | 447 | 1,564 | 1,751 | 4,380 |
| 17 | 14 | 309 | 1,451 | 1,736 | 4,056 |
| 18 | 14 | 166 | 1,408 | 1,654 | 4,405 |
| 19 | 14 | 90 | 1,110 | 1,199 | 3,026 |
| 20 | 14 | 175 | 1,155 | 1,072 | 2,035 |
| 21 | 14 | 74 | 570 | 861 | 1,970 |
| 22 | 14 | 86 | 570 | 855 | 2,089 |
| 23 | 14 | 62 | 1,203 | 1,049 | 2,860 |

The trough is 03:00–05:00 IST, but it is not quiet. A maintenance pause is
required rather than relying on a naturally idle period.

## Why the pause must include the ingestor

The WhatsMeow ingestor writes directly to the `whatsmeow_*` tables. A prior
attempt to create the policies timed out while waiting on
`public.whatsmeow_device`; live activity showed multiple PostgreSQL sessions
idle in transaction while writing `whatsmeow_message_secrets`.

Stopping only extraction workers is insufficient. The pause must first stop
the WhatsMeow ingestor gracefully, then stop extraction/reprocessing workers
so all policy-targeted tables can drain.

## Proposed runbook

1. Announce a short ingestion maintenance pause and record the start time.
2. Gracefully stop the Coolify `ingestor` service. Do not kill PostgreSQL
   sessions manually.
3. Stop `extraction-worker` and `extraction-reprocessing-worker`. Stop other
   writers to the target tables if their heartbeats or activity show writes.
4. Poll `pg_stat_activity`/lock state until no WhatsMeow or extraction writer
   is active or idle in transaction.
5. Capture pre-change counts for raw-message queue state, dead letters,
   worker heartbeats, and the admin smoke-query set.
6. Apply the 39-table deny policy migration in one transaction. The policies
   deny `anon` and `authenticated` with `USING (false)` and `WITH CHECK
   (false)`; `service_role` remains able to operate because it bypasses RLS.
7. Verify the policy count and names, then run service-role smoke queries for
   raw ingestion, extraction queue state, worker health, and admin dashboard
   data.
8. Restart the ingestor, then extraction/reprocessing workers.
9. Verify new raw rows, message identity continuity, queue movement, worker
   heartbeats, and absence of new ingestion errors.
10. Record the pause interval, counts, logs, and any recovery discrepancy.

Expected elapsed time after writers drain is a few seconds for the DDL, with
an operational maintenance budget of 2–5 minutes for stop, verification, and
restart. The earlier 30-second failure was lock wait, not demonstrated DDL
work duration.

## Loss-verification gap

There is no independent WhatsApp Business API delivery ledger in this
architecture that can be queried as a definitive message-by-message source of
truth. WhatsMeow receives protocol events and persists local evidence; it does
not provide a vendor delivery report that can prove every event during a
paused interval was later recovered.

The post-resume checks can prove local continuity, but cannot prove absence of
messages that never reached the local session:

- compare WhatsMeow reconnect/history-sync logs and event timestamps with the
  pause interval;
- compare message identity continuity (`message_uid`, source, sender/JID,
  timestamp) before and after the pause;
- compare expected history-sync/replay counts reported by the ingestor with
  inserted `raw_messages` counts;
- inspect duplicate/repeat markers and extraction queue movement;
- verify no database insert errors or reconnect failures occurred.

If history sync reports incomplete recovery, or the session is rate-limited or
fails to reconnect, the operation must be marked recovery-uncertain. The
missing-message risk is real: a hot listing or requirement posted during the
pause could be absent from PropAI, and the database cannot identify an event
that never arrived. That is not an acceptable “note and move on” outcome for
source-grounded inventory.

## Risk mitigation decision

The pause should be run only during a deliberately selected window on a day
whose recent traffic is confirmed typical, with an operator watching the
ingestor logs and database counts. If a zero-loss requirement is strict, the
safer prerequisite is an explicit durable ingress buffer or a provider-side
delivery/replay ledger; quiet hours alone cannot provide that guarantee.

No pause, worker stop, policy migration, or data change has been performed as
part of this document.
