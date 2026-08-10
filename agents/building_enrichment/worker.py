"""Building Enrichment Worker - Background processing of building enrichment jobs."""

import time
import logging
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Optional
from datetime import datetime, timezone

from .providers import get_all_providers, EnrichmentResult

logger = logging.getLogger(__name__)


class BuildingEnrichmentWorker:
    """Background worker that processes building enrichment jobs.

    This worker:
    1. Picks up pending jobs from the queue
    2. Runs enrichment through configured providers
    3. Updates building profiles with enriched data
    4. Creates AI suggestions for low-confidence matches
    5. Tracks enrichment history
    """

    def __init__(self, storage, config: dict = None):
        self.storage = storage
        self.config = config or {}
        self.running = False
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()

        # Configuration
        self.batch_size = self.config.get("batch_size", 10)
        self.concurrency = max(1, int(self.config.get("concurrency", 1)))
        self.poll_interval = self.config.get("poll_interval", 30)  # seconds
        self.confidence_threshold = self.config.get("confidence_threshold", 0.7)
        self.max_retries = self.config.get("max_retries", 3)
        self.preferred_provider = self.config.get("provider") or "google_places"

        # Initialize providers
        self.providers = get_all_providers(config)

    def start(self):
        """Start the background worker."""
        if self.running:
            logger.warning("Worker already running")
            return

        self.running = True
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()
        logger.info("Building enrichment worker started")

    def stop(self):
        """Stop the background worker."""
        self.running = False
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=10)
        logger.info("Building enrichment worker stopped")

    def _run_loop(self):
        """Main worker loop."""
        while self.running and not self._stop_event.is_set():
            try:
                processed = self._process_batch()
                if processed == 0:
                    # No jobs to process, wait longer
                    self._stop_event.wait(self.poll_interval)
                else:
                    # Processed some jobs, wait briefly
                    self._stop_event.wait(1)
            except Exception as e:
                logger.error(f"Worker loop error: {e}", exc_info=True)
                self._stop_event.wait(5)

    def _process_batch(self) -> int:
        """Process a batch of pending jobs.

        Returns:
            Number of jobs processed
        """
        jobs = self.storage.get_pending_building_jobs(limit=self.batch_size)
        if not jobs:
            return 0

        # Jobs are claimed atomically by storage, so bounded concurrency is
        # safe even if another worker polls the same queue. Keep the executor
        # bounded: enrichment is network-bound, but unbounded threads would
        # create provider bursts and exhaust database connections.
        jobs = jobs[: self.batch_size]
        processed = 0
        with ThreadPoolExecutor(max_workers=self.concurrency, thread_name_prefix="building-enrich") as pool:
            futures = [pool.submit(self._process_job, job) for job in jobs if self.running]
            for future in as_completed(futures):
                processed += 1
                try:
                    future.result()
                except Exception:
                    # _process_job normally records failures itself. Keep the
                    # batch alive if an adapter/provider raises unexpectedly.
                    logger.exception("Unexpected building enrichment job failure")

        return processed

    def _process_job(self, job: dict) -> bool:
        """Process a single enrichment job.

        Args:
            job: Job record from database

        Returns:
            True if successful, False otherwise
        """
        job_id = job["id"]
        building_db_id = job["building_id"]
        provider_name = job.get("provider") or ""

        # Older discovery rows were created with provider='unassigned'. Pick
        # a configured provider at claim time so those rows become runnable;
        # do not require a destructive queue migration.
        provider_names = {p.name for p in self.providers}
        if provider_name not in provider_names:
            if self.preferred_provider in provider_names:
                provider_name = self.preferred_provider
            elif self.providers:
                provider_name = self.providers[0].name
            else:
                logger.error("No building enrichment provider is configured")
                self.storage.complete_building_job(job_id, False, "No provider configured")
                return False

        # Claim the job
        if not self.storage.claim_building_job(job_id, provider=provider_name):
            logger.warning(f"Failed to claim job {job_id}")
            return False

        # Get the provider
        provider = None
        for p in self.providers:
            if p.name == provider_name:
                provider = p
                break

        if not provider:
            logger.error(f"Provider {provider_name} not found")
            self.storage.complete_building_job(job_id, False, f"Provider {provider_name} not found")
            return False

        # Get building info
        building = self.storage.get_building(building_db_id=building_db_id)
        if not building:
            logger.error(f"Building {building_db_id} not found")
            self.storage.complete_building_job(job_id, False, f"Building {building_db_id} not found")
            return False

        try:
            # Run enrichment
            logger.info(f"Enriching {building['canonical_name']} with {provider_name}")
            result = provider.enrich(
                building_name=building["canonical_name"],
                canonical_name=building["canonical_name"],
                micro_market=building.get("micro_market"),
                address=building.get("address"),
                pincode=building.get("pincode"),
            )

            if result.error and not result.fields:
                # Provider returned an error with no data
                logger.warning(f"Enrichment failed for {building['canonical_name']}: {result.error}")
                self.storage.complete_building_job(job_id, False, result.error)
                self.storage.add_enrichment_history(
                    building_db_id, provider_name, "failed",
                    details={"error": result.error}, job_id=job_id
                )
                return False

            # Apply enriched data
            if result.fields:
                confidence = result.confidence

                if confidence >= self.confidence_threshold:
                    # Auto-apply high confidence data
                    self.storage.update_building_from_enrichment(
                        building_db_id, result.fields, provider_name, confidence
                    )
                    self.storage.add_enrichment_history(
                        building_db_id, provider_name, "enriched",
                        fields_updated=list(result.fields.keys()),
                        confidence=confidence,
                        details={"source_url": result.source_url},
                        job_id=job_id
                    )
                    logger.info(f"Enriched {building['canonical_name']} with {provider_name} "
                               f"(confidence: {confidence:.0%})")
                else:
                    # Low confidence - create AI suggestion for review
                    self._create_review_suggestion(building, result, job_id)
                    self.storage.add_enrichment_history(
                        building_db_id, provider_name, "needs_review",
                        fields_updated=list(result.fields.keys()),
                        confidence=confidence,
                        details={"source_url": result.source_url},
                        job_id=job_id
                    )

                    self.storage.complete_building_job(job_id, True)
                    return True

                # Keep the database adapter-specific writes in storage.  The
                # old implementation used SQLite cursor/commit calls here, so
                # the first Supabase job crashed after the provider returned.
                self.storage.record_enrichment_sources(
                    building_db_id, provider_name, result.fields,
                    result.confidence, result.source_url, result.source_record_id,
                )
                self.storage.mark_building_enriched(
                    building_db_id, provider_name, result.confidence
                )

            # Mark job as completed
            self.storage.complete_building_job(job_id, True)
            return True

        except Exception as e:
            logger.error(f"Enrichment error for {building['canonical_name']}: {e}", exc_info=True)
            self.storage.complete_building_job(job_id, False, str(e))
            self.storage.add_enrichment_history(
                building_db_id, provider_name, "failed",
                details={"error": str(e)}, job_id=job_id
            )
            return False

    def _create_review_suggestion(self, building: dict, result: EnrichmentResult, job_id: int):
        """Create an AI suggestion for low-confidence enrichment data."""
        self.storage.create_enrichment_review_suggestion(building, result, job_id)

    def enrich_building(self, building_db_id: int, provider: str = None) -> bool:
        """Manually trigger enrichment for a specific building.

        Args:
            building_db_id: Database ID of the building
            provider: Specific provider to use (None = all providers)

        Returns:
            True if enrichment was triggered
        """
        if provider:
            return self.storage.create_building_enrichment_job(building_db_id, provider, priority=10)
        else:
            for p in self.providers:
                self.storage.create_building_enrichment_job(building_db_id, p.name, priority=10)
            return True

    def get_status(self) -> dict:
        """Get worker status."""
        return {
            "running": self.running,
            "providers": [p.name for p in self.providers],
            "batch_size": self.batch_size,
            "concurrency": self.concurrency,
            "poll_interval": self.poll_interval,
            "confidence_threshold": self.confidence_threshold,
            "preferred_provider": self.preferred_provider,
        }
