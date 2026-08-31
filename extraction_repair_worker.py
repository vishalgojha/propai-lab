"""Durable worker for historical extraction-boundary repairs."""
from __future__ import annotations

import logging
import os
import time

from extraction import _materialize_split_raw_messages, preview_source_boundaries
from extraction_worker import context_from_raw
from extraction import get_storage

POLL = float(os.getenv("EXTRACTION_REPAIR_WORKER_POLL_SECONDS", "5"))
BATCH = max(1, min(10, int(os.getenv("EXTRACTION_REPAIR_WORKER_BATCH_SIZE", "2"))))


def run_once(storage) -> int:
    jobs = storage.claim_extraction_repair_jobs(limit=BATCH)
    completed = 0
    for job in jobs:
        job_id = int(job["id"])
        parent_id = int(job["parent_raw_id"])
        try:
            # A repair job must never read a raw message from another tenant.
            raw = storage.get_raw_message(parent_id, tenant_id=job.get("tenant_id"))
            if not raw:
                storage.update_extraction_repair_job(job_id, status="failed", error="parent raw message not found")
                continue
            row = raw.__dict__
            # Boundary repair uses the same LLM-only segmentation contract as
            # forward extraction. Children are reprocessed by the normal
            # extraction pipeline before any typed row is persisted.
            pattern, chunks = preview_source_boundaries(
                str(row.get("message") or ""),
                job.get("tenant_id"),
            )
            if not pattern or len(chunks) < 2:
                storage.update_extraction_repair_job(job_id, status="no_split", pattern_id=pattern or "")
                continue
            ctx = context_from_raw(raw)
            ctx["split_pattern"] = pattern
            child_ids = _materialize_split_raw_messages(storage, parent_id, ctx, chunks)
            if len(child_ids) != len(chunks):
                raise RuntimeError(f"expected {len(chunks)} children, got {len(child_ids)}")
            storage.mark_raw_extraction_superseded(parent_id, job_id)
            storage.mark_raw_processed(parent_id)
            storage.update_extraction_repair_job(job_id, status="queued", pattern_id=pattern, child_raw_ids=child_ids)
            completed += 1
            print(f"[repair-worker] parent={parent_id} children={len(child_ids)} pattern={pattern}", flush=True)
        except Exception as exc:
            logging.exception("repair job %s failed", job_id)
            storage.update_extraction_repair_job(job_id, status="failed", error=str(exc)[:500])
    return completed


def main() -> None:
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper())
    storage = get_storage()
    print(f"[repair-worker] started batch={BATCH} poll={POLL}s", flush=True)
    while True:
        try:
            run_once(storage)
        except Exception:
            logging.exception("repair worker cycle failed")
        time.sleep(POLL)


if __name__ == "__main__":
    main()
