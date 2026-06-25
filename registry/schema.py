"""
Schema for the Canonical Building Registry.

- canonical_buildings: one row per real building
- review_queue: uncertain matches requiring human confirmation
"""
from dataclasses import dataclass, field
from typing import Optional

CANONICAL_FIELDS = [
    "building_id",
    "fingerprint",
    "canonical_name",
    "aliases",
    "area",
    "micro_market",
    "latitude",
    "longitude",
    "pincode",
    "developer",
    "confidence_score",
    "health_score",
    "source_urls",
    "first_seen",
    "last_seen",
]

REVIEW_FIELDS = [
    "candidate_a_id",
    "candidate_a_name",
    "candidate_a_area",
    "candidate_b_id",
    "candidate_b_name",
    "candidate_b_area",
    "confidence_score",
    "evidence",
    "recommended_action",
    "status",
]


@dataclass
class BuildingRecord:
    building_id: int
    fingerprint: str = ""
    canonical_name: str = ""
    aliases: list[str] = field(default_factory=list)
    area: str = ""
    micro_market: str = ""
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    pincode: Optional[str] = None
    developer: Optional[str] = None
    confidence_score: int = 100
    source_urls: list[str] = field(default_factory=list)
    first_seen: str = ""
    last_seen: str = ""

    def to_dict(self):
        return {
            "building_id": self.building_id,
            "fingerprint": self.fingerprint,
            "canonical_name": self.canonical_name,
            "aliases": " | ".join(self.aliases),
            "area": self.area,
            "micro_market": self.micro_market,
            "latitude": self.latitude or "",
            "longitude": self.longitude or "",
            "pincode": self.pincode or "",
            "developer": self.developer or "",
            "confidence_score": self.confidence_score,
            "health_score": self.health_score if hasattr(self, 'health_score') else 0,
            "source_urls": " | ".join(self.source_urls),
            "first_seen": self.first_seen,
            "last_seen": self.last_seen,
        }


@dataclass
class ReviewItem:
    candidate_a_id: int
    candidate_a_name: str
    candidate_a_area: str
    candidate_b_id: int
    candidate_b_name: str
    candidate_b_area: str
    confidence_score: int
    evidence: str
    recommended_action: str  # "merge", "flag", "ask"
    status: str = "pending"

    def to_dict(self):
        return {
            "candidate_a_id": self.candidate_a_id,
            "candidate_a_name": self.candidate_a_name,
            "candidate_a_area": self.candidate_a_area,
            "candidate_b_id": self.candidate_b_id,
            "candidate_b_name": self.candidate_b_name,
            "candidate_b_area": self.candidate_b_area,
            "confidence_score": self.confidence_score,
            "evidence": self.evidence,
            "recommended_action": self.recommended_action,
            "status": self.status,
        }
