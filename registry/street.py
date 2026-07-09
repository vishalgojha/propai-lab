"""
Street Registry — location infrastructure for the Evidence Engine.

Streets are a first-class canonical entity alongside buildings.
Every building sits on one or more streets. Every street belongs
to a micro market.

This enables:
  - "Show me buildings on Carter Road"
  - "Property near Hill Road" (WhatsApp/IGR)
  - "3 BHK near Mehboob Studio" (landmark → street → buildings)
  - IGR address resolution (survey number → street → micro market)
"""
import csv
import json
import os
import re
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Optional

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STREETS_PATH = os.path.join(BASE_DIR, "data", "streets.csv")
BUILDING_STREETS_PATH = os.path.join(BASE_DIR, "data", "building_streets.csv")

STREET_SUFFIXES = {"road", "street", "marg", "lane", "avenue", "drive", "highway", "way", "path"}

# Known Mumbai streets that may not appear in our existing data
# Each: (name, aliases, micro_market, pincodes, buildings_along_this_street)
KNOWN_MUMBAI_STREETS = [
    # South Mumbai
    ("Altamount Road", ["Altamount Rd", "Altamont Road", "Dr Gopalrao Deshmukh Marg"], "South Mumbai Prime", ["400026"]),
    ("Nepean Sea Road", ["Nepean Sea Rd", "Nepean Road", "Lady Hardinge Road"], "South Mumbai Prime", ["400036"]),
    ("Peddar Road", ["Peddar Rd", "Pedar Road"], "South Mumbai Prime", ["400026"]),
    ("Marine Drive", ["Marine Dr", "Netaji Subhash Chandra Bose Road", "Queens Necklace"], "South Mumbai Prime", ["400020"]),
    ("Carmichael Road", ["Carmichael Rd", "Carmichael"], "South Mumbai Prime", ["400026"]),
    ("Warden Road", ["Warden Rd", "Dr Bhadkamkar Marg"], "South Mumbai Prime", ["400026"]),
    ("Hughes Road", ["Hughes Rd", "Bhulabhai Desai Marg"], "South Mumbai Prime", ["400036"]),
    ("Grant Road", ["Grant Rd", "Maulana Shaukat Ali Marg"], "South Mumbai Central", ["400036"]),
    ("Breach Candy", ["Breach Candy Marg", "Bhulabhai Desai Road"], "South Mumbai Prime", ["400026"]),
    ("LBS Marg", ["Lbs Road", "Lal Bahadur Shastri Marg", "L B S Marg"], "Eastern Suburbs", ["400070"]),
    ("Cuffe Parade", ["Cuffe Parade Marg"], "South Mumbai Prime", ["400005"]),
    
    # Western Suburbs
    ("Linking Road", ["Linking Rd", "Link Road"], "Bandra West", ["400050", "400052", "400064"]),
    ("Hill Road", ["Hill Rd", "Hillroad", "Dr Ambedkar Road"], "Bandra West", ["400050"]),
    ("Carter Road", ["Carter Rd", "Carterroad"], "Bandra West", ["400050"]),
    ("Turner Road", ["Turner Rd", "Gurunanak Marg"], "Bandra West", ["400050"]),
    ("SV Road", ["S V Road", "Swami Vivekanand Road", "Sv Rd"], "Khar West", ["400052", "400058", "400057"]),
    ("Juhu Tara Road", ["Juhu Tara Rd", "Juhu Tara"], "Juhu", ["400058"]),
    ("Yari Road", ["Yari Rd", "Yariroad"], "Versova", ["400061"]),
    ("Versova Road", ["Versova Rd", "Versova Link Road", "Vesava Road"], "Versova", ["400061"]),
    ("Andheri Kurla Road", ["Andheri Kurla Rd", "Ak Road", "A K Road"], "Andheri East", ["400069", "400059"]),
    ("Marol Maroshi Road", ["Marol Maroshi Rd", "Marol Road"], "Andheri East", ["400059"]),
    ("Western Express Highway", ["Weh", "Mumbai Western Express Highway", "Western Exp Highway", "Western Express Hwy"], "Andheri West", ["400058", "400060", "400047", "400063"]),
    ("New Link Road", ["New Link Rd", "Nlr"], "Kandivali West", ["400064", "400067"]),
    ("Mira Road", ["Mira Road East", "Mira Bhayander Road"], "Western Suburbs Far", ["400601"]),
    
    # Eastern Suburbs
    ("Eastern Express Highway", ["Eastern Exp Highway", "Eastern Express Hwy", "Eeh"], "Chembur", ["400022", "400024"]),
    ("Sion Road", ["Sion Rd", "Sion"], "Sion", ["400022"]),
    ("LBS Marg", ["Lbs Road", "Lal Bahadur Shastri Marg", "L B S Marg"], "Eastern Suburbs", ["400070"]),
    ("MG Road", ["M G Road", "Mahatma Gandhi Road"], "Ghatkopar West", ["400077", "400086"]),
    
    # Navi Mumbai
    ("Palm Beach Road", ["Palm Beach Marg", "Palm Beach"], "Navi Mumbai", ["400703"]),
    ("Sion Panvel Highway", ["Sion Panvel Road", "Old Mumbai Pune Highway"], "Navi Mumbai", ["410206"]),
    
    # Thane
    ("Eastern Express Highway", ["Mumbai Nashik Highway", "Agra Road"], "Thane West", ["400601"]),
    ("Ghoda Bunder Road", ["Ghoda Bunder Rd", "Jail Road"], "Thane West", ["400610"]),
]

