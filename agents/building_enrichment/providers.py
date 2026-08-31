"""Building Enrichment Providers - Base interface and implementations."""

import os
import time
import json
import hashlib
import logging
import re
import threading
import urllib.parse
import urllib.request
from abc import ABC, abstractmethod
from dataclasses import dataclass, field, asdict
from typing import Optional
from datetime import datetime, timezone

from extraction_quality import canonical_locality_alias

logger = logging.getLogger(__name__)


_GENERIC_BUILDING_WORDS = frozenset({
    "apartment", "apartments", "building", "buildings", "bldg", "tower",
    "towers", "residency", "residences", "residential", "society", "societies",
    "cooperative", "co", "operative", "complex", "heights", "view", "views",
    "park", "garden", "gardens", "enclave", "plaza", "house", "homes",
    "mansion", "mansions", "chsl", "chs", "phase", "wing", "block",
})

_REAL_ESTATE_CONTEXT_WORDS = frozenset({
    "address", "apartment", "apartments", "builder", "bungalow",
    "business", "commercial", "complex", "industrial", "office", "offices",
    "developer", "flat", "flats", "home", "homes", "house", "housing",
    "location", "maharera", "possession", "project", "property", "realty",
    "residential", "residence", "retail", "shop", "showroom", "society",
    "unit", "villa", "warehouse",
})


def _geocode_name_confidence(requested_name: str, result: dict) -> float:
    """Score whether a geocoder result actually names the requested building.

    Google can return a nearby address for vague queries. Coordinates are only
    safe to auto-apply when the result contains all distinctive requested name
    tokens; generic words such as "Apartment" or "Tower" are not evidence of
    an identity match.
    """
    requested_tokens = [
        token.casefold()
        for token in re.findall(r"[a-z0-9]+", str(requested_name or "").casefold())
    ]
    distinctive = [
        token for token in requested_tokens
        if len(token) > 2 and token not in _GENERIC_BUILDING_WORDS
    ]
    if not distinctive:
        return 0.0

    result_parts = [str(result.get("formatted_address") or "")]
    for component in result.get("address_components") or []:
        result_parts.extend(component.get("long_name") or "" for _ in [0])
        result_parts.extend(component.get("short_name") or "" for _ in [0])
    result_text = " ".join(result_parts).casefold()
    result_tokens = set(re.findall(r"[a-z0-9]+", result_text))

    matched = sum(token in result_tokens for token in distinctive)
    if matched == len(distinctive):
        return 0.95
    if matched and matched / len(distinctive) >= 0.5:
        return 0.55
    return 0.0


def _place_name_confidence(requested_name: str, place: dict) -> float:
    """Score a Places Text Search candidate without trusting its locality.

    Places returns the project name separately from the formatted address, so
    it is a better identity source than the Geocoding API.  Reuse the strict
    token guard by presenting both fields as candidate evidence.
    """
    display_name = place.get("displayName") or {}
    if isinstance(display_name, dict):
        display_name = display_name.get("text") or ""
    return _geocode_name_confidence(
        requested_name,
        {"formatted_address": f"{display_name} {place.get('formattedAddress') or ''}"},
    )


def _locality_from_components(components: list[dict] | None) -> str | None:
    """Return the most specific usable locality from a Google result."""
    priorities = (
        "sublocality_level_1",
        "sublocality_level_2",
        "neighborhood",
        "administrative_area_level_3",
        "locality",
    )
    for wanted in priorities:
        for component in components or []:
            if wanted not in (component.get("types") or []):
                continue
            value = (
                component.get("longText")
                or component.get("long_name")
                or component.get("shortText")
                or component.get("short_name")
            )
            if value and str(value).strip().casefold() not in {"mumbai", "greater mumbai"}:
                return str(value).strip()
    return None


