"""
Read-only deterministic backfill dry-run.

Uses location.parse_location (with the alias map in location.py _LOCATION_ALIASES)
against a CLEANED canonical gazetteer (merged _COMMON_MUMBAI_LOCALITIES + LLM
Known micro_markets, buckets stripped). Reports match rate + unmatched samples.

NO database writes.

Run: python3 apps/www/scripts/backfill_deterministic_dryrun.py
"""
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
    "dadar", "powai", "versova", "vile parle", "chembur",     "mahalaxmi", "prabhadevi",
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


def is_canonical(value: str | None) -> str | None:
    if not value:
        return None
    v = value.strip().lower()
    return v if v in GAZETTEER else None


def main() -> None:
    path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/untagged.json"
    with open(path) as f:
        rows = __import__("json").load(f)
    print(f"Cleaned canonical gazetteer size: {len(GAZETTEER)} (buckets excluded: {len(BUCKETS)})")
    print(f"Loaded {len(rows)} untagged rows from {path}")

    total = matched = 0
    unmatched: list[str] = []
    by_loc: dict[str, int] = {}

    for row in rows:
        total += 1
        signal = (row.get("location_label") or "").strip() or (row.get("landmark_name") or "").strip()
        if not signal:
            if len(unmatched) < 25:
                unmatched.append(f"[id {row['id']}] (empty signal)")
            continue
        loc = parse_location(signal)
        hit = is_canonical(loc.micro_market) or is_canonical(loc.locality) or is_canonical(loc.city)
        if hit:
            matched += 1
            by_loc[hit] = by_loc.get(hit, 0) + 1
        elif len(unmatched) < 25:
            unmatched.append(f"[id {row['id']}] \"{signal[:70]}\"")

    rate = f"{(matched / total * 100):.1f}" if total else "0"
    print("\n=== DETERMINISTIC DRY-RUN (cleaned gazetteer, parse_location + aliases) ===")
    print(f"Untagged listings scanned : {total}")
    print(f"Matched (would be tagged) : {matched} ({rate}%)")
    print(f"Unmatched (review)        : {total - matched} ({100 - float(rate):.1f}%)")
    print("\nMatched breakdown:")
    for loc, n in sorted(by_loc.items(), key=lambda x: -x[1]):
        print(f"  {loc}: {n}")
    print(f"\nUnmatched samples (first {len(unmatched)}):")
    for s in unmatched:
        print(f"  - {s}")
    print("\nNO UPDATES PERFORMED.")


if __name__ == "__main__":
    main()
