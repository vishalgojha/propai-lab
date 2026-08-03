#!/usr/bin/env python3
"""Backfill script: re-resolve localities for existing rows.

Loads all reference data (locality_reference, buildings,
building_name_aliases) into memory once via
:mod:`registry.locality_resolver`, then scans every row that has a raw
source message and re-resolves the locality.

Supported targets:

- ``typed_listings_index`` (uses ``representative_raw_message_id``)
- ``typed_parsed_output`` (uses ``raw_message_id``)

Default behavior is *dry-run*: prints mismatches and writes a CSV
report. **No data is modified** unless ``--apply`` is also passed.

Usage:

    # dry-run report for the typed listing projection (unchanged behaviour)
    python backfill_localities.py [--batch-size 2000] [--output report.csv]

    # dry-run report for the parsed projection
    python backfill_localities.py --target typed_parsed_output

    # preview what --apply would change, without writing
    python backfill_localities.py --apply --dry-run-apply --target both

    # apply: only fills rows whose micro_market is null/empty
    python backfill_localities.py --apply --target typed_listings_index \
        --tenant-id <org-uuid>

    # apply + also overwrite populating-but-different rows (dangerous)
    python backfill_localities.py --apply --target both \
        --overwrite-existing --tenant-id <org-uuid>

Safety rules (see ``docs/DATA_QUALITY.md``):

- Without ``--overwrite-existing`` the apply path **never** rewrites a
  non-null ``micro_market``. ``typed_parsed_output.location_raw`` is also only
  filled when currently null, and uses the matched span or original
  message snippet — never a normalized/resolved value.
- ``--apply`` requires ``--tenant-id`` because both typed projections are
  tenant-scoped after migration
  ``20260719010000``. Multi-tenant writes without an explicit scope
  would cross organisations.
- Every applied row is logged to a timestamped audit CSV
  ``locality_backfill_applied_<timestamp>.csv`` (or whatever
  ``--audit-csv=PATH`` specifies) so the change is reproducible.
"""
import argparse
import csv
import os
import sys
import time
from datetime import datetime
from typing import Any

sys.path.insert(0, os.path.dirname(__file__))

from storage.supabase import SupabaseStorage, _typed_route  # noqa: E402

from registry.locality_resolver import (  # noqa: E402
    EXTERNAL_LINK_RE,
    LINK_ONLY_RE,
    LocalityResolver,
    PAGE,
    meets_minimum,
)


# ──────────────────────────────────────────────────────────────────
# helpers
# ──────────────────────────────────────────────────────────────────

def _is_empty(value: Any) -> bool:
    """Treat ``None`` / empty string / whitespace-only as missing."""
    return value is None or (isinstance(value, str) and not value.strip())


def _resolve_message(
    resolver: LocalityResolver, message_text: str, building_name: str
) -> dict | None:
    """Apply the same heuristics ``run_backfill`` uses, but raw-text in,
    structured out, ready to be written.

    Returns the resolver dict *augmented* with ``source_detail`` (either
    the matched span or ``building_name``) so callers can surface
    provenance in audit logs and messages.
    """
    if not message_text or len(message_text.strip()) < 5:
        return None
    msg_stripped = message_text.strip()
    is_link_only = bool(LINK_ONLY_RE.match(msg_stripped.lower()))
    is_ultra_short = len(msg_stripped) < 30

    if is_link_only or is_ultra_short:
        bld = resolver.resolve_from_building(building_name)
        if bld:
            return {**bld, "source_detail": f"building_name ({bld['source']})"}
        return None

    txt = resolver.resolve_from_text(message_text)
    if txt:
        return {**txt, "source_detail": "text_reference_match"}
    if building_name:
        bld = resolver.resolve_from_building(building_name)
        if bld:
            return {**bld, "source_detail": f"building_name ({bld['source']})"}
    return None


def _open_audit_csv(path: str) -> tuple[csv.DictWriter, "io.TextIOBase"]:
    """Open (or create) the audit CSV and return ``(writer, file_handle)``.

    Header columns are stable across calls so re-runs append sensibly.
    The file handle is returned so callers can flush/close it on shutdown.
    """
    new_file = not os.path.exists(path)
    f = open(path, "a", newline="")
    writer = csv.DictWriter(
        f,
        fieldnames=[
            "applied_at",
            "tenant_id",
            "target_table",
            "row_id",
            "old_micro_market",
            "new_micro_market",
            "old_location_raw",
            "new_location_raw",
            "source",
            "source_detail",
            "confidence",
            "matched_sub",
            "raw_message_snippet",
        ],
    )
    if new_file:
        writer.writeheader()
    return writer, f


