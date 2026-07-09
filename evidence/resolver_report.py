"""
Resolver Report — diagnoses every resolution attempt.

Categorizes each MahaRERA project:
  - Matched BuildingID       → resolved successfully
  - Outside Mumbai region    → expected miss, no action
  - Developer known, no bid  → project exists in registry's service area but building missing
  - Street matched           → project name matches a street (likely a reference, not a project)
  - Insufficient information → entirely unknown to the registry
  - Likely resolver bug      → should have matched but didn't
"""
import csv
import os
import re
import sys
from difflib import SequenceMatcher
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from evidence.resolver import (
    resolve, resolve_by_rera, resolve_by_project_name,
    resolve_by_developer, clear_cache,
)

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")

MUMBAI_REGION = {"Mumbai City", "Mumbai Suburban", "Thane", "Palghar", "Raigad"}


def load_all() -> tuple:
    """Load canonical buildings, projects, developers, streets for diagnosis."""
    bldgs = {}
    with open(os.path.join(DATA_DIR, "canonical_buildings.csv")) as f:
        for row in csv.DictReader(f):
            bldgs[int(row["building_id"])] = row["canonical_name"]

    devs = {}
    path = os.path.join(DATA_DIR, "developer_registry.csv")
    if os.path.exists(path):
        with open(path) as f:
            for row in csv.DictReader(f):
                devs[row["developer_name"].strip().lower()] = {
                    "name": row["developer_name"],
                    "building_ids": [int(b) for b in row.get("building_ids", "").split(";") if b.strip()],
                }

    streets = []
    path = os.path.join(DATA_DIR, "streets.csv")
    if os.path.exists(path):
        with open(path) as f:
            for row in csv.DictReader(f):
                streets.append({
                    "name": row["name"],
                    "building_ids": [int(b) for b in row.get("building_ids", "").split(";") if b.strip()],
                })

    return bldgs, devs, streets


def is_mumbai(district: str) -> bool:
    return district.strip() in MUMBAI_REGION


def closest_fuzzy(name: str, bldgs: dict, threshold: float = 0.4) -> list:
    """Find closest building name matches even below resolution threshold."""
    n = re.sub(r'[^a-z0-9\s]', '', name.lower().strip())
    n = re.sub(r'\s+', ' ', n).strip()
    cands = []
    for bid, bname in bldgs.items():
        bn = re.sub(r'[^a-z0-9\s]', '', bname.lower().strip())
        bn = re.sub(r'\s+', ' ', bn).strip()
        r = SequenceMatcher(None, n, bn).ratio()
        if r >= threshold:
            cands.append((r, bid, bname))
    cands.sort(reverse=True)
    return cands[:5]


def diagnose(project: dict, bldgs: dict, devs: dict, streets: list) -> dict:
    name = project.get("project_name", "").strip()
    promoter = project.get("promoter", "").strip()
    district = project.get("district", "").strip()
    area = (project.get("location", "") or "").split(",")[0].strip()
    rera = project.get("rera_no", "").strip()

    # Try resolution (uses new multi-path resolver)
    bid, confidence, method = resolve(name, area, promoter)

    reasons = []
    verdict = "resolved" if bid > 0 else "unresolved"

    if bid > 0:
        reasons.append(f"Matched via {method} (confidence={confidence})")
    else:
        # Check outside Mumbai
        in_mumbai = is_mumbai(district)
        if not in_mumbai:
            reasons.append(f"Outside Mumbai region: district={district}")
            verdict = "outside_mumbai"

        # Street match
        nl = name.lower().strip()
        for s in streets:
            sn = s["name"].lower()
            if sn in nl or nl in sn:
                bids_str = f"{len(s['building_ids'])} buildings" if s["building_ids"] else "no registered buildings"
                reasons.append(f"Name matches street '{s['name']}' ({bids_str})")

        # Developer lookup
        dev_key = promoter.lower().strip()
        if dev_key in devs:
            d = devs[dev_key]
            if d["building_ids"]:
                reasons.append(f"Developer '{promoter}' known ({len(d['building_ids'])} buildings)")
            else:
                reasons.append(f"Developer '{promoter}' known but has no resolved buildings")
        else:
            for dk, dv in devs.items():
                if dev_key in dk or dk in dev_key:
                    reasons.append(f"Developer partial match: '{dv['name']}'")
                    break

        # Project registry lookup
        proj = resolve_by_project_name(name)
        if proj and proj["building_ids"]:
            reasons.append(f"Project exists in registry (project_id={proj['project_id']}) with buildings {proj['building_ids']}")

        # RERA lookup
        rera_bid, rera_conf, rera_method = resolve_by_rera(rera)
        if rera_bid > 0:
            reasons.append(f"RERA {rera} previously resolved to building_id={rera_bid}")

        # Closest fuzzy match
        fuzzy = closest_fuzzy(name, bldgs)
        if fuzzy:
            r, fb, fn = fuzzy[0]
            reasons.append(f"Closest fuzzy: '{fn}' (ratio={r:.2f}, bid={fb})")
            if r < 0.5:
                reasons.append("Entirely unknown to registry")
        else:
            reasons.append("No fuzzy match above 0.4 — entirely unknown")

    return {
        "rera": rera,
        "project_name": name,
        "promoter": promoter,
        "district": district,
        "area": area,
        "building_id": bid,
        "confidence": confidence,
        "method": method,
        "verdict": verdict,
        "reasons": reasons,
    }


