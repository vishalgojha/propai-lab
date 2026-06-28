"""
Structured location parser for PropAI.

Tokenizes free-text location strings into typed, resolved geographic signals
using the evidence engine's known landmarks, micro markets, and spatial relations.

Input:  "in Bandra near Lilavati Hospital, 500m from station"
Output: {
    "micro_market": "Bandra West",
    "locality": "Bandra",
    "landmark": "Lilavati Hospital",
    "spatial_relation": "near",
    "distance_m": 500,
    "transit_landmark": "station",
    "city": "Mumbai",
}
"""

from __future__ import annotations

import math
import re
from difflib import SequenceMatcher
from typing import Optional

# ── Spatial relation patterns (ordered longest-first for greedy match) ──

_SPATIAL_RELATIONS = [
    ("walking distance from", "walking distance"),
    ("walking distance to", "walking distance"),
    ("walking distance", "walking distance"),
    ("around the corner from", "near"),
    ("around the corner", "near"),
    ("close to", "near"),
    ("adjacent to", "adjacent"),
    ("next to", "next to"),
    ("opposite", "opposite"),
    ("facing", "facing"),
    ("behind", "behind"),
    ("beside", "beside"),
    ("across", "across"),
    ("nearby", "near"),
    ("near", "near"),
    ("off", "off"),
    ("above", "above"),
    ("below", "below"),
]

# ── Distance pattern ──

_DISTANCE_RE = re.compile(
    r'(\d+[\d,]*\.?\d*)\s*(km|kms|kilometer|kilometre|kilometers|kilometres|'
    r'm|mtr|metre|meter|metres|meters|min|mins|minutes)\b',
    re.IGNORECASE,
)

# ── Transit landmark keywords ──

_TRANSIT_KEYWORDS = frozenset({
    "station", "railway station", "metro", "metro station", "bus stop",
    "bus stand", "airport", "railway", "rail",
})

# ── Common city names ──

_CITIES = frozenset({
    "mumbai", "navi mumbai", "thane", "pune", "delhi", "bangalore",
    "bengaluru", "hyderabad", "chennai", "kolkata", "ahmedabad",
    "gurgaon", "noida", "jaipur", "goa",
})

# ── Building indicator keywords ──

_BUILDING_INDICATORS = frozenset({
    "tower", "towers", "building", "residency", "heights", "park",
    "enclave", "garden", "villa", "villas", "palace", "court",
    "house", "apartment", "complex", "plaza", "chambers",
    "corporation", "building", "heritage",
})

# ── Stop words to skip in location text ──

_STOP = frozenset({
    "a", "an", "the", "in", "at", "on", "for", "with", "and", "&",
    "of", "to", "is", "are", "this", "that", "it", "its", "has",
    "have", "been", "being", "from", "by",
})

_GENERIC_LOCATION_PHRASES = frozenset({
    "rent", "rental", "on rent", "for rent", "lease", "on lease",
    "sale", "sell", "for sale", "available", "available on rent",
    "available for rent", "available on sale", "available for sale",
    "direct inventory", "inventory", "urgent", "urgently",
})

_COMMON_MUMBAI_LOCALITIES = frozenset({
    "andheri", "andheri west", "andheri east", "bandra", "bandra west",
    "bandra east", "bkc", "santacruz", "santacruz west", "santacruz east",
    "khar", "khar west", "juhu", "malad", "malad west", "goregaon",
    "goregaon west", "worli", "parel", "lower parel", "dadar", "powai",
    "versova", "vile parle", "chembur", "mahalaxmi", "prabhadevi",
    "oshiwara", "lokhandwala", "mount mary", "pali hill", "turner road",
    "carter road", "hill road", "linking road",
})


# ── Token match result ──

class LocationToken:
    """A single token extracted from location text."""
    def __init__(self, text: str, kind: str, value: str | None = None,
                 score: float = 1.0, meta: dict | None = None):
        self.text = text
        self.kind = kind          # micro_market, locality, landmark, building,
                                  # spatial_relation, distance, transit_landmark,
                                  # city, street, unknown
        self.value = value or text
        self.score = score
        self.meta = meta or {}

    def __repr__(self) -> str:
        return f"Token({self.text!r}, {self.kind}, val={self.value!r})"


