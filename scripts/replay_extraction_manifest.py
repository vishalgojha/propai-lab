#!/usr/bin/env python3
"""Apply an explicitly approved extraction replay manifest.

The command is dry-run by default. ``--apply`` verifies that every selected
raw message still has the same source hash as the manifest, then resets only
those raw IDs onto the normal extraction queue. It never deletes typed rows or
touches unrelated backlog rows.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any

import httpx

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.build_extraction_replay_corpus import source_hash

MAX_CASES = 1000


def management_query(project_ref: str, token: str, sql: str) -> list[dict[str, Any]]:
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


def load_manifest(path: Path) -> list[dict[str, Any]]:
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    if not rows or len(rows) > MAX_CASES:
        raise ValueError(f"manifest must contain 1-{MAX_CASES} cases")
    ids = [int(row["raw_message_id"]) for row in rows]
    if len({row["case_id"] for row in rows}) != len(rows):
        raise ValueError("manifest contains duplicate case_id values")
    if any(int(row.get("raw_message_id") or 0) <= 0 or not row.get("source_hash") for row in rows):
        raise ValueError("every case requires a positive raw_message_id and source_hash")
    return rows


def ids_sql(ids: list[int]) -> str:
    return ",".join(str(int(value)) for value in sorted(set(ids)))


def verify_source_hashes(project_ref: str, token: str, cases: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    ids = [int(case["raw_message_id"]) for case in cases]
    rows = management_query(
        project_ref,
        token,
        "select id,tenant_id,message,raw_payload,processed,processed_at,extraction_attempts,extraction_outcome "
        "from public.raw_messages where id in (" + ids_sql(ids) + ")",
    )
    current = {int(row["id"]): row for row in rows}
    if set(current) != set(ids):
        missing = sorted(set(ids) - set(current))
        raise RuntimeError(f"raw messages missing from production: {missing[:10]}")
    bad: list[int] = []
    for case in cases:
        raw_id = int(case["raw_message_id"])
        row = current[raw_id]
        if source_hash(str(row.get("message") or ""), row.get("raw_payload")) != case["source_hash"]:
            bad.append(raw_id)
    if bad:
        raise RuntimeError(f"source changed since manifest creation for raw IDs: {sorted(set(bad))[:10]}")
    return current


def apply_reset(project_ref: str, token: str, raw_ids: list[int]) -> list[int]:
    return [int(row["id"]) for row in management_query(
        project_ref,
        token,
        "update public.raw_messages set processed = false, processed_at = null, "
        "extraction_attempts = 0, extraction_outcome = null, extraction_last_error = null, "
        "extraction_suppressed = false where id in (" + ids_sql(raw_ids) + ") returning id",
    )]


def status_snapshot(project_ref: str, token: str, raw_ids: list[int]) -> list[dict[str, Any]]:
    return management_query(
        project_ref,
        token,
        "select processed,coalesce(extraction_outcome,'') as extraction_outcome,count(*)::int as n "
        "from public.raw_messages where id in (" + ids_sql(raw_ids) + ") "
        "group by processed,extraction_outcome order by processed,extraction_outcome",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--wait-seconds", type=int, default=0, help="Poll selected rows after apply")
    args = parser.parse_args()
    token = os.getenv("SUPABASE_MANAGEMENT_TOKEN", "").strip()
    project_ref = os.getenv("SUPABASE_PROJECT_REF", "").strip()
    if not token or not project_ref:
        parser.error("SUPABASE_MANAGEMENT_TOKEN and SUPABASE_PROJECT_REF are required")
    cases = load_manifest(args.manifest)
    current = verify_source_hashes(project_ref, token, cases)
    raw_ids = sorted(current)
    print(json.dumps({
        "cases": len(cases),
        "unique_raw_messages": len(raw_ids),
        "tenants": dict(Counter(str(row.get("tenant_id")) for row in current.values())),
        "already_processed": sum(bool(row.get("processed")) for row in current.values()),
        "source_hashes_verified": True,
        "mode": "apply" if args.apply else "dry_run",
        "read_only": not args.apply,
    }, indent=2))
    if not args.apply:
        return 0
    changed = apply_reset(project_ref, token, raw_ids)
    if len(changed) != len(raw_ids):
        raise RuntimeError(f"reset {len(changed)} rows; expected {len(raw_ids)}")
    print(json.dumps({"reset_rows": len(changed), "queue": "normal extraction worker"}))
    deadline = time.monotonic() + max(0, min(args.wait_seconds, 1800))
    while time.monotonic() < deadline:
        snapshot = status_snapshot(project_ref, token, raw_ids)
        print(json.dumps({"status": snapshot}))
        if all(bool(row.get("processed")) for row in management_query(
            project_ref, token,
            "select processed from public.raw_messages where id in (" + ids_sql(raw_ids) + ")"
        )):
            break
        time.sleep(10)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
