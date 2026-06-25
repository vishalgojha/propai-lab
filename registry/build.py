"""
Build the Canonical Building Registry.

Pipeline:
  1. Load clean PROPi building data
  2. Extract developer info + assign hierarchy
  3. Geocode unique locations (from cache)
  4. Evaluate duplicates with smart auto-merge
  5. Cluster remaining review items by pattern
  6. Assign permanent BuildingIDs
  7. Write outputs + audit trail
"""
import csv
import json
import os
import sys
from datetime import datetime
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from schema import BuildingRecord, ReviewItem, CANONICAL_FIELDS, REVIEW_FIELDS
from developers import extract_developer
from locations import get_micro_market, get_canonical_area
from dedup import evaluate_duplicate, cluster_review_items, classify_pattern
from rules import apply_rules, building_fingerprint, canonicalize, RULES, save_rules, get_knowledge_summary

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
INPUT = os.path.join(DATA_DIR, "propi_buildings_clean.csv")
OUTPUT_CANONICAL = os.path.join(DATA_DIR, "canonical_buildings.csv")
OUTPUT_REVIEW = os.path.join(DATA_DIR, "review_queue.csv")
OUTPUT_ALIASES = os.path.join(DATA_DIR, "building_aliases.csv")
OUTPUT_AUDIT = os.path.join(DATA_DIR, "merge_audit.csv")
OUTPUT_CLUSTERS = os.path.join(DATA_DIR, "review_clusters.json")
SOURCE_NAME = "https://www.propi.in/search/properties"
TODAY = datetime.now().strftime("%Y-%m-%d")

AUDIT_FIELDS = ["building_id", "canonical_name", "alias_added", "reason", "rule_triggered", "confidence", "resolved_by", "timestamp"]


def load_clean_data() -> list[dict]:
    with open(INPUT) as f:
        return list(csv.DictReader(f))


def load_geocode_cache() -> dict:
    path = os.path.join(DATA_DIR, "geocode_cache.json")
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return {}


def enrich_records(rows: list[dict], geo_cache: dict) -> list[BuildingRecord]:
    enriched = []
    for r in rows:
        raw_name = r["building"].strip()
        area_raw = r["location"].strip()
        area = get_canonical_area(area_raw)
        micro_market = get_micro_market(area_raw)
        developer = extract_developer(raw_name)
        
        # Apply normalization rules (with area + developer context)
        rule_changes = apply_rules(raw_name, area, developer)
        canonical_name = canonicalize(raw_name, area, developer)
        aliases = [raw_name] if raw_name != canonical_name else []
        
        geo = geo_cache.get(area_raw) if area_raw not in ("—", "-", "") else None
        lat = geo["lat"] if geo and geo else None
        lon = geo["lon"] if geo and geo else None
        pincode = geo["pincode"] if geo and geo else None
        
        rec = BuildingRecord(
            building_id=0,
            canonical_name=canonical_name,
            aliases=aliases,
            area=area,
            micro_market=micro_market,
            latitude=lat,
            longitude=lon,
            pincode=pincode,
            developer=developer,
            confidence_score=100,
            source_urls=[SOURCE_NAME],
            first_seen=TODAY,
            last_seen=TODAY,
        )
        rec.fingerprint = building_fingerprint(canonical_name, developer, area, lat, lon)
        enriched.append(rec)
    return enriched


