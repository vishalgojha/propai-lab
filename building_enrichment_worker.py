"""Standalone building enrichment worker entrypoint.

Runs as a separate Coolify service so enrichment jobs do not share threads or
request latency with the API process.
"""

from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timezone

from extraction import get_storage
from agents.building_enrichment.worker import BuildingEnrichmentWorker


def heartbeat_payload(*, status: str, config: dict, last_error: str | None = None) -> dict:
    """Return non-secret runtime evidence for the Super Admin worker view."""
    return {
        "worker_name": "building-enrichment-worker",
        "service_name": os.getenv("COOLIFY_RESOURCE_NAME", "building-enrichment-worker"),
        "status": status,
        "heartbeat_at": datetime.now(timezone.utc).isoformat(),
        "runtime_version": (
            os.getenv("COOLIFY_COMMIT_SHA")
            or os.getenv("GIT_COMMIT_SHA")
            or os.getenv("COOLIFY_BRANCH")
            or "unknown"
        ),
        "last_error": last_error,
        "config": config,
    }


def write_heartbeat(storage, *, status: str, config: dict, last_error: str | None = None) -> None:
    payload = heartbeat_payload(status=status, config=config, last_error=last_error)
    storage.client.table("worker_heartbeats").upsert(payload, on_conflict="worker_name").execute()


def main() -> None:
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    storage = get_storage()
    batch_size = int(os.getenv("BUILDING_ENRICHMENT_WORKER_BATCH_SIZE", "10"))
    concurrency = int(os.getenv("BUILDING_ENRICHMENT_WORKER_CONCURRENCY", "10"))
    poll_interval = int(os.getenv("BUILDING_ENRICHMENT_WORKER_POLL_SECONDS", "30"))
    confidence_threshold = float(os.getenv("BUILDING_ENRICHMENT_CONFIDENCE_THRESHOLD", "0.7"))
    max_retries = int(os.getenv("BUILDING_ENRICHMENT_MAX_RETRIES", "3"))
    web_search_enabled = os.getenv("BUILDING_ENRICHMENT_WEB_SEARCH_ENABLED", "false").lower() in {
        "1", "true", "yes", "on"
    }
    max_web_searches_per_day = int(os.getenv("BUILDING_ENRICHMENT_WEB_SEARCH_MAX_PER_DAY", "50"))

    worker = BuildingEnrichmentWorker(
        storage,
        config={
            "batch_size": batch_size,
            "concurrency": concurrency,
            "poll_interval": poll_interval,
            "confidence_threshold": confidence_threshold,
            "max_retries": max_retries,
            "web_search_enabled": web_search_enabled,
            "max_web_searches_per_day": max_web_searches_per_day,
        },
    )
    worker.start()

    worker_config = {
        "batch_size": batch_size,
        "concurrency": concurrency,
        "poll_interval": poll_interval,
        "confidence_threshold": confidence_threshold,
        "max_retries": max_retries,
        "web_search_enabled": web_search_enabled,
        "max_web_searches_per_day": max_web_searches_per_day,
    }

    try:
        write_heartbeat(storage, status="running", config=worker_config)
    except Exception:
        logging.getLogger(__name__).exception("Unable to write initial building worker heartbeat")

    print(
        "Building enrichment worker started "
        f"(batch_size={batch_size}, concurrency={concurrency}, "
        f"poll_interval={poll_interval}s, confidence_threshold={confidence_threshold:.2f})",
        flush=True,
    )

    try:
        last_heartbeat = 0.0
        while True:
            time.sleep(60)
            now = time.monotonic()
            if now - last_heartbeat >= 30:
                try:
                    write_heartbeat(storage, status="running", config=worker_config)
                    last_heartbeat = now
                except Exception:
                    logging.getLogger(__name__).exception("Unable to write building worker heartbeat")
    except KeyboardInterrupt:
        try:
            write_heartbeat(storage, status="stopped", config=worker_config)
        except Exception:
            logging.getLogger(__name__).exception("Unable to write stopped building worker heartbeat")
        worker.stop()


if __name__ == "__main__":
    main()
