"""Standalone extraction worker — polls for unprocessed raw messages.

Usage:
    python3 extraction_worker.py [--poll N]

Alternate to the per-webhook background thread; useful for production
deployments where the API server is scaled horizontally and a single
dedicated worker should own all extraction.
"""

import argparse
import json
import os
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from threading import Lock

from extraction import get_storage, process_raw_message

POLL_INTERVAL = int(os.getenv("EXTRACTION_WORKER_POLL_SECONDS", "5"))
BATCH_SIZE = int(os.getenv("EXTRACTION_WORKER_BATCH_SIZE", "50"))
MAX_RETRIES = int(os.getenv("EXTRACTION_WORKER_MAX_RETRIES", "5"))

# Provider-side concurrency ceiling. Keep the deployment default high enough
# to drain the historical queue, but cap accidental configuration at 100.
# The provider client applies Retry-After cooldowns when the account limit is
# lower than this ceiling.
_configured_concurrency = int(os.getenv("EXTRACTION_WORKER_CONCURRENCY", "50"))
CONCURRENCY = max(1, min(100, _configured_concurrency))

# Keep fresh WhatsApp messages moving while the historical queue drains. The
# total remains CONCURRENCY; these knobs only divide the existing pool.
RECENT_WINDOW_HOURS = float(os.getenv("EXTRACTION_WORKER_RECENT_WINDOW_HOURS", "24"))
_default_fast_slots = max(1, min(3, CONCURRENCY - 1)) if CONCURRENCY > 1 else 1
_requested_fast_slots = int(os.getenv("EXTRACTION_WORKER_FAST_LANE_SLOTS", str(_default_fast_slots)))
_requested_backlog_raw = os.getenv("EXTRACTION_WORKER_BACKLOG_LANE_SLOTS", "").strip()
if _requested_backlog_raw:
    # If both lane knobs are supplied, keep their sum within the existing
    # provider ceiling; backlog's explicit reservation wins the conflict.
    BACKLOG_LANE_SLOTS = max(0, min(CONCURRENCY, int(_requested_backlog_raw)))
    FAST_LANE_SLOTS = max(0, min(CONCURRENCY - BACKLOG_LANE_SLOTS, _requested_fast_slots))
else:
    if CONCURRENCY > 1:
        # Keep at least one slot available for backlog unless the deployment
        # has only one total provider slot, where a split is impossible.
        FAST_LANE_SLOTS = max(0, min(CONCURRENCY - 1, _requested_fast_slots))
    else:
        FAST_LANE_SLOTS = max(0, min(CONCURRENCY, _requested_fast_slots))
    BACKLOG_LANE_SLOTS = max(0, CONCURRENCY - FAST_LANE_SLOTS)

# Optional hard ceiling on cumulative extraction spend (USD), read from
# ai_usage_log.agent = 'extraction'.  When the budget is exhausted the
# worker stops pulling from the queue, so a one-time campaign (or a
# misbehaving provider) can never silently bill past a fixed amount.
# Unset/empty = unlimited.
_budget_raw = os.getenv("EXTRACTION_BUDGET_USD", "").strip()
EXTRACTION_BUDGET_USD = float(_budget_raw) if _budget_raw else None


def _cumulative_extraction_spend(storage) -> float:
    """Sum of logged extraction cost from ai_usage_log (never raises)."""
    try:
        resp = storage.client.table("ai_usage_log").select("cost_usd").eq("agent", "extraction").execute()
        total = 0.0
        for row in (resp.data or []):
            try:
                total += float(row.get("cost_usd") or 0)
            except (TypeError, ValueError):
                continue
        return round(total, 6)
    except Exception:
        return 0.0


def remaining_budget(storage, budget: float | None) -> float | None:
    """None when unlimited, else budget minus cumulative spend (floor 0)."""
    if budget is None:
        return None
    return max(0.0, budget - _cumulative_extraction_spend(storage))


def row_value(row, key: str, default=None):
    if isinstance(row, dict):
        return row.get(key, default)
    return getattr(row, key, default)


def parse_json(value, default):
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str) and value.strip():
        try:
            return json.loads(value)
        except (json.JSONDecodeError, TypeError):
            return default
    return default


