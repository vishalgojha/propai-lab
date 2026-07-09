"""
MahaRERA Adapter — raw scraper output → normalized observations.

Field mapping (scraper output → adapter input):

  Scraper CSV field     Adapter field
  ─────────────────────────────────────────────
  rera_no               → source_reference
  project_name          → building_name
  promoter              → developer
  location              → area
  district              → district
  pincode               → pincode
  last_modified         → observed_at
  source                → constant "MAHARERA"
"""
from typing import Optional

from evidence.adapters import ObservationAdapter
from evidence.resolver import resolve


SOURCE = "MAHARERA"
SOURCE_URL = "https://maharera.maharashtra.gov.in"


def extract(project: dict) -> list[dict]:
    """
    Transform a MahaRERA project record (from scraper CSV) into observations.

    Scraper output fields:
      rera_no, project_name, promoter, location,
      district, pincode, state, last_modified, source
    """
    rera_no = project.get("rera_no", "").strip()
    project_name = project.get("project_name", "").strip()
    promoter = project.get("promoter", "").strip()
    location = project.get("location", "").strip()
    district = project.get("district", "").strip()
    pincode = project.get("pincode", "").strip()
    last_modified = project.get("last_modified", "").strip()

    # Normalize: extract micro area from location
    # Location format: "Village, Taluka, District" or just a locality name
    location_parts = [p.strip() for p in location.split(",")]
    area = location_parts[0] if location_parts else location

    # The project_name IS the "building_name" for resolution purposes
    building_name = project_name

    # Determine observation type based on project context
    # MahaRERA projects are always MAHARERA_PROJECT observations
    # But if we already know this building, it's a status update
    bid, confidence, method = resolve(building_name, area, promoter)
    obs_type = "MAHARERA_PROJECT"
    if bid > 0:
        # If the building is already in our registry, this is a status update
        pass  # Still MAHARERA_PROJECT — the payload distinguishes new vs update

    payload = {
        "rera_number": rera_no,
        "project_name": project_name,
        "promoter": promoter,
        "location": location,
        "district": district,
        "pincode": pincode,
        "building_name": building_name,
        "area": area,
        "developer": promoter,
        "state": project.get("state", ""),
    }

    observation = {
        "building_name": building_name,
        "area": area,
        "developer": promoter,
        "observation_type": obs_type,
        "source": SOURCE,
        "observed_at": last_modified,
        "payload": {k: v for k, v in payload.items() if v},
        "source_reference": rera_no,
    }

    return [observation]


def extract_batch(projects: list[dict]) -> list[dict]:
    """Extract observations from a batch of MahaRERA project records."""
    all_obs = []
    for project in projects:
        all_obs.extend(extract(project))
    return all_obs


class MahaRERAAdapter:
    source = SOURCE

    def fetch(self, **kwargs) -> list[dict]:
        return []
