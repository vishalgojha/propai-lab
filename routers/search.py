"""
Search routes — text search, raw FTS, sender/group filtered search, market search.
"""
import asyncio
import logging
import os
import re
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from routers.common import storage, require_user, get_tenant_context
from routers.protection import TTLCache, bounded_page

router = APIRouter(tags=["search"])

_logger = logging.getLogger(__name__)
_query_parse_cache = TTLCache(
    max_entries=int(os.getenv("PROPAI_SEARCH_PARSE_CACHE_ENTRIES", "512")),
    ttl_seconds=float(os.getenv("PROPAI_SEARCH_PARSE_CACHE_SECONDS", "60")),
)


class ParsedQuery(BaseModel):
    query: str
    bhk: Optional[int] = None
    intent: Optional[str] = None
    asset: Optional[str] = None
    minPrice: Optional[int] = None
    maxPrice: Optional[int] = None
    furnishing: Optional[str] = None
    locality: Optional[str] = None
    localities: list[str] = []
    building: Optional[str] = None
    broker: Optional[str] = None


_LOCALITY_NAMES = [
    "bandra", "andheri", "goregaon", "juhu", "powai", "khar", "chembur",
    "thane", "navi", "mumbai", "delhi", "bangalore", "bengaluru", "hyderabad",
    "pune", "chennai", "kolkata", "gurgaon", "gurugram", "noida", "borivali",
    "kandivali", "parel", "worli", "dadar", "santacruz", "vashi", "malad",
]

def _extract_localities(query: str) -> list[str]:
    lower = query.lower()
    localities = []
    between_match = re.search(r'\bbetween\s+(\w+)\s+(?:and|to)\s+(\w+)', lower)
    if between_match:
        first, second = between_match.group(1), between_match.group(2)
        for loc in _LOCALITY_NAMES:
            if loc.startswith(first) or loc.startswith(second):
                if loc not in localities:
                    localities.append(loc)
        if len(localities) >= 2:
            return localities[:4]
    for loc in _LOCALITY_NAMES:
        pattern = rf'\b{loc}\b'
        if re.search(pattern, lower):
            if loc not in localities:
                localities.append(loc)
    return localities[:4]


def _parse_price(text: str) -> tuple[Optional[int], Optional[int]]:
    text = text.lower()
    min_val = None
    max_val = None
    range_match = re.search(r'(\d+(?:\.\d+)?)\s*(?:to|and|-)\s*(\d+(?:\.\d+)?)\s*(?:l(?:akh)?|cr)', text)
    if range_match:
        first = int(float(range_match.group(1)) * (100000 if 'l' in range_match.group(0) else 10000000))
        second = int(float(range_match.group(2)) * (100000 if 'l' in range_match.group(0) else 10000000))
        min_val = min(first, second)
        max_val = max(first, second)
        return min_val, max_val
    lakh_match = re.search(r'(\d+(?:\.\d+)?)\s*l(?:akh)?', text)
    if lakh_match:
        val = int(float(lakh_match.group(1)) * 100000)
        prefix = text[max(0, lakh_match.start() - 18):lakh_match.start()]
        if re.search(r'\b(?:under|below|upto|up\s+to|max(?:imum)?)\s*$', prefix):
            max_val = val
        elif re.search(r'\b(?:above|over|min(?:imum)?|from)\s*$', prefix):
            min_val = val
        else:
            min_val = max_val = val
    crore_match = re.search(r'(\d+(?:\.\d+)?)\s*cr', text)
    if crore_match:
        val = int(float(crore_match.group(1)) * 10000000)
        prefix = text[max(0, crore_match.start() - 18):crore_match.start()]
        if re.search(r'\b(?:under|below|upto|up\s+to|max(?:imum)?)\s*$', prefix):
            min_val = None
            max_val = val
        elif re.search(r'\b(?:above|over|min(?:imum)?|from)\s*$', prefix):
            min_val = val
            max_val = None
        elif min_val is None:
            min_val = max_val = val
    return min_val, max_val


