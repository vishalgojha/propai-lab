#!/usr/bin/env python3
"""Review and replay a bounded set of historical WhatsApp extractions.

This is intentionally separate from ``extraction_worker.py``. The normal
worker only consumes ``processed = false`` queue rows; this tool can replay
specific already-processed rows after a reviewed plan is approved.

Safe workflow:

  1. Dry-run and write a plan (read-only):
     python3 scripts/reprocess_extractions.py \
       --tenant-id ORG_UUID --group-jid GROUP_JID --limit 30 \
       --include-processed --include-suppressed \
       --write-plan /tmp/reprocess-plan.json

  2. Review the plan, then apply only that exact plan:
     python3 scripts/reprocess_extractions.py \
       --tenant-id ORG_UUID --apply --plan-file /tmp/reprocess-plan.json \
       --confirm REPROCESS

The default maximum is 30 rows. No rows are changed during dry-run. Apply
validates tenant, source message hash, and the exact planned row set before
resetting queue state. The existing extraction pipeline then re-writes the
typed row through its source-fingerprint upsert path.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from extraction import get_storage, process_raw_message
from extraction_worker import context_from_raw

PLAN_VERSION = 1
DEFAULT_LIMIT = 30
MAX_LIMIT = 30


def source_hash(raw) -> str:
    payload = raw.raw_payload if isinstance(raw.raw_payload, str) else json.dumps(
        raw.raw_payload or {}, sort_keys=True, default=str
    )
    material = "\0".join((str(raw.message or ""), str(payload or "")))
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def select_candidates(storage, args) -> list[dict]:
    query = storage.client.table("raw_messages").select(
        "id,tenant_id,group_name,sender,timestamp,processed,processed_at,"
        "extraction_suppressed,extraction_attempts,extraction_outcome"
    ).eq("tenant_id", args.tenant_id).eq("is_group", True)

    if args.raw_id:
        query = query.in_("id", args.raw_id)
    elif args.group_jid:
        query = query.eq("group_name", args.group_jid)
    elif args.group_name:
        query = query.ilike("group_name", f"%{args.group_name}%")
    else:
        raise ValueError("dry-run requires --raw-id, --group-jid, or --group-name")

    if not args.include_suppressed:
        query = query.eq("extraction_suppressed", False)
    if not args.include_processed:
        query = query.eq("processed", False)
    if args.after_id:
        query = query.gt("id", args.after_id)

    rows = query.order("id", desc=False).limit(args.limit).execute().data or []
    return [dict(row) for row in rows]


def plan_entry(storage, row: dict) -> dict:
    raw = storage.get_raw_message(int(row["id"]))
    if not raw:
        raise RuntimeError(f"raw message disappeared while planning: {row['id']}")
    return {
        "raw_id": int(raw.id),
        "tenant_id": str(row.get("tenant_id") or ""),
        "group_name": raw.group_name,
        "sender": raw.sender,
        "timestamp": raw.timestamp,
        "message_preview": (raw.message or "").replace("\n", " ")[:240],
        "source_hash": source_hash(raw),
        "processed": bool(row.get("processed")),
        "processed_at": row.get("processed_at"),
        "extraction_suppressed": bool(row.get("extraction_suppressed")),
        "extraction_attempts": int(row.get("extraction_attempts") or 0),
        "extraction_outcome": row.get("extraction_outcome"),
    }


def write_plan(path: Path, tenant_id: str, entries: list[dict]) -> None:
    payload = {
        "plan_version": PLAN_VERSION,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "tenant_id": tenant_id,
        "row_count": len(entries),
        "rows": entries,
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def load_plan(path: Path, tenant_id: str) -> list[dict]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("plan_version") != PLAN_VERSION:
        raise ValueError("unsupported or missing replay plan version")
    if str(payload.get("tenant_id")) != tenant_id:
        raise ValueError("plan tenant_id does not match --tenant-id")
    rows = payload.get("rows") or []
    if not rows or len(rows) > MAX_LIMIT:
        raise ValueError(f"plan must contain 1-{MAX_LIMIT} rows")
    ids = [int(row["raw_id"]) for row in rows]
    if len(ids) != len(set(ids)):
        raise ValueError("plan contains duplicate raw IDs")
    return rows


def validate_plan(storage, tenant_id: str, entries: list[dict]) -> list[object]:
    raws = []
    for entry in entries:
        raw = storage.get_raw_message(int(entry["raw_id"]))
        if not raw:
            raise ValueError(f"raw_id={entry['raw_id']} no longer exists")
        if str(raw.tenant_id or "") != tenant_id:
            raise ValueError(f"raw_id={raw.id} belongs to another tenant")
        if source_hash(raw) != entry.get("source_hash"):
            raise ValueError(f"raw_id={raw.id} source changed since plan was created")
        raws.append(raw)
    return raws


def reset_for_replay(storage, tenant_id: str, raw_ids: list[int]) -> None:
    """Put only the reviewed rows back on the normal extraction queue."""
    result = storage.client.table("raw_messages").update({
        "processed": False,
        "processed_at": None,
        "extraction_attempts": 0,
        "extraction_outcome": None,
        "extraction_last_error": None,
        "extraction_suppressed": False,
    }).eq("tenant_id", tenant_id).in_("id", raw_ids).select("id").execute()
    changed = len(result.data or [])
    if changed != len(raw_ids):
        raise RuntimeError(f"replay reset changed {changed} rows; expected {len(raw_ids)}")


def replay_one(storage, raw, tenant_id: str) -> tuple[str, str]:
    attempt_id = None
    try:
        attempt = storage.begin_raw_extraction_attempt(raw.id, lane="replay")
        attempt_id = int((attempt or {}).get("attempt_id") or 0) or None
        context = context_from_raw(raw)
        context["tenant_id"] = tenant_id
        result = process_raw_message(raw.id, context, storage=storage) or {}
        status = result.get("storage_status") if isinstance(result, dict) else "stored"
        if status == "failed":
            raise RuntimeError("extraction returned storage_status=failed")
        if attempt_id:
            storage.finish_raw_extraction_attempt(
                attempt_id,
                "succeeded" if status == "stored" else "skipped",
                reason=str(result.get("extraction_source") or status or "replay"),
                details={"replay": True},
            )
        return "stored" if status == "stored" else "skipped", ""
    except Exception as exc:
        if attempt_id:
            storage.finish_raw_extraction_attempt(
                attempt_id, "failed", reason=str(exc)[:500], details={"replay": True}
            )
        return "failed", str(exc)[:500]


def main() -> int:
    parser = argparse.ArgumentParser(description="Review and replay bounded historical extractions")
    parser.add_argument("--tenant-id", required=True)
    parser.add_argument("--raw-id", action="append", type=int, help="Exact raw ID; repeatable")
    parser.add_argument("--group-jid", help="Exact WhatsApp group JID")
    parser.add_argument("--group-name", help="Case-insensitive group-name fragment")
    parser.add_argument("--after-id", type=int, default=0)
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT)
    parser.add_argument("--include-processed", action="store_true", help="Include already processed rows")
    parser.add_argument("--include-suppressed", action="store_true", help="Include consent-suppressed rows")
    parser.add_argument("--write-plan", type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--plan-file", type=Path)
    parser.add_argument("--confirm", help="Must be REPROCESS when applying a reviewed plan")
    args = parser.parse_args()
    args.limit = max(1, min(int(args.limit), MAX_LIMIT))

    if args.apply:
        if not args.plan_file or args.confirm != "REPROCESS":
            parser.error("--apply requires --plan-file and --confirm REPROCESS")
        if args.raw_id or args.group_jid or args.group_name:
            parser.error("--apply accepts scope only from --plan-file")
    elif not (args.raw_id or args.group_jid or args.group_name):
        parser.error("dry-run requires --raw-id, --group-jid, or --group-name")

    storage = get_storage()
    storage.tenant_id = args.tenant_id

    if args.apply:
        entries = load_plan(args.plan_file, args.tenant_id)
        raws = validate_plan(storage, args.tenant_id, entries)
        ids = [raw.id for raw in raws]
        reset_for_replay(storage, args.tenant_id, ids)
        print(f"RESET {len(ids)} reviewed raw rows; replaying through extraction pipeline")
        counts = {"stored": 0, "skipped": 0, "failed": 0}
        for raw in raws:
            status, reason = replay_one(storage, raw, args.tenant_id)
            counts[status] += 1
            print(f"raw_id={raw.id} status={status}{' reason=' + reason if reason else ''}", flush=True)
        print(json.dumps(counts, sort_keys=True))
        return 1 if counts["failed"] else 0

    rows = select_candidates(storage, args)
    entries = [plan_entry(storage, row) for row in rows]
    print(f"DRY RUN: {len(entries)} row(s); no data changed")
    for entry in entries:
        print(
            f"raw_id={entry['raw_id']} group={entry['group_name']!r} "
            f"processed={entry['processed']} suppressed={entry['extraction_suppressed']} "
            f"attempts={entry['extraction_attempts']} preview={entry['message_preview']!r}"
        )
    if args.write_plan:
        write_plan(args.write_plan, args.tenant_id, entries)
        print(f"PLAN_WRITTEN={args.write_plan}")
    print("Review the plan, then apply only with --apply --plan-file FILE --confirm REPROCESS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
