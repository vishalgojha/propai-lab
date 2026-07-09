"""
Landmark Registry Builder.

Creates a canonical landmark registry and maps buildings to nearby landmarks.

Flow:
  1. Load canonical buildings with coordinates
  2. Build proximity index (buildings within 500m of each landmark)
  3. Assign LandmarkIDs (LM-001 format)
  4. Score landmarks by importance
  5. Write landmarks.csv + building_landmarks.csv

Landmark hierarchy:
  City → Zone → Micro Market → Landmark → Street → Building
"""
import csv
import json
import math
import os
import sys
from collections import defaultdict
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")

LANDMARKS_PATH = os.path.join(DATA_DIR, "landmarks.csv")
BUILDING_LANDMARKS_PATH = os.path.join(DATA_DIR, "building_landmarks.csv")


# ── Seed landmarks ───────────────────────────────────────────────
# Curated from broker vocabulary — these are the landmarks brokers
# actually reference in Mumbai real estate.
SEED_LANDMARKS = [
    # ── Bandra West ──────────────────────────────────────────
    {"name": "Mount Mary Church", "aliases": ["Mount Mary", "Mount Mary Basilica"], "type": "Church", "micro_market": "Bandra West", "lat": 19.0538, "lng": 72.8283, "importance": 90},
    {"name": "Mehboob Studio", "aliases": ["Mehboob Studios", "Mehboob Khan Studio"], "type": "Studio", "micro_market": "Bandra West", "lat": 19.0550, "lng": 72.8330, "importance": 85},
    {"name": "Bandra Bandstand", "aliases": ["Bandstand", "Bandra Bandstand Promenade"], "type": "Beachfront", "micro_market": "Bandra West", "lat": 19.0500, "lng": 72.8250, "importance": 80},
    {"name": "Bandra Fort", "aliases": ["Castella de Aguada"], "type": "Fort", "micro_market": "Bandra West", "lat": 19.0475, "lng": 72.8265, "importance": 70},
    {"name": "Linking Road", "aliases": ["Linking Rd"], "type": "Road", "micro_market": "Bandra West", "lat": 19.0580, "lng": 72.8370, "importance": 95},
    {"name": "Hill Road", "aliases": ["Hill Rd"], "type": "Road", "micro_market": "Bandra West", "lat": 19.0530, "lng": 72.8310, "importance": 85},
    {"name": "Taj Lands End", "aliases": ["Taj Landsend", "Taj Lands End Bandra"], "type": "Hotel", "micro_market": "Bandra West", "lat": 19.0480, "lng": 72.8240, "importance": 75},
    {"name": "Bandra Station", "aliases": ["Bandra Railway Station", "Bandra Terminus"], "type": "Railway Station", "micro_market": "Bandra West", "lat": 19.0543, "lng": 72.8404, "importance": 90},
    {"name": "Carter Road", "aliases": ["Carter Rd"], "type": "Road", "micro_market": "Bandra West", "lat": 19.0630, "lng": 72.8220, "importance": 80},
    # ── BKC ──────────────────────────────────────────────────
    {"name": "Bandra Kurla Complex", "aliases": ["BKC", "Bandra Kurla Complex"], "type": "Business Park", "micro_market": "Bandra BKC", "lat": 19.0600, "lng": 72.8480, "importance": 95},
    {"name": "Bharat Diamond Bourse", "aliases": ["BDB", "Diamond Bourse"], "type": "Office", "micro_market": "Bandra BKC", "lat": 19.0620, "lng": 72.8460, "importance": 80},
    {"name": "Jio World Centre", "aliases": ["Jio World Drive", "Jio World Garden", "Jio Convention Centre"], "type": "Convention Centre", "micro_market": "Bandra BKC", "lat": 19.0585, "lng": 72.8495, "importance": 85},
    {"name": "NSE (National Stock Exchange)", "aliases": ["NSE BKC", "National Stock Exchange"], "type": "Office", "micro_market": "Bandra BKC", "lat": 19.0610, "lng": 72.8500, "importance": 75},
    # ── Lower Parel / South Mumbai ────────────────────────────
    {"name": "High Street Phoenix", "aliases": ["Phoenix Marketcity", "Phoenix Mills", "High Street Phoenix Mall"], "type": "Mall", "micro_market": "Lower Parel", "lat": 18.9950, "lng": 72.8230, "importance": 90},
    {"name": "Lilavati Hospital", "aliases": ["Lilavati", "Lilavati Hospital Bandra"], "type": "Hospital", "micro_market": "Bandra West", "lat": 19.0520, "lng": 72.8340, "importance": 85},
    {"name": "Siddhivinayak Temple", "aliases": ["Siddhivinayak", "Siddhivinayak Mandir", "Prabhadevi Temple"], "type": "Temple", "micro_market": "Prabhadevi", "lat": 19.0170, "lng": 72.8300, "importance": 85},
    {"name": "Worli Sea Face", "aliases": ["Worli Seaface", "Worli Seaside"], "type": "Seafront", "micro_market": "Worli", "lat": 19.0080, "lng": 72.8180, "importance": 80},
    {"name": "Haji Ali Dargah", "aliases": ["Haji Ali", "Haji Ali Masjid"], "type": "Mosque", "micro_market": "Worli", "lat": 18.9830, "lng": 72.8130, "importance": 75},
    {"name": "Mahalaxmi Racecourse", "aliases": ["Racecourse", "Mahalaxmi Race Course"], "type": "Ground", "micro_market": "Mahalaxmi", "lat": 18.9850, "lng": 72.8250, "importance": 75},
    {"name": "Pedder Road", "aliases": ["Pedder Rd"], "type": "Road", "micro_market": "South Mumbai Central", "lat": 18.9700, "lng": 72.8100, "importance": 70},
    {"name": "Marine Drive", "aliases": ["Marine Drive", "Queen's Necklace"], "type": "Promenade", "micro_market": "South Mumbai Prime", "lat": 18.9440, "lng": 72.8230, "importance": 90},
    {"name": "Nariman Point", "aliases": ["Nariman Pt"], "type": "Business District", "micro_market": "South Mumbai Prime", "lat": 18.9330, "lng": 72.8200, "importance": 85},
    {"name": "Churchgate Station", "aliases": ["Churchgate"], "type": "Railway Station", "micro_market": "South Mumbai Prime", "lat": 18.9350, "lng": 72.8260, "importance": 80},
    {"name": "Gateway of India", "aliases": ["Gateway"], "type": "Monument", "micro_market": "South Mumbai Prime", "lat": 18.9220, "lng": 72.8340, "importance": 80},
    {"name": "Colaba Causeway", "aliases": ["Colaba Causeway"], "type": "Market", "micro_market": "South Mumbai Prime", "lat": 18.9180, "lng": 72.8310, "importance": 75},
    {"name": "Oberoi Trident", "aliases": ["Oberoi", "Trident Hotel"], "type": "Hotel", "micro_market": "South Mumbai Prime", "lat": 18.9280, "lng": 72.8200, "importance": 70},
    {"name": "Taj Mahal Palace", "aliases": ["Taj Hotel", "Taj Mahal Hotel"], "type": "Hotel", "micro_market": "South Mumbai Prime", "lat": 18.9220, "lng": 72.8330, "importance": 75},
    {"name": "Wankhede Stadium", "aliases": ["Wankhede", "Wankhede Stadium"], "type": "Stadium", "micro_market": "South Mumbai Central", "lat": 18.9380, "lng": 72.8270, "importance": 75},
    # ── Andheri ──────────────────────────────────────────────
    {"name": "Andheri Station", "aliases": ["Andheri Railway Station", "Andheri Station East", "Andheri Station West"], "type": "Railway Station", "micro_market": "Andheri West", "lat": 19.1190, "lng": 72.8460, "importance": 90},
    {"name": "Infinity Mall", "aliases": ["Infinity Mall Andheri"], "type": "Mall", "micro_market": "Andheri West", "lat": 19.1250, "lng": 72.8400, "importance": 75},
    {"name": "DN Nagar Metro", "aliases": ["DN Nagar", "DN Nagar Metro Station"], "type": "Metro Station", "micro_market": "Andheri West", "lat": 19.1230, "lng": 72.8380, "importance": 70},
    {"name": "Versova Beach", "aliases": ["Versova Beach"], "type": "Beach", "micro_market": "Versova", "lat": 19.1380, "lng": 72.8120, "importance": 75},
    {"name": "Lokhandwala Complex", "aliases": ["Lokhandwala", "Lokhandwala Market"], "type": "Market", "micro_market": "Andheri West", "lat": 19.1270, "lng": 72.8350, "importance": 80},
    # ── Juhu / Vile Parle ────────────────────────────────────
    {"name": "Juhu Beach", "aliases": ["Juhu Beach"], "type": "Beach", "micro_market": "Juhu", "lat": 19.0880, "lng": 72.8260, "importance": 85},
    {"name": "Prithvi Theatre", "aliases": ["Prithvi", "Prithvi Theatre Juhu"], "type": "Theatre", "micro_market": "Juhu", "lat": 19.1010, "lng": 72.8310, "importance": 70},
    {"name": "Juhu Circle", "aliases": ["Juhu Circle"], "type": "Junction", "micro_market": "Juhu", "lat": 19.0890, "lng": 72.8290, "importance": 75},
    {"name": "Vile Parle Station", "aliases": ["Vile Parle Railway Station", "Vile Parle"], "type": "Railway Station", "micro_market": "Vile Parle West", "lat": 19.1000, "lng": 72.8400, "importance": 75},
    {"name": "ISKCON Temple Juhu", "aliases": ["ISKCON Juhu", "Hare Krishna Temple"], "type": "Temple", "micro_market": "Juhu", "lat": 19.0940, "lng": 72.8300, "importance": 75},
    # ── Powai ─────────────────────────────────────────────────
    {"name": "Powai Lake", "aliases": ["Powai Lake"], "type": "Lake", "micro_market": "Powai", "lat": 19.1200, "lng": 72.9050, "importance": 80},
    {"name": "IIT Bombay", "aliases": ["IIT Powai", "IIT Bombay"], "type": "College", "micro_market": "Powai", "lat": 19.1330, "lng": 72.9150, "importance": 85},
    {"name": "R City Mall", "aliases": ["R City", "R City Mall Ghatkopar"], "type": "Mall", "micro_market": "Ghatkopar West", "lat": 19.0970, "lng": 72.8970, "importance": 80},
    {"name": "Hiranandani Gardens", "aliases": ["Hiranandani", "Hiranandani Powai"], "type": "Township", "micro_market": "Powai", "lat": 19.1170, "lng": 72.9100, "importance": 85},
    # ── Thane ─────────────────────────────────────────────────
    {"name": "Thane Station", "aliases": ["Thane Railway Station"], "type": "Railway Station", "micro_market": "Thane West", "lat": 19.1800, "lng": 72.9700, "importance": 85},
    {"name": "Viviana Mall", "aliases": ["Viviana Mall Thane"], "type": "Mall", "micro_market": "Thane West", "lat": 19.2100, "lng": 72.9800, "importance": 80},
    {"name": "Korum Mall", "aliases": ["Korum Mall Thane"], "type": "Mall", "micro_market": "Thane West", "lat": 19.1950, "lng": 72.9750, "importance": 70},
    {"name": "Upvan Lake", "aliases": ["Upvan Lake Thane", "Upvan"], "type": "Lake", "micro_market": "Thane West", "lat": 19.1950, "lng": 72.9650, "importance": 65},
    # ── Navi Mumbai ───────────────────────────────────────────
    {"name": "Seawoods Grand Central Mall", "aliases": ["Seawoods Mall", "Grand Central Mall"], "type": "Mall", "micro_market": "Navi Mumbai", "lat": 19.0250, "lng": 73.0100, "importance": 75},
    {"name": "Vashi Station", "aliases": ["Vashi Railway Station"], "type": "Railway Station", "micro_market": "Navi Mumbai", "lat": 19.0700, "lng": 72.9900, "importance": 80},
    {"name": "Palm Beach Road", "aliases": ["Palm Beach Rd"], "type": "Road", "micro_market": "Navi Mumbai", "lat": 19.0500, "lng": 73.0000, "importance": 75},
    # ── Extended suburbs ──────────────────────────────────────
    {"name": "Goregaon Station", "aliases": ["Goregaon Railway Station"], "type": "Railway Station", "micro_market": "Goregaon West", "lat": 19.1650, "lng": 72.8410, "importance": 80},
    {"name": "Oberoi Mall", "aliases": ["Oberoi Mall Goregaon"], "type": "Mall", "micro_market": "Goregaon East", "lat": 19.1600, "lng": 72.8550, "importance": 80},
    {"name": "Kandivali Station", "aliases": ["Kandivali Railway Station"], "type": "Railway Station", "micro_market": "Kandivali West", "lat": 19.2040, "lng": 72.8400, "importance": 75},
    {"name": "Borivali Station", "aliases": ["Borivali Railway Station"], "type": "Railway Station", "micro_market": "Borivali West", "lat": 19.2300, "lng": 72.8560, "importance": 80},
    {"name": "Yoga Institute", "aliases": ["The Yoga Institute"], "type": "Institute", "micro_market": "Santacruz West", "lat": 19.0800, "lng": 72.8350, "importance": 70},
    {"name": "Khar Station", "aliases": ["Khar Railway Station"], "type": "Railway Station", "micro_market": "Khar West", "lat": 19.0700, "lng": 72.8370, "importance": 75},
    {"name": "Santacruz Station", "aliases": ["Santacruz Railway Station"], "type": "Railway Station", "micro_market": "Santacruz West", "lat": 19.0820, "lng": 72.8380, "importance": 75},
    {"name": "Dadar Station", "aliases": ["Dadar Railway Station", "Dadar"], "type": "Railway Station", "micro_market": "Dadar West", "lat": 19.0180, "lng": 72.8420, "importance": 90},
    {"name": "Shivaji Park", "aliases": ["Shivaji Park Dadar"], "type": "Ground", "micro_market": "Dadar West", "lat": 19.0230, "lng": 72.8380, "importance": 80},
]


