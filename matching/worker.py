"""Durable incremental/nightly requirement-to-listing matcher."""
from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timezone

from storage import SupabaseStorage
from .service import run_sample

POLL = float(os.getenv("REQUIREMENT_MATCH_WORKER_POLL_SECONDS", "300"))
BATCH = max(1, min(250, int(os.getenv("REQUIREMENT_MATCH_WORKER_REQUIREMENTS", "50"))))


def _heartbeat(storage, *, status: str, metrics: dict, last_error: str | None = None) -> None:
    try:
        storage.client.table("worker_heartbeats").upsert({
            "worker_name": "matcher-worker",
            "service_name": os.getenv("COOLIFY_RESOURCE_NAME", "matcher"),
            "status": status,
            "heartbeat_at": datetime.now(timezone.utc).isoformat(),
            "runtime_version": (
                os.getenv("COOLIFY_COMMIT_SHA")
                or os.getenv("GIT_COMMIT_SHA")
                or os.getenv("COOLIFY_BRANCH")
                or "unknown"
            ),
            "last_error": last_error,
            "config": {"batch_size": BATCH, "poll_seconds": POLL, "metrics": metrics},
        }, on_conflict="worker_name").execute()
    except Exception:
        logging.getLogger(__name__).exception("matcher heartbeat failed")


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
    metrics = {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "last_cycle_at": None,
        "last_work_at": None,
        "last_success_at": None,
        "last_cycle": {"requirements_scanned": 0, "match_rows_written": 0, "requirements_with_matches": 0},
    }
    _heartbeat(storage, status="running", metrics=metrics)
    while True:
        try:
            result = run_once(storage, tenant_id)
            print(f"[match-worker] {result}", flush=True)
            cycle_at = datetime.now(timezone.utc).isoformat()
            metrics["last_cycle"] = result
            metrics["last_cycle_at"] = cycle_at
            if result.get("requirements_scanned"):
                metrics["last_work_at"] = cycle_at
            if result.get("match_rows_written"):
                metrics["last_success_at"] = cycle_at
            _heartbeat(storage, status="running", metrics=metrics)
        except Exception:
            logging.exception("matching worker cycle failed")
            _heartbeat(storage, status="degraded", metrics=metrics, last_error="Matcher cycle failed")
        time.sleep(POLL)


if __name__ == "__main__":
    main()