# Micro market hierarchy
MUMBAI_ZONES = {
    "South Mumbai": [
        "South Mumbai Prime", "South Mumbai Central", "Fort", "Colaba", "Nariman Point",
        "Malabar Hill", "Prabhadevi", "Lower Parel", "Worli", "Mahalaxmi", "Parel",
        "Byculla", "Dadar West", "Grant Road", "Marine Drive", "Tardeo", "Breach Candy",
    ],
    "Western Suburbs": [
        "Bandra West", "Bandra East", "Khar West", "Santacruz West", "Vile Parle West",
        "Andheri West", "Andheri East", "Jogeshwari West", "Goregaon West", "Malad West",
        "Kandivali West", "Borivali West", "Dahisar West", "Juhu", "Versova", "Powai",
        "Oshiwara", "Lokhandwala", "Mahim", "Western Suburbs Mid", "Western Suburbs Far",
    ],
    "Eastern Suburbs": [
        "Eastern Suburbs", "Kurla", "Sion", "Chembur", "Ghatkopar West", "Ghatkopar East",
        "Vikhroli", "Kanjur Marg", "Bhandup", "Mulund West", "Nahur",
    ],
    "Navi Mumbai": [
        "Navi Mumbai", "Airoli", "Ghansoli", "Koparkhairne", "Vashi", "Sanpada",
        "Nerul", "Belapur", "Kharghar", "Panvel", "New Panvel", "Dronagiri", "Ulwe",
    ],
    "Thane": [
        "Thane West", "Thane East", "Mira Road", "Bhayandar", "Dombivali", "Kalyan",
        "Ambernath", "Badlapur",
    ],
}

