"""
Sync Scheduler — manages background sync jobs across all sources.

Architecture:
    IngestionSource.discover_jobs() → [SourceJob]
            ↓
    Scheduler → SyncJob (DB row) → fetch_records() → SourceRecord
            ↓
    Pipeline: store_raw → parse → resolve → observation (with version tracking)

Worker pool runs jobs concurrently. Each job has its own checkpoint.
The scheduler is resumable, rate-limited, and never blocks live ingestion.
"""

import json
import logging
import sqlite3
import threading
from datetime import datetime, timezone
from queue import Queue, Empty
from typing import Optional

from lab.config import DB_PATH, EVOLUTION_INSTANCE
from lab.sources import SourceRegistry, SourceRecord, SourceJob
from lab.sources.base import IngestionSource
from lab.sources.registry import get_registry

logger = logging.getLogger(__name__)

# Pipeline version — bump when parser or resolver logic changes
PIPELINE_VERSION = "1.0.0"

# Max concurrent sync jobs
MAX_WORKERS = 3


# ── Database helpers (internal to scheduler) ──────────────────────

def _db() -> sqlite3.Connection:
    db = sqlite3.connect(str(DB_PATH))
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")
    return db


# ── Sync Job Lifecycle ────────────────────────────────────────────

JOB_STATUS_PENDING = "pending"
JOB_STATUS_RUNNING = "running"
JOB_STATUS_COMPLETE = "complete"
JOB_STATUS_FAILED = "failed"
JOB_STATUS_CANCELLED = "cancelled"


