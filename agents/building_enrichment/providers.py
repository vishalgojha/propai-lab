"""Building Enrichment Providers - Base interface and implementations."""

import os
import time
import json
import hashlib
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field, asdict
from typing import Optional
from datetime import datetime, timezone

logger = logging.getLogger(__name__)


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
        self._cache_dir = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "..", "..", "data", "enrichment_cache"
        )
        os.makedirs(self._cache_dir, exist_ok=True)

    def _get_cache_key(self, building_name: str) -> str:
        """Generate a cache key for a building name."""
        return hashlib.md5(f"{self.name}:{building_name}".encode()).hexdigest()

    def _get_cache_path(self, cache_key: str) -> str:
        """Get the file path for a cache entry."""
        return os.path.join(self._cache_dir, f"{self.name}_{cache_key}.json")

    def _check_cache(self, building_name: str) -> Optional[dict]:
        """Check if we have cached results for this building."""
        cache_key = self._get_cache_key(building_name)
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

    def _save_cache(self, building_name: str, result: dict):
        """Save results to cache."""
        cache_key = self._get_cache_key(building_name)
        cache_path = self._get_cache_path(cache_key)
        try:
            with open(cache_path, "w") as f:
                json.dump({"timestamp": time.time(), "result": result}, f)
        except Exception as e:
            logger.warning(f"Failed to save cache for {building_name}: {e}")

    def _rate_limit(self):
        """Enforce rate limiting between requests."""
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
                raw_data=cached,
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
        """IGR is always available (public website)."""
        return True


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
        cached = self._check_cache(building_name)
        if cached:
            return EnrichmentResult(
                provider=self.name,
                confidence=cached.get("confidence", 0.0),
                fields=cached.get("fields", {}),
                source_url=cached.get("source_url", ""),
                raw_data=cached,
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

    def __init__(self, config: dict = None):
        super().__init__(config)
        self.api_key = self.config.get("api_key") or os.environ.get("GOOGLE_places_API_KEY", "")

    def is_available(self) -> bool:
        return bool(self.api_key)

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

        cached = self._check_cache(building_name)
        if cached:
            return EnrichmentResult(
                provider=self.name,
                confidence=cached.get("confidence", 0.0),
                fields=cached.get("fields", {}),
                source_url=cached.get("source_url", ""),
                raw_data=cached,
                cached=True,
            )

        # Google Places enrichment logic would go here
        result = EnrichmentResult(
            provider=self.name,
            confidence=0.0,
            fields={},
            error="Google Places provider not yet implemented",
        )

        self._save_cache(building_name, result.to_dict())
        return result


class OpenStreetMapProvider(BaseProvider):
    """OpenStreetMap (OSM) data provider.

    Provides:
    - Building footprints
    - Address details
    - Coordinates
    - Nearby amenities
    - Building type

    Uses Overpass API for queries.
    """

    name = "openstreetmap"
    priority = 40
    rate_limit_delay = 1.0

    def enrich(self, building_name: str, canonical_name: str = None,
               micro_market: str = None, **kwargs) -> EnrichmentResult:
        """Enrich building with OSM data."""
        cached = self._check_cache(building_name)
        if cached:
            return EnrichmentResult(
                provider=self.name,
                confidence=cached.get("confidence", 0.0),
                fields=cached.get("fields", {}),
                source_url=cached.get("source_url", ""),
                raw_data=cached,
                cached=True,
            )

        # OSM enrichment logic would go here
        result = EnrichmentResult(
            provider=self.name,
            confidence=0.0,
            fields={},
            error="OpenStreetMap provider not yet implemented",
        )

        self._save_cache(building_name, result.to_dict())
        return result

    def is_available(self) -> bool:
        """OSM is always available (free, public)."""
        return True


# Provider registry
PROVIDERS = {
    "igr": IGRProvider,
    "rera": RERAProvider,
    "google_places": GooglePlacesProvider,
    "openstreetmap": OpenStreetMapProvider,
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
