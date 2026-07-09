"""
IGR Maharashtra Adapter.

Extracts registered transaction observations from IGR sale deeds.
Maps to observation types: IGR_TRANSACTION.

These are the ground truth for actual sale prices — the most
valuable signal for market intelligence.
"""
from typing import Optional

from evidence.adapters import ObservationAdapter


SOURCE = "IGR"
SOURCE_URL = "https://igrmaharashtra.gov.in"


def extract(raw: dict) -> list[dict]:
    """
    Transform an IGR sale deed record into observations.
    
    Expected input fields:
      - property_description (building name + unit)
      - deed_number, deed_date
      - registration_date
      - consideration_amount (sale price)
      - stamp_duty_paid
      - area_sqmt, area_sqft
      - seller_name, buyer_name
      - property_address (includes area/locality)
      - sub_register_office
      - deed_type (Sale Deed / Gift Deed / etc.)
    """
    observations = []
    
    building_name = raw.get("property_description", "").strip()
    area = raw.get("property_address", "").strip()
    
    # Extract building name from property description
    # IGR descriptions vary: "Flat No. XYZ, Building Name, Area"
    parts = [p.strip() for p in building_name.split(",")]
    if len(parts) >= 2:
        building_name = parts[1]  # Assume second part is building name
        if not area:
            area = parts[-1]  # Last part is area
    
    price = raw.get("consideration_amount")
    
    payload = {
        "deed_number": raw.get("deed_number", ""),
        "consideration_amount": price,
        "stamp_duty_paid": raw.get("stamp_duty_paid"),
        "area_sqmt": raw.get("area_sqmt"),
        "area_sqft": raw.get("area_sqft"),
        "seller_name": raw.get("seller_name", ""),
        "buyer_name": raw.get("buyer_name", ""),
        "sub_register_office": raw.get("sub_register_office", ""),
        "deed_type": raw.get("deed_type", "Sale Deed"),
        "building_name": building_name,
        "area": area,
    }
    
    observed_at = raw.get("deed_date", "") or raw.get("registration_date", "")
    
    observation = {
        "building_name": building_name,
        "area": area,
        "developer": "",
        "observation_type": "IGR_TRANSACTION",
        "source": SOURCE,
        "observed_at": observed_at,
        "payload": {k: v for k, v in payload.items() if v is not None},
        "source_reference": raw.get("deed_number", ""),
    }
    
    observations.append(observation)
    return observations


def extract_batch(deeds: list[dict]) -> list[dict]:
    all_obs = []
    for deed in deeds:
        all_obs.extend(extract(deed))
    return all_obs


class IGRAdapter:
    source = SOURCE
    
    def fetch(self, **kwargs) -> list[dict]:
        return []
