import json
from agents.building_enrichment.providers import (
    EnrichmentResult,
    GooglePlacesProvider,
    _geocode_name_confidence,
    _locality_from_components,
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
        self.retries = []
        self.recovered = 0
        self.backfilled = []

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

    def backfill_linked_listings_from_building(self, *args):
        self.backfilled.append(args)
        return 1

    def add_enrichment_history(self, *args, **kwargs):
        self.history.append((args, kwargs))
        return True

    def complete_building_job(self, *args):
        self.completed.append(args)
        return True

    def retry_building_job(self, job_id, error, max_attempts=None):
        self.retries.append((job_id, error, max_attempts))
        return "pending"

    def recover_stale_building_jobs(self, max_attempts=None):
        self.recovered += 1
        return 0

    def create_enrichment_review_suggestion(self, *args):
        self.suggestions.append(args)
        return 101


class CacheRetryStorage(FakeStorage):
    """Storage double proving post-provider retries reuse durable results."""

    def __init__(self):
        super().__init__()
        self.cache = None
        self.fail_backfill = True

    def get_entity_enrichment_cache(self, *args, **kwargs):
        return self.cache

    def put_entity_enrichment_cache(self, *args, **kwargs):
        self.cache = {
            "confidence": 0.95,
            "source_url": "https://example.test/place",
            "source_record_id": "place-1",
            "result": {
                "fields": {"address": "MS Gateway, Santacruz West"},
                "raw_data": {},
                "error": "",
            },
        }
        return True

    def backfill_linked_listings_from_building(self, *args):
        if self.fail_backfill:
            self.fail_backfill = False
            raise RuntimeError("Supabase 409 during listing propagation")
        return super().backfill_linked_listings_from_building(*args)


def test_unassigned_job_is_claimed_with_configured_provider_without_sqlite_calls():
    storage = FakeStorage()
    worker = BuildingEnrichmentWorker(storage, {"provider": "google_places"})
    worker.providers = [FakeProvider()]

    assert worker._process_job({"id": 7, "building_id": 42, "provider": "unassigned"})
    assert storage.claimed == [(7, "google_places")]
    assert storage.enriched == [(42, "google_places", 0.95)]
    assert storage.sources
    assert storage.backfilled == [(42, {"address": "MS Gateway, Santacruz West"}, 0.95)]
    assert storage.history[0][0][2] == "enriched"
    assert storage.completed == [(7, True)]


def test_post_provider_failure_reuses_cached_result_without_second_provider_call():
    storage = CacheRetryStorage()
    provider = FakeProvider()
    calls = {"count": 0}
    original_enrich = provider.enrich

    def counted_enrich(**kwargs):
        calls["count"] += 1
        return original_enrich(**kwargs)

    provider.enrich = counted_enrich
    worker = BuildingEnrichmentWorker(storage, {"provider": "google_places"})
    worker.providers = [provider]

    assert worker._process_job({"id": 70, "building_id": 42, "provider": "google_places"}) is False
    assert calls["count"] == 1
    assert storage.history[-1][1]["details"]["provider_result_reusable"] is True

    assert worker._process_job({"id": 70, "building_id": 42, "provider": "google_places"}) is True
    assert calls["count"] == 1


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


def test_geocoder_accepts_google_spelling_correction_for_distinctive_token():
    assert _geocode_name_confidence(
        "Deepak Silvarine",
        {"formatted_address": "Deepak Silverene, Hill Road, Bandra West, Mumbai"},
    ) == 0.85


def test_places_locality_prefers_sublocality_over_city():
    assert _locality_from_components([
        {"longText": "Mumbai", "types": ["locality"]},
        {"longText": "Byculla East", "types": ["sublocality_level_1"]},
    ]) == "Byculla East"


def test_places_search_uses_verified_source_locality_and_returns_provider_locality(monkeypatch):
    provider = GooglePlacesProvider({"api_key": "test-key"})
    monkeypatch.setattr(provider, "_check_cache", lambda *_args: None)
    monkeypatch.setattr(provider, "_save_cache", lambda *_args: None)
    monkeypatch.setattr(provider, "_rate_limit", lambda: None)
    captured = {}

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return b'''{"places":[{"id":"place-1","displayName":{"text":"Piramal Aranya"},"formattedAddress":"Byculla East, Mumbai, Maharashtra 400010","addressComponents":[{"longText":"Byculla East","types":["sublocality_level_1"]},{"longText":"Mumbai","types":["locality"]}],"location":{"latitude":18.976,"longitude":72.834}}]}'''

    def fake_urlopen(request, timeout=0):
        captured["body"] = json.loads(request.data.decode("utf-8"))
        captured["url"] = request.full_url
        return Response()

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)

    result = provider.enrich("Piramal Aranya", micro_market="Sion")

    assert captured["url"].endswith("places:searchText")
    assert captured["body"]["textQuery"] == "Piramal Aranya, Sion, Mumbai, Maharashtra, India"
    assert result.confidence == 0.95
    assert result.fields["micro_market"] == "Byculla East"
    assert result.fields["geocode_source"] == "google_places_text_search"


