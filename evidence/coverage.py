"""
Evidence Coverage Report — measures knowledge graph completeness.

Instead of "how many buildings did we scrape", tracks:

  How many buildings have observations?
  How many sources cover each building?
  How deep is the evidence history?
  Where are the gaps?

Run daily to track growth of evidence density.
"""
import csv
import os
import sys
from collections import defaultdict, Counter
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")


def load_buildings() -> dict:
    """Load canonical buildings. Returns {building_id: {name, area, developer}}."""
    bldgs = {}
    path = os.path.join(DATA_DIR, "canonical_buildings.csv")
    if not os.path.exists(path):
        return bldgs
    with open(path) as f:
        for row in csv.DictReader(f):
            bid = int(row["building_id"])
            bldgs[bid] = {
                "name": row["canonical_name"],
                "area": row.get("area", ""),
                "developer": row.get("developer", ""),
            }
    return bldgs


def load_observations() -> list[dict]:
    """Load all observations from the append-only store."""
    path = os.path.join(DATA_DIR, "observations.csv")
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return list(csv.DictReader(f))


def load_unresolved() -> list[dict]:
    """Load unresolved observations."""
    path = os.path.join(DATA_DIR, "unresolved_observations.csv")
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return list(csv.DictReader(f))


def load_projects() -> list[dict]:
    """Load canonical project registry."""
    path = os.path.join(DATA_DIR, "projects.csv")
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return list(csv.DictReader(f))


def compute_coverage(buildings: dict, observations: list[dict],
                     unresolved: list[dict], projects: list[dict]) -> dict:
    """
    Compute evidence coverage metrics.

    Returns { metric_name: value } dict for reporting.
    """
    total_buildings = len(buildings)

    # Per-building observation stats
    obs_per_building = defaultdict(list)
    obs_sources_per_building = defaultdict(set)
    obs_dates_per_building = defaultdict(list)

    for obs in observations:
        bid_str = obs.get("building_id", "0")
        try:
            bid = int(bid_str)
        except ValueError:
            continue
        if bid == 0:
            continue
        obs_per_building[bid].append(obs)
        obs_sources_per_building[bid].add(obs.get("source", ""))
        d = obs.get("observed_at", "")
        if d:
            obs_dates_per_building[bid].append(d)

    buildings_with_obs = len(obs_per_building)
    buildings_with_10 = sum(1 for v in obs_per_building.values() if len(v) >= 10)
    buildings_with_100 = sum(1 for v in obs_per_building.values() if len(v) >= 100)

    # Source diversity: 3+ independent sources
    buildings_with_3_sources = sum(
        1 for s in obs_sources_per_building.values() if len(s) >= 3
    )

    # Time span: 90+ days of history
    buildings_with_90d = 0
    now = datetime.now(timezone.utc)
    for bid, dates in obs_dates_per_building.items():
        parsed = []
        for d in dates:
            try:
                parsed.append(datetime.fromisoformat(d.replace("Z", "")))
            except (ValueError, TypeError):
                pass
        if parsed:
            span = (max(parsed) - min(parsed)).days
            if span >= 90:
                buildings_with_90d += 1

    # Source diversity distribution
    source_counts = Counter(len(s) for s in obs_sources_per_building.values())
    source_diversity_buckets = {
        "1 source": source_counts.get(1, 0),
        "2 sources": source_counts.get(2, 0),
        "3 sources": source_counts.get(3, 0),
        "4+ sources": sum(v for k, v in source_counts.items() if k >= 4),
    }

    # Evidence density per building
    total_obs = len(observations)
    avg_density = round(total_obs / max(buildings_with_obs, 1), 1)
    median_density = 0
    if obs_per_building:
        sorted_counts = sorted(len(v) for v in obs_per_building.values())
        mid = len(sorted_counts) // 2
        median_density = sorted_counts[mid] if len(sorted_counts) % 2 else (
            (sorted_counts[mid - 1] + sorted_counts[mid]) / 2
        )

    # Projects linked to buildings
    projects_with_buildings = sum(
        1 for p in projects if p.get("building_ids", "").strip()
    )
    # Developers linked to projects (from project registry developer_name field)
    devs_with_projects = len(set(
        p.get("developer_name", "") for p in projects if p.get("developer_name", "").strip()
    ))

    return {
        "canonical_buildings": total_buildings,
        "buildings_with_obs": buildings_with_obs,
        "buildings_with_10_obs": buildings_with_10,
        "buildings_with_100_obs": buildings_with_100,
        "buildings_with_3_sources": buildings_with_3_sources,
        "buildings_with_90d_history": buildings_with_90d,
        "coverage_pct": round(buildings_with_obs / max(total_buildings, 1) * 100, 1),
        "total_observations": total_obs,
        "avg_evidence_density": avg_density,
        "median_evidence_density": median_density,
        "source_diversity": source_diversity_buckets,
        "unresolved_observations": len(unresolved),
        "projects_linked_to_buildings": projects_with_buildings,
        "total_projects": len(projects),
        "developers_linked_to_projects": devs_with_projects,
    }


