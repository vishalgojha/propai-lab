"""
MahaRERA Enrichment Pipeline.

Takes raw scraper CSV and produces:
  1. Project Registry (projects.csv) — canonical entity with project_id
  2. Developer Registry (developer_registry.csv) — only devs with resolved buildings
  3. RERA Lookup (rera_lookup.csv) — fast RERA# → project_id + building_ids
  4. MAHARERA_PROJECT observations → observations.csv

Canonical entity hierarchy:
  Developer → Project(s) → Building(s)

The registry remains read-only. MahaRERA enriches via evidence + links.
"""
import csv
import os
import re
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from evidence.resolver import resolve, resolve_by_rera, clear_cache
from evidence.pipeline import create_pipeline

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")

PROJECTS_PATH = os.path.join(DATA_DIR, "projects.csv")
DEVELOPER_REGISTRY_PATH = os.path.join(DATA_DIR, "developer_registry.csv")
RERA_LOOKUP_PATH = os.path.join(DATA_DIR, "rera_lookup.csv")


# ── Helpers ──────────────────────────────────────────────────────

def _load_existing_projects() -> dict:
    """Load existing projects.csv to preserve project_ids across runs."""
    existing = {}
    if os.path.exists(PROJECTS_PATH):
        with open(PROJECTS_PATH) as f:
            for row in csv.DictReader(f):
                existing[row["rera_no"].strip()] = row
    return existing


def _next_project_id(existing: dict) -> int:
    """Return next project_id (max existing + 1)."""
    ids = [int(r["project_id"]) for r in existing.values() if r.get("project_id")]
    return max(ids) + 1 if ids else 1


# ── Load ─────────────────────────────────────────────────────────

def load_raw_projects() -> list[dict]:
    path = os.path.join(DATA_DIR, "maharera_projects.csv")
    if not os.path.exists(path):
        print(f"  No data at {path}")
        return []

    with open(path) as f:
        projects = list(csv.DictReader(f))

    print(f"  Loaded {len(projects)} projects from {path}")
    return projects


# ── Normalize ────────────────────────────────────────────────────

def normalize_project(project: dict) -> dict:
    name = project.get("project_name", "").strip()
    promoter = project.get("promoter", "").strip()
    location = project.get("location", "").strip()
    rera = project.get("rera_no", "").strip()
    area = location.split(",")[0].strip() if location else ""

    name = name.replace("  ", " ").strip().strip(".,;:#")

    return {
        "rera_no": rera,
        "project_name": name,
        "promoter": promoter,
        "location": location,
        "area": area,
        "district": project.get("district", ""),
        "pincode": project.get("pincode", ""),
        "last_modified": project.get("last_modified", ""),
    }


# ── Resolve ──────────────────────────────────────────────────────

def resolve_project(project: dict) -> dict:
    name = project["project_name"]
    area = project["area"]
    developer = project["promoter"]
    rera = project["rera_no"]
    bid = 0
    confidence = 0.0
    method = "unresolved"

    bid, confidence, method = resolve(name, area, developer)

    if bid == 0:
        shortened = re.sub(r'\s+(Phase|Ph|Tower|Wing|Block|Building)\s*[\w\d]*$', '', name, flags=re.IGNORECASE)
        if shortened != name:
            bid, confidence, method = resolve(shortened, area, developer)

    if bid == 0 and rera:
        bid, confidence, method = resolve_by_rera(rera)

    return {
        **project,
        "building_id": bid,
        "resolution_confidence": confidence,
        "resolution_method": method,
        "resolved": bid > 0,
    }


# ── Build Canonical Registry ─────────────────────────────────────

def build_canonical_registry(resolved_projects: list[dict]) -> dict:
    """
    Build canonical projects + developer registry.

    Returns:
        {
            "projects": [ {project_id, rera_no, project_name, developer_name,
                           building_ids (list), ...}, ... ],
            "developers": { developer_name: {project_ids, building_ids} },
            "rera_index": { rera_no: project_dict },
        }
    """
    existing = _load_existing_projects()
    next_id = _next_project_id(existing)

    projects = []
    developers = defaultdict(lambda: {"project_ids": [], "building_ids": set()})
    rera_index = {}
    resolved_count = 0

    for p in resolved_projects:
        rera = p["rera_no"]
        dev_name = p["promoter"]
        bid = p["building_id"]

        # Preserve existing project_id if rera already seen
        if rera in existing:
            pid = int(existing[rera]["project_id"])
        else:
            pid = next_id
            next_id += 1

        building_ids = [bid] if bid > 0 else []

        project_row = {
            "project_id": pid,
            "rera_no": rera,
            "project_name": p["project_name"],
            "developer_name": dev_name,
            "building_ids": ";".join(str(b) for b in building_ids),
            "location": p["location"],
            "area": p["area"],
            "district": p["district"],
            "pincode": p["pincode"],
            "resolution_confidence": p["resolution_confidence"],
            "resolution_method": p["resolution_method"],
            "last_modified": p["last_modified"],
        }
        projects.append(project_row)
        rera_index[rera] = project_row

        if dev_name:
            developers[dev_name]["project_ids"].append(pid)
            if bid > 0:
                developers[dev_name]["building_ids"].add(bid)

        if bid > 0:
            resolved_count += 1

    resolved_devs = sum(1 for d in developers.values() if d["building_ids"])
    print(f"  Resolved: {resolved_count}/{len(resolved_projects)} ({resolved_count/max(len(resolved_projects), 1) * 100:.1f}%)")
    print(f"  Developers with resolved buildings: {resolved_devs} / {len(developers)}")

    return {
        "projects": projects,
        "developers": dict(developers),
        "rera_index": rera_index,
    }