def build_registry(records: list[BuildingRecord]) -> tuple[list[BuildingRecord], list[dict], list[dict]]:
    """
    Build canonical registry with smart dedup using rules + fingerprints.
    
    Strategy:
    - Step 1: Collapse by fingerprint (catches rule-resolved duplicates)
    - Step 2: Collapse by (canonical_name, area)
    - Step 3: Run dedup with 2-letter blocking
    - Step 4: Cluster remaining review items by pattern
    """
    audit_log = []
    review_items = []
    from dedup import _normalize as norm_name
    from dedup import _quick_filter
    
    # ── Step 1: Group by fingerprint ────────────────────────────
    fp_map: dict[str, BuildingRecord] = {}
    for rec in records:
        if rec.fingerprint in fp_map:
            existing = fp_map[rec.fingerprint]
            if rec.canonical_name not in existing.aliases:
                existing.aliases.append(rec.canonical_name)
            audit_log.append({
                "building_id": 0,
                "canonical_name": existing.canonical_name,
                "alias_added": rec.canonical_name,
                "reason": "Identical fingerprint (same name+dev+area+coords after rules)",
                "rule_triggered": "Fingerprint match",
                "confidence": 100,
                "resolved_by": "AI",
                "timestamp": TODAY,
            })
        else:
            fp_map[rec.fingerprint] = rec
    
    # ── Step 2: Group by canonical name + area ──────────────────
    canonical_map: dict[str, BuildingRecord] = {}
    for rec in fp_map.values():
        key = f"{norm_name(rec.canonical_name)}||{rec.area.lower()}"
        if key in canonical_map:
            existing = canonical_map[key]
            if rec.canonical_name not in existing.aliases:
                existing.aliases.append(rec.canonical_name)
            existing.last_seen = TODAY
        else:
            canonical_map[key] = rec
    
    # ── Step 3: Build blocks by first 2 letters for dedup ──────
    blocks: dict[str, list[tuple[str, BuildingRecord]]] = defaultdict(list)
    for key, rec in canonical_map.items():
        prefix = norm_name(rec.canonical_name)[:2] or "__"
        blocks[prefix].append((key, rec))
    
    compared = set()
    
    for prefix, group in blocks.items():
        for i in range(len(group)):
            for j in range(i + 1, len(group)):
                key_a, a = group[i]
                key_b, b = group[j]
                
                pair = tuple(sorted([key_a, key_b]))
                if pair in compared:
                    continue
                compared.add(pair)
                
                if not _quick_filter(a.canonical_name, b.canonical_name):
                    continue
                
                result = evaluate_duplicate(
                    a.canonical_name, a.area, a.developer,
                    b.canonical_name, b.area, b.developer,
                    a.latitude, a.longitude, b.latitude, b.longitude,
                )
                
                if result["action"] == "auto_merge":
                    canonical_map.pop(key_b, None)
                    if b.canonical_name not in a.aliases:
                        a.aliases.append(b.canonical_name)
                    a.last_seen = max(a.last_seen, b.last_seen)
                    a.confidence_score = max(a.confidence_score, result["score"])
                    audit_log.append({
                        "building_id": 0,
                        "canonical_name": a.canonical_name,
                        "alias_added": b.canonical_name,
                        "reason": "; ".join(result["evidence"]),
                        "rule_triggered": result["rule_triggered"],
                        "confidence": result["score"],
                        "resolved_by": "AI",
                        "timestamp": TODAY,
                    })
                elif result["action"] == "negative_knowledge":
                    # Skip — known different buildings
                    pass
                elif result["score"] >= 80:
                    review_items.append({
                        "candidate_a_name": a.canonical_name,
                        "candidate_a_area": a.area,
                        "candidate_b_name": b.canonical_name,
                        "candidate_b_area": b.area,
                        "developer_a": a.developer or "",
                        "developer_b": b.developer or "",
                        "confidence_score": result["score"],
                        "evidence": "; ".join(result["evidence"]),
                        "pattern": result["pattern"],
                        "rule_triggered": result["rule_triggered"],
                        "recommended_action": "merge" if result["action"] == "auto_merge" else "flag",
                        "status": "pending",
                    })
                elif result["score"] >= 80:
                    review_items.append({
                        "candidate_a_name": a.canonical_name,
                        "candidate_a_area": a.area,
                        "candidate_b_name": b.canonical_name,
                        "candidate_b_area": b.area,
                        "developer_a": a.developer or "",
                        "developer_b": b.developer or "",
                        "confidence_score": result["score"],
                        "evidence": "; ".join(result["evidence"]),
                        "pattern": result["pattern"],
                        "rule_triggered": result["rule_triggered"],
                        "recommended_action": "merge",
                        "status": "pending",
                    })
    
    # ── Step 3: Assign BuildingIDs + Health Scores ─────────────
    final_records = list(canonical_map.values())
    for idx, rec in enumerate(final_records, 1):
        rec.building_id = idx
        rec.confidence_score = max(rec.confidence_score, 90 if rec.area else 80)
        rec.aliases = list(dict.fromkeys(rec.aliases))  # dedupe, preserve order
        # Recompute fingerprint with official building_id
        rec.fingerprint = building_fingerprint(
            rec.canonical_name, rec.developer, rec.area, rec.latitude, rec.longitude
        )
        # Health Score: 0-100 summary of data completeness
        _health = 0
        _health += 25 if rec.area and rec.area not in ("—", "") else 0
        _health += 15 if rec.micro_market else 0
        _health += 20 if rec.latitude and rec.longitude else 0
        _health += 5 if rec.pincode else 0
        _health += 15 if rec.developer else 0
        _health += 10 if rec.aliases else 0
        _health += 10 if rec.confidence_score >= 90 else 5
        rec.health_score = _health
    
    # ── Step 4: Cluster review items ────────────────────────────
    clusters = cluster_review_items(review_items)
    
    return final_records, review_items, audit_log, clusters


