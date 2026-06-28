"""Building name detector.

Last-resort enrichment: tries to extract building name from a raw message
when the parser/resolver couldn't find one.

Pre-checks before LLM:
  1. building_aliases knowledge graph
  2. Existing canonical_buildings.csv
  3. Other observations from same group in the last hour
  4. Other observations from same sender

Every LLM answer is stored in building_aliases for future free resolution.
"""

import json
import os
from datetime import datetime, timezone, timedelta
from typing import TYPE_CHECKING
from openai import OpenAI

if TYPE_CHECKING:
    from lab.storage.sqlite import SqliteStorage

MODEL = "Qwen/Qwen3.6-35B-A3B-FP8"
BASE_URL = "https://api.doubleword.ai/v1"

BUILDING_SYSTEM_PROMPT = """You are a building name extractor for Mumbai real estate WhatsApp groups.

Given a raw WhatsApp message, extract the building/complex name if one is clearly mentioned.

Rules:
- Return the exact building name as written (e.g. "Lodha Crown", "Rustomjee Eternity", "Chandak Unicorn")
- If multiple buildings, return the primary one being advertised
- If no building is mentioned, return null
- If only a landmark or area (not a specific building), return null
- Be conservative — only extract when you are confident

Respond in JSON: {"building_name": string | null, "confidence": 0.0-1.0, "reasoning": "brief explanation"}"""


def _get_client():
    key = os.environ.get("DOUBLEWORD_API_KEY", "")
    if not key:
        key_file = os.path.expanduser("~/.propai/config.json")
        if os.path.exists(key_file):
            try:
                cfg = json.loads(open(key_file).read())
                key = cfg.get("doubleword_api_key", "")
            except (json.JSONDecodeError, OSError):
                pass
    return OpenAI(api_key=key, base_url=BASE_URL) if key else None


def enrich_building(storage: "SqliteStorage", d: dict) -> None:
    """Try to resolve building name for a parsed observation. Creates suggestion if found."""
    parsed_id = d["id"]
    raw_message = d.get("message") or ""
    location_raw = d.get("location_raw") or ""
    micro_market = d.get("micro_market") or ""
    group_name = d.get("group_name") or ""
    sender = d.get("sender") or ""
    building_name = d.get("building_name") or ""

    if building_name:
        return

    raw_text = f"{raw_message} {location_raw}"

    # Pre-check 1: building_aliases knowledge graph
    alias_building = storage.resolve_building(raw_text)
    if alias_building:
        return

    # Pre-check 2: canonical buildings
    if _check_canonical_buildings(storage, raw_text, parsed_id):
        return

    # Pre-check 3: cross-reference — other observations in same group, last hour
    if _check_group_context(storage, parsed_id, group_name, sender, raw_text):
        return

    # Last resort: LLM call
    result = _call_llm(raw_message, location_raw, micro_market)
    if result:
        sug = _make_suggestion(parsed_id, result["building_name"],
                               result["confidence"],
                               f"LLM extraction: {result.get('reasoning', '')}")
        storage.create_suggestion(sug)


def _check_canonical_buildings(storage: "SqliteStorage", raw_text: str, parsed_id: int) -> bool:
    """Check if any canonical building name appears in the raw text (free, no LLM)."""
    search_terms = raw_text.lower()
    rows = storage.db.execute(
        "SELECT DISTINCT building_name FROM resolver_decisions WHERE building_name IS NOT NULL"
    ).fetchall()
    for r in rows:
        name = r["building_name"]
        if name and name.lower() in search_terms:
            sug = _make_suggestion(parsed_id, name, 0.92, "matched canonical database")
            storage.create_suggestion(sug)
            return True
    return False


def _check_group_context(storage: "SqliteStorage", parsed_id: int,
                         group_name: str, sender: str, raw_text: str) -> bool:
    """Look for building mentions in recent same-group/same-sender messages."""
    one_hour_ago = (datetime.now(timezone.utc) - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows = storage.db.execute(
        """SELECT p.building_name, r.message, r.group_name, r.sender
           FROM parsed_output p
           JOIN raw_messages r ON r.id = p.raw_message_id
           WHERE p.building_name IS NOT NULL AND p.building_name != ''
             AND p.id != ?
             AND (r.group_name = ? OR r.sender = ?)
             AND (r.timestamp >= ? OR p.created_at >= ?)
           ORDER BY p.id DESC
           LIMIT 10""",
        (parsed_id, group_name, sender, one_hour_ago, one_hour_ago),
    ).fetchall()

    buildings_seen = {}
    for r in rows:
        name = r["building_name"]
        if name:
            buildings_seen[name] = buildings_seen.get(name, 0) + 1

    if buildings_seen:
        best = max(buildings_seen, key=buildings_seen.get)
        count = buildings_seen[best]
        confidence = min(0.95, 0.80 + count * 0.03)
        sug = _make_suggestion(parsed_id, best, confidence,
                               f"mentioned in {count} recent messages by same sender/group")
        storage.create_suggestion(sug)
        return True
    return False


def _call_llm(raw_message: str, location_raw: str, micro_market: str) -> dict | None:
    client = _get_client()
    if not client:
        return None

    user_text = f"Message: {raw_message}\nLocation: {location_raw}\nMarket: {micro_market}"
    try:
        resp = client.chat.completions.create(
            model=MODEL,
            messages=[
                {"role": "system", "content": BUILDING_SYSTEM_PROMPT},
                {"role": "user", "content": user_text},
            ],
            temperature=0.1,
            max_tokens=150,
        )
        text = resp.choices[0].message.content.strip()
        text = text.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        result = json.loads(text)
        if result.get("building_name") and result.get("confidence", 0) >= 0.80:
            return result
    except Exception:
        return None
    return None


def _make_suggestion(parsed_id: int, building_name: str,
                     confidence: float, reason: str):
    from lab.storage.base import AISuggestion
    import json
    return AISuggestion(
        agent="building",
        suggestion_type="create",
        title=f"Building: {building_name}",
        description=f"Detected building '{building_name}' in observation #{parsed_id}. {reason}.",
        source_data=json.dumps({"parsed_id": parsed_id, "building_name": building_name}),
        proposal_data=json.dumps({
            "action": "create_alias",
            "alias": building_name.lower(),
            "canonical": building_name,
        }),
        confidence=confidence,
    )
