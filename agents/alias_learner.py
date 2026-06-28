"""Deterministic alias learning agent.

Detects abbreviations like BKC (Bandra Kurla Complex) that appear
frequently in location_raw / micro_market / landmark_name, and
suggests storing them as permanent aliases.

Strategy:
1. Find short tokens (2-5 chars) that appear in location fields
2. Check if they cluster with a dominant canonical form
3. Create alias suggestions for high-confidence pairs
"""

import json
import re
from collections import Counter
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from lab.storage.sqlite import SqliteStorage

STOP_WORDS = {
    "THE", "FOR", "AND", "WITH", "NEAR", "FROM", "THAT", "THIS",
    "ON", "IN", "AT", "TO", "OF", "IS", "IT", "OR", "AS", "BE",
    "BY", "NO", "SO", "UP", "WE", "AN", "DO", "IF", "ALL", "NOT",
    "ARE", "BUT", "HAS", "HAD", "OUT", "OFF", "NEW", "OLD", "ANY",
    "WAY", "MAN", "WAS", "BIG", "GET", "NOW", "OWN", "PUT", "SEE",
    "SET", "TWO", "PER", "VIA", "SIR", "KEY", "LOT", "GOT",
    "SALE", "SELL", "BUY", "RENT", "LEASE",
    "EAST", "WEST", "LOWER", "UPPER", "NEAR",
    "ROAD", "TOWER", "HILL", "PARK", "NAGAR", "SPACE",
    "FLAT", "APT", "BHK",
    "FULLY", "SEMI", "FURNISHED",
    "SQFT",
}


def _tokenize(text: str) -> list[str]:
    return [w for w in re.findall(r"[A-Z0-9]{2,}", text.upper())
            if not w.isdigit() and w not in STOP_WORDS]


def check_for_aliases(storage: "SqliteStorage") -> None:
    rows = storage.db.execute(
        """SELECT location_raw, micro_market, building_name, landmark_name
           FROM parsed_output
           WHERE location_raw IS NOT NULL"""
    ).fetchall()

    token_counts: Counter = Counter()
    token_contexts: dict[str, Counter] = {}

    for r in rows:
        seen = set()
        for field in r:
            if not field:
                continue
            for token in _tokenize(field):
                if token not in seen:
                    token_counts[token] += 1
                    seen.add(token)
                if len(token) <= 5:
                    ctx_text = field.upper()
                    for candidate in re.findall(r"[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,4}", ctx_text):
                        if token in ctx_text:
                            token_contexts.setdefault(token, Counter())[candidate.strip()] += 1

    for token, count in token_counts.most_common(50):
        if count < 10 or len(token) < 2 or len(token) > 5:
            continue
        if not token.isalpha():
            continue

        contexts = token_contexts.get(token, {})
        if not contexts:
            continue

        total_ctx = sum(contexts.values())
        best_canonical, best_count = contexts.most_common(1)[0]
        share = best_count / total_ctx if total_ctx else 0

        if share < 0.30:
            continue
        existing = storage.db.execute(
            """SELECT id FROM ai_suggestions
               WHERE agent = 'alias'
                 AND suggestion_type = 'create'
                 AND status IN ('pending', 'approved')
                 AND source_data LIKE ?""",
            (f"%{token}%",),
        ).fetchone()
        if existing:
            continue

        title = f"Learn alias: {token} → {best_canonical}"
        description = (
            f"\"{token}\" appears {count} times in messages. "
            f"When expanded, it most often maps to \"{best_canonical}\" "
            f"({best_count}/{total_ctx} occurrences = {share*100:.0f}% confidence)."
        )

        source_data = json.dumps({
            "alias": token,
            "canonical": best_canonical,
            "occurrences": count,
            "match_count": best_count,
            "total_contexts": total_ctx,
        })

        proposal_data = json.dumps({
            "action": "create_alias",
            "alias": token,
            "canonical": best_canonical,
        })

        confidence = round(min(0.99, 0.70 + share * 0.25 + min(count / 500, 0.05)), 2)

        from lab.storage.base import AISuggestion
        sug = AISuggestion(
            agent="alias",
            suggestion_type="create",
            title=title,
            description=description,
            source_data=source_data,
            proposal_data=proposal_data,
            confidence=confidence,
        )
        storage.create_suggestion(sug)