def classify(diag: dict) -> str:
    if diag["building_id"] > 0:
        return "Matched BuildingID"
    if diag["verdict"] == "outside_mumbai":
        return "Outside Mumbai region"
    r = " ".join(diag["reasons"]).lower()
    if "project exists in registry" in r:
        return "Project exists — building missing from project→building link"
    if "developer" in r and "known" in r:
        return "Developer known — building missing"
    if "street" in r:
        return "Street matched — building may be unmapped"
    if "entirely unknown" in r or "no fuzzy" in r:
        return "Insufficient information"
    if "previously resolved" in r:
        return "Previously resolved — check registry"
    # Extract closest fuzzy ratio to distinguish bugs from low-similarity
    for reason in diag.get("reasons", []):
        if "closest fuzzy" in reason.lower() and "ratio=" in reason.lower():
            m = re.search(r'ratio=([\d.]+)', reason)
            if m:
                ratio = float(m.group(1))
                if ratio >= 0.75:
                    return "Close fuzzy match missed — check resolver"
                elif ratio >= 0.60:
                    return "Low similarity — name differs from nearest building"
                else:
                    return "No meaningful name match in registry"
    return "Likely resolver bug — no clear diagnosis"


def generate_report(projects: list[dict]):
    clear_cache()
    bldgs, devs, streets = load_all()
    total = len(projects)

    results = [diagnose(p, bldgs, devs, streets) for p in projects]
    for r in results:
        r["category"] = classify(r)

    cats = Counter(r["category"] for r in results)
    verdicts = Counter(r["verdict"] for r in results)

    print("=" * 65)
    print("  RESOLVER REPORT")
    print("=" * 65)
    print(f"  Total projects: {total}")
    print()
    print(f"  {'Category':<50} {'Count':>5}")
    print(f"  {'─'*50} {'─'*5}")
    for cat, count in sorted(cats.items(), key=lambda x: -x[1]):
        print(f"  {cat:<50} {count:>5}")
    print()
    print(f"  Verdict breakdown: resolved={verdicts.get('resolved',0)}, "
          f"outside_mumbai={verdicts.get('outside_mumbai',0)}, "
          f"unresolved={verdicts.get('unresolved',0)}")
    print()

    # Detail
    for r in results:
        icon = {"resolved": "✓", "unresolved": "?"}.get(r["verdict"], "⨯")
        print(f"\n  {icon} {r['project_name']}")
        print(f"    RERA: {r['rera']}  |  District: {r['district']}  |  Area: {r['area']}")
        print(f"    Developer: {r['promoter']}")
        if r["building_id"] > 0:
            print(f"    → BuildingID={r['building_id']} ({r['method']}, conf={r['confidence']})")
        else:
            print(f"    → UNRESOLVED ({r['category']})")
        for reason in r["reasons"]:
            print(f"      • {reason}")

    # Action items
    actions = {
        "Matched BuildingID": "None — already resolved",
        "Outside Mumbai region": "Ignore — outside registry scope",
        "Developer known — building missing": "Create project→building link for this developer's project",
        "Project exists — building missing from project→building link": "Update project→building linkage in projects.csv",
        "Street matched — building may be unmapped": "Check street registry — building may exist but not linked",
        "Close fuzzy match missed — check resolver": "Investigate resolver: close name but blocked by other filter",
        "Low similarity — name differs from nearest building": "New project not in registry — needs manual building creation or alias",
        "No meaningful name match in registry": "Project name entirely unknown to registry",
        "Insufficient information": "Manual review needed",
        "Likely resolver bug — no clear diagnosis": "Investigate resolver logic",
    }
    print()
    print("=" * 65)
    print("  ACTION ITEMS")
    print("=" * 65)
    for cat, action in actions.items():
        n = cats.get(cat, 0)
        if n:
            print(f"  {cat:<50} {n:>3}  → {action}")


def run():
    path = os.path.join(DATA_DIR, "maharera_projects.csv")
    if not os.path.exists(path):
        print(f"No data at {path}")
        return
    with open(path) as f:
        generate_report(list(csv.DictReader(f)))


if __name__ == "__main__":
    run()
