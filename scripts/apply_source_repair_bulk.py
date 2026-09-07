#!/usr/bin/env python3
"""Bulk-apply the approved source-repair CSV through guarded PostgREST calls."""
import argparse
import csv
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from storage.supabase import SupabaseStorage  # noqa: E402

STALE = {"locality_unresolved", "locality_resolution_ambiguous", "building_places_locality_ambiguous"}


def arr(value):
    return list(value or []) if isinstance(value, list) else []


def apply(path: str, chunk_size: int = 500) -> Counter:
    db = SupabaseStorage().client
    items = list(csv.DictReader(open(path, newline="")))
    counts = Counter()
    now = datetime.now(timezone.utc).isoformat()
    # Apply locality before price so a row present in both actions retains
    # both provenance markers after the second grouped update.
    for action in ("set_locality_fields", "set_monthly_rent", "set_total_asking_price"):
        selected = [item for item in items if item["action"] == action]
        by_table = defaultdict(list)
        for item in selected:
            by_table[item["table"]].append(item)
        for table, table_items in by_table.items():
            current = {}
            ids = [item["id"] for item in table_items]
            for start in range(0, len(ids), chunk_size):
                page = db.table(table).select("id,tenant_id,validation_flags,corrected_fields," + (
                    "locality_id" if action == "set_locality_fields" else
                    "monthly_rent" if action == "set_monthly_rent" else "total_asking_price"
                )).in_("id", ids[start:start + chunk_size]).execute().data or []
                current.update({str(row["id"]): row for row in page})
            groups = defaultdict(list)
            for item in table_items:
                row = current.get(str(item["id"]))
                if not row:
                    counts["skipped_missing"] += 1
                    continue
                target = "locality_id" if action == "set_locality_fields" else "monthly_rent" if action == "set_monthly_rent" else "total_asking_price"
                if row.get(target) is not None:
                    counts["skipped_already_filled"] += 1
                    continue
                fields = arr(row.get("corrected_fields"))
                fields.append("source_attached_locality_repair" if action == "set_locality_fields" else "source_attached_price_repair")
                updates = {"corrected_at": now, "corrected_fields": sorted(set(fields))}
                if action == "set_locality_fields":
                    updates.update({
                        "locality_id": int(item["new_locality_id"]),
                        "locality_resolved": item["new_locality"],
                        "micro_market": item["new_locality"],
                        "locality_match_status": "matched",
                        "locality_confidence": item["locality_confidence"] or "medium",
                        "validation_flags": [f for f in arr(row.get("validation_flags")) if str(f) not in STALE],
                    })
                else:
                    updates[target] = float(item["new_price"])
                    updates["price_raw_text"] = item["price_source"]
                key = (item.get("tenant_id") or "", tuple(sorted((k, str(v)) for k, v in updates.items())))
                groups[(key, target)].append(item["id"])
            for (key, target), row_ids in groups.items():
                tenant, encoded = key
                updates = dict(encoded)
                for field, value in updates.items():
                    if field in {"corrected_fields", "validation_flags"}:
                        import ast
                        updates[field] = ast.literal_eval(value)
                    elif field in {"locality_id"}:
                        updates[field] = int(value)
                    elif field in {"monthly_rent", "total_asking_price"}:
                        updates[field] = float(value)
                query = db.table(table).update(updates).in_("id", row_ids)
                if tenant:
                    query = query.eq("tenant_id", tenant)
                result = query.is_(target, "null").execute().data or []
                counts["applied"] += len(result)
                counts[action] += len(result)
    return counts


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("preview_csv")
    args = parser.parse_args()
    print(dict(apply(args.preview_csv)))
