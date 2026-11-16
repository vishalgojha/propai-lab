"""Account-free, public read-only surface for client-side agents (Instinct, MCP connectors).

These routes serve exactly the data the public website renders: rows from the
`listings_unified_public` view, which is gated in SQL to shared-market rows
sourced from publication-allowlisted WhatsApp groups
(supabase/migrations/20261113110000_instinct_connection_publication_gate.sql).

There are no accounts, API keys or tenant context on this surface, so there is
no path from here to workspace-private data. Broker phone numbers are never
returned; the listing's public page is the contact route (it hands off to the
broker on WhatsApp without exposing the number). Request bursts are bounded by
the app-level rate-limit middleware in app.py.
"""
import logging
import os
import re

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import PlainTextResponse

from routers.common import storage
from routers.protection import bounded_page

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/public/v1", tags=["public_agent"])

PUBLIC_WWW_URL = os.environ.get("PUBLIC_WWW_URL", "https://www.propai.live").rstrip("/")

# Public-safe projection of the listings_unified_public view. The view grants
# SELECT to anon and carries no phone numbers; keep it that way - never add
# contact fields here.
PUBLIC_LISTING_COLUMNS = (
    "card_type,id,summary_title,building_name,micro_market,location_label,"
    "locality_resolved,bhk,area_sqft,price,price_unit,price_model,furnishing,"
    "asset_type,property_type,intent,transaction_type,deal_tags,"
    "first_seen,last_seen,observation_count,broker_name"
)

# Mirrors the title portion of the website's isPublicListingEligible gate
# (apps/www/src/lib/public-eligibility.ts). The payload-dependent checks
# (public_eligible flag, commercial-conflict heuristic) need the raw payload,
# which the public projection deliberately does not expose; on the website
# those checks already no-op for projection rows.
_PLACEHOLDER_TITLE = re.compile(r"^\[(?:unstructured|unknown|listing)\]", re.IGNORECASE)

PUBLIC_AGENT_DOCS = """PropAI public listings API (account-free, read-only)

Base URL: https://api.propai.live/api/public/v1

This API serves the same public, shared-market listings shown on
https://www.propai.live - inventory extracted from public Mumbai broker
WhatsApp networks. No account or API key is required. It never returns
workspace-private data and never returns broker phone numbers.

Endpoints:

GET /listings/search
  Query params (all optional):
    q                free text matched against building, locality and title
    locality         e.g. "Bandra West", "BKC", "Khar"
    bhk              numeric, e.g. 2 or 3.5
    transaction_type "rent" or "sale"
    budget_min       minimum price in INR (monthly rent for rent, total for sale)
    budget_max       maximum price in INR
    furnishing       e.g. "furnished", "semi"
    limit            1-50, default 20
    offset           pagination offset, default 0
  Returns: { results: [...], count, offset, limit }

GET /listings/{listing_id}
  Returns the full public detail for one listing. If the id is ambiguous
  across card types, every match is returned with its card_type.

Each result includes:
  summary_title, building_name, micro_market, bhk, area_sqft, price (+unit),
  furnishing, transaction_type, first_seen, last_seen, broker_name, and
  public_url - the listing's page on www.propai.live.

Contacting a broker: open the listing's public_url and use its WhatsApp
button. The site hands the enquiry to the broker without exposing their
number; phone numbers are intentionally not part of this API.

Freshness: listings are ordered by last_seen (most recently observed first).
Inventory older than 30 days leaves the public market view.

Rate limits: requests are rate-limited per caller (search endpoints currently
60 requests/minute; 429 responses carry Retry-After). Cache results where you
can and prefer specific queries over broad paging.

Example:
  curl "https://api.propai.live/api/public/v1/listings/search?locality=Bandra%20West&bhk=2&transaction_type=rent&budget_max=150000"
"""


def _title_eligible(row: dict) -> bool:
    title = str(row.get("summary_title") or "").strip()
    return bool(title) and not _PLACEHOLDER_TITLE.match(title)


