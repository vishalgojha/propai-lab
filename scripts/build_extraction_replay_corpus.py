#!/usr/bin/env python3
"""Build a stratified, source-grounded extraction evaluation corpus.

This command is read-only. It samples existing typed observations by observed
quality flag, joins each observation to its raw WhatsApp message, and writes a
local JSONL manifest keyed by ``raw_message_id:listing_index``. It does not
call Sarvam, reset queue state, or update Supabase.

Example:
    python3 scripts/build_extraction_replay_corpus.py \
        --sample-size 240 --output /tmp/propai-replay-corpus.jsonl

The output is deliberately a manifest rather than a production table. A
reviewer can annotate ``expected`` fields later, and a separate replay runner
can consume only an explicitly approved manifest.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import httpx

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from extraction import get_storage

SCHEMA_VERSION = 1
MAX_SAMPLE_SIZE = 1000
DEFAULT_SAMPLE_SIZE = 240

TABLES = {
    "residential_rent_listings": "monthly_rent",
    "residential_sale_listings": "total_asking_price",
    "commercial_rent_listings": "monthly_rent",
    "commercial_sale_listings": "total_asking_price",
}

# These are families, not mutually exclusive labels. One case can expose
# several failures; retaining all labels makes later analysis reproducible.
FLAG_FAMILIES = {
    "title_grounding": ("title_evidence_mismatch",),
    "bhk_grounding": ("bhk_source_missing", "bhk_dropped_not_in_source_slice", "bhk_source_mismatch"),
    "price_grounding": ("missing_price", "price_source_missing", "price_value_not_traceable_to_source", "price_total_source_conflict"),
    "location_identity": ("missing_building_or_locality", "locality_source_conflict", "building_name_unresolved", "building_name_is_listing_text"),
    "furnishing_grounding": ("furnishing_without_source_evidence",),
    "price_normalization": ("invalid_price_unit:per_sqft", "price_psf_ai_mismatch_corrected", "price_below_property_scale"),
}

COMMON_TYPED_FIELDS = (
    "id,raw_message_id,listing_index,needs_review,validation_flags,"
    "ai_extraction,raw_payload,building_name,locality_resolved,"
    "transaction_type,price_raw_text,carpet_area_sqft,created_at"
)

RESIDENTIAL_TYPED_FIELDS = COMMON_TYPED_FIELDS + ",bhk"


def _compact(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def format_families(text: str) -> list[str]:
    """Classify observed WhatsApp shape without interpreting property facts."""
    value = str(text or "")
    folded = value.lower()
    labels: list[str] = []
    if re.search(r"[\U0001F300-\U0001FAFF]|[\u2600-\u27BF]", value):
        labels.append("emoji_anchored")
    if re.search(r"(^|\n)\s*[•*·▪▸➤-]", value):
        labels.append("bullet_or_bold_fields")
    if re.search(r"(?:={3,}|-{3,}|_{3,})", value):
        labels.append("separator_blocks")
    if len(re.findall(r"\b(?:rent|lease|sale|sell|buy|purchase)\b", folded)) >= 2:
        labels.append("mixed_or_repeated_transaction_cues")
    if re.search(r"(?:\d+(?:\.\d+)?\s*(?:l|lac|lakh|cr|crore)\b|\d+\s*k\b|psf|per\s*sq\.?\s*ft|persqft)", folded):
        labels.append("price_shorthand")
    if re.search(r"\b(?:\d+(?:\.\d+)?\s*bhk|bhk\s*\d+|rk)\b", folded):
        labels.append("configuration_cue")
    if re.search(r"\b(?:carpet|crpt|built[- ]?up|sq\.?\s*ft|sqft)\b", folded):
        labels.append("area_cue")
    if not labels:
        labels.append("plain_or_unclassified")
    return labels


def source_hash(message: str, raw_payload: Any) -> str:
    payload = raw_payload if isinstance(raw_payload, str) else json.dumps(
        raw_payload or {}, sort_keys=True, ensure_ascii=False, default=str
    )
    return hashlib.sha256((str(message or "") + "\0" + payload).encode("utf-8")).hexdigest()


def flag_families(flags: list[str]) -> list[str]:
    values = set(str(flag) for flag in flags or [])
    return [family for family, members in FLAG_FAMILIES.items() if values.intersection(members)]


def _parse_json(value: Any) -> Any:
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str) and value.strip():
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    return value


def _field_snapshot(row: dict[str, Any], price_column: str) -> dict[str, Any]:
    ai = _parse_json(row.get("ai_extraction"))
    if not isinstance(ai, dict):
        ai = {}
    return {
        "table": row.get("_table"),
        "typed_id": row.get("id"),
        "listing_index": row.get("listing_index", 0),
        "transaction_type": row.get("transaction_type"),
        "building_name": row.get("building_name"),
        "locality": row.get("locality_resolved"),
        "bhk": ai.get("bhk", row.get("bhk")),
        "price": row.get(price_column),
        "price_raw_text": row.get("price_raw_text") or ai.get("price_raw_text") or ai.get("price"),
        "area_sqft": row.get("carpet_area_sqft") or ai.get("carpet_area_sqft") or ai.get("area_sqft"),
        "furnishing_status": ai.get("furnishing_status") or ai.get("furnishing"),
        "source_slice": ai.get("source_slice"),
    }


def fetch_typed_candidates(storage, tenant_id: str | None, per_family: int) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for table, price_column in TABLES.items():
        select_fields = RESIDENTIAL_TYPED_FIELDS if table.startswith("residential_") else COMMON_TYPED_FIELDS
        base = storage.client.table(table).select(select_fields)
        if tenant_id:
            base = base.eq("tenant_id", tenant_id)
        # Pull a bounded sample for each family. The deterministic id order is
        # intentional; the seeded selection below removes ordering bias while
        # keeping the query bounded and repeatable for a given database state.
        for family, members in FLAG_FAMILIES.items():
            for flag in members:
                # The production REST adapter exposes raw PostgREST filters,
                # but not supabase-py's convenience ``contains`` method.
                query = base.filter("validation_flags", "cs", "{" + flag + "}").order("id", desc=False).limit(per_family)
                data = query.execute().data or []
                for raw in data:
                    row = dict(raw)
                    row["_table"] = table
                    row["_price_column"] = price_column
                    row["_flag_family"] = family
                    rows.append(row)
    return rows


def _safe_tenant_clause(tenant_id: str | None) -> str:
    if not tenant_id:
        return ""
    if not re.fullmatch(r"[0-9a-fA-F-]{8,64}", tenant_id):
        raise ValueError("tenant_id must be a UUID-like value")
    return " and tenant_id = '" + tenant_id + "'"


def management_query(project_ref: str, token: str, sql: str) -> list[dict[str, Any]]:
    """Run a read-only SQL query with a Supabase management token."""
    response = httpx.post(
        f"https://api.supabase.com/v1/projects/{project_ref}/database/query",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"query": sql},
        timeout=60.0,
    )
    response.raise_for_status()
    data = response.json()
    if not isinstance(data, list):
        raise RuntimeError("Supabase management query returned a non-list result")
    return [dict(row) for row in data if isinstance(row, dict)]


def fetch_typed_candidates_management(project_ref: str, token: str, tenant_id: str | None, per_family: int) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    tenant_clause = _safe_tenant_clause(tenant_id)
    all_flags = sorted({flag for members in FLAG_FAMILIES.values() for flag in members})
    flag_array = ",".join("'" + flag.replace("'", "''") + "'" for flag in all_flags)
    for table, price_column in TABLES.items():
        fields = [
            "id", "raw_message_id", "listing_index", "needs_review",
            "validation_flags", "ai_extraction", "building_name",
            "locality_resolved", "transaction_type", "price_raw_text",
            "carpet_area_sqft", "created_at", price_column,
        ]
        if table.startswith("residential_"):
            fields.append("bhk")
        projection = ", ".join(
            "'" + field + "', x." + field for field in dict.fromkeys(fields)
        )
        # One bounded query per typed table is materially faster than one
        # management request per individual flag. Python assigns overlapping
        # family labels after the rows are fetched.
        sql = (
            "select '" + table + "' as _table, '" + price_column + "' as _price_column, "
            "json_build_object(" + projection + ") as row from public." + table + " x where "
            "validation_flags ?| array[" + flag_array + "]"
            + tenant_clause + " order by id asc limit " + str(int(per_family * len(FLAG_FAMILIES)))
        )
        for item in management_query(project_ref, token, sql):
            row = dict(item.get("row") or {})
            row["_table"] = item.get("_table") or table
            row["_price_column"] = item.get("_price_column") or price_column
            rows.append(row)
    return rows


def fetch_raw_messages(storage, raw_ids: list[int], tenant_id: str | None) -> dict[int, dict[str, Any]]:
    result: dict[int, dict[str, Any]] = {}
    for start in range(0, len(raw_ids), 100):
        ids = raw_ids[start:start + 100]
        query = storage.client.table("raw_messages").select(
            "id,tenant_id,message,message_type,source,group_name,sender,timestamp,raw_payload"
        ).in_("id", ids)
        if tenant_id:
            query = query.eq("tenant_id", tenant_id)
        for row in query.execute().data or []:
            result[int(row["id"])] = dict(row)
    return result


def fetch_raw_messages_management(project_ref: str, token: str, raw_ids: list[int], tenant_id: str | None) -> dict[int, dict[str, Any]]:
    if not raw_ids:
        return {}
    ids = ",".join(str(int(raw_id)) for raw_id in raw_ids)
    rows = management_query(
        project_ref,
        token,
        "select id,tenant_id,message,message_type,source,group_name,sender,timestamp,raw_payload "
        "from public.raw_messages where id in (" + ids + ")" + _safe_tenant_clause(tenant_id),
    )
    return {int(row["id"]): row for row in rows if row.get("id") is not None}


def build_cases(rows: list[dict[str, Any]], raw_by_id: dict[int, dict[str, Any]], sample_size: int, seed: int) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    seen: set[str] = set()
    for row in rows:
        raw_id = row.get("raw_message_id")
        if raw_id is None or int(raw_id) not in raw_by_id:
            continue
        key = f"{int(raw_id)}:{int(row.get('listing_index') or 0)}"
        if key in seen:
            continue
        seen.add(key)
        flags = [str(flag) for flag in (row.get("validation_flags") or [])]
        family_labels = flag_families(flags)
        # A clean control stratum is useful for measuring regressions, but only
        # include it when explicitly requested by the caller's candidate pool.
        family = family_labels[0] if family_labels else "clean_or_other"
        grouped[family].append(row)

    rng = random.Random(seed)
    selected: list[dict[str, Any]] = []
    families = sorted(grouped)
    while len(selected) < sample_size and families:
        progressed = False
        for family in families:
            bucket = grouped[family]
            if not bucket:
                continue
            selected.append(bucket.pop(rng.randrange(len(bucket))))
            progressed = True
            if len(selected) >= sample_size:
                break
        if not progressed:
            break

    cases: list[dict[str, Any]] = []
    for row in selected:
        raw_id = int(row["raw_message_id"])
        raw = raw_by_id[raw_id]
        message = str(raw.get("message") or "")
        flags = [str(flag) for flag in (row.get("validation_flags") or [])]
        key = f"{raw_id}:{int(row.get('listing_index') or 0)}"
        cases.append({
            "case_id": key,
            "schema_version": SCHEMA_VERSION,
            "raw_message_id": raw_id,
            "listing_index": int(row.get("listing_index") or 0),
            "tenant_id": raw.get("tenant_id"),
            "source_hash": source_hash(message, raw.get("raw_payload")),
            "raw": {
                "message": message,
                "message_type": raw.get("message_type"),
                "source": raw.get("source"),
                "group_name": raw.get("group_name"),
                "timestamp": raw.get("timestamp"),
            },
            "format_families": format_families(message),
            "observed": {
                "flags": flags,
                "flag_families": flag_families(flags),
                "needs_review": bool(row.get("needs_review")),
                "fields": _field_snapshot(row, str(row.get("_price_column") or "")),
            },
            # Reviewers fill this without altering raw evidence or observed
            # output. Null means not yet reviewed, not “field absent”.
            "expected": None,
        })
    return cases


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sample-size", type=int, default=DEFAULT_SAMPLE_SIZE)
    parser.add_argument("--per-family", type=int, default=80)
    parser.add_argument("--seed", type=int, default=20260910)
    parser.add_argument("--tenant-id", help="Optional tenant scope; omit only for a deliberate cross-tenant audit")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not 1 <= args.sample_size <= MAX_SAMPLE_SIZE:
        parser.error(f"--sample-size must be between 1 and {MAX_SAMPLE_SIZE}")
    if not 1 <= args.per_family <= MAX_SAMPLE_SIZE:
        parser.error(f"--per-family must be between 1 and {MAX_SAMPLE_SIZE}")

    management_token = os.getenv("SUPABASE_MANAGEMENT_TOKEN", "").strip()
    project_ref = os.getenv("SUPABASE_PROJECT_REF", "").strip()
    if management_token and not project_ref:
        parser.error("SUPABASE_PROJECT_REF is required with SUPABASE_MANAGEMENT_TOKEN")
    if management_token:
        rows = fetch_typed_candidates_management(project_ref, management_token, args.tenant_id, args.per_family)
    else:
        storage = get_storage()
        rows = fetch_typed_candidates(storage, args.tenant_id, args.per_family)
    raw_ids = sorted({int(row["raw_message_id"]) for row in rows if row.get("raw_message_id") is not None})
    raw_by_id = (
        fetch_raw_messages_management(project_ref, management_token, raw_ids, args.tenant_id)
        if management_token
        else fetch_raw_messages(storage, raw_ids, args.tenant_id)
    )
    cases = build_cases(rows, raw_by_id, args.sample_size, args.seed)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as handle:
        for case in cases:
            handle.write(json.dumps(case, ensure_ascii=False, sort_keys=True) + "\n")

    counts = Counter(family for case in cases for family in case["observed"]["flag_families"])
    formats = Counter(label for case in cases for label in case["format_families"])
    print(json.dumps({
        "schema_version": SCHEMA_VERSION,
        "output": str(args.output),
        "cases": len(cases),
        "candidate_typed_rows": len(rows),
        "candidate_raw_messages": len(raw_ids),
        "flag_families": dict(sorted(counts.items())),
        "format_families": dict(sorted(formats.items())),
        "read_only": True,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
