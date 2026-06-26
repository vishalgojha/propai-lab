"""
Historical WhatsApp Group Synchronization.

Connects to Evolution API to discover groups, fetch historical messages,
and process them through the existing pipeline. Runs as a background worker
with queue-based processing, rate limiting, and resumable checkpoints.

Flow:
  POST /api/sync/start → discover groups → for each group:
    fetch metadata → fetch messages (paginated, oldest-first) →
    process through pipeline (save_raw → parse → resolve → store) →
    update checkpoint → next group

Idempotency: messages are deduplicated by (instance_name, group_jid, message_id)
via the raw_messages.message_uid unique index.
"""

import json
import time
import logging
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx

from lab.config import (
    EVOLUTION_API_URL,
    EVOLUTION_API_KEY,
    EVOLUTION_INSTANCE,
    EVOLUTION_SYNC_DELAY_MS,
)
from lab.storage import SyncCheckpoint
from lab.app import storage

logger = logging.getLogger(__name__)

# ── Constants ─────────────────────────────────────────────────────

SYNC_BATCH_SIZE = 100       # messages per Evolution API call
SYNC_DELAY_S = max(0.1, EVOLUTION_SYNC_DELAY_MS / 1000.0)


# ── Evolution API Client ──────────────────────────────────────────

class EvolutionAPIClient:
    """Thin HTTP client for Evolution API REST endpoints."""

    def __init__(self, base_url: str = EVOLUTION_API_URL,
                 api_key: str = EVOLUTION_API_KEY,
                 instance: str = EVOLUTION_INSTANCE):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.instance = instance
        self._headers = {"Content-Type": "application/json"}
        if api_key:
            self._headers["apikey"] = api_key

    def _get(self, path: str, params: dict = None, timeout: int = 30) -> dict:
        url = f"{self.base_url}/{path.lstrip('/')}"
        resp = httpx.get(url, headers=self._headers, params=params, timeout=timeout)
        resp.raise_for_status()
        return resp.json()

    def _post(self, path: str, body: dict = None, timeout: int = 30) -> dict:
        url = f"{self.base_url}/{path.lstrip('/')}"
        resp = httpx.post(url, headers=self._headers, json=body or {}, timeout=timeout)
        resp.raise_for_status()
        return resp.json()

    def instance_status(self) -> dict:
        """Check if the instance is connected."""
        try:
            return self._get(f"instance/connectionState/{self.instance}")
        except Exception:
            return {"instance": {"state": "disconnected"}}

    def fetch_groups(self) -> list[dict]:
        """List all joined WhatsApp groups."""
        try:
            data = self._get(f"group/fetchAllGroups/{self.instance}")
        except Exception:
            try:
                data = self._get(f"group/{self.instance}/fetchAllGroups")
            except Exception as e:
                logger.warning(f"Cannot fetch groups: {e}")
                return []
        if isinstance(data, list):
            return data
        for key in ("data", "groups", "result", "response"):
            val = data.get(key)
            if isinstance(val, list):
                return val
        return []

    def group_metadata(self, group_jid: str) -> dict:
        """Get group metadata (name, participants, owner, etc.)."""
        try:
            data = self._get(f"group/metadata/{self.instance}/{group_jid}")
        except Exception:
            try:
                data = self._get(f"group/{self.instance}/metadata/{group_jid}")
            except Exception as e:
                logger.warning(f"Cannot fetch metadata for {group_jid}: {e}")
                return {}
        if isinstance(data, dict):
            # Remove wrapping keys
            for key in ("data", "result", "response"):
                inner = data.get(key)
                if isinstance(inner, dict):
                    return inner
            return data
        return {}

    def fetch_messages(self, group_jid: str, count: int = SYNC_BATCH_SIZE,
                       offset: int = 0) -> list[dict]:
        """
        Fetch messages from a group. Returns newest-first by default.
        offset = number of messages to skip from the newest.
        """
        try:
            data = self._get(
                f"message/fetchAll/{self.instance}/{group_jid}",
                params={"count": count, "offset": offset},
            )
        except Exception:
            try:
                data = self._get(
                    f"message/{self.instance}/fetchAll/{group_jid}",
                    params={"count": count, "offset": offset},
                )
            except Exception as e:
                logger.warning(f"Cannot fetch messages for {group_jid}: {e}")
                return []
        if isinstance(data, list):
            return data
        for key in ("data", "messages", "result", "response"):
            val = data.get(key)
            if isinstance(val, list):
                return val
        return []

    def check_connection(self) -> bool:
        """Verify the instance is connected to WhatsApp."""
        try:
            # Try connectionState endpoint first
            st = self.instance_status()
            state = st.get("instance", {}).get("state", "")
            if state.lower() in ("open", "connected", "syncing", "connecting"):
                return True
            # Fallback: check fetchInstances which is more reliable
            instances = self.fetch_groups()
            for inst in instances:
                if inst.get("name") == self.instance:
                    return inst.get("connectionStatus", "").lower() == "open"
            return False
        except Exception:
            return False


