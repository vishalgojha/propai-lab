import json
import sys

from agents.building_enrichment.providers import (
    Crawl4AIBuildingDiscoveryProvider,
    EnrichmentResult,
    GooglePlacesProvider,
    _geocode_name_confidence,
    _locality_from_components,
    get_all_providers,
    _web_candidate_names,
)
from agents.building_enrichment.crawl_discovery import DiscoveryCandidate
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
    worker = BuildingEnrichmentWorker(storage, {"provider": "crawl4ai"})
    worker.providers = []

    assert worker._process_job({"id": 10, "building_id": 45, "provider": "crawl4ai"}) is False
    assert storage.retries == []
    assert storage.completed == [(10, False, "No configured enrichment provider is available")]
    assert storage.history[0][0][2] == "configuration_unavailable"


def test_web_discovery_accepts_only_explicit_search_corrections():
    candidates = _web_candidate_names(
        "Deepak Silverline",
        [{
            "source_url": "https://www.google.com/search?q=deepak",
            "title": "These are results for Deepak Silverene Bandra West",
            "excerpt": "Search instead for Deepak Silverline bandra west",
        }],
    )

    assert candidates
    assert candidates[0]["name"] == "Deepak Silverene"


def test_crawl4ai_provider_is_disabled_by_default():
    assert not Crawl4AIBuildingDiscoveryProvider({}).is_available()


def test_crawl4ai_provider_requires_installed_package(monkeypatch):
    monkeypatch.setitem(sys.modules, "crawl4ai", None)
    assert not Crawl4AIBuildingDiscoveryProvider({"web_search_enabled": True}).is_available()


def test_crawl4ai_provider_returns_candidate_for_worker_verification(monkeypatch):
    provider = Crawl4AIBuildingDiscoveryProvider({"web_search_enabled": True})
    monkeypatch.setattr(provider, "_check_cache", lambda *_args: None)
    monkeypatch.setattr(provider, "_save_cache", lambda *_args: None)
    monkeypatch.setattr(provider, "_rate_limit", lambda: None)
    monkeypatch.setattr(
        "agents.building_enrichment.crawl_discovery.crawl_discovery_pages_sync",
        lambda *_args, **_kwargs: [DiscoveryCandidate(
            building_name="Deepak Silverline",
            source_url="https://www.google.com/search?q=deepak",
            title="These are results for Deepak Silverene Bandra West",
            excerpt="These are results for Deepak Silverene Bandra West",
        )],
    )

    result = provider.enrich("Deepak Silverline", micro_market="Bandra West")

    assert result.raw_data["resolved_name"] == "Deepak Silverene"
    assert result.source_url.startswith("https://www.google.com")
    assert result.fields == {}


def test_crawl4ai_provider_returns_structured_claims_without_promoting_them(monkeypatch):
    provider = Crawl4AIBuildingDiscoveryProvider({"web_search_enabled": True})
    monkeypatch.setattr(provider, "_check_cache", lambda *_args: None)
    monkeypatch.setattr(provider, "_save_cache", lambda *_args: None)
    monkeypatch.setattr(provider, "_rate_limit", lambda: None)
    monkeypatch.setattr(
        "agents.building_enrichment.crawl_discovery.crawl_discovery_pages_sync",
        lambda *_args, **_kwargs: [DiscoveryCandidate(
            building_name="Monalisa",
            source_url="https://example.test/monalisa",
            title="Monalisa Apartments",
            excerpt="Address: 12 Example Road, Bandra West, Mumbai\nDeveloper: Example Homes\nMahaRERA No: P51800012345",
            name_match=1.0,
            locality_match=1.0,
            structured_fields={
                "address": {"value": "12 Example Road, Bandra West, Mumbai", "confidence": 0.82, "evidence": "Address: 12 Example Road"},
                "developer": {"value": "Example Homes", "confidence": 0.82, "evidence": "Developer: Example Homes"},
            },
        )],
    )

    result = provider.enrich("Monalisa", micro_market="Bandra West")

    assert result.fields == {}
    assert result.error == ""
    assert result.raw_data["structured_fields"]["developer"]["value"] == "Example Homes"