# Area → street mapping (which streets pass through which areas)
# This enriches the building-street mapping from area field
AREA_STREETS = {
    "bandra west": ["Hill Road", "Carter Road", "Turner Road", "Linking Road", "SV Road"],
    "khar west": ["SV Road", "Linking Road"],
    "santacruz west": ["SV Road", "Linking Road", "Milan Subway Road"],
    "vile parle west": ["SV Road", "Irla Road"],
    "andheri west": ["SV Road", "New Link Road", "Veera Desai Road"],
    "andheri east": ["Andheri Kurla Road", "Marol Maroshi Road", "Western Express Highway"],
    "juhu": ["Juhu Tara Road", "Gulmohar Road"],
    "versova": ["Yari Road", "Versova Road", "Balasaheb Sawant Road"],
    "powai": ["LBS Marg", "Powai Road", "Chandivali Road"],
    "worli": ["Senapati Bapat Marg", "Dr Annie Besant Road", "LJ Road"],
    "lower parel": ["Senapati Bapat Marg", "Pandurang Budhkar Marg"],
    "prabhadevi": ["Senapati Bapat Marg", "Gokhale Road"],
    "dadar west": ["Ranade Road", "Gokhale Road", "Senapati Bapat Marg"],
    "thane west": ["Ghoda Bunder Road", "Eastern Express Highway", "Pokhran Road #1"],
    "chembur": ["Eastern Express Highway", "Sion Panvel Highway"],
    "ghatkopar west": ["MG Road", "LBS Marg", "Junction Road"],
    "mulund west": ["LBS Marg"],
    "kandivali west": ["New Link Road", "SV Road"],
    "borivali west": ["SV Road", "New Link Road"],
    "malad west": ["New Link Road", "SV Road", "Marve Road"],
    "goregaon west": ["SV Road", "New Link Road", "Film City Road"],
    "mira road": ["Mira Road", "Eastern Express Highway"],
    "navi mumbai": ["Palm Beach Road", "Sion Panvel Highway"],
    "vashi": ["Palm Beach Road", "Vashi Station Road"],
    "kharghar": ["Kharghar Station Road"],
    "airoli": ["Airoli Station Road"],
    "ghansoli": ["Ghansoli Station Road"],
    "koparkhairne": ["Koparkhairne Station Road"],
    "sion": ["Sion Road", "Sion Bandra Link Road"],
    "bandra east": ["Bandra Kurla Complex Road"],
    "bkc": ["Bandra Kurla Complex Road"],
    "byculla": ["N M Joshi Marg"],
    "marine drive": ["Marine Drive", "Maharshi Karve Road"],
    "malabar hill": ["Malabar Hill", "Ridge Road"],
    "breach candy": ["Breach Candy", "Bhulabhai Desai Marg"],
    "colaba": ["Colaba Causeway", "Shahid Bhagat Singh Marg"],
    "fort": ["Shahid Bhagat Singh Marg", "Mahatma Gandhi Road"],
    "grant road": ["Grant Road", "Maulana Shaukat Ali Marg"],
    "opera house": ["Mama Paramanand Marg"],
    "altamount road": ["Altamount Road"],
    "nepean sea road": ["Nepean Sea Road"],
    "peddar road": ["Peddar Road"],
    "carmichael road": ["Carmichael Road"],
    "hughes road": ["Hughes Road"],
    "warden road": ["Warden Road"],
    "yari road": ["Yari Road"],
    "lbs marg": ["LBS Marg"],
    "kanjur marg": ["Kanjur Marg"],
    "marine lines": ["Marine Drive", "Maharshi Karve Road"],
    "churchgate": ["Maharshi Karve Road"],
    "gamdevi": ["Hughes Road", "J Boman Behram Marg"],
    "tardeo": ["Tardeo Road"],
    "mahim": ["Jasmine Mill Road", "LJ Road"],
    "matunga": ["Bhandarkar Road"],
    "kurla": ["S G Barve Marg", "LBS Marg"],
    "ghatkopar east": ["LBS Marg"],
    "jogeshwari west": ["SV Road"],
    "jogeshwari east": ["Western Express Highway"],
    "dahisar west": ["New Link Road", "Western Express Highway"],
    "dahisar east": ["Eastern Express Highway"],
}

