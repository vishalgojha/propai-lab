"""Deterministic locality resolver.

Shared by:

- `backfill_localities.py` — bulk read-only report / opt-in apply path.
- `agents/location_resolver.py` — runtime agent's deterministic pre-check
  before the LLM step (kept forward-compatible; the public API of the agent
  has not changed).

The resolver is purely deterministic. It never calls an LLM. If
`resolve_from_text` or `resolve_from_building` returns ``None`` the row is
genuinely unresolvable and the caller must **leave it empty** — never guess.
See `docs/DATA_QUALITY.md` for the "never guess a building name from
context" rule and the "We never auto-correct broker-entered data"
guideline.

Reference tables read once at construction time:

- ``locality_reference``: ``(sub_locality, parent_locality, confidence)``
- ``buildings``: ``(canonical_name, micro_market)``
- ``building_name_aliases``: ``(alias, canonical_name)``

Public API:

- :class:`LocalityResolver`
- :func:`fetch_reference_data`  — utility used by ``backfill_localities.py``'s
  apply path so we do not hand-roll a second paginator.
- :data:`EXTERNAL_LINK_RE` — shared with ``backfill_localities.py`` so a
  re-export is not required at the call site.
"""
from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger(__name__)


# External domains counted as "link noise" — stripped before matching.
EXTERNAL_LINK_RE = re.compile(
    r"https?://(?:www\.)?(?:youtube\.com|youtu\.be|instagram\.com|facebook\.com|"
    r"fb\.com|twitter\.com|x\.com|t\.co|tiktok\.com|linkedin\.com)/\S*"
)

# Full URL / link-only line. Used by ``run_apply`` to skip text matching and
# fall back to building-name lookup only.
LINK_ONLY_RE = re.compile(r"^https?://\S+$")

# PostgREST default page size for paginated fetches.
PAGE = 1000

# Confidence ranks. Anything below ``RANK[_min]`` is dropped by both
# ``backfill_localities.py``'s ``--min-confidence`` filter (default
# "medium") and by any future runtime caller that wants to honour the
# same house rule.
_RANKS = {"low": 0, "medium": 1, "high": 2}


def rank(confidence: str | None) -> int:
    """Map a confidence label to a comparable rank. Unknown labels = 0."""
    if not confidence:
        return 0
    return _RANKS.get(confidence.strip().lower(), 0)


def meets_minimum(confidence: str | None, minimum: str) -> bool:
    """Return True if *confidence* is at or above *minimum* (ranked)."""
    r_min = rank(minimum)
    if r_min == 0:
        # Anything is acceptable when minimum is unknown / empty.
        return True
    return rank(confidence) >= r_min


def fetch_reference_data(db: Any) -> dict[str, list[dict]]:
    """Fetch every row of the three reference tables.

    Returns a dict with keys ``locality_reference``, ``buildings``,
    ``building_name_aliases``. Page-aware so the response is correct even
    when a reference table grows past PostgREST's 1000-row default.
    """
    return {
        "locality_reference": _fetch_all(
            db, "locality_reference", "sub_locality, parent_locality, confidence"
        ),
        "buildings": _fetch_all(
            db,
            "buildings",
            "canonical_name, micro_market",
            filters=[("micro_market", "not.is", "null"), ("micro_market", "neq", "")],
        ),
        "building_name_aliases": _fetch_all(
            db, "building_name_aliases", "alias, canonical_name"
        ),
    }


def _fetch_all(db: Any, table: str, columns: str, filters: list[tuple] | None = None) -> list[dict]:
    """Paginate through PostgREST's 1000-row limit when reading a table."""
    rows: list[dict] = []
    offset = 0
    while True:
        q = db.table(table).select(columns)
        if filters:
            for col, op, val in filters:
                if op == "not.is":
                    q = q.not_.is_(col, val)
                elif op == "neq":
                    q = q.neq(col, val)
        q = q.order("id").offset(offset).limit(PAGE)
        page = q.execute().data or []
        rows.extend(page)
        if len(page) < PAGE:
            break
        offset += PAGE
    return rows


