"""Standalone building enrichment worker entrypoint.

Runs as a separate Coolify service so enrichment jobs do not share threads or
request latency with the API process.
"""

from __future__ import annotations

import logging
import os
import time

from extraction import get_storage
from agents.building_enrichment.worker import BuildingEnrichmentWorker


def main() -> None:
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    storage = get_storage()
    batch_size = int(os.getenv("BUILDING_ENRICHMENT_WORKER_BATCH_SIZE", "10"))
    poll_interval = int(os.getenv("BUILDING_ENRICHMENT_WORKER_POLL_SECONDS", "30"))
    confidence_threshold = float(os.getenv("BUILDING_ENRICHMENT_CONFIDENCE_THRESHOLD", "0.7"))
    max_retries = int(os.getenv("BUILDING_ENRICHMENT_MAX_RETRIES", "3"))

    worker = BuildingEnrichmentWorker(
        storage,
        config={
            "batch_size": batch_size,
            "poll_interval": poll_interval,
            "confidence_threshold": confidence_threshold,
            "max_retries": max_retries,
        },
    )
    worker.start()

    print(
        "Building enrichment worker started "
        f"(batch_size={batch_size}, poll_interval={poll_interval}s, confidence_threshold={confidence_threshold:.2f})",
        flush=True,
    )

    try:
        while True:
            time.sleep(60)
    except KeyboardInterrupt:
        worker.stop()


if __name__ == "__main__":
    main()
