#!/usr/bin/env python3
"""Backfill rich residential-sale fields from existing WhatsApp evidence.

Default mode is dry-run. Use --apply to update Supabase.

This script intentionally updates only the additive rich fields introduced by
20260806190000_extend_residential_sale_listing_schema.sql. It does not rewrite
core listing identity, BHK, area, price, building, or transaction fields.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from ai_extraction import ai_extract_sync  # noqa: E402
from extraction import _ai_extraction_to_typed  # noqa: E402
from storage.supabase import SupabaseStorage  # noqa: E402


RICH_FIELDS = (
    "broker_company",
    "contacts",
    "showing_instructions",
    "contact_instructions",
    "availability_status",
    "brokerage_context",
    "co_brokered",
    "wing",
    "floor_min",
    "floor_max",
    "floor_label",
    "original_bhk",
    "current_bhk",
    "is_converted_unit",
    "is_combination_unit",
    "configuration_details",
    "can_sell_separately",
    "balcony_area_sqft",
    "balcony_area_raw_text",
    "terrace_area_sqft",
    "covered_terrace_area_sqft",
    "terrace_area_raw_text",
    "sellable_area_sqft",
    "computed_total_asking_price",
    "computed_price_confidence",
    "price_math",
    "unit_condition",
    "vastu_compliant",
    "view_description",
    "parking_details",
    "society_restrictions",
    "society_restrictions_raw",
    "unstructured_facts",
)

JSON_EMPTY = {
    "contacts": [],
    "price_math": {},
    "parking_details": {},
    "society_restrictions": [],
    "unstructured_facts": {},
}


def _storage() -> SupabaseStorage:
    url = os.getenv("SUPABASE_URL", "")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_SERVICE_KEY") or ""
    if not url or not key:
        raise RuntimeError("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/SUPABASE_SERVICE_KEY")
    return SupabaseStorage(url, key)


def _payload_dict(value: Any) -> dict:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def _is_empty(value: Any) -> bool:
    return value is None or value == "" or value == [] or value == {}


def _source_text(row: dict, raw_messages: dict[int, str]) -> tuple[str, str]:
    payload = _payload_dict(row.get("raw_payload"))
    slice_text = str(payload.get("slice_text") or "").strip()
    if slice_text:
        return slice_text, "raw_payload.slice_text"
    full_text = str(payload.get("full_text") or "").strip()
    if full_text:
        return full_text, "raw_payload.full_text"
    normalized = str(row.get("normalized_message") or "").strip()
    if normalized:
        return normalized, "normalized_message"
    raw_id = int(row.get("raw_message_id") or 0)
    raw = raw_messages.get(raw_id, "").strip()
    return raw, "raw_messages.message" if raw else ""


def _non_empty_updates(row: dict, proposed: dict, *, overwrite: bool) -> dict:
    updates = {}
    for field in RICH_FIELDS:
        value = proposed.get(field)
        if _is_empty(value):
            continue
        if not overwrite and not _is_empty(row.get(field, JSON_EMPTY.get(field))):
            continue
        updates[field] = value
    return updates


def _fetch_rows(storage: SupabaseStorage, limit: int, offset: int) -> list[dict]:
    columns = ",".join(
        [
            "id",
            "tenant_id",
            "raw_message_id",
            "listing_index",
            "raw_payload",
            "normalized_message",
            *RICH_FIELDS,
        ]
    )
    result = (
        storage.client.table("residential_sale_listings")
        .select(columns)
        .order("created_at", desc=True)
        .limit(limit)
        .offset(offset)
        .execute()
    )
    return result.data or []


def _fetch_raw_messages(storage: SupabaseStorage, raw_ids: list[int]) -> dict[int, str]:
    out: dict[int, str] = {}
    for start in range(0, len(raw_ids), 100):
        chunk = raw_ids[start : start + 100]
        if not chunk:
            continue
        result = storage.client.table("raw_messages").select("id,message").in_("id", chunk).execute()
        for row in result.data or []:
            out[int(row["id"])] = str(row.get("message") or "")
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=25)
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--apply", action="store_true", help="write proposed updates")
    parser.add_argument("--overwrite", action="store_true", help="overwrite non-empty rich fields")
    parser.add_argument("--json", action="store_true", help="emit JSON report")
    args = parser.parse_args()

    storage = _storage()
    rows = _fetch_rows(storage, args.limit, args.offset)
    raw_ids = sorted({int(row.get("raw_message_id") or 0) for row in rows if int(row.get("raw_message_id") or 0) > 0})
    raw_messages = _fetch_raw_messages(storage, raw_ids)

    report = []
    applied = 0
    skipped = 0
    failed = 0

    for row in rows:
        source, source_kind = _source_text(row, raw_messages)
        if not source:
            skipped += 1
            report.append({"id": row.get("id"), "status": "skipped", "reason": "missing_source"})
            continue
        try:
            result = ai_extract_sync(
                source,
                {
                    "tenant_id": row.get("tenant_id"),
                    "message_id": row.get("raw_message_id"),
                },
                storage=storage,
            )
            items = result.get("extractions") or []
            item = next(
                (
                    candidate
                    for candidate in items
                    if candidate.get("listing_type") == "sale"
                    and candidate.get("property_category") == "residential"
                ),
                items[0] if items else None,
            )
            if not item:
                skipped += 1
                report.append({"id": row.get("id"), "status": "skipped", "reason": result.get("error") or "no_extraction"})
                continue
            table, typed = _ai_extraction_to_typed(
                item,
                source,
                slice_text=source,
                raw_message_id=row.get("raw_message_id"),
                tenant_id=row.get("tenant_id"),
                listing_index=row.get("listing_index") or 0,
            )
            if table != "residential_sale_listings":
                skipped += 1
                report.append({"id": row.get("id"), "status": "skipped", "reason": f"routed_to_{table}"})
                continue
            updates = _non_empty_updates(row, typed, overwrite=args.overwrite)
            if not updates:
                skipped += 1
                report.append({"id": row.get("id"), "status": "skipped", "reason": "no_new_rich_fields", "source": source_kind})
                continue
            if args.apply:
                storage.client.table("residential_sale_listings").update(updates).eq("id", int(row["id"])).execute()
                applied += 1
                status = "applied"
            else:
                status = "dry_run"
            report.append({
                "id": row.get("id"),
                "raw_message_id": row.get("raw_message_id"),
                "source": source_kind,
                "status": status,
                "updates": updates,
            })
        except Exception as exc:
            failed += 1
            report.append({"id": row.get("id"), "status": "failed", "error": str(exc)})

    summary = {
        "mode": "apply" if args.apply else "dry_run",
        "rows_scanned": len(rows),
        "applied": applied,
        "skipped": skipped,
        "failed": failed,
        "report": report,
    }
    if args.json:
        print(json.dumps(summary, indent=2, ensure_ascii=False, default=str))
    else:
        print(json.dumps({k: v for k, v in summary.items() if k != "report"}, indent=2))
        for item in report[:10]:
            print(json.dumps(item, ensure_ascii=False, default=str))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
