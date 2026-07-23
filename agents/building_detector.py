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
import logging
import os
import re
from datetime import datetime, timezone, timedelta
from typing import TYPE_CHECKING
from openai import OpenAI

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from lab.storage.base import Storage

BUILDING_SYSTEM_PROMPT = """You are a building name extractor for Mumbai real estate WhatsApp groups.

Given a raw WhatsApp message, extract the building/complex name if one is clearly mentioned.

Rules:
- Return the exact building name as written (e.g. "Lodha Crown", "Rustomjee Eternity", "Chandak Unicorn")
- If multiple buildings, return the primary one being advertised
- If no building is mentioned, return null
- If only a landmark or area (not a specific building), return null
- Be conservative — only extract when you are confident

CRITICAL: Some tower names include a locality abbreviation (e.g. "Ten BKC", "One BKC",
"BKC-X") — these are SPECIFIC TOWERS in the BKC area, not area references.  Do NOT
null them out just because "BKC" looks like a locality name.  Similarly, "The Capital"
is a tower name despite containing a generic word.

Examples of locality-name-collision (tower name contains area abbreviation):
  Input: "2 BHK for lease, Ten BKC"          → "Ten BKC" (specific tower in BKC)
  Input: "3 BHK in One BKC"                   → "One BKC" (specific tower)
  Input: "Office space at BKC-X"              → "BKC-X" (specific tower)
  Input: "2 BHK office in BKC"                → null (BKC alone is just the locality)
  Input: "1 BHK in Kanakia Paris BKC"         → "Kanakia Paris" (tower name)
  Input: "10 BKC 3BHK 2300 sqft"              → "10 BKC" (numeral variant of Ten BKC)
  Input: "Rentals in The Capital BKC"         → "The Capital" (tower name)

Respond in JSON: {"building_name": string | null, "confidence": 0.0-1.0, "reasoning": "brief explanation"}"""

KNOWN_BKC_TOWERS = {
    "Ten BKC", "One BKC", "10 BKC",
    "BKC-X", "BKC X",
    "Kanakia Paris", "The Capital", "Platina", "Parinee",
    "Trade Centre", "Naman Centre",
    "Bharat Diamond Bourse", "Cressenzo", "Ceejay House",
    "Jio World Centre", "Maker Maxity",
    "Sigma Corp", "ICICI Centre", "One International Center",
}


def _get_client():
    from llm import get_client as _fb_client
    return _fb_client()


def _gemini_client() -> OpenAI | None:
    """Try to create a Gemini OpenAI-compatible client."""
    import os
    key = os.getenv("GEMINI_API_KEY", "")
    if key:
        return OpenAI(api_key=key, base_url="https://generativelanguage.googleapis.com/v1beta/openai")
    return None


def _cerebras_client() -> OpenAI | None:
    """Try to create a Cerebras OpenAI-compatible client."""
    import os
    key = os.getenv("CEREBRAS_API_KEY", "")
    if key:
        return OpenAI(api_key=key, base_url="https://api.cerebras.ai/v1")
    return None


def enrich_building(storage: "Storage", d: dict) -> None:
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

    # Pre-check 2: canonical buildings (exact substring match)
    if _check_canonical_buildings(storage, raw_text, parsed_id):
        return

    # Pre-check 3: fuzzy alias matching — catches near-misses exact match misses
    if _check_fuzzy_building_match(storage, raw_text, parsed_id):
        return

    # Pre-check 4: cross-reference — other observations in same group, last hour
    if _check_group_context(storage, parsed_id, group_name, sender, raw_text):
        return

    # Last resort: LLM call
    result = _call_llm(raw_message, location_raw, micro_market)
    if result:
        sug = _make_suggestion(parsed_id, result["building_name"],
                               result["confidence"],
                               f"LLM extraction: {result.get('reasoning', '')}")
        storage.create_suggestion(sug)


def _check_canonical_buildings(storage: "Storage", raw_text: str, parsed_id: int) -> bool:
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


def _check_fuzzy_building_match(storage: "Storage", raw_text: str, parsed_id: int) -> bool:
    """Fuzzy-match the raw text against known building names and aliases.

    Uses the building_alias_engine.fuzzy_score() to catch near-misses
    that exact substring matching (used by _check_canonical_buildings)
    would miss — e.g. "Kalpataru Vivant" vs "Kalpataru Vivant Andheri West".
    Runs before the LLM fallback to resolve cheaply what it can.
    """
    from agents.building_alias_engine import fuzzy_score, normalize_building_name

    norm_text = normalize_building_name(raw_text)
    norm_tokens = norm_text.split()
    if len(norm_tokens) < 2:
        return False

    # Collect known building names + aliases
    names = set()
    try:
        for table, col in [("buildings", "canonical_name"),
                           ("building_aliases", "alias"),
                           ("building_name_aliases", "alias")]:
            rows = storage.db.execute(
                f"SELECT DISTINCT {col} FROM {table} WHERE {col} IS NOT NULL AND {col} != ''"
            ).fetchall()
            for r in rows:
                names.add(r[col])
    except Exception:
        return False

    if not names:
        return False

    best_name = None
    best_score = 0.0
    THRESHOLD = 0.85

    for name in names:
        norm_name = normalize_building_name(name)
        if not norm_name or len(norm_name) < 4:
            continue
        name_tokens = norm_name.split()
        name_len = len(name_tokens)
        if name_len < 1:
            continue

        # Sliding window over raw text tokens to find best match
        max_start = len(norm_tokens) - name_len + 1
        for i in range(max_start):
            window = ' '.join(norm_tokens[i:i + name_len])
            score = fuzzy_score(norm_name, window)
            if score > best_score:
                best_score = score
                best_name = name
                if score >= 1.0:
                    break
        if best_score >= 1.0:
            break

    if best_score >= THRESHOLD and best_name:
        sug = _make_suggestion(parsed_id, best_name, best_score,
                               f"fuzzy alias match (score={best_score:.3f})")
        storage.create_suggestion(sug)
        return True
    return False