# ── Structured location output ──

class StructuredLocation:
    """Resolved, structured location from a message."""
    def __init__(self):
        self.city: Optional[str] = None
        self.micro_market: Optional[str] = None
        self.locality: Optional[str] = None
        self.building: Optional[str] = None
        self.landmark: Optional[str] = None
        self.transit_landmark: Optional[str] = None
        self.street: Optional[str] = None
        self.spatial_relation: Optional[str] = None
        self.distance_m: Optional[float] = None
        self.distance_text: Optional[str] = None
        self.tokens: list[dict] = []
        self.raw: str = ""

    def to_dict(self) -> dict:
        return {
            "city": self.city,
            "micro_market": self.micro_market,
            "locality": self.locality,
            "building": self.building,
            "landmark": self.landmark,
            "transit_landmark": self.transit_landmark,
            "street": self.street,
            "spatial_relation": self.spatial_relation,
            "distance_m": self.distance_m,
            "distance_text": self.distance_text,
            "tokens": self.tokens,
            "raw": self.raw,
        }

    @staticmethod
    def from_dict(d: dict) -> "StructuredLocation":
        loc = StructuredLocation()
        loc.city = d.get("city")
        loc.micro_market = d.get("micro_market")
        loc.locality = d.get("locality")
        loc.building = d.get("building")
        loc.landmark = d.get("landmark")
        loc.transit_landmark = d.get("transit_landmark")
        loc.street = d.get("street")
        loc.spatial_relation = d.get("spatial_relation")
        loc.distance_m = d.get("distance_m")
        loc.distance_text = d.get("distance_text")
        loc.tokens = d.get("tokens", [])
        loc.raw = d.get("raw", "")
        return loc


# ═══════════════════════════════════════════════════════════════════
# Evidence engine integration
# ═══════════════════════════════════════════════════════════════════

_evidence_loaded = False
_landmarks_by_name: dict[str, dict] = {}
_landmarks_by_alias: dict[str, dict] = {}
_landmarks_list: list[dict] = []
_buildings: dict[str, dict] = {}
_buildings_by_alias: dict[str, dict] = {}
_micro_markets: set[str] = set()
_localities: set[str] = set()


def _load_evidence():
    global _evidence_loaded, _landmarks_by_name, _landmarks_by_alias
    global _landmarks_list, _buildings, _buildings_by_alias
    global _micro_markets, _localities
    if _evidence_loaded:
        return
    try:
        from evidence.resolver import CACHE, _load_registry, _load_landmarks
        _load_registry()
        _load_landmarks()
        _landmarks_by_name = CACHE.get("landmarks_by_name", {})
        _landmarks_by_alias = CACHE.get("landmarks_by_alias", {})
        _landmarks_list = CACHE.get("landmarks_list", [])
        _buildings = CACHE.get("buildings", {})
        _buildings_by_alias = CACHE.get("buildings_by_alias", {})
        # Extract micro markets from landmarks
        for lm in _landmarks_list:
            mm = lm.get("micro_market")
            if mm:
                _micro_markets.add(mm.lower())
        # Extract locality names from micro markets
        for mm in _micro_markets:
            for part in mm.split():
                p = part.strip(" -")
                if len(p) > 2:
                    _localities.add(p.lower())
        # Also add micro markets themselves as potential localities
        _localities.update(_micro_markets)
        _localities.update(_COMMON_MUMBAI_LOCALITIES)
        _evidence_loaded = True
    except Exception:
        _localities.update(_COMMON_MUMBAI_LOCALITIES)
        pass


# ═══════════════════════════════════════════════════════════════════
# Location extraction from raw message text
# ═══════════════════════════════════════════════════════════════════