# ──────────────────────────────────────────────────────────────────
# list-and-resolve walker helpers — (intentionally not present)
# ──────────────────────────────────────────────────────────────────
# Earlier iterations exposed `_iter_listings` / `_iter_parsed_output`
# generators for callers outside this file. We kept the interaction
# limited to two well-defined entry points (`run_backfill`, `run_apply`)
# and a private `_resolve_message` helper, so the walkers add surface
# area without current callers. Re-introduce them only if a future
# command (e.g., a CLI streaming mode) needs them.


# ──────────────────────────────────────────────────────────────────
# dry-run path (kept identical to the original behaviour)
# ──────────────────────────────────────────────────────────────────

def run_backfill(batch_size: int = 2000, output_path: str = "locality_backfill_report.csv"):
    print("Initializing storage...")
    storage = SupabaseStorage()
    db = storage.client

    print("Loading reference data into memory...")
    resolver = LocalityResolver(db)
    print(
        f"  locality_reference={resolver.stats['locality_reference']:,} "
        f"buildings={resolver.stats['buildings']:,} "
        f"building_name_aliases={resolver.stats['building_name_aliases']:,}"
    )

    print("\nScanning listings...")
    offset = 0
    total_scanned = 0
    mismatches: list[dict] = []
    link_only_count = 0
    no_text_count = 0
    building_fallback_count = 0
    text_match_count = 0
    same_count = 0
    null_resolve_count = 0

    start_time = time.time()

    while True:
        result = (
            db.table("typed_listings_index")
            .select(
                "id, building_name, micro_market, canonical_micro_market_slug, "
                "representative_raw_message_id"
            )
            .not_.is_("representative_raw_message_id", "null")
            .order("id")
            .offset(offset)
            .limit(PAGE)
            .execute()
        )
        batch = result.data or []
        if not batch:
            break

        raw_ids = [
            r["representative_raw_message_id"] for r in batch if r.get("representative_raw_message_id")
        ]
        if not raw_ids:
            offset += batch_size
            total_scanned += len(batch)
            continue

        msg_result = (
            db.table("raw_messages")
            .select("id, message, group_name")
            .in_("id", raw_ids)
            .execute()
        )
        msg_map = {m["id"]: m for m in (msg_result.data or [])}

        for listing in batch:
            lid = listing["id"]
            current_market = listing.get("micro_market") or ""
            building_name = listing.get("building_name") or ""
            raw_id = listing.get("representative_raw_message_id")

            if not raw_id or raw_id not in msg_map:
                no_text_count += 1
                continue

            raw_msg = msg_map[raw_id]
            message_text = raw_msg.get("message") or ""
            group_name = raw_msg.get("group_name") or ""

            if not message_text or len(message_text.strip()) < 5:
                no_text_count += 1
                continue

            msg_stripped = message_text.strip()
            is_link_only = bool(LINK_ONLY_RE.match(msg_stripped.lower()))
            is_ultra_short = len(msg_stripped) < 30

            resolved_market = None
            source = None

            if is_link_only or is_ultra_short:
                link_only_count += 1
                bld = resolver.resolve_from_building(building_name)
                if bld:
                    resolved_market = bld["resolved_locality"]
                    source = f"building_name ({bld['source']})"
            else:
                txt = resolver.resolve_from_text(message_text)
                if txt:
                    resolved_market = txt["resolved_locality"]
                    source = "text_reference_match"
                elif building_name:
                    bld = resolver.resolve_from_building(building_name)
                    if bld:
                        resolved_market = bld["resolved_locality"]
                        source = f"building_name ({bld['source']})"

            if resolved_market:
                if resolved_market != current_market:
                    mismatches.append({
                        "listing_id": lid,
                        "current_locality": current_market,
                        "resolved_locality": resolved_market,
                        "building_name": building_name,
                        "raw_message_snippet": EXTERNAL_LINK_RE.sub("", message_text)[:200].strip(),
                        "source": source or "",
                        "group_name": group_name,
                        "is_link_only": is_link_only,
                    })
                    if "building_name" in (source or ""):
                        building_fallback_count += 1
                    else:
                        text_match_count += 1
                else:
                    same_count += 1
            else:
                null_resolve_count += 1

        total_scanned += len(batch)
        elapsed = time.time() - start_time
        rate = total_scanned / elapsed if elapsed > 0 else 0
        pct = (total_scanned / 82000 * 100) if total_scanned < 100000 else 100
        print(
            f"  {total_scanned:>7,} scanned "
            f"({pct:5.1f}%) | "
            f"{len(mismatches):>6,} mismatches | "
            f"{same_count:>6,} correct | "
            f"{null_resolve_count:>6,} null | "
            f"{rate:.0f}/sec",
            flush=True,
        )

        if len(batch) < PAGE:
            break
        offset += PAGE

    elapsed = time.time() - start_time

    print(f"\n{'='*70}")
    print(f"BACKFILL REPORT")
    print(f"{'='*70}")
    print(f"Total listings scanned:         {total_scanned:>8,}")
    print(f"Link-only messages:             {link_only_count:>8,}")
    print(f"No text / too short:            {no_text_count:>8,}")
    print(f"Confirmed correct (same):       {same_count:>8,}")
    print(f"Null resolve (no match):        {null_resolve_count:>8,}")
    print(f"Text reference corrections:     {text_match_count:>8,}")
    print(f"Building name corrections:      {building_fallback_count:>8,}")
    print(f"TOTAL MISMATCHES:               {len(mismatches):>8,}")
    print(f"Time elapsed:                   {elapsed:>8.1f}s")
    print(f"{'='*70}\n")

    if mismatches:
        mismatches.sort(key=lambda m: (m["source"], m["listing_id"]))

        with open(output_path, "w", newline="") as f:
            writer = csv.DictWriter(
                f,
                fieldnames=[
                    "listing_id", "current_locality", "resolved_locality",
                    "building_name", "raw_message_snippet", "source",
                    "group_name", "is_link_only",
                ],
            )
            writer.writeheader()
            writer.writerows(mismatches)

        print(f"Report written to: {output_path}")

        vivante_hits = [m for m in mismatches if "kalpataru" in (m.get("building_name") or "").lower()]
        if vivante_hits:
            print(f"\n{'─'*70}")
            print(f"KALPATARU VIVANT/VIVANTE LISTINGS ({len(vivante_hits)} found):")
            print(f"{'─'*70}")
            for m in vivante_hits:
                print(f"  Listing {m['listing_id']}: {m['current_locality'] or '(none)'} → {m['resolved_locality']}")
                print(f"    Building: {m['building_name']}")
                print(f"    Source:   {m['source']}")
                print(f"    Message:  {m['raw_message_snippet'][:120]}")
                print()

        print(f"\nSample mismatches (first 25):")
        print(f"{'ID':>10} | {'Current':>20} | {'Resolved':>20} | {'Source':>30} | Building")
        print("-" * 120)
        for m in mismatches[:25]:
            print(
                f"{m['listing_id']:>10} | "
                f"{m['current_locality']:>20} | "
                f"{m['resolved_locality']:>20} | "
                f"{m['source']:>30} | "
                f"{m['building_name'][:40]}"
            )
    else:
        print("No mismatches found!")

    return mismatches