def _status_for(rec: BuildingRecord) -> str:
    if not rec.area or rec.area in ("—", "-", ""):
        return "Needs Area Resolution"
    return "Active"


def write_outputs(canonical, review_items, audit_log, clusters):
    os.makedirs(DATA_DIR, exist_ok=True)
    
    # Canonical buildings
    with open(OUTPUT_CANONICAL, "w", newline="") as f:
        fieldnames = CANONICAL_FIELDS + ["status"]
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for rec in sorted(canonical, key=lambda x: x.building_id):
            d = rec.to_dict()
            d["status"] = _status_for(rec)
            w.writerow(d)
    
    # Review queue
    with open(OUTPUT_REVIEW, "w", newline="") as f:
        fieldnames = REVIEW_FIELDS
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in sorted(review_items, key=lambda x: -x["confidence_score"]):
            w.writerow({
                "candidate_a_id": "",
                "candidate_a_name": r["candidate_a_name"],
                "candidate_a_area": r["candidate_a_area"],
                "candidate_b_id": "",
                "candidate_b_name": r["candidate_b_name"],
                "candidate_b_area": r["candidate_b_area"],
                "confidence_score": r["confidence_score"],
                "evidence": r["evidence"],
                "recommended_action": r["recommended_action"],
                "status": r["status"],
            })
    
    # Aliases
    alias_rows = []
    for rec in canonical:
        for alias in rec.aliases:
            alias_rows.append({
                "building_id": rec.building_id,
                "canonical_name": rec.canonical_name,
                "alias": alias,
            })
    if alias_rows:
        with open(OUTPUT_ALIASES, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=["building_id", "canonical_name", "alias"])
            w.writeheader()
            w.writerows(alias_rows)
    
    # Audit log
    if audit_log:
        for entry in audit_log:
            # Map building_id for merged aliases
            for rec in canonical:
                if entry["alias_added"] in rec.aliases or entry["alias_added"] == rec.canonical_name:
                    entry["building_id"] = rec.building_id
                    break
        with open(OUTPUT_AUDIT, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=AUDIT_FIELDS)
            w.writeheader()
            w.writerows(audit_log)
    
    # Review clusters JSON (for interactive display)
    cluster_summary = []
    for c in clusters:
        cluster_summary.append({
            "pattern": c["pattern"],
            "cluster_key": c["cluster_key"],
            "count": c["count"],
            "unique_buildings": c["unique_buildings"],
            "examples": c["examples"],
            "avg_confidence": c["avg_confidence"],
            "score_range": c["score_range"],
            "actions": list(c["actions"]),
        })
    with open(OUTPUT_CLUSTERS, "w") as f:
        json.dump(cluster_summary, f, indent=2)
    
    print(f"\n  canonical_buildings.csv → {len(canonical)} records")
    print(f"  review_queue.csv        → {len(review_items)} items")
    print(f"  building_aliases.csv    → {len(alias_rows)} aliases")
    print(f"  merge_audit.csv         → {len(audit_log)} merges")
    print(f"  review_clusters.json    → {len(clusters)} clusters")
    
    return cluster_summary