def extract_location_text(raw_text: str) -> str | None:
    """
    Extract the location substring from a raw message.
    Captures everything from the first location trigger keyword until
    price/contact/broker/noise appears.
    Keeps distance phrases (e.g. "500m from station") which contain commas
    but aren't price boundaries.
    """
    text = raw_text.strip()
    lower = text.lower()
    _load_evidence()

    def usable_candidate(candidate: str | None) -> bool:
        if not candidate:
            return False
        normalized = re.sub(r'[*_`~]', '', candidate).strip(" \t,.-:").lower()
        normalized = re.sub(r'\s+', ' ', normalized)
        if len(normalized) < 3 or normalized in _GENERIC_LOCATION_PHRASES:
            return False
        if re.fullmatch(r'(?:on|for)?\s*(?:rent|sale|lease|sell|buy|requirement)s?', normalized):
            return False
        if re.fullmatch(r'(?:rent|sale|lease|available|direct|inventory|urgent|urgently)[\s\W]*', normalized):
            return False
        return True

    def clean_candidate(candidate: str) -> str:
        rest = re.sub(r'[*_`~]', '', candidate).strip(" \t:-")
        boundaries = []
        boundary_patterns = [
            r'\n',
            r'\bcontact\b',
            r'\bcall\b',
            r'\bwhatsapp\b',
            r'\bprice\b',
            r'\bstarting\b',
            r'\bstarts?\b',
            r'\bmax\b',
            r'₹',
            r'\brs\.?\b',
            r'\bbudget\b',
            r'\bfor\s+sale\b',
            r'\bfor\s+rent\b',
            r'\bcr(?:ore)?\b',
            r'\bl(?:ac|akh|acs)?\b',
            r'/-',
            r'\bonly\b',
            r'\bbroker\b',
        ]
        for pat in boundary_patterns:
            m = re.search(pat, rest, re.IGNORECASE)
            if m:
                boundaries.append(m.start())
        # Keep comma-separated distance phrases, but stop before the next clause.
        for ci in [m.start() for m in re.finditer(',', rest)]:
            before = rest[:ci].strip()
            if re.search(r'\d+\s*(?:km|kms|m|mtr|min)\s*$', before, re.IGNORECASE):
                continue
            boundaries.append(ci)

        if boundaries:
            rest = rest[:min(boundaries)].strip()
        rest = re.sub(
            r'\s+\d[\d,.]*(?:\s*(?:cr|crore|lac|lakh|k|thousand))?.*',
            '', rest, count=1, flags=re.IGNORECASE
        ).strip(" \t,.-")
        for noise in ["distance from ", "distance to ",
                      "walking distance from ", "walking distance to "]:
            if rest.lower().startswith(noise):
                rest = rest[len(noise):].strip()
        rest = re.sub(
            r'^(?:available|direct inventory|inventory|urgent|urgently|sale|sell|rent|rental|'
            r'on\s+rent|for\s+rent|on\s+lease|for\s+lease|on\s+sale|for\s+sale|'
            r'apt|flat|office|space|property)\b\s*',
            '',
            rest,
            flags=re.IGNORECASE,
        ).strip(" \t,.-:")
        rest = re.sub(r'^(?:in|at|near)\s+', '', rest, flags=re.IGNORECASE).strip()
        return rest

    def known_location_candidate() -> str | None:
        candidates = sorted(
            {x for x in (_localities | _micro_markets) if len(x) >= 4},
            key=len,
            reverse=True,
        )
        for name in candidates:
            m = re.search(rf'\b{re.escape(name)}\b', lower)
            if not m:
                continue
            start = max(0, m.start() - 45)
            end = min(len(text), m.end() + 90)
            prefix = text[start:m.start()]
            cut = max(prefix.rfind("\n"), prefix.rfind(","), prefix.rfind("*"))
            if cut >= 0:
                start = start + cut + 1
            suffix = text[m.end():end]
            next_breaks = [idx for idx in (suffix.find("\n"), suffix.find(",")) if idx >= 0]
            if next_breaks:
                end = m.end() + min(next_breaks)
            candidate = clean_candidate(text[start:end])
            candidate = re.sub(
                r'^(?:available|direct inventory|inventory|urgent|urgently|sale|sell|rent|rental|on rent|for rent|on sale|for sale|apt|flat|office|space)\b\s*',
                '',
                candidate,
                flags=re.IGNORECASE,
            ).strip(" \t,.-:")
            if usable_candidate(candidate):
                return candidate
        return None

    # Requirement shorthand should prefer the desired area after BHK over
    # secondary landmarks like "near Metro".
    if re.search(r'\b(?:need|require|requirement|tenant|client|wanted|looking\s+for)\b', lower):
        bhk_loc = re.search(
            r'\b(?:need|require|want|wanted|looking\s+for|client\s+requirement|tenant\s+need)?\s*'
            r'(?:\d+(?:\.\d+)?\s*(?:bhk|rk|bedroom)|studio)\s+(.+)$',
            text,
            re.IGNORECASE | re.DOTALL,
        )
        if bhk_loc:
            rest = clean_candidate(bhk_loc.group(1))
            if (
                usable_candidate(rest)
                and not re.match(r'^(?:starting|start(?:s)?|price|budget|from|max)\b', rest, re.IGNORECASE)
            ):
                return rest

    known = known_location_candidate()
    if known:
        return known

    loc_keywords = [
        r'at', r'in', r'near', r'opposite', r'opp\.?', r'behind', r'off',
        r'walkable', r'walking', r'walk', r'location', r'area',
        r'distance\s+from', r'distance\s+to',
    ]
    for kw in loc_keywords:
        m = re.search(rf'(?<![A-Za-z]){kw}\s+', lower)
        if m:
            rest = clean_candidate(text[m.end():])
            if usable_candidate(rest):
                return rest

    # Common requirement shorthand: "Need 2 BHK Bandra Budget 3 Cr".
    bhk_loc = re.search(
        r'\b(?:need|require|want|wanted|looking\s+for|client\s+requirement)?\s*'
        r'(?:\d+(?:\.\d+)?\s*(?:bhk|rk|bedroom)|studio)\s+(.+)$',
        text,
        re.IGNORECASE | re.DOTALL,
    )
    if bhk_loc:
        rest = clean_candidate(bhk_loc.group(1))
        if (
            usable_candidate(rest)
            and not re.match(r'^(?:starting|start(?:s)?|price|budget|from|max)\b', rest, re.IGNORECASE)
        ):
            return rest

    # Launch/listing cards often put the project and market on their own line.
    for line in [l.strip() for l in text.splitlines() if l.strip()]:
        if re.search(r'\b(?:bhk|cr|crore|lac|lakh|budget|contact|call)\b|\d{10}', line, re.IGNORECASE):
            continue
        if re.search(r'\b(?:launch|booking|owner|sale|rent|requirement|forwarded)\b', line, re.IGNORECASE):
            continue
        if usable_candidate(line):
            return clean_candidate(line)
    return None