def test_crawl4ai_provider_accepts_explicit_search_overview_claims(monkeypatch):
    provider = Crawl4AIBuildingDiscoveryProvider({"web_search_enabled": True})
    monkeypatch.setattr(provider, "_check_cache", lambda *_args: None)
    monkeypatch.setattr(provider, "_save_cache", lambda *_args: None)
    monkeypatch.setattr(provider, "_rate_limit", lambda: None)
    monkeypatch.setattr(
        "agents.building_enrichment.crawl_discovery.crawl_discovery_pages_sync",
        lambda *_args, **_kwargs: [DiscoveryCandidate(
            building_name="Trinity",
            source_url="https://www.google.com/search?q=Trinity+Khar+West+Mumbai",
            title="Trinity Luxury Residences Khar West Mumbai",
            excerpt="Address: 139, 10th Road, Khar West, Mumbai. Residential apartments.",
            name_match=1.0,
            locality_match=1.0,
            structured_fields={
                "address": {"value": "139, 10th Road, Khar West, Mumbai", "confidence": 0.82, "evidence": "Address"},
            },
        )],
    )

    result = provider.enrich("Trinity", micro_market="Khar West")

    assert result.error == ""
    assert result.raw_data["structured_fields"]["address"]["value"].startswith("139")


def test_crawl4ai_provider_rejects_structured_claims_from_unrelated_pages(monkeypatch):
    provider = Crawl4AIBuildingDiscoveryProvider({"web_search_enabled": True})
    monkeypatch.setattr(provider, "_check_cache", lambda *_args: None)
    monkeypatch.setattr(provider, "_save_cache", lambda *_args: None)
    monkeypatch.setattr(provider, "_rate_limit", lambda: None)
    monkeypatch.setattr(
        "agents.building_enrichment.crawl_discovery.crawl_discovery_pages_sync",
        lambda *_args, **_kwargs: [DiscoveryCandidate(
            building_name="Monalisa",
            source_url="https://unrelated.example/project",
            title="Other Project",
            excerpt="Address: 99 Other Road, Powai, Mumbai",
            name_match=0.0,
            locality_match=1.0,
            structured_fields={
                "developer": {"value": "Wrong Developer", "confidence": 0.95, "evidence": "Developer: Wrong Developer"},
            },
        )],
    )

    result = provider.enrich("Monalisa", micro_market="Bandra West")

    assert result.raw_data["structured_fields"] == {}


def test_crawl4ai_provider_requires_real_estate_context(monkeypatch):
    provider = Crawl4AIBuildingDiscoveryProvider({"web_search_enabled": True})
    monkeypatch.setattr(provider, "_check_cache", lambda *_args: None)
    monkeypatch.setattr(provider, "_save_cache", lambda *_args: None)
    monkeypatch.setattr(provider, "_rate_limit", lambda: None)
    monkeypatch.setattr(
        "agents.building_enrichment.crawl_discovery.crawl_discovery_pages_sync",
        lambda *_args, **_kwargs: [DiscoveryCandidate(
            building_name="Brand New Building",
            source_url="https://unrelated.example/quotes",
            title="Brand New Building",
            excerpt="Brand new ideas from Santacruz West",
            name_match=1.0,
            locality_match=1.0,
            structured_fields={
                "amenities": {"value": ["lift"], "confidence": 0.72, "evidence": "lift"},
            },
        )],
    )

    result = provider.enrich("Brand New Building", micro_market="Santacruz West")

    assert result.raw_data["structured_fields"] == {}


def test_crawl4ai_provider_accepts_commercial_real_estate_context(monkeypatch):
    provider = Crawl4AIBuildingDiscoveryProvider({"web_search_enabled": True})
    monkeypatch.setattr(provider, "_check_cache", lambda *_args: None)
    monkeypatch.setattr(provider, "_save_cache", lambda *_args: None)
    monkeypatch.setattr(provider, "_rate_limit", lambda: None)
    monkeypatch.setattr(
        "agents.building_enrichment.crawl_discovery.crawl_discovery_pages_sync",
        lambda *_args, **_kwargs: [DiscoveryCandidate(
            building_name="One Corporate Park",
            source_url="https://property.example/office",
            title="One Corporate Park commercial office project",
            excerpt="Commercial office project at Andheri East Mumbai",
            name_match=1.0,
            locality_match=1.0,
            structured_fields={
                "address": {"value": "Andheri East, Mumbai", "confidence": 0.82, "evidence": "Address"},
            },
        )],
    )

    result = provider.enrich("One Corporate Park", micro_market="Andheri East")

    assert result.raw_data["structured_fields"]["address"]["value"] == "Andheri East, Mumbai"