def _evidence_score(locality: str | None, evidence: dict | None) -> float:
    """Rank a provider candidate using internal evidence, never create facts."""
    key = str(locality or "").strip().casefold()
    if not key or not evidence:
        return 0.0
    score = 0.0
    for field, weight in (("source_localities", 0.30), ("broker_markets", 0.15)):
        votes = evidence.get(field) or {}
        total = sum(max(0.0, float(value or 0)) for value in votes.values())
        if total:
            matched = sum(
                max(0.0, float(value or 0))
                for name, value in votes.items()
                if str(name).strip().casefold() == key
            )
            score += weight * matched / total
    price = evidence.get("price")
    band = next((value for name, value in (evidence.get("price_bands") or {}).items()
                 if str(name).strip().casefold() == key), None)
    if price and band:
        low = float(band.get("p25") or band.get("p5") or 0)
        high = float(band.get("p75") or band.get("p95") or 0)
        if low and high and low <= float(price) <= high:
            score += 0.10
    return score


def source_locality_conflict(evidence: dict | None, fields: dict | None) -> str | None:
    """Return a review reason when enrichment crosses source locality context.

    A building's existing registry locality is not authoritative: it may be
    the contaminated value being repaired. Source votes therefore establish
    the expected context, and provider output must agree before it can be
    written to the canonical building row.
    """
    evidence = evidence or {}
    fields = fields or {}
    ranked = sorted(
        ((str(name).strip(), float(votes or 0))
         for name, votes in (evidence.get("source_localities") or {}).items()
         if str(name).strip()),
        key=lambda item: item[1],
        reverse=True,
    )
    if len(ranked) > 1 and ranked[0][1] <= ranked[1][1] * 2:
        return "Source listings contain competing locality context; enrichment requires identity review"
    if not ranked:
        return None
    expected = canonical_locality_alias(ranked[0][0]).casefold()
    actual_value = fields.get("micro_market") or fields.get("locality_resolved")
    if actual_value:
        actual = canonical_locality_alias(str(actual_value)).casefold()
        if expected != actual:
            return "Enrichment locality conflicts with source listing locality; enrichment requires identity review"
    return None


def _web_candidate_names(requested_name: str, pages: list[dict]) -> list[dict]:
    """Extract explicit search-engine spelling corrections from crawled pages.

    This deliberately only accepts names explicitly presented as a search
    correction (for example, Google's ``These are results for ...``). It does
    not infer a canonical building from arbitrary page prose.
    """
    requested = " ".join(str(requested_name or "").split()).strip()
    requested_tokens = set(re.findall(r"[a-z0-9]+", requested.casefold()))
    candidates: list[dict] = []
    seen: set[str] = set()
    correction_patterns = (
        r"results\s+for\s+[\"“”']?([^\"“”'\n]+)",
        r"search\s+instead\s+for\s+[\"“”']?([^\"“”'\n]+)",
    )
    for page in pages:
        text = " ".join(str(page.get(key) or "") for key in ("title", "excerpt", "text"))
        for pattern in correction_patterns:
            for match in re.finditer(pattern, text, flags=re.IGNORECASE):
                name = re.split(r"\s+(?:bandra|andheri|mumbai|maharashtra|india)\b", match.group(1), maxsplit=1, flags=re.IGNORECASE)[0]
                name = " ".join(name.strip(" .,;:!?\"“”'").split())
                if not name or name.casefold() == requested.casefold():
                    continue
                tokens = set(re.findall(r"[a-z0-9]+", name.casefold()))
                overlap = len(tokens & requested_tokens) / max(1, len(requested_tokens))
                if overlap < 0.25 or name.casefold() in seen:
                    continue
                seen.add(name.casefold())
                candidates.append({
                    "name": name,
                    "source_url": page.get("source_url") or page.get("url") or "",
                    "title": page.get("title") or "",
                    "excerpt": page.get("excerpt") or page.get("text") or "",
                    "name_overlap": round(overlap, 3),
                })
    return candidates


@dataclass
class EnrichmentResult:
    """Result from an enrichment provider."""
    provider: str
    confidence: float  # 0.0 to 1.0
    fields: dict = field(default_factory=dict)  # field_name -> value
    source_url: str = ""
    source_record_id: str = ""
    raw_data: dict = field(default_factory=dict)
    error: str = ""
    cached: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


