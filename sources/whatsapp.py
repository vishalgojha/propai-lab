"""
WhatsApp ingestion connector — implements IngestionSource for the Evolution API.

Connects to the Evolution API to discover joined groups (as SourceJobs) and
stream historical messages (as SourceRecords). The scheduler drives this
connector without knowing anything about WhatsApp internals.
"""

import json
import logging
import time
from typing import Iterator, Optional

import httpx

from lab.config import (
    EVOLUTION_API_URL,
    EVOLUTION_API_KEY,
    EVOLUTION_INSTANCE,
    EVOLUTION_SYNC_DELAY_MS,
)
from lab.sources.base import IngestionSource, SourceJob, SourceRecord

logger = logging.getLogger(__name__)

SYNC_BATCH_SIZE = 100
SYNC_DELAY_S = max(0.1, EVOLUTION_SYNC_DELAY_MS / 1000.0)


class WhatsAppSource(IngestionSource):
    """WhatsApp group connector via the Evolution API."""

    name = "whatsapp"
    version = "1.0.0"

    def __init__(self):
        self.base_url = EVOLUTION_API_URL.rstrip("/")
        self.api_key = EVOLUTION_API_KEY
        self.instance = EVOLUTION_INSTANCE
        self._headers = {"Content-Type": "application/json"}
        if self.api_key:
            self._headers["apikey"] = self.api_key

    def _get(self, path: str, params: dict = None, timeout: int = 30) -> dict:
        url = f"{self.base_url}/{path.lstrip('/')}"
        resp = httpx.get(url, headers=self._headers, params=params, timeout=timeout)
        resp.raise_for_status()
        return resp.json()

    # ── BaseSource interface ─────────────────────────────────

    def validate_connection(self) -> bool:
        try:
            data = self._get(f"instance/connectionState/{self.instance}")
            state = data.get("instance", {}).get("state", "")
            return state.lower() in ("open", "connected", "syncing")
        except Exception:
            return False

    def discover_jobs(self) -> list[SourceJob]:
        """Enumerate all joined groups as sync jobs."""
        try:
            data = self._get(f"group/fetchAllGroups/{self.instance}")
        except Exception:
            try:
                data = self._get(f"group/{self.instance}/fetchAllGroups")
            except Exception as e:
                logger.warning(f"Cannot fetch WhatsApp groups: {e}")
                return []

        raw_groups = data if isinstance(data, list) else (
            data.get("data") or data.get("groups") or data.get("result") or []
        )
        if not isinstance(raw_groups, list):
            return []

        jobs = []
        for g in raw_groups:
            jid = g.get("id") or g.get("jid") or g.get("remoteJid") or ""
            name = g.get("name") or g.get("subject") or jid
            if not jid:
                continue
            # Fetch metadata for participant count
            participants = 0
            try:
                meta = self._get(f"group/metadata/{self.instance}/{jid}")
                meta_data = meta.get("data", meta) if isinstance(meta, dict) else {}
                participants_list = meta_data.get("participants", [])
                participants = len(participants_list) if isinstance(participants_list, list) else 0
            except Exception:
                pass
            jobs.append(SourceJob(
                source=self.name,
                instance=self.instance,
                group_id=jid,
                group_name=name,
                meta={"participants": participants},
            ))
        return jobs

    def fetch_records(self, job: SourceJob) -> Iterator[SourceRecord]:
        """
        Fetch all historical messages for a group, yielding oldest-first.
        Supports resumable sync via job.meta.get("last_cursor").
        """
        group_jid = job.group_id
        skip_count = int(job.meta.get("last_cursor", "0")) if job.meta.get("last_cursor") else 0
        batch_offset = skip_count
        max_empty = 3
        consecutive_empty = 0

        while consecutive_empty < max_empty:
            batch = self._fetch_batch(group_jid, count=SYNC_BATCH_SIZE, offset=batch_offset)
            if not batch:
                consecutive_empty += 1
                batch_offset += SYNC_BATCH_SIZE
                continue
            consecutive_empty = 0
            # Reverse to yield oldest-first
            for msg in reversed(batch):
                record = self._msg_to_record(msg, group_jid)
                if record:
                    yield record
            batch_offset += len(batch)
            time.sleep(SYNC_DELAY_S)
            if len(batch) < SYNC_BATCH_SIZE:
                break

    # ── Internal ─────────────────────────────────────────────

    def _fetch_batch(self, group_jid: str, count: int = SYNC_BATCH_SIZE,
                     offset: int = 0) -> list[dict]:
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

    def _msg_to_record(self, msg: dict, group_jid: str) -> Optional[SourceRecord]:
        """Convert an Evolution API message to a generic SourceRecord."""
        key = msg.get("key", {})
        message_id = key.get("id", "")
        participant = key.get("participant", "") or msg.get("sender", {}).get("pushName", "unknown")

        msg_obj = msg.get("message", {})
        text = (
            msg_obj.get("conversation", "")
            or msg_obj.get("extendedTextMessage", {}).get("text", "")
            or msg.get("text", "")
        )
        if not text:
            text = json.dumps(msg_obj) if msg_obj else ""

        if not text:
            return None

        ts_raw = msg.get("messageTimestamp") or msg.get("timestamp", 0)
        if isinstance(ts_raw, (int, float)) and ts_raw > 1000000000:
            ts = float(ts_raw)
        else:
            ts = None

        return SourceRecord(
            source=self.name,
            instance=self.instance,
            group_id=group_jid,
            record_id=message_id,
            text=text,
            sender=participant,
            timestamp=ts,
            raw=msg,
            meta={
                "key": key,
                "message_type": list(msg_obj.keys()) if isinstance(msg_obj, dict) else [],
            },
        )
