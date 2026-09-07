#!/usr/bin/env python3
"""Read-only preview of deterministic repairs from the attached raw message.

The preview deliberately has no ``--apply`` switch.  It produces an exact,
rerunnable candidate set for a separately approved write operation.  A row is
eligible only when the shared locality resolver returns one reference ID and
the source contains an unambiguous price for the row's transaction type.
Ambiguous and unmatched rows are reported, never guessed.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
from collections import Counter
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from price_normalization import (  # noqa: E402
    canonical_commercial_rental_price_rupees,
    canonical_price_rupees,
    canonical_rental_price_rupees,
    parse_explicit_price,
    source_transaction_type_details,
)
from registry.locality_resolver import (  # noqa: E402
    LocalityResolver,
    meets_minimum,
    strip_external_links,
)
from storage.supabase import SupabaseStorage  # noqa: E402


TABLES = (
    "residential_rent_listings", "residential_sale_listings",
    "commercial_rent_listings", "commercial_sale_listings",
    "residential_rent_requirements", "residential_sale_requirements",
    "commercial_rent_requirements", "commercial_sale_requirements",
)
PAGE = 1000
_LABELLED_RENT = re.compile(
    r"(?<![A-Za-z0-9])(?:rent|rental|monthly\s+rent)\s*[:=\-]?\s*"
    r"(?:₹|rs\.?\s*)?(?P<amount>\d[\d,.]*)\s*"
    r"(?P<unit>cr(?:ore|ores)?|lac(?:s)?|lakh(?:s)?|l|k|thousand(?:s)?)?"
    r"(?![A-Za-z])", re.IGNORECASE,
)


def _empty(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def _snippet(text: str | None, limit: int = 220) -> str:
    value = strip_external_links(str(text or ""))
    value = re.sub(r"(?<!\d)(?:\+?\d[\d ()-]{7,}\d)(?!\d)", "[redacted]", value)
    return " ".join(value.split())[:limit]


def _rent_value(text: str) -> tuple[float | None, str | None]:
    match = _LABELLED_RENT.search(text or "")
    if not match:
        return None, None
    try:
        amount = float(match.group("amount").replace(",", ""))
    except (TypeError, ValueError):
        return None, None
    unit = str(match.group("unit") or "").lower().rstrip("s") or "abs"
    return amount, match.group(0).strip()


def _source_price(table: str, text: str) -> tuple[float | None, str | None, str | None]:
    tx = "rent" if "_rent_" in table else "sale"
    evidence = source_transaction_type_details(text, tx)
    if not evidence["exclusive"] or evidence["disagreement"] or evidence["mixed"]:
        return None, None, "mixed_or_nonexclusive_transaction_evidence"
    if tx == "rent":
        amount, matched_text = _rent_value(text)
        if amount is None or matched_text is None:
            return None, None, None
        unit_match = re.search(
            r"(cr(?:ore|ores)?|lac(?:s)?|lakh(?:s)?|l|k|thousand(?:s)?)\b",
            matched_text, re.IGNORECASE,
        )
        unit = unit_match.group(1).lower().rstrip("s") if unit_match else "abs"
        if table.startswith("commercial_"):
            value = canonical_commercial_rental_price_rupees(amount, unit, text)
        else:
            value = canonical_rental_price_rupees(amount, unit, text)
        # A unitless tiny number is not a safe rent amount; it is commonly a
        # typo, a ratio, or a fragment of another fact.
        if unit == "abs" and value is not None and value < 5_000:
            return None, None, None
        return value, matched_text, None
    explicit = parse_explicit_price(text)
    if not explicit:
        return None, None, None
    amount, unit = explicit
    return canonical_price_rupees(amount, unit), f"{amount:g} {unit}", None


def _locality(resolver: LocalityResolver, row: dict, message: str) -> dict | None:
    result = resolver.resolve_from_text(message)
    if result and result.get("locality_id") is not None:
        return {**result, "source_detail": "raw_message:text_reference_match"}
    # Building fallback is allowed only if it maps to one locality-reference
    # ID. A market label without a unique ID is not safe enough to persist.
    building = resolver.resolve_from_building(row.get("building_name"))
    if building:
        locality_id = resolver._locality_id_for_market(building.get("resolved_locality"))
        if locality_id is not None:
            return {
                **building,
                "locality_id": locality_id,
                "source_detail": "raw_message:building_reference",
            }
    return None


def _stale_locality_flags(value: Any) -> list[str]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (TypeError, ValueError):
            value = [value]
    return [str(flag) for flag in (value or []) if str(flag) in {
        "locality_unresolved", "locality_resolution_ambiguous",
        "building_places_locality_ambiguous",
    }]


def run(output: str, batch_size: int = PAGE, minimum: str = "medium") -> Counter:
    storage = SupabaseStorage()
    db = storage.client
    resolver = LocalityResolver(db)
    counts: Counter = Counter()
    base_fields = (
        "id,tenant_id,raw_message_id,building_name,locality_id,locality_raw,"
        "locality_resolved,micro_market,locality_match_status,validation_flags,"
        "needs_review,transaction_type"
    )
    with open(output, "w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=[
            "table", "id", "tenant_id", "raw_message_id", "action",
            "old_locality_id", "new_locality_id", "old_locality",
            "new_locality", "locality_source", "locality_confidence",
            "old_price", "new_price", "price_source", "reason",
            "raw_message_snippet",
        ])
        writer.writeheader()
        for table in TABLES:
            fields = base_fields
            if table == "residential_rent_listings" or table == "commercial_rent_listings":
                fields += ",monthly_rent"
            elif table == "residential_sale_listings" or table == "commercial_sale_listings":
                fields += ",total_asking_price"
            offset = 0
            while True:
                rows = db.table(table).select(fields).order("id").offset(offset).limit(batch_size).execute().data or []
                if not rows:
                    break
                raw_ids = [row["raw_message_id"] for row in rows if row.get("raw_message_id")]
                raw_rows = db.table("raw_messages").select("id,message").in_("id", raw_ids).execute().data or []
                raw_map = {item["id"]: item.get("message") or "" for item in raw_rows}
                for row in rows:
                    message = raw_map.get(row.get("raw_message_id"), "")
                    loc = None if not _empty(row.get("locality_id")) else _locality(resolver, row, message)
                    price_field = "monthly_rent" if "_rent_" in table and "_listings" in table else "total_asking_price"
                    price = None
                    price_text = None
                    price_reason = None
                    if "_listings" in table and _empty(row.get(price_field)):
                        price, price_text, price_reason = _source_price(table, message)
                    if loc and not meets_minimum(loc.get("confidence"), minimum):
                        loc = None
                        counts["locality_below_minimum"] += 1
                    if loc:
                        counts["locality_candidates"] += 1
                        stale_flags = _stale_locality_flags(row.get("validation_flags"))
                        writer.writerow({
                            "table": table, "id": row["id"], "tenant_id": row.get("tenant_id"),
                            "raw_message_id": row.get("raw_message_id"), "action": "set_locality_fields",
                            "old_locality_id": row.get("locality_id"), "new_locality_id": loc["locality_id"],
                            "old_locality": row.get("locality_resolved") or row.get("micro_market"),
                            "new_locality": loc.get("resolved_locality"), "locality_source": loc.get("source_detail"),
                            "locality_confidence": loc.get("confidence"), "old_price": "", "new_price": "",
                            "price_source": "", "reason": "unique raw-message locality reference; remove flags=" + ",".join(stale_flags),
                            "raw_message_snippet": _snippet(message),
                        })
                    if price is not None:
                        counts["price_candidates"] += 1
                        writer.writerow({
                            "table": table, "id": row["id"], "tenant_id": row.get("tenant_id"),
                            "raw_message_id": row.get("raw_message_id"), "action": f"set_{price_field}",
                            "old_locality_id": "", "new_locality_id": "", "old_locality": "", "new_locality": "",
                            "locality_source": "", "locality_confidence": "", "old_price": row.get(price_field),
                            "new_price": price, "price_source": price_text, "reason": "explicit source price",
                            "raw_message_snippet": _snippet(message),
                        })
                    if not loc:
                        counts["locality_unresolved"] += 1
                    if price_reason:
                        counts[f"price_{price_reason}"] += 1
                offset += len(rows)
                if len(rows) < batch_size:
                    break
    return counts


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="source_attached_repairs_preview.csv")
    parser.add_argument("--batch-size", type=int, default=PAGE)
    parser.add_argument("--min-confidence", default="medium")
    args = parser.parse_args()
    print(dict(run(args.output, args.batch_size, args.min_confidence)))