class BaseProvider(ABC):
    """Base class for building enrichment providers."""

    name: str = "base"
    priority: int = 0  # Higher = processed first
    rate_limit_delay: float = 1.0  # Seconds between requests

    def __init__(self, config: dict = None):
        self.config = config or {}
        self._last_request_time = 0.0
        self._rate_limit_lock = threading.Lock()
        self._cache_dir = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "..", "..", "data", "enrichment_cache"
        )
        os.makedirs(self._cache_dir, exist_ok=True)

    def _get_cache_key(self, building_name: str, context: str = "") -> str:
        """Generate a cache key for a building name."""
        return hashlib.md5(f"{self.name}:{building_name}:{context}".encode()).hexdigest()

    def _get_cache_path(self, cache_key: str) -> str:
        """Get the file path for a cache entry."""
        return os.path.join(self._cache_dir, f"{self.name}_{cache_key}.json")

    def _check_cache(self, building_name: str, context: str = "") -> Optional[dict]:
        """Check if we have cached results for this building."""
        cache_key = self._get_cache_key(building_name, context)
        cache_path = self._get_cache_path(cache_key)
        if os.path.exists(cache_path):
            try:
                with open(cache_path, "r") as f:
                    data = json.load(f)
                # Cache expires after 30 days
                if time.time() - data.get("timestamp", 0) < 30 * 24 * 3600:
                    return data.get("result")
            except Exception:
                pass
        return None

    def _save_cache(self, building_name: str, result: dict, context: str = ""):
        """Save results to cache."""
        cache_key = self._get_cache_key(building_name, context)
        cache_path = self._get_cache_path(cache_key)
        try:
            with open(cache_path, "w") as f:
                json.dump({"timestamp": time.time(), "result": result}, f)
        except Exception as e:
            logger.warning(f"Failed to save cache for {building_name}: {e}")

    def _rate_limit(self):
        """Enforce rate limiting between requests."""
        # Provider instances are shared by the worker's bounded thread pool.
        # Serialize the timestamp check so concurrency does not accidentally
        # turn the configured delay into an unbounded request burst.
        with self._rate_limit_lock:
            elapsed = time.time() - self._last_request_time
            if elapsed < self.rate_limit_delay:
                time.sleep(self.rate_limit_delay - elapsed)
            self._last_request_time = time.time()

    @abstractmethod
    def enrich(self, building_name: str, canonical_name: str = None,
               micro_market: str = None, **kwargs) -> EnrichmentResult:
        """Enrich a building with data from this provider.

        Args:
            building_name: The canonical building name to enrich
            canonical_name: Alternative canonical name if different
            micro_market: Known micro market / locality
            **kwargs: Additional context

        Returns:
            EnrichmentResult with enriched fields
        """
        pass

    def is_available(self) -> bool:
        """Check if this provider is configured and available."""
        return True


class IGRProvider(BaseProvider):
    """Indian Government Registration (IGR) data provider.

    IGR provides property registration data including:
    - Property transactions
    - Stamp duty records
    - Property area details
    - Buyer/seller information (anonymized)

    Note: IGR data is publicly accessible for Maharashtra at
    https://igrmaharashtra.gov.in/ but requires careful parsing.
    """

    name = "igr"
    priority = 10
    rate_limit_delay = 2.0  # Respect IGR servers

    def enrich(self, building_name: str, canonical_name: str = None,
               micro_market: str = None, **kwargs) -> EnrichmentResult:
        """Enrich building with IGR data."""
        # Check cache first
        cached = self._check_cache(building_name)
        if cached:
            return EnrichmentResult(
                provider=self.name,
                confidence=cached.get("confidence", 0.0),
                fields=cached.get("fields", {}),
                source_url=cached.get("source_url", ""),
                source_record_id=cached.get("source_record_id", ""),
                raw_data=cached,
                error=cached.get("error", ""),
                cached=True,
            )

        # IGR enrichment logic would go here
        # For now, return empty result - to be implemented with actual IGR parsing
        result = EnrichmentResult(
            provider=self.name,
            confidence=0.0,
            fields={},
            error="IGR provider not yet implemented",
        )

        # Cache the result
        self._save_cache(building_name, result.to_dict())
        return result

    def is_available(self) -> bool:
        """IGR search is not a supported enrichment source."""
        return False


