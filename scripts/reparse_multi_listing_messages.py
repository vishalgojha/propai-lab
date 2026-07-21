#!/usr/bin/env python3
"""Safely reparse selected multi-listing WhatsApp posts with the current AI pipeline.

Dry-run (default):
  python scripts/reparse_multi_listing_messages.py --tenant-id <uuid> --broker-phone 8655245101

Apply after reviewing the dry run:
  python scripts/reparse_multi_listing_messages.py --tenant-id <uuid> --broker-phone 8655245101 --apply
"""

import argparse
import re
from typing import Iterable

from extraction import get_storage, process_raw_message
from extraction_worker import context_from_raw
from lab import multi_listing


def normalize_phone(value: str) -> str:
    return re.sub(r"\D", "", value)[-10:]


def parsed_rows_for_scope(storage, args) -> list[dict]:
    query = storage.client.table("parsed_output").select("raw_message_id,broker_name,broker_phone")\
        .eq("tenant_id", args.tenant_id)
    if args.broker_phone:
        query = query.eq("broker_phone", normalize_phone(args.broker_phone))
    else:
        query = query.ilike("broker_name", f"%{args.broker_name.strip()}%")
    result = query.order("raw_message_id", desc=True).limit(args.limit * 4).execute()
    return list(result.data or [])


def unique_raw_ids(rows: Iterable[dict], limit: int) -> list[int]:
    ids: list[int] = []
    seen: set[int] = set()
    for row in rows:
        raw_id = int(row.get("raw_message_id") or 0)
        if raw_id and raw_id not in seen:
            seen.add(raw_id)
            ids.append(raw_id)
        if len(ids) >= limit:
            break
    return ids


def delete_derived_rows(storage, raw_id: int) -> None:
    parsed_rows = storage.client.table("parsed_output").select("id").eq("raw_message_id", raw_id).execute().data or []
    parsed_ids = [int(row["id"]) for row in parsed_rows]

    # Children keyed directly by the raw message are removed first. This keeps
    # the raw WhatsApp event intact and only replaces derived extraction data.
    for table in ("observation_evidence", "listing_observations", "broker_observations"):
        storage.client.table(table).delete().eq("raw_message_id", raw_id).execute()

    if parsed_ids:
        for table, field in (
            ("resolver_decisions", "parsed_id"),
            ("enrichment_jobs", "parsed_id"),
            ("observation_evidence", "parsed_id"),
            ("listing_observations", "parsed_id"),
            ("broker_observations", "parsed_id"),
            ("requirement_matches", "requirement_id"),
        ):
            storage.client.table(table).delete().in_(field, parsed_ids).execute()

    storage.client.table("parsed_output").delete().eq("raw_message_id", raw_id).execute()


def main() -> int:
    parser = argparse.ArgumentParser(description="Reparse selected multi-listing WhatsApp messages")
    parser.add_argument("--tenant-id", required=True, help="Organization UUID to keep the replay tenant-scoped")
    broker = parser.add_mutually_exclusive_group(required=True)
    broker.add_argument("--broker-phone", help="Broker phone, including or excluding +91")
    broker.add_argument("--broker-name", help="Broker display-name fragment")
    parser.add_argument("--limit", type=int, default=50, help="Maximum raw posts to inspect (default: 50, max: 250)")
    parser.add_argument("--apply", action="store_true", help="Replace derived parsed rows and rerun extraction")
    args = parser.parse_args()
    args.limit = max(1, min(args.limit, 250))

    storage = get_storage()
    rows = parsed_rows_for_scope(storage, args)
    candidates = []
    for raw_id in unique_raw_ids(rows, args.limit):
        raw = storage.get_raw_message(raw_id)
        if not raw or getattr(raw, "tenant_id", None) != args.tenant_id:
            continue
        if multi_listing.classify_message(raw.message or "") == "multi":
            candidates.append(raw)

    mode = "APPLY" if args.apply else "DRY RUN"
    print(f"{mode}: {len(candidates)} multi-listing raw message(s) selected")
    for raw in candidates:
        print(f"  raw_id={raw.id} group={raw.group_name!r} sender={raw.sender!r} text={(raw.message or '')[:100]!r}")

    if not args.apply:
        print("No data changed. Re-run with --apply after reviewing this list.")
        return 0

    for raw in candidates:
        delete_derived_rows(storage, raw.id)
        context = context_from_raw(raw)
        context["tenant_id"] = args.tenant_id
        context["skip_knowledge_record"] = True
        process_raw_message(raw.id, context, storage=storage)

    storage.rebuild_broker_graph()
    print(f"Reparsed {len(candidates)} multi-listing raw message(s) and rebuilt broker entities.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