# Known buildings with no street mapping → assign via micro market proximity
# Map: micro_market -> likely streets
MICRO_MARKET_STREETS = {
    "Worli": ["LJ Road", "Senapati Bapat Marg", "Dr Annie Besant Road", "Khan Abdul Gaffar Khan Road"],
    "Lower Parel": ["Senapati Bapat Marg", "Pandurang Budhkar Marg", "NM Joshi Marg"],
    "Prabhadevi": ["Senapati Bapat Marg", "Gokhale Road", "Veer Savarkar Marg"],
    "Dadar West": ["Ranade Road", "Gokhale Road", "Senapati Bapat Marg"],
    "Bandra West": ["Hill Road", "Carter Road", "Turner Road", "Linking Road", "SV Road", "Perry Road", "Waterfield Road"],
    "Khar West": ["SV Road", "Linking Road", "14th Road"],
    "Santacruz West": ["SV Road", "Linking Road", "Milan Subway"],
    "Vile Parle West": ["SV Road", "Irla Road", "Nehru Road"],
    "Andheri West": ["SV Road", "Linking Road", "New Link Road", "Veera Desai Road"],
    "Andheri East": ["Andheri Kurla Road", "Marol Maroshi Road", "Western Express Highway"],
    "Juhu": ["Juhu Tara Road", "JVPD Scheme", "Gulmohar Road"],
    "Versova": ["Yari Road", "Versova Road", "Beach Road"],
    "Powai": ["Powai Road", "Chandivali Road", "LBS Marg"],
    "Lower Parel": ["Senapati Bapat Marg", "Pandurang Budhkar Marg"],
    "Thane West": ["Ghoda Bunder Road", "Eastern Express Highway", "Pokhran Road #1", "Pokhran Road #2"],
    "Chembur": ["Eastern Express Highway", "Sion Panvel Highway", "RC Marg"],
    "Ghatkopar West": ["MG Road", "LBS Marg", "Junction Road"],
    "Mulund West": ["LBS Marg", "Gopal Krishna Gokhale Road"],
    "Kandivali West": ["New Link Road", "SV Road"],
    "Borivali West": ["SV Road", "New Link Road"],
    "Malad West": ["New Link Road", "SV Road", "Marve Road"],
    "Goregaon West": ["SV Road", "New Link Road", "Film City Road"],
    "Mira Road": ["Mira Road", "Eastern Express Highway"],
    "Kharghar": ["Sector 12 Road", "Kharghar Station Road", "CBD Belapur Road"],
    "Vashi": ["Palm Beach Road", "Sector 17 Road", "Vashi Station Road"],
    "Airoli": ["Airoli Station Road", "Mumbai Nashik Highway"],
}



@dataclass
class Street:
    street_id: str
    name: str
    aliases: list[str] = field(default_factory=list)
    micro_market: str = ""
    pincodes: list[str] = field(default_factory=list)
    lat_start: Optional[float] = None
    lng_start: Optional[float] = None
    lat_end: Optional[float] = None
    lng_end: Optional[float] = None
    building_ids: list[int] = field(default_factory=list)
    source: str = ""  # "nominatim", "geocode_area", "manual"

    def to_csv_row(self) -> dict:
        return {
            "street_id": self.street_id,
            "name": self.name,
            "aliases": ";".join(self.aliases),
            "micro_market": self.micro_market,
            "pincodes": ";".join(self.pincodes),
            "lat_start": self.lat_start or "",
            "lng_start": self.lng_start or "",
            "lat_end": self.lat_end or "",
            "lng_end": self.lng_end or "",
            "building_ids": ";".join(str(b) for b in self.building_ids),
            "source": self.source,
        }


STREET_CSV_FIELDS = [
    "street_id", "name", "aliases", "micro_market", "pincodes",
    "lat_start", "lng_start", "lat_end", "lng_end",
    "building_ids", "source",
]


def is_street_name(name: str) -> bool:
    """Check if a name looks like a street/road."""
    lower = name.lower().strip()
    parts = lower.split()
    if not parts:
        return False
    last = parts[-1].rstrip(".")
    # Direct street suffix check
    if last in STREET_SUFFIXES:
        return True
    # "Rd", "St" abbreviations
    if last in ("rd", "st"):
        return True
    return False


def normalize_street_name(name: str) -> str:
    """Normalize a street name for matching."""
    s = name.strip()
    # Remove common prefixes
    s = re.sub(r'^(near|opposite|behind|above|below)\s+', '', s, flags=re.IGNORECASE)
    # Normalize suffix
    s = re.sub(r'\s+Rd\.?$', ' Road', s, flags=re.IGNORECASE)
    s = re.sub(r'\s+St\.?$', ' Street', s, flags=re.IGNORECASE)
    # Title case
    s = s.title()
    return s


def extract_streets_from_geocode() -> list[Street]:
    """Extract streets from the Nominatim geocode cache display_names."""
    cache_path = os.path.join(BASE_DIR, "data", "geocode_cache.json")
    if not os.path.exists(cache_path):
        return []

    with open(cache_path) as f:
        cache = json.load(f)

    seen = {}
    streets = []

    for area_name, data in cache.items():
        if data is None:
            continue
        parts = [p.strip() for p in data.get("display_name", "").split(",")]
        if len(parts) < 2:
            continue
        road = parts[1]
        if not is_street_name(road):
            continue

        pincode = data.get("pincode", "")
        canonical = normalize_street_name(road)

        if canonical not in seen:
            seen[canonical] = Street(
                street_id="",
                name=canonical,
                micro_market="",
                pincodes=[pincode] if pincode else [],
                source="nominatim",
            )
        else:
            if pincode and pincode not in seen[canonical].pincodes:
                seen[canonical].pincodes.append(pincode)

    for s in seen.values():
        s.street_id = _next_id(streets, seen)
        streets.append(s)

    return streets


