"""
MagicBricks Adapter.

Extracts listing observations from MagicBricks property listings.
Maps to observation types: SALE_LISTING, RENT_LISTING, BROKER_OFFER.
"""
from typing import Optional

from evidence.adapters import ObservationAdapter


SOURCE = "MAGICBRICKS"
SOURCE_URL = "https://www.magicbricks.com"


def extract(raw: dict) -> list[dict]:
    """
    Transform a MagicBricks listing response into observation records.
    
    Expected input fields:
      - property_name, sub_area, locality
      - expected_price, price_per_sqft
      - property_type (Apartment/Villa/Plot)
      - bedrooms, bathrooms, super_builtup_area
      - floor, total_floors, furnishing
      - possession_date, amenities
      - listing_url, listing_date
      - posted_by (Builder/Agent/Owner)
      - developer_name
    """
    observations = []
    
    building_name = raw.get("property_name", "").strip()
    area = raw.get("sub_area", "") or raw.get("locality", "")
    developer = raw.get("developer_name", "") or raw.get("posted_by", "")
    obs_type = "SALE_LISTING"
    if raw.get("listing_type") == "rent":
        obs_type = "RENT_LISTING"
    if raw.get("posted_by", "").lower() == "agent":
        obs_type = "BROKER_OFFER"
    
    payload = {
        "bedrooms": raw.get("bedrooms"),
        "bathrooms": raw.get("bathrooms"),
        "area_sqft": raw.get("super_builtup_area"),
        "price": raw.get("expected_price"),
        "price_per_sqft": raw.get("price_per_sqft"),
        "floor": raw.get("floor"),
        "total_floors": raw.get("total_floors"),
        "furnishing": raw.get("furnishing", "UNFURNISHED"),
        "possession_date": raw.get("possession_date"),
        "amenities": raw.get("amenities", []),
        "building_name": building_name,
        "area": area,
        "developer": developer,
        "posted_by": raw.get("posted_by"),
    }
    
    observation = {
        "building_name": building_name,
        "area": area,
        "developer": developer,
        "observation_type": obs_type,
        "source": SOURCE,
        "observed_at": raw.get("listing_date", ""),
        "payload": {k: v for k, v in payload.items() if v is not None},
        "source_reference": raw.get("listing_url", ""),
    }
    
    observations.append(observation)
    return observations


def extract_batch(listings: list[dict]) -> list[dict]:
    all_obs = []
    for listing in listings:
        all_obs.extend(extract(listing))
    return all_obs


class MagicBricksAdapter:
    source = SOURCE
    
    def fetch(self, **kwargs) -> list[dict]:
        return []
