#!/usr/bin/env python3
"""Resumable backfill for ``raw_messages.message_hash``.

The script walks oldest-first in fixed-size batches, updates rows whose
``message_hash`` is still NULL, and commits each batch independently so
interruption is safe. Re-running simply resumes from the remaining NULL
rows.

Usage:

    DATABASE_URL=postgres://... python backfill_message_hash.py --batch-size 5000
"""

from __future__ import annotations

import argparse
import os
from typing import Iterable

import psycopg2


def _database_url() -> str:
    for key in ("DATABASE_URL", "SUPABASE_DATABASE_URL", "SUPABASE_DB_URL"):
        value = os.getenv(key, "").strip()
        if value:
            return value
    raise SystemExit("DATABASE_URL (or SUPABASE_DATABASE_URL / SUPABASE_DB_URL) is required")


def _count_null_hash_rows(cur) -> int:
    cur.execute("select count(*) from raw_messages where message_hash is null")
    row = cur.fetchone()
    return int(row[0] or 0) if row else 0


def _fetch_batch(cur, batch_size: int) -> list[int]:
    cur.execute(
        """
        select id
        from raw_messages
        where message_hash is null
        order by id asc
        limit %s
        """,
        (batch_size,),
    )
    return [int(row[0]) for row in cur.fetchall()]


def _update_batch(cur, raw_ids: Iterable[int]) -> int:
    ids = [int(raw_id) for raw_id in raw_ids]
    if not ids:
        return 0
    cur.execute(
        """
        update raw_messages
        set message_hash = md5(message)
        where message_hash is null
          and id = any(%s)
        """,
        (ids,),
    )
    return int(cur.rowcount or 0)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--batch-size", type=int, default=5000)
    args = parser.parse_args()

    dsn = _database_url()
    conn = psycopg2.connect(dsn)
    conn.autocommit = False

    try:
        with conn.cursor() as cur:
            total = _count_null_hash_rows(cur)
        print(f"pending={total:,}")

        done = 0
        batch_no = 0
        while True:
            with conn.cursor() as cur:
                ids = _fetch_batch(cur, max(1, int(args.batch_size)))
            if not ids:
                break

            batch_no += 1
            with conn.cursor() as cur:
                updated = _update_batch(cur, ids)
            conn.commit()

            done += updated
            remaining = max(0, total - done)
            print(
                f"batch={batch_no} updated={updated:,} "
                f"done={done:,} remaining≈{remaining:,}",
                flush=True,
            )
            if updated == 0:
                # Another worker may have filled the batch in the meantime.
                # Recompute the remaining count and continue until NULLs are gone.
                with conn.cursor() as cur:
                    total = _count_null_hash_rows(cur)
                if total == 0:
                    break
                done = 0
                print(f"rescan pending={total:,}", flush=True)

        with conn.cursor() as cur:
            remaining = _count_null_hash_rows(cur)
        print(f"complete remaining={remaining:,}")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
