"""
Proactive intelligence engine for PropAI.
Analyzes knowledge records and surfaces actionable insights.
"""

import json
import sqlite3
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path


class IntelligenceEngine:
    """Analyzes knowledge records and generates insights."""

    def __init__(self, db_path: Path):
        self.db_path = db_path
        self._db: sqlite3.Connection | None = None

    @property
    def db(self) -> sqlite3.Connection:
        if self._db is None:
            self._db = sqlite3.connect(str(self.db_path), check_same_thread=False)
            self._db.row_factory = sqlite3.Row
        return self._db

    def get_daily_digest(self, days: int = 1) -> dict:
        """Generate a daily digest of market activity."""
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")

        # New listings
        listings = self.db.execute("""
            SELECT COUNT(*) as cnt,
                   GROUP_CONCAT(DISTINCT intent) as intents
            FROM knowledge_records
            WHERE content_type = 'listing' AND message_timestamp >= ? AND is_valid = 1
        """, (cutoff,)).fetchone()

        # New requirements
        requirements = self.db.execute("""
            SELECT COUNT(*) as cnt,
                   GROUP_CONCAT(DISTINCT intent) as intents
            FROM knowledge_records
            WHERE content_type = 'requirement' AND message_timestamp >= ? AND is_valid = 1
        """, (cutoff,)).fetchone()

        # Active markets
        markets = self.db.execute("""
            SELECT tag_value, COUNT(*) as cnt
            FROM knowledge_tags kt
            JOIN knowledge_records kr ON kr.id = kt.record_id
            WHERE kt.tag_type = 'market' AND kr.message_timestamp >= ? AND kr.is_valid = 1
            GROUP BY tag_value
            ORDER BY cnt DESC
            LIMIT 10
        """, (cutoff,)).fetchall()

        # Active buildings
        buildings = self.db.execute("""
            SELECT tag_value, COUNT(*) as cnt
            FROM knowledge_tags kt
            JOIN knowledge_records kr ON kr.id = kt.record_id
            WHERE kt.tag_type = 'building' AND kr.message_timestamp >= ? AND kr.is_valid = 1
            GROUP BY tag_value
            ORDER BY cnt DESC
            LIMIT 10
        """, (cutoff,)).fetchall()

        # Active senders
        senders = self.db.execute("""
            SELECT sender_name, sender_phone, COUNT(*) as cnt
            FROM knowledge_records
            WHERE message_timestamp >= ? AND is_valid = 1 AND sender_name IS NOT NULL
            GROUP BY sender_name
            ORDER BY cnt DESC
            LIMIT 10
        """, (cutoff,)).fetchall()

        # Total messages
        total = self.db.execute("""
            SELECT COUNT(*) FROM knowledge_records
            WHERE message_timestamp >= ? AND is_valid = 1
        """, (cutoff,)).fetchone()[0]

        return {
            "period": f"Last {days} day(s)",
            "total_messages": total,
            "new_listings": listings[0] if listings else 0,
            "new_requirements": requirements[0] if requirements else 0,
            "top_markets": [{"market": r[0], "count": r[1]} for r in markets],
            "top_buildings": [{"building": r[0], "count": r[1]} for r in buildings],
            "top_senders": [{"sender": r[0], "phone": r[1], "count": r[2]} for r in senders],
        }

    def get_price_insights(self) -> dict:
        """Analyze price patterns and detect anomalies."""
        # Average prices by market
        market_prices = self.db.execute("""
            SELECT kt_market.tag_value as market,
                   kt_bhk.tag_value as bhk,
                   AVG(CAST(kt_price.tag_value AS REAL)) as avg_price,
                   COUNT(*) as cnt
            FROM knowledge_tags kt_market
            JOIN knowledge_tags kt_bhk ON kt_bhk.record_id = kt_market.record_id AND kt_bhk.tag_type = 'bhk'
            JOIN knowledge_tags kt_price ON kt_price.record_id = kt_market.record_id AND kt_price.tag_type = 'price'
            JOIN knowledge_records kr ON kr.id = kt_market.record_id
            WHERE kt_market.tag_type = 'market' AND kr.is_valid = 1
            GROUP BY kt_market.tag_value, kt_bhk.tag_value
            HAVING cnt >= 2
            ORDER BY market, bhk
        """).fetchall()

        # Price distribution
        price_ranges = self.db.execute("""
            SELECT
                CASE
                    WHEN CAST(tag_value AS REAL) < 5000000 THEN 'Under 50L'
                    WHEN CAST(tag_value AS REAL) < 10000000 THEN '50L-1Cr'
                    WHEN CAST(tag_value AS REAL) < 20000000 THEN '1Cr-2Cr'
                    WHEN CAST(tag_value AS REAL) < 50000000 THEN '2Cr-5Cr'
                    ELSE '5Cr+'
                END as range,
                COUNT(*) as cnt
            FROM knowledge_tags
            WHERE tag_type = 'price' AND tag_value IS NOT NULL
            GROUP BY range
            ORDER BY MIN(CAST(tag_value AS REAL))
        """).fetchall()

        return {
            "market_prices": [
                {"market": r[0], "bhk": r[1], "avg_price": r[2], "count": r[3]}
                for r in market_prices
            ],
            "price_distribution": [{"range": r[0], "count": r[1]} for r in price_ranges],
        }

    def get_market_coverage(self) -> dict:
        """Analyze market coverage and identify gaps."""
        # All known markets
        all_markets = self.db.execute("""
            SELECT DISTINCT tag_value, COUNT(*) as mentions
            FROM knowledge_tags
            WHERE tag_type = 'market'
            GROUP BY tag_value
            ORDER BY mentions DESC
        """).fetchall()

        # Markets with listings
        markets_with_listings = self.db.execute("""
            SELECT DISTINCT kt.tag_value
            FROM knowledge_tags kt
            JOIN knowledge_records kr ON kr.id = kt.record_id
            WHERE kt.tag_type = 'market' AND kr.content_type = 'listing'
        """).fetchall()
        markets_with_listings = {r[0] for r in markets_with_listings}

        # Markets with requirements
        markets_with_requirements = self.db.execute("""
            SELECT DISTINCT kt.tag_value
            FROM knowledge_tags kt
            JOIN knowledge_records kr ON kr.id = kt.record_id
            WHERE kt.tag_type = 'market' AND kr.content_type = 'requirement'
        """).fetchall()
        markets_with_requirements = {r[0] for r in markets_with_requirements}

        coverage = []
        for market, mentions in all_markets:
            has_listings = market in markets_with_listings
            has_requirements = market in markets_with_requirements

            if has_listings and has_requirements:
                status = "balanced"
            elif has_listings:
                status = "supply_heavy"
            elif has_requirements:
                status = "demand_heavy"
            else:
                status = "mentions_only"

            coverage.append({
                "market": market,
                "mentions": mentions,
                "has_listings": has_listings,
                "has_requirements": has_requirements,
                "status": status,
            })

        return {
            "total_markets": len(all_markets),
            "balanced_markets": sum(1 for c in coverage if c["status"] == "balanced"),
            "supply_heavy": sum(1 for c in coverage if c["status"] == "supply_heavy"),
            "demand_heavy": sum(1 for c in coverage if c["status"] == "demand_heavy"),
            "markets": coverage[:20],
        }

    def get_broker_insights(self) -> dict:
        """Analyze broker activity and patterns."""
        # Top brokers by activity
        top_brokers = self.db.execute("""
            SELECT sender_name, sender_phone, COUNT(*) as messages,
                   SUM(CASE WHEN content_type = 'listing' THEN 1 ELSE 0 END) as listings,
                   SUM(CASE WHEN content_type = 'requirement' THEN 1 ELSE 0 END) as requirements
            FROM knowledge_records
            WHERE is_valid = 1 AND sender_name IS NOT NULL
            GROUP BY sender_name
            ORDER BY messages DESC
            LIMIT 20
        """).fetchall()

        # Broker specialization
        broker_markets = self.db.execute("""
            SELECT kr.sender_name, kt.tag_value as market, COUNT(*) as cnt
            FROM knowledge_records kr
            JOIN knowledge_tags kt ON kt.record_id = kr.id AND kt.tag_type = 'market'
            WHERE kr.is_valid = 1 AND kr.sender_name IS NOT NULL
            GROUP BY kr.sender_name, kt.tag_value
            HAVING cnt >= 2
            ORDER BY kr.sender_name, cnt DESC
        """).fetchall()

        # Group brokers by market
        market_brokers = defaultdict(list)
        for sender, market, cnt in broker_markets:
            market_brokers[market].append({"broker": sender, "count": cnt})

        return {
            "top_brokers": [
                {
                    "name": r[0], "phone": r[1], "messages": r[2],
                    "listings": r[3], "requirements": r[4],
                }
                for r in top_brokers
            ],
            "market_brokers": dict(list(market_brokers.items())[:10]),
        }

    def get_anomalies(self) -> list[dict]:
        """Detect anomalies in the data."""
        anomalies = []

        # Unusual prices (very high or very low)
        unusual_prices = self.db.execute("""
            SELECT kr.id, kr.raw_content, kr.sender_name, kt.tag_value as price
            FROM knowledge_records kr
            JOIN knowledge_tags kt ON kt.record_id = kr.id AND kt.tag_type = 'price'
            WHERE kr.is_valid = 1 AND CAST(kt.tag_value AS REAL) > 0
            AND (CAST(kt.tag_value AS REAL) > 50000000 OR CAST(kt.tag_value AS REAL) < 1000000)
        """).fetchall()

        for r in unusual_prices:
            anomalies.append({
                "type": "unusual_price",
                "record_id": r[0],
                "description": f"Unusual price: ₹{r[3]}",
                "content": r[1][:100] if r[1] else "",
                "sender": r[2],
            })

        # New markets (first mention)
        new_markets = self.db.execute("""
            SELECT kt.tag_value, MIN(kr.message_timestamp) as first_seen
            FROM knowledge_tags kt
            JOIN knowledge_records kr ON kr.id = kt.record_id
            WHERE kt.tag_type = 'market' AND kr.is_valid = 1
            GROUP BY kt.tag_value
            HAVING first_seen >= datetime('now', '-7 days')
        """).fetchall()

        for r in new_markets:
            anomalies.append({
                "type": "new_market",
                "description": f"New market mentioned: {r[0]}",
                "first_seen": r[1],
            })

        return anomalies

    def get_actionable_insights(self) -> list[dict]:
        """Generate actionable insights for the broker."""
        insights = []

        # 1. Unmatched requirements
        unmatched = self.db.execute("""
            SELECT COUNT(*) FROM knowledge_records
            WHERE content_type = 'requirement' AND is_valid = 1
        """).fetchone()[0]

        if unmatched > 0:
            insights.append({
                "type": "opportunity",
                "title": f"{unmatched} unmatched requirements",
                "description": "There are buyers looking for properties. Match them with your listings.",
                "action": "View requirements",
                "priority": "high",
            })

        # 2. Markets with high demand but low supply
        demand_supply = self.db.execute("""
            SELECT kt.tag_value as market,
                   SUM(CASE WHEN kr.content_type = 'requirement' THEN 1 ELSE 0 END) as demand,
                   SUM(CASE WHEN kr.content_type = 'listing' THEN 1 ELSE 0 END) as supply
            FROM knowledge_tags kt
            JOIN knowledge_records kr ON kr.id = kt.record_id
            WHERE kt.tag_type = 'market' AND kr.is_valid = 1
            GROUP BY kt.tag_value
            HAVING demand > supply * 2 AND demand >= 3
            ORDER BY (demand - supply) DESC
            LIMIT 5
        """).fetchall()

        for r in demand_supply:
            insights.append({
                "type": "market_gap",
                "title": f"{r[0]}: High demand, low supply",
                "description": f"Demand: {r[1]}, Supply: {r[2]}. Consider listing properties here.",
                "action": f"View {r[0]} listings",
                "priority": "medium",
            })

        return insights

    def generate_full_report(self) -> dict:
        """Generate a comprehensive intelligence report."""
        return {
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "digest": self.get_daily_digest(days=7),
            "price_insights": self.get_price_insights(),
            "market_coverage": self.get_market_coverage(),
            "broker_insights": self.get_broker_insights(),
            "anomalies": self.get_anomalies(),
            "actionable_insights": self.get_actionable_insights(),
        }


# Global instance
_engine: IntelligenceEngine | None = None


def get_engine(db_path: Path | None = None) -> IntelligenceEngine:
    """Get or create the global intelligence engine."""
    global _engine
    if _engine is None:
        if db_path is None:
            db_path = Path(__file__).parent.parent / "lab.db"
        _engine = IntelligenceEngine(db_path)
    return _engine
