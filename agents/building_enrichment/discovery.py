"""Building Discovery - Extract canonical building names from parsed observations."""

import re
import logging
from collections import Counter
from typing import Optional

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
}


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
        if sum(c.isdigit() for c in name) > len(name) * 0.5:
            return False
        words = name.lower().split()
        if sum(w in NON_BUILDING_WORDS for w in words) > len(words) * 0.5:
            return False
        return len(" ".join(w for w in words if w not in NON_BUILDING_WORDS)) >= 3

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
        if hasattr(self.storage, "db"):
            rows = self.storage.db.execute("""
            SELECT p.building_name, COUNT(*) as obs_count,
                   COUNT(DISTINCT p.micro_market) as markets,
                   COUNT(DISTINCT p.broker_name) as brokers,
                   STRING_AGG(DISTINCT p.micro_market, ',') as market_list,
                   (
                     SELECT micro_market FROM parsed_output_unified p2
                     WHERE LOWER(p2.building_name) = LOWER(p.building_name)
                       AND p2.micro_market IS NOT NULL AND p2.micro_market != ''
                     GROUP BY p2.micro_market ORDER BY COUNT(*) DESC LIMIT 1
                   ) as primary_market,
                   MIN(created_at) as first_seen, MAX(created_at) as last_seen
            FROM parsed_output_unified p
            WHERE p.building_name IS NOT NULL AND p.building_name != ''
            GROUP BY LOWER(p.building_name)
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
                    bucket = grouped.setdefault(raw.casefold(), {
                        "building_name": raw, "markets": Counter(), "brokers": set(),
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
                "market_list": ",".join(b["markets"].keys()),
                "primary_market": b["markets"].most_common(1)[0][0] if b["markets"] else None,
                "first_seen": b["first_seen"], "last_seen": b["last_seen"],
            } for b in grouped.values() if b["count"] >= min_observations]

        discovered = []
        for row in rows:
            raw_name = row["building_name"]
            canonical = self._normalize_building_name(raw_name)
            if not self._is_valid_building_name(canonical):
                continue
            existing = self.storage.get_building(canonical_name=canonical)
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
                micro_market=(row.get("primary_market") or (markets[0] if markets else None)),
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
