"""Durable incremental/nightly requirement-to-listing matcher."""
from __future__ import annotations

import logging
import os
import time

from storage import SupabaseStorage
from .service import run_sample

POLL = float(os.getenv("REQUIREMENT_MATCH_WORKER_POLL_SECONDS", "300"))
BATCH = max(1, min(250, int(os.getenv("REQUIREMENT_MATCH_WORKER_REQUIREMENTS", "50"))))


def run_once(storage: SupabaseStorage, tenant_id: str | None = None) -> dict[str, int]:
    """Run one cycle for one debug tenant or every active organization."""
    tenant_ids = [tenant_id] if tenant_id else [
        str(row["id"]) for row in storage.list_organizations(limit=10000)
        if row.get("id") and row.get("is_active", True) is not False
    ]
    total = {"tenants_scanned": 0, "requirements_scanned": 0, "match_rows_written": 0, "requirements_with_matches": 0}
    for current_tenant in tenant_ids:
        result = run_sample(storage, tenant_id=current_tenant, limit_requirements=BATCH)
        total["tenants_scanned"] += 1
        for key in ("requirements_scanned", "match_rows_written", "requirements_with_matches"):
            total[key] += result.get(key, 0)
    return total


def main() -> None:
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper())
    tenant_id = os.getenv("MATCH_TENANT_ID") or None
    storage = SupabaseStorage(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])
    scope = tenant_id or "all-active-tenants"
    print(f"[match-worker] started scope={scope} batch={BATCH} poll={POLL}s", flush=True)
    while True:
        try:
            result = run_once(storage, tenant_id)
            print(f"[match-worker] {result}", flush=True)
        except Exception:
            logging.exception("matching worker cycle failed")
        time.sleep(POLL)


if __name__ == "__main__":
    main()
