from agents.building_enrichment.providers import (
    EnrichmentResult,
    _geocode_name_confidence,
    get_all_providers,
)
from agents.building_enrichment.worker import BuildingEnrichmentWorker


class FakeProvider:
    name = "google_places"
    confidence = 0.95

    def enrich(self, **kwargs):
        return EnrichmentResult(
            provider=self.name,
            confidence=self.confidence,
            fields={"address": "MS Gateway, Santacruz West"},
            source_url="https://example.test/place",
            source_record_id="place-1",
        )


class FakeStorage:
    def __init__(self):
        self.claimed = []
        self.completed = []
        self.history = []
        self.sources = []
        self.enriched = []
        self.updated = []
        self.suggestions = []

    def claim_building_job(self, job_id, provider=None):
        self.claimed.append((job_id, provider))
        return True

    def get_building(self, building_db_id=None, **kwargs):
        return {"id": building_db_id, "canonical_name": "MS Gateway", "micro_market": "Santacruz West"}

    def update_building_from_enrichment(self, *args):
        self.updated.append(args)
        return True

    def record_enrichment_sources(self, *args):
        self.sources.append(args)

    def mark_building_enriched(self, *args):
        self.enriched.append(args)
        return True

    def add_enrichment_history(self, *args, **kwargs):
        self.history.append((args, kwargs))
        return True

    def complete_building_job(self, *args):
        self.completed.append(args)
        return True

    def create_enrichment_review_suggestion(self, *args):
        self.suggestions.append(args)
        return 101


def test_unassigned_job_is_claimed_with_configured_provider_without_sqlite_calls():
    storage = FakeStorage()
    worker = BuildingEnrichmentWorker(storage, {"provider": "google_places"})
    worker.providers = [FakeProvider()]

    assert worker._process_job({"id": 7, "building_id": 42, "provider": "unassigned"})
    assert storage.claimed == [(7, "google_places")]
    assert storage.enriched == [(42, "google_places", 0.95)]
    assert storage.sources
    assert storage.history[0][0][2] == "enriched"
    assert storage.completed == [(7, True)]


def test_low_confidence_result_is_reviewed_without_marking_building_enriched():
    storage = FakeStorage()
    provider = FakeProvider()
    provider.confidence = 0.4
    worker = BuildingEnrichmentWorker(storage, {"provider": "google_places"})
    worker.providers = [provider]

    assert worker._process_job({"id": 8, "building_id": 43, "provider": "unassigned"})
    assert storage.claimed == [(8, "google_places")]
    assert storage.suggestions
    assert storage.history[0][0][2] == "needs_review"
    assert storage.updated == []
    assert storage.sources == []
    assert storage.enriched == []
    assert storage.completed == [(8, True)]


def test_igr_provider_is_not_auto_registered():
    assert "igr" not in {provider.name for provider in get_all_providers({})}


def test_geocoder_rejects_generic_building_name_match():
    assert _geocode_name_confidence(
        "By Apartment",
        {"formatted_address": "Apartment Road, Worli, Mumbai"},
    ) == 0.0


def test_geocoder_accepts_distinctive_building_name_match():
    assert _geocode_name_confidence(
        "Juhu Abhishek",
        {"formatted_address": "Juhu Abhishek, Four Bungalows, Mumbai"},
    ) == 0.95
