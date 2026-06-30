"""
WhatsApp source — connects to Evolution API for group discovery
and historical message synchronization.

Implements BaseSource so the scheduler can treat WhatsApp like
any other data source.
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
from lab.ingestion.base import BaseSource, SyncJob, SourceRecord

logger = logging.getLogger(__name__)

SYNC_BATCH_SIZE = 100
SYNC_DELAY_S = max(0.1, EVOLUTION_SYNC_DELAY_MS / 1000.0)


class WhatsAppSource(BaseSource):
    """WhatsApp groups via Evolution API."""

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
        resp = httpx.get(url, headers=self._headers, params=params, timeout=timeout, trust_env=False)
        resp.raise_for_status()
        return resp.json()

    def _post(self, path: str, json_body: dict = None, timeout: int = 30) -> dict:
        url = f"{self.base_url}/{path.lstrip('/')}"
        resp = httpx.post(url, headers=self._headers, json=json_body, timeout=timeout, trust_env=False)
        resp.raise_for_status()
        return resp.json()

    # ── BaseSource interface ─────────────────────────────────

    def validate_connection(self) -> bool:
        try:
            data = self._get(f"instance/connectionState/{self.instance}", timeout=3)
            state = data.get("instance", {}).get("state", "")
            if state.lower() in ("open", "connected", "syncing"):
                return True
            info_state = self._extract_state(self._fetch_instance_info())
            return (info_state or "").lower() in ("open", "connected", "syncing")
        except Exception:
            return False

    def connection_details(self) -> dict:
        """Return real Evolution API connection details, leaving unknowns as None."""
        state_payload = self._safe_get(f"instance/connectionState/{self.instance}") or {}
        state = self._extract_state(state_payload)
        instance_info = self._fetch_instance_info()
        instance_state = self._extract_state(instance_info)
        if (instance_state or "").lower() in ("open", "connected", "syncing"):
            state = instance_state
        chats = self._fetch_chats()
        groups = self._fetch_groups()

        total_chats = len(chats) if chats is not None else None
        group_count = self._count_groups(chats) if chats is not None else None
        if groups is not None and (group_count is None or len(groups) > group_count):
            group_count = len(groups)
        individual_count = None
        if total_chats is not None and group_count is not None and total_chats >= group_count:
            individual_count = max(total_chats - group_count, 0)

        owner_jid = self._first_value(
            instance_info,
            "ownerJid", "owner", "wuid", "jid", "number",
        )
        phone = self._phone_from_jid(owner_jid)

        return {
            "connected": (state or "").lower() in ("open", "connected", "syncing"),
            "connection_state": state,
            "instance": self.instance,
            "instance_name": self._first_value(instance_info, "name", "instanceName", "instance_name") or self.instance,
            "phone_number": phone,
            "device_name": self._first_value(instance_info, "device", "deviceName", "platform", "browser"),
            "display_name": self._first_value(instance_info, "profileName", "pushName", "name"),
            "connected_since": self._first_value(instance_info, "createdAt", "connectedAt", "updatedAt"),
            "last_heartbeat": self._first_value(instance_info, "lastSeen", "lastHeartbeat", "updatedAt"),
            "whatsapp_version": self._first_value(instance_info, "waVersion", "whatsappVersion", "version"),
            "total_chats": total_chats,
            "total_groups": group_count,
            "total_individual_chats": individual_count,
            "total_broadcasts": self._count_jid_suffix(chats, "@broadcast") if chats is not None else None,
            "total_communities": self._count_communities(chats) if chats is not None else None,
            "group_discovery_succeeded": groups is not None,
            "chat_discovery_succeeded": chats is not None,
            "raw_state": state_payload,
        }

    def qr_code(self) -> dict:
        """Fetch QR code base64 from Evolution API. Returns {'base64': '...'} or {'error': '...'}."""
        try:
            data = self._get(f"instance/connect/{self.instance}", timeout=10)
            return data
        except httpx.TimeoutException:
            return {"error": "Timed out waiting for QR from Evolution API"}
        except Exception as e:
            return {"error": str(e)}

    def logout(self) -> dict:
        """Log out the WhatsApp instance. Returns {'success': true} or {'error': '...'}."""
        import httpx
        try:
            data = self._get(f"instance/logout/{self.instance}", timeout=15)
            return {"success": True, "data": data}
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 404:
                return {"error": "Logout endpoint not available. You may need to delete the session manually.", "hint": "Restart the Evolution API container or use instance/delete"}
            return {"error": str(e)}
        except Exception as e:
            return {"error": str(e)}

    def connection_status(self) -> dict:
        """Get current connection state of the instance."""
        try:
            data = self._get(f"instance/connectionState/{self.instance}", timeout=3)
            state = self._extract_state(data)
            if (state or "").lower() not in ("open", "connected", "syncing"):
                info_state = self._extract_state(self._fetch_instance_info())
                if (info_state or "").lower() in ("open", "connected", "syncing"):
                    state = info_state
            return {"state": state, "connected": (state or "").lower() in ("open", "connected", "syncing")}
        except Exception as e:
            info_state = self._extract_state(self._fetch_instance_info())
            if (info_state or "").lower() in ("open", "connected", "syncing"):
                return {"state": info_state, "connected": True}
            return {"state": "error", "error": str(e), "connected": False}

    def _safe_get(self, path: str, params: dict = None, timeout: int = 3):
        try:
            return self._get(path, params=params, timeout=timeout)
        except Exception as e:
            logger.debug(f"Evolution GET failed for {path}: {e}")
            return None

    def _safe_post(self, path: str, json_body: dict | None = None, timeout: int = 3):
        try:
            return self._post(path, json_body=json_body, timeout=timeout)
        except Exception as e:
            logger.debug(f"Evolution POST failed for {path}: {e}")
            return None

    def _fetch_instance_info(self) -> dict:
        data = self._safe_get("instance/fetchInstances")
        instances = data if isinstance(data, list) else (self._list_from_payload(data) or [])
        for inst in instances:
            name = inst.get("name") or inst.get("instanceName") or inst.get("instance", {}).get("instanceName")
            if name == self.instance:
                return inst
        return {}

    def _fetch_chats(self) -> Optional[list[dict]]:
        data = self._safe_post(f"chat/findChats/{self.instance}", {})
        chats = self._list_from_payload(data)
        if chats is not None:
            return chats
        data = self._safe_get(f"chat/findChats/{self.instance}")
        return self._list_from_payload(data)

    def _fetch_groups(self) -> Optional[list[dict]]:
        data = self._safe_get(
            f"group/fetchAllGroups/{self.instance}",
            params={"getParticipants": "false"},
            timeout=3,
        )
        return self._list_from_payload(data)

    def _extract_state(self, payload: dict) -> Optional[str]:
        if not isinstance(payload, dict):
            return None
        state = payload.get("state") or payload.get("connectionStatus")
        if state:
            return state
        inst = payload.get("instance")
        if isinstance(inst, dict):
            return inst.get("state") or inst.get("connectionStatus")
        return None

    def _list_from_payload(self, payload) -> Optional[list[dict]]:
        if isinstance(payload, list):
            return payload
        if not isinstance(payload, dict):
            return None
        for key in ("data", "chats", "groups", "messages", "records", "result", "response"):
            val = payload.get(key)
            if isinstance(val, list):
                return val
            if isinstance(val, dict):
                nested = self._list_from_payload(val)
                if nested is not None:
                    return nested
        return None

    def _count_groups(self, chats: list[dict]) -> int:
        return self._count_jid_suffix(chats, "@g.us")

    def _count_jid_suffix(self, chats: list[dict], suffix: str) -> int:
        return sum(1 for chat in chats if self._chat_jid(chat).endswith(suffix))

    def _count_communities(self, chats: list[dict]) -> int:
        return sum(1 for chat in chats if chat.get("isCommunity") or chat.get("community") or chat.get("isCommunityAnnounce"))

    def _chat_jid(self, chat: dict) -> str:
        return str(
            chat.get("id")
            or chat.get("jid")
            or chat.get("remoteJid")
            or chat.get("key", {}).get("remoteJid")
            or ""
        )

    def _first_value(self, payload: dict, *keys: str):
        if not isinstance(payload, dict):
            return None
        for key in keys:
            value = payload.get(key)
            if value:
                return value
        for value in payload.values():
            if isinstance(value, dict):
                nested = self._first_value(value, *keys)
                if nested:
                    return nested
        return None

    def _phone_from_jid(self, value) -> Optional[str]:
        if not value:
            return None
        number = str(value).split("@")[0]
        digits = "".join(ch for ch in number if ch.isdigit())
        return f"+{digits}" if digits else None

    def discover_jobs(self) -> list[SyncJob]:
        """Enumerate all joined groups as sync jobs."""
        try:
            data = self._get(
                f"group/fetchAllGroups/{self.instance}",
                params={"getParticipants": "false"},
                timeout=30,
            )
        except Exception as e:
            logger.warning(f"Cannot fetch WhatsApp groups: {e}")
            return self._cached_group_jobs()

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
            participants = g.get("size", 0) or len(g.get("participants", [])) or g.get("_count", {}).get("participants", 0)
            jobs.append(SyncJob(
                source=self.name,
                instance=self.instance,
                group_id=jid,
                group_name=name,
                meta={"participants": participants},
            ))
        return jobs

    def _cached_group_jobs(self) -> list[SyncJob]:
        """Fallback to groups already discovered in PropAI when Evolution rate-limits discovery."""
        try:
            from lab.app import storage
            if not storage:
                return []
            jobs = []
            for row in storage.get_sync_jobs(limit=500, source=self.name):
                try:
                    meta = json.loads(row.meta) if isinstance(row.meta, str) else (row.meta or {})
                except (TypeError, json.JSONDecodeError):
                    meta = {}
                if not row.group_id:
                    continue
                jobs.append(SyncJob(
                    source=self.name,
                    instance=self.instance,
                    group_id=row.group_id,
                    group_name=row.group_name or row.group_id,
                    meta=meta,
                ))
            return jobs
        except Exception as e:
            logger.warning(f"Cannot load cached WhatsApp groups: {e}")
            return []

    def fetch_records(self, job: SyncJob) -> Iterator[SourceRecord]:
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
                record = self._msg_to_record(msg, group_jid, job.group_name)
                if record:
                    yield record
            batch_offset += len(batch)
            time.sleep(SYNC_DELAY_S)
            if len(batch) < SYNC_BATCH_SIZE:
                break

    # ── Internal ─────────────────────────────────────────────

    def _fetch_batch(self, group_jid: str, count: int = SYNC_BATCH_SIZE,
                     offset: int = 0) -> list[dict]:
        """
        Fetch stored messages from Evolution API's database.
        Uses POST /chat/findMessages/{instance} (v2.3.7+).
        This only returns messages already stored by the API (webhook / live ingest).
        """
        page = (offset // count) + 1 if count > 0 else 1
        try:
            data = self._post(
                f"chat/findMessages/{self.instance}",
                json_body={
                    "where": {"key": {"remoteJid": group_jid}},
                    "limit": count,
                    "offset": offset,
                    "page": page,
                },
                timeout=30,
            )
        except Exception as e:
            logger.warning(f"Cannot fetch messages for {group_jid}: {e}")
            return []
        records = data.get("messages", {}).get("records", [])
        if not isinstance(records, list):
            return []
        return records

    def _msg_to_record(self, msg: dict, group_jid: str, group_name: str = "") -> Optional[SourceRecord]:
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
                "group_name": group_name,
                "message_type": list(msg_obj.keys()) if isinstance(msg_obj, dict) else [],
            },
        )
