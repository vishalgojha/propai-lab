"""Building Discovery - Extract canonical building names from parsed observations."""

import re
import logging
from collections import Counter
from typing import Optional

logger = logging.getLogger(__name__)


# Common building name patterns in Mumbai
BUILDING_PATTERNS = [
    # "Kanakia Paris" style
    r'^([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+)$',
    # "Kanakia Paris 2" style
    r'^([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+\s+\d+)$',
    # "XYZ Tower" style
    r'^([A-Z][a-zA-Z]+\s+(?:Tower|Tower|Residency|Residences|Heights|Heights|Apartment|Apartments|Complex|Enclave|Paradise|Villa|Villas|Park|Gardens|Heights|Enclave))$',
]

# Words that indicate non-building names
NON_BUILDING_WORDS = {
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
    "with", "by", "from", "of", "near", "behind", "next", "opp", "nearby",
    "flat", "apartment", "bungalow", "villa", "house", "room", "office",
    "shop", "showroom", "godown", "warehouse", "factory",
    "road", "street", "lane", "main", "west", "east", "north", "south",
    "near", "opposite", "behind", "next", "adjacent",
}

# Common Mumbai building name suffixes
BUILDING_SUFFIXES = {
    "tower", "towers", "residency", "residences", "heights", "height",
    "apartment", "apartments", "complex", "enclave", "paradise",
    "villa", "villas", "park", "gardens", "heights", "enclave",
    "chambers", "house", "building", "center", "centre", "plaza",
    "mall", "market", "court", "nagar", "colony", "society",
}