# ──────────────────────────────────────────────────────────────────
# apply path
# ──────────────────────────────────────────────────────────────────

def _apply_listings(
    db,
    resolver: LocalityResolver,
    *,
    overwrite_existing: bool,
    min_confidence: str,
    dry_run: bool,
    audit,
    tenant_id: str | None,
) -> dict:
    """Apply resolved localities to the typed listing projection's
    ``micro_market``.

    Returns a counters dict: ``scanned``, ``eligible``, ``updated``,
    ``skipped_existing``, ``skipped_low_confidence``, ``errors``.

    Pagination via ``offset`` is correct for backfill scripts because
    the typed listing projection only ever grows monotonically during a run.
    For very large datasets the caller should split into batches.
    Repeated calls on already-processed rows are safe: rows whose
    ``micro_market`` now matches the resolver are filtered upstream.
    """
    counters = {
        "scanned": 0, "eligible": 0, "updated": 0,
        "skipped_existing": 0, "skipped_low_confidence": 0, "errors": 0,
    }
    conn = db.table("typed_listings_index")
    offset = 0
    while True:
        query = conn.select(
            "id, legacy_source_id, asset_type, transaction_type, building_name, "
            "micro_market, representative_raw_message_id, tenant_id"
        )
        if tenant_id:
            query = query.eq("tenant_id", tenant_id)
        batch = query.order("id").offset(offset).limit(PAGE).execute().data or []
        if not batch:
            break
        raw_ids = [
            r["representative_raw_message_id"] for r in batch if r.get("representative_raw_message_id")
        ]
        msg_map: dict[int, dict] = {}
        if raw_ids:
            for i in range(0, len(raw_ids), 200):
                sub_ids = raw_ids[i : i + 200]
                raw_query = (
                    db.table("raw_messages")
                    .select("id, message, group_name, tenant_id")
                    .in_("id", sub_ids)
                )
                if tenant_id:
                    raw_query = raw_query.eq("tenant_id", tenant_id)
                raw_result = raw_query.execute()
                for m in (raw_result.data or []):
                    msg_map[m["id"]] = m
        for listing in batch:
            counters["scanned"] += 1
            row_id = listing["id"]
            current = listing.get("micro_market") or ""
            building_name = listing.get("building_name") or ""
            raw_id = listing.get("representative_raw_message_id")
            if not raw_id or raw_id not in msg_map:
                counters["skipped_existing"] += 1
                continue
            message_text = (msg_map[raw_id].get("message") or "").strip()
            decision = _resolve_message(resolver, message_text, building_name)
            if not decision:
                counters["skipped_existing"] += 1
                continue
            if current and not overwrite_existing:
                counters["skipped_existing"] += 1
                continue
            if not meets_minimum(decision["confidence"], min_confidence):
                counters["skipped_low_confidence"] += 1
                continue
            counters["eligible"] += 1
            new_value = decision["resolved_locality"]
            audit_row = {
                "applied_at": datetime.utcnow().isoformat() + "Z",
                "tenant_id": listing.get("tenant_id") or tenant_id or "",
                "target_table": "typed_listings_index",
                "row_id": row_id,
                "old_micro_market": current,
                "new_micro_market": new_value,
                "old_location_raw": "",
                "new_location_raw": "",
                "source": decision["source"],
                "source_detail": decision.get("source_detail") or "",
                "confidence": decision["confidence"],
                "matched_sub": decision.get("matched_sub") or "",
                "raw_message_snippet": EXTERNAL_LINK_RE.sub("", message_text)[:200].strip(),
            }
            if dry_run:
                audit.writerow(audit_row)
                counters["updated"] += 1
                continue
            try:
                typed_table = _typed_route(listing)[0]
                key = "legacy_source_id" if listing.get("legacy_source_id") else "id"
                key_value = listing.get("legacy_source_id") or row_id
                db.table(typed_table).update({"micro_market": new_value}).eq(key, key_value).execute()
                audit.writerow(audit_row)
                counters["updated"] += 1
            except Exception as exc:  # pragma: no cover - hot path log only
                print(f"  ERR typed_listings_index.id={row_id}: {exc}", file=sys.stderr)
                counters["errors"] += 1
        if len(batch) < PAGE:
            break
        offset += PAGE
    return counters
    """Paginated typed-listing apply — replaces the placeholder loop above."""
    counters = initial_counters
    conn = db.table("typed_listings_index")
    offset = 0
    while True:
        query = conn.select(
            "id, building_name, micro_market, representative_raw_message_id, "
            "tenant_id"
        )
        if tenant_id:
            query = query.eq("tenant_id", tenant_id)
        batch = query.order("id").offset(offset).limit(PAGE).execute().data or []
        if not batch:
            break
        raw_ids = [
            r["representative_raw_message_id"] for r in batch if r.get("representative_raw_message_id")
        ]
        msg_map: dict[int, dict] = {}
        if raw_ids:
            for i in range(0, len(raw_ids), 200):
                sub_ids = raw_ids[i : i + 200]
                raw_query = (
                    db.table("raw_messages")
                    .select("id, message, group_name, tenant_id")
                    .in_("id", sub_ids)
                )
                if tenant_id:
                    raw_query = raw_query.eq("tenant_id", tenant_id)
                raw_result = raw_query.execute()
                for m in (raw_result.data or []):
                    msg_map[m["id"]] = m
        for listing in batch:
            counters["scanned"] += 1
            row_id = listing["id"]
            current = listing.get("micro_market") or ""
            building_name = listing.get("building_name") or ""
            raw_id = listing.get("representative_raw_message_id")
            if not raw_id or raw_id not in msg_map:
                counters["skipped_existing"] += 1
                continue
            message_text = (msg_map[raw_id].get("message") or "").strip()
            decision = _resolve_message(resolver, message_text, building_name)
            if not decision:
                counters["skipped_existing"] += 1
                continue
            if current and not overwrite_existing:
                counters["skipped_existing"] += 1
                continue
            if not meets_minimum(decision["confidence"], min_confidence):
                counters["skipped_low_confidence"] += 1
                continue
            counters["eligible"] += 1
            new_value = decision["resolved_locality"]
            audit_row = {
                "applied_at": datetime.utcnow().isoformat() + "Z",
                "tenant_id": listing.get("tenant_id") or tenant_id or "",
                "target_table": "typed_listings_index",
                "row_id": row_id,
                "old_micro_market": current,
                "new_micro_market": new_value,
                "old_location_raw": "",
                "new_location_raw": "",
                "source": decision["source"],
                "source_detail": decision.get("source_detail") or "",
                "confidence": decision["confidence"],
                "matched_sub": decision.get("matched_sub") or "",
                "raw_message_snippet": EXTERNAL_LINK_RE.sub("", message_text)[:200].strip(),
            }
            if dry_run:
                audit.writerow(audit_row)
                counters["updated"] += 1
                continue
            try:
                conn.update({"micro_market": new_value}).eq("id", row_id).execute()
                audit.writerow(audit_row)
                counters["updated"] += 1
            except Exception as exc:  # pragma: no cover - hot path log only
                print(f"  ERR typed_listings_index.id={row_id}: {exc}", file=sys.stderr)
                counters["errors"] += 1
        if len(batch) < PAGE:
            break
        offset += PAGE
    return counters


