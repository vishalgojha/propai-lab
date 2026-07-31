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
from threading import Lock

from extraction import get_storage, process_raw_message
from extraction_dedup import should_skip

POLL_INTERVAL = int(os.getenv("EXTRACTION_WORKER_POLL_SECONDS", "5"))
BATCH_SIZE = int(os.getenv("EXTRACTION_WORKER_BATCH_SIZE", "50"))
MAX_RETRIES = int(os.getenv("EXTRACTION_WORKER_MAX_RETRIES", "5"))

# Provider-side concurrency ceiling. The Grid account rejects the 6th
# in-flight request with `429 concurrency_limit_exceeded`, so the default
# stays at 5 and is overridable for deployments with different headroom.
CONCURRENCY = int(os.getenv("EXTRACTION_WORKER_CONCURRENCY", "5"))

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
        "tenant_id": row_value(row, "tenant_id") or "",
    }


def run_cycle(storage, retry_counts: dict):
    """Process one batch of unprocessed raw messages.

    ``retry_counts`` is an in-memory dict mapping raw_id → number of
    failed extraction attempts.  It is intentionally *not* persisted;
    on worker restart the counters reset which gives transient failures
    (e.g. a temporarily unavailable LLM) another chance.

    Three stages, cheapest first:

    1. Dead-letter rows that exhausted their retries.
    2. Skip rows that cannot contain a listing (no provider call at all).
    3. Extract the remainder across a bounded thread pool, sized to the
       provider's concurrent-request ceiling.
    """
    unprocessed = storage.get_unprocessed_raw_messages(limit=BATCH_SIZE)
    processed = 0
    failed = 0
    dead_lettered = 0
    skipped = 0
    skip_reasons: dict[str, int] = {}

    extractable = []

    for row in unprocessed:
        raw_id = row_value(row, "id")
        attempts = retry_counts.get(raw_id, 0)

        if attempts >= MAX_RETRIES:
            # Permanently stuck — mark processed so it never blocks the
            # queue again.  A human can re-process via the dashboard.
            try:
                storage.mark_raw_processed(raw_id)
                dead_lettered += 1
            except Exception:
                pass
            continue

        # Deterministic pre-LLM filter. A skipped message is marked
        # processed so it leaves the queue, but no parsed_output row is
        # written — it never claimed to be a listing.
        reason = should_skip(row_value(row, "message"))
        if reason:
            try:
                storage.mark_raw_processed(raw_id)
                skipped += 1
                skip_reasons[reason] = skip_reasons.get(reason, 0) + 1
            except Exception:
                pass
            continue

        extractable.append(row)

    if extractable:
        lock = Lock()

        def _handle(row):
            nonlocal processed, failed
            raw_id = row_value(row, "id")
            attempts = retry_counts.get(raw_id, 0)
            try:
                ctx = context_from_raw(row)
                process_raw_message(raw_id, ctx, storage=storage)
                with lock:
                    processed += 1
                    retry_counts.pop(raw_id, None)
            except Exception:
                with lock:
                    retry_counts[raw_id] = attempts + 1
                    failed += 1
                print(
                    f"[worker] raw_id={raw_id} failed (attempt {attempts + 1}/{MAX_RETRIES}):",
                    flush=True,
                )
                traceback.print_exc()

        workers = max(1, min(CONCURRENCY, len(extractable)))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for future in as_completed(pool.submit(_handle, r) for r in extractable):
                # _handle swallows its own errors; this surfaces anything
                # that escaped (e.g. a failure inside the executor itself).
                future.result()

    if dead_lettered:
        print(
            f"[worker] dead-lettered {dead_lettered} messages "
            f"(exceeded {MAX_RETRIES} retries)",
            flush=True,
        )
    if skipped:
        detail = " ".join(f"{k}={v}" for k, v in sorted(skip_reasons.items()))
        print(f"[worker] skipped {skipped} non-listing messages ({detail})", flush=True)
    return processed, failed, dead_lettered, skipped


def main():
    parser = argparse.ArgumentParser(description="Extraction worker")
    parser.add_argument("--poll", type=int, default=POLL_INTERVAL, help="Poll interval in seconds")
    args = parser.parse_args()

    storage = get_storage()
    retry_counts: dict[int, int] = {}
    print(
        f"[worker] Extraction worker started — polling every {args.poll}s "
        f"(batch={BATCH_SIZE} concurrency={CONCURRENCY} max_retries={MAX_RETRIES} "
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
            count = storage.count_unprocessed_raw()
            if count > 0:
                processed, failed, dead_lettered, skipped = run_cycle(storage, retry_counts)
                if processed or dead_lettered or skipped:
                    cleared = processed + dead_lettered + skipped
                    print(
                        f"[worker] cycle done: processed={processed} failed={failed} "
                        f"skipped={skipped} dead_lettered={dead_lettered} "
                        f"remaining={max(0, count - cleared)}",
                        flush=True,
                    )
        except Exception:
            print("[worker] Cycle error:", flush=True)
            traceback.print_exc()
        time.sleep(args.poll)


if __name__ == "__main__":
    main()