def _to_public_listing(row: dict) -> dict:
    listing_id = row.get("id")
    return {
        "id": listing_id,
        "card_type": row.get("card_type"),
        "title": row.get("summary_title"),
        "building_name": row.get("building_name"),
        "micro_market": row.get("micro_market"),
        "location_label": row.get("location_label") or row.get("micro_market") or row.get("locality_resolved"),
        "bhk": row.get("bhk"),
        "area_sqft": row.get("area_sqft"),
        "price": row.get("price"),
        "price_unit": row.get("price_unit"),
        "price_model": row.get("price_model"),
        "furnishing": row.get("furnishing"),
        "asset_type": row.get("asset_type"),
        "property_type": row.get("property_type"),
        "intent": row.get("intent"),
        "transaction_type": row.get("transaction_type"),
        "deal_tags": row.get("deal_tags") or [],
        "first_seen": row.get("first_seen"),
        "last_seen": row.get("last_seen"),
        "observation_count": row.get("observation_count"),
        "broker_name": row.get("broker_name"),
        "public_url": f"{PUBLIC_WWW_URL}/listings/{listing_id}/{listing_id}",
        "contact": "Open public_url and use the WhatsApp button to reach the broker. Broker phone numbers are not exposed by this API.",
    }


def _ilike_or(columns: list[str], value: str) -> str:
    escaped = value.replace("%", "").replace(",", " ").strip()
    return ",".join(f"{col}.ilike.%{escaped}%" for col in columns)


@router.get("/docs", response_class=PlainTextResponse)
async def public_docs():
    """Public bootstrap guide for agents; contains instructions only, never listing data."""
    return PlainTextResponse(PUBLIC_AGENT_DOCS, headers={"Cache-Control": "public, max-age=300"})


@router.get("/listings/search")
async def public_listing_search(
    q: str = "",
    locality: str = "",
    bhk: float | None = None,
    transaction_type: str = "",
    budget_min: int | None = None,
    budget_max: int | None = None,
    furnishing: str = "",
    limit: int = Query(20, ge=1, le=50),
    offset: int = Query(0, ge=0),
):
    limit, offset = bounded_page(limit, offset, maximum=50)
    try:
        query = storage.client.table("listings_unified_public").select(PUBLIC_LISTING_COLUMNS)
        if q.strip():
            query = query.or_(_ilike_or(["building_name", "micro_market", "location_label", "summary_title"], q))
        if locality.strip():
            query = query.or_(_ilike_or(["micro_market", "location_label", "locality_resolved", "building_name"], locality))
        if bhk is not None:
            query = query.eq("bhk", bhk)
        if transaction_type.strip().lower() in {"rent", "sale"}:
            query = query.eq("transaction_type", transaction_type.strip().lower())
        if budget_min is not None:
            query = query.gte("price", budget_min)
        if budget_max is not None:
            query = query.lte("price", budget_max)
        if furnishing.strip():
            query = query.ilike("furnishing", f"%{furnishing.strip()}%")
        result = query.order("last_seen", desc=True).limit(limit * 2).offset(offset).execute()
    except Exception as exc:
        logger.exception("Public listing search failed; error_type=%s", type(exc).__name__)
        raise HTTPException(503, "Public listing search is temporarily unavailable") from exc
    rows = [row for row in (result.data or []) if _title_eligible(row)][:limit]
    return {
        "results": [_to_public_listing(row) for row in rows],
        "count": len(rows),
        "offset": offset,
        "limit": limit,
    }


@router.get("/listings/{listing_id}")
async def public_listing_detail(listing_id: int, card_type: str = ""):
    try:
        query = storage.client.table("listings_unified_public").select(PUBLIC_LISTING_COLUMNS).eq("id", listing_id)
        if card_type.strip():
            query = query.eq("card_type", card_type.strip())
        result = query.limit(8).execute()
    except Exception as exc:
        logger.exception("Public listing detail failed; error_type=%s", type(exc).__name__)
        raise HTTPException(503, "Public listing lookup is temporarily unavailable") from exc
    rows = [row for row in (result.data or []) if _title_eligible(row)]
    if not rows:
        raise HTTPException(404, "Listing not found in the public market view")
    return {"results": [_to_public_listing(row) for row in rows], "count": len(rows)}
