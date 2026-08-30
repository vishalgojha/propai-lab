"""Standing, throttled reprocessor for review-flagged typed observations.

This is deliberately separate from ``extraction_worker.py`` (live ingestion)
and ``extraction_repair_worker.py`` (split-parent repair). It claims durable
per-row jobs, uses the normal source-scoped extraction path, and marks terminal
outcomes so missing evidence or an unfixable row is never retried forever.

Run locally with::

    python3 extraction_reprocessing_worker.py

The worker is not started by the normal API process. Deploy it as its own
Coolify process after the queue migration has been applied and heartbeat/RPC
visibility has been verified.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

from extraction import get_storage, process_raw_message
from extraction_worker import context_from_raw


WORKER_NAME = "extraction-reprocessing-worker"
POLL_SECONDS = max(5.0, float(os.getenv("EXTRACTION_REPROCESSING_POLL_SECONDS", "30")))
BATCH_SIZE = max(1, min(100, int(os.getenv("EXTRACTION_REPROCESSING_BATCH_SIZE", "10"))))
CONCURRENCY = max(1, min(20, int(os.getenv("EXTRACTION_REPROCESSING_CONCURRENCY", "2"))))
RATE_PER_MINUTE = max(0.0, float(os.getenv("EXTRACTION_REPROCESSING_RATE_PER_MINUTE", "6")))
DRY_RUN = os.getenv("EXTRACTION_REPROCESSING_DRY_RUN", "false").strip().lower() in {
    "1", "true", "yes", "on"
}

_logger = logging.getLogger(__name__)


def recoverable_source(raw) -> str:
    """Return source text suitable for extraction, or an empty string.

    A media marker, sender/group metadata, or an empty payload is not source
    evidence. Prefer the raw message body and use retained payload text only
    for legacy rows where the body column is unavailable.
    """
    candidates = [getattr(raw, "message", "")]
    payload = getattr(raw, "raw_payload", {})
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except (TypeError, json.JSONDecodeError):
            payload = {}
    if isinstance(payload, dict):
        candidates.extend((payload.get("full_text"), payload.get("slice_text"), payload.get("message")))
    for value in candidates:
        text = str(value or "").strip()
        if text and text.casefold() not in {"[image]", "[video]", "[document]", "[audio]", "[sticker]"}:
            return text
    return ""


class RateLimiter:
    """Process-wide minimum interval limiter shared by worker threads."""

    def __init__(self, per_minute: float):
        self.interval = 60.0 / per_minute if per_minute > 0 else 0.0
        self._lock = threading.Lock()
        self._next_at = 0.0

    def wait(self) -> None:
        if self.interval <= 0:
            return
        with self._lock:
            now = time.monotonic()
            start = max(now, self._next_at)
            self._next_at = start + self.interval
        delay = start - now
        if delay > 0:
            time.sleep(delay)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _job_update(storage, job_id: int, *, status: str, result: dict | None = None, error: str | None = None) -> None:
    storage.client.table("extraction_reprocessing_jobs").update({
        "status": status,
        "result": result or {},
        "last_error": error,
        "completed_at": _now() if status in {"fixed", "still_unresolved", "no_source", "failed"} else None,
        "updated_at": _now(),
    }).eq("id", int(job_id)).execute()


def _row(storage, table: str, row_id: int) -> dict | None:
    result = storage.client.table(table).select("*").eq("id", int(row_id)).limit(1).execute()
    rows = result.data or []
    return rows[0] if rows else None


def _release_quarantine(storage, job: dict, row: dict) -> None:
    """Remove only this worker's quarantine markers after a clean result."""
    flags = row.get("validation_flags")
    if isinstance(flags, str):
        try:
            flags = json.loads(flags)
        except (TypeError, json.JSONDecodeError):
            flags = []
    flags = [flag for flag in (flags or []) if flag not in {
        "grounding_backfill_20260830", "locality_unresolved",
    }]
    payload = {
        "needs_review": False,
        "validation_flags": flags,
        "updated_at": _now(),
    }
    # A flagged duplicate status may have come from the quarantine migration;
    # only release it when no remaining worker/review flags exist.
    if str(row.get("duplicate_status") or "").lower() == "flagged" and not flags:
        payload["duplicate_status"] = "distinct"
    storage.client.table(job["source_table"]).update(payload).eq("id", int(job["source_row_id"])).execute()