def _parse_query_simple(query: str) -> ParsedQuery:
    parsed = ParsedQuery(query=query)
    lower = query.lower()
    bhk_match = re.search(r'(\d+(?:\.\d+)?)\s*(?:bhk|bedrooms?|beds?)', lower)
    if bhk_match:
        parsed.bhk = int(float(bhk_match.group(1)))
    if re.search(r'\b(rent|rental|lease)\b', lower):
        parsed.intent = "rent"
    elif re.search(r'\b(sale|sell|buy|purchase)\b', lower):
        parsed.intent = "sale"
    if re.search(r'\b(commercial|office|shop|showroom|warehouse|retail)\b', lower):
        parsed.asset = "commercial"
    if re.search(r'\b(residential|apartment|flat|house)\b', lower):
        parsed.asset = "residential"
    if re.search(r'\b(unfurnished)\b', lower):
        parsed.furnishing = "unfurnished"
    elif re.search(r'\b(fully\s+furnished|ff|furnished)\b', lower):
        parsed.furnishing = "furnished"
    elif re.search(r'\b(semi\s+furnished|sf)\b', lower):
        parsed.furnishing = "semi_furnished"
    min_p, max_p = _parse_price(query)
    parsed.minPrice = min_p
    parsed.maxPrice = max_p
    localities = _extract_localities(query)
    parsed.localities = localities
    if localities:
        parsed.locality = localities[0]
    return parsed


async def _parse_query_llm(query: str) -> Optional[ParsedQuery]:
    try:
        from llm import get_fast_client, get_fast_model, get_fast_provider_name
        client = get_fast_client()
        model = get_fast_model()
        prompt = f"""
Parse this Mumbai real estate search query into structured JSON:

Query: "{query}"

Return JSON with: bhk (number or null), intent ("rent"|"sale"|null), minPrice (rupees or null), maxPrice (rupees or null), locality (city/area or null), localities (array of city/area names, for "between X and Y" patterns), building (complex name or null), furnishing (null|"unfurnished"|"semi_furnished"|"fully_furnished"), asset (null|"residential"|"commercial").

Rules:
- Extract explicit values only, don't infer
- Convert rupees: 1 Lakh = 100,000, 1 Crore = 10,000,000
- Locality: extract city/area names like Bandra, Andheri, Powai, etc.
- For "between X and Y" locality patterns, return both in localities array
- Building: extract society/complex names like "Kalpataru", "Prestige", etc.

Query: "{query}"
JSON:"""
        resp = client.chat.completions.create(model=model, messages=[{"role": "user", "content": prompt}], max_tokens=500, temperature=0)
        content = (resp.choices[0].message.content or "").strip()
        import json
        if content.startswith("```"):
            content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content, flags=re.IGNORECASE)
        parsed = json.loads(content)
        result = ParsedQuery(query=query, **parsed)
        # Keep deterministic extraction as a safety net when the provider
        # omits an explicit bedroom/BHK mention from otherwise valid JSON.
        simple = _parse_query_simple(query)
        if result.bhk is None:
            result.bhk = simple.bhk
        if result.intent is None:
            result.intent = simple.intent
        if result.minPrice is None:
            result.minPrice = simple.minPrice
        if result.maxPrice is None:
            result.maxPrice = simple.maxPrice
        if result.locality is None:
            result.locality = simple.locality
        if not result.localities:
            result.localities = simple.localities
        if not result.localities and result.locality:
            result.localities = [result.locality] if result.locality else []
        if result.localities:
            result.locality = result.localities[0]
        return result
    except Exception as e:
        _logger.warning("LLM query parsing failed: %s", str(e)[:100])
        return None


@router.get("/api/search/parse")
async def parse_query(q: str = ""):
    if not q:
        return ParsedQuery(query="").model_dump()
    q = q.strip()
    cache_key = q.casefold()
    cached = _query_parse_cache.get(cache_key)
    if cached is not None:
        return cached
    parsed = await _parse_query_llm(q)
    if not parsed:
        parsed = _parse_query_simple(q)
    payload = parsed.model_dump()
    _query_parse_cache.set(cache_key, payload)
    return payload


def _search_value(row: dict, *keys: str) -> str:
    return " ".join(str(row.get(key) or "") for key in keys).casefold()