# ── Historical Sync Worker ────────────────────────────────────────

class HistoricalSyncWorker:
    """
    Background worker that discovers WhatsApp groups, fetches historical
    messages via Evolution API, and processes them through the pipeline.

    Thread-safe: uses one DB connection per operation. WAL mode allows
    concurrent reads while the webhook handler writes simultaneously.
    """

    def __init__(self):
        self.api = EvolutionAPIClient()
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self._status = {
            "overall": "idle",           # idle | discovering | syncing | complete | error | no_connection
            "instance_connected": False,
            "total_groups": 0,
            "completed_groups": 0,
            "failed_groups": 0,
            "total_messages_found": 0,
            "synced_messages": 0,
            "failed_messages": 0,
            "current_group": None,
            "current_group_name": None,
            "started_at": None,
            "completed_at": None,
            "error": None,
        }

    # ── Public API ───────────────────────────────────────────

    def start(self) -> bool:
        """Start sync in a background thread. Returns False if already running."""
        with self._lock:
            if self._running:
                return False
            if not self.api.check_connection():
                self._status["overall"] = "no_connection"
                self._status["error"] = "Evolution API instance not connected to WhatsApp"
                return False
            self._running = True
            self._reset_status()
            self._status["started_at"] = datetime.now(timezone.utc).isoformat()

        self._thread = threading.Thread(target=self._run, daemon=True, name="hist-sync")
        self._thread.start()
        logger.info("Historical sync worker started")
        return True

    def stop(self):
        """Signal the worker to stop gracefully."""
        with self._lock:
            self._running = False
        logger.info("Historical sync worker stop requested")

    def status(self) -> dict:
        """Return a snapshot of current sync status."""
        with self._lock:
            return dict(self._status)

    def is_running(self) -> bool:
        with self._lock:
            return self._running

    def groups(self) -> list[dict]:
        """Return checkpoint data for all known groups (dashboard)."""
        checkpoints = storage.get_checkpoints(EVOLUTION_INSTANCE)
        return [{f.name: getattr(cp, f.name) for f in cp.__dataclass_fields__.values()} for cp in checkpoints]

    def update_checkpoint(self, group_jid: str, **kwargs):
        """Thread-safe checkpoint upsert via storage layer."""
        existing = storage.get_checkpoint(EVOLUTION_INSTANCE, group_jid)
        cp = SyncCheckpoint(
            instance_name=EVOLUTION_INSTANCE,
            group_jid=group_jid,
            group_name=kwargs.get("group_name", existing.group_name if existing else ""),
            group_owner=kwargs.get("group_owner", existing.group_owner if existing else ""),
            participants=kwargs.get("participants", existing.participants if existing else 0),
            last_message_id=kwargs.get("last_message_id", existing.last_message_id if existing else None),
            last_message_ts=kwargs.get("last_message_ts", existing.last_message_ts if existing else None),
            first_message_ts=kwargs.get("first_message_ts", existing.first_message_ts if existing else None),
            last_synced_ts=kwargs.get("last_synced_ts", existing.last_synced_ts if existing else None),
            total_available=kwargs.get("total_available", existing.total_available if existing else 0),
            synced_count=kwargs.get("synced_count", existing.synced_count if existing else 0),
            status=kwargs.get("status", existing.status if existing else "pending"),
            error=kwargs.get("error", existing.error if existing else None),
        )
        storage.save_checkpoint(cp)

    # ── Internal ─────────────────────────────────────────────

    def _reset_status(self):
        self._status["overall"] = "discovering"
        self._status["total_groups"] = 0
        self._status["completed_groups"] = 0
        self._status["failed_groups"] = 0
        self._status["total_messages_found"] = 0
        self._status["synced_messages"] = 0
        self._status["failed_messages"] = 0
        self._status["current_group"] = None
        self._status["current_group_name"] = None
        self._status["complete_at"] = None
        self._status["error"] = None

    def _run(self):
        """Main sync loop — runs in background thread."""
        try:
            self._sync_all_groups()
        except Exception as e:
            logger.exception("Historical sync failed")
            with self._lock:
                self._status["overall"] = "error"
                self._status["error"] = str(e)

    def _sync_all_groups(self):
        """Discover all groups and sync each one."""
        groups = self.api.fetch_groups()
        if not groups:
            logger.info("No groups found via Evolution API")
            with self._lock:
                self._status["overall"] = "complete"
                self._status["completed_at"] = datetime.now(timezone.utc).isoformat()
            return

        with self._lock:
            self._status["overall"] = "syncing"
            self._status["total_groups"] = len(groups)
            self._status["instance_connected"] = True

        for g in groups:
            if not self._running:
                break
            jid = g.get("id") or g.get("jid") or g.get("remoteJid") or ""
            name = g.get("name") or g.get("subject") or jid
            if not jid:
                logger.warning(f"Group has no JID: {g}")
                continue
            self._sync_group(jid, name)

        with self._lock:
            self._status["overall"] = "complete"
            self._status["current_group"] = None
            self._status["current_group_name"] = None
            self._status["completed_at"] = datetime.now(timezone.utc).isoformat()

    def _sync_group(self, group_jid: str, group_name: str):
        """Fetch and process all historical messages for one group."""
        # Get or create checkpoint
        cp = self._get_checkpoint(group_jid)
        synced_count = cp.get("synced_count", 0)

        with self._lock:
            self._status["current_group"] = group_jid
            self._status["current_group_name"] = group_name

        # Fetch group metadata
        meta = self.api.group_metadata(group_jid)
        participants = len(meta.get("participants", [])) if isinstance(meta.get("participants"), list) else 0
        group_owner = meta.get("owner", "") or meta.get("groupOwner", "")

        # Initialize checkpoint
        self.update_checkpoint(
            group_jid,
            group_name=group_name,
            group_owner=group_owner,
            participants=participants,
            status="syncing",
        )

        # Fetch messages in batches, from oldest (by reversing newset-first batches)
        all_messages = []
        batch_offset = 0
        max_empty_batches = 3
        consecutive_empty = 0

        while self._running and consecutive_empty < max_empty_batches:
            batch = self.api.fetch_messages(group_jid, count=SYNC_BATCH_SIZE, offset=batch_offset)
            if not batch:
                consecutive_empty += 1
                batch_offset += SYNC_BATCH_SIZE
                continue
            consecutive_empty = 0
            # Reverse so we process oldest-first within this batch
            all_messages.extend(reversed(batch))
            batch_offset += len(batch)
            time.sleep(SYNC_DELAY_S)

            # Stop if we got fewer than requested (end of history)
            if len(batch) < SYNC_BATCH_SIZE:
                break

        # Track total found
        total_found = len(all_messages)
        with self._lock:
            self._status["total_messages_found"] += total_found

        # Skip messages we already synced (checkpoint resumed)
        to_process = all_messages[synced_count:]
        skipped = synced_count

        # Set first/last timestamps
        first_ts = None
        last_ts = None
        if all_messages:
            timestamps = []
            for m in all_messages:
                ts = m.get("messageTimestamp")
                if ts:
                    timestamps.append(ts)
            if timestamps:
                first_ts = datetime.fromtimestamp(min(timestamps), tz=timezone.utc).isoformat()
                last_ts = datetime.fromtimestamp(max(timestamps), tz=timezone.utc).isoformat()

        self.update_checkpoint(
            group_jid,
            total_available=total_found,
            first_message_ts=first_ts,
            last_message_ts=last_ts,
        )

        # Process messages oldest-first
        batch_errors = 0
        for i, msg in enumerate(to_process):
            if not self._running:
                break
            try:
                self._process_message(msg, group_jid)
                synced_count += 1
                with self._lock:
                    self._status["synced_messages"] += 1
            except Exception as e:
                batch_errors += 1
                with self._lock:
                    self._status["failed_messages"] += 1
                logger.error(f"Failed to process message in {group_jid}: {e}")

            # Update checkpoint every N messages
            if (i + 1) % 10 == 0:
                self.update_checkpoint(
                    group_jid,
                    synced_count=synced_count,
                    last_message_id=msg.get("key", {}).get("id"),
                    last_synced_ts=datetime.now(timezone.utc).isoformat(),
                )

        # Final checkpoint update
        final_status = "error" if batch_errors > 0 and synced_count == skipped else "complete"
        self.update_checkpoint(
            group_jid,
            synced_count=synced_count,
            last_synced_ts=datetime.now(timezone.utc).isoformat(),
            status=final_status,
            error=f"{batch_errors} errors" if batch_errors > 0 else None,
        )

        with self._lock:
            self._status["completed_groups"] += 1
            if final_status == "error":
                self._status["failed_groups"] += 1

    def _process_message(self, msg: dict, group_jid: str):
        """
        Run a single WhatsApp message through the full pipeline:
        save_raw → parse → save_parsed → resolve → save_resolver_decision.
        """
        key = msg.get("key", {})
        message_id = key.get("id", "")
        participant = key.get("participant", "") or msg.get("sender", {}).get("pushName", "unknown")
        remote_jid = key.get("remoteJid", group_jid)

        # Message content
        msg_obj = msg.get("message", {})
        text = (
            msg_obj.get("conversation", "")
            or msg_obj.get("extendedTextMessage", {}).get("text", "")
            or msg.get("text", "")
        )
        if not text:
            text = json.dumps(msg_obj) if msg_obj else ""

        # Timestamp
        ts_raw = msg.get("messageTimestamp") or msg.get("timestamp", 0)
        if isinstance(ts_raw, (int, float)) and ts_raw > 1000000000:
            timestamp = datetime.fromtimestamp(ts_raw, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        else:
            timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

        # Skip non-text messages
        if not text:
            return

        # Build dedup key: instance::group::message_id
        message_uid = f"{EVOLUTION_INSTANCE}::{remote_jid}::{message_id}" if message_id else None

        # Save raw message (deduplicated by message_uid)
        from lab.app import save_raw_message, parse_message, save_parsed, resolve_parsed, save_resolver_decision
        raw_id = save_raw_message(
            group=remote_jid,
            sender=participant,
            message=text,
            msg_type="text",
            timestamp=timestamp,
            source="WHATSAPP_HISTORY",
            raw_payload=msg,
            message_uid=message_uid,
        )

        # Check if already parsed (dedup)
        if message_uid:
            existing = storage.get_parsed_by_raw(raw_id)
            if existing:
                return

        # Parse and resolve
        parsed = parse_message(text)
        parsed_id = save_parsed(raw_id, parsed)

        resolver_result = resolve_parsed(parsed, text)
        save_resolver_decision(parsed_id, resolver_result)

    def _get_checkpoint(self, group_jid: str) -> dict:
        """Read existing checkpoint for a group, or return defaults."""
        cp = storage.get_checkpoint(EVOLUTION_INSTANCE, group_jid)
        if cp:
            return {f.name: getattr(cp, f.name) for f in cp.__dataclass_fields__.values()}
        return {
            "synced_count": 0,
            "last_message_id": None,
            "total_available": 0,
            "status": "pending",
        }
