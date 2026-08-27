#!/usr/bin/env python3
"""Backfill source-grounded decimal-k monthly rents.

Dry-run by default:
    python3 scripts/backfill_decimal_k_rents.py --output /tmp/decimal-k.json
    python3 scripts/backfill_decimal_k_rents.py --apply --run-id RUN_UUID

Only rent listing rows whose source contains an explicit decimal ``k`` quote
below 5 are changed. The existing extraction parser is used to calculate the
new value; this script does not invent or reinterpret any other price.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import uuid
from datetime import datetime, timezone
from typing import Any

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from extraction import _source_rent_price_value  # noqa: E402
from storage.supabase import SupabaseStorage  # noqa: E402

TABLES = ("residential_rent_listings", "commercial_rent_listings")
DECIMAL_K_RE = re.compile(r"(?<![\d.])(\d+\.\d+)\s*k\b", re.IGNORECASE)


def client():
    url = os.getenv("SUPABASE_URL", "").strip()
    key = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_SERVICE_KEY") or "").strip()
    if not url or not key:
        raise RuntimeError("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/SUPABASE_SERVICE_KEY")
    return SupabaseStorage(url, key).client


def as_dict(value: Any) -> dict:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def source_text(row: dict, raw_by_id: dict[int, str]) -> str:
    normalized = str(row.get("normalized_message") or "").strip()
    if normalized:
        return normalized
    payload = as_dict(row.get("raw_payload"))
    for key in ("slice_text", "full_text", "normalized_message", "text", "message"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return raw_by_id.get(int(row.get("raw_message_id") or 0), "").strip()


def fetch_rows(db, table: str) -> list[dict]:
    rows: list[dict] = []
    page = 1000
    for offset in range(0, 1_000_000, page):
        batch = db.table(table).select(
            "id,raw_message_id,normalized_message,raw_payload,monthly_rent,corrected_fields,corrected_at"
        ).order("id").limit(page).offset(offset).execute().data or []
        rows.extend(batch)
        if len(batch) < page:
            break
    return rows


def raw_messages(db, ids: list[int]) -> dict[int, str]:
    result: dict[int, str] = {}
    for start in range(0, len(ids), 100):
        batch = ids[start:start + 100]
        rows = db.table("raw_messages").select("id,message").in_("id", batch).execute().data or []
        result.update({int(row["id"]): str(row.get("message") or "") for row in rows})
    return result


def changes_for(db) -> list[dict]:
    changes: list[dict] = []
    for table in TABLES:
        rows = fetch_rows(db, table)
        raw_by_id = raw_messages(db, [int(row["raw_message_id"]) for row in rows if row.get("raw_message_id")])
        for row in rows:
            text = source_text(row, raw_by_id)
            match = DECIMAL_K_RE.search(text)
            if not match:
                continue
            amount = float(match.group(1))
            if amount >= 5:
                continue
            proposed = _source_rent_price_value(text)
            old = row.get("monthly_rent")
            if proposed is None or old is None or abs(float(old) - proposed) < 0.01:
                continue
            changes.append({
                "table": table,
                "id": int(row["id"]),
                "field": "monthly_rent",
                "old": old,
                "new": proposed,
                "source_quote": match.group(0),
            })
    return changes


def apply(db, changes: list[dict], run_id: str) -> None:
    applied_at = datetime.now(timezone.utc).isoformat()
    # Fail before touching source rows if the audit migration is unavailable.
    db.table("extraction_backfill_audit").select("id").limit(1).execute()
    for change in changes:
        table, row_id = change["table"], change["id"]
        live = db.table(table).select("monthly_rent,corrected_fields").eq("id", row_id).limit(1).execute().data or []
        if not live or live[0].get("monthly_rent") != change["old"]:
            continue
        corrected = live[0].get("corrected_fields")
        if not isinstance(corrected, list):
            corrected = []
        if "monthly_rent" not in corrected:
            corrected = [*corrected, "monthly_rent"]
        db.table("extraction_backfill_audit").insert({
            "source_table": table,
            "source_row_id": row_id,
            "field_name": "monthly_rent",
            "old_value": change["old"],
            "new_value": change["new"],
            "flags_added": [],
            "backfill_run_id": run_id,
            "applied_at": applied_at,
        }).execute()
        try:
            db.table(table).update({
                "monthly_rent": change["new"],
                "corrected_fields": corrected,
                "corrected_at": applied_at,
            }).eq("id", row_id).execute()
        except Exception:
            db.table("extraction_backfill_audit").delete().eq("backfill_run_id", run_id).eq("source_table", table).eq("source_row_id", row_id).eq("field_name", "monthly_rent").execute()
            raise


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="/tmp/decimal-k-rents.json")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--run-id")
    args = parser.parse_args()
    db = client()
    changes = changes_for(db)
    run_id = args.run_id or str(uuid.uuid4())
    report = {"mode": "apply" if args.apply else "dry_run", "run_id": run_id, "count": len(changes), "changes": changes}
    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
    print(json.dumps({k: report[k] for k in ("mode", "run_id", "count")}))
    if args.apply:
        apply(db, changes, run_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
