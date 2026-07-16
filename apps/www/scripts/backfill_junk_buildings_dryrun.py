"""
Read-only dry-run: identify "junk" building names that leaked from raw message
text into buildings.canonical_name (and the listings that carry the same junk
building_name). Mirrors the www isJunkBuildingName guard.

NO database writes. Reports counts + samples so a cleanup UPDATE can be planned.

Run: python3 apps/www/scripts/backfill_junk_buildings_dryrun.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))

URL = "https://jsoiuzfwohtfkctlkozw.supabase.co"
KEY = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impzb2l1emZ3"
    "b2h0ZmtjdGxrb3p3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MzI2MTgzMywiZXhwIjoy"
    "MDk4ODM3ODMzfQ.LZEE8bXPjsONehNVqNJGM_iufIz9FUdV3z_S4GUmuEM"
)


def is_junk(name):
    if not name:
        return True
    n = name.strip()
    if len(n) < 3:
        return True
    import re
    lower = n.lower()
    # Strong real-estate ad phrases that only appear in raw message text, never
    # in a real building/society name.
    AD_PHRASES = re.compile(
        r"\b(available|commercial space|for rent|for sale|on rent|on sale|"
        r"outright|unfurnished|furnished|semi furnished|car parking|carpet|"
        r"built up|super area|sq\.?ft|sqft|bhk|rent|sale|possession|resale)\b"
    )
    # Words that mark a LEGITIMATE building/society name — if present, never junk.
    SOCIETY = re.compile(
        r"\b(society|chs|chsl|ch\.s\.l|co[- ]?op|cooperative|housing|apartment|"
        r"apartments|niwas|park|phase|tower|towers|complex|heights|residency|"
        r"buildi?ng|estate|enclave|gardens|heights|residences|layout)\b"
    )
    if SOCIETY.search(lower):
        return False
    # Only flag as junk when it reads like an ad sentence: an ad phrase present
    # AND it is a multi-word phrase (>=5 words) OR starts with junk punctuation.
    has_ad = bool(AD_PHRASES.search(lower))
    words = [w for w in n.split() if w]
    if has_ad and (len(words) >= 5 or re.match(r"^[.\*◇\-_]+", n)):
        return True
    # Leading markdown/punctuation artifacts with an ad phrase.
    if re.match(r"^[.\*◇\-_]+", n) and has_ad:
        return True
    return False


def main() -> None:
    import urllib.request
    import urllib.error

    headers = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}

    def get(path, params=""):
        url = f"{URL}/rest/v1/{path}{params}"
        req = urllib.request.Request(url, headers=headers)
        return json.loads(urllib.request.urlopen(req).read())

    # All buildings with canonical_name.
    buildings = []
    for offset in range(0, 10000, 1000):
        rows = get(
            "buildings",
            f"?select=id,canonical_name,micro_market&canonical_name=not.is.null"
            f"&order=id&limit=1000&offset={offset}",
        )
        buildings.extend(rows)
        if len(rows) < 1000:
            break

    junk_buildings = [b for b in buildings if is_junk(b["canonical_name"])]
    print(f"Total buildings: {len(buildings)}")
    print(f"Junk buildings (would 404 on www): {len(junk_buildings)}")

    # Listings whose building_name matches a junk canonical_name.
    junk_names = {b["canonical_name"] for b in junk_buildings}
    listings_with_junk = []
    for offset in range(0, 20000, 1000):
        rows = get(
            "listings",
            f"?select=id,building_name&building_name=not.is.null"
            f"&order=id&limit=1000&offset={offset}",
        )
        for r in rows:
            if r["building_name"] in junk_names:
                listings_with_junk.append(r)
        if len(rows) < 1000:
            break

    print(f"Listings carrying a junk building_name: {len(listings_with_junk)}")
    print("\nJunk building samples (first 8):")
    for b in junk_buildings[:8]:
        print(f"  id={b['id']} market={b['micro_market']!r} name={b['canonical_name'][:60]!r}")
    print("\nLinked listing samples (first 8):")
    for r in listings_with_junk[:8]:
        print(f"  listing id={r['id']} name={r['building_name'][:60]!r}")

    # How many junk buildings already have a REAL building also in same market?
    print("\nNO UPDATES PERFORMED.")


if __name__ == "__main__":
    main()