@router.get("/api/search/market-items")
async def search_market_items(
    q: str,
    result_type: str = "all",
    limit: int = 50,
    offset: int = 0,
    user: dict = Depends(require_user),
):
    """Search typed listings and requirements using a free-form query.

    The Market Inbox timeline is intentionally bounded, so searching that
    browser-side page can never be complete. This endpoint parses the query
    into real-estate filters and searches a wider typed-data window instead.
    """
    query = str(q or "").strip()
    if len(query) < 2:
        return {"items": [], "total": 0, "query": query, "parsed": {}}
    if result_type not in {"all", "listings", "requirements"}:
        raise HTTPException(422, "result_type must be all, listings, or requirements")

    cache_key = query.casefold()
    parsed_payload = _query_parse_cache.get(cache_key)
    if parsed_payload is None:
        parsed = await _parse_query_llm(query) or _parse_query_simple(query)
        parsed_payload = parsed.model_dump()
        _query_parse_cache.set(cache_key, parsed_payload)
    parsed = ParsedQuery(**parsed_payload)

    requirement_filter = (
        True if result_type == "requirements"
        else False if result_type == "listings"
        else None
    )
    rows = await asyncio.to_thread(
        storage._fetch_typed_rows,
        requirements=requirement_filter,
        all_tenants=True,
        limit_per_table=500,
        card_only=True,
    )

    intent = str(parsed.intent or "").casefold()
    asset = str(parsed.asset or "").casefold()
    localities = [str(value).casefold() for value in (parsed.localities or []) if value]
    if parsed.locality and parsed.locality.casefold() not in localities:
        localities.append(parsed.locality.casefold())
    building = str(parsed.building or "").casefold()
    furnishing = str(parsed.furnishing or "").casefold().replace("_", " ")
    ignored_terms = {
        "a", "an", "and", "or", "the", "for", "in", "at", "near", "between",
        "to", "from", "under", "below", "above", "over", "up", "upto", "max",
        "minimum", "maximum", "bhk", "bed", "beds", "bedroom", "bedrooms",
        "rent", "rental", "lease", "sale", "sell", "buy", "purchase", "property",
        "properties", "listing", "listings", "requirement", "requirements", "lakh",
        "lakhs", "crore", "crores", "cr", "residential", "commercial", "office",
        "flat", "apartment", "furnished", "unfurnished", "semi", "fully",
    }
    structured_values = {
        *(value for locality in localities for value in locality.split()),
        *(building.split() if building else []),
    }
    residual_terms = [
        token for token in re.findall(r"[a-z0-9]+", query.casefold())
        if token not in ignored_terms
        and token not in structured_values
        and not re.fullmatch(r"\d+(?:\.\d+)?", token)
    ]

    matches: list[dict] = []
    for typed in rows:
        table = str(typed.get("_typed_table") or "")
        if str(typed.get("visibility") or "").casefold() == "workspace_private":
            continue
        if asset and not table.startswith(f"{asset}_"):
            continue
        transaction = str(typed.get("transaction_type") or "").casefold()
        if intent and transaction != intent:
            continue
        if parsed.bhk is not None:
            wanted_bhk = float(parsed.bhk)
            options = typed.get("bhk_options")
            if not isinstance(options, (list, tuple)):
                options = []
            candidates = [typed.get("bhk"), *options]
            try:
                if not any(float(value) == wanted_bhk for value in candidates if value is not None):
                    continue
            except (TypeError, ValueError):
                continue
        locality_text = _search_value(
            typed, "micro_market", "locality_raw", "locality_resolved", "locality_options"
        )
        # A corridor query means either endpoint/locality is useful inventory;
        # requiring every locality on one row would incorrectly return zero.
        if localities and not any(locality in locality_text for locality in localities):
            continue
        searchable = _search_value(
            typed, "summary_title", "building_name", "micro_market", "locality_raw",
            "locality_resolved", "locality_options", "broker_name", "commercial_use_type",
            "property_type", "furnishing", "furnishing_preference",
        )
        if building and building not in searchable:
            continue
        if furnishing and furnishing not in searchable:
            continue
        if residual_terms and not all(term in searchable for term in residual_terms):
            continue

        legacy = storage._typed_row_to_legacy(typed)
        price = legacy.get("price") or typed.get("budget_max") or typed.get("budget_min") or 0
        try:
            numeric_price = float(price or 0)
        except (TypeError, ValueError):
            numeric_price = 0
        if parsed.minPrice is not None and numeric_price < parsed.minPrice:
            continue
        if parsed.maxPrice is not None and numeric_price > parsed.maxPrice:
            continue

        legacy["source_schema"] = table
        legacy["_typed_table"] = table
        legacy["observation_type"] = "REQUIREMENT" if table.endswith("_requirements") else "LISTING"
        legacy["latest_parsed_id"] = typed.get("id")
        legacy["latest_raw_message_id"] = typed.get("raw_message_id")
        legacy["first_seen"] = typed.get("created_at")
        legacy["last_seen"] = typed.get("last_seen_at") or typed.get("updated_at") or typed.get("created_at")
        matches.append(legacy)

    matches.sort(key=lambda row: str(row.get("last_seen") or row.get("created_at") or ""), reverse=True)
    safe_limit = min(max(int(limit or 50), 1), 100)
    safe_offset = max(int(offset or 0), 0)
    return {
        "items": matches[safe_offset:safe_offset + safe_limit],
        "total": len(matches),
        "query": query,
        "parsed": parsed.model_dump(),
    }