def haversine(lat1, lng1, lat2, lng2):
    """Haversine distance in meters."""
    R = 6371000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c


def load_buildings_with_coords() -> list[dict]:
    """Load canonical buildings that have lat/lng coordinates."""
    buildings = []
    path = os.path.join(DATA_DIR, "canonical_buildings.csv")
    with open(path) as f:
        for row in csv.DictReader(f):
            lat = row.get("latitude")
            lng = row.get("longitude")
            if lat and lng:
                try:
                    buildings.append({
                        "building_id": int(row["building_id"]),
                        "name": row["canonical_name"],
                        "lat": float(lat),
                        "lng": float(lng),
                        "micro_market": row.get("micro_market", ""),
                        "area": row.get("area", ""),
                    })
                except (ValueError, TypeError):
                    pass
    return buildings


def assign_landmark_ids(landmarks: list[dict]) -> list[dict]:
    """Assign LM-XXX IDs, preserving across rebuilds."""
    existing = {}
    path = os.path.join(DATA_DIR, "landmarks.csv")
    if os.path.exists(path):
        with open(path) as f:
            for row in csv.DictReader(f):
                existing[row["name"].strip().lower()] = row["landmark_id"]

    next_num = 1
    if existing:
        ids = [int(v.split("-")[1]) for v in existing.values() if v.startswith("LM-")]
        next_num = max(ids) + 1 if ids else 1

    for lm in landmarks:
        key = lm["name"].strip().lower()
        if key in existing:
            lm["landmark_id"] = existing[key]
        else:
            lm["landmark_id"] = f"LM-{next_num:03d}"
            next_num += 1
    return landmarks


