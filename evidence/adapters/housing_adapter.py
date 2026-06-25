"""
Housing.com Adapter.

Extracts listing observations from Housing.com property listings.
Maps to observation types: SALE_LISTING, RENT_LISTING, PRICE_CHANGE.
"""
import json
from datetime import datetime
from typing import Optional

from evidence.adapters import ObservationAdapter


SOURCE = "HOUSING"
SOURCE_URL = "https://www.housing.com"


def extract(raw: dict) -> list[dict]:
    """
    Transform a Housing.com listing response into observation records.
    
    Expected input fields:
      - property_name (building name)
      - locality (area)
      - price, price_per_sqft
      - listing_type (buy/rent)
      - bedrooms, bathrooms, area_sqft
      - floor, total_floors, furnishing
      - possession_date, amenities
      - listing_url
      - listing_date
      - developer_name
    """
    observations = []
    now = datetime.utcnow().isoformat()[:10]
    
    building_name = raw.get("property_name", "").strip()
    area = raw.get("locality", "").strip()
    developer = raw.get("developer_name", "").strip()
    listing_type = raw.get("listing_type", "buy")
    obs_type = "RENT_LISTING" if listing_type == "rent" else "SALE_LISTING"
    observed_at = raw.get("listing_date", now)
    
    payload = {
        "bedrooms": raw.get("bedrooms"),
        "bathrooms": raw.get("bathrooms"),
        "area_sqft": raw.get("area_sqft"),
        "price": raw.get("price"),
        "price_per_sqft": raw.get("price_per_sqft"),
        "floor": raw.get("floor"),
        "total_floors": raw.get("total_floors"),
        "furnishing": raw.get("furnishing", "UNFURNISHED"),
        "facing": raw.get("facing"),
        "possession_date": raw.get("possession_date"),
        "amenities": raw.get("amenities", []),
        "building_name": building_name,
        "area": area,
        "developer": developer,
    }
    
    observation = {
        "building_name": building_name,
        "area": area,
        "developer": developer,
        "observation_type": obs_type,
        "source": SOURCE,
        "observed_at": observed_at,
        "payload": {k: v for k, v in payload.items() if v is not None},
        "source_reference": raw.get("listing_url", ""),
    }
    
    observations.append(observation)
    return observations


def extract_batch(listings: list[dict]) -> list[dict]:
    """Extract observations from a batch of Housing.com listings."""
    all_obs = []
    for listing in listings:
        all_obs.extend(extract(listing))
    return all_obs


class HousingAdapter:
    source = SOURCE
    
    def fetch(self, **kwargs) -> list[dict]:
        """
        Fetch listings from Housing.com.
        
        In production, this would call the Housing.com API or scrape.
        For now, returns an empty list — implement when API access is available.
        """
        return []
