"""
WhatsApp source — discovers groups from DB (populated by the WhatsApp ingestor
via GROUPS_REFRESHED webhook) and provides empty historical records
(live messages flow through the webhook).
"""

import json
import logging
import os
from typing import Iterator, Optional
from datetime import datetime, timezone

from lab.config import STATUS_FILE, PROJECT_DIR
from lab.ingestion.base import BaseSource, SyncJob, SourceRecord
from lab.storage import SupabaseStorage, SyncJob as StorageSyncJob

logger = logging.getLogger(__name__)


class WhatsAppSource(BaseSource):
    """WhatsApp groups — discovered via ingestor GROUPS_REFRESHED."""

    name = "whatsapp"
    version = "2.0.0"

    def __init__(self):
        self._status = {}

    def _read_status_file(self) -> dict:
        """Read the ingestor status file."""
        if self._status:
            return self._status
        candidates = [STATUS_FILE, PROJECT_DIR / "status.json"]
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
        """Check ingestor is connected via status file."""
        status = self._read_status_file()
        if not status:
            return False
        return bool(status.get("connected", False))

    def connection_details(self) -> dict:
        """Return ingestor connection details from status file."""
        status = self._read_status_file()
        if not status:
            return {
                "connected": False,
                "connection_state": "unknown",
                "instance": "propai-whatsapp",
                "phone_number": None,
                "display_name": None,
            }
        return {
            "connected": bool(status.get("connected", False)),
            "connection_state": status.get("connection_state", "unknown"),
            "instance": status.get("instance", "propai-whatsapp"),
            "phone_number": status.get("phone_number", "").split(":")[0] if status.get("phone_number") else None,
            "display_name": status.get("display_name"),
            "instance_name": status.get("instance_name", "propai-whatsapp"),
            "updated_at": status.get("updated_at"),
        }

    def discover_jobs(self) -> list[SyncJob]:
        """Discover groups from source_sync_jobs in DB (populated via GROUPS_REFRESHED webhook)."""
        try:
            supabase_url = os.getenv("SUPABASE_URL", "")
            supabase_key = os.getenv("SUPABASE_SERVICE_KEY", "")
            if not supabase_url or not supabase_key:
                return []
            _storage = SupabaseStorage(supabase_url, supabase_key)
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
                    instance=row.instance or "propai-whatsapp",
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
            return {"state": "error", "connected": False, "error": "Cannot read status file"}
        state = status.get("connection_state", "unknown")
        return {
            "state": state,
            "connected": bool(status.get("connected", False)),
        }

    def qr_code(self) -> dict:
        return {"error": "QR pairing is handled by the new ingestor service."}

    def logout(self) -> dict:
        return {"error": "Logout not supported via API. Stop the ingestor, delete auth directory, and restart."}