# ═══════════════════════════════════════════════════════════════════
# Tokenizer
# ═══════════════════════════════════════════════════════════════════

def _tokenize(text: str) -> list[str]:
    """Split location text into segments."""
    segments = []
    for part in re.split(r'\s*,\s*|\s+and\s+|\s*&\s*', text):
        part = part.strip()
        if part and len(part) >= 2:
            segments.append(part)
    return segments


def _match_spatial_relation(text: str) -> tuple[str | None, str | None]:
    """Match a spatial relation at the start of text. Returns (matched_text, relation)."""
    lower = text.lower().strip()
    for pattern, relation in _SPATIAL_RELATIONS:
        if lower.startswith(pattern):
            return pattern, relation
    return None, None


def _match_distance(text: str) -> tuple[float | None, str | None, str | None]:
    """Match distance at the start of text. Returns (meters, distance_text, remaining)."""
    m = _DISTANCE_RE.match(text.strip())
    if m:
        val = float(m.group(1).replace(",", ""))
        unit = m.group(2).lower()
        if unit in ("km", "kms", "kilometer", "kilometre", "kilometers", "kilometres"):
            meters = val * 1000
        else:
            meters = val
        return meters, m.group(0), text[m.end():].strip()
    return None, None, None


def _fuzzy_match(item: str, candidates: dict[str, any],
                 threshold: float = 0.80) -> tuple[str | None, float]:
    """Fuzzy match item against candidate keys."""
    item_lower = item.lower().strip()
    best_key = None
    best_ratio = 0.0
    for key in candidates:
        m = SequenceMatcher(None, item_lower, key.lower().strip()).ratio()
        if m > best_ratio:
            best_ratio = m
            best_key = key
    if best_key and best_ratio >= threshold:
        return best_key, best_ratio
    return None, 0.0