class RERAProvider(BaseProvider):
    """RERA (Real Estate Regulatory Authority) data provider.

    RERA provides:
    - Project registration details
    - Developer information
    - Project status
    - Unit details
    - Completion dates

    Maharashtra RERA: https://maha-rera.mahaonline.gov.in/
    """

    name = "rera"
    priority = 20
    rate_limit_delay = 2.0

    def enrich(self, building_name: str, canonical_name: str = None,
               micro_market: str = None, **kwargs) -> EnrichmentResult:
        """Enrich building with RERA data."""
        address = kwargs.get("address")
        pincode = kwargs.get("pincode")
        context = ", ".join(str(part).strip() for part in (address, pincode) if part and str(part).strip())
        cached = self._check_cache(building_name, context)
        if cached:
            return EnrichmentResult(
                provider=self.name,
                confidence=cached.get("confidence", 0.0),
                fields=cached.get("fields", {}),
                source_url=cached.get("source_url", ""),
                source_record_id=cached.get("source_record_id", ""),
                raw_data=cached,
                error=cached.get("error", ""),
                cached=True,
            )

        # RERA enrichment logic would go here
        result = EnrichmentResult(
            provider=self.name,
            confidence=0.0,
            fields={},
            error="RERA provider not yet implemented",
        )

        self._save_cache(building_name, result.to_dict())
        return result

    def is_available(self) -> bool:
        return True


