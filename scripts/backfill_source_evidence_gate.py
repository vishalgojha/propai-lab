#!/usr/bin/env python3
"""Re-apply the existing source-evidence gate to historical typed rows.

Dry-run is the default. Apply only after reviewing the report and applying
20260827100000_extraction_gate_backfill_audit.sql:

  python scripts/backfill_source_evidence_gate.py --output /tmp/gate.json
  python scripts/backfill_source_evidence_gate.py --apply --run-id RUN_UUID
  python scripts/backfill_source_evidence_gate.py --revert RUN_UUID

No LLM calls are made. The script imports ``_apply_source_evidence_gates``
directly and writes only the eight typed tables plus the audit table.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from datetime import datetime, timezone
from typing import Any

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from extraction import _apply_source_evidence_gates  # noqa: E402
from storage.supabase import SupabaseStorage  # noqa: E402

TABLES = (
    "residential_sale_listings", "residential_rent_listings",
    "commercial_sale_listings", "commercial_rent_listings",
    "residential_sale_requirements", "residential_rent_requirements",
    "commercial_sale_requirements", "commercial_rent_requirements",
)

GATED_FIELDS = (
    "bhk", "bhk_options", "original_bhk", "current_bhk",
    "configuration_type", "configuration_details", "property_category",
    "asset_type", "summary_title", "needs_review", "extraction_confidence",
)
AI_TO_ROW = {
    "title": "summary_title",
    "summary_title": "summary_title",
    "bhk": "bhk",
    "bhk_options": "bhk_options",
    "original_bhk": "original_bhk",
    "current_bhk": "current_bhk",
    "configuration_type": "configuration_type",
    "configuration_details": "configuration_details",
    "property_category": "asset_type",
    "asset_type": "asset_type",
}
BASE_SELECT = (
    "id,raw_message_id,normalized_message,raw_payload,ai_extraction,"
    "validation_flags,needs_review,extraction_confidence,corrected_fields,"
    "corrected_at,asset_type,summary_title,created_at"
)
TABLE_SELECT = {
    table: BASE_SELECT
    + (",bhk,configuration_type" if table in {
        "residential_sale_listings", "residential_rent_listings"
    } else "")
    + (",bhk_options" if table in {
        "residential_sale_requirements", "residential_rent_requirements"
    } else "")
    + (",original_bhk,current_bhk,configuration_details"
       if table in {"residential_sale_listings", "residential_rent_listings"}
       else "")
    for table in TABLES
}


def _client():
    url = os.getenv("SUPABASE_URL", "").strip()
    key = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_SERVICE_KEY") or "").strip()
    if not url or not key:
        raise RuntimeError("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/SUPABASE_SERVICE_KEY")
    # Use the repository's storage bootstrap so local execution does not
    # resolve the sibling ``supabase/`` migrations directory as a package.
    return SupabaseStorage(url, key).client


def _dict(value: Any) -> dict:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def _source_text(row: dict, raw_by_id: dict[int, str]) -> str:
    normalized = str(row.get("normalized_message") or "").strip()
    if normalized:
        return normalized
    payload = _dict(row.get("raw_payload"))
    for key in ("slice_text", "full_text", "normalized_message", "text", "message"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return raw_by_id.get(int(row.get("raw_message_id") or 0), "").strip()


def _raw_messages(client, ids: list[int]) -> dict[int, str]:
    result: dict[int, str] = {}
    for start in range(0, len(ids), 100):
        rows = client.table("raw_messages").select("id,message").in_("id", ids[start:start + 100]).execute().data or []
        result.update({int(row["id"]): str(row.get("message") or "") for row in rows})
    return result


def _flags(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value if str(item)]
    return []


def _ai(row: dict) -> dict:
    ai = dict(_dict(row.get("ai_extraction")))
    # Typed rows are the persisted source of truth after the schema cutover;
    # overlay only fields the gate reads, preserving the original AI shape.
    for field in ("bhk", "bhk_options", "original_bhk", "current_bhk",
                  "configuration_type", "configuration_details", "asset_type",
                  "summary_title", "needs_review", "extraction_confidence"):
        if field in row:
            ai[field] = row.get(field)
    ai["validation_flags"] = _flags(row.get("validation_flags"))
    return ai


def _json_equal(left: Any, right: Any) -> bool:
    return left == right


def _changes(table: str, row: dict, source: str) -> dict:
    expected_asset = "commercial" if table.startswith("commercial_") else "residential"
    actual_asset = str(row.get("asset_type") or "").strip().lower()
    if actual_asset and actual_asset != expected_asset:
        return {"table": table, "id": int(row["id"]), "raw_message_id": row.get("raw_message_id"),
                "skip_reason": f"asset_type={actual_asset!r} violates {expected_asset} table invariant"}
    before_flags = _flags(row.get("validation_flags"))
    before = _ai(row)
    after = _apply_source_evidence_gates(before, source)
    flags = list(dict.fromkeys(before_flags + _flags(after.get("validation_flags"))))
    flags_added = [flag for flag in flags if flag not in before_flags]
    changes: dict[str, dict[str, Any]] = {}
    for ai_field, row_field in AI_TO_ROW.items():
        if ai_field not in after or row_field not in row:
            continue
        old = row.get(row_field)
        new = after.get(ai_field)
        if not _json_equal(old, new):
            changes[row_field] = {"old": old, "new": new}
    if flags_added:
        changes["validation_flags"] = {"old": before_flags, "new": flags}
    if bool(after.get("needs_review")) != bool(row.get("needs_review")):
        changes["needs_review"] = {"old": row.get("needs_review"), "new": bool(after.get("needs_review"))}
    if not changes:
        return {}
    return {"table": table, "id": int(row["id"]), "raw_message_id": row.get("raw_message_id"),
            "fields": changes, "flags_added": flags_added, "source_preview": source[:240]}


def _fetch(client, table: str, all_rows: bool) -> list[dict]:
    rows: list[dict] = []
    for offset in range(0, 10_000_000, 1000):
        query = (client.table(table).select(TABLE_SELECT[table]).order("id")
                 .limit(1000).offset(offset))
        page = query.execute().data or []
        rows.extend(dict(row) for row in page)
        if len(page) < 1000:
            break
    if all_rows:
        return rows
    return [row for row in rows if str(row.get("extraction_confidence") or "").lower() == "high"
            and not _flags(row.get("validation_flags"))]


def _report(changes: list[dict], skipped: list[dict], output: str | None) -> None:
    payload = {"mode": "dry_run", "candidate_count": len(changes),
               "skipped_count": len(skipped), "changes": changes, "skipped": skipped}
    rendered = json.dumps(payload, ensure_ascii=False, indent=2, default=str)
    if output:
        with open(output, "w", encoding="utf-8") as handle:
            handle.write(rendered + "\n")
    else:
        print(rendered)


def _apply(client, changes: list[dict], run_id: str) -> None:
    applied_at = datetime.now(timezone.utc).isoformat()
    audit_ready = client.table("extraction_backfill_audit").select("id").limit(1).execute()
    if audit_ready is None:
        raise RuntimeError("extraction_backfill_audit migration is not available")
    for change in changes:
        table = change["table"]
        row_id = change["id"]
        fields = change["fields"]
        live = client.table(table).select("asset_type").eq("id", row_id).limit(1).execute().data or []
        if live:
            expected_asset = "commercial" if table.startswith("commercial_") else "residential"
            actual_asset = str(live[0].get("asset_type") or "").strip().lower()
            if actual_asset and actual_asset != expected_asset:
                logging.warning("Skipping %s/%s: asset_type=%s violates %s table invariant",
                                table, row_id, actual_asset, expected_asset)
                continue
        updates = {field: detail["new"] for field, detail in fields.items()}
        corrected = set()
        existing = client.table(table).select("corrected_fields").eq("id", row_id).limit(1).execute().data or []
        for field in (existing[0].get("corrected_fields") if existing else []) or []:
            corrected.add(str(field))
        corrected.update(field for field in fields if field not in {"validation_flags", "needs_review"})
        corrected_fields = sorted(corrected)
        existing_corrected_at = None
        existing_row = client.table(table).select("corrected_fields,corrected_at").eq("id", row_id).limit(1).execute().data or []
        if existing_row:
            existing_corrected_at = existing_row[0].get("corrected_at")
        updates["corrected_fields"] = corrected_fields
        updates["corrected_at"] = applied_at
        audit_rows = [{
            "source_table": table, "source_row_id": row_id,
            "raw_message_id": change.get("raw_message_id"), "field_name": field,
            "old_value": detail["old"], "new_value": detail["new"],
            "flags_added": change["flags_added"], "backfill_run_id": run_id,
            "applied_at": applied_at,
        } for field, detail in fields.items()]
        audit_rows.extend([
            {
                "source_table": table, "source_row_id": row_id,
                "raw_message_id": change.get("raw_message_id"), "field_name": "corrected_fields",
                "old_value": list(existing[0].get("corrected_fields") or []) if existing else [],
                "new_value": corrected_fields, "flags_added": change["flags_added"],
                "backfill_run_id": run_id, "applied_at": applied_at,
            },
            {
                "source_table": table, "source_row_id": row_id,
                "raw_message_id": change.get("raw_message_id"), "field_name": "corrected_at",
                "old_value": existing_corrected_at, "new_value": applied_at,
                "flags_added": change["flags_added"], "backfill_run_id": run_id,
                "applied_at": applied_at,
            },
        ])
        client.table("extraction_backfill_audit").insert(audit_rows).execute()
        try:
            client.table(table).update(updates).eq("id", row_id).execute()
        except Exception:
            # The audit must describe an actual correction. Remove only the
            # records just inserted for this failed row before propagating the
            # database error so a retry cannot inherit a false audit trail.
            client.table("extraction_backfill_audit").delete().eq(
                "backfill_run_id", run_id).eq("source_table", table
            ).eq("source_row_id", row_id).execute()
            raise


def _revert(client, run_id: str) -> None:
    rows = client.table("extraction_backfill_audit").select(
        "source_table,source_row_id,field_name,old_value"
    ).eq("backfill_run_id", run_id).order("id", desc=True).execute().data or []
    for row in rows:
        if row.get("source_table") not in TABLES or row.get("field_name") not in {
            *GATED_FIELDS, "validation_flags", "corrected_fields", "corrected_at",
        }:
            raise RuntimeError("audit row contains an out-of-scope table or field")
        client.table(row["source_table"]).update({row["field_name"]: row.get("old_value")}).eq(
            "id", row["source_row_id"]
        ).execute()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--all", action="store_true", help="run the gate against every row")
    parser.add_argument("--apply", action="store_true", help="apply the reviewed deterministic changes")
    parser.add_argument("--run-id", default=None, help="UUID for an apply run; generated if omitted")
    parser.add_argument("--revert", metavar="RUN_ID", help="restore old values from one applied run")
    parser.add_argument("--output", help="write dry-run JSON report to this path")
    args = parser.parse_args()
    if args.revert and (args.apply or args.output or args.all):
        parser.error("--revert cannot be combined with --apply, --all, or --output")
    client = _client()
    if args.revert:
        _revert(client, args.revert)
        print(json.dumps({"mode": "revert", "backfill_run_id": args.revert}))
        return 0
    run_id = args.run_id or str(uuid.uuid4())
    changes: list[dict] = []
    skipped: list[dict] = []
    counts: dict[str, int] = {}
    flag_counts: dict[str, int] = {}
    for table in TABLES:
        rows = _fetch(client, table, args.all)
        raw = _raw_messages(client, sorted({int(row.get("raw_message_id") or 0) for row in rows if row.get("raw_message_id")}))
        for row in rows:
            source = _source_text(row, raw)
            if not source:
                continue
            change = _changes(table, row, source)
            if change:
                if "skip_reason" in change:
                    skipped.append(change)
                    continue
                changes.append(change)
                counts[table] = counts.get(table, 0) + 1
                for flag in change["flags_added"]:
                    flag_counts[flag] = flag_counts.get(flag, 0) + 1
    if not args.apply:
        _report(changes, skipped, args.output)
        print(json.dumps({"mode": "dry_run", "run_id": run_id,
                          "counts_by_table": counts, "counts_by_flag": flag_counts,
                          "skipped_count": len(skipped)}), file=sys.stderr)
        return 0
    _apply(client, changes, run_id)
    print(json.dumps({"mode": "apply", "run_id": run_id, "corrected": len(changes),
                      "counts_by_table": counts, "counts_by_flag": flag_counts}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