def _match_known_entity(text: str) -> tuple[LocationToken | None, str]:
    """
    Try to match the longest known entity at the start of text.
    Returns (token, remaining_text).
    Priority: micro markets > landmarks > buildings > localities > cities.
    """
    lower = text.lower().strip()

    # 1. Micro market match (highest priority — avoid partial building matches)
    mms_sorted = sorted(_micro_markets, key=len, reverse=True)
    for mm in mms_sorted:
        if lower.startswith(mm):
            rest = lower[len(mm):].strip()
            return (
                LocationToken(
                    text=mm,
                    kind="micro_market",
                    value=mm.title(),
                    meta={"micro_market": mm.title()},
                ),
                rest,
            )

    # 2. Landmark match (by name or alias)
    for name in sorted(_landmarks_by_name, key=len, reverse=True):
        if lower.startswith(name):
            info = _landmarks_by_name[name]
            rest = lower[len(name):].strip()
            return (
                LocationToken(
                    text=name,
                    kind="landmark",
                    value=info.get("name", name),
                    meta={
                        "landmark_id": info.get("landmark_id"),
                        "micro_market": info.get("micro_market"),
                        "zone": info.get("zone"),
                    },
                ),
                rest,
            )
    for alias in sorted(_landmarks_by_alias, key=len, reverse=True):
        if lower.startswith(alias):
            info = _landmarks_by_alias[alias]
            rest = lower[len(alias):].strip()
            return (
                LocationToken(
                    text=alias,
                    kind="landmark",
                    value=info.get("name", alias),
                    meta={
                        "landmark_id": info.get("landmark_id"),
                        "micro_market": info.get("micro_market"),
                        "zone": info.get("zone"),
                    },
                ),
                rest,
            )

    # 3. Building match (skip single-word short names to avoid false positives)
    for name in sorted(_buildings, key=len, reverse=True):
        if len(name.split()) < 2 and len(name) <= 4:
            continue
        if lower.startswith(name):
            info = _buildings[name]
            rest = lower[len(name):].strip()
            return (
                LocationToken(
                    text=name,
                    kind="building",
                    value=info.get("canonical_name", name),
                    meta={
                        "building_id": info.get("building_id"),
                        "area": info.get("area"),
                        "developer": info.get("developer"),
                    },
                ),
                rest,
            )

    # 4. Locality match
    loc_sorted = sorted(_localities, key=len, reverse=True)
    for loc in loc_sorted:
        lower_loc = loc.lower().strip()
        if lower.startswith(lower_loc) and lower_loc not in _STOP and len(lower_loc) > 2:
            rest = lower[len(lower_loc):].strip()
            return (
                LocationToken(
                    text=loc,
                    kind="locality",
                    value=loc.title(),
                ),
                rest,
            )

    # 5. City match
    for city in _CITIES:
        if lower.startswith(city):
            rest = lower[len(city):].strip()
            return (
                LocationToken(
                    text=city,
                    kind="city",
                    value=city.title(),
                ),
                rest,
            )

    return None, text


# ═══════════════════════════════════════════════════════════════════
# Main parser
# ═══════════════════════════════════════════════════════════════════