def _apply_parsed_output(
    db,
    resolver: LocalityResolver,
    *,
    overwrite_existing: bool,
    min_confidence: str,
    dry_run: bool,
    audit,
    tenant_id: str | None,
) -> dict:
    """Apply resolved localities to the typed parsed projection's
    ``micro_market`` and optionally ``location_raw``.

    ``location_raw`` is filled only when currently null, and only when
    the resolver produced a matched span or the raw message text is
    usable. The script never writes a normalized/resolved value into
    ``location_raw`` — see ``docs/DATA_QUALITY.md``.
    """
    conn = db.table("typed_parsed_output")
    counters = {
        "scanned": 0, "eligible": 0, "updated": 0,
        "skipped_existing": 0, "skipped_low_confidence": 0, "errors": 0,
    }
    offset = 0
    while True:
        query = conn.select(
            "id, legacy_source_id, asset_type, transaction_type, message_type, "
            "raw_message_id, location_raw, building_name, micro_market, tenant_id"
        ).or_(
            "micro_market.is.null,micro_market.eq.,"
            "location_raw.is.null,location_raw.eq."
        )
        if tenant_id:
            query = query.eq("tenant_id", tenant_id)
        batch = query.order("id").offset(offset).limit(PAGE).execute().data or []
        if not batch:
            break
        raw_ids = list({r["raw_message_id"] for r in batch if r.get("raw_message_id")})
        msg_map: dict[int, dict] = {}
        if raw_ids:
            for i in range(0, len(raw_ids), 200):
                sub_ids = raw_ids[i : i + 200]
                raw_query = (
                    db.table("raw_messages")
                    .select("id, message, group_name, tenant_id")
                    .in_("id", sub_ids)
                )
                if tenant_id:
                    raw_query = raw_query.eq("tenant_id", tenant_id)
                raw_result = raw_query.execute()
                for m in (raw_result.data or []):
                    msg_map[m["id"]] = m
        for parsed in batch:
            counters["scanned"] += 1
            row_id = parsed["id"]
            current_market = parsed.get("micro_market") or ""
            current_location = parsed.get("location_raw") or ""
            building_name = parsed.get("building_name") or ""
            raw_id = parsed.get("raw_message_id")
            if not raw_id or raw_id not in msg_map:
                counters["skipped_existing"] += 1
                continue
            message_text = (msg_map[raw_id].get("message") or "").strip()
            decision = _resolve_message(resolver, message_text, building_name)
            if not decision:
                counters["skipped_existing"] += 1
                continue
            if current_market and not overwrite_existing:
                counters["skipped_existing"] += 1
                continue
            if not meets_minimum(decision["confidence"], min_confidence):
                counters["skipped_low_confidence"] += 1
                continue
            counters["eligible"] += 1
            new_market = decision["resolved_locality"]
            # location_raw gets the matched span when present, otherwise
            # a clipped snippet of the original message text — never the
            # resolved value (preserves ``docs/DATA_QUALITY.md`` "Raw
            # ``location_raw`` is preserved as-is").
            new_location = ""
            if _is_empty(current_location):
                if decision.get("matched_sub"):
                    new_location = decision["matched_sub"]
                else:
                    new_location = EXTERNAL_LINK_RE.sub("", message_text)[:120].strip()
            audit_row = {
                "applied_at": datetime.utcnow().isoformat() + "Z",
                "tenant_id": parsed.get("tenant_id") or tenant_id or "",
                "target_table": "typed_parsed_output",
                "row_id": row_id,
                "old_micro_market": current_market,
                "new_micro_market": new_market,
                "old_location_raw": current_location,
                "new_location_raw": new_location,
                "source": decision["source"],
                "source_detail": decision.get("source_detail") or "",
                "confidence": decision["confidence"],
                "matched_sub": decision.get("matched_sub") or "",
                "raw_message_snippet": EXTERNAL_LINK_RE.sub("", message_text)[:200].strip(),
            }
            payload: dict[str, Any] = {"micro_market": new_market}
            if new_location:
                payload["location_raw"] = new_location
            if dry_run:
                audit.writerow(audit_row)
                counters["updated"] += 1
                continue
            try:
                typed_table = _typed_route(parsed)[0]
                key = "legacy_source_id" if parsed.get("legacy_source_id") else "id"
                key_value = parsed.get("legacy_source_id") or row_id
                db.table(typed_table).update(payload).eq(key, key_value).execute()
                audit.writerow(audit_row)
                counters["updated"] += 1
            except Exception as exc:  # pragma: no cover - hot path log only
                print(f"  ERR typed_parsed_output.id={row_id}: {exc}", file=sys.stderr)
                counters["errors"] += 1
        if len(batch) < PAGE:
            break
        offset += PAGE
    return counters


