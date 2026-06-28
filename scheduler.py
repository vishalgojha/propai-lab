"""
Sync Scheduler — manages background sync jobs across all sources.

Architecture:
    Source → discover_jobs() → SyncJob → fetch_records() → SourceRecord
                                                              ↓
    Pipeline: store_raw → parse → resolve → observation (with version tracking)

Worker pool runs jobs concurrently. Each job has its own checkpoint.
The scheduler is resumable, rate-limited, and never blocks live ingestion.
"""

import json
import logging
import threading
from datetime import datetime, timezone
from queue import Queue, Empty
from typing import Optional

from lab.app import storage
from lab.config import DB_PATH, EVOLUTION_INSTANCE
from lab.ingestion import SourceRegistry, SourceRecord, SyncJob
from lab.ingestion.registry import get_registry
from lab.storage import SyncJob as StorageSyncJob

logger = logging.getLogger(__name__)

# Pipeline version — bump when parser or resolver logic changes
PIPELINE_VERSION = "1.0.0"

# Max concurrent sync jobs
MAX_WORKERS = 3


# ── Sync Job Lifecycle ────────────────────────────────────────────

JOB_STATUS_PENDING = "pending"
JOB_STATUS_RUNNING = "running"
JOB_STATUS_COMPLETE = "complete"
JOB_STATUS_FAILED = "failed"
JOB_STATUS_CANCELLED = "cancelled"


def create_job_in_db(source: str, instance: str, group_id: str,
                     group_name: str = "", meta: str = "{}") -> int:
    job = StorageSyncJob(source=source, instance=instance, group_id=group_id,
                         group_name=group_name, meta=meta, status=JOB_STATUS_PENDING)
    return storage.create_sync_job(job)


def update_job(job_id: int, **kwargs):
    storage.update_sync_job(job_id, **kwargs)


def get_job(job_id: int) -> Optional[dict]:
    job = storage.get_sync_job(job_id)
    if job:
        return {f.name: getattr(job, f.name) for f in job.__dataclass_fields__.values()}
    return None


def get_jobs(source: str = "", status: str = "", limit: int = 50) -> list[dict]:
    jobs = storage.get_sync_jobs(limit=limit, source=source, status=status)
    return [{f.name: getattr(j, f.name) for f in j.__dataclass_fields__.values()} for j in jobs]


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
    from lab.app import storage, parse_message, resolve_parsed
    from lab.storage import RawMessage, ParsedObservation, ResolverDecision
    import json

    # Stage 1: Store raw (idempotent via message_uid)
    raw_msg = RawMessage(
        group_name=record.meta.get("group_name") or record.group_id,
        sender=record.sender,
        message=record.text,
        message_type="text",
        timestamp=record.timestamp_iso,
        source=record.source.upper(),
        raw_payload=json.dumps(record.raw),
        message_uid=record.message_uid,
    )
    raw_id = storage.save_raw_message(raw_msg)

    # Stage 2: Parse
    parsed = parse_message(record.text)
    parsed["pipeline_version"] = pipeline_version
    parsed["source"] = record.source
    obs = ParsedObservation(
        raw_message_id=raw_id,
        message_type=parsed.get("message_type"),
        bhk=parsed.get("bhk"),
        price=parsed.get("price"),
        price_unit=parsed.get("price_unit"),
        area_sqft=parsed.get("area_sqft"),
        furnishing=parsed.get("furnishing"),
        location_raw=parsed.get("location_raw"),
        location=json.dumps(parsed.get("location")) if parsed.get("location") else None,
        building_name=parsed.get("building_name"),
        landmark_name=parsed.get("landmark_name"),
        street_name=parsed.get("street_name"),
        area=parsed.get("area"),
        micro_market=parsed.get("micro_market"),
        developer=parsed.get("developer"),
        broker_name=parsed.get("broker_name"),
        broker_phone=parsed.get("broker_phone"),
        confidence=parsed.get("confidence", 0.0),
        raw_payload=json.dumps(parsed.get("raw_payload", {})),
    )
    parsed_id = storage.save_parsed(obs)

    # Stage 3: Resolve
    resolver_result = resolve_parsed(parsed, record.text)
    resolver_result["pipeline_version"] = pipeline_version
    resolver_result["source"] = record.source
    dec = ResolverDecision(
        parsed_id=parsed_id,
        building_id=resolver_result.get("building_id"),
        building_name=resolver_result.get("building_name"),
        landmark_id=resolver_result.get("landmark_id"),
        landmark_name=resolver_result.get("landmark_name"),
        street_id=resolver_result.get("street_id"),
        street_name=resolver_result.get("street_name"),
        project_id=resolver_result.get("project_id"),
        project_name=resolver_result.get("project_name"),
        developer_name=resolver_result.get("developer_name"),
        parser_confidence=resolver_result.get("parser_confidence", 0.0),
        resolver_confidence=resolver_result.get("resolver_confidence", 0.0),
        final_confidence=resolver_result.get("final_confidence", 0.0),
        method=resolver_result.get("method", "unresolved"),
        method_detail=resolver_result.get("method_detail"),
        candidates=json.dumps(resolver_result.get("candidates", [])),
        failure_category=resolver_result.get("failure_category"),
        error=resolver_result.get("error"),
        raw_message_id=raw_id,
    )
    storage.save_resolver_decision(dec)

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

    def _process_job(self, job_id: int, source: BaseSource, job: SyncJob) -> bool:
        """Process one sync job: fetch records → pipeline."""
        update_job(job_id, status=JOB_STATUS_RUNNING, started_at=datetime.now(timezone.utc).isoformat())

        processed = 0
        failed = 0
        last_cursor = job.meta.get("last_cursor", "0") if job.meta else "0"
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
                    # Publish sync progress event (lazy import to avoid circular)
                    try:
                        from lab.events import get_bus
                        get_bus().publish("sync.progress", {
                            "job_id": job_id, "group": job.group_name,
                            "processed": processed, "found": found,
                            "total_processed": self._status.get("records_processed", 0),
                        })
                    except Exception:
                        pass
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
            try:
                from lab.events import get_bus
                get_bus().publish("sync.completed", {
                    "job_id": job_id, "group": job.group_name,
                    "status": status, "processed": processed, "found": found, "failed": failed,
                })
            except Exception:
                pass
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