class BuildingDiscovery:
    """Discovers and normalizes canonical building names from WhatsApp observations."""

    def __init__(self, storage):
        self.storage = storage

    def _normalize_building_name(self, raw_name: str) -> str:
        """Normalize a raw building name to canonical form."""
        if not raw_name:
            return ""

        # Remove extra whitespace
        name = " ".join(raw_name.split())

        # Remove common prefixes/suffixes that aren't part of the name
        name = re.sub(r'^(the|a|an)\s+', '', name, flags=re.IGNORECASE)

        # Remove trailing punctuation
        name = name.rstrip('.,;:!?')

        # Title case the name
        words = name.split()
        normalized_words = []
        for word in words:
            if word.upper() in {"BKC", "CBD", "SEZ", "IT", "ITC", "DNA", "RSS", "NGO"}:
                normalized_words.append(word.upper())
            elif word.lower() in {"no", "ph", "wing", "block", "flat"}:
                normalized_words.append(word.upper() if len(word) <= 2 else word.capitalize())
            else:
                normalized_words.append(word.capitalize())

        return " ".join(normalized_words)

    def _is_valid_building_name(self, name: str) -> bool:
        """Check if a string looks like a valid building name."""
        if not name or len(name) < 3:
            return False

        # Skip if it's mostly numbers
        if sum(c.isdigit() for c in name) > len(name) * 0.5:
            return False

        # Skip if it contains too many non-building words
        words = name.lower().split()
        non_building_count = sum(1 for w in words if w in NON_BUILDING_WORDS)
        if non_building_count > len(words) * 0.5:
            return False

        # Skip if it's too short after removing common words
        cleaned = " ".join(w for w in words if w not in NON_BUILDING_WORDS)
        if len(cleaned) < 3:
            return False

        return True

    def _extract_building_from_message(self, message: str) -> Optional[str]:
        """Try to extract a building name from a WhatsApp message."""
        if not message:
            return None

        # Look for common patterns
        # "X near Y" pattern
        near_match = re.search(r'([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+)\s+(?:near|opp|behind|next)\s+', message)
        if near_match:
            return near_match.group(1)

        # "X Road" or "X Street" pattern
        road_match = re.search(r'([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+)\s+(?:Road|Street|Lane|Main|West|East)', message)
        if road_match:
            return road_match.group(1)

        # "X BKC" or "X Andheri" pattern
        area_match = re.search(r'([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+)\s+(?:BKC|Andheri|Bandra|Juhu|Powai|Worli|Lower Parel|Nariman Point)', message)
        if area_match:
            return area_match.group(1)

        return None

    def discover_from_observations(self, min_observations: int = 2) -> list[dict]:
        """Discover canonical building names from parsed_output.

        Args:
            min_observations: Minimum number of observations to consider a building canonical

        Returns:
            List of discovered buildings with metadata
        """
        # Get all building names from parsed_output
        rows = self.storage.db.execute("""
            SELECT building_name, COUNT(*) as obs_count,
                   COUNT(DISTINCT micro_market) as markets,
                   COUNT(DISTINCT broker_name) as brokers,
                   GROUP_CONCAT(DISTINCT micro_market) as market_list,
                   MIN(created_at) as first_seen,
                   MAX(created_at) as last_seen
            FROM parsed_output
            WHERE building_name IS NOT NULL AND building_name != ''
            GROUP BY LOWER(building_name)
            HAVING obs_count >= ?
            ORDER BY obs_count DESC
        """, (min_observations,)).fetchall()

        discovered = []
        for r in rows:
            raw_name = r["building_name"]
            canonical = self._normalize_building_name(raw_name)

            if not self._is_valid_building_name(canonical):
                logger.debug(f"Skipping invalid building name: {raw_name}")
                continue

            # Check if already exists
            existing = self.storage.db.execute(
                "SELECT id, building_id FROM buildings WHERE canonical_name = ?",
                (canonical,)
            ).fetchone()

            if existing:
                discovered.append({
                    "id": existing["id"],
                    "building_id": existing["building_id"],
                    "canonical_name": canonical,
                    "raw_name": raw_name,
                    "obs_count": r["obs_count"],
                    "markets": r["markets"],
                    "brokers": r["brokers"],
                    "market_list": r["market_list"],
                    "first_seen": r["first_seen"],
                    "last_seen": r["last_seen"],
                    "already_existed": True,
                })
                continue

            # Create new building
            micro_markets = [m.strip() for m in (r["market_list"] or "").split(",") if m.strip()]
            primary_market = micro_markets[0] if micro_markets else None

            result = self.storage.create_building(
                canonical_name=canonical,
                micro_market=primary_market,
            )

            if result:
                # Create the primary alias
                self.storage.create_building_alias(
                    result["id"], canonical, canonical, confidence=1.0, source="whatsapp"
                )

                # Also create aliases for the raw name if different
                if raw_name != canonical:
                    self.storage.create_building_alias(
                        result["id"], raw_name, canonical, confidence=0.9, source="whatsapp"
                    )

                discovered.append({
                    **result,
                    "canonical_name": canonical,
                    "raw_name": raw_name,
                    "obs_count": r["obs_count"],
                    "markets": r["markets"],
                    "brokers": r["brokers"],
                    "market_list": r["market_list"],
                    "first_seen": r["first_seen"],
                    "last_seen": r["last_seen"],
                    "already_existed": False,
                })

                logger.info(f"Discovered building: {canonical} (ID: {result['building_id']}, {r['obs_count']} observations)")

        return discovered

    def create_enrichment_jobs(self, provider: str = "igr", priority: int = 0) -> int:
        """Create enrichment jobs for all discovered buildings that haven't been enriched yet.

        Returns:
            Number of jobs created
        """
        buildings = self.storage.db.execute("""
            SELECT id FROM buildings
            WHERE status = 'discovered'
            AND id NOT IN (
                SELECT building_id FROM building_enrichment_jobs
                WHERE provider = ? AND status IN ('pending', 'running')
            )
            ORDER BY observed_listings DESC
        """, (provider,)).fetchall()

        count = 0
        for b in buildings:
            if self.storage.create_building_enrichment_job(b["id"], provider, priority):
                count += 1

        return count