class GooglePlacesProvider(BaseProvider):
    """Google Places API provider.

    Provides:
    - Building address
    - Coordinates (lat/lng)
    - Place ID
    - Ratings and reviews
    - Opening hours (for commercial)
    - Photos

    Requires API key in GOOGLE_PLACES_API_KEY env var.
    """

    name = "google_places"
    priority = 30
    rate_limit_delay = 0.1  # Google allows faster requests
    _cache_version = "places-text-search-v1"

    def __init__(self, config: dict = None):
        super().__init__(config)
        self.api_key = (
            self.config.get("api_key")
            or os.environ.get("GOOGLE_PLACES_API_KEY", "")
            or os.environ.get("GOOGLE_MAPS_API_KEY", "")
            or os.environ.get("GOOGLE_places_API_KEY", "")
        )

    def is_available(self) -> bool:
        return bool(self.api_key)

    def _get_cache_key(self, building_name: str, context: str = "") -> str:
        # Invalidate results cached before candidate-name validation was added.
        return hashlib.md5(
            f"{self.name}:{self._cache_version}:{building_name}:{context}".encode()
        ).hexdigest()

    def enrich(self, building_name: str, canonical_name: str = None,
               micro_market: str = None, **kwargs) -> EnrichmentResult:
        """Enrich building with Google Places data."""
        if not self.is_available():
            return EnrichmentResult(
                provider=self.name,
                confidence=0.0,
                fields={},
                error="Google Places API key not configured",
            )

        requested_name = canonical_name or building_name
        evidence = kwargs.get("resolution_evidence") or {}
        locality_votes = evidence.get("source_localities") or {}
        ranked_localities = sorted(
            ((str(name).strip(), float(votes or 0)) for name, votes in locality_votes.items() if str(name).strip()),
            key=lambda item: item[1],
            reverse=True,
        )
        evidence_locality = ranked_localities[0][0] if ranked_localities else None
        if len(ranked_localities) > 1 and ranked_localities[0][1] <= ranked_localities[1][1] * 2:
            return EnrichmentResult(
                provider=self.name,
                confidence=0.0,
                fields={},
                error="Source listings contain competing locality context; enrichment requires identity review",
                raw_data={"source_localities": locality_votes},
            )
        # Source locality is the binding constraint. The registry's existing
        # locality may itself be the contaminated value we are repairing.
        context = str(evidence_locality or micro_market or "Mumbai").strip()
        context = context if context.casefold() not in {"unknown", "no locality"} else "Mumbai"
        candidate_names = [
            str(name).strip() for name in (evidence.get("candidate_names") or [])
            if str(name).strip()
        ]
        identity_names = list(dict.fromkeys([requested_name, *candidate_names]))[:6]
        cached = self._check_cache(building_name, context)
        if cached:
            return EnrichmentResult(
                provider=self.name,
                confidence=cached.get("confidence", 0.0),
                fields=cached.get("fields", {}),
                source_url=cached.get("source_url", ""),
                source_record_id=cached.get("source_record_id", ""),
                raw_data=cached,
                error=cached.get("error", ""),
                cached=True,
            )

        self._rate_limit()
        query = f"{requested_name}, {context}, Mumbai, Maharashtra, India"
        places_url = "https://places.googleapis.com/v1/places:searchText"
        try:
            request = urllib.request.Request(
                places_url,
                data=json.dumps({"textQuery": query, "maxResultCount": 10}).encode("utf-8"),
                headers={
                    "Content-Type": "application/json",
                    "X-Goog-Api-Key": self.api_key,
                    "X-Goog-FieldMask": (
                        "places.id,places.displayName,places.formattedAddress,"
                        "places.addressComponents,places.location,places.plusCode"
                    ),
                },
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=15) as response:
                payload = json.loads(response.read().decode("utf-8"))
            places = payload.get("places") or []
            if not places:
                error = ((payload.get("error") or {}).get("message") or "No Places Text Search result")
                result = EnrichmentResult(provider=self.name, confidence=0.0, error=error, raw_data=payload)
            else:
                scored_results = []
                for candidate in places:
                    name_confidence = max(
                        (_place_name_confidence(name, candidate) for name in identity_names),
                        default=0.0,
                    )
                    locality = _locality_from_components(candidate.get("addressComponents"))
                scored_results.append((name_confidence + _evidence_score(locality, evidence), name_confidence, locality, candidate))
                _score, match_confidence, resolved_market, match = max(
                    scored_results,
                    key=lambda item: item[0],
                )
                if evidence_locality and resolved_market:
                    expected = canonical_locality_alias(evidence_locality).casefold()
                    actual = canonical_locality_alias(resolved_market).casefold()
                    if expected != actual:
                        result = EnrichmentResult(
                            provider=self.name,
                            confidence=0.0,
                            fields={},
                            error="Places result locality conflicts with source listing locality; enrichment requires review",
                            source_url=places_url,
                            raw_data={"places": places, "expected_locality": evidence_locality, "resolved_locality": resolved_market},
                        )
                        self._save_cache(building_name, result.to_dict(), context)
                        return result
                if match_confidence < 0.7:
                    result = EnrichmentResult(
                        provider=self.name,
                        confidence=match_confidence,
                        fields={},
                        error=(
                            "Geocoder returned no sufficiently matching building name; "
                            "coordinates require review"
                        ),
                        source_url=places_url,
                        raw_data={"places": places},
                    )
                    self._save_cache(building_name, result.to_dict(), context)
                    return result
                credible = [item for item in scored_results if item[1] >= 0.7]
                distinct_markets = {str(item[2] or "").casefold() for item in credible if item[2]}
                if len(distinct_markets) > 1 and len(credible) > 1:
                    ranked = sorted(credible, key=lambda item: item[0], reverse=True)
                    if ranked[0][0] - ranked[1][0] < 0.10:
                        result = EnrichmentResult(
                            provider=self.name,
                            confidence=match_confidence,
                            fields={},
                            error="Ambiguous same-name Places results require stronger source, broker, or price evidence",
                            source_url=places_url,
                            raw_data={"places": places},
                        )
                        self._save_cache(building_name, result.to_dict(), context)
                        return result
                location = match.get("location") or {}
                plus = match.get("plusCode") or {}
                fields = {
                    "address": match.get("formattedAddress"),
                    "micro_market": resolved_market,
                    "latitude": location.get("latitude"),
                    "longitude": location.get("longitude"),
                    "google_place_id": match.get("id"),
                    "plus_code": plus.get("compoundCode") or plus.get("globalCode"),
                    "geocode_query": query,
                    "geocode_source": "google_places_text_search",
                    "geocode_confidence": match_confidence,
                    "geocoded_at": datetime.now(timezone.utc).isoformat(),
                }
                result = EnrichmentResult(
                    provider=self.name,
                    confidence=match_confidence,
                    fields={key: value for key, value in fields.items() if value is not None},
                    source_url=places_url,
                    source_record_id=match.get("id", ""),
                    raw_data={"result": match},
                )
        except Exception as exc:
            result = EnrichmentResult(provider=self.name, confidence=0.0, error=str(exc))

        self._save_cache(building_name, result.to_dict(), context)
        return result


