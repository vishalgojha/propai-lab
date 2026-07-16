"""
Option C dry-run (read-only): for listings with building_name populated but
micro_market NULL, resolve the locality via buildings.canonical_name -> buildings.address
(NOT buildings.micro_market, which is a bucket). Validate the address against the
cleaned gazetteer before counting it as resolvable.

Also reports the Kalpataru Magnus mistag scope: listings whose micro_market is
already set but CONFLICTS with their building's address (likely mistagged).

NO database writes.

Run: python3 apps/www/scripts/backfill_option_c_dryrun.py
"""
import json
import os
import re
import sys
import urllib.request
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))

URL = "https://jsoiuzfwohtfkctlkozw.supabase.co"
KEY = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impzb2l1emZ3"
    "b2h0ZmtjdGxrb3p3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MzI2MTgzMywiZXhwIjoy"
    "MDk4ODM3ODMzfQ.LZEE8bXPjsONehNVqNJGM_iufIz9FUdV3z_S4GUmuEM"
)

DETERMINISTIC = [
    "andheri", "andheri west", "andheri east", "bandra", "bandra west", "bandra east",
    "bkc", "santacruz", "santacruz west", "santacruz east", "khar", "khar west", "juhu",
    "malad", "malad west", "goregaon", "goregaon west", "worli", "parel", "lower parel",
    "dadar", "powai", "versova", "vile parle", "chembur", "mahalaxmi", "prabhadevi",
    "oshiwara", "lokhandwala", "mount mary", "pali hill", "turner road", "carter road",
    "hill road", "linking road", "thane", "vasai",
]
LLM_KNOWN = [
    "bandra west", "bandra east", "khar west", "khar east", "santacruz west",
    "santacruz east", "vile parle west", "vile parle east", "andheri west",
    "andheri east", "juhu", "juhu tara road", "versova", "lokhandwala", "oshiwara",
    "marol", "sakinaka", "powai", "chandivali", "bkc", "lower parel", "parel",
    "mahalaxmi", "worli", "prabhadevi", "dadar west", "dadar east", "matunga",
    "mahim", "shivaji park", "malad west", "malad east", "goregaon west",
    "goregaon east", "kandivali west", "kandivali east", "borivali west",
    "borivali east", "dahisar", "mira road", "thane west", "thane east", "mulund",
    "bhandup", "vikhroli", "kanjur marg", "ghatkopar", "chembur", "wadala", "sewri",
    "colaba", "cuffe parade", "nariman point", "fort", "churchgate", "marine lines",
    "charni road", "grant road", "mumbai central",
]
BUCKETS = {
    "south mumbai central", "near thakur mall highway", "central suburbs",
    "eastern suburbs", "western suburbs mid", "western suburbs prime", "navi mumbai",
}
GAZETTEER = {s.strip().lower() for s in (DETERMINISTIC + LLM_KNOWN) if s.strip().lower() and s.strip().lower() not in BUCKETS}


def is_canonical(v):
    if not v:
        return None
    v = v.strip().lower()
    # address may be "Andheri West" -> match; or "BKC" -> match; allow gazetteer or alias-normalized
    return v if v in GAZETTEER else None


def get(path, params):
    url = f"{URL}/rest/v1/{path}{params}"
    req = urllib.request.Request(url, headers={"apikey": KEY, "Authorization": f"Bearer {KEY}"})
    return json.loads(urllib.request.urlopen(req).read())


def main() -> None:
    # Load all buildings (canonical_name -> address). Paginate.
    buildings = []
    for offset in range(0, 10000, 1000):
        rows = get("buildings", f"?select=canonical_name,address,micro_market&canonical_name=not.is.null&limit=1000&offset={offset}")
        buildings.extend(rows)
        if len(rows) < 1000:
            break
    name_to_address = {}
    name_to_market = {}
    for b in buildings:
        cn = (b["canonical_name"] or "").strip()
        if cn:
            name_to_address[cn.lower()] = (b.get("address") or "").strip()
            name_to_market[cn.lower()] = (b.get("micro_market") or "").strip()

    # Listings with building_name populated. Paginate.
    listings = []
    for offset in range(0, 20000, 1000):
        rows = get("listings", f"?select=id,building_name,micro_market&building_name=not.is.null&limit=1000&offset={offset}")
        listings.extend(rows)
        if len(rows) < 1000:
            break

    untagged = [r for r in listings if not (r.get("micro_market") or "").strip()]
    print(f"Listings w/ building_name: {len(listings)}")
    print(f"  of which micro_market NULL (Option C target): {len(untagged)}")

    resolved = 0
    unresolved_samples = []
    by_locality = {}
    for r in untagged:
        bn = (r.get("building_name") or "").strip()
        addr = name_to_address.get(bn.lower(), "")
        hit = is_canonical(addr)
        if hit:
            resolved += 1
            by_locality[hit] = by_locality.get(hit, 0) + 1
        elif len(unresolved_samples) < 15:
            unresolved_samples.append(f"[id {r['id']}] bn={bn!r} addr={addr!r}")

    rate = f"{(resolved / len(untagged) * 100):.1f}" if untagged else "0"
    print(f"\nOption C resolvable (via building.address, gazetteer-validated): {resolved} ({rate}%)")
    print("Resolved breakdown:")
    for loc, n in sorted(by_locality.items(), key=lambda x: -x[1]):
        print(f"  {loc}: {n}")
    print(f"\nUnresolved samples (first {len(unresolved_samples)}):")
    for s in unresolved_samples:
        print(f"  - {s}")

    # Mistag scope: listings whose micro_market is set but conflicts with building.address.
    # Normalize away West/East/Central granularity so we only count REAL conflicts.
    def base(v):
        return re.sub(r"\s+(west|east|central|prime|mid|extended)$", "", (v or "").lower()).strip()

    conflicts = []
    benign = 0
    for r in listings:
        mm = (r.get("micro_market") or "").strip()
        if not mm:
            continue
        bn = (r.get("building_name") or "").strip()
        addr = name_to_address.get(bn.lower(), "")
        if addr and is_canonical(addr) and is_canonical(mm):
            if base(mm) != base(addr):
                conflicts.append((r["id"], bn, mm, addr))
            else:
                benign += 1
    print(f"\nMistag candidates (listing micro_market set, REAL conflict with building.address): {len(conflicts)}")
    print(f"  (benign West/East granularity diffs, not counted: {benign})")
    for c in conflicts[:15]:
        print(f"  - id={c[0]} bn={c[1]!r} listing_mm={c[2]!r} building_addr={c[3]!r}")

    print("\nNO UPDATES PERFORMED.")


if __name__ == "__main__":
    main()
