"""Building Enrichment Worker - Background processing of building enrichment jobs."""

import time
import logging
import threading
from datetime import datetime, timedelta, timezone
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
        self.max_web_searches_per_day = max(0, int(self.config.get("max_web_searches_per_day", 50)))
        self.preferred_provider = self.config.get("provider") or "crawl4ai"

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
        recover = getattr(self.storage, "recover_stale_building_jobs", None)
        if recover:
            recover(max_attempts=self.max_retries)
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

        def fail(error: str) -> bool:
            retry = getattr(self.storage, "retry_building_job", None)
            next_status = (
                retry(job_id, error, max_attempts=self.max_retries)
                if retry else None
            )
            if next_status is None:
                self.storage.complete_building_job(job_id, False, error)
                next_status = "failed"
            self.storage.add_enrichment_history(
                building_db_id,
                provider_name or "unassigned",
                "retry_scheduled" if next_status == "pending" else "failed",
                details={"error": error, "next_status": next_status},
                job_id=job_id,
            )
            return False

        # Older discovery rows were created with provider='unassigned'. Pick
        # a configured provider at claim time so those rows become runnable;
        # do not require a destructive queue migration.
        provider_names = {p.name for p in self.providers}
        if not provider_names:
            # Missing packages, API keys, or disabled providers are
            # configuration state, not transient building failures. Do not
            # retry these jobs forever and flood the queue with identical
            # errors; retain the job as failed for an operator to requeue
            # after the provider is made available.
            self.storage.complete_building_job(
                job_id, False, "No configured enrichment provider is available"
            )
            self.storage.add_enrichment_history(
                building_db_id,
                provider_name or "unassigned",
                "configuration_unavailable",
                details={"available_providers": []},
                job_id=job_id,
            )
            logger.error("No configured building enrichment provider is available")
            return False
        if provider_name not in provider_names:
            if self.preferred_provider in provider_names:
                provider_name = self.preferred_provider
            elif self.providers:
                provider_name = self.providers[0].name
            else:
                logger.error("No building enrichment provider is configured")
                return fail("No provider configured")

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
            return fail(f"Provider {provider_name} not found")

        if provider_name == "crawl4ai":
            count_recent = getattr(self.storage, "count_recent_enrichment_actions", None)
            if count_recent and self.max_web_searches_per_day:
                used = count_recent("crawl4ai", "web_search_attempt")
                if used >= self.max_web_searches_per_day:
                    self.storage.add_enrichment_history(
                        building_db_id, "crawl4ai", "web_search_budget_exhausted",
                        details={"daily_limit": self.max_web_searches_per_day, "used": used},
                        job_id=job_id,
                    )
                    defer = getattr(self.storage, "defer_building_job", None)
                    if defer:
                        tomorrow = (datetime.now(timezone.utc) + timedelta(days=1)).replace(
                            hour=0, minute=5, second=0, microsecond=0
                        ).isoformat()
                        defer(job_id, tomorrow, "Crawl4AI daily budget reached")
                    else:
                        self.storage.complete_building_job(job_id, True)
                    logger.warning("Crawl4AI daily budget reached; deferring building %s", building_db_id)
                    return False
            self.storage.add_enrichment_history(
                building_db_id, "crawl4ai", "web_search_attempt", job_id=job_id
            )

        # Get building info
        building = self.storage.get_building(building_db_id=building_db_id)
        if not building:
            logger.error(f"Building {building_db_id} not found")
            return fail(f"Building {building_db_id} not found")

        try:
            # Run enrichment
            logger.info(f"Enriching {building['canonical_name']} with {provider_name}")
            evidence_loader = getattr(self.storage, "get_building_resolution_evidence", None)
            resolution_evidence = evidence_loader(building_db_id) if evidence_loader else {}
            result = provider.enrich(
                building_name=building["canonical_name"],
                canonical_name=building["canonical_name"],
                micro_market=building.get("micro_market"),
                address=building.get("address"),
                pincode=building.get("pincode"),
                resolution_evidence=resolution_evidence,
            )

            # Web discovery is deliberately a first step, not the final
            # authority. Verify an explicit spelling correction with Places
            # before applying coordinates or marking the building enriched.
            web_resolved_name = (result.raw_data or {}).get("resolved_name") if provider_name == "crawl4ai" else None
            if web_resolved_name:
                web_discovery_data = dict(result.raw_data or {})
                google = next((candidate for candidate in self.providers if candidate.name == "google_places"), None)
                if google:
                    verified = google.enrich(
                        building_name=building["canonical_name"],
                        canonical_name=web_resolved_name,
                        micro_market=building.get("micro_market"),
                        address=building.get("address"),
                        pincode=building.get("pincode"),
                        resolution_evidence=resolution_evidence,
                    )
                    if verified.fields and verified.confidence >= self.confidence_threshold:
                        result.raw_data["web_discovery"] = {
                            "resolved_name": web_resolved_name,
                            "source_url": result.source_url,
                            "candidates": web_discovery_data.get("candidates", []),
                            "pages": web_discovery_data.get("pages", []),
                        }
                        result = verified
                        result.raw_data["web_provider"] = "crawl4ai"
                        result.raw_data["web_resolved_name"] = web_resolved_name
                    else:
                        return fail(
                            "Web candidate found but geocoder could not verify "
                            f"{web_resolved_name}: {verified.error or 'insufficient confidence'}"
                        )
                else:
                    return fail("Web candidate found but Google Places verification is unavailable")

            if not result.fields:
                # An empty result is never success. Cached failures used to lose
                # their error while being reconstructed and were consequently
                # marked completed here.
                error = result.error or "Provider returned no enrichment fields"
                logger.warning(f"Enrichment failed for {building['canonical_name']}: {error}")
                return fail(error)

            # Apply enriched data
            if result.fields:
                confidence = result.confidence

                if confidence >= self.confidence_threshold:
                    web_name = (result.raw_data or {}).get("web_resolved_name")
                    if web_name and web_name.casefold() != str(building.get("canonical_name") or "").casefold():
                        alias_writer = getattr(self.storage, "apply_web_building_alias", None)
                        if alias_writer:
                            alias_outcome = alias_writer(
                                building_db_id,
                                building.get("canonical_name") or "",
                                web_name,
                                confidence=min(confidence, 0.9),
                                source="crawl4ai",
                            )
                        else:
                            alias_writer = getattr(self.storage, "create_building_alias_for_building", None)
                            alias_outcome = {"action": "alias_only"}
                            if alias_writer:
                                alias_writer(
                                    building_db_id,
                                    building.get("canonical_name") or "",
                                    web_name,
                                    confidence=min(confidence, 0.9),
                                    source="crawl4ai",
                                )
                        if alias_writer:
                            self.storage.add_enrichment_history(
                                building_db_id, "crawl4ai", "alias_discovered",
                                fields_updated=["canonical_name"],
                                confidence=min(confidence, 0.9),
                                details={
                                    "resolved_name": web_name,
                                    "outcome": alias_outcome,
                                    "source_url": (result.raw_data.get("web_discovery") or {}).get("source_url", ""),
                                },
                                job_id=job_id,
                            )
                    # Auto-apply high confidence data
                    self.storage.update_building_from_enrichment(
                        building_db_id, result.fields, provider_name, confidence
                    )
                    backfill = getattr(self.storage, "backfill_linked_listings_from_building", None)
                    if backfill:
                        backfill(building_db_id, result.fields, confidence)
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
            return fail(str(e))

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