def parse_location(raw_text: str) -> StructuredLocation:
    """
    Parse a raw message text and return a structured location object.
    """
    _load_evidence()
    loc = StructuredLocation()
    loc.raw = extract_location_text(raw_text) or ""
    if not loc.raw:
        return loc

    segments = _tokenize(loc.raw)
    tokens: list[LocationToken] = []

    for segment in segments:
        remaining = segment
        seg_tokens: list[LocationToken] = []

        # Iteratively consume tokens from remaining text
        while remaining:
            remaining = remaining.strip()
            if not remaining or len(remaining) <= 2:
                break

            # Skip stop words
            skip = re.match(r'^(in|at|on|the|a|an|for|to|of)\s+', remaining, re.IGNORECASE)
            if skip:
                remaining = remaining[skip.end():].strip()
                continue

            # 1. Distance at start
            dist_m, dist_text, dist_rest = _match_distance(remaining)
            if dist_m is not None:
                seg_tokens.append(LocationToken(
                    text=dist_text,
                    kind="distance",
                    value=f"{dist_m:.0f}m",
                    meta={"distance_m": dist_m},
                ))
                loc.distance_m = dist_m
                loc.distance_text = dist_text
                remaining = dist_rest
                continue

            # 2. Spatial relation at start
            rel_text, relation = _match_spatial_relation(remaining)
            if rel_text:
                seg_tokens.append(LocationToken(
                    text=rel_text,
                    kind="spatial_relation",
                    value=relation,
                ))
                loc.spatial_relation = relation
                remaining = remaining[len(rel_text):].strip()
                continue

            # 3. "from [entity]" pattern
            from_m = re.match(r'from\s+(.+)', remaining, re.IGNORECASE)
            if from_m:
                after_from = from_m.group(1).strip()
                # Check if transit keyword
                tl_lower = after_from.lower().rstrip(".,")
                if tl_lower in _TRANSIT_KEYWORDS or \
                   any(kw in tl_lower for kw in _TRANSIT_KEYWORDS):
                    seg_tokens.append(LocationToken(
                        text=after_from,
                        kind="transit_landmark",
                        value=after_from,
                    ))
                    loc.transit_landmark = after_from
                    remaining = ""
                    continue
                else:
                    match_token, rest = _match_known_entity(after_from)
                    if match_token:
                        seg_tokens.append(match_token)
                        remaining = rest
                        continue
                    else:
                        remaining = after_from
                        continue

            # 4. Known entity match
            match_token, remaining_after = _match_known_entity(remaining)
            if match_token:
                seg_tokens.append(match_token)
                remaining = remaining_after
                continue

            # 5. Unknown — extract first word as locality, continue
            words = remaining.split()
            found = False
            for i in range(1, min(len(words) + 1, 4)):
                candidate = " ".join(words[:i]).strip(".,")
                match_token, remaining_after = _match_known_entity(" ".join(words[i:]))
                if match_token:
                    if len(candidate) > 2:
                        seg_tokens.append(LocationToken(
                            text=candidate,
                            kind="locality",
                            value=candidate.title(),
                        ))
                    seg_tokens.append(match_token)
                    remaining = remaining_after
                    found = True
                    break
            if found:
                continue

            # Nothing matched — take first word(s) as locality
            first_word = words[0].strip(".,")
            if len(first_word) > 2 and first_word.lower() not in _STOP:
                seg_tokens.append(LocationToken(
                    text=first_word,
                    kind="locality",
                    value=first_word.title(),
                ))
            remaining = " ".join(words[1:])

        # Filter noise
        seg_tokens = [t for t in seg_tokens
                      if t.text.lower().strip(" ,.") not in ("at", "in", "on", "the", "a", "an")]
        tokens.extend(seg_tokens)

    # ── Resolve tokens into structured fields ──
    for t in tokens:
        if t.kind == "city" and not loc.city:
            loc.city = t.value
        elif t.kind == "micro_market" and not loc.micro_market:
            loc.micro_market = t.value
        elif t.kind == "locality" and not loc.locality:
            loc.locality = t.value
        elif t.kind == "landmark" and not loc.landmark:
            loc.landmark = t.value
            # Enrich micro_market from landmark meta
            mm = t.meta.get("micro_market")
            if mm and not loc.micro_market:
                loc.micro_market = mm
            # If no locality but landmark has micro_market, extract locality
            if not loc.locality and mm:
                loc.locality = mm.split()[0]
        elif t.kind == "building" and not loc.building:
            loc.building = t.value
        elif t.kind == "transit_landmark" and not loc.transit_landmark:
            loc.transit_landmark = t.value
        elif t.kind == "spatial_relation" and not loc.spatial_relation:
            loc.spatial_relation = t.value

    # Set city default
    if not loc.city:
        micro = (loc.micro_market or "").lower()
        if any(c in micro for c in ["mumbai", "bandra", "andheri", "powai", "worli",
                                     "juhu", "parel", "dadar", "ghatkopar",
                                     "goregaon", "borivali", "kandivali",
                                     "khar", "santacruz", "vile", "versova",
                                     "thane", "navi"]):
            loc.city = "Mumbai"
        elif "pune" in micro:
            loc.city = "Pune"

    loc.tokens = [{"text": t.text, "kind": t.kind, "value": t.value, "meta": t.meta}
                   for t in tokens]
    return loc