def test_places_keeps_google_address_when_source_locality_differs(monkeypatch):
    provider = GooglePlacesProvider({"api_key": "test-key"})
    monkeypatch.setattr(provider, "_check_cache", lambda *_args: None)
    monkeypatch.setattr(provider, "_save_cache", lambda *_args: None)
    monkeypatch.setattr(provider, "_rate_limit", lambda: None)

    class Response:
        def __enter__(self): return self
        def __exit__(self, *_args): return False
        def read(self):
            return b'''{"places":[{"id":"place-1","displayName":{"text":"Rustomjee Paramount"},"formattedAddress":"Khar West, Mumbai, Maharashtra 400052","addressComponents":[{"longText":"Khar West","types":["sublocality_level_1"]}],"location":{"latitude":19.07,"longitude":72.83}}]}'''

    monkeypatch.setattr("urllib.request.urlopen", lambda *_args, **_kwargs: Response())
    result = provider.enrich(
        "Rustomjee Paramount",
        micro_market="Bandra West",
        resolution_evidence={"source_localities": {"Bandra West": 4}},
    )

    assert result.fields["address"] == "Khar West, Mumbai, Maharashtra 400052"
    assert result.fields["micro_market"] == "Khar West"
    assert result.confidence >= 0.9


def test_places_same_name_across_markets_requires_evidence(monkeypatch):
    provider = GooglePlacesProvider({"api_key": "test-key"})
    monkeypatch.setattr(provider, "_check_cache", lambda *_args: None)
    monkeypatch.setattr(provider, "_save_cache", lambda *_args: None)
    monkeypatch.setattr(provider, "_rate_limit", lambda: None)

    class Response:
        def __enter__(self): return self
        def __exit__(self, *_args): return False
        def read(self):
            return b'''{"places":[{"id":"andheri","displayName":{"text":"Sunshine Heights"},"formattedAddress":"Andheri West, Mumbai","addressComponents":[{"longText":"Andheri West","types":["sublocality_level_1"]}],"location":{"latitude":19.1,"longitude":72.8}},{"id":"thane","displayName":{"text":"Sunshine Heights"},"formattedAddress":"Thane West, Maharashtra","addressComponents":[{"longText":"Thane West","types":["sublocality_level_1"]}],"location":{"latitude":19.2,"longitude":72.9}}]}'''

    monkeypatch.setattr("urllib.request.urlopen", lambda *_args, **_kwargs: Response())

    ambiguous = provider.enrich("Sunshine Heights")
    assert ambiguous.fields == {}
    assert "Ambiguous same-name" in ambiguous.error

    ranked = provider.enrich(
        "Sunshine Heights",
        resolution_evidence={"source_localities": {"Andheri West": 4}},
    )
    assert ranked.fields["micro_market"] == "Andheri West"


def test_cached_geocoder_failure_preserves_error_and_cannot_look_successful(monkeypatch):
    provider = GooglePlacesProvider({"api_key": "test-key"})
    monkeypatch.setattr(provider, "_check_cache", lambda *_args: {
        "confidence": 0.0,
        "fields": {},
        "error": "ZERO_RESULTS",
        "source_record_id": "",
    })

    result = provider.enrich("Missing Building")

    assert result.cached is True
    assert result.fields == {}
    assert result.error == "ZERO_RESULTS"


def test_empty_enrichment_result_is_retried_not_completed():
    storage = FakeStorage()
    provider = FakeProvider()
    provider.enrich = lambda **_kwargs: EnrichmentResult(
        provider="google_places", confidence=0.0, fields={}
    )
    worker = BuildingEnrichmentWorker(storage, {"provider": "google_places", "max_retries": 3})
    worker.providers = [provider]

    assert worker._process_job({"id": 9, "building_id": 44, "provider": "google_places"}) is False
    assert storage.completed == []
    assert storage.retries == [(9, "Provider returned no enrichment fields", 3)]
    assert storage.history[0][0][2] == "retry_scheduled"


def test_missing_enrichment_provider_is_failed_without_retry_churn():
    storage = FakeStorage()
    worker = BuildingEnrichmentWorker(storage, {"provider": "unsupported_provider"})
    worker.providers = []

    assert worker._process_job({"id": 10, "building_id": 45, "provider": "unsupported_provider"}) is False
    assert storage.retries == []
    assert storage.completed == [(10, False, "No configured enrichment provider is available")]
    assert storage.history[0][0][2] == "configuration_unavailable"


def test_building_provider_registry_excludes_web_crawlers():
    from agents.building_enrichment.providers import PROVIDERS

    assert set(PROVIDERS) == {"igr", "rera", "google_places"}