# ── Write Outputs ────────────────────────────────────────────────

def write_projects(projects: list[dict]):
    fieldnames = [
        "project_id", "rera_no", "project_name", "developer_name",
        "building_ids", "location", "area", "district", "pincode",
        "resolution_confidence", "resolution_method", "last_modified",
    ]
    with open(PROJECTS_PATH, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(projects)
    print(f"  Wrote {len(projects)} projects to {PROJECTS_PATH}")


def write_developer_registry(developers: dict):
    """
    Write developer_registry.csv (only developers with resolved buildings).
    """
    rows = []
    for dev_name, info in developers.items():
        building_ids = list(info["building_ids"])
        if not building_ids:
            continue
        project_ids = info["project_ids"]
        rows.append({
            "developer_name": dev_name,
            "project_count": len(project_ids),
            "project_ids": ";".join(str(pid) for pid in project_ids),
            "building_ids": ";".join(str(b) for b in building_ids),
            "resolved_buildings": len(building_ids),
        })

    rows.sort(key=lambda r: -r["project_count"])

    with open(DEVELOPER_REGISTRY_PATH, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=[
            "developer_name", "project_count", "project_ids",
            "building_ids", "resolved_buildings",
        ])
        w.writeheader()
        w.writerows(rows)
    print(f"  Wrote {len(rows)} developers to {DEVELOPER_REGISTRY_PATH}")


def write_rera_lookup(rera_index: dict):
    rows = []
    for rera, p in rera_index.items():
        bid_str = p.get("building_ids", "")
        first_bid = bid_str.split(";")[0] if bid_str else "0"
        rows.append({
            "rera_no": rera,
            "project_id": p["project_id"],
            "project_name": p["project_name"],
            "building_ids": bid_str,
            "building_id": first_bid,
            "confidence": p["resolution_confidence"],
        })

    with open(RERA_LOOKUP_PATH, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=[
            "rera_no", "project_id", "project_name",
            "building_ids", "building_id", "confidence",
        ])
        w.writeheader()
        w.writerows(rows)
    print(f"  Wrote {len(rows)} RERA lookups to {RERA_LOOKUP_PATH}")


# ── Observations ─────────────────────────────────────────────────

def create_observations(projects: list[dict]) -> list[dict]:
    pipeline = create_pipeline("MAHARERA")

    raw_observations = []
    for p in projects:
        bid_str = p.get("building_ids", "")
        building_ids = [int(b) for b in bid_str.split(";") if b.strip()]
        first_bid = building_ids[0] if building_ids else 0

        raw_observations.append({
            "building_name": p["project_name"],
            "area": p["area"],
            "developer": p["developer_name"],
            "observation_type": "MAHARERA_PROJECT",
            "observed_at": p["last_modified"] or "",
            "source_reference": p["rera_no"],
            "payload": {
                "project_id": p["project_id"],
                "rera_number": p["rera_no"],
                "project_name": p["project_name"],
                "developer_name": p["developer_name"],
                "location": p["location"],
                "district": p["district"],
                "pincode": p["pincode"],
                "area": p["area"],
                "building_ids": bid_str,
                "resolution_confidence": p["resolution_confidence"],
                "resolution_method": p["resolution_method"],
            },
        })

    print(f"  Feeding {len(raw_observations)} observations through pipeline...")
    results = pipeline.run(raw_observations)
    print(f"  Ingested: {len(results['ingested'])}")
    print(f"  Unresolved: {len(results['unresolved'])}")
    print(f"  Failed: {len(results['failed'])}")

    return raw_observations


# ── Main ─────────────────────────────────────────────────────────

def run():
    print("=" * 60)
    print("MahaRERA Enrichment Pipeline")
    print("=" * 60)

    print("\n[1/5] Loading raw MahaRERA projects...")
    projects = load_raw_projects()
    if not projects:
        print("  Nothing to process. Run the scraper first.")
        return

    print("\n[2/5] Normalizing projects...")
    normalized = [normalize_project(p) for p in projects]
    print(f"  Normalized {len(normalized)} projects")

    print("\n[3/5] Resolving BuildingIDs...")
    clear_cache()
    resolved = [resolve_project(p) for p in normalized]

    print("\n[4/5] Building canonical registries...")
    registry = build_canonical_registry(resolved)
    write_projects(registry["projects"])
    write_developer_registry(registry["developers"])
    write_rera_lookup(registry["rera_index"])

    print("\n[5/5] Creating observations...")
    create_observations(registry["projects"])

    resolved_count = sum(1 for p in resolved if p["building_id"] > 0)
    resolved_devs = sum(1 for d in registry["developers"].values() if d["building_ids"])
    print()
    print("=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"  Projects processed:              {len(resolved)}")
    print(f"  Buildings resolved:              {resolved_count} ({resolved_count/max(len(resolved),1)*100:.1f}%)")
    print(f"  Unresolved:                      {len(resolved) - resolved_count}")
    print(f"  Total developers (all):          {len(registry['developers'])}")
    print(f"  Developers with resolved builds: {resolved_devs}")
    print(f"  Output files:")
    print(f"    {PROJECTS_PATH}")
    print(f"    {DEVELOPER_REGISTRY_PATH}")
    print(f"    {RERA_LOOKUP_PATH}")
    print(f"    observations.csv (via pipeline)")


if __name__ == "__main__":
    run()
