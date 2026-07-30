#!/usr/bin/env python3
"""Backfill script: re-resolve localities for existing listings.

Loads all reference data (locality_reference, buildings,
building_name_aliases) into memory once, then scans every listing that
has a raw source message and re-resolves the locality. Outputs a CSV
report of mismatches.

NO data is modified — this script is read-only. Review the output
before applying any corrections.

Usage:
    python backfill_localities.py [--batch-size 2000] [--output report.csv]
"""

import argparse
import csv
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))

from storage.supabase import SupabaseStorage  # noqa: E402


LINK_ONLY_RE = re.compile(r"^https?://\S+$")
EXTERNAL_LINK_RE = re.compile(
    r"https?://(?:www\.)?(?:youtube\.com|youtu\.be|instagram\.com|facebook\.com|"
    r"fb\.com|twitter\.com|x\.com|t\.co|tiktok\.com|linkedin\.com)/\S*"
)
PAGE = 1000  # PostgREST default max-rows


def _fetch_all(db, table, columns, filters=None):
    """Fetch all rows from a table, paginating through PostgREST's 1000-row limit."""
    all_rows = []
    offset = 0
    while True:
        q = db.table(table).select(columns)
        if filters:
            for col, op, val in filters:
                if op == "not.is":
                    q = q.not_.is_(col, val)
                elif op == "neq":
                    q = q.neq(col, val)
        q = q.order("id").offset(offset).limit(PAGE)
        res = q.execute()
        rows = res.data or []
        all_rows.extend(rows)
        if len(rows) < PAGE:
            break
        offset += PAGE
    return all_rows


LINK_ONLY_RE = re.compile(r"^https?://\S+$")
EXTERNAL_LINK_RE = re.compile(
    r"https?://(?:www\.)?(?:youtube\.com|youtu\.be|instagram\.com|facebook\.com|"
    r"fb\.com|twitter\.com|x\.com|t\.co|tiktok\.com|linkedin\.com)/\S*"
)


class LocalityResolver:
    """In-memory locality resolver. Pre-loads all reference data."""

    def __init__(self, db):
        self.db = db

        # locality_reference → text matching (small, < 1000 rows)
        print("  Loading locality_reference...", flush=True)
        res = db.table("locality_reference").select(
            "sub_locality, parent_locality, confidence"
        ).limit(PAGE).execute()
        self.loc_ref = res.data or []
        self.loc_ref_by_sub = {}
        for row in self.loc_ref:
            sub = (row.get("sub_locality") or "").strip()
            if sub:
                self.loc_ref_by_sub[sub.lower()] = row
        print(f"    {len(self.loc_ref)} rows, {len(self.loc_ref_by_sub)} unique sub_locality keys")

        # buildings → micro_market lookup (may exceed 1000 rows)
        print("  Loading buildings...", flush=True)
        self.buildings = _fetch_all(
            db, "buildings", "canonical_name, micro_market",
            filters=[("micro_market", "not.is", "null"), ("micro_market", "neq", "")],
        )
        self.building_map = {}
        for row in self.buildings:
            name = (row.get("canonical_name") or "").strip()
            market = (row.get("micro_market") or "").strip()
            if name and market:
                self.building_map[name.lower()] = market
        print(f"    {len(self.buildings)} rows, {len(self.building_map)} with micro_market")

        # building_name_aliases → alias → canonical → buildings lookup
        print("  Loading building_name_aliases...", flush=True)
        self.aliases = _fetch_all(
            db, "building_name_aliases", "alias, canonical_name",
        )
        self.alias_map = {}
        for row in self.aliases:
            alias = (row.get("alias") or "").strip()
            canonical = (row.get("canonical_name") or "").strip()
            if alias and canonical:
                self.alias_map[alias.lower()] = canonical.lower()
        print(f"    {len(self.aliases)} rows, {len(self.alias_map)} unique aliases")

    def resolve_from_text(self, text: str) -> dict | None:
        """Find a locality mentioned in raw message text."""
        if not text or len(text.strip()) < 5:
            return None

        cleaned = EXTERNAL_LINK_RE.sub("", text).strip()
        if not cleaned:
            return None

        text_lower = cleaned.lower()
        # Check each known sub-locality against the text
        for sub_lower, row in self.loc_ref_by_sub.items():
            if len(sub_lower) >= 4 and sub_lower in text_lower:
                return {
                    "resolved_locality": row["parent_locality"],
                    "confidence": row.get("confidence") or "medium",
                    "source": "text_reference_match",
                }
        return None

    def resolve_from_building(self, building_name: str) -> dict | None:
        """Look up a building's known locality from buildings / aliases."""
        if not building_name or not building_name.strip():
            return None

        name = building_name.strip().lower()

        # Direct match in buildings table
        market = self.building_map.get(name)
        if market:
            return {
                "resolved_locality": market,
                "confidence": "high",
                "source": "buildings_table",
            }

        # Alias lookup → canonical → buildings
        canonical = self.alias_map.get(name)
        if canonical:
            market = self.building_map.get(canonical)
            if market:
                return {
                    "resolved_locality": market,
                    "confidence": "medium",
                    "source": "building_name_aliases",
                }

        return None