class Crawl4AIBuildingDiscoveryProvider(BaseProvider):
    """Web-first spelling discovery for unresolved building names.

    Crawl4AI is used only to discover an explicitly surfaced search correction.
    A result is not considered enrichment until Google Places verifies the
    discovered candidate in the worker.
    """

    name = "crawl4ai"
    priority = 50
    rate_limit_delay = 2.0

    def __init__(self, config: dict = None):
        super().__init__(config)
        self.enabled = bool(self.config.get("web_search_enabled", False))
        configured_template = self.config.get("web_search_url_template") or os.environ.get(
            "BUILDING_ENRICHMENT_SEARCH_URL_TEMPLATE"
        )
        self.search_url_templates = self.config.get("web_search_url_templates") or (
            [configured_template] if configured_template else [
                "https://www.google.com/search?q=%22{query}%22+{locality}+Mumbai",
                "https://www.bing.com/search?q=%22{query}%22+{locality}+Mumbai&count=10",
            ]
        )

    def is_available(self) -> bool:
        if not self.enabled:
            return False
        try:
            import crawl4ai  # noqa: F401
        except ImportError:
            logger.error(
                "Crawl4AI web search is enabled but the crawl4ai package is not installed"
            )
            return False
        return True

    def enrich(self, building_name: str, canonical_name: str = None,
               micro_market: str = None, **kwargs) -> EnrichmentResult:
        requested = canonical_name or building_name
        search_name = re.sub(r"^\s*name\s*[-:]\s*", "", requested, flags=re.IGNORECASE).strip() or requested
        evidence = kwargs.get("resolution_evidence") or {}
        address = str(kwargs.get("address") or "").strip()
        pincode = str(kwargs.get("pincode") or "").strip()

        # The building row often has no locality yet. Use bounded, structured
        # evidence derived from the source listings in that case. This keeps
        # discovery anchored to the broker's actual market instead of asking
        # the web to resolve a bare, potentially ambiguous building name.
        context = str(micro_market or "").strip()
        if not context or context.casefold() in {"no locality", "unknown", "mumbai"}:
            locality_votes = {}
            for field in ("source_localities", "broker_markets"):
                for locality, votes in (evidence.get(field) or {}).items():
                    value = str(locality or "").strip()
                    if value:
                        value = canonical_locality_alias(value)
                        locality_votes[value] = locality_votes.get(value, 0) + float(votes or 0)
            if locality_votes:
                context = max(locality_votes, key=locality_votes.get)
        context = context or "Mumbai"
        # Search identity is deliberately narrow: a building name plus its
        # market is more useful than appending a noisy full address/pincode.
        search_context = context.split(",", 1)[0].strip() or "Mumbai"
        source_contexts = kwargs.get("resolution_evidence", {}).get("source_contexts") or []
        # The source slice is deliberately not appended wholesale to the URL.
        # It is retained in the provider result for auditability while the
        # deterministic locality remains the actual search constraint.
        # Bump the discovery cache namespace when the result-link/parser
        # contract changes. Otherwise a prior "no evidence" result can mask
        # the next implementation and prevent Crawl4AI from issuing a fresh
        # search after a worker redeploy.
        cache_context = f"discovery-v2:{search_context}"
        cached = self._check_cache(search_name, cache_context)
        cached_fields = (cached or {}).get("raw_data", {}).get("structured_fields") or {}
        cached_candidates = (cached or {}).get("raw_data", {}).get("candidates") or []
        # Negative discovery results must never be cached. A parser or query
        # improvement needs to be able to retry the same building after a
        # worker redeploy.
        if cached and not cached.get("error") and (cached_fields or cached_candidates):
            return EnrichmentResult(
                provider=self.name,
                confidence=cached.get("confidence", 0.0),
                fields=cached.get("fields", {}),
                source_url=cached.get("source_url", ""),
                source_record_id=cached.get("source_record_id", ""),
                raw_data=cached.get("raw_data") or cached,
                error=cached.get("error", ""),
                cached=True,
            )

        self._rate_limit()
        try:
            from .crawl_discovery import crawl_discovery_pages_sync

            pages = crawl_discovery_pages_sync(
                [search_name], self.search_url_templates, {search_name: search_context}
            )
            page_dicts = [
                {
                    "source_url": page.source_url,
                    "title": page.title,
                    "excerpt": page.excerpt,
                    "name_match": page.name_match,
                    "locality_match": page.locality_match,
                    "structured_fields": page.structured_fields or {},
                }
                for page in pages
            ]
            structured_fields = {}
            for page in page_dicts:
                # Never import claims from an unrelated search result. A
                # linked page must independently mention both the requested
                # building and the bounded locality context.
                if float(page.get("name_match") or 0) < 0.75 or float(page.get("locality_match") or 0) < 0.5:
                    continue
                page_text = " ".join(
                    str(page.get(key) or "") for key in ("title", "excerpt")
                ).casefold()
                if not any(
                    re.search(rf"(?<!\w){re.escape(word)}(?!\w)", page_text)
                    for word in _REAL_ESTATE_CONTEXT_WORDS
                ):
                    continue
                source_host = urllib.parse.urlparse(str(page.get("source_url") or "")).netloc.casefold()
                if (
                    source_host in {"google.com", "bing.com"}
                    or source_host.endswith((".google.com", ".bing.com", ".bingj.com"))
                ):
                    # Search snippets can contain explicit labelled claims
                    # (for example, an Address in Google's overview). They
                    # are admissible as bounded discovery evidence, but only
                    # when deterministic extraction found a claim; never use
                    # a bare search snippet as identity or source evidence.
                    if not page.get("structured_fields"):
                        continue
                for field_name, claim in (page.get("structured_fields") or {}).items():
                    current = structured_fields.get(field_name)
                    if current is None or float(claim.get("confidence") or 0) > float(current.get("confidence") or 0):
                        structured_fields[field_name] = {
                            **claim,
                            "source_url": page.get("source_url") or "",
                        }
            candidates = _web_candidate_names(search_name, page_dicts)
            if not candidates:
                result = EnrichmentResult(
                    provider=self.name,
                    confidence=max((float(v.get("confidence") or 0) for v in structured_fields.values()), default=0.0),
                    fields={},
                    error="" if structured_fields else "No structured web evidence found",
                    raw_data={"pages": page_dicts, "candidates": [], "structured_fields": structured_fields},
                )
            else:
                candidate = candidates[0]
                confidence = min(
                    0.9,
                    0.55 + 0.15 * min(1.0, float(candidate.get("name_overlap") or 0.0))
                    + (0.15 if len(candidates) >= 2 else 0.0),
                )
                result = EnrichmentResult(
                    provider=self.name,
                    confidence=confidence,
                    fields={},
                    source_url=candidate.get("source_url", ""),
                    raw_data={
                        "pages": page_dicts,
                        "candidates": candidates,
                        "resolved_name": candidate["name"],
                        "source_contexts": source_contexts[:5],
                        "structured_fields": structured_fields,
                    },
                )
        except Exception as exc:
            result = EnrichmentResult(provider=self.name, confidence=0.0, fields={}, error=str(exc))

        if not result.error and ((result.raw_data or {}).get("structured_fields") or (result.raw_data or {}).get("candidates")):
            self._save_cache(search_name, result.to_dict(), cache_context)
        return result


# Provider registry
PROVIDERS = {
    "igr": IGRProvider,
    "rera": RERAProvider,
    "google_places": GooglePlacesProvider,
    "crawl4ai": Crawl4AIBuildingDiscoveryProvider,
}


def get_provider(name: str, config: dict = None) -> Optional[BaseProvider]:
    """Get a provider instance by name."""
    provider_class = PROVIDERS.get(name)
    if provider_class:
        return provider_class(config)
    return None


def get_all_providers(config: dict = None) -> list[BaseProvider]:
    """Get all available providers sorted by priority."""
    providers = []
    for name, cls in PROVIDERS.items():
        p = cls(config)
        if p.is_available():
            providers.append(p)
    providers.sort(key=lambda p: p.priority, reverse=True)
    return providers