def print_summary(canonical, review_items, audit_log, clusters):
    with_dev = sum(1 for r in canonical if r.developer)
    with_coords = sum(1 for r in canonical if r.latitude)
    with_micro = sum(1 for r in canonical if r.micro_market)
    with_aliases = sum(1 for r in canonical if r.aliases)
    needs_area = sum(1 for r in canonical if not r.area or r.area in ("—", ""))
    unique_fps = len(set(r.fingerprint for r in canonical))
    
    print("\n" + "=" * 60)
    print("Canonical Building Registry — Build Summary")
    print("=" * 60)
    print(f"  Total canonical buildings:  {len(canonical)}")
    print(f"  Unique fingerprints:         {unique_fps}")
    print(f"  With developer identified:   {with_dev}")
    print(f"  With geocoded coordinates:   {with_coords}")
    print(f"  With micro market assigned:  {with_micro}")
    print(f"  With aliases merged:         {with_aliases}")
    print(f"  Auto-merges applied:         {len(audit_log)}")
    kb = get_knowledge_summary()
    print(f"  Active normalization strategies:  {kb.get('normalization_strategies', 0)}")
    print(f"  Negative knowledge pairs:         {kb.get('negative_knowledge_pairs', 0)}")
    print(f"  Needs Area Resolution:       {needs_area}")
    print(f"  Review queue items:          {len(review_items)}")
    print(f"  Review clusters:             {len(clusters)}")
    print("=" * 60)
    
    if clusters:
        print("\n--- Review Clusters ---")
        for c in clusters:
            examples_str = ", ".join(f"{a} ↔ {b}" for a, b in c["examples"])
            print(f"\n  [{c['cluster_key']}] {c['pattern']}")
            print(f"       Count: {c['count']} pairs, {c['unique_buildings']} unique buildings")
            print(f"       Confidence: {c['score_range']} (avg: {c['avg_confidence']}%)")
            print(f"       Examples: {examples_str}")
    
    if audit_log:
        print("\n--- Auto-merges applied ---")
        for entry in audit_log[:10]:
            print(f"  [{entry['confidence']}%] {entry['canonical_name']} ← {entry['alias_added']}")
            print(f"       Rule: {entry['rule_triggered']}")
        if len(audit_log) > 10:
            print(f"  ... and {len(audit_log) - 10} more")


def main():
    print("Building Canonical Building Registry...\n")
    
    print("Step 1/5: Loading clean data...")
    rows = load_clean_data()
    print(f"  {len(rows)} records")
    
    print("Step 2/5: Loading geocode cache...")
    geo_cache = load_geocode_cache()
    print(f"  {len(geo_cache)} locations cached")
    
    print("Step 3/5: Enriching records...")
    enriched = enrich_records(rows, geo_cache)
    
    print("Step 4/5: Building registry (dedup + cluster)...")
    canonical, review_items, audit_log, clusters = build_registry(enriched)
    
    print("Step 5/5: Writing outputs + saving rules...")
    save_rules()
    cluster_summary = write_outputs(canonical, review_items, audit_log, clusters)
    
    print_summary(canonical, review_items, audit_log, clusters)
    
    if clusters:
        print(f"\n\nReview clusters saved to data/review_clusters.json")
    
    return canonical, review_items, audit_log, clusters


if __name__ == "__main__":
    main()