def run_backfill(batch_size: int = 2000, output_path: str = "locality_backfill_report.csv"):
    print("Initializing storage...")
    storage = SupabaseStorage()
    db = storage.client

    print("Loading reference data into memory...")
    resolver = LocalityResolver(db)

    print("\nScanning listings...")
    offset = 0
    total_scanned = 0
    mismatches = []
    link_only_count = 0
    no_text_count = 0
    building_fallback_count = 0
    text_match_count = 0
    same_count = 0
    null_resolve_count = 0

    start_time = time.time()

    while True:
        result = db.table("listings").select(
            "id, building_name, micro_market, canonical_micro_market_slug, "
            "representative_raw_message_id"
        ).not_.is_(
            "representative_raw_message_id", "null"
        ).order("id").offset(offset).limit(PAGE).execute()

        batch = result.data or []
        if not batch:
            break

        raw_ids = [r["representative_raw_message_id"] for r in batch if r.get("representative_raw_message_id")]
        if not raw_ids:
            offset += batch_size
            total_scanned += len(batch)
            continue

        msg_result = db.table("raw_messages").select(
            "id, message, group_name"
        ).in_("id", raw_ids).execute()

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
                # Only try building-name lookup
                bld = resolver.resolve_from_building(building_name)
                if bld:
                    resolved_market = bld["resolved_locality"]
                    source = f"building_name ({bld['source']})"
            else:
                # Try text match first
                txt = resolver.resolve_from_text(message_text)
                if txt:
                    resolved_market = txt["resolved_locality"]
                    source = "text_reference_match"
                elif building_name:
                    # Fallback to building-name lookup
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

    # ── Summary ───────────────────────────────────────────────────────
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
            writer = csv.DictWriter(f, fieldnames=[
                "listing_id", "current_locality", "resolved_locality",
                "building_name", "raw_message_snippet", "source",
                "group_name", "is_link_only",
            ])
            writer.writeheader()
            writer.writerows(mismatches)

        print(f"Report written to: {output_path}")

        # ── Kalpataru Vivant/Vivante check ────────────────────────────
        vivante_hits = [m for m in mismatches if "kalpataru" in (m["building_name"] or "").lower()]
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

        # ── Sample mismatches ─────────────────────────────────────────
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


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Backfill localities from raw messages")
    parser.add_argument("--batch-size", type=int, default=2000, help="Batch size for DB queries")
    parser.add_argument("--output", type=str, default="locality_backfill_report.csv", help="Output CSV path")
    args = parser.parse_args()

    run_backfill(batch_size=args.batch_size, output_path=args.output)