def extract_streets_from_areas() -> list[Street]:
    """Extract streets from canonical_buildings.csv area field."""
    buildings_path = os.path.join(BASE_DIR, "data", "canonical_buildings.csv")
    if not os.path.exists(buildings_path):
        return []

    seen = {}
    building_areas = defaultdict(list)
    micro_markets = {}

    with open(buildings_path) as f:
        for row in csv.DictReader(f):
            area = row.get("area", "").strip()
            if is_street_name(area):
                canonical = normalize_street_name(area)
                bid = int(row["building_id"])
                building_areas[canonical].append(bid)
                mm = row.get("micro_market", "").strip()
                if mm:
                    micro_markets[canonical] = mm

    streets = []
    for name, bids in building_areas.items():
        s = Street(
            street_id="",
            name=name,
            aliases=[],
            micro_market=micro_markets.get(name, ""),
            building_ids=bids,
            source="geocode_area",
        )
        streets.append(s)

    return streets


def merge_streets(s1: list[Street], s2: list[Street]) -> list[Street]:
    """Merge two street lists, deduplicating by name."""
    by_name = {}

    for s in s1 + s2:
        if s.name not in by_name:
            by_name[s.name] = s
        else:
            existing = by_name[s.name]
            # Merge building_ids
            existing_bids = set(existing.building_ids)
            for bid in s.building_ids:
                if bid not in existing_bids:
                    existing.building_ids.append(bid)
            # Merge pincodes
            for p in s.pincodes:
                if p and p not in existing.pincodes:
                    existing.pincodes.append(p)
            # Merge aliases
            for a in s.aliases:
                if a and a not in existing.aliases:
                    existing.aliases.append(a)
            # Prefer non-empty micro_market
            if not existing.micro_market and s.micro_market:
                existing.micro_market = s.micro_market
            # Prefer manual source
            if s.source == "manual":
                existing.source = "manual"

    return list(by_name.values())


def assign_ids(streets: list[Street]) -> list[Street]:
    """Assign ST-XXX IDs sorted by name."""
    streets.sort(key=lambda s: s.name.lower())
    for i, s in enumerate(streets, 1):
        s.street_id = f"ST-{i:03d}"
    return streets


def write_streets(streets: list[Street]):
    """Write streets.csv and building_streets.csv."""
    os.makedirs(os.path.dirname(STREETS_PATH), exist_ok=True)

    # streets.csv
    with open(STREETS_PATH, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=STREET_CSV_FIELDS)
        writer.writeheader()
        for s in streets:
            writer.writerow(s.to_csv_row())

    # building_streets.csv: one row per building-street pair
    building_rows = []
    for s in streets:
        for bid in s.building_ids:
            building_rows.append({
                "building_id": bid,
                "street_id": s.street_id,
                "street_name": s.name,
            })

    with open(BUILDING_STREETS_PATH, "w", newline="") as f:
        if building_rows:
            writer = csv.DictWriter(f, fieldnames=["building_id", "street_id", "street_name"])
            writer.writeheader()
            writer.writerows(building_rows)

    print(f"  Wrote {len(streets)} streets to {STREETS_PATH}")
    print(f"  Wrote {len(building_rows)} building-street mappings to {BUILDING_STREETS_PATH}")


def build_known_streets() -> list[Street]:
    """Build Street objects from known Mumbai streets list."""
    streets = []
    for name, aliases, micro_market, pincodes in KNOWN_MUMBAI_STREETS:
        s = Street(
            street_id="",
            name=name,
            aliases=aliases,
            micro_market=micro_market,
            pincodes=pincodes,
            source="manual",
        )
        streets.append(s)
    return streets