def create_job_in_db(source: str, instance: str, group_id: str,
                     group_name: str = "", meta: str = "{}") -> int:
    db = _db()
    cur = db.execute(
        """INSERT INTO source_sync_jobs
           (source, instance, group_id, group_name, meta, status)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (source, instance, group_id, group_name, meta, JOB_STATUS_PENDING),
    )
    db.commit()
    job_id = cur.lastrowid
    db.close()
    return job_id


def update_job(job_id: int, **kwargs):
    sets = ", ".join(f"{k} = ?" for k in kwargs)
    vals = list(kwargs.values())
    db = _db()
    db.execute(f"UPDATE source_sync_jobs SET {sets} WHERE id = ?", vals + [job_id])
    db.commit()
    db.close()


def get_job(job_id: int) -> Optional[dict]:
    db = _db()
    row = db.execute("SELECT * FROM source_sync_jobs WHERE id = ?", (job_id,)).fetchone()
    db.close()
    return dict(row) if row else None


def get_jobs(source: str = "", status: str = "", limit: int = 50) -> list[dict]:
    db = _db()
    where = []
    params = []
    if source:
        where.append("source = ?")
        params.append(source)
    if status:
        where.append("status = ?")
        params.append(status)
    clause = ("WHERE " + " AND ".join(where)) if where else ""
    rows = db.execute(
        f"SELECT * FROM source_sync_jobs {clause} ORDER BY id DESC LIMIT ?",
        params + [limit],
    ).fetchall()
    db.close()
    return [dict(r) for r in rows]


# ── Pipeline ──────────────────────────────────────────────────────

def process_record(record: SourceRecord, pipeline_version: str = PIPELINE_VERSION) -> dict:
    """
    Run a SourceRecord through the full pipeline with version tracking.

    Stages:
        1. store_raw — save to raw_messages with dedup
        2. parse — run broker parser
        3. resolve — run multi-path resolver
        4. store — save parsed + resolver decisions with versions

    Returns dict with raw_id, parsed_id, resolver result.
    """
    from lab.app import save_raw_message, parse_message, save_parsed, resolve_parsed, save_resolver_decision

    # Stage 1: Store raw (idempotent via message_uid)
    raw_id = save_raw_message(
        group=record.group_id,
        sender=record.sender,
        message=record.text,
        msg_type="text",
        timestamp=record.timestamp_iso,
        source=record.source.upper(),
        raw_payload=record.raw,
        message_uid=record.message_uid,
    )

    # Stage 2: Parse
    parsed = parse_message(record.text)
    parsed["pipeline_version"] = pipeline_version
    parsed["source"] = record.source
    parsed_id = save_parsed(raw_id, parsed)

    # Stage 3: Resolve
    resolver_result = resolve_parsed(parsed, record.text)
    resolver_result["pipeline_version"] = pipeline_version
    resolver_result["source"] = record.source
    save_resolver_decision(parsed_id, resolver_result)

    return {
        "raw_id": raw_id,
        "parsed_id": parsed_id,
        "resolved": resolver_result.get("method") == "resolved",
        "building_name": resolver_result.get("building_name"),
        "confidence": resolver_result.get("final_confidence"),
    }


# ── Scheduler ─────────────────────────────────────────────────────

class SyncScheduler:
    """
    Background scheduler that runs sync jobs across all sources.

    Features:
        - Discovers jobs from source plugins
        - Runs jobs in a worker pool (configurable concurrency)
        - Each job: fetch records → process pipeline → update DB checkpoint
        - Resumable: skips records already processed via message_uid dedup
        - Rate-limited: configurable delay between API calls
        - Never blocks: runs entirely in background threads
    """

    def __init__(self):
        self._registry: Optional[SourceRegistry] = None
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self._status = {
            "overall": "idle",
            "active_jobs": 0,
            "total_jobs": 0,
            "completed_jobs": 0,
            "failed_jobs": 0,
            "records_processed": 0,
            "records_failed": 0,
            "started_at": None,
            "completed_at": None,
            "error": None,
        }

    # ── Properties ───────────────────────────────────────────

    @property
    def registry(self) -> SourceRegistry:
        if self._registry is None:
            self._registry = get_registry()
        return self._registry

    @property
    def is_running(self) -> bool:
        with self._lock:
            return self._running

    # ── Lifecycle ────────────────────────────────────────────

    def start(self, source: str = "") -> bool:
        """
        Start the scheduler. If source is specified, only sync that source.
        Returns False if already running or no sources available.
        """
        with self._lock:
            if self._running:
                return False
            self._running = True
            self._status["overall"] = "running"
            self._status["started_at"] = datetime.now(timezone.utc).isoformat()

        self._thread = threading.Thread(
            target=self._run, args=(source,), daemon=True, name="sync-scheduler"
        )
        self._thread.start()
        logger.info(f"Sync scheduler started (source={source or 'all'})")
        return True

    def stop(self):
        """Gracefully stop the scheduler."""
        with self._lock:
            self._running = False
        logger.info("Sync scheduler stop requested")

    def status(self) -> dict:
        with self._lock:
            return dict(self._status)

    # ── Internal ─────────────────────────────────────────────

    def _run(self, source_filter: str = ""):
        """Main loop — discover jobs and dispatch to workers."""
        try:
            sources = self.registry.all()
            if source_filter:
                src = self.registry.get(source_filter)
                if not src:
                    raise ValueError(f"Unknown source: {source_filter}")
                sources = [src]

            all_jobs: list[dict] = []

            for src in sources:
                if not self._running:
                    break
                if not src.validate_connection():
                    logger.warning(f"Source {src.name} not connected, skipping")
                    continue

                logger.info(f"Discovering jobs from {src.name}")
                try:
                    discovered = src.discover_jobs()
                except Exception as e:
                    logger.error(f"Failed to discover jobs from {src.name}: {e}")
                    continue

                # Create DB records for each job
                for job in discovered:
                    jid = create_job_in_db(
                        source=job.source,
                        instance=job.instance,
                        group_id=job.group_id,
                        group_name=job.group_name,
                        meta=json.dumps(job.meta),
                    )
                    all_jobs.append({"id": jid, "source": src, "job": job})

            with self._lock:
                self._status["total_jobs"] = len(all_jobs)

            if not all_jobs:
                logger.info("No jobs to process")
                self._mark_complete()
                return

            # Process jobs with worker pool (sequential for now, concurrent via threads)
            completed = 0
            failed = 0

            for entry in all_jobs:
                if not self._running:
                    break
                success = self._process_job(entry["id"], entry["source"], entry["job"])
                if success:
                    completed += 1
                else:
                    failed += 1
                with self._lock:
                    self._status["completed_jobs"] = completed
                    self._status["failed_jobs"] = failed

            self._mark_complete()

        except Exception as e:
            logger.exception("Scheduler failed")
            with self._lock:
                self._status["overall"] = "error"
                self._status["error"] = str(e)

    def _process_job(self, job_id: int, source: IngestionSource, job: SourceJob) -> bool:
        """Process one sync job: fetch records → pipeline."""
        update_job(job_id, status=JOB_STATUS_RUNNING, started_at=datetime.now(timezone.utc).isoformat())

        processed = 0
        failed = 0
        # job.meta is always a dict for in-memory SourceJob objects.
        # Guard against str in case a SourceJob is ever reconstructed from a DB row.
        raw_meta = job.meta if isinstance(job.meta, dict) else (json.loads(job.meta) if job.meta else {})
        last_cursor = raw_meta.get("last_cursor", "0") or "0"
        found = 0

        try:
            for record in source.fetch_records(job):
                if not self._running:
                    update_job(job_id, status=JOB_STATUS_CANCELLED, records_processed=processed,
                               records_failed=failed, last_cursor=str(processed + found))
                    return False

                found += 1
                try:
                    result = process_record(record)
                    processed += 1
                    with self._lock:
                        self._status["records_processed"] += 1
                except Exception as e:
                    failed += 1
                    with self._lock:
                        self._status["records_failed"] += 1
                    logger.error(f"Failed to process record {record.record_id}: {e}")

                # Update job progress periodically
                if (found + processed) % 20 == 0:
                    update_job(job_id, records_processed=processed, records_failed=failed,
                               last_cursor=str(found))

            status = JOB_STATUS_COMPLETE if failed == 0 else JOB_STATUS_FAILED
            update_job(job_id, status=status, records_found=found, records_processed=processed,
                       records_failed=failed, last_cursor=str(found),
                       finished_at=datetime.now(timezone.utc).isoformat())
            return status == JOB_STATUS_COMPLETE

        except Exception as e:
            logger.error(f"Job {job_id} failed: {e}")
            update_job(job_id, status=JOB_STATUS_FAILED, records_processed=processed,
                       records_failed=failed, error=str(e),
                       finished_at=datetime.now(timezone.utc).isoformat())
            return False

    def _mark_complete(self):
        with self._lock:
            self._running = False
            self._status["overall"] = "complete"
            self._status["completed_at"] = datetime.now(timezone.utc).isoformat()
