"""Building Discovery - Extract canonical building names from parsed observations."""

import re
import logging
from collections import Counter
from typing import Optional

from extraction_quality import building_name_problem

logger = logging.getLogger(__name__)

# Common building name patterns/suffixes retained for callers that import them.
BUILDING_PATTERNS = [
    r'^([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+)$',
    r'^([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+\s+\d+)$',
]
BUILDING_SUFFIXES = {
    "tower", "towers", "residency", "residences", "heights", "height",
    "apartment", "apartments", "complex", "enclave", "paradise", "villa",
    "villas", "park", "gardens", "chambers", "house", "building", "center",
    "centre", "plaza", "mall", "market", "court", "nagar", "colony", "society",
}

NON_BUILDING_WORDS = {
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
    "with", "by", "from", "of", "near", "behind", "next", "opp", "nearby",
    "flat", "apartment", "bungalow", "villa", "house", "room", "office",
    "shop", "showroom", "godown", "warehouse", "factory", "road", "street",
    "lane", "main", "west", "east", "north", "south", "opposite", "adjacent",
    "quote", "suitable", "available", "sale", "rent", "price", "cr", "crore",
    "lakh", "bhk", "sqft", "carpet", "possession",
}

PRICE_PATTERN = re.compile(
    r"(?:₹\s*)?[\d][\d,.]*\s*(?:cr|crore|lakh|l)\b",
    flags=re.IGNORECASE,
)