@router.get("/api/search")
async def search_messages(q: str = "", use_llm: bool = False):
    if not q:
        return []
    q = q.strip()
    parsed = None
    if use_llm:
        parsed = await _parse_query_llm(q)
    if not parsed:
        parsed = _parse_query_simple(q)
    like_q = f"%{q}%"
    result = {"listings": [], "requirements": [], "brokers": [], "buildings": [], "markets": [], "messages": []}
    try:
        try:
            where_clause = "broker_name ILIKE ? OR building_name ILIKE ? OR micro_market ILIKE ?"
            params = [like_q] * 3
            if parsed.bhk:
                where_clause += " OR bhk = ?"
                params.append(parsed.bhk)
            if parsed.intent:
                where_clause += " OR intent = ?"
                params.append(parsed.intent.upper())
            if parsed.minPrice or parsed.maxPrice:
                where_clause += " OR price IS NOT NULL"
            result["listings"] = [dict(r) for r in storage.db.execute(f"""
                SELECT fingerprint, intent, bhk, price, price_unit, area_sqft, furnishing,
                       location_label, building_name, landmark_name, micro_market,
                       broker_name, broker_phone, observation_count, last_seen
                FROM listings_unified
                WHERE {where_clause}
                ORDER BY observation_count DESC
                LIMIT 8
            """, params).fetchall()]
        except Exception:
            result["listings"] = []
        try:
            result["requirements"] = [dict(r) for r in storage.db.execute("""
                SELECT p.id, p.intent, p.bhk, p.price, p.price_unit, p.broker_name, p.broker_phone,
                       p.micro_market, p.location_raw, p.created_at, r.message, r.group_name
                FROM parsed_output_unified p
                JOIN raw_messages r ON r.id = p.raw_message_id
                WHERE p.intent IN ('BUY','RENTAL_SEEKER')
                  AND (
                    to_tsvector('english', COALESCE(r.message, '')) @@ plainto_tsquery('english', ?)
                    OR p.broker_name ILIKE ? OR p.micro_market ILIKE ?
                    OR p.bhk ILIKE ? OR p.location_raw ILIKE ?
                  )
                ORDER BY p.id DESC
                LIMIT 6
            """, [q, like_q, like_q, like_q, like_q]).fetchall()]
        except Exception:
            result["requirements"] = []
        try:
            result["brokers"] = [dict(r) for r in storage.db.execute("""
                SELECT id, canonical_name AS name, primary_phone AS phone,
                       observation_count, listing_count, requirement_count,
                       group_count, market_count, avg_ticket
                FROM brokers
                WHERE canonical_name ILIKE ? OR primary_phone ILIKE ?
                ORDER BY observation_count DESC
                LIMIT 6
            """, [like_q, like_q]).fetchall()]
        except Exception:
            result["brokers"] = []
        try:
            result["buildings"] = [dict(r) for r in storage.db.execute("""
                SELECT DISTINCT rd.building_name AS name, p.micro_market,
                       COUNT(*) AS occurrence_count,
                       COUNT(DISTINCT p.broker_name) AS broker_count
                FROM resolver_decisions rd
                LEFT JOIN parsed_output_unified p ON p.id = rd.parsed_id
                WHERE rd.building_name IS NOT NULL AND rd.building_name != ''
                  AND rd.building_name ILIKE ?
                GROUP BY rd.building_name
                ORDER BY occurrence_count DESC
                LIMIT 6
            """, [like_q]).fetchall()]
        except Exception:
            result["buildings"] = []
        try:
            result["markets"] = [dict(r) for r in storage.db.execute("""
                SELECT micro_market, COUNT(*) AS observation_count,
                       COUNT(DISTINCT building_name) AS building_count,
                       COUNT(DISTINCT broker_name) AS broker_count
                FROM parsed_output_unified
                WHERE micro_market IS NOT NULL AND micro_market != ''
                  AND micro_market ILIKE ?
                GROUP BY micro_market
                ORDER BY observation_count DESC
                LIMIT 6
            """, [like_q]).fetchall()]
        except Exception:
            result["markets"] = []
        try:
            result["messages"] = [dict(r) for r in storage.db.execute("""
                SELECT id, message, group_name, sender, timestamp
                FROM raw_messages
                WHERE to_tsvector('english', COALESCE(message, '')) @@ plainto_tsquery('english', ?)
                ORDER BY id DESC
                LIMIT 6
            """, [q]).fetchall()]
        except Exception:
            result["messages"] = []
    except Exception:
        pass
    result = {k: v for k, v in result.items() if v}
    return result