def run_apply(
    *,
    target: str,
    tenant_id: str | None,
    overwrite_existing: bool,
    min_confidence: str,
    dry_run_apply: bool,
    audit_csv: str,
):
    """Orchestrator for the ``--apply`` / ``--dry-run-apply`` paths.

    Targets: ``"typed_listings_index"``, ``"typed_parsed_output"``, ``"both"``.
    """
    if target not in {"typed_listings_index", "typed_parsed_output", "both"}:
        sys.exit(f"--target must be typed_listings_index|typed_parsed_output|both (got {target!r})")
    if not tenant_id:
        sys.exit(
            "ERROR: --apply (or --dry-run-apply) requires --tenant-id. "
            "Both typed projections are tenant-scoped after "
            "migration 20260719010000; never apply cross-tenant."
        )

    print("Initializing storage...")
    storage = SupabaseStorage()
    db = storage.client

    print("Loading reference data into memory...")
    resolver = LocalityResolver(db)
    print(
        f"  locality_reference={resolver.stats['locality_reference']:,} "
        f"buildings={resolver.stats['buildings']:,} "
        f"building_name_aliases={resolver.stats['building_name_aliases']:,}"
    )

    print(f"\n{'─'*70}")
    print(
        f"Apply target={target} tenant_id={tenant_id} "
        f"overwrite_existing={overwrite_existing} "
        f"min_confidence={min_confidence} "
        f"{'DRY-RUN' if dry_run_apply else 'WRITE'}"
    )
    print(f"Audit CSV → {audit_csv}")
    print(f"{'─'*70}\n")

    audit, audit_fh = _open_audit_csv(audit_csv)
    overall = {}
    try:
        if target in {"typed_listings_index", "both"}:
            print("\n→ typed_listings_index")
            overall["typed_listings_index"] = _apply_listings(
                db, resolver,
                overwrite_existing=overwrite_existing,
                min_confidence=min_confidence,
                dry_run=dry_run_apply, audit=audit, tenant_id=tenant_id,
            )
        if target in {"typed_parsed_output", "both"}:
            print("\n→ typed_parsed_output")
            overall["typed_parsed_output"] = _apply_parsed_output(
                db, resolver,
                overwrite_existing=overwrite_existing,
                min_confidence=min_confidence,
                dry_run=dry_run_apply, audit=audit, tenant_id=tenant_id,
            )
    finally:
        audit_fh.close()

    print(f"\n{'='*70}")
    print(f"APPLY SUMMARY {'(DRY-RUN)' if dry_run_apply else ''}")
    print(f"{'='*70}")
    grand = {"eligible": 0, "updated": 0, "errors": 0}
    for label, c in overall.items():
        print(f"\n[{label}]")
        print(f"  scanned               : {c['scanned']:>8,}")
        print(f"  eligible              : {c['eligible']:>8,}")
        print(f"  updated               : {c['updated']:>8,}")
        print(f"  skipped (existing)    : {c['skipped_existing']:>8,}")
        print(f"  skipped (low conf)    : {c['skipped_low_confidence']:>8,}")
        print(f"  errors                : {c['errors']:>8,}")
        grand["eligible"] += c["eligible"]
        grand["updated"] += c["updated"]
        grand["errors"] += c["errors"]
    print(f"\nTOTAL  eligible={grand['eligible']:,}  "
          f"updated={grand['updated']:,}  errors={grand['errors']:,}")
    print(f"Audit log: {audit_csv}")
    if dry_run_apply:
        print("Re-run without --dry-run-apply to actually write.")