class BuildingDiscovery:
    """Discovers and normalizes canonical building names from observations."""

    def __init__(self, storage):
        self.storage = storage

    def _normalize_building_name(self, raw_name: str) -> str:
        if not raw_name:
            return ""
        name = " ".join(raw_name.split())
        name = re.sub(r"^(the|a|an)\s+", "", name, flags=re.IGNORECASE).rstrip(".,;:!?")
        words = name.split()
        normalized = []
        for word in words:
            if word.upper() in {"BKC", "CBD", "SEZ", "IT", "ITC", "DNA", "RSS", "NGO"}:
                normalized.append(word.upper())
            elif word.lower() in {"no", "ph", "wing", "block", "flat"}:
                normalized.append(word.upper() if len(word) <= 2 else word.capitalize())
            else:
                normalized.append(word.capitalize())
        return " ".join(normalized)

    def _is_valid_building_name(self, name: str) -> bool:
        if not name or len(name) < 3:
            return False
        if building_name_problem(name):
            return False
        if PRICE_PATTERN.search(name):
            return False
        if sum(c.isdigit() for c in name) > len(name) * 0.5:
            return False
        words = re.findall(r"[a-z0-9]+", name.lower())
        if not words:
            return False
        blocked_count = sum(
            word in NON_BUILDING_WORDS and word not in BUILDING_SUFFIXES
            for word in words
        )
        if blocked_count >= len(words) * 0.5:
            return False
        meaningful_words = [
            word for word in words
            if word not in NON_BUILDING_WORDS or word in BUILDING_SUFFIXES
        ]
        return len(" ".join(meaningful_words)) >= 3

    def _extract_building_from_message(self, message: str) -> Optional[str]:
        if not message:
            return None
        for pattern in (
            r"([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+)\s+(?:near|opp|behind|next)\s+",
            r"([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+)\s+(?:Road|Street|Lane|Main|West|East)",
            r"([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+)\s+(?:BKC|Andheri|Bandra|Juhu|Powai|Worli|Lower Parel|Nariman Point)",
        ):
            match = re.search(pattern, message)
            if match:
                return match.group(1)
        return None

    def discover_from_observations(self, min_observations: int = 2) -> list[dict]:
        # SupabaseStorage exposes a compatibility ``db`` adapter for legacy
        # callers, but its SQL RPC path cannot query the compatibility view
        # reliably in every production schema revision. Use the typed source
        # tables for hosted storage; local SQLite doubles still use the view.
        if hasattr(self.storage, "client"):
            grouped = {}
            for table in (
                "residential_sale_listings", "residential_rent_listings",
                "commercial_sale_listings", "commercial_rent_listings",
                "residential_sale_requirements", "residential_rent_requirements",
                "commercial_sale_requirements", "commercial_rent_requirements",
            ):
                result = self.storage.client.table(table).select(
                    "building_name,micro_market,broker_name,created_at"
                ).filter("building_name", "not.is", "null").execute()
                for item in result.data or []:
                    raw = (item.get("building_name") or "").strip()
                    locality = (item.get("micro_market") or "").strip()
                    if not raw or not locality:
                        continue
                    bucket_key = (raw.casefold(), locality.casefold())
                    bucket = grouped.setdefault(bucket_key, {
                        "building_name": raw, "micro_market": locality,
                        "obs_count": 0, "brokers": set(),
                        "first_seen": item.get("created_at"),
                        "last_seen": item.get("created_at"),
                    })
                    bucket["obs_count"] += 1
                    if item.get("broker_name"):
                        bucket["brokers"].add(item["broker_name"])
                    created_at = item.get("created_at")
                    if created_at:
                        bucket["first_seen"] = min(bucket["first_seen"] or created_at, created_at)
                        bucket["last_seen"] = max(bucket["last_seen"] or created_at, created_at)
            rows = [
                {**bucket, "brokers": len(bucket["brokers"]), "markets": 1,
                 "market_list": bucket["micro_market"]}
                for bucket in grouped.values()
                if bucket["obs_count"] >= min_observations
            ]
        elif hasattr(self.storage, "db"):
            rows = self.storage.db.execute("""
            SELECT MIN(p.building_name) as building_name,
                   MIN(p.micro_market) as micro_market,
                   COUNT(*) as obs_count,
                   COUNT(DISTINCT p.broker_name) as brokers,
                   MIN(created_at) as first_seen, MAX(created_at) as last_seen
            FROM parsed_output_unified p
            WHERE p.building_name IS NOT NULL AND p.building_name != ''
              AND p.micro_market IS NOT NULL AND p.micro_market != ''
            GROUP BY LOWER(p.building_name), LOWER(p.micro_market)
            HAVING obs_count >= ? ORDER BY obs_count DESC
            """, (min_observations,)).fetchall()
        else:
            grouped = {}
            for table in (
                "residential_sale_listings", "residential_rent_listings",
                "commercial_sale_listings", "commercial_rent_listings",
                "residential_sale_requirements", "residential_rent_requirements",
                "commercial_sale_requirements", "commercial_rent_requirements",
            ):
                result = self.storage.client.table(table).select(
                    "building_name,micro_market,broker_name,created_at"
                ).filter("building_name", "not.is", "null").execute()
                for item in result.data or []:
                    raw = (item.get("building_name") or "").strip()
                    if not raw:
                        continue
                    locality = (item.get("micro_market") or "").strip()
                    if not locality:
                        continue
                    bucket_key = (raw.casefold(), locality.casefold())
                    bucket = grouped.setdefault(bucket_key, {
                        "building_name": raw, "markets": Counter(), "brokers": set(),
                        "micro_market": locality,
                        "count": 0, "first_seen": item.get("created_at"),
                        "last_seen": item.get("created_at"),
                    })
                    bucket["count"] += 1
                    if item.get("micro_market"):
                        bucket["markets"][item["micro_market"]] += 1
                    if item.get("broker_name"):
                        bucket["brokers"].add(item["broker_name"])
                    bucket["first_seen"] = min(bucket["first_seen"] or item.get("created_at"), item.get("created_at") or bucket["first_seen"])
                    bucket["last_seen"] = max(bucket["last_seen"] or item.get("created_at"), item.get("created_at") or bucket["last_seen"])
            rows = [{
                "building_name": b["building_name"], "obs_count": b["count"],
                "markets": len(b["markets"]), "brokers": len(b["brokers"]),
                "micro_market": b["micro_market"],
                "market_list": b["micro_market"],
                "first_seen": b["first_seen"], "last_seen": b["last_seen"],
            } for b in grouped.values() if b["count"] >= min_observations]

        discovered = []
        for row in rows:
            raw_name = row["building_name"]
            canonical = self._normalize_building_name(raw_name)
            if not self._is_valid_building_name(canonical):
                continue
            locality = row.get("micro_market") or row.get("primary_market")
            existing = self.storage.get_building(canonical_name=canonical, micro_market=locality)
            if existing:
                discovered.append({**existing, "canonical_name": canonical,
                                   "raw_name": raw_name, "obs_count": row["obs_count"],
                                   "markets": row.get("markets"), "brokers": row.get("brokers"),
                                   "market_list": row.get("market_list"),
                                   "first_seen": row.get("first_seen"), "last_seen": row.get("last_seen"),
                                   "already_existed": True})
                continue
            markets = [m.strip() for m in (row.get("market_list") or "").split(",") if m.strip()]
            result = self.storage.create_building(
                canonical_name=canonical,
                micro_market=locality or (markets[0] if markets else None),
            )
            if result:
                self.storage.create_building_alias_for_building(
                    result["id"], canonical, canonical, confidence=1.0, source="whatsapp"
                )
                if raw_name != canonical:
                    self.storage.create_building_alias_for_building(
                        result["id"], raw_name, canonical, confidence=0.9, source="whatsapp"
                    )
                discovered.append({**result, "canonical_name": canonical, "raw_name": raw_name,
                                   "obs_count": row["obs_count"], "markets": row.get("markets"),
                                   "brokers": row.get("brokers"), "market_list": row.get("market_list"),
                                   "first_seen": row.get("first_seen"), "last_seen": row.get("last_seen"),
                                   "already_existed": False})
                logger.info("Discovered building: %s (ID: %s, %s observations)",
                            canonical, result.get("building_id"), row["obs_count"])
        return discovered

    def create_enrichment_jobs(self, provider: str = "google_places", priority: int = 0) -> int:
        buildings = self.storage.get_buildings(limit=10000)
        active = self.storage.client.table("building_enrichment_jobs").select(
            "building_id"
        ).eq("provider", provider).in_("status", ["pending", "running"]).execute()
        active_ids = {row["building_id"] for row in (active.data or [])}
        count = 0
        for building in buildings:
            if building.get("status") == "discovered" and building.get("id") not in active_ids:
                if self.storage.create_building_enrichment_job(building["id"], provider, priority):
                    count += 1
        return count
