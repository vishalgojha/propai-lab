"""Location resolver.

Resolves vague location descriptions to known Mumbai micro_markets.
Last resort enrichment — runs after deterministic checks fail.

Pre-checks before LLM:
  1. location_aliases knowledge graph
  2. Canonical streets/landmarks CSV data
  3. Other observations from same group/sender in the last hour

Every LLM answer is stored in location_aliases for future free resolution.
"""

import csv
import json
import logging
import os
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import TYPE_CHECKING
from openai import OpenAI

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from lab.storage.base import Storage

MODEL = "Qwen/Qwen3.6-35B-A3B-FP8"
BASE_URL = "https://api.doubleword.ai/v1"

LOCATION_SYSTEM_PROMPT = """You are a Mumbai real estate location resolver.

Given a raw WhatsApp message and its extracted location text, determine the most specific micro_market in Mumbai.

Known micro_markets include: Bandra West, Bandra East, Khar West, Khar East, Santacruz West, Santacruz East, Vile Parle West, Vile Parle East, Andheri West, Andheri East, Juhu, Juhu Tara Road, Versova, Lokhandwala, Oshiwara, Marol, Sakinaka, Powai, Chandivali, BKC (Bandra Kurla Complex), Lower Parel, Parel, Mahalaxmi, Worli, Prabhadevi, Dadar West, Dadar East, Matunga, Mahim, Shivaji Park, Malad West, Malad East, Goregaon West, Goregaon East, Kandivali West, Kandivali East, Borivali West, Borivali East, Dahisar, Mira Road, Thane West, Thane East, Mulund, Bhandup, Vikhroli, Kanjur Marg, Ghatkopar, Chembur, Wadala, Sewri, Colaba, Cuffe Parade, Nariman Point, Fort, Churchgate, Marine Lines, Charni Road, Grant Road, Mumbai Central, Mahalakshmi.

Rules:
- Return the single best micro_market match
- If a landmark or street is mentioned, resolve it to the micro_market it belongs to
- If the location is ambiguous or cannot be resolved, return null
- Be conservative — only resolve when you are confident

Respond in JSON: {"micro_market": string | null, "confidence": 0.0-1.0, "reasoning": "brief explanation"}"""


def _get_client():
    from llm import get_client as _fb_client
    return _fb_client()


def _load_canonical_locations():
    """Load streets and landmarks mapped to micro_markets from CSV files."""
    locations = {}
    lab_dir = Path(__file__).parent.parent
    propai_data = lab_dir.parent / "propai" / "data"

    # Streets
    streets_csv = propai_data / "building_streets.csv"
    if streets_csv.exists():
        with open(streets_csv) as f:
            reader = csv.DictReader(f)
            for row in reader:
                name = (row.get("street_name") or "").strip().lower()
                if name and row.get("micro_market"):
                    locations[name] = row["micro_market"]

    # Landmarks
    landmarks_csv = propai_data / "landmarks.csv"
    if landmarks_csv.exists():
        with open(landmarks_csv) as f:
            reader = csv.DictReader(f)
            for row in reader:
                name = (row.get("name") or "").strip().lower()
                mm = row.get("micro_market") or ""
                if name and mm:
                    locations[name] = mm
                aliases = (row.get("aliases") or "").split(";")
                for alias in aliases:
                    alias = alias.strip().lower()
                    if alias:
                        locations[alias] = mm

    return locations


def enrich_location(storage: "Storage", d: dict) -> None:
    """Resolve micro_market for a parsed observation. Creates suggestion if found."""
    parsed_id = d["id"]
    raw_message = d.get("message") or ""
    location_raw = d.get("location_raw") or ""
    micro_market = d.get("micro_market") or ""
    group_name = d.get("group_name") or ""
    sender = d.get("sender") or ""

    if micro_market:
        return

    raw_text = f"{raw_message} {location_raw}"

    # Pre-check 1: location_aliases knowledge graph
    alias_mm = storage.resolve_location(raw_text)
    if alias_mm:
        return

    # Pre-check 2: canonical streets/landmarks
    canonical_mm = _check_canonical_locations(raw_text)
    if canonical_mm:
        sug = _make_location_suggestion(parsed_id, canonical_mm, 0.90, "matched canonical street/landmark database")
        storage.create_suggestion(sug)
        return

    # Pre-check 3: cross-reference with same group/sender
    if _check_group_location_context(storage, parsed_id, group_name, sender, raw_text):
        return

    # Pre-check 4: location_aliases on substrings of raw text
    if _check_substring_aliases(storage, raw_text, parsed_id):
        return

    # Last resort: LLM call
    result = _call_llm(raw_message, location_raw)
    if result:
        sug = _make_location_suggestion(parsed_id, result["micro_market"],
                                        result["confidence"],
                                        f"LLM resolution: {result.get('reasoning', '')}")
        storage.create_suggestion(sug)


