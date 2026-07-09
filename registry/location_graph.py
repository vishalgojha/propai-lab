"""
Location Graph — hierarchical geography for Mumbai real estate.

Enables queries at any level of granularity:
  - "All luxury buildings in Bandra West"
  - "Streets in South Mumbai"
  - "What zone is Worli in?"
  - "Buildings near Mount Mary Church"
  - "IGR transactions on Linking Road"

Hierarchy:
  City → Zone → Micro Market → Landmark → Street → Building → Wing → Unit
"""
import csv
import os
from collections import defaultdict

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ZONES_PATH = os.path.join(BASE_DIR, "data", "location_zones.csv")
LOCATION_GRAPH_PATH = os.path.join(BASE_DIR, "data", "location_graph.csv")

# ── Zone → Micro Market definitions ────────────────────────────
ZONES = {
    "South Mumbai": [
        "South Mumbai Prime", "South Mumbai Central", "Fort", "Colaba",
        "Nariman Point", "Malabar Hill", "Prabhadevi", "Lower Parel",
        "Worli", "Mahalaxmi", "Parel", "Byculla", "Dadar West",
        "Grant Road", "Marine Drive", "Tardeo", "Breach Candy",
        "Cuffe Parade", "Churchgate", "Mumbai Central", "Girgaon",
        "Kemps Corner", "Nana Chowk", "Opera House", "Walkeshwar",
    ],
    "Western Suburbs": [
        "Bandra West", "Bandra East", "Khar West", "Santacruz West",
        "Vile Parle West", "Andheri West", "Andheri East", "Jogeshwari West",
        "Goregaon West", "Goregaon East", "Malad West", "Kandivali West",
        "Kandivali East", "Borivali West", "Borivali East", "Dahisar West",
        "Dahisar East", "Juhu", "Versova", "Powai", "Oshiwara",
        "Lokhandwala", "Mahim", "JVPD", "Vile Parle East",
        "Khar East", "Santacruz East", "Jogeshwari East",
    ],
    "Eastern Suburbs": [
        "Kurla", "Sion", "Chembur", "Ghatkopar West", "Ghatkopar East",
        "Vikhroli", "Kanjur Marg", "Bhandup West", "Bhandup East",
        "Mulund West", "Mulund East", "Nahur", "Kanjurmarg East",
    ],
    "Navi Mumbai": [
        "Navi Mumbai", "Airoli", "Ghansoli", "Koparkhairne", "Vashi",
        "Sanpada", "Nerul", "Belapur", "Kharghar", "Panvel",
        "New Panvel", "Dronagiri", "Ulwe", "Kalamboli", "Kamothe",
        "Khandeshwar",
    ],
    "Thane": [
        "Thane West", "Thane East", "Mira Road", "Bhayandar",
        "Bhiwandi", "Dombivali", "Kalyan", "Ambernath", "Badlapur",
        "Ulhasnagar",
    ],
}

# Reverse: micro_market → zone
MICRO_MARKET_TO_ZONE = {}
for zone, markets in ZONES.items():
    for mm in markets:
        MICRO_MARKET_TO_ZONE[mm.lower()] = zone


def zone_for_micro_market(micro_market: str) -> str:
    """Get the zone for a given micro market name."""
    return MICRO_MARKET_TO_ZONE.get(micro_market.lower(), "")


def write_location_graph():
    """Write the location graph as CSV."""
    rows = []

    # Micro markets
    for zone, markets in ZONES.items():
        for mm in markets:
            rows.append({
                "entity_type": "micro_market",
                "name": mm,
                "parent_type": "zone",
                "parent_name": zone,
            })

    # Landmarks (from landmark registry)
    lm_path = os.path.join(BASE_DIR, "data", "landmarks.csv")
    if os.path.exists(lm_path):
        with open(lm_path) as f:
            for row in csv.DictReader(f):
                mm = row.get("micro_market", "").strip()
                rows.append({
                    "entity_type": "landmark",
                    "name": row["name"],
                    "parent_type": "micro_market",
                    "parent_name": mm,
                })

    # Zones
    for zone in ZONES:
        rows.append({
            "entity_type": "zone",
            "name": zone,
            "parent_type": "city",
            "parent_name": "Mumbai",
        })

    # City
    rows.append({
        "entity_type": "city",
        "name": "Mumbai",
        "parent_type": "",
        "parent_name": "",
    })

    with open(LOCATION_GRAPH_PATH, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["entity_type", "name", "parent_type", "parent_name"])
        writer.writeheader()
        writer.writerows(rows)

    print(f"  Wrote {len(rows)} location graph entries to {LOCATION_GRAPH_PATH}")


def load_location_graph() -> dict:
    """Load location graph into memory as a dict of relationships."""
    if not os.path.exists(LOCATION_GRAPH_PATH):
        return {}

    graph = {}
    with open(LOCATION_GRAPH_PATH) as f:
        for row in csv.DictReader(f):
            entity_type = row["entity_type"]
            name = row["name"]
            graph[(entity_type, name.lower())] = {
                "entity_type": entity_type,
                "name": name,
                "parent_type": row["parent_type"],
                "parent_name": row["parent_name"],
            }
    return graph


def children_of(parent_type: str, parent_name: str) -> list[str]:
    """Get all child entities of a given parent."""
    graph = load_location_graph()
    results = []
    for (etype, name_lower), info in graph.items():
        if info["parent_type"] == parent_type and info["parent_name"].lower() == parent_name.lower():
            results.append(info["name"])
    return results


def micro_markets_in_zone(zone: str) -> list[str]:
    """Get all micro markets in a zone."""
    return children_of("zone", zone)


def streets_in_micro_market(micro_market: str, streets: list) -> list:
    """Filter a street list to those in a given micro market."""
    return [s for s in streets if s.micro_market.lower() == micro_market.lower()]


def buildings_on_street(street_name: str, streets: list) -> list[int]:
    """Get all building IDs on a given street."""
    for s in streets:
        if s.name.lower() == street_name.lower():
            return s.building_ids
    return []


def resolve_street(query: str, streets: list) -> list:
    """Resolve a street mention (maybepartial, from WhatsApp/IGR) to Street objects.
    
    "near Hill Road" → Hill Road
    "opposite Mehboob" → lookup landmarks → Hill Road
    "Linking Rd" → Linking Road
    """
    query_lower = query.lower().strip()

    # Strip common prefixes
    for prefix in ["near ", "opposite ", "behind ", "above ", "next to ", "across "]:
        if query_lower.startswith(prefix):
            query_lower = query_lower[len(prefix):].strip()
            break

    matches = []
    for s in streets:
        # Direct name match
        if query_lower == s.name.lower():
            matches.append(s)
            continue
        # Alias match
        for alias in s.aliases:
            if query_lower == alias.lower():
                matches.append(s)
                break
        # Partial match (for queries like "Hill" → "Hill Road")
        if len(query_lower) >= 4:
            if query_lower in s.name.lower():
                matches.append(s)
                continue
            for alias in s.aliases:
                if query_lower in alias.lower():
                    matches.append(s)
                    break

    return matches


if __name__ == "__main__":
    write_location_graph()
    print(f"Zones: {len(ZONES)}")
    print(f"Micro markets: {sum(len(v) for v in ZONES.values())}")
