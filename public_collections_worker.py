"""Generate factual public listing collections from existing inventory.

No LLM, external search, or copied inventory is used here. A collection is a
deterministic slice over source-backed public listing rows and stores only typed
listing references plus reproducible reason codes.
"""
from __future__ import annotations

import logging
import os
import re
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

from storage import SupabaseStorage


WINDOW_DAYS = max(1, min(365, int(os.getenv("PUBLIC_COLLECTION_FRESHNESS_DAYS", "30"))))
POLL_SECONDS = max(60, int(os.getenv("PUBLIC_COLLECTION_WORKER_POLL_SECONDS", "900")))
MAX_ITEMS = max(3, min(24, int(os.getenv("PUBLIC_COLLECTION_MAX_ITEMS", "24"))))
MIN_ITEMS = max(2, min(10, int(os.getenv("PUBLIC_COLLECTION_MIN_ITEMS", "3"))))
RULE_VERSION = "market-slice-v1"


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")


def _transaction(row: dict[str, Any]) -> str | None:
    card = str(row.get("card_type") or "").lower()
    if card.endswith("_rent"):
        return "rent"
    if card.endswith("_sale"):
        return "sale"
    return None


def _bhk(row: dict[str, Any]) -> str | None:
    if not str(row.get("card_type") or "").startswith("residential_"):
        return None
    raw = str(row.get("bhk") or "").strip()
    match = re.match(r"^([1-9]|1[0-9])(?:\.5)?\s*BHK$", raw, re.I)
    return f"{match.group(1)} BHK" if match else None


def _freshness_score(row: dict[str, Any], now: datetime) -> float:
    try:
        seen = datetime.fromisoformat(str(row.get("last_seen")).replace("Z", "+00:00"))
        age = max(0.0, (now - seen).total_seconds() / 86400)
        return max(0.0, 1.0 - age / WINDOW_DAYS)
    except (TypeError, ValueError):
        return 0.0


def _score(row: dict[str, Any], now: datetime) -> tuple[float, list[str]]:
    reasons = []
    freshness = _freshness_score(row, now)
    if freshness >= 0.75:
        reasons.append("fresh_7d")
    elif freshness >= 0.25:
        reasons.append("fresh_30d")
    if row.get("building_name"):
        reasons.append("building_named")
    if row.get("price") is not None and float(row.get("price") or 0) > 0:
        reasons.append("price_available")
    if row.get("area_sqft") is not None:
        reasons.append("area_available")
    if row.get("bhk"):
        reasons.append("explicit_configuration")
    completeness = min(1.0, len(reasons) / 5)
    return round(freshness * 0.7 + completeness * 0.3, 6), reasons


def _load_rows(storage: Any, cutoff: str) -> list[dict[str, Any]]:
    fields = "card_type,id,summary_title,building_name,micro_market,canonical_micro_market_slug,bhk,price,price_model,area_sqft,furnishing,asset_type,last_seen"
    rows: list[dict[str, Any]] = []
    page_size = 1000
    for offset in range(0, 1_000_000, page_size):
        result = storage.client.table("listings_unified_public").select(fields).gte("last_seen", cutoff).lte("last_seen", datetime.now(timezone.utc).isoformat()).order("last_seen", desc=True).range(offset, offset + page_size - 1).execute()
        page = list(getattr(result, "data", None) or [])
        rows.extend(page)
        if len(page) < page_size:
            break
    return rows


