"""
Search routes — text search, raw FTS, sender/group filtered search, market search.
"""
import logging
import re
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from routers.common import storage, require_user

router = APIRouter(tags=["search"])


@router.get("/api/search")
async def search_messages(q: str = "", user: dict = Depends(require_user)):
    if not q:
        return []
    q = q.strip()
    like_q = f"%{q}%"
    result = {"listings": [], "requirements": [], "brokers": [], "buildings": [], "markets": [], "messages": []}
    try:
        try:
            result["listings"] = [dict(r) for r in storage.db.execute("""
                SELECT fingerprint, intent, bhk, price, price_unit, area_sqft, furnishing,
                       location_label, building_name, landmark_name, micro_market,
                       broker_name, broker_phone, observation_count, last_seen
                FROM listings
                WHERE broker_name LIKE ? OR building_name LIKE ? OR micro_market LIKE ?
                   OR bhk LIKE ? OR location_label LIKE ? OR landmark_name LIKE ?
                ORDER BY observation_count DESC
                LIMIT 8
            """, [like_q] * 6).fetchall()]
        except Exception:
            result["listings"] = []
        try:
            result["requirements"] = [dict(r) for r in storage.db.execute("""
                SELECT p.id, p.intent, p.bhk, p.price, p.price_unit, p.broker_name, p.broker_phone,
                       p.micro_market, p.location_raw, p.created_at, r.message, r.group_name
                FROM parsed_output p
                JOIN raw_messages r ON r.id = p.raw_message_id
                WHERE p.intent IN ('BUY','RENTAL_SEEKER')
                  AND (r.message LIKE ? OR p.broker_name LIKE ? OR p.micro_market LIKE ?
                       OR p.bhk LIKE ? OR p.location_raw LIKE ?)
                ORDER BY p.id DESC
                LIMIT 6
            """, [like_q] * 5).fetchall()]
        except Exception:
            result["requirements"] = []
        try:
            result["brokers"] = [dict(r) for r in storage.db.execute("""
                SELECT id, canonical_name AS name, primary_phone AS phone,
                       observation_count, listing_count, requirement_count,
                       group_count, market_count, avg_ticket
                FROM brokers
                WHERE canonical_name LIKE ? OR primary_phone LIKE ?
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
                LEFT JOIN parsed_output p ON p.id = rd.parsed_id
                WHERE rd.building_name IS NOT NULL AND rd.building_name != ''
                  AND rd.building_name LIKE ?
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
                FROM parsed_output
                WHERE micro_market IS NOT NULL AND micro_market != ''
                  AND micro_market LIKE ?
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
                WHERE message LIKE ?
                ORDER BY id DESC
                LIMIT 6
            """, [like_q]).fetchall()]
        except Exception:
            result["messages"] = []
    except Exception:
        pass
    result = {k: v for k, v in result.items() if v}
    return result


@router.get("/api/search/raw")
async def search_raw_messages(q: str = "", limit: int = 20, offset: int = 0, user: dict = Depends(require_user)):
    if not q:
        return {"results": [], "count": 0}
    q = q.strip()

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
            rows = storage.get_raw_messages(limit=max(limit + offset, 1000), offset=0)
            needle = q.casefold()
            filtered = []
            for row in rows:
                haystack = " ".join(
                    str(part)
                    for part in (
                        getattr(row, "message", "") or "",
                        getattr(row, "group_name", "") or "",
                        getattr(row, "sender", "") or "",
                        getattr(row, "sender_phone", "") or "",
                        getattr(row, "source", "") or "",
                    )
                ).casefold()
                if needle in haystack:
                    filtered.append({
                        "id": getattr(row, "id", None),
                        "group_name": _resolve_group_name(getattr(row, "group_name", "") or ""),
                        "sender": getattr(row, "sender", "") or "",
                        "sender_phone": getattr(row, "sender_phone", "") or "",
                        "message": getattr(row, "message", "") or "",
                        "timestamp": getattr(row, "timestamp", "") or "",
                        "source": getattr(row, "source", "") or "",
                        "snippet": (getattr(row, "message", "") or "")[:200],
                    })
            total = len(filtered)
            return {"results": filtered[offset:offset + limit], "count": total, "query": q, "fallback": "python_scan"}
        except Exception as scan_error:
            logging.warning("[api/search/raw] python fallback failed: %s", scan_error)
            return {"results": [], "count": 0, "query": q, "fallback": "empty"}


@router.get("/api/search/raw/sender")
async def search_raw_by_sender(sender: str = "", limit: int = 50, user: dict = Depends(require_user)):
    if not sender:
        return {"results": [], "count": 0}
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
    intent: str = "", bhk: str = "", building: str = "", micro_market: str = "",
    price_max: float = 0, price_min: float = 0, furnishing: str = "", broker: str = "",
    sort_by: str = "last_seen", limit: int = 10, offset: int = 0,
    group_by_building: bool = True,
):
    import math
    from datetime import datetime, timezone, timedelta

    where_clauses = []
    params = []

    if intent and intent != "any":
        where_clauses.append("l.intent = ?")
        params.append(intent.upper())

    if bhk and bhk != "any":
        where_clauses.append("l.bhk = ?")
        params.append(bhk)

    if building:
        where_clauses.append("""(
            l.building_name LIKE ? OR
            l.building_name IN (SELECT canonical FROM building_aliases WHERE alias LIKE ?) OR
            l.building_name IN (SELECT alias FROM building_aliases WHERE canonical LIKE ?) OR
            l.building_name IN (SELECT canonical FROM building_aliases WHERE alias LIKE ?)
        )""")
        bpattern = f"%{building}%"
        params.extend([bpattern, bpattern, bpattern, bpattern])

    if micro_market:
        where_clauses.append("l.micro_market LIKE ?")
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
        where_clauses.append("l.broker_name LIKE ?")
        params.append(f"%{broker}%")

    where_sql = " AND ".join(where_clauses) if where_clauses else "1=1"

    sort_map = {
        "price": "l.price",
        "last_seen": "l.last_seen",
        "observation_count": "l.observation_count",
    }
    order_sql = sort_map.get(sort_by, "l.last_seen")

    total_count = storage.db.execute(
        f"SELECT COUNT(*) FROM listings l WHERE {where_sql}", params
    ).fetchone()[0]

    listing_params = params.copy()
    listing_params.extend([limit + 50, offset])
    rows = storage.db.execute(f"""
        SELECT l.fingerprint, l.intent, l.bhk, l.price, l.price_unit, l.area_sqft,
               l.furnishing, l.location_label, l.building_name, l.landmark_name,
               l.micro_market, l.broker_name, l.broker_phone,
               l.first_seen, l.last_seen, l.observation_count, l.group_count,
               l.latest_raw_message_id
        FROM listings l
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
        if d.get("price_unit") and d.get("price_unit") != "/sale" and d.get("intent") == "RENT":
            price_formatted += "/month"

        confidence_pct = 0
        latest_msg = ""

        results.append({
            "fingerprint": d.get("fingerprint"),
            "intent": d.get("intent"),
            "bhk": d.get("bhk"),
            "price": d.get("price"),
            "price_formatted": price_formatted,
            "area_sqft": d.get("area_sqft"),
            "furnishing": d.get("furnishing"),
            "location_label": d.get("location_label"),
            "building_name": d.get("building_name") or "Unknown Building",
            "landmark_name": d.get("landmark_name"),
            "micro_market": d.get("micro_market"),
            "broker_name": d.get("broker_name"),
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
            "match_reasons": match_reasons,
        })

    grouped = {}
    if group_by_building:
        for r in results:
            bname = r["building_name"] or "Unknown Building"
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
