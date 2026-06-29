"""Reparse old raw WhatsApp messages and rebuild derived listings.

Default mode is dry-run. Use --apply to replace parsed_output rows.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_DIR))

from app import parse_message  # noqa: E402
from config import DB_PATH  # noqa: E402
from lab import multi_listing  # noqa: E402
from lab.storage import SqliteStorage  # noqa: E402


NUMBERED_LISTING_RE = re.compile(
    r"^\s*(?:[⭐*•-]\s*)?\d{1,3}\s*[\).:-]\s*(?=.*(?:bhk|rk|studio))",
    re.I | re.M,
)


DEPENDENT_TABLES = (
    "listing_observations",
    "resolver_decisions",
    "broker_observations",
    "enrichment_jobs",
)


PARSED_COLUMNS = (
    "raw_message_id",
    "message_type",
    "intent",
    "principal",
    "bhk",
    "price",
    "price_unit",
    "area_sqft",
    "furnishing",
    "location_raw",
    "location",
    "building_name",
    "landmark_name",
    "street_name",
    "area",
    "micro_market",
    "developer",
    "broker_name",
    "broker_phone",
    "profile_name",
    "listing_index",
    "forwarded",
    "confidence",
    "raw_payload",
    "event_id",
    "embedding",
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Reparse raw_messages into parsed_output.")
    target = parser.add_mutually_exclusive_group()
    target.add_argument("--raw-id", type=int, help="Reindex one raw_messages.id")
    target.add_argument(
        "--pattern",
        choices=("numbered", "all"),
        default="numbered",
        help="Raw message set to scan. Defaults to numbered.",
    )
    parser.add_argument("--limit", type=int, default=100, help="Maximum raw messages to process.")
    parser.add_argument("--offset", type=int, default=0, help="Offset for scanned raw messages.")
    parser.add_argument("--apply", action="store_true", help="Write changes. Without this, dry-run only.")
    parser.add_argument("--no-backup", action="store_true", help="Skip SQLite backup before --apply.")
    parser.add_argument("--no-rebuild", action="store_true", help="Skip rebuilding listings after --apply.")
    return parser


def candidate_rows(conn: sqlite3.Connection, args: argparse.Namespace) -> list[sqlite3.Row]:
    if args.raw_id:
        return conn.execute("SELECT * FROM raw_messages WHERE id = ?", (args.raw_id,)).fetchall()

    if args.pattern == "all":
        return conn.execute(
            """SELECT * FROM raw_messages
               ORDER BY id ASC
               LIMIT ? OFFSET ?""",
            (args.limit, args.offset),
        ).fetchall()

    selected: list[sqlite3.Row] = []
    batch_size = 500
    offset = args.offset
    while len(selected) < args.limit:
        rows = conn.execute(
            """SELECT * FROM raw_messages
               ORDER BY id ASC
               LIMIT ? OFFSET ?""",
            (batch_size, offset),
        ).fetchall()
        if not rows:
            break
        for row in rows:
            if NUMBERED_LISTING_RE.search(row["message"] or ""):
                selected.append(row)
                if len(selected) >= args.limit:
                    break
        offset += len(rows)
    return selected


def parse_raw(row: sqlite3.Row) -> list[dict]:
    message = row["message"] or ""
    profile_name = row["sender"] or row["sender_phone"] or ""
    msg_class = multi_listing.classify_message(message)
    if msg_class == "multi":
        parsed = multi_listing.parse_multi_message(message, profile_name=profile_name)
    else:
        single = parse_message(message, profile_name=profile_name)
        parsed = [single] if single else []

    sender_phone = row["sender_phone"] or ""
    if not sender_phone and row["sender_jid"]:
        sender_phone = "".join(ch for ch in str(row["sender_jid"]).split("@", 1)[0] if ch.isdigit())

    for item in parsed:
        if not item.get("broker_name"):
            item["broker_name"] = profile_name or (f"+91 {sender_phone[-10:]}" if len(sender_phone) >= 10 else sender_phone)
        if not item.get("broker_phone") and sender_phone:
            item["broker_phone"] = sender_phone[-10:] if len(sender_phone) >= 10 else sender_phone
    return parsed


def delete_existing(conn: sqlite3.Connection, raw_id: int) -> list[int]:
    old_ids = [row["id"] for row in conn.execute("SELECT id FROM parsed_output WHERE raw_message_id = ?", (raw_id,))]
    if not old_ids:
        return []
    placeholders = ",".join("?" for _ in old_ids)
    for table in DEPENDENT_TABLES:
        try:
            conn.execute(f"DELETE FROM {table} WHERE parsed_id IN ({placeholders})", old_ids)
        except sqlite3.OperationalError:
            pass
    conn.execute(f"DELETE FROM parsed_output WHERE id IN ({placeholders})", old_ids)
    return old_ids


def insert_parsed(conn: sqlite3.Connection, raw: sqlite3.Row, parsed_items: list[dict]) -> list[int]:
    ids: list[int] = []
    placeholders = ",".join("?" for _ in PARSED_COLUMNS)
    sql = f"INSERT INTO parsed_output ({','.join(PARSED_COLUMNS)}) VALUES ({placeholders})"
    for idx, item in enumerate(parsed_items):
        values = {
            "raw_message_id": raw["id"],
            "message_type": item.get("message_type"),
            "intent": item.get("intent"),
            "principal": item.get("principal"),
            "bhk": item.get("bhk"),
            "price": item.get("price"),
            "price_unit": item.get("price_unit"),
            "area_sqft": item.get("area_sqft"),
            "furnishing": item.get("furnishing"),
            "location_raw": item.get("location_raw"),
            "location": json.dumps(item.get("location")) if item.get("location") else None,
            "building_name": item.get("building_name"),
            "landmark_name": item.get("landmark_name"),
            "street_name": item.get("street_name"),
            "area": item.get("area"),
            "micro_market": item.get("micro_market"),
            "developer": item.get("developer"),
            "broker_name": item.get("broker_name"),
            "broker_phone": item.get("broker_phone"),
            "profile_name": raw["sender"],
            "listing_index": idx,
            "forwarded": item.get("forwarded", 0),
            "confidence": item.get("confidence", 0.0),
            "raw_payload": json.dumps(item.get("raw_payload", {})),
            "event_id": raw["event_id"],
            "embedding": None,
        }
        cur = conn.execute(sql, [values[column] for column in PARSED_COLUMNS])
        ids.append(int(cur.lastrowid))
    return ids


def backup_db() -> Path:
    backup = Path(str(DB_PATH) + f".backup-before-reindex-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}")
    shutil.copy2(DB_PATH, backup)
    return backup


def main() -> int:
    args = build_parser().parse_args()
    storage = SqliteStorage(DB_PATH)
    conn = storage.db
    rows = candidate_rows(conn, args)

    summary = []
    for row in rows:
        parsed = parse_raw(row)
        existing = conn.execute("SELECT COUNT(*) FROM parsed_output WHERE raw_message_id = ?", (row["id"],)).fetchone()[0]
        summary.append((row, existing, parsed))

    print(f"DB: {DB_PATH}")
    print(f"Mode: {'APPLY' if args.apply else 'DRY RUN'}")
    print(f"Raw messages selected: {len(summary)}")
    print("")

    for row, existing, parsed in summary[:20]:
        preview = re.sub(r"\s+", " ", (row["message"] or "").strip())[:120]
        print(f"raw_id={row['id']} existing={existing} new={len(parsed)} sender={row['sender']} :: {preview}")
    if len(summary) > 20:
        print(f"... {len(summary) - 20} more")

    if not args.apply:
        print("")
        print("Dry run only. Re-run with --apply to write changes.")
        return 0

    backup = None if args.no_backup else backup_db()
    if backup:
        print(f"Backup: {backup}")

    changed = 0
    inserted = 0
    try:
        for row, _existing, parsed in summary:
            delete_existing(conn, row["id"])
            insert_ids = insert_parsed(conn, row, parsed)
            changed += 1
            inserted += len(insert_ids)
        conn.commit()
    except Exception:
        conn.rollback()
        raise

    if not args.no_rebuild:
        storage.rebuild_listings()
        try:
            storage.rebuild_broker_graph()
        except Exception:
            pass

    print("")
    print(f"Reindexed raw messages: {changed}")
    print(f"Inserted parsed rows: {inserted}")
    if not args.no_rebuild:
        print("Rebuilt listings.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
