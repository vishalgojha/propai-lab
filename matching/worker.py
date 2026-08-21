"""Durable incremental/nightly requirement-to-listing matcher."""
from __future__ import annotations

import logging
import os
import time

from storage import SupabaseStorage
from .service import run_sample

POLL = float(os.getenv("REQUIREMENT_MATCH_WORKER_POLL_SECONDS", "300"))
BATCH = max(1, min(250, int(os.getenv("REQUIREMENT_MATCH_WORKER_REQUIREMENTS", "50"))))


def run_once(storage: SupabaseStorage, tenant_id: str) -> dict[str, int]:
    return run_sample(storage, tenant_id=tenant_id, limit_requirements=BATCH)


def main() -> None:
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper())
    tenant_id = os.getenv("MATCH_TENANT_ID")
    if not tenant_id:
        raise RuntimeError("MATCH_TENANT_ID is required; refusing an unscoped run")
    storage = SupabaseStorage(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])
    print(f"[match-worker] started tenant={tenant_id} batch={BATCH} poll={POLL}s", flush=True)
    while True:
        try:
            result = run_once(storage, tenant_id)
            print(f"[match-worker] {result}", flush=True)
        except Exception:
            logging.exception("matching worker cycle failed")
        time.sleep(POLL)


if __name__ == "__main__":
    main()