@router.get("/api/search/raw")
async def search_raw_messages(q: str = "", limit: int = 20, offset: int = 0):
    if not q:
        return {"results": [], "count": 0}
    q = q.strip()
    limit, offset = bounded_page(limit, offset)

    def _resolve_group_name(group_name: str) -> str:
        if group_name and "@g.us" in group_name:
            resolved = storage.db.execute(
                "SELECT group_name FROM source_sync_jobs WHERE group_id = ? LIMIT 1",
                (group_name,)
            ).fetchone()
            if resolved:
                return resolved[0]
        return group_name

    def _row_to_result(row: Any, snippet: str | None = None) -> dict:
        return {
            "id": row[0],
            "group_name": _resolve_group_name(row[1]),
            "sender": row[2],
            "sender_phone": row[3],
            "message": row[4],
            "timestamp": row[5],
            "source": row[6],
            "snippet": snippet if snippet is not None else (row[4][:200] if row[4] else ""),
        }

    try:
        rows = storage.db.execute("""
            SELECT rm.id, rm.group_name, rm.sender, rm.sender_phone,
                   rm.message, rm.timestamp, rm.source,
                   snippet(raw_messages_fts, 0, '<mark>', '</mark>', '...', 40) as snippet
            FROM raw_messages_fts fts
            JOIN raw_messages rm ON rm.id = fts.rowid
            WHERE raw_messages_fts MATCH ?
            ORDER BY rank
            LIMIT ? OFFSET ?
        """, (q, limit, offset)).fetchall()
        count_row = storage.db.execute("""
            SELECT COUNT(*) FROM raw_messages_fts WHERE raw_messages_fts MATCH ?
        """, (q,)).fetchone()
        total = count_row[0] if count_row else 0
        return {"results": [_row_to_result(r, r[7]) for r in rows], "count": total, "query": q}
    except Exception as e:
        try:
            like_q = f"%{q}%"
            rows = storage.db.execute("""
                SELECT id, group_name, sender, sender_phone, message, timestamp, source
                FROM raw_messages
                WHERE message LIKE ? OR group_name LIKE ? OR sender LIKE ?
                ORDER BY id DESC
                LIMIT ? OFFSET ?
            """, (like_q, like_q, like_q, limit, offset)).fetchall()
            count_row = storage.db.execute("""
                SELECT COUNT(*) FROM raw_messages
                WHERE message LIKE ? OR group_name LIKE ? OR sender LIKE ?
            """, (like_q, like_q, like_q)).fetchone()
            total = count_row[0] if count_row else 0
            return {"results": [_row_to_result(r) for r in rows], "count": total, "query": q}
        except Exception as like_error:
            logging.warning("[api/search/raw] FTS and LIKE search failed: %s / %s", e, like_error)
        try:
            # Never recover from a failed indexed query by scanning an
            # arbitrary raw-message page in Python. That made one search
            # request read 1,000 rows and still return incomplete results.
            # Surface an explicit degraded response so the client can retry
            # after the FTS/index problem is fixed.
            return {"results": [], "count": 0, "query": q, "fallback": "indexed_search_unavailable"}
        except Exception as scan_error:
            logging.warning("[api/search/raw] python fallback failed: %s", scan_error)
            return {"results": [], "count": 0, "query": q, "fallback": "empty"}