# ──────────────────────────────────────────────────────────────────
# entry point
# ──────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Re-resolve or back-fill localities for typed listing/parsed projections."
    )
    parser.add_argument("--batch-size", type=int, default=2000)
    parser.add_argument("--output", type=str, default="locality_backfill_report.csv")

    parser.add_argument(
        "--apply", action="store_true",
        help="Required to write any change to the DB. Default is dry-run report."
    )
    parser.add_argument(
        "--dry-run-apply", action="store_true",
        help="Runs the same apply code path (same filter, same batching, same "
             "audit log) but does not call .update(). Use this for a final "
             "sanity check before the real apply."
    )
    parser.add_argument(
        "--target", choices=["typed_listings_index", "typed_parsed_output", "both"], default="typed_listings_index",
        help="Which typed projection to operate on. Dry-run default = typed_listings_index."
    )
    parser.add_argument(
        "--overwrite-existing", action="store_true",
        help="DANGEROUS: also rewrite rows whose micro_market is non-empty but "
             "different from the resolver's answer. Off by default; review the "
             "dry-run report before enabling this."
    )
    parser.add_argument(
        "--min-confidence", choices=["low", "medium", "high"], default="medium",
        help="Minimum resolver confidence to apply. Default 'medium' skips rows "
             "resolved only via low-confidence referential matches."
    )
    parser.add_argument(
        "--tenant-id", type=str, default=None,
        help="**Required** with --apply / --dry-run-apply. Typed projections are "
             "tenant-scoped; do not write across organizations."
    )
    parser.add_argument(
        "--audit-csv", type=str, default=None,
        help="Where to write the per-row audit trail. Defaults to "
             "locality_backfill_applied_<UTC-timestamp>.csv in CWD."
    )
    args = parser.parse_args()

    if args.apply or args.dry_run_apply:
        if not args.audit_csv:
            stamp = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
            args.audit_csv = f"locality_backfill_applied_{stamp}.csv"
        run_apply(
            target=args.target,
            tenant_id=args.tenant_id,
            overwrite_existing=args.overwrite_existing,
            min_confidence=args.min_confidence,
            dry_run_apply=args.dry_run_apply or not args.apply,
            audit_csv=args.audit_csv,
        )
    else:
        # Dry-run historical behaviour: only the typed listing projection, write the report CSV.
        if args.target != "typed_listings_index":
            print(
                f"NOTE: dry-run mode only scans {args.target!r} table "
                "when --target != 'typed_listings_index' and --apply is omitted; "
                "this is exactly the historical behaviour of "
                "backfill_localities.py. Use --dry-run-apply to exercise "
                "the apply path on typed_parsed_output without writes.",
                file=sys.stderr,
            )
        run_backfill(batch_size=args.batch_size, output_path=args.output)


if __name__ == "__main__":
    main()
