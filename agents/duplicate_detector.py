"""Deterministic duplicate listing detector.

Same broker posts the same property across groups. While exact matches
are deduplicated by fingerprint, parser noise (e.g. "45K" vs "45000",
"3BHK 2T" vs "3 BHK 2 toilet") creates separate fingerprints.

This agent finds those near-misses and suggests merging.
Matching: same broker + same bhk + similar price.
"""

import json
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from lab.storage.sqlite import SqliteStorage


def check_for_duplicates(storage: "SqliteStorage", listing_id: int, parsed_id: int) -> None:
    row = storage.db.execute(
        """SELECT id, fingerprint, location_label, bhk, price, price_unit,
                  broker_name, observation_count, group_count
           FROM listings WHERE id = ?""",
        (listing_id,),
    ).fetchone()
    if not row:
        return

    bhk = row["bhk"] or ""
    broker = row["broker_name"] or ""
    price = row["price"]
    fingerprint = row["fingerprint"]
    label = (row["location_label"] or "").strip()

    if not bhk and not broker:
        return
    if not broker:
        return

    lo = 0
    hi = 10_000_000_000
    if price is not None:
        tol = max(price * 0.15, 5000)
        lo = price - tol
        hi = price + tol

    candidates = storage.db.execute(
        """SELECT id, fingerprint, location_label, bhk, price, price_unit,
                  broker_name, observation_count, group_count,
                  first_seen, last_seen
           FROM listings
           WHERE fingerprint != ?
             AND broker_name = ?
             AND bhk = ?
             AND (price IS NULL OR (price >= ? AND price <= ?))
           ORDER BY observation_count DESC
           LIMIT 10""",
        (fingerprint, broker, bhk, lo, hi),
    ).fetchall()

    if not candidates:
        return

    existing = storage.db.execute(
        """SELECT id FROM ai_suggestions
           WHERE agent = 'duplicate_listing'
             AND suggestion_type = 'merge'
             AND status IN ('pending', 'approved')
             AND source_data LIKE ?""",
        (f"%{fingerprint}%",),
    ).fetchone()
    if existing:
        return

    for cand in candidates:
        cand_fp = cand["fingerprint"]
        existing_pair = storage.db.execute(
            """SELECT id FROM ai_suggestions
               WHERE agent = 'duplicate_listing'
                 AND suggestion_type = 'merge'
                 AND status IN ('pending', 'approved')
                 AND (source_data LIKE ? OR source_data LIKE ?)""",
            (f"%{fingerprint}%", f"%{cand_fp}%"),
        ).fetchone()
        if existing_pair:
            continue

        combined_obs = row["observation_count"] + cand["observation_count"]
        confidence = min(0.95, 0.70 + combined_obs * 0.02)

        label_a = label or f"#{listing_id}"
        label_b = (cand["location_label"] or "").strip() or f"#{cand['id']}"

        title = f"Merge listing: {bhk} by {broker}"
        description = (
            f"Listings #{listing_id} ({row['observation_count']} posts, "
            f"'{label_a}') and #{cand['id']} ({cand['observation_count']} posts, "
            f"'{label_b}') share broker '{broker}' and BHK '{bhk}'. "
            f"Parser noise likely created separate fingerprints."
        )

        source_data = json.dumps({
            "listing_ids": [listing_id, cand["id"]],
            "fingerprints": [fingerprint, cand_fp],
            "broker": broker,
            "bhk": bhk,
            "price_a": price,
            "price_b": cand["price"],
            "label_a": label_a,
            "label_b": label_b,
        })

        proposal_data = json.dumps({
            "action": "merge_listings",
            "keep_id": cand["id"],
            "merge_id": listing_id,
        })

        from lab.storage.base import AISuggestion
        sug = AISuggestion(
            agent="duplicate_listing",
            suggestion_type="merge",
            title=title,
            description=description,
            source_data=source_data,
            proposal_data=proposal_data,
            confidence=confidence,
        )
        storage.create_suggestion(sug)
        break
