#!/usr/bin/env python3
"""Backfill canonical_micro_market_slug on listings and buildings tables.

Reads every row's micro_market, applies the canonical locality mapping
(from locality-canon.ts), and writes the computed slug back.

Run once after the migration adds the column:
    python scripts/backfill_canonical_slugs.py

Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.
"""

import os
import re
import sys
import time

from supabase import create_client

# ── Canonical locality mapping (mirrors apps/www/src/lib/locality-canon.ts) ──

HIDDEN_BUCKETS = {
    "western suburbs prime",
    "south mumbai central",
    "eastern suburbs",
    "central suburbs",
    "mumbai suburbs",
    "western line",
    "central line",
    "harbour line",
}

GENERIC_PARENTS = {
    "andheri",
    "dadar",
    "thane",
    "malad",
    "goregaon",
    "vile parle",
    "kandivali",
    "borivali",
}

IMPLIED_DIRECTION = {
    "bandra": "Bandra West",
    "khar": "Khar West",
    "santacruz": "Santacruz West",
    "scuz": "Santacruz West",
}

REDIRECTS = {
    "bandra bkc": "Bandra East",
    "bandra bkc east": "Bandra East",
    "bandra east bkc": "Bandra East",
    "bkc": "Bandra Kurla Complex",
    "pali hill": "Bandra West",
    "mount mary": "Bandra West",
    "turner road": "Bandra West",
    "lokhandwala": "Andheri West",
    "versova": "Andheri West",
    "oshiwara": "Andheri West",
    "dn nagar": "Andheri West",
    "marol": "Andheri East",
    "sakinaka": "Andheri East",
    "chandivali": "Andheri East",
    "juhu scheme": "Juhu",
    "hiranandani estate": "Thane West",
    "wagle estate, thane": "Thane West",
    "kasarvadavali": "Thane West",
    "kasarvadavli": "Thane West",
    "kapurbawdi": "Thane West",
    "ghodbunder road, thane": "Thane West",
    "mahajanwadi, thane": "Thane West",
    "mahim west": "Mahim",
    "matunga east": "Matunga",
    "wadala west": "Wadala",
    "vile parle east": "Vile Parle East",
    "parle east": "Vile Parle East",
}

STANDALONE_LOCALITIES = {
    "andheri east": "Andheri East",
    "andheri west": "Andheri West",
    "ambernath": "Ambernath",
    "agripada": "Agripada",
    "badlapur": "Badlapur",
    "bandra east": "Bandra East",
    "bandra kurla complex": "Bandra Kurla Complex",
    "bandra west": "Bandra West",
    "bhandup": "Bhandup",
    "bhayandar": "Bhayandar",
    "borivali east": "Borivali East",
    "borivali west": "Borivali West",
    "byculla": "Byculla",
    "chembur": "Chembur",
    "churchgate": "Churchgate",
    "chowpatty": "Chowpatty",
    "colaba": "Colaba",
    "cuffe parade": "Cuffe Parade",
    "dahisar": "Dahisar",
    "dadar east": "Dadar East",
    "dadar west": "Dadar West",
    "dombivli": "Dombivli",
    "fort": "Fort",
    "ghatkopar east": "Ghatkopar East",
    "ghatkopar west": "Ghatkopar West",
    "goregaon east": "Goregaon East",
    "goregaon west": "Goregaon West",
    "grant road": "Grant Road",
    "juhu": "Juhu",
    "jogeshwari east": "Jogeshwari East",
    "jogeshwari west": "Jogeshwari West",
    "kalyan": "Kalyan",
    "kandivali east": "Kandivali East",
    "kandivali west": "Kandivali West",
    "khar west": "Khar West",
    "kurla": "Kurla",
    "kurla west": "Kurla West",
    "lalbaug": "Lalbaug",
    "lower parel": "Lower Parel",
    "mahalaxmi": "Mahalaxmi",
    "mahim": "Mahim",
    "malabar hill": "Malabar Hill",
    "malad east": "Malad East",
    "malad west": "Malad West",
    "marine lines": "Marine Lines",
    "matunga": "Matunga",
    "mira road": "Mira Road",
    "mulund west": "Mulund West",
    "mumbai central": "Mumbai Central",
    "nariman point": "Nariman Point",
    "nagpada": "Nagpada",
    "nerul": "Nerul",
    "panvel": "Panvel",
    "parel": "Parel",
    "powai": "Powai",
    "prabhadevi": "Prabhadevi",
    "pydhonie": "Pydhonie",
    "santacruz east": "Santacruz East",
    "santacruz west": "Santacruz West",
    "sewri": "Sewri",
    "sion": "Sion",
    "tardeo": "Tardeo",
    "thane west": "Thane West",
    "vile parle west": "Vile Parle West",
    "vashi": "Vashi",
    "vasai": "Vasai",
    "vikhroli": "Vikhroli",
    "virar": "Virar",
    "wadala": "Wadala",
    "worli": "Worli",
}


def _slugify(value: str) -> str:
    """Mirror apps/www/src/lib/supabase.ts slugify()."""
    return re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9]+", "-", value.strip().lower()))


def canonical_micro_market_slug(raw: str | None) -> str | None:
    """Return the canonical URL slug for a raw micro_market value, or None if hidden/unknown."""
    if not raw:
        return None
    normalised = re.sub(r"\s+", " ", raw.strip().lower())
    if not normalised:
        return None
    if normalised in HIDDEN_BUCKETS:
        return None
    if normalised in REDIRECTS:
        return _slugify(REDIRECTS[normalised])
    if normalised in IMPLIED_DIRECTION:
        return _slugify(IMPLIED_DIRECTION[normalised])
    if normalised in GENERIC_PARENTS:
        return _slugify(raw.strip())
    label = STANDALONE_LOCALITIES.get(normalised)
    if label:
        return _slugify(label)
    # Unknown raw value — not public in the canonical mapping.
    return None


# ── Backfill logic ──────────────────────────────────────────────────────────

BATCH = 1000


def backfill_table(client, table: str) -> int:
    """Backfill canonical_micro_market_slug for every row in *table*."""
    total = 0
    offset = 0
    while True:
        res = (
            client.table(table)
            .select("id, micro_market")
            .not_.is_("micro_market", None)
            .range(offset, offset + BATCH - 1)
            .execute()
        )
        rows = res.data or []
        if not rows:
            break

        updates = []
        for row in rows:
            slug = canonical_micro_market_slug(row.get("micro_market"))
            # Only update if the slug is non-null or the column was previously set.
            updates.append({"id": row["id"], "canonical_micro_market_slug": slug})

        # Batch update in chunks of 100 (Supabase upsert limit).
        for i in range(0, len(updates), 100):
            chunk = updates[i : i + 100]
            client.table(table).upsert(chunk, on_conflict="id").execute()

        total += len(rows)
        if len(rows) < BATCH:
            break
        offset += BATCH
        if total % 5000 == 0:
            print(f"  {table}: {total} rows processed …", flush=True)

    return total


def main():
    url = os.environ.get("SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        sys.exit("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set")

    client = create_client(url, key)

    for table in ("listings", "buildings"):
        print(f"Backfilling {table} …", flush=True)
        t0 = time.time()
        n = backfill_table(client, table)
        elapsed = time.time() - t0
        print(f"  {table}: done — {n} rows in {elapsed:.1f}s", flush=True)


if __name__ == "__main__":
    main()