def format_stars(count: int) -> str:
    """Convert source count to 1-5 star rating."""
    if count >= 5:
        return "★★★★★"
    if count >= 4:
        return "★★★★"
    if count >= 3:
        return "★★★"
    if count >= 2:
        return "★★"
    return "★"


def print_report(coverage: dict):
    """Print the coverage report in a readable format."""
    print("=" * 65)
    print("  EVIDENCE COVERAGE REPORT")
    print("=" * 65)
    print(f"  Generated: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")
    print()

    # Core metrics
    print(f"  {'Metric':<45} {'Value':>10}")
    print(f"  {'─'*45} {'─'*10}")
    print(f"  {'Canonical buildings':<45} {coverage['canonical_buildings']:>10}")
    print(f"  {'Buildings with ≥1 observation':<45} {coverage['buildings_with_obs']:>10}")
    print(f"  {'Coverage %':<45} {coverage['coverage_pct']:>10}%")
    print(f"  {'Buildings with ≥10 observations':<45} {coverage['buildings_with_10_obs']:>10}")
    print(f"  {'Buildings with ≥100 observations':<45} {coverage['buildings_with_100_obs']:>10}")
    print(f"  {'Buildings with ≥3 data sources':<45} {coverage['buildings_with_3_sources']:>10}")
    print(f"  {'Buildings with ≥90 days history':<45} {coverage['buildings_with_90d_history']:>10}")
    print()

    # Evidence density
    print(f"  {'Total observations':<45} {coverage['total_observations']:>10}")
    print(f"  {'Average evidence density (obs/building)':<45} {coverage['avg_evidence_density']:>10}")
    print(f"  {'Median evidence density':<45} {coverage['median_evidence_density']:>10}")
    print()

    # Source diversity
    print("  Source diversity:")
    sd = coverage["source_diversity"]
    for label, count in sorted(sd.items(), key=lambda x: -x[1]):
        bar = "█" * min(count, 40) if count > 0 else ""
        print(f"    {label:<30} {count:>5}  {bar}")

    # Graph linkage
    print()
    print(f"  {'Projects linked to buildings':<45} {coverage['projects_linked_to_buildings']:>10}")
    print(f"  {'Total projects in registry':<45} {coverage['total_projects']:>10}")
    print(f"  {'Developers linked to projects':<45} {coverage['developers_linked_to_projects']:>10}")
    print(f"  {'Unresolved observations':<45} {coverage['unresolved_observations']:>10}")

    # Top buildings by evidence density
    print()
    print("─" * 65)

    # Per-building detail (top 10 by observation count)
    print("  TOP 10 BUILDINGS BY EVIDENCE DENSITY")
    print(f"  {'BuildingID':<12} {'Name':<28} {'Obs':>5} {'Sources':>8} {'Span':>6}")
    print(f"  {'─'*12} {'─'*28} {'─'*5} {'─'*8} {'─'*6}")


def building_summary(buildings: dict, observations: list[dict], top_n: int = 10):
    """Print a per-building density summary."""
    obs_per_building = defaultdict(list)
    sources_per_building = defaultdict(set)
    dates_per_building = defaultdict(list)

    for obs in observations:
        bid_s = obs.get("building_id", "0")
        try:
            bid = int(bid_s)
        except ValueError:
            continue
        if bid == 0:
            continue
        obs_per_building[bid].append(obs)
        sources_per_building[bid].add(obs.get("source", ""))
        d = obs.get("observed_at", "")
        if d:
            dates_per_building[bid].append(d)

    ranked = sorted(obs_per_building.items(), key=lambda x: -len(x[1]))

    for bid, obsv in ranked[:top_n]:
        name = buildings.get(bid, {}).get("name", "???")
        count = len(obsv)
        sources = len(sources_per_building.get(bid, set()))
        spans = dates_per_building.get(bid, [])
        span_days = 0
        if spans:
            try:
                parsed = [datetime.fromisoformat(d.replace("Z", "")) for d in spans]
                span_days = (max(parsed) - min(parsed)).days
            except (ValueError, TypeError):
                pass
        name_trunc = name[:28] if len(name) > 28 else name
        print(f"  {bid:<12} {name_trunc:<28} {count:>5} {sources:>8} {span_days:>6}")

    if ranked:
        print(f"  {'─'*12} {'─'*28} {'─'*5} {'─'*8} {'─'*6}")


