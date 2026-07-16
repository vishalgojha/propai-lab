"""
Apply the pre-approved deterministic backfill: tag ONLY the rows that
parse_location + aliases resolve to a cleaned-gazetteer canonical locality.
Read-only dry-run confirmed this set = 370 rows. The remaining 4,575 rows are
structurally non-locality text (marketing fragments, floor/deal descriptors,
prepositions, bare building names) and are left PERMANENTLY untagged.

No LLM pass. No UPDATE on unmatched rows.

Run: python3 apps/www/scripts/apply_deterministic_backfill.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))

from location import parse_location  # noqa: E402

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

GAZETTEER = set()
for l in DETERMINISTIC + LLM_KNOWN:
    s = l.strip().lower()
    if s and s not in BUCKETS:
        GAZETTEER.add(s)


def is_canonical(value):
    if not value:
        return None
    v = value.strip().lower()
    return v if v in GAZETTEER else None


def main() -> None:
    path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/untagged.json"
    rows = json.load(open(path))

    to_tag = []  # (id, micro_market)
    for row in rows:
        signal = (row.get("location_label") or "").strip() or (row.get("landmark_name") or "").strip()
        if not signal:
            continue
        loc = parse_location(signal)
        mm = is_canonical(loc.micro_market) or is_canonical(loc.locality) or is_canonical(loc.city)
        if mm:
            to_tag.append((row["id"], mm.title()))

    print(f"Rows to tag: {len(to_tag)}")

    # Apply via PostgREST (service role). Use a minimal HTTP client to avoid
    # the broken python supabase package.
    import urllib.request
    from concurrent.futures import ThreadPoolExecutor

    headers = {
        "apikey": KEY,
        "Authorization": f"Bearer {KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }

    def patch(row_id_mm):
        row_id, mm = row_id_mm
        body = json.dumps({"micro_market": mm}).encode()
        req = urllib.request.Request(
            f"{URL}/rest/v1/listings?id=eq.{row_id}",
            data=body,
            headers=headers,
            method="PATCH",
        )
        urllib.request.urlopen(req)

    done = 0
    with ThreadPoolExecutor(max_workers=16) as ex:
        list(ex.map(patch, to_tag))
        done = len(to_tag)

    print(f"Tagged {done} rows. Remaining {len(rows) - done} left permanently untagged.")
    print("No LLM pass. Unmatched rows have no locality signal in source text.")


if __name__ == "__main__":
    main()