def test_crawl4ai_uses_source_locality_when_building_has_no_locality(monkeypatch):
    provider = Crawl4AIBuildingDiscoveryProvider({"web_search_enabled": True})
    monkeypatch.setattr(provider, "_check_cache", lambda *_args: None)
    monkeypatch.setattr(provider, "_save_cache", lambda *_args: None)
    monkeypatch.setattr(provider, "_rate_limit", lambda: None)
    captured = {}

    def fake_discovery(names, templates, localities):
        captured["locality"] = localities[names[0]]
        return []

    monkeypatch.setattr(
        "agents.building_enrichment.crawl_discovery.crawl_discovery_pages_sync",
        fake_discovery,
    )

    provider.enrich(
        "West Avenue",
        micro_market="No locality",
        resolution_evidence={"source_localities": {"Bandra West": 4}},
    )

    assert captured["locality"] == "Bandra West"


def test_crawl4ai_uses_versioned_discovery_cache_namespace(monkeypatch):
    provider = Crawl4AIBuildingDiscoveryProvider({"web_search_enabled": True})
    seen = {}
    def check_cache(name, context):
        seen["check"] = (name, context)
        return None

    monkeypatch.setattr(provider, "_check_cache", check_cache)
    monkeypatch.setattr(provider, "_save_cache", lambda name, result, context: seen.setdefault("save", (name, context)))
    monkeypatch.setattr(provider, "_rate_limit", lambda: None)
    monkeypatch.setattr(
        "agents.building_enrichment.crawl_discovery.crawl_discovery_pages_sync",
        lambda *_args, **_kwargs: [],
    )

    provider.enrich("Monalisa", micro_market="Bandra West")

    assert seen["check"] == ("Monalisa", "discovery-v2:Bandra West")
    assert "save" not in seen


def test_crawl4ai_does_not_reuse_negative_discovery_cache(monkeypatch):
    provider = Crawl4AIBuildingDiscoveryProvider({"web_search_enabled": True})
    monkeypatch.setattr(provider, "_check_cache", lambda *_args: {
        "error": "No structured web evidence found",
        "raw_data": {"structured_fields": {}, "candidates": []},
    })
    monkeypatch.setattr(provider, "_save_cache", lambda *_args: (_ for _ in ()).throw(AssertionError("negative result cached")))
    monkeypatch.setattr(provider, "_rate_limit", lambda: None)
    monkeypatch.setattr(
        "agents.building_enrichment.crawl_discovery.crawl_discovery_pages_sync",
        lambda *_args, **_kwargs: [],
    )

    result = provider.enrich("Monalisa", micro_market="Bandra West")

    assert result.error == "No structured web evidence found"


def test_crawl4ai_defaults_to_google_then_bing_fallback(monkeypatch):
    provider = Crawl4AIBuildingDiscoveryProvider({"web_search_enabled": True})
    seen = {}
    monkeypatch.setattr(provider, "_check_cache", lambda *_args: None)
    monkeypatch.setattr(provider, "_save_cache", lambda *_args: None)
    monkeypatch.setattr(provider, "_rate_limit", lambda: None)

    def fake_discovery(names, templates, localities):
        seen["templates"] = templates
        return []

    monkeypatch.setattr(
        "agents.building_enrichment.crawl_discovery.crawl_discovery_pages_sync",
        fake_discovery,
    )

    provider.enrich("Monalisa", micro_market="Bandra West")

    assert seen["templates"][0].startswith("https://www.google.com/")
    assert seen["templates"][1].startswith("https://www.bing.com/")


def test_crawl4ai_normalizes_known_locality_typo(monkeypatch):
    provider = Crawl4AIBuildingDiscoveryProvider({"web_search_enabled": True})
    monkeypatch.setattr(provider, "_check_cache", lambda *_args: None)
    monkeypatch.setattr(provider, "_save_cache", lambda *_args: None)
    monkeypatch.setattr(provider, "_rate_limit", lambda: None)
    captured = {}

    def fake_discovery(names, templates, localities):
        captured["locality"] = localities[names[0]]
        return []

    monkeypatch.setattr(
        "agents.building_enrichment.crawl_discovery.crawl_discovery_pages_sync",
        fake_discovery,
    )
    provider.enrich(
        "Some Building",
        micro_market="No locality",
        resolution_evidence={"source_localities": {"Ndheri West": 3}},
    )
    assert captured["locality"] == "Andheri West"