@router.get("/api/search/raw/sender")
async def search_raw_by_sender(sender: str = "", limit: int = 50, user: dict = Depends(require_user)):
    if not sender:
        return {"results": [], "count": 0}
    limit, _ = bounded_page(limit, 0)
    like_q = f"%{sender}%"
    rows = storage.db.execute("""
        SELECT id, group_name, sender, sender_phone, message, timestamp, source
        FROM raw_messages
        WHERE sender LIKE ? OR sender_phone LIKE ?
        ORDER BY id DESC
        LIMIT ?
    """, (like_q, like_q, limit)).fetchall()
    results = []
    for r in rows:
        group_name = r[1]
        if group_name and '@g.us' in group_name:
            resolved = storage.db.execute(
                "SELECT group_name FROM source_sync_jobs WHERE group_id = ? LIMIT 1",
                (group_name,)
            ).fetchone()
            if resolved:
                group_name = resolved[0]
        results.append({
            "id": r[0],
            "group_name": group_name,
            "sender": r[2],
            "sender_phone": r[3],
            "message": r[4],
            "timestamp": r[5],
            "source": r[6],
        })
    return {"results": results, "count": len(results), "query": sender}


@router.get("/api/search/raw/group")
async def search_raw_by_group(group_jid: str = "", limit: int = 50, user: dict = Depends(require_user)):
    if not group_jid:
        return {"results": [], "count": 0}
    limit, _ = bounded_page(limit, 0)
    rows = storage.db.execute("""
        SELECT id, group_name, sender, sender_phone, message, timestamp, source
        FROM raw_messages
        WHERE group_name = ? OR group_name LIKE ?
        ORDER BY id DESC
        LIMIT ?
    """, (group_jid, f"%{group_jid}%", limit)).fetchall()
    results = []
    for r in rows:
        group_name = r[1]
        if group_name and '@g.us' in group_name:
            resolved = storage.db.execute(
                "SELECT group_name FROM source_sync_jobs WHERE group_id = ? LIMIT 1",
                (group_name,)
            ).fetchone()
            if resolved:
                group_name = resolved[0]
        results.append({
            "id": r[0],
            "group_name": group_name,
            "sender": r[2],
            "sender_phone": r[3],
            "message": r[4],
            "timestamp": r[5],
            "source": r[6],
        })
    return {"results": results, "count": len(results), "query": group_jid}


@router.get("/api/search/market")
async def market_search(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
    intent: str = "", bhk: str = "", building: str = "", micro_market: str = "",
    q: str = "",
    price_max: float = 0, price_min: float = 0, furnishing: str = "", broker: str = "",
    sort_by: str = "last_seen", limit: int = 10, offset: int = 0,
):
    # Market Map is backed by the shared typed listing tables. Keep this
    # route off the deprecated SQLite ``listings_unified`` compatibility view;
    # that view is not the source of truth and can be absent in production.
    return await asyncio.to_thread(
        storage.get_shared_market_listings,
        limit=limit,
        offset=offset,
        intent=intent,
        bhk=bhk,
        building=building,
        micro_market=micro_market,
        q=q,
        price_max=price_max,
        price_min=price_min,
        furnishing=furnishing,
        broker=broker,
    )