def compute_proximity(landmarks: list[dict], buildings: list[dict], max_dist: int = 750):
    """For each landmark, find nearby buildings within max_dist meters."""
    links = []
    for lm in landmarks:
        llat, llng = lm["lat"], lm["lng"]
        for b in buildings:
            dist = haversine(llat, llng, b["lat"], b["lng"])
            if dist <= max_dist:
                walking_min = round(dist / 80)  # ~80m/min walking
                links.append({
                    "building_id": b["building_id"],
                    "landmark_id": lm["landmark_id"],
                    "distance_m": round(dist),
                    "walking_min": max(1, walking_min),
                    "building_name": b["name"],
                    "landmark_name": lm["name"],
                })
    return links


def compute_importance(landmarks: list[dict], links: list[dict]):
    """Compute importance score based on nearby building density."""
    building_count = defaultdict(int)
    for link in links:
        building_count[link["landmark_id"]] += 1

    for lm in landmarks:
        lid = lm["landmark_id"]
        nearby = building_count.get(lid, 0)
        # Blend seed importance with observed density
        seed = lm.get("importance", 50)
        density_score = min(nearby * 2, 50)
        lm["importance"] = min(seed + density_score, 100)


def write_landmarks(landmarks: list[dict]):
    fields = [
        "landmark_id", "name", "aliases", "type", "micro_market",
        "latitude", "longitude", "importance", "source",
    ]
    with open(LANDMARKS_PATH, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for lm in sorted(landmarks, key=lambda x: -x["importance"]):
            w.writerow({
                "landmark_id": lm["landmark_id"],
                "name": lm["name"],
                "aliases": "; ".join(lm.get("aliases", [])),
                "type": lm["type"],
                "micro_market": lm["micro_market"],
                "latitude": lm["lat"],
                "longitude": lm["lng"],
                "importance": lm["importance"],
                "source": "seed",
            })
    print(f"  Wrote {len(landmarks)} landmarks to {LANDMARKS_PATH}")


def write_building_landmarks(links: list[dict]):
    fields = [
        "building_id", "landmark_id", "distance_m", "walking_min",
        "building_name", "landmark_name",
    ]
    with open(BUILDING_LANDMARKS_PATH, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for link in sorted(links, key=lambda x: x["distance_m"]):
            w.writerow(link)
    print(f"  Wrote {len(links)} building→landmark links to {BUILDING_LANDMARKS_PATH}")


def print_summary(landmarks: list[dict], links: list[dict], buildings: list[dict]):
    """Print a summary of the landmark registry."""
    total_buildings_with_coords = len(buildings)
    linked_buildings = len(set(l["building_id"] for l in links))
    types = defaultdict(int)
    for lm in landmarks:
        types[lm["type"]] += 1

    print()
    print("=" * 60)
    print("  LANDMARK REGISTRY SUMMARY")
    print("=" * 60)
    print(f"  Landmarks:                   {len(landmarks)}")
    print(f"  Landmark types:              {len(types)}")
    print(f"  Buildings with coordinates:  {total_buildings_with_coords}")
    print(f"  Buildings near ≥1 landmark:  {linked_buildings} ({linked_buildings/max(total_buildings_with_coords,1)*100:.1f}%)")
    print(f"  Building→landmark links:     {len(links)}")
    print(f"  Avg links per building:      {len(links)/max(linked_buildings,1):.1f}")
    print()
    print("  Landmark types:")
    for t, c in sorted(types.items(), key=lambda x: -x[1]):
        print(f"    {t:<25} {c}")
    print()
    print("  Top 10 landmarks by importance:")
    for lm in sorted(landmarks, key=lambda x: -x["importance"])[:10]:
        nearby = sum(1 for l in links if l["landmark_id"] == lm["landmark_id"])
        print(f"    {lm['landmark_id']}  {lm['name']:<35} importance={lm['importance']:>3}  nearby={nearby}")


def run():
    print("Building Landmark Registry...")

    seeds = SEED_LANDMARKS
    print(f"  Loaded {len(seeds)} seed landmarks")

    landmarks = assign_landmark_ids(seeds)
    print(f"  Assigned IDs: {[lm['landmark_id'] for lm in landmarks[:5]]}...")

    buildings = load_buildings_with_coords()
    print(f"  Loaded {len(buildings)} buildings with coordinates")

    links = compute_proximity(landmarks, buildings, max_dist=1000)
    print(f"  Computed {len(links)} proximity links (max 1000m)")

    compute_importance(landmarks, links)
    print(f"  Computed importance scores")

    write_landmarks(landmarks)
    write_building_landmarks(links)
    print_summary(landmarks, links, buildings)


if __name__ == "__main__":
    run()
