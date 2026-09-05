#!/usr/bin/env python3
"""Apply a previously generated source-attached repair preview.

This is intentionally separate from the preview command. It accepts only a
CSV produced by ``preview_source_attached_repairs.py`` and uses null guards so
a row changed after preview is skipped rather than overwritten.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from storage.supabase import SupabaseStorage  # noqa: E402

STALE_LOCALITY_FLAGS = {
    "locality_unresolved", "locality_resolution_ambiguous",
    "building_places_locality_ambiguous",
}


def _array(value):
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (TypeError, ValueError):
            value = [value]
    return list(value or []) if isinstance(value, list) else []


def _apply_item(db, item: dict, now: str) -> Counter:
    counts = Counter()
    table = item["table"]
    row_id = item["id"]
    tenant_id = item.get("tenant_id")
    action = item["action"]
    query = db.table(table).select("id,validation_flags,corrected_fields")
    query = query.eq("id", row_id)
    if tenant_id:
        query = query.eq("tenant_id", tenant_id)
    current = query.limit(1).execute().data or []
    if not current:
        counts["skipped_missing_or_tenant"] += 1
        return counts
    row = current[0]
    updates = {
        "corrected_at": now,
        "corrected_fields": sorted(set(_array(row.get("corrected_fields")) + [
            "source_attached_locality_repair"
            if action == "set_locality_fields" else "source_attached_price_repair"
        ])),
    }
    if action == "set_locality_fields":
        updates.update({
            "locality_id": int(item["new_locality_id"]),
            "locality_resolved": item["new_locality"],
            "micro_market": item["new_locality"],
            "locality_match_status": "matched",
            "locality_confidence": item["locality_confidence"] or "medium",
            "validation_flags": [
                flag for flag in _array(row.get("validation_flags"))
                if str(flag) not in STALE_LOCALITY_FLAGS
            ],
        })
        guard_field = "locality_id"
    elif action == "set_monthly_rent":
        updates.update({"monthly_rent": float(item["new_price"]), "price_raw_text": item["price_source"]})
        guard_field = "monthly_rent"
    elif action == "set_total_asking_price":
        updates.update({"total_asking_price": float(item["new_price"]), "price_raw_text": item["price_source"]})
        guard_field = "total_asking_price"
    else:
        counts["skipped_unknown_action"] += 1
        return counts
    guarded = db.table(table).update(updates).eq("id", row_id)
    if tenant_id:
        guarded = guarded.eq("tenant_id", tenant_id)
    result = guarded.is_(guard_field, "null").execute().data or []
    counts["applied" if result else "skipped_changed_since_preview"] += 1
    if result:
        counts[action] += 1
    return counts


def apply_preview(path: str, workers: int = 12) -> Counter:
    storage = SupabaseStorage()
    db = storage.client
    counts = Counter()
    now = datetime.now(timezone.utc).isoformat()
    with open(path, newline="") as handle:
        items = list(csv.DictReader(handle))
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(_apply_item, db, item, now) for item in items]
        for future in futures:
            counts.update(future.result())
    return counts


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("preview_csv")
    parser.add_argument("--workers", type=int, default=12)
    args = parser.parse_args()
    print(dict(apply_preview(args.preview_csv, args.workers)))
