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


def _finish(storage, item: dict, decision: str, reason: str) -> None:
    storage.client.table("tenant_boundary_review_queue").update({
        "decision": decision,
        "decision_reason": reason[:1000],
        "decided_at": datetime.now(timezone.utc).isoformat(),
        "locked_at": None,
        "locked_by": None,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", int(item["id"])).eq("decision", "replay").execute()


def run_once(storage) -> int:
    claimed = storage.client.rpc(
        "claim_tenant_boundary_replays", {"p_limit": BATCH}
    ).execute().data or []
    completed = 0
    for item in claimed:
        try:
            table = str(item.get("typed_table") or "")
            row_id = int(item.get("typed_row_id") or 0)
            raw_id = int(item.get("raw_message_id") or 0)
            raw_tenant = str(item.get("raw_tenant_id") or "").strip()
            if table not in TABLES or row_id <= 0 or raw_id <= 0 or not raw_tenant:
                _finish(storage, item, "quarantine", "invalid review evidence")
                continue

            raw = storage.client.table("raw_messages").select(
                "id,tenant_id,source,group_name,message_uid"
            ).eq("id", raw_id).limit(1).execute().data or []
            if not raw or str(raw[0].get("tenant_id") or "") != raw_tenant:
                _finish(storage, item, "quarantine", "raw source tenant changed or is missing")
                continue

            typed = storage.client.table(table).select(
                "id,raw_message_id,tenant_id"
            ).eq("id", row_id).limit(1).execute().data or []
            if not typed or int(typed[0].get("raw_message_id") or 0) != raw_id:
                _finish(storage, item, "quarantine", "typed source row changed or is missing")
                continue

            result = storage.client.table(table).update({
                "tenant_id": raw_tenant,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }).eq("id", row_id).eq("raw_message_id", raw_id).execute()
            if not result.data:
                _finish(storage, item, "quarantine", "tenant repair was not applied")
                continue
            _finish(storage, item, "repaired", "tenant aligned to verified raw source tenant")
            completed += 1
        except Exception as exc:
            logging.exception("tenant boundary item %s failed", item.get("id"))
            _finish(storage, item, "quarantine", f"repair failed: {exc}")
    return completed


def main() -> None:
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper())
    storage = get_storage()
    while True:
        try:
            run_once(storage)
        except Exception:
            logging.exception("tenant boundary repair cycle failed")
        time.sleep(POLL)


if __name__ == "__main__":
    main()