def _check_group_context(storage: "Storage", parsed_id: int,
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
    hint = ""
    if "bkc" in micro_market.lower() or "bkc" in location_raw.lower():
        towers = ", ".join(sorted(KNOWN_BKC_TOWERS))
        hint = f"\nKnown BKC towers (extract one of these if matched): {towers}"
    truncated = raw_message[:800]
    user_text = f"Message: {truncated}\nLocation: {location_raw}\nMarket: {micro_market}{hint}"

    providers_to_try = [
        (_get_client(), None, "Default"),
        (_cerebras_client(), "gpt-oss-120b", "Cerebras"),
    ]

    for client, model_override, label in providers_to_try:
        if not client:
            continue
        model = model_override or _get_model()
        try:
            kwargs = dict(
                model=model,
                messages=[
                    {"role": "system", "content": BUILDING_SYSTEM_PROMPT},
                    {"role": "user", "content": user_text},
                ],
                temperature=0.1,
                max_tokens=400,
            )
            # Cerebras supports response_format; NVIDIA sometimes ignores it
            # and returns empty content — skip for Default provider
            if label != "Default":
                kwargs["response_format"] = {"type": "json_object"}

            resp = client.chat.completions.create(**kwargs)
            text = resp.choices[0].message.content.strip()

            # Try JSON first
            result = _extract_json(text)
            if result:
                bn = result.get("building_name") or result.get("building_names")
                if isinstance(bn, list):
                    bn = bn[0] if bn else None
                if bn:
                    result["building_name"] = bn
                    result.setdefault("confidence", 0.75)
                    return result

            # Fallback: extract building name from narrative text
            bn = _extract_narrative_building(text)
            if bn:
                logger.info("building_detector (%s): narrative extraction -> %s", label, bn)
                return {"building_name": bn, "confidence": 0.65, "reasoning": "extracted from narrative"}
        except Exception as exc:
            # Retry once on 429/503 after delay
            err_str = str(exc)
            if "429" in err_str or "503" in err_str or "Too Many Requests" in err_str:
                import time
                time.sleep(2)
                try:
                    resp = client.chat.completions.create(
                        model=model,
                        messages=[
                            {"role": "system", "content": BUILDING_SYSTEM_PROMPT},
                            {"role": "user", "content": user_text},
                        ],
                        temperature=0.1,
                        max_tokens=400,
                    )
                    text = resp.choices[0].message.content.strip()
                    result = _extract_json(text)
                    if result:
                        bn = result.get("building_name") or result.get("building_names")
                        if isinstance(bn, list):
                            bn = bn[0] if bn else None
                        if bn:
                            result["building_name"] = bn
                            result.setdefault("confidence", 0.75)
                            return result
                    bn = _extract_narrative_building(text)
                    if bn:
                        return {"building_name": bn, "confidence": 0.65, "reasoning": "extracted from narrative (retry)"}
                except Exception:
                    pass
            logger.warning("building_detector (%s): %s", label, exc)

    return None


def _get_model():
    from llm import get_model
    return get_model()


def _extract_json(text: str) -> dict | None:
    """Parse JSON from model output, with fallback regex extraction."""
    cleaned = text.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass
    m = re.search(r'\{[^{}]*(?:"building_name"|"building_names"|"confidence")[^{}]*\}', cleaned, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            pass
    return None


_NARRATIVE_SKIP = {"bhk", "sqft", "rent", "floor", "carpet", "furnished", "lakh", "cr", "price",
                    "contact", "call", "whatsapp", "inventory", "listing", "unit", "tower",
                    "available", "amenities", "view", "location", "area", "wing", "phase",
                    "residences", "flats", "apartment", "road", "west", "east", "north", "south",
                    "the", "a", "an", "for", "in", "at", "on", "to", "is", "are", "was",
                    "known", "towers", "extract", "one", "these", "matched", "includes",
                    "include", "following", "such", "like", "list", "listing", "entries"}

_BUILDING_KEYWORDS = frozenset({
    "bkc", "tower", "house", "residency", "court", "heights", "corporation",
    "complex", "centre", "center", "square", "park", "villa", "palace",
    "chambers", "enclave", "garden", "manor", "plaza", "nest", "kingdom",
    "empire", "manor", "chambers", "building", "towers", "residence",
    "heaven", "pride", "landmark", "vista", "crown", "royal", "regal",
    "capital", "platinum", "diamond", "gold", "silver", "unicorn",
    "eternity", "magnus", "serendipity", "kanakia", "parinee", "platina",
    "cressenzo", "ceejay", "maxity", "maker", "sig", "jio", "bkc",
    "naman", "bourse", "international", "trade", "centre",
})


_REJECT_LIKE = re.compile(
    r'(available|urgent|pictures|photos|images?|contact|call|whatsapp|price|rent|lease|sell|sale|deal|'
    r'inventory|listing|update|new|just|looking|furnishing|furnished|semi|fully|'
    r'modular|kitchen|servant|room|floor|wing|phase|'
    r'\d+\.?\s*bhk|bhk\s+\d)',
    re.I,
)

def _is_building_like(name: str) -> bool:
    """Check if a text fragment looks like a building name."""
    if not name or len(name) < 3 or len(name) > 60:
        return False
    if name.startswith("*") or name.startswith("-") or name.startswith("#"):
        return False
    lower = name.lower()
    if lower in ("building_name", "building_names", "null", "none", "bkc"):
        return False
    # Reject description-like phrases
    if _REJECT_LIKE.search(lower):
        return False
    # Must not be purely a skip word
    words = set(lower.split())
    significant = words - _NARRATIVE_SKIP
    if not significant:
        return False
    # Must contain at least one building keyword
    if any(kw in lower for kw in _BUILDING_KEYWORDS):
        return True
    # Unterminated numeral prefix (e.g. "10 BKC")
    if re.fullmatch(r'\d+\s+[a-z].+', lower):
        return True
    return False


def _extract_narrative_building(text: str) -> str | None:
    """Extract the primary building name from narrative LLM output.

    Handles several formats the model returns:
    - "Adani TEN BKC"  (quoted)
    - Adani TEN BKC    (bare, no quotes)
    - The building is "Adani TEN BKC"  (narrative with quotes)
    - {"building_name": "Adani TEN BKC"} (JSON)
    """
    text = text.strip()

    # If the entire response is short and building-like, return it directly
    if _is_building_like(text):
        return text

    # Look for content in double quotes
    candidates = re.findall(r'"([^"]{3,60})"', text)
    for c in candidates:
        c_stripped = c.strip()
        if _is_building_like(c_stripped):
            return c_stripped

    # Try first line if it's short and building-like (skip lines starting with hint words)
    first_line = text.split('\n')[0].strip()
    hint_words = {"known", "the", "message", "based", "looking", "check", "note", "after"}
    if _is_building_like(first_line) and not first_line.lower().startswith(tuple(hint_words)):
        return first_line

    # Fallback: first quoted string
    if candidates:
        return candidates[0].strip()

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


def _apply_building(storage: "Storage", d: dict) -> str | None:
    """Extract building name via LLM + update parsed_output directly.

    Returns the extracted building name or None.
    """
    parsed_id = d["id"]
    raw_message = d.get("message") or ""
    location_raw = d.get("location_raw") or ""
    micro_market = d.get("micro_market") or ""

    result = _call_llm(raw_message, location_raw, micro_market)
    if not result:
        return None

    building_name = result["building_name"]
    storage.db.execute(
        "UPDATE parsed_output SET building_name = ? WHERE id = ?",
        (building_name, parsed_id),
    )

    sug = _make_suggestion(parsed_id, building_name,
                           result["confidence"],
                           f"Backfill extraction: {result.get('reasoning', '')}")
    storage.create_suggestion(sug)
    return building_name


def backfill_bkc(storage: "Storage") -> tuple[int, int]:
    """Re-run building detection on all BKC rows where building_name is null.

    Returns (attempted, succeeded) counts.
    """
    rows = storage.db.execute(
        """SELECT p.id, r.message, p.location_raw, p.micro_market,
                  r.group_name, r.sender, p.building_name
           FROM parsed_output p
           JOIN raw_messages r ON r.id = p.raw_message_id
           WHERE p.micro_market ILIKE 'BKC'
             AND (p.building_name IS NULL OR p.building_name = '')
           ORDER BY p.id"""
    ).fetchall()

    # Dedup: skip rows that already have a building suggestion
    existing = {
        r["parsed_id"] for r in storage.db.execute(
            "SELECT DISTINCT source_data->>'parsed_id' AS parsed_id FROM ai_suggestions WHERE agent = 'building'"
        ).fetchall() if r.get("parsed_id")
    }

    attempted = 0
    succeeded = 0
    for row in rows:
        d = dict(row)
        if str(d["id"]) in existing:
            continue
        attempted += 1
        try:
            name = _apply_building(storage, d)
            if name:
                succeeded += 1
        except Exception:
            logger.exception("backfill_bkc: enrich_building failed for parsed_id=%s", d["id"])

    logger.info("backfill_bkc: attempted=%d succeeded=%d", attempted, succeeded)
    return attempted, succeeded