def print_building_density_report(buildings: dict, observations: list[dict]):
    """Print per-building evidence density with star ratings."""
    obs_per_building = defaultdict(list)
    sources_per_building = defaultdict(set)
    dates_per_building = defaultdict(list)

    for obs in observations:
        bid_s = obs.get("building_id", "0")
        try:
            bid = int(bid_s)
        except ValueError:
            continue
        if bid == 0:
            continue
        obs_per_building[bid].append(obs)
        sources_per_building[bid].add(obs.get("source", ""))
        d = obs.get("observed_at", "")
        if d:
            dates_per_building[bid].append(d)

    ranked = sorted(obs_per_building.items(), key=lambda x: -len(x[1]))
    total_buildings = len(buildings)

    print()
    print("=" * 65)
    print("  PER-BUILDING EVIDENCE DENSITY (top 20)")
    print("=" * 65)
    print(f"  {'ID':<6} {'Building Name':<30} {'Obs':>5} {'Sources':>8} {'Span':>6} {'Rating':>8}")
    print(f"  {'─'*6} {'─'*30} {'─'*5} {'─'*8} {'─'*6} {'─'*8}")

    for bid, obsv in ranked[:20]:
        name = buildings.get(bid, {}).get("name", "???")
        count = len(obsv)
        sources_count = len(sources_per_building.get(bid, set()))
        star_rating = format_stars(sources_count)
        span_days = 0
        dates = dates_per_building.get(bid, [])
        if dates:
            try:
                parsed = [datetime.fromisoformat(d.replace("Z", "")) for d in dates]
                span_days = (max(parsed) - min(parsed)).days
            except (ValueError, TypeError):
                pass
        name_t = name[:30] if len(name) > 30 else name
        print(f"  {bid:<6} {name_t:<30} {count:>5} {sources_count:>8} {span_days:>6} {star_rating:>8}")

    # Buildings with zero observations
    zero_obs = total_buildings - len(obs_per_building)
    if zero_obs > 0:
        print()
        print(f"  Buildings with ZERO observations: {zero_obs} ({zero_obs/total_buildings*100:.1f}%)")


def run():
    """Run the evidence coverage report."""
    buildings = load_buildings()
    observations = load_observations()
    unresolved = load_unresolved()
    projects = load_projects()

    if not buildings:
        print("No canonical buildings found.")
        return

    coverage = compute_coverage(buildings, observations, unresolved, projects)
    print_report(coverage)
    building_summary(buildings, observations)
    print_building_density_report(buildings, observations)

    # Summary line
    print()
    print("─" * 65)
    pct = coverage["coverage_pct"]
    total = coverage["canonical_buildings"]
    with_obs = coverage["buildings_with_obs"]
    missing = total - with_obs

    status = "CRITICAL" if pct < 10 else ("LOW" if pct < 30 else ("MODERATE" if pct < 60 else ("HIGH" if pct < 90 else "EXCELLENT")))
    print(f"  Coverage Status: {status} ({with_obs}/{total} buildings have observations)")
    print(f"  Next priority: {'Fill observation gaps' if missing > 1000 else 'Increase source diversity'}")

    # If this were saved daily, we'd track the delta
    # For now, print counts that would go into a tracking dashboard
    print()
    print("  Dashboard metrics (save for time-series):")
    print(f"    date={datetime.now(timezone.utc).strftime('%Y-%m-%d')} "
          f"coverage_pct={coverage['coverage_pct']} "
          f"avg_density={coverage['avg_evidence_density']} "
          f"median_density={coverage['median_evidence_density']} "
          f"total_obs={coverage['total_observations']} "
          f"3plus_sources={coverage['buildings_with_3_sources']} "
          f"90d_history={coverage['buildings_with_90d_history']} "
          f"unresolved={coverage['unresolved_observations']}")


def building_density(building_id: int) -> dict:
    """
    Get evidence density for a single building.
    Use this from the intelligence engine or API.
    """
    buildings = load_buildings()
    observations = load_observations()

    if building_id not in buildings:
        return {"building_id": building_id, "found": False, "observations": 0}

    building_obs = [o for o in observations if o.get("building_id") == str(building_id)]
    sources = set(o.get("source", "") for o in building_obs)
    dates = [o.get("observed_at", "") for o in building_obs if o.get("observed_at")]

    span_days = 0
    if dates:
        try:
            parsed = [datetime.fromisoformat(d.replace("Z", "")) for d in dates]
            span_days = (max(parsed) - min(parsed)).days
        except (ValueError, TypeError):
            pass

    source_count = len(sources)
    if source_count >= 5:
        confidence = "very_high"
    elif source_count >= 3:
        confidence = "high"
    elif source_count >= 2:
        confidence = "moderate"
    elif source_count == 1:
        confidence = "low"
    else:
        confidence = "none"

    return {
        "building_id": building_id,
        "name": buildings[building_id]["name"],
        "found": True,
        "observations": len(building_obs),
        "unique_sources": source_count,
        "source_diversity_rating": format_stars(source_count),
        "time_span_days": span_days,
        "confidence": confidence,
    }


if __name__ == "__main__":
    run()