def map_buildings_by_micro_market(streets: list[Street]) -> list[Street]:
    """Map buildings to streets by matching area field against street name/aliases
    and the AREA_STREETS lookup table.
    """
    buildings_path = os.path.join(BASE_DIR, "data", "canonical_buildings.csv")
    if not os.path.exists(buildings_path):
        return streets

    # Read all buildings
    buildings = []
    with open(buildings_path) as f:
        for row in csv.DictReader(f):
            bid = int(row["building_id"])
            mm = row.get("micro_market", "").strip()
            area = row.get("area", "").strip()
            buildings.append({"building_id": bid, "micro_market": mm, "area": area})

    # Build a lookup: set of already-mapped building IDs
    building_already_mapped = set()
    for s in streets:
        for bid in s.building_ids:
            building_already_mapped.add(bid)

    # Build a street lookup: for each street, all its names (canonical + aliases)
    street_names = {}  # lowercase name → street
    for s in streets:
        street_names[s.name.lower()] = s
        for alias in s.aliases:
            street_names[alias.lower().strip()] = s

    new_mappings = 0

    for b in buildings:
        bid = b["building_id"]
        if bid in building_already_mapped:
            continue
        area = b["area"].lower() if b["area"] else ""

        if not area:
            continue

        # Try 1: area IS a street name
        if area in street_names:
            s = street_names[area]
            s.building_ids.append(bid)
            new_mappings += 1
            continue

        # Try 2: area contains a street name
        for name, s in street_names.items():
            if name in area or area in name:
                if bid not in s.building_ids:
                    s.building_ids.append(bid)
                    new_mappings += 1
                break
        else:
            # Try 3: use AREA_STREETS lookup table
            if area in AREA_STREETS:
                for street_name in AREA_STREETS[area]:
                    sname = street_name.lower()
                    if sname in street_names:
                        s = street_names[sname]
                        if bid not in s.building_ids:
                            s.building_ids.append(bid)
                            new_mappings += 1
                        break  # Assign to the first matching street

    print(f"  New building-street mappings via area/street matching: {new_mappings}")
    return streets


def build_registry():
    """Build the full street registry from all available sources."""
    print("Building Street Registry...")

    streets_from_geocode = extract_streets_from_geocode()
    print(f"  From geocode cache: {len(streets_from_geocode)} streets")

    streets_from_areas = extract_streets_from_areas()
    print(f"  From building areas: {len(streets_from_areas)} streets")

    streets_known = build_known_streets()
    print(f"  From known Mumbai streets: {len(streets_known)} streets")

    merged = merge_streets(
        merge_streets(streets_from_geocode, streets_from_areas),
        streets_known,
    )
    print(f"  After merge: {len(merged)} unique streets")

    mapped = map_buildings_by_micro_market(merged)
    print(f"  After micro market mapping: {sum(len(s.building_ids) for s in mapped)} building-street pairs")

    assigned = assign_ids(mapped)

    write_streets(assigned)

    print(f"\nDone. {len(assigned)} streets in registry.")
    return assigned


def load_registry() -> list[Street]:
    """Load streets from CSV."""
    if not os.path.exists(STREETS_PATH):
        return []

    streets = []
    with open(STREETS_PATH) as f:
        for row in csv.DictReader(f):
            s = Street(
                street_id=row["street_id"],
                name=row["name"],
                aliases=[a.strip() for a in row.get("aliases", "").split(";") if a.strip()],
                micro_market=row.get("micro_market", ""),
                pincodes=[p.strip() for p in row.get("pincodes", "").split(";") if p.strip()],
                lat_start=float(row["lat_start"]) if row.get("lat_start") else None,
                lng_start=float(row["lng_start"]) if row.get("lng_start") else None,
                lat_end=float(row["lat_end"]) if row.get("lat_end") else None,
                lng_end=float(row["lng_end"]) if row.get("lng_end") else None,
                building_ids=[int(b) for b in row.get("building_ids", "").split(";") if b.strip()],
                source=row.get("source", ""),
            )
            streets.append(s)

    return streets


def _next_id(streets, seen):
    """Generate a temporary placeholder ID."""
    return f"ST-TMP-{len(streets) + len(seen) + 1:03d}"


if __name__ == "__main__":
    build_registry()
