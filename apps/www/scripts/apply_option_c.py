"""
Apply Option C backfill (read-only dry-run verified: 626 resolvable + 115 mistag corrections).

Pass 1 — Option C tag:
  For listings with building_name populated but micro_market NULL, join to
  buildings.canonical_name and use buildings.address as the locality candidate,
  validated against the cleaned gazetteer (buckets excluded). Write micro_market.

Pass 2 — Mistag correction:
  For listings whose micro_market is already set but REALLY conflicts with their
  building's address (base locality differs, West/East granularity excluded),
  overwrite micro_market with the building address (gazetteer-validated).

NO writes happen to rows that fail gazetteer validation.

Run: python3 apps/www/scripts/apply_option_c.py
"""
import json
import os
import re
import sys
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor

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

HEADERS = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json", "Prefer": "return=minimal"}


def is_canonical(v):
    if not v:
        return None
    v = v.strip().lower()
    return v if v in GAZETTEER else None


def base(v):
    return re.sub(r"\s+(west|east|central|prime|mid|extended)$", "", (v or "").lower()).strip()


def get(path, params):
    url = f"{URL}/rest/v1/{path}{params}"
    req = urllib.request.Request(url, headers={"apikey": KEY, "Authorization": f"Bearer {KEY}"})
    return json.loads(urllib.request.urlopen(req).read())


def patch(row_id, value):
    body = json.dumps({"micro_market": value}).encode()
    req = urllib.request.Request(f"{URL}/rest/v1/listings?id=eq.{row_id}", data=body, headers=HEADERS, method="PATCH")
    urllib.request.urlopen(req)


def main() -> None:
    # Buildings map
    buildings = []
    for offset in range(0, 10000, 1000):
        rows = get("buildings", f"?select=canonical_name,address,micro_market&canonical_name=not.is.null&limit=1000&offset={offset}")
        buildings.extend(rows)
        if len(rows) < 1000:
            break
    name_to_address = {}
    for b in buildings:
        cn = (b.get("canonical_name") or "").strip()
        if cn:
            name_to_address[cn.lower()] = (b.get("address") or "").strip()

    # Listings
    listings = []
    for offset in range(0, 20000, 1000):
        rows = get("listings", f"?select=id,building_name,micro_market&building_name=not.is.null&limit=1000&offset={offset}")
        listings.extend(rows)
        if len(rows) < 1000:
            break

    option_c = []   # (id, value) untagged -> tag from address
    mistag = []     # (id, value) mistagged -> overwrite from address
    for r in listings:
        bn = (r.get("building_name") or "").strip()
        addr = name_to_address.get(bn.lower(), "")
        hit = is_canonical(addr)
        mm = (r.get("micro_market") or "").strip()
        if not mm:
            if hit:
                option_c.append((r["id"], hit.title()))
        else:
            if hit and base(mm) != base(addr):
                mistag.append((r["id"], hit.title()))

    print(f"Option C to tag: {len(option_c)}")
    print(f"Mistag to correct: {len(mistag)}")

    def run(label, items):
        done = 0
        with ThreadPoolExecutor(max_workers=16) as ex:
            list(ex.map(lambda x: patch(x[0], x[1]), items))
            done = len(items)
        print(f"  applied {label}: {done}")

    run("Option C", option_c)
    run("mistag correction", mistag)
    print("\nNO writes to rows failing gazetteer validation. Done.")


if __name__ == "__main__":
    main()