def context_from_raw(row) -> dict:
    raw_payload = parse_json(row_value(row, "raw_payload"), {})
    data = raw_payload.get("data", raw_payload) if isinstance(raw_payload, dict) else {}
    key = data.get("key", {}) if isinstance(data, dict) else {}
    sender_data = data.get("sender", {}) if isinstance(data, dict) else {}
    msg = data.get("message", {}) if isinstance(data, dict) else {}

    group = (
        key.get("remoteJid")
        or data.get("from")
        or row_value(row, "group_name")
        or ""
    )
    sender_jid = key.get("participant") or sender_data.get("id") or row_value(row, "sender_jid") or ""
    sender_name = sender_data.get("name") or data.get("pushName") or row_value(row, "sender") or ""
    sender_phone = row_value(row, "sender_phone") or ""
    message_uid = row_value(row, "message_uid") or f"{group}:{key.get('id') or row_value(row, 'id')}"

    return {
        "sender_name": sender_name,
        "push_name": data.get("pushName") or sender_name,
        "sender_jid": sender_jid,
        "sender_phone": sender_phone,
        "message_hash": row_value(row, "message_hash") or "",
        "group": group,
        "group_name": row_value(row, "group_name") or "",
        "instance": data.get("instance") or raw_payload.get("instance") or "",
        "is_dm": str(group).endswith("@s.whatsapp.net") or str(group).endswith("@lid"),
        "message_uid": message_uid,
        "message_id": key.get("id") or "",
        "msg_text": row_value(row, "message") or "",
        "msg": msg,
        "attachments": parse_json(row_value(row, "attachments"), []),
        "reply_context": parse_json(row_value(row, "reply_context"), {}),
        "tenant_id": row_value(row, "tenant_id") or "",
        "parent_message_id": row_value(row, "parent_message_id"),
        "split_index": row_value(row, "split_index"),
        "raw_payload": raw_payload,
        "timestamp": row_value(row, "timestamp") or "",
        "synced_at": row_value(row, "synced_at") or "",
        "event_id": row_value(row, "event_id") or "",
        "source": row_value(row, "source") or "WHATSAPP",
        "is_group": bool(row_value(row, "is_group", False)),
        "pipeline_version": row_value(row, "pipeline_version") or "",
    }


def recent_cutoff(now=None) -> str:
    """Return the UTC cutoff shared by both mutually-exclusive lane queries."""
    current = now or datetime.now(timezone.utc)
    return (current - timedelta(hours=RECENT_WINDOW_HOURS)).isoformat()


def next_fast_batch(storage, cutoff: str, limit: int = BATCH_SIZE, tenant_ids=None):
    """Fetch one FIFO batch from the recent lane."""
    try:
        return storage.get_unprocessed_raw_messages_since(cutoff, limit=limit, tenant_ids=tenant_ids)
    except TypeError:
        return storage.get_unprocessed_raw_messages_since(cutoff, limit=limit)


def next_backlog_batch(storage, cutoff: str, limit: int = BATCH_SIZE, tenant_ids=None):
    """Fetch one FIFO batch from the historical lane."""
    try:
        return storage.get_unprocessed_raw_messages_before(cutoff, limit=limit, tenant_ids=tenant_ids)
    except TypeError:
        return storage.get_unprocessed_raw_messages_before(cutoff, limit=limit)


def _legacy_lane_batch(storage, cutoff: str, lane: str, limit: int):
    """Compatibility fallback for older test/dry-run storage doubles.

    Production SupabaseStorage implements the two indexed queries above. This
    fallback keeps local tooling that only implements the original storage
    method usable while filtering conservatively in memory.
    """
    rows = storage.get_unprocessed_raw_messages(limit=limit)
    cutoff_dt = datetime.fromisoformat(cutoff)
    selected = []
    for row in rows:
        # The background market extractor only consumes WhatsApp group posts.
        # Direct/self-chat messages are handled by their explicit intake path;
        # allowing them here causes the agent's conversational replies to be
        # reinterpreted as property requirements.
        if row_value(row, "is_group", False) is not True:
            continue
        value = row_value(row, "timestamp", "")
        if not value:
            is_recent = False
        else:
            try:
                is_recent = datetime.fromisoformat(str(value).replace("Z", "+00:00")) >= cutoff_dt
            except ValueError:
                is_recent = False
        if is_recent == (lane == "fast"):
            selected.append(row)
    return selected


def _fetch_lane(storage, lane: str, cutoff: str, limit: int, tenant_ids=None):
    if lane == "fast" and hasattr(storage, "get_unprocessed_raw_messages_since"):
        return next_fast_batch(storage, cutoff, limit, tenant_ids)
    if lane == "backlog" and hasattr(storage, "get_unprocessed_raw_messages_before"):
        return next_backlog_batch(storage, cutoff, limit, tenant_ids)
    return _legacy_lane_batch(storage, cutoff, lane, limit)


