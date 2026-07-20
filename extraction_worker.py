"""Standalone extraction worker — polls for unprocessed raw messages.

Usage:
    python3 extraction_worker.py [--poll N]

Alternate to the per-webhook background thread; useful for production
deployments where the API server is scaled horizontally and a single
dedicated worker should own all extraction.
"""

import argparse
import json
import os
import sys
import time
import traceback

from extraction import get_storage, process_raw_message

POLL_INTERVAL = int(os.getenv("EXTRACTION_WORKER_POLL_SECONDS", "5"))
BATCH_SIZE = int(os.getenv("EXTRACTION_WORKER_BATCH_SIZE", "50"))


def row_value(row, key: str, default=None):
    if isinstance(row, dict):
        return row.get(key, default)
    return getattr(row, key, default)


def parse_json(value, default):
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str) and value.strip():
        try:
            return json.loads(value)
        except (json.JSONDecodeError, TypeError):
            return default
    return default


def context_from_raw(row) -> dict:
    raw_payload = parse_json(row_value(row, "raw_payload"), {})
    data = raw_payload.get("data", raw_payload) if isinstance(raw_payload, dict) else {}
    key = data.get("key", {}) if isinstance(data, dict) else {}
    sender_data = data.get("sender", {}) if isinstance(data, dict) else {}
    msg = data.get("message", {}) if isinstance(data, dict) else {}

    group = (
        key.get("remoteJid")
        or data.get("from")
        or row_value(row, "group_name")
        or ""
    )
    sender_jid = key.get("participant") or sender_data.get("id") or row_value(row, "sender_jid") or ""
    sender_name = sender_data.get("name") or data.get("pushName") or row_value(row, "sender") or ""
    sender_phone = row_value(row, "sender_phone") or ""
    message_uid = row_value(row, "message_uid") or f"{group}:{key.get('id') or row_value(row, 'id')}"

    return {
        "sender_name": sender_name,
        "push_name": data.get("pushName") or sender_name,
        "sender_jid": sender_jid,
        "sender_phone": sender_phone,
        "group": group,
        "group_name": row_value(row, "group_name") or "",
        "instance": data.get("instance") or raw_payload.get("instance") or "",
        "is_dm": str(group).endswith("@s.whatsapp.net") or str(group).endswith("@lid"),
        "message_uid": message_uid,
        "message_id": key.get("id") or "",
        "msg_text": row_value(row, "message") or "",
        "msg": msg,
        "tenant_id": row_value(row, "tenant_id") or "",
    }


def run_cycle(storage):
    unprocessed = storage.get_unprocessed_raw_messages(limit=BATCH_SIZE)
    for row in unprocessed:
        raw_id = row_value(row, "id")
        try:
            ctx = context_from_raw(row)
            process_raw_message(raw_id, ctx, storage=storage)
        except Exception:
            print(f"[worker] Error processing raw_id={raw_id}:", flush=True)
            traceback.print_exc()
            # Continue to next message


def main():
    parser = argparse.ArgumentParser(description="Extraction worker")
    parser.add_argument("--poll", type=int, default=POLL_INTERVAL, help="Poll interval in seconds")
    args = parser.parse_args()

    storage = get_storage()
    print(f"[worker] Extraction worker started — polling every {args.poll}s", flush=True)

    while True:
        try:
            count = storage.count_unprocessed_raw()
            if count > 0:
                run_cycle(storage)
        except Exception:
            print("[worker] Cycle error:", flush=True)
            traceback.print_exc()
        time.sleep(args.poll)


if __name__ == "__main__":
    main()