def process_job(storage, job: dict, limiter: RateLimiter) -> str:
    """Process one claimed job and return its terminal outcome."""
    job_id = int(job["id"])
    raw_id = int(job.get("raw_message_id") or 0)
    try:
        raw = storage.get_raw_message(raw_id, tenant_id=job.get("tenant_id")) if raw_id else None
        source = recoverable_source(raw) if raw else ""
        if not source:
            _job_update(storage, job_id, status="no_source", result={"raw_message_id": raw_id})
            return "no_source_available"
        if DRY_RUN:
            _job_update(storage, job_id, status="still_unresolved", result={"dry_run": True, "source_chars": len(source)})
            return "still_unresolved"

        limiter.wait()
        result = process_raw_message(
            raw_id,
            {**context_from_raw(raw), "reprocessing": True},
            storage=storage,
        )
        updated = _row(storage, job["source_table"], int(job["source_row_id"]))
        if updated and updated.get("needs_review") is not True:
            _release_quarantine(storage, job, updated)
            _job_update(storage, job_id, status="fixed", result={"pipeline": result or {}})
            return "fixed"
        _job_update(storage, job_id, status="still_unresolved", result={"pipeline": result or {}})
        return "still_unresolved"
    except Exception as exc:  # terminal failure; an operator can explicitly requeue it
        _logger.exception("reprocessing job %s failed", job_id)
        _job_update(storage, job_id, status="failed", error=str(exc)[:500])
        return "failed"


def _heartbeat(storage, status: str, counts: dict | None = None) -> None:
    try:
        storage.client.table("worker_heartbeats").upsert({
            "worker_name": WORKER_NAME,
            "service_name": os.getenv("COOLIFY_RESOURCE_NAME", WORKER_NAME),
            "status": status,
            "heartbeat_at": _now(),
            "runtime_version": os.getenv("COOLIFY_COMMIT_SHA", "reprocessing-worker-local"),
            "config": {
                "poll_seconds": POLL_SECONDS,
                "batch_size": BATCH_SIZE,
                "concurrency": CONCURRENCY,
                "rate_per_minute": RATE_PER_MINUTE,
            },
            "last_error": None,
        }, on_conflict="worker_name").execute()
    except Exception:
        _logger.exception("reprocessing heartbeat failed")


def run_once(storage) -> dict[str, int]:
    """Claim one batch, process it, and persist an observable run summary."""
    started = _now()
    counts = {key: 0 for key in (
        "attempted", "fixed", "still_unresolved", "no_source_available", "failed",
    )}
    run_row = storage.client.table("extraction_reprocessing_runs").insert({
        "worker_name": WORKER_NAME,
        "started_at": started,
        "config": {
            "poll_seconds": POLL_SECONDS,
            "batch_size": BATCH_SIZE,
            "concurrency": CONCURRENCY,
            "rate_per_minute": RATE_PER_MINUTE,
            "dry_run": DRY_RUN,
        },
    }).execute()
    try:
        jobs = storage.client.rpc(
            "claim_extraction_reprocessing_jobs", {"p_limit": BATCH_SIZE}
        )
        jobs = jobs if isinstance(jobs, list) else []
        limiter = RateLimiter(RATE_PER_MINUTE)
        with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
            futures = [pool.submit(process_job, storage, dict(job), limiter) for job in jobs]
            for future in as_completed(futures):
                counts["attempted"] += 1
                outcome = future.result()
                counts[outcome] = counts.get(outcome, 0) + 1
        storage.client.table("extraction_reprocessing_runs").update({
            "completed_at": _now(), "counts": counts,
        }).eq("id", int((run_row.data or [{}])[0].get("id") or 0)).execute()
        _heartbeat(storage, "running", counts)
        _logger.info("reprocessing run counts=%s", counts)
        return counts
    except Exception as exc:
        run_id = int((run_row.data or [{}])[0].get("id") or 0)
        if run_id:
            storage.client.table("extraction_reprocessing_runs").update({
                "completed_at": _now(), "counts": counts, "error": str(exc)[:500],
            }).eq("id", run_id).execute()
        _heartbeat(storage, "degraded", counts)
        raise


def main() -> None:
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper())
    storage = get_storage()
    _heartbeat(storage, "running")
    _logger.info(
        "started poll=%ss batch=%s concurrency=%s rate=%s/min dry_run=%s",
        POLL_SECONDS, BATCH_SIZE, CONCURRENCY, RATE_PER_MINUTE, DRY_RUN,
    )
    while True:
        try:
            run_once(storage)
        except Exception:
            _logger.exception("reprocessing cycle failed")
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