def _remove_opted_out_rows(storage, lane_rows):
    """Keep opted-out group messages queued without sending them to extraction."""
    getter = getattr(storage, "get_opted_out_extraction_groups", None)
    setter = getattr(storage, "set_raw_message_extraction_suppressed", None)
    if not getter or not setter:
        return lane_rows, 0
    opted_out = getter()
    if opted_out is None:
        print("[worker] group opt-out lookup unavailable; failing open", flush=True)
        return lane_rows, 0
    filtered = []
    suppressed = 0
    for lane, slots, rows in lane_rows:
        eligible = []
        for row in rows:
            tenant_id = str(row_value(row, "tenant_id") or "")
            group_jid = str(row_value(row, "group_name") or "")
            if tenant_id and group_jid and (tenant_id, group_jid) in opted_out:
                try:
                    setter(int(row_value(row, "id") or 0), True)
                except Exception:
                    print(f"[worker] could not suppress opted-out raw row id={row_value(row, 'id')}", flush=True)
                    traceback.print_exc()
                suppressed += 1
            else:
                eligible.append(row)
        filtered.append((lane, slots, eligible))
    return filtered, suppressed


def _process_lane(storage, rows, lane: str, slots: int, retry_counts: dict):
    """Run the existing per-message pipeline for one reserved lane."""
    stats = {
        "lane": lane,
        "fetched": len(rows),
        "attempted": 0,
        "processed": 0,
        "failed": 0,
        "dead_lettered": 0,
        "skipped": 0,
        "skip_reasons": {},
        "latency_seconds": 0.0,
        "max_latency_seconds": 0.0,
    }
    extractable = []

    for row in rows:
        raw_id = row_value(row, "id")
        attempts = retry_counts.get(raw_id, 0)

        if attempts >= MAX_RETRIES:
            try:
                storage.mark_raw_processed(raw_id)
                stats["dead_lettered"] += 1
            except Exception:
                pass
            continue

        extractable.append(row)

    if extractable and slots > 0:
        lock = Lock()

        def _handle(row):
            raw_id = row_value(row, "id")
            attempts = retry_counts.get(raw_id, 0)
            started = time.perf_counter()
            try:
                with lock:
                    stats["attempted"] += 1
                ctx = context_from_raw(row)
                result = process_raw_message(raw_id, ctx, storage=storage)
                if isinstance(result, dict) and result.get("storage_status") == "failed":
                    raise RuntimeError("extraction completed without a successful parsed-row write")
                elapsed = time.perf_counter() - started
                with lock:
                    stats["processed"] += 1
                    stats["latency_seconds"] += elapsed
                    stats["max_latency_seconds"] = max(stats["max_latency_seconds"], elapsed)
                    retry_counts.pop(raw_id, None)
            except Exception:
                elapsed = time.perf_counter() - started
                with lock:
                    retry_counts[raw_id] = attempts + 1
                    stats["failed"] += 1
                    stats["latency_seconds"] += elapsed
                    stats["max_latency_seconds"] = max(stats["max_latency_seconds"], elapsed)
                print(
                    f"[worker] lane={lane} raw_id={raw_id} failed "
                    f"(attempt {attempts + 1}/{MAX_RETRIES}):",
                    flush=True,
                )
                traceback.print_exc()

        # Reply corrections are group-local state. Process each group's rows
        # FIFO, while allowing different groups to run concurrently.
        grouped: dict[str, list] = {}
        for row in extractable:
            group_key = str(row_value(row, "group_name") or "")
            grouped.setdefault(group_key, []).append(row)
        for group_rows in grouped.values():
            group_rows.sort(key=lambda row: (
                str(row_value(row, "timestamp") or ""),
                int(row_value(row, "id") or 0),
            ))

        workers = max(1, min(slots, len(grouped)))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(lambda batch=batch: [_handle(row) for row in batch], batch)
                       for batch in grouped.values()]
            for future in as_completed(futures):
                future.result()

    completed = stats["attempted"]
    avg_ms = (stats["latency_seconds"] / completed * 1000) if completed else 0.0
    print(
        f"[worker] lane={lane} fetched={stats['fetched']} "
        f"attempted={stats['attempted']} stored={stats['processed']} failed={stats['failed']} "
        f"skipped={stats['skipped']} dead_lettered={stats['dead_lettered']} "
        f"avg_latency_ms={avg_ms:.1f} max_latency_ms={stats['max_latency_seconds'] * 1000:.1f}",
        flush=True,
    )
    return stats


