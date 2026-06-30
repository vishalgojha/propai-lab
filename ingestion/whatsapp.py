"""
WhatsApp source — discovers groups from DB (populated by Baileys ingestor
via GROUPS_REFRESHED webhook) and provides empty historical records
(live messages flow through the webhook).

The Baileys ingestor is the ONLY WhatsApp client. Evolution API is dead.
"""

import json
import logging
from typing import Iterator, Optional
from datetime import datetime, timezone

from lab.config import BAILEYS_STATUS_FILE, PROJECT_DIR, DB_PATH
from lab.ingestion.base import BaseSource, SyncJob, SourceRecord
from lab.storage import SqliteStorage, SyncJob as StorageSyncJob

logger = logging.getLogger(__name__)


class WhatsAppSource(BaseSource):
    """WhatsApp groups — discovered via Baileys ingestor GROUPS_REFRESHED."""

    name = "whatsapp"
    version = "2.0.0"

    def __init__(self):
        self._status = {}

    def _read_status_file(self) -> dict:
        """Read the Baileys ingestor status file."""
        if self._status:
            return self._status
        candidates = [BAILEYS_STATUS_FILE, PROJECT_DIR / "services" / "baileys-ingestor" / "auth" / "status.json"]
        seen = set()
        for path in candidates:
            key = str(path)
            if key in seen:
                continue
            seen.add(key)
            try:
                if path.exists():
                    data = json.loads(path.read_text())
                    if isinstance(data, dict):
                        self._status = data
                        return data
            except Exception:
                continue
        return {}

    # ── BaseSource interface ─────────────────────────────────

    def validate_connection(self) -> bool:
        """Check Baileys ingestor is connected via status file."""
        status = self._read_status_file()
        if not status:
            return False
        return bool(status.get("connected", False))

    def connection_details(self) -> dict:
        """Return Baileys ingestor connection details from status file."""
        status = self._read_status_file()
        if not status:
            return {
                "connected": False,
                "connection_state": "unknown",
                "instance": "propai-baileys",
                "phone_number": None,
                "display_name": None,
            }
        return {
            "connected": bool(status.get("connected", False)),
            "connection_state": status.get("connection_state", "unknown"),
            "instance": status.get("instance", "propai-baileys"),
            "phone_number": status.get("phone_number", "").split(":")[0] if status.get("phone_number") else None,
            "display_name": status.get("display_name"),
            "instance_name": status.get("instance_name", "propai-baileys"),
            "updated_at": status.get("updated_at"),
        }

    def discover_jobs(self) -> list[SyncJob]:
        """Discover groups from source_sync_jobs in DB (populated via GROUPS_REFRESHED webhook)."""
        try:
            _storage = SqliteStorage(DB_PATH)
            rows = _storage.get_sync_jobs(limit=500, source=self.name)
            jobs = []
            for row in rows:
                try:
                    meta = json.loads(row.meta) if isinstance(row.meta, str) else (row.meta or {})
                except (TypeError, json.JSONDecodeError):
                    meta = {}
                if not row.group_id:
                    continue
                jobs.append(SyncJob(
                    source=self.name,
                    instance=row.instance or "propai-baileys",
                    group_id=row.group_id,
                    group_name=row.group_name or row.group_id,
                    meta=meta,
                ))
            return jobs
        except Exception as e:
            logger.warning(f"Cannot load WhatsApp groups from DB: {e}")
            return []

    def fetch_records(self, job: SyncJob) -> Iterator[SourceRecord]:
        """
        No historical records available — live messages arrive via webhook.
        Returns empty iterator.
        """
        return iter([])

    # ── Internal helpers for compatibility ────────────────────

    def connection_status(self) -> dict:
        status = self._read_status_file()
        if not status:
            return {"state": "error", "connected": False, "error": "Cannot read Baileys status file"}
        state = status.get("connection_state", "unknown")
        return {
            "state": state,
            "connected": bool(status.get("connected", False)),
        }

    def qr_code(self) -> dict:
        """QR not available — Baileys ingestor handles its own pairing."""
        return {"error": "QR pairing is handled by the Baileys ingestor service. Use pm2 logs to view QR."}

    def logout(self) -> dict:
        """Logout not supported — delete auth dir and restart ingestor."""
        return {"error": "Logout not supported via API. Stop the ingestor (pm2 stop propai-baileys), delete auth/ directory, and restart."}
