#!/usr/bin/env python3
"""Preview and safely reparse historical multi-opportunity WhatsApp posts.

The default mode is read-only: it parses the raw WhatsApp history and prints
the exact cards that would be created. ``--apply`` inserts that reviewed
generation first and removes the old parsed rows only after the expected
number of new rows has been saved successfully.
"""

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Iterable

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from extraction import get_storage, process_raw_message
from extraction_worker import context_from_raw
from lab import multi_listing


def normalize_phone(value: str) -> str:
    return re.sub(r"\D", "", value)[-10:]


def raw_rows_for_scope(storage, args) -> list[dict]:
    """Select from raw history, including posts never parsed successfully."""
    query = (
        storage.client.table("raw_messages")
        .select("id")
        .eq("tenant_id", args.tenant_id)
    )
    if args.raw_id:
        query = query.eq("id", args.raw_id)
    else:
        query = query.eq("is_group", True)
        if args.after_raw_id:
            query = query.gt("id", args.after_raw_id)
        if args.broker_phone:
            query = query.ilike("sender_phone", f"%{normalize_phone(args.broker_phone)}")
        elif args.broker_name:
            query = query.ilike("sender", f"%{args.broker_name.strip()}%")

    # Ascending keyset order lets --all walk the entire history in bounded
    # batches without slow/unstable OFFSET pagination.
    result = query.order("id", desc=False).limit(args.limit).execute()
    return list(result.data or [])


def unique_raw_ids(rows: Iterable[dict], limit: int) -> list[int]:
    ids: list[int] = []
    seen: set[int] = set()
    for row in rows:
        raw_id = int(row.get("id") or row.get("raw_message_id") or 0)
        if raw_id and raw_id not in seen:
            seen.add(raw_id)
            ids.append(raw_id)
        if len(ids) >= limit:
            break
    return ids


def existing_parsed_ids(storage, raw_id: int) -> list[int]:
    rows = (
        storage.client.table("parsed_output")
        .select("id")
        .eq("raw_message_id", raw_id)
        .execute()
        .data
        or []
    )
    return [int(row["id"]) for row in rows]


def discard_parsed_generation(storage, tenant_id: str, parsed_ids: list[int]) -> int:
    """Atomically discard one parsed generation via a service-role-only RPC."""
    if not parsed_ids:
        return 0
    result = storage.client.rpc(
        "discard_parsed_generation",
        {"p_tenant_id": tenant_id, "p_parsed_ids": parsed_ids},
    ).execute()
    return int(result.data or 0)


def replace_parsed_generation(
    storage,
    tenant_id: str,
    raw_id: int,
    old_ids: list[int],
    new_ids: list[int],
) -> dict:
    """Atomically verify the complete new generation, then retire the old."""
    result = storage.client.rpc(
        "replace_parsed_generation",
        {
            "p_tenant_id": tenant_id,
            "p_raw_message_id": raw_id,
            "p_old_ids": old_ids,
            "p_new_ids": new_ids,
        },
    ).execute()
    return dict(result.data or {})


def preview_raw(storage, raw, tenant_id: str) -> dict:
    context = context_from_raw(raw)
    context.update({
        "tenant_id": tenant_id,
        "skip_knowledge_record": True,
        "preview_only": True,
    })
    result = process_raw_message(raw.id, context, storage=storage) or {}
    result.setdefault("parsed_listings", [])
    result.setdefault("proposed_count", len(result["parsed_listings"]))
    return result


def card_summary(item: dict) -> str:
    intent = item.get("intent") or item.get("transaction_type") or "UNKNOWN"
    parts = [
        item.get("building_name"),
        item.get("configuration"),
        item.get("floor") or item.get("floor_range"),
        item.get("locality"),
        item.get("price_text") or item.get("rent_text"),
    ]
    details = " | ".join(str(value) for value in parts if value not in (None, ""))
    return f"{intent}: {details or item.get('summary_title') or 'unlabelled card'}"


def raw_message_sha256(raw) -> str:
    return hashlib.sha256((raw.message or "").encode("utf-8")).hexdigest()


def write_plan(
    storage,
    path: Path,
    tenant_id: str,
    candidates: list[tuple[object, dict]],
) -> None:
    payload = {
        "version": 2,
        "tenant_id": tenant_id,
        "posts": [
            {
                "raw_id": int(raw.id),
                "raw_message_sha256": raw_message_sha256(raw),
                "old_parsed_ids": existing_parsed_ids(storage, raw.id),
                "proposed_count": int(preview["proposed_count"]),
                "parsed_listings": preview["parsed_listings"],
            }
            for raw, preview in candidates
        ],
    }
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, default=str),
        encoding="utf-8",
    )