def run_cycle(storage, retry_counts: dict):
    """Process one batch of unprocessed raw messages.

    ``retry_counts`` is an in-memory dict mapping raw_id → number of
    failed extraction attempts.  It is intentionally *not* persisted;
    on worker restart the counters reset which gives transient failures
    (e.g. a temporarily unavailable LLM) another chance.

    Four stages, cheapest first:

    1. Dead-letter rows that exhausted their retries.
    2. Skip rows that cannot contain a listing (no provider call at all).
    3. Fetch recent and historical rows through separate FIFO lane queries.
    4. Extract each lane across its reserved bounded thread pool; the two
       pools' combined size is the provider's concurrent-request ceiling.
    """
    running_tenant_ids = None
    if hasattr(storage, "get_running_extraction_tenant_ids"):
        running_tenant_ids = storage.get_running_extraction_tenant_ids()
        if running_tenant_ids == []:
            print("[worker] extraction paused/stopped for all active tenants; raw_messages remain queued", flush=True)
            return 0, 0, 0, 0, 0
        if running_tenant_ids is None:
            print("[worker] extraction control lookup unavailable; failing open", flush=True)

    cutoff = recent_cutoff()
    lane_specs = (
        ("fast", FAST_LANE_SLOTS),
        ("backlog", BACKLOG_LANE_SLOTS),
    )
    # Fetch lanes independently.  A Supabase/PostgREST error in one lane must
    # not prevent the other lane from draining; the failed lane is retried on
    # the next polling cycle.  This is especially important during an index
    # rollout or a transient API failure because the backlog and fast lane use
    # different query plans.
    lane_rows = []
    for lane, slots in lane_specs:
        if slots <= 0:
            continue
        try:
            rows = _fetch_lane(storage, lane, cutoff, BATCH_SIZE, running_tenant_ids)
        except Exception:
            print(f"[worker] {lane} lane fetch failed", flush=True)
            traceback.print_exc()
            continue
        lane_rows.append((lane, slots, rows))
    lane_rows, suppressed = _remove_opted_out_rows(storage, lane_rows)
    if suppressed:
        print(f"[worker] suppressed {suppressed} opted-out group rows; raw messages remain queued", flush=True)
    # The lane executors reserve disjoint slot pools, so both lanes can make
    # progress at once while their combined extraction calls remain bounded
    # by CONCURRENCY.
    with ThreadPoolExecutor(max_workers=2) as lane_pool:
        futures = [
            lane_pool.submit(_process_lane, storage, rows, lane, slots, retry_counts)
            for lane, slots, rows in lane_rows
            if slots > 0
        ]
        lane_stats = [future.result() for future in futures]

    attempted = sum(item["attempted"] for item in lane_stats)
    processed = sum(item["processed"] for item in lane_stats)
    failed = sum(item["failed"] for item in lane_stats)
    dead_lettered = sum(item["dead_lettered"] for item in lane_stats)
    skipped = sum(item["skipped"] for item in lane_stats)
    skip_reasons: dict[str, int] = {}
    for item in lane_stats:
        for reason, count in item["skip_reasons"].items():
            skip_reasons[reason] = skip_reasons.get(reason, 0) + count

    if dead_lettered:
        print(
            f"[worker] dead-lettered {dead_lettered} messages "
            f"(exceeded {MAX_RETRIES} retries)",
            flush=True,
        )
    if skipped:
        detail = " ".join(f"{k}={v}" for k, v in sorted(skip_reasons.items()))
        print(f"[worker] skipped {skipped} non-listing messages ({detail})", flush=True)
    return attempted, processed, failed, dead_lettered, skipped


def main():
    parser = argparse.ArgumentParser(description="Extraction worker")
    parser.add_argument("--poll", type=int, default=POLL_INTERVAL, help="Poll interval in seconds")
    args = parser.parse_args()

    storage = get_storage()
    retry_counts: dict[int, int] = {}
    print(
        f"[worker] Extraction worker started — polling every {args.poll}s "
        f"(batch={BATCH_SIZE} concurrency={CONCURRENCY} max_retries={MAX_RETRIES} "
        f"recent_window_hours={RECENT_WINDOW_HOURS:g} "
        f"lane_slots=fast:{FAST_LANE_SLOTS}/backlog:{BACKLOG_LANE_SLOTS} "
        f"budget={'$' + format(EXTRACTION_BUDGET_USD, '.2f') if EXTRACTION_BUDGET_USD is not None else 'unlimited'})",
        flush=True,
    )

    while True:
        try:
            if remaining_budget(storage, EXTRACTION_BUDGET_USD) == 0.0:
                spent = _cumulative_extraction_spend(storage)
                print(
                    f"[worker] EXTRACTION_BUDGET_USD reached (${spent:.2f} spent) — stopping.",
                    flush=True,
                )
                break
            if hasattr(storage, "has_unprocessed_raw"):
                has_pending = storage.has_unprocessed_raw()
            else:
                # Compatibility fallback for older storage doubles.
                has_pending = storage.count_unprocessed_raw() > 0
            if has_pending:
                attempted, stored, failed, dead_lettered, skipped = run_cycle(storage, retry_counts)
                if attempted or dead_lettered or skipped:
                    cleared = stored + dead_lettered + skipped
                    print(
                        f"[worker] cycle done: attempted={attempted} stored={stored} failed={failed} "
                        f"skipped={skipped} dead_lettered={dead_lettered} "
                        f"remaining=not_counted cleared={cleared}",
                        flush=True,
                    )
        except Exception:
            print("[worker] Cycle error:", flush=True)
            traceback.print_exc()
        time.sleep(args.poll)


if __name__ == "__main__":
    main()
