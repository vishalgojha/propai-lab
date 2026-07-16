#!/usr/bin/env python3
"""Manual bridge: rebuild the `listings` table from parsed_observations.

Run:  python3 scripts/rebuild_listings.py [limit]
Reads parsed_observations (+ resolver_decisions) and upserts each into
`listings` via the fingerprint dedup in storage.save_listing. Idempotent —
re-running only updates existing rows, never duplicates.

This is the missing link between the parser (extraction.py / multi_listing.py)
and the `listings` table that www reads. New messages also push live via
extraction.process_raw_message -> upsert_listing_from_parsed.
"""
import os
import sys

from storage.supabase import SupabaseStorage


def get_storage() -> SupabaseStorage:
    url = os.getenv("SUPABASE_URL", "")
    key = os.getenv("SUPABASE_SERVICE_KEY", "")
    if not url or not key:
        raise RuntimeError("Set SUPABASE_URL and SUPABASE_SERVICE_KEY.")
    return SupabaseStorage(url, key)


def main() -> None:
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    storage = get_storage()
    print(f"rebuild_listings(limit={limit or 'all'}) ...")
    n = storage.rebuild_listings(limit=limit)
    print(f"processed {n} parsed observations into listings")


if __name__ == "__main__":
    main()
