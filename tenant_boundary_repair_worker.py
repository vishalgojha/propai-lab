"""Apply only explicitly approved tenant-boundary repairs."""
from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timezone

from extraction import get_storage

POLL = float(os.getenv("TENANT_BOUNDARY_REPAIR_POLL_SECONDS", "15"))
BATCH = max(1, min(100, int(os.getenv("TENANT_BOUNDARY_REPAIR_BATCH_SIZE", "25"))))
TABLES = {
    "residential_sale_requirements",
    "residential_rent_requirements",
    "commercial_sale_requirements",
    "commercial_rent_requirements",
}


def _heartbeat(storage, *, status: str, metrics: dict, last_error: str | None = None) -> None:
    try:
        storage.client.table("worker_heartbeats").upsert({
            "worker_name": "tenant-boundary-repair-worker",
            "service_name": os.getenv("COOLIFY_RESOURCE_NAME", "tenant-boundary-repair-worker"),
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
        logging.getLogger(__name__).exception("tenant boundary heartbeat failed")


def _finish(storage, item: dict, decision: str, reason: str, *, typed_tenant_id: str | None = None) -> None:
    updates = {
        "decision": decision,
        "decision_reason": reason[:1000],
        "decided_at": datetime.now(timezone.utc).isoformat(),
        "locked_at": None,
        "locked_by": None,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    if typed_tenant_id:
        updates["typed_tenant_id"] = typed_tenant_id
    storage.client.table("tenant_boundary_review_queue").update(updates).eq("id", int(item["id"])).eq("decision", "replay").execute()


def run_once(storage) -> int:
    rpc_result = storage.client.rpc(
        "claim_tenant_boundary_replays", {"p_limit": BATCH}
    )
    # The installed Supabase client returns RPC rows directly for this call,
    # unlike table queries which return a response object with `.data`.
    claimed = rpc_result if isinstance(rpc_result, list) else (rpc_result.data or [])
    completed = 0
    quarantined = 0
    for item in claimed:
        try:
            table = str(item.get("typed_table") or "")
            row_id = int(item.get("typed_row_id") or 0)
            raw_id = int(item.get("raw_message_id") or 0)
            raw_tenant = str(item.get("raw_tenant_id") or "").strip()
            if table not in TABLES or row_id <= 0 or raw_id <= 0 or not raw_tenant:
                _finish(storage, item, "quarantine", "invalid review evidence")
                quarantined += 1
                continue

            raw = storage.client.table("raw_messages").select(
                "id,tenant_id,source,group_name,message_uid"
            ).eq("id", raw_id).limit(1).execute().data or []
            if not raw or str(raw[0].get("tenant_id") or "") != raw_tenant:
                _finish(storage, item, "quarantine", "raw source tenant changed or is missing")
                quarantined += 1
                continue

            typed = storage.client.table(table).select(
                "id,raw_message_id,tenant_id"
            ).eq("id", row_id).limit(1).execute().data or []
            if not typed or int(typed[0].get("raw_message_id") or 0) != raw_id:
                _finish(storage, item, "quarantine", "typed source row changed or is missing")
                quarantined += 1
                continue

            result = storage.client.table(table).update({
                "tenant_id": raw_tenant,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }).eq("id", row_id).eq("raw_message_id", raw_id).execute()
            if not result.data:
                _finish(storage, item, "quarantine", "tenant repair was not applied")
                quarantined += 1
                continue
            _finish(storage, item, "repaired", "tenant aligned to verified raw source tenant", typed_tenant_id=raw_tenant)
            completed += 1
        except Exception as exc:
            logging.exception("tenant boundary item %s failed", item.get("id"))
            _finish(storage, item, "quarantine", f"repair failed: {exc}")
            quarantined += 1
    run_once.last_stats = {
        "attempted": len(claimed),
        "succeeded": completed,
        "failed": quarantined,
    }
    return completed


run_once.last_stats = {"attempted": 0, "succeeded": 0, "failed": 0}


def main() -> None:
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper())
    storage = get_storage()
    print(f"[tenant-boundary-worker] started batch={BATCH} poll={POLL}s", flush=True)
    metrics = {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "last_cycle_at": None,
        "last_work_at": None,
        "last_success_at": None,
        "last_cycle": run_once.last_stats,
    }
    _heartbeat(storage, status="running", metrics=metrics)
    while True:
        try:
            run_once(storage)
            cycle_at = datetime.now(timezone.utc).isoformat()
            cycle = dict(run_once.last_stats)
            metrics["last_cycle"] = cycle
            metrics["last_cycle_at"] = cycle_at
            if cycle.get("attempted"):
                metrics["last_work_at"] = cycle_at
            if cycle.get("succeeded"):
                metrics["last_success_at"] = cycle_at
            _heartbeat(storage, status="running", metrics=metrics)
        except Exception:
            logging.exception("tenant boundary repair cycle failed")
            _heartbeat(storage, status="degraded", metrics=metrics, last_error="Tenant boundary repair cycle failed")
        time.sleep(POLL)


if __name__ == "__main__":
    main()
