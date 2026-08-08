"""
Search routes — text search, raw FTS, sender/group filtered search, market search.
"""
import logging
import os
import re
from datetime import datetime, timezone
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
        min_val = max_val = val
    crore_match = re.search(r'(\d+(?:\.\d+)?)\s*cr', text)
    if crore_match:
        val = int(float(crore_match.group(1)) * 10000000)
        if min_val is None:
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
        content = resp.choices[0].message.content or ""
        import json
        parsed = json.loads(content.strip().lstrip('{').rstrip('}'))
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
    group_by_building: bool = True,
):
    import math
    limit, offset = bounded_page(limit, offset)
    from datetime import datetime, timezone, timedelta

    where_clauses = []
    params = []
    # PropAI is a shared WhatsApp intelligence network.  A connected
    # workspace contributes inventory to the common market; it must not make
    # that inventory invisible to other connected users.  Keep the viewer's
    # tenant only for the provenance label returned below, never as a market
    # visibility filter.

    if intent and intent != "any":
        where_clauses.append("l.intent = ?")
        params.append(intent.upper())

    if bhk and bhk != "any":
        where_clauses.append("l.bhk = ?")
        params.append(bhk)

    if building:
        where_clauses.append("""(
            LOWER(COALESCE(l.building_name, '')) LIKE LOWER(?)
            OR l.building_name IN (
                SELECT canonical_name FROM building_name_aliases
                WHERE LOWER(COALESCE(alias, '')) LIKE LOWER(?)
                UNION
                SELECT alias FROM building_name_aliases
                WHERE LOWER(COALESCE(canonical_name, '')) LIKE LOWER(?)
            )
        )""")
        bpattern = f"%{building}%"
        params.extend([bpattern, bpattern, bpattern])

    if micro_market:
        where_clauses.append("LOWER(COALESCE(l.micro_market, '')) LIKE LOWER(?)")
        params.append(f"%{micro_market}%")

    if price_max:
        where_clauses.append("l.price <= ?")
        params.append(float(price_max))

    if price_min:
        where_clauses.append("l.price >= ?")
        params.append(float(price_min))

    if furnishing and furnishing != "any":
        where_clauses.append("l.furnishing = ?")
        params.append(furnishing)

    if broker:
        where_clauses.append("LOWER(COALESCE(l.broker_name, '')) LIKE LOWER(?)")
        params.append(f"%{broker}%")

    # A single free-text term is used by the map's typeahead.  Keep it
    # deterministic and search the fields that brokers actually use for
    # discovery; structured filters above remain ANDed with this clause.
    if q.strip():
        qpattern = f"%{q.strip()}%"
        where_clauses.append("""(
            LOWER(COALESCE(l.building_name, '')) LIKE LOWER(?)
            OR LOWER(COALESCE(l.micro_market, '')) LIKE LOWER(?)
            OR LOWER(COALESCE(l.location_label, '')) LIKE LOWER(?)
            OR LOWER(COALESCE(l.street_name, '')) LIKE LOWER(?)
            OR LOWER(COALESCE(l.broker_name, '')) LIKE LOWER(?)
            OR l.building_name IN (
                SELECT canonical_name FROM building_name_aliases
                WHERE LOWER(COALESCE(alias, '')) LIKE LOWER(?)
            )
        )""")
        params.extend([qpattern] * 6)

    where_sql = " AND ".join(where_clauses) if where_clauses else "1=1"

    sort_map = {
        "price": "l.price",
        "last_seen": "l.last_seen",
        "observation_count": "l.observation_count",
    }
    order_sql = sort_map.get(sort_by, "l.last_seen")

    total_count = storage.db.execute(
        f"SELECT COUNT(*) FROM listings_unified l WHERE {where_sql}", params
    ).fetchone()[0]

    listing_params = params.copy()
    listing_params.extend([limit + 50, offset])
    rows = storage.db.execute(f"""
        SELECT l.id AS listing_id, l.source_fingerprint AS fingerprint, l.tenant_id AS source_tenant_id,
               l.intent, l.bhk, l.price, l.price_unit, l.area_sqft,
               l.furnishing, l.location_label, l.street_name, l.building_name, l.landmark_name,
               l.micro_market, l.broker_name, l.broker_phone,
               (SELECT CASE
                    WHEN NULLIF(b.canonical_name, '') IS NOT NULL
                     AND b.canonical_name !~ '@s\\.whatsapp\\.net$'
                     AND b.canonical_name !~ '^[0-9 +()\\-]+$'
                    THEN b.canonical_name
                    ELSE ba.alias
                END
                FROM brokers b
                LEFT JOIN broker_aliases ba ON ba.broker_id = b.id
                WHERE regexp_replace(COALESCE(b.primary_phone, ''), '\\D', '', 'g') =
                      regexp_replace(COALESCE(l.broker_phone, ''), '\\D', '', 'g')
                  AND NULLIF(regexp_replace(COALESCE(l.broker_phone, ''), '\\D', '', 'g'), '') IS NOT NULL
                  AND (
                    (NULLIF(b.canonical_name, '') IS NOT NULL
                     AND b.canonical_name !~ '@s\\.whatsapp\\.net$'
                     AND b.canonical_name !~ '^[0-9 +()\\-]+$')
                    OR (NULLIF(ba.alias, '') IS NOT NULL
                        AND ba.alias !~ '@s\\.whatsapp\\.net$'
                        AND ba.alias !~ '^[0-9 +()\\-]+$')
                  )
                ORDER BY (NULLIF(b.canonical_name, '') IS NOT NULL) DESC,
                         COALESCE(ba.observation_count, 0) DESC
                LIMIT 1) AS broker_display_name,
               l.first_seen, l.last_seen, l.observation_count, l.group_count,
               l.latest_raw_message_id,
               (SELECT b.latitude FROM buildings b
                WHERE lower(trim(b.canonical_name)) = lower(trim(l.building_name))
                  AND (NULLIF(trim(l.micro_market), '') IS NULL
                       OR lower(trim(b.address)) = lower(trim(l.micro_market))
                       OR lower(trim(b.address)) LIKE '%' || lower(trim(l.micro_market)) || '%'
                       OR lower(trim(l.micro_market)) LIKE '%' || lower(trim(b.address)) || '%')
                LIMIT 1) AS latitude,
               (SELECT b.longitude FROM buildings b
                WHERE lower(trim(b.canonical_name)) = lower(trim(l.building_name))
                  AND (NULLIF(trim(l.micro_market), '') IS NULL
                       OR lower(trim(b.address)) = lower(trim(l.micro_market))
                       OR lower(trim(b.address)) LIKE '%' || lower(trim(l.micro_market)) || '%'
                       OR lower(trim(l.micro_market)) LIKE '%' || lower(trim(b.address)) || '%')
                LIMIT 1) AS longitude,
               (SELECT b.address FROM buildings b
                WHERE lower(trim(b.canonical_name)) = lower(trim(l.building_name))
                  AND b.address IS NOT NULL
                  AND (NULLIF(trim(l.micro_market), '') IS NULL
                       OR lower(trim(b.address)) = lower(trim(l.micro_market))
                       OR lower(trim(b.address)) LIKE '%' || lower(trim(l.micro_market)) || '%'
                       OR lower(trim(l.micro_market)) LIKE '%' || lower(trim(b.address)) || '%')
                LIMIT 1) AS building_address
        FROM listings_unified l
        WHERE {where_sql}
        ORDER BY {order_sql} DESC
        LIMIT ? OFFSET ?
    """, listing_params).fetchall()

    if not rows:
        return {
            "type": "listing_results",
            "total": total_count,
            "results": [],
            "grouped": {},
            "showing": 0,
            "offset": offset,
            "has_more": False,
            "remaining": 0,
            "search_summary": {"total": 0, "brokers": 0, "buildings": 0, "groups": 0},
            "suggestion": "No exact matches found. Try: Nearby markets | Similar buildings | Different budget | Different BHK | Latest listings",
        }

    now = datetime.now(timezone.utc)
    results = []
    for r in rows:
        d = dict(r)
        match_reasons = []
        if bhk and bhk != "any" and d.get("bhk"):
            match_reasons.append(f"✓ {d['bhk']} BHK")
        if intent and d.get("intent"):
            match_reasons.append(f"✓ {d['intent']}")
        if micro_market and d.get("micro_market"):
            match_reasons.append(f"✓ {d['micro_market']}")
        if building and d.get("building_name"):
            match_reasons.append(f"✓ Building match: {d['building_name']}")
        if furnishing and d.get("furnishing"):
            match_reasons.append(f"✓ {d['furnishing']}")

        last_seen = d.get("last_seen")
        age = ""
        if last_seen:
            try:
                last_dt = datetime.fromisoformat(last_seen.replace("Z", "+00:00"))
                diff = now - last_dt
                if diff.days == 0:
                    hours = diff.seconds // 3600
                    age = f"Seen {hours}h ago" if hours > 0 else "Seen just now"
                elif diff.days == 1:
                    age = "Seen yesterday"
                elif diff.days < 7:
                    age = f"Seen {diff.days}d ago"
                else:
                    age = f"Seen {diff.days // 7}w ago"
            except Exception:
                age = ""

        first_seen = d.get("first_seen")
        first_age = ""
        if first_seen:
            try:
                first_dt = datetime.fromisoformat(first_seen.replace("Z", "+00:00"))
                diff = now - first_dt
                if diff.days == 0:
                    first_age = "First seen today"
                elif diff.days == 1:
                    first_age = "First seen yesterday"
                elif diff.days < 7:
                    first_age = f"First seen {diff.days}d ago"
                else:
                    first_age = f"First seen {diff.days // 7}w ago"
            except Exception:
                first_age = ""

        price_val = d.get("price") or 0
        price_formatted = ""
        if price_val >= 1_00_00_000:
            price_formatted = f"₹{price_val / 1_00_00_000:.2f} Cr"
        elif price_val >= 1_00_000:
            price_formatted = f"₹{price_val / 1_00_000:.1f} L"
        elif price_val > 0:
            price_formatted = f"₹{price_val:,.0f}"
        if price_formatted and d.get("price_unit") and d.get("price_unit") != "/sale" and d.get("intent") == "RENT":
            price_formatted += "/month"

        confidence_pct = 0
        latest_msg = ""

        results.append({
            "listing_id": d.get("listing_id"),
            "fingerprint": d.get("fingerprint"),
            "market_scope": "workspace" if tenant_id and str(d.get("source_tenant_id") or "") == str(tenant_id) else "shared",
            "intent": d.get("intent"),
            "bhk": d.get("bhk"),
            "price": d.get("price"),
            "price_formatted": price_formatted,
            "area_sqft": d.get("area_sqft"),
            "furnishing": d.get("furnishing"),
            "location_label": d.get("location_label"),
            "street_name": d.get("street_name"),
            "building_name": d.get("building_name") or "On Request",
            "building_address": d.get("building_address"),
            "landmark_name": d.get("landmark_name"),
            "micro_market": d.get("micro_market"),
            "broker_name": d.get("broker_name"),
            "broker_display_name": d.get("broker_display_name"),
            "broker_phone": d.get("broker_phone"),
            "first_seen": d.get("first_seen"),
            "first_seen_text": first_age,
            "last_seen": d.get("last_seen"),
            "last_seen_text": age,
            "observation_count": d.get("observation_count", 0),
            "group_count": d.get("group_count", 0),
            "confidence": confidence_pct,
            "latest_message": latest_msg,
            "latest_group": "",
            "latest_timestamp": "",
            "latest_sender": "",
            "raw_message_id": d.get("latest_raw_message_id"),
            "latitude": d.get("latitude"),
            "longitude": d.get("longitude"),
            "match_reasons": match_reasons,
        })

    grouped = {}
    if group_by_building:
        for r in results:
            bname = r["building_name"] or "On Request"
            if bname not in grouped:
                grouped[bname] = {"rentals": 0, "sales": 0, "listings": []}
            if r["intent"] == "RENT":
                grouped[bname]["rentals"] += 1
            elif r["intent"] == "SELL":
                grouped[bname]["sales"] += 1
            grouped[bname]["listings"].append(r)

    brokers_found = len(set(r["broker_name"] for r in results if r["broker_name"]))
    buildings_found = len(set(r["building_name"] for r in results if r["building_name"]))
    groups_found = len(set(r["latest_group"] for r in results if r["latest_group"]))

    return {
        "type": "listing_results",
        "total": total_count,
        "results": results[:limit],
        "grouped": grouped,
        "showing": len(results[:limit]),
        "offset": offset,
        "has_more": total_count > offset + limit,
        "remaining": max(0, total_count - offset - limit),
        "search_summary": {
            "total": total_count,
            "brokers": brokers_found,
            "buildings": buildings_found,
            "groups": groups_found,
        },
    }