def _check_canonical_locations(raw_text: str) -> str | None:
    search = raw_text.lower()
    locations = _load_canonical_locations()
    best = None
    best_len = 0
    for name, mm in locations.items():
        if name in search and len(name) > best_len:
            best = mm
            best_len = len(name)
    return best


def _check_group_location_context(storage: "Storage", parsed_id: int,
                                  group_name: str, sender: str, raw_text: str) -> bool:
    """Look for micro_market mentions in recent same-group/same-sender messages."""
    one_hour_ago = (datetime.now(timezone.utc) - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows = storage.db.execute(
        """SELECT p.micro_market, r.message, r.group_name
           FROM parsed_output p
           JOIN raw_messages r ON r.id = p.raw_message_id
           WHERE p.micro_market IS NOT NULL AND p.micro_market != ''
             AND p.id != ?
             AND (r.group_name = ? OR r.sender = ?)
             AND (r.timestamp >= ? OR p.created_at >= ?)
           ORDER BY p.id DESC
           LIMIT 10""",
        (parsed_id, group_name, sender, one_hour_ago, one_hour_ago),
    ).fetchall()

    markets = {}
    for r in rows:
        mm = r["micro_market"]
        if mm:
            markets[mm] = markets.get(mm, 0) + 1

    if markets:
        best = max(markets, key=markets.get)
        count = markets[best]
        confidence = min(0.93, 0.78 + count * 0.03)
        sug = _make_location_suggestion(parsed_id, best, confidence,
                                        f"same sender/group uses '{best}' in {count} recent messages")
        storage.create_suggestion(sug)
        return True
    return False


def _check_substring_aliases(storage: "Storage", raw_text: str, parsed_id: int) -> bool:
    search = raw_text.lower()
    rows = storage.db.execute(
        "SELECT alias, canonical, confidence FROM location_aliases"
    ).fetchall()
    best = None
    best_len = 0
    for r in rows:
        alias = r["alias"].lower()
        if alias in search and len(alias) > best_len:
            best = (r["canonical"], r["confidence"])
            best_len = len(alias)
    if best:
        sug = _make_location_suggestion(parsed_id, best[0], best[1],
                                        f"substring matched alias '{best[0]}'")
        storage.create_suggestion(sug)
        return True
    return False


def _call_llm(raw_message: str, location_raw: str) -> dict | None:
    client = _get_client()
    if not client:
        return None

    user_text = f"Message: {raw_message}\nLocation: {location_raw}"
    try:
        resp = client.chat.completions.create(
            model=os.environ.get("LLM_TASK_MODEL", "extraction"),
            messages=[
                {"role": "system", "content": LOCATION_SYSTEM_PROMPT},
                {"role": "user", "content": user_text},
            ],
            temperature=0.1,
            max_tokens=150,
        )
        text = resp.choices[0].message.content.strip()
        text = text.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        result = json.loads(text)
        if result.get("micro_market") and result.get("confidence", 0) >= 0.80:
            return result
        return None
    except Exception as exc:
        logger.warning(
            "location_resolver LLM call failed (task_type=extraction): %s", exc
        )
        return None


def _make_location_suggestion(parsed_id: int, micro_market: str,
                              confidence: float, reason: str):
    from lab.storage.base import AISuggestion
    import json
    return AISuggestion(
        agent="location",
        suggestion_type="create",
        title=f"Location: {micro_market}",
        description=f"Resolved location for observation #{parsed_id} → {micro_market}. {reason}.",
        source_data=json.dumps({"parsed_id": parsed_id, "micro_market": micro_market}),
        proposal_data=json.dumps({
            "action": "create_alias",
            "alias": micro_market.lower(),
            "canonical": micro_market,
        }),
        confidence=confidence,
    )
