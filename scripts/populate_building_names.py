"""Batch populate parsed_output.building_name from building_name_aliases.

Uses word-index for O(n) matching instead of O(n*m) regex scan.
"""

import sys
import os
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lab.storage import SqliteStorage

BLACKLIST = {
    "park", "and", "the", "one", "new", "old", "flat", "wing", "block",
    "phase", "tower", "royal", "apartment", "enclave", "heights", "garden",
    "lake", "sai", "shree", "kings", "exclusive", "arsha", "continental",
    "supreme", "imperial", "solitaire", "vista", "capital", "opera",
    "crest", "anand", "magnus", "laxmi", "abhishek", "spring", "bunglow",
    "lodha", "oberoi", "kiran", "surabhi", "ram",
}

MIN_ALIAS_LEN = 4


def populate_building_names(dry_run: bool = False):
    storage = SqliteStorage("lab.db")

    aliases = storage.db.execute(
        "SELECT alias, canonical_name FROM building_name_aliases"
    ).fetchall()

    filtered = [
        (a["alias"], a["canonical_name"])
        for a in aliases
        if a["alias"].lower() not in BLACKLIST and len(a["alias"]) >= MIN_ALIAS_LEN
    ]
    filtered.sort(key=lambda x: -len(x[0]))

    # Build first-word index for fast lookup
    word_index: dict[str, list[tuple[str, str]]] = {}
    for alias, canonical in filtered:
        first_word = alias.split()[0].lower()
        if first_word not in word_index:
            word_index[first_word] = []
        word_index[first_word].append((alias, canonical))

    print(f"Loaded {len(aliases)} aliases, {len(filtered)} usable, {len(word_index)} first-words")

    rows = storage.db.execute("""
        SELECT p.id, p.location_raw, p.building_name, r.message
        FROM parsed_output p
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE (p.building_name IS NULL OR p.building_name = '')
        ORDER BY p.id
    """).fetchall()

    print(f"Found {len(rows)} observations without building_name")

    updated = 0
    matched = 0
    t0 = time.time()

    for i, row in enumerate(rows):
        text = f"{row['location_raw'] or ''} {row['message'] or ''}"
        text_lower = text.lower()

        best = None
        best_len = 0

        for w in text_lower.split():
            w_clean = w.strip(".,!?;:\"'()")
            if w_clean in word_index:
                for alias, canonical in word_index[w_clean]:
                    if len(alias) > best_len and alias in text_lower:
                        best = canonical
                        best_len = len(alias)

        if best:
            matched += 1
            if not dry_run:
                storage.db.execute(
                    "UPDATE parsed_output SET building_name = ? WHERE id = ?",
                    (best, row["id"]),
                )
                updated += 1
                if updated % 1000 == 0:
                    storage._commit()
                    elapsed = time.time() - t0
                    rate = (i + 1) / elapsed
                    print(f"  Updated {updated} ({rate:.0f}/s)...")

    if not dry_run:
        storage._commit()

    elapsed = time.time() - t0
    print(f"\nDone in {elapsed:.1f}s")
    print(f"  Matched: {matched}")
    print(f"  Updated: {updated}")
    print(f"  Dry run: {dry_run}")

    if not dry_run:
        result = storage.db.execute("""
            SELECT COUNT(*) FROM parsed_output
            WHERE building_name IS NOT NULL AND building_name != ''
        """).fetchone()
        print(f"  Total with building_name: {result[0]}")

        top = storage.db.execute("""
            SELECT building_name, COUNT(*) as cnt
            FROM parsed_output
            WHERE building_name IS NOT NULL AND building_name != ''
            GROUP BY building_name
            ORDER BY cnt DESC
            LIMIT 20
        """).fetchall()
        print("\n  Top 20 building names:")
        for r in top:
            print(f"    {r[1]:5d}  {r[0]}")

    storage.close()


if __name__ == "__main__":
    dry_run = "--dry-run" in sys.argv
    populate_building_names(dry_run=dry_run)