def _candidate_buckets(rows: list[dict[str, Any]], now: datetime) -> dict[str, dict[str, Any]]:
    groups: dict[tuple[str, str, str | None], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        if not str(row.get("summary_title") or "").strip():
            continue
        locality = str(row.get("micro_market") or row.get("locality_resolved") or "").strip()
        locality_slug = str(row.get("canonical_micro_market_slug") or _slug(locality)).strip().lower()
        transaction = _transaction(row)
        if not locality_slug or not locality or not transaction:
            continue
        groups[(locality_slug, transaction, _bhk(row))].append(row)

    candidates: dict[str, dict[str, Any]] = {}
    for (locality_slug, transaction, bhk), grouped in groups.items():
        if len(grouped) < MIN_ITEMS:
            continue
        locality = str(grouped[0].get("micro_market") or grouped[0].get("locality_resolved") or locality_slug.replace("-", " ")).strip()
        label = f"{bhk + ' ' if bhk else ''}{'rentals' if transaction == 'rent' else 'sale inventory'} in {locality}"
        slug = _slug(f"fresh-{bhk or 'commercial'}-{transaction}-{locality_slug}")
        scored = []
        for row in grouped:
            score, reasons = _score(row, now)
            scored.append((score, str(row.get("last_seen") or ""), row, reasons))
        scored.sort(key=lambda item: (item[0], item[1]), reverse=True)
        selected = scored[:MAX_ITEMS]
        candidates[slug] = {
            "slug": slug,
            "title": f"Fresh {label}",
            "description": f"Source-backed {label}, captured from recent broker conversations.",
            "collection_type": "market_slice",
            "locality": locality,
            "transaction_type": transaction,
            "bhk": bhk,
            "listing_count": len(selected),
            "freshness_days": WINDOW_DAYS,
            "rule_version": RULE_VERSION,
            "items": [(rank, score, reasons, row) for rank, (score, _, row, reasons) in enumerate(selected, start=1)],
        }
    return candidates


def generate_once(storage: Any, now: datetime | None = None) -> dict[str, int]:
    current = now or datetime.now(timezone.utc)
    cutoff = (current - timedelta(days=WINDOW_DAYS)).isoformat()
    candidates = _candidate_buckets(_load_rows(storage, cutoff), current)
    existing = list(getattr(storage.client.table("public_listing_collections").select("id,slug").eq("collection_type", "market_slice").execute(), "data", None) or [])
    desired = set(candidates)
    archived = 0
    for row in existing:
        if row.get("slug") not in desired:
            storage.client.table("public_listing_collections").update({"status": "archived", "listing_count": 0, "updated_at": current.isoformat()}).eq("id", row["id"]).execute()
            archived += 1

    generated = 0
    item_count = 0
    for candidate in candidates.values():
        metadata = {key: candidate[key] for key in ("slug", "title", "description", "collection_type", "locality", "transaction_type", "bhk", "listing_count", "freshness_days", "rule_version")}
        metadata.update({"generated_at": current.isoformat(), "updated_at": current.isoformat(), "status": "published"})
        result = storage.client.table("public_listing_collections").upsert(metadata, on_conflict="slug").execute()
        saved = list(getattr(result, "data", None) or [])
        if not saved:
            saved = list(getattr(storage.client.table("public_listing_collections").select("id").eq("slug", candidate["slug"]).limit(1).execute(), "data", None) or [])
        if not saved:
            continue
        collection_id = saved[0]["id"]
        storage.client.table("public_listing_collection_items").delete().eq("collection_id", collection_id).execute()
        payload = [{"collection_id": collection_id, "listing_type": row.get("card_type"), "listing_id": row.get("id"), "rank": rank, "score": score, "reason_codes": reasons, "generated_at": current.isoformat()} for rank, score, reasons, row in candidate["items"] if row.get("card_type") and row.get("id") is not None]
        if payload:
            storage.client.table("public_listing_collection_items").insert(payload).execute()
            item_count += len(payload)
        generated += 1
    return {"collections_generated": generated, "items_written": item_count, "collections_archived": archived}


def main() -> None:
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper())
    storage = SupabaseStorage(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])
    logging.info("public collection worker started poll=%ss window=%sd", POLL_SECONDS, WINDOW_DAYS)
    while True:
        try:
            logging.info("public collection cycle: %s", generate_once(storage))
        except Exception:
            logging.exception("public collection cycle failed")
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
