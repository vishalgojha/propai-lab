"""Tenant-scoped Google Sheets snapshot worker for broker inventory."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from extraction import get_storage
from services.google_drive import connection_token, drive_request
from services.google_drive_export import export_values

LOG = logging.getLogger("google-drive-sync")
def _values(rows: list[dict]) -> list[list[str]]:
    return export_values(rows)


def _create_folder(token: str, name: str) -> str:
    created = drive_request("POST", "https://www.googleapis.com/drive/v3/files", token, json={"name": name, "mimeType": "application/vnd.google-apps.folder"})
    return created["id"]


def sync_export(storage, export: dict) -> dict:
    tenant_id = str(export["tenant_id"])
    connection = (storage.client.table("google_drive_connections").select("*").eq("tenant_id", tenant_id).limit(1).execute().data or [None])[0]
    if not connection:
        raise RuntimeError("Google Drive connection not found")
    token = connection_token(connection)
    folder_id = export.get("folder_id") or _create_folder(token, f"PropAI Inventory - Export {export['id']}")
    if not export.get("file_id"):
        file = drive_request("POST", "https://www.googleapis.com/drive/v3/files", token, json={"name": export.get("file_name") or "PropAI Inventory - Current", "mimeType": "application/vnd.google-apps.spreadsheet", "parents": [folder_id]})
        file_id = file["id"]
    else:
        file_id = export["file_id"]
    inventory_ids = [int(value) for value in (export.get("inventory_ids") or []) if str(value).isdigit()]
    query = storage.client.table("crm_inventory").select("*").eq("tenant_id", tenant_id)
    if inventory_ids:
        query = query.in_("id", inventory_ids)
    rows = query.order("updated_at", desc=True).limit(5000).execute().data or []
    values = _values(rows)
    checksum = hashlib.sha256(json.dumps(values, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    drive_request("POST", f"https://sheets.googleapis.com/v4/spreadsheets/{file_id}/values/Inventory:clear", token, json={})
    drive_request("PUT", f"https://sheets.googleapis.com/v4/spreadsheets/{file_id}/values/Inventory!A1:M{max(1, len(values))}", token, params={"valueInputOption": "RAW"}, json={"range": "Inventory!A1", "majorDimension": "ROWS", "values": values})
    now = datetime.now(timezone.utc).isoformat()
    storage.client.table("google_drive_exports").update({"folder_id": folder_id, "file_id": file_id, "last_checksum": checksum, "last_row_count": len(rows), "last_attempted_at": now, "last_success_at": now, "last_error": None, "updated_at": now}).eq("id", export["id"]).execute()
    return {"export_id": export["id"], "rows": len(rows), "checksum": checksum}


def main() -> None:
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
    storage = get_storage()
    poll = max(15, int(os.getenv("GOOGLE_DRIVE_SYNC_POLL_SECONDS", "60")))
    LOG.info("Google Drive sync worker started poll=%ss", poll)
    while True:
        jobs = storage.client.table("google_drive_sync_jobs").select("*").eq("status", "pending").order("scheduled_at").limit(20).execute().data or []
        for job in jobs:
            export = (storage.client.table("google_drive_exports").select("*").eq("id", job["export_id"]).eq("status", "active").limit(1).execute().data or [None])[0]
            if not export:
                storage.client.table("google_drive_sync_jobs").update({"status": "completed", "completed_at": datetime.now(timezone.utc).isoformat()}).eq("id", job["id"]).execute()
                continue
            claimed = storage.client.table("google_drive_sync_jobs").update({"status": "running", "started_at": datetime.now(timezone.utc).isoformat(), "attempts": int(job.get("attempts") or 0) + 1}).eq("id", job["id"]).eq("status", "pending").execute().data or []
            if not claimed:
                continue
            try:
                sync_export(storage, export)
                storage.client.table("google_drive_sync_jobs").update({"status": "completed", "completed_at": datetime.now(timezone.utc).isoformat(), "error": None}).eq("id", job["id"]).execute()
            except Exception as exc:
                LOG.exception("Drive export failed export_id=%s", export.get("id"))
                now = datetime.now(timezone.utc).isoformat()
                storage.client.table("google_drive_sync_jobs").update({"status": "failed", "completed_at": now, "error": str(exc)[:1000]}).eq("id", job["id"]).execute()
                storage.client.table("google_drive_exports").update({"last_attempted_at": now, "last_error": str(exc)[:1000]}).eq("id", export["id"]).execute()
        time.sleep(poll)


if __name__ == "__main__":
    main()
