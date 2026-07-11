"""Standalone extraction worker — polls for unprocessed raw messages.

Usage:
    python3 extraction_worker.py [--poll N]

Alternate to the per-webhook background thread; useful for production
deployments where the API server is scaled horizontally and a single
dedicated worker should own all extraction.
"""

import argparse
import json
import sys
import time
import traceback

from extraction import get_storage, process_raw_message

POLL_INTERVAL = 5     # seconds between polls
BATCH_SIZE = 10        # messages per cycle


def run_cycle(storage):
    unprocessed = storage.get_unprocessed_raw_messages(limit=BATCH_SIZE)
    for row in unprocessed:
        raw_id = row["id"]
        try:
            ctx = json.loads(row.get("context") or "{}")
            ctx.setdefault("sender_name", row.get("sender_name") or "")
            ctx.setdefault("push_name", row.get("push_name") or "")
            ctx.setdefault("sender_jid", row.get("sender_jid") or "")
            ctx.setdefault("sender_phone", row.get("sender_phone") or "")
            ctx.setdefault("group", row.get("group_name") or row.get("conversation_id") or "")
            ctx.setdefault("group_name", row.get("group_name") or "")
            ctx.setdefault("instance", ctx.get("instance", ""))
            ctx.setdefault("is_dm", row.get("is_dm", False))
            ctx.setdefault("message_uid", row.get("message_uid") or str(raw_id))
            ctx.setdefault("message_id", ctx.get("message_id", ""))
            ctx.setdefault("msg_text", row.get("message") or "")
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