def load_plan(storage, path: Path, tenant_id: str) -> list[tuple[object, dict]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("version") != 2 or payload.get("tenant_id") != tenant_id:
        raise ValueError("plan version or tenant does not match this run")
    candidates: list[tuple[object, dict]] = []
    for post in payload.get("posts") or []:
        raw = storage.get_raw_message(int(post["raw_id"]))
        cards = post.get("parsed_listings") or []
        planned_old_ids = sorted(int(value) for value in post.get("old_parsed_ids") or [])
        current_old_ids = sorted(existing_parsed_ids(storage, int(post["raw_id"])))
        if (
            not raw
            or str(getattr(raw, "tenant_id", "")) != tenant_id
            or post.get("raw_message_sha256") != raw_message_sha256(raw)
            or planned_old_ids != current_old_ids
            or int(post.get("proposed_count") or 0) != len(cards)
            or len(cards) < 2
        ):
            raise ValueError(f"invalid or stale plan entry for raw_id={post.get('raw_id')}")
        candidates.append((raw, {
            "parsed_listings": cards,
            "proposed_count": len(cards),
            "extraction_source": "reviewed_plan",
            "old_parsed_ids": planned_old_ids,
        }))
    return candidates


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Preview or safely reparse historical multi-opportunity WhatsApp posts"
    )
    parser.add_argument("--tenant-id", required=True, help="Organization UUID")
    scope = parser.add_mutually_exclusive_group(required=False)
    scope.add_argument("--raw-id", type=int, help="Exact raw WhatsApp message id")
    scope.add_argument("--broker-phone", help="Broker phone, with or without +91")
    scope.add_argument("--broker-name", help="Broker display-name fragment")
    scope.add_argument("--all", action="store_true", help="Inspect all tenant group history up to --limit")
    parser.add_argument("--limit", type=int, default=250, help="Maximum raw posts to inspect (max: 5000)")
    parser.add_argument(
        "--after-raw-id",
        type=int,
        default=0,
        help="For historical batches, inspect ids after this cursor",
    )
    parser.add_argument(
        "--write-plan",
        type=Path,
        help="Write the exact dry-run cards to a JSON plan for later --apply",
    )
    parser.add_argument(
        "--plan-file",
        type=Path,
        help="With --apply, use this previously reviewed plan (no new AI call)",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Insert validated cards, then replace their old parsed generation",
    )
    args = parser.parse_args()
    args.limit = max(1, min(args.limit, 5000))
    if args.apply and not args.plan_file:
        parser.error("--apply requires --plan-file so only reviewed cards can be written")
    has_scope = bool(args.raw_id or args.broker_phone or args.broker_name or args.all)
    if args.apply and has_scope:
        parser.error("--apply reads its exact scope from --plan-file; do not add a selector")
    if not args.apply and not has_scope:
        parser.error("dry-run requires --raw-id, --broker-phone, --broker-name, or --all")
    if not args.apply and args.plan_file:
        parser.error("--plan-file is only valid with --apply")

    storage = get_storage()
    storage.tenant_id = args.tenant_id
    rejected = 0
    if args.apply:
        candidates = load_plan(storage, args.plan_file, args.tenant_id)
    else:
        rows = raw_rows_for_scope(storage, args)
        next_cursor = max((int(row.get("id") or 0) for row in rows), default=0)
        candidates: list[tuple[object, dict]] = []
        for raw_id in unique_raw_ids(rows, args.limit):
            raw = storage.get_raw_message(raw_id)
            if not raw or str(getattr(raw, "tenant_id", "")) != args.tenant_id:
                continue
            if multi_listing.classify_message(raw.message or "") != "multi":
                continue
            preview = preview_raw(storage, raw, args.tenant_id)
            if int(preview.get("proposed_count") or 0) < 2:
                rejected += 1
                continue
            candidates.append((raw, preview))

    mode = "APPLY" if args.apply else "DRY RUN"
    print(
        f"{mode}: {len(candidates)} safe multi-opportunity post(s); "
        f"{rejected} rejected because fewer than two cards were produced"
    )
    for raw, preview in candidates:
        old_count = len(existing_parsed_ids(storage, raw.id))
        print(
            f"  raw_id={raw.id} group={raw.group_name!r} sender={raw.sender!r} "
            f"old={old_count} proposed={preview['proposed_count']} "
            f"source={preview.get('extraction_source')}"
        )
        for index, item in enumerate(preview["parsed_listings"], start=1):
            print(f"    {index}. {card_summary(item)}")

    if not args.apply:
        if args.write_plan:
            write_plan(storage, args.write_plan, args.tenant_id, candidates)
            print(f"Reviewed plan written to {args.write_plan}")
        if next_cursor:
            print(f"NEXT_CURSOR={next_cursor}")
        print("No data changed. Review the cards above, then re-run with --apply.")
        return 0

    applied = 0
    failed = 0
    for raw, preview in candidates:
        old_ids = list(preview.get("old_parsed_ids") or existing_parsed_ids(storage, raw.id))
        context = context_from_raw(raw)
        context.update({
            "tenant_id": args.tenant_id,
            "skip_knowledge_record": True,
            "preparsed_listings": preview["parsed_listings"],
        })
        try:
            result = process_raw_message(raw.id, context, storage=storage) or {}
            new_ids = [
                int(value)
                for value in (result.get("parsed_ids") or [])
                if int(value) not in set(old_ids)
            ]
            if len(new_ids) != int(preview["proposed_count"]):
                discard_parsed_generation(storage, args.tenant_id, new_ids)
                failed += 1
                print(
                    f"  FAILED raw_id={raw.id}: saved {len(new_ids)} of "
                    f"{preview['proposed_count']} proposed cards; old rows preserved"
                )
                continue
            replace_parsed_generation(
                storage, args.tenant_id, raw.id, old_ids, new_ids
            )
            applied += 1
        except Exception as exc:
            # Any partial new generation can be identified as ids not present
            # before the attempt. Roll it back and preserve the old cards.
            current_ids = existing_parsed_ids(storage, raw.id)
            discard_parsed_generation(
                storage,
                args.tenant_id,
                [value for value in current_ids if value not in old_ids],
            )
            failed += 1
            print(f"  FAILED raw_id={raw.id}: {exc}; old rows preserved")

    if applied:
        try:
            storage.rebuild_observation_graph()
        except Exception as exc:
            print(f"Observation graph rebuild warning: {exc}")
        storage.rebuild_broker_graph()
    print(f"Applied {applied} post(s); failed safely {failed}. Raw WhatsApp history was untouched.")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
