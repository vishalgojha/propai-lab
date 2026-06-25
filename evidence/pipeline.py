"""
Evidence Ingestion Pipeline.

Flow:
  Source Data → Normalize → Resolve BuildingID → Validate → Store

Each source adapter produces a list of Observation dicts (raw).
The pipeline normalizes them, resolves BuildingIDs, validates,
and writes to CSV (or DB).

Design principles:
  - Never modify canonical data
  - Never create buildings automatically
  - Append-only for observations
  - Validation is strict for building_id (0 = rejected)
"""
import csv
import json
import os
import uuid
from datetime import datetime
from typing import Callable, Optional

from evidence.models import Observation
from evidence.resolver import resolve


BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OBSERVATIONS_PATH = os.path.join(BASE_DIR, "data", "observations.csv")
UNRESOLVED_PATH = os.path.join(BASE_DIR, "data", "unresolved_observations.csv")


class Pipeline:
    """
    Ingestion pipeline for a batch of observations from a single source.
    
    Usage:
        observations = adapter.fetch()
        pipeline = Pipeline(source="HOUSING")
        results = pipeline.run(observations)
        # results["ingested"] — successfully stored
        # results["unresolved"] — building_id could not be resolved
        # results["failed"] — validation errors
    """

    def __init__(self, source: str):
        self.source = source
        self.normalizers: list[Callable] = []
        self.validators: list[Callable] = []

    def add_normalizer(self, fn: Callable):
        """Add a normalizer function: (dict) -> dict."""
        self.normalizers.append(fn)

    def add_validator(self, fn: Callable[[dict], Optional[str]]):
        """Add a validator function: (dict) -> error_message or None."""
        self.validators.append(fn)

    def run(self, observations: list[dict]) -> dict:
        ingested = []
        unresolved = []
        failed = []

        for raw in observations:
            # 1. Apply normalizers
            rec = raw
            for fn in self.normalizers:
                try:
                    rec = fn(rec)
                except Exception as e:
                    failed.append({"raw": raw, "error": f"normalizer error: {e}"})
                    continue

            # 2. Apply validators
            valid = True
            for fn in self.validators:
                try:
                    err = fn(rec)
                    if err:
                        failed.append({"raw": raw, "error": err})
                        valid = False
                        break
                except Exception as e:
                    failed.append({"raw": raw, "error": f"validator error: {e}"})
                    valid = False
                    break
            if not valid:
                continue

            # 3. Resolve BuildingID
            building_name = rec.get("building_name", "")
            area = rec.get("area", "")
            developer = rec.get("developer", "")
            bid, confidence, method = resolve(building_name, area, developer)

            # 4. Build Observation
            obs_id = str(uuid.uuid4())
            now = datetime.utcnow().isoformat() + "Z"

            observation = Observation(
                observation_id=obs_id,
                building_id=bid,
                observation_type=rec.get("observation_type", "SALE_LISTING"),
                source=self.source,
                observed_at=rec.get("observed_at", now[:10]),
                payload=rec.get("payload", {}),
                confidence=confidence,
                source_reference=rec.get("source_reference", ""),
                created_at=now,
            )

            if bid > 0:
                ingested.append(observation)
            else:
                obs = Observation(
                    observation_id=obs_id,
                    building_id=0,
                    observation_type=rec.get("observation_type", "SALE_LISTING"),
                    source=self.source,
                    observed_at=rec.get("observed_at", now[:10]),
                    payload=rec.get("payload", {}),
                    confidence=0.0,
                    source_reference=rec.get("source_reference", ""),
                    created_at=now,
                )
                unresolved.append(obs)

        # 5. Persist
        self._write_observations(ingested)
        self._write_unresolved(unresolved)

        return {
            "ingested": ingested,
            "unresolved": unresolved,
            "failed": failed,
        }

    def _write_observations(self, observations: list[Observation]):
        if not observations:
            return
        
        exists = os.path.exists(OBSERVATIONS_PATH)
        fieldnames = [
            "observation_id", "building_id", "observation_type", "source",
            "observed_at", "payload_json", "confidence", "source_reference",
            "created_at",
        ]

        with open(OBSERVATIONS_PATH, "a", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            if not exists:
                writer.writeheader()
            for obs in observations:
                row = obs.to_csv_row()
                row["payload_json"] = json.dumps(obs.payload, default=str)
                writer.writerow(row)

    def _write_unresolved(self, observations: list[Observation]):
        if not observations:
            return

        exists = os.path.exists(UNRESOLVED_PATH)
        fieldnames = [
            "observation_id", "building_id", "observation_type", "source",
            "observed_at", "payload_json", "confidence", "source_reference",
            "created_at", "raw_building_name", "raw_area",
        ]

        with open(UNRESOLVED_PATH, "a", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            if not exists:
                writer.writeheader()
            for obs in observations:
                row = obs.to_csv_row()
                row["payload_json"] = json.dumps(obs.payload, default=str)
                row["raw_building_name"] = obs.payload.get("building_name", "")
                row["raw_area"] = obs.payload.get("area", "")
                writer.writerow(row)


def default_validators() -> list[Callable]:
    """Built-in validators shared across all sources."""

    def has_observation_type(rec: dict) -> Optional[str]:
        if not rec.get("observation_type"):
            return "missing observation_type"
        return None

    def has_observed_at(rec: dict) -> Optional[str]:
        if not rec.get("observed_at"):
            return "missing observed_at"
        return None

    def has_building_name(rec: dict) -> Optional[str]:
        if not rec.get("building_name"):
            return "missing building_name (required for resolution)"
        return None

    return [has_observation_type, has_observed_at, has_building_name]


def default_normalizers() -> list[Callable]:
    """Built-in normalizers shared across all sources."""

    def trim_fields(rec: dict) -> dict:
        for key in ["building_name", "area", "developer"]:
            if key in rec and isinstance(rec[key], str):
                rec[key] = rec[key].strip()
        return rec

    def ensure_payload(rec: dict) -> dict:
        if "payload" not in rec:
            rec["payload"] = {}
        return rec

    def coerce_types(rec: dict) -> dict:
        if "price" in rec:
            if "payload" not in rec:
                rec["payload"] = {}
            rec["payload"]["price"] = rec.pop("price")
        if "bedrooms" in rec:
            if "payload" not in rec:
                rec["payload"] = {}
            rec["payload"]["bedrooms"] = rec.pop("bedrooms")
        return rec

    return [trim_fields, ensure_payload, coerce_types]


def create_pipeline(source: str) -> Pipeline:
    """Factory: build a fully-configured pipeline for a given source."""
    p = Pipeline(source)
    for fn in default_normalizers():
        p.add_normalizer(fn)
    for fn in default_validators():
        p.add_validator(fn)
    return p