class LocalityResolver:
    """In-memory locality resolver. Pre-loaded from reference tables.

    Construction runs three paginated selects (≤3 round-trips total). All
    decisions afterwards are constant-time map lookups.
    """

    def __init__(self, db: Any, *, reference: dict[str, list[dict]] | None = None) -> None:
        self.db = db
        if reference is None:
            reference = fetch_reference_data(db)
        self._reference = reference

        # locality_reference: text → {parent_locality, confidence}
        self.loc_ref_by_sub: dict[str, dict] = {}
        for row in reference["locality_reference"]:
            sub = (row.get("sub_locality") or "").strip()
            if sub:
                self.loc_ref_by_sub[sub.lower()] = row
            for alternate in row.get("alternate_names") or []:
                alternate = (alternate or "").strip()
                if alternate:
                    self.loc_ref_by_sub[alternate.lower()] = row

        # buildings: lowercase canonical_name → micro_market
        self.building_map: dict[str, str] = {}
        for row in reference["buildings"]:
            name = (row.get("canonical_name") or "").strip()
            market = (row.get("micro_market") or "").strip()
            if name and market:
                self.building_map[name.lower()] = market

        # building_name_aliases: lowercase alias → lowercase canonical_name
        self.alias_map: dict[str, str] = {}
        for row in reference["building_name_aliases"]:
            alias = (row.get("alias") or "").strip()
            canonical = (row.get("canonical_name") or "").strip()
            if alias and canonical:
                self.alias_map[alias.lower()] = canonical.lower()

    @property
    def stats(self) -> dict[str, int]:
        """Surface the load sizes so test fixtures can assert on them."""
        return {
            "locality_reference": len(self.loc_ref_by_sub),
            "buildings": len(self.building_map),
            "building_name_aliases": len(self.alias_map),
        }

    def resolve_from_text(self, text: str) -> dict | None:
        """Match a free-form message against ``locality_reference``.

        Returns ``None`` if the text is too short (<5 chars), is just a
        URL, or matches no known sub-locality. Otherwise::

            {
                "resolved_locality": "<parent_locality>",
                "confidence": "high" | "medium" | "low" | row.confidence,
                "source": "text_reference_match",
                "matched_sub": "<original sub_locality>",
            }
        """
        if not text or len(text.strip()) < 5:
            return None

        cleaned = EXTERNAL_LINK_RE.sub("", text).strip()
        if not cleaned:
            return None

        text_lower = cleaned.lower()
        for sub_lower, row in self.loc_ref_by_sub.items():
            if len(sub_lower) >= 4 and sub_lower in text_lower:
                return {
                    "resolved_locality": row["parent_locality"],
                    "confidence": (row.get("confidence") or "medium"),
                    "source": "text_reference_match",
                    "matched_sub": row["sub_locality"],
                }
        return None

    def resolve_from_building(self, building_name: str | None) -> dict | None:
        """Look up a building name against ``buildings`` then aliases.

        Returns ``None`` if neither direct lookup nor alias resolution
        finds anything. The alias path returns ``confidence="medium"``
        because aliases are an extra hop; the direct path returns
        ``confidence="high"`` because ``buildings`` is the source of
        truth.
        """
        if not building_name or not building_name.strip():
            return None

        name = building_name.strip().lower()
        market = self.building_map.get(name)
        if market:
            return {
                "resolved_locality": market,
                "confidence": "high",
                "source": "buildings_table",
                "matched_sub": None,
            }

        canonical = self.alias_map.get(name)
        if canonical:
            market = self.building_map.get(canonical)
            if market:
                return {
                    "resolved_locality": market,
                    "confidence": "medium",
                    "source": "building_name_aliases",
                    "matched_sub": None,
                }
        return None
