"""Multi-listing message classifier, hierarchical parser, and section splitter.

Detects document-level hierarchy (project, tower, wing), validates
building names, extracts property attributes, and splits messages
into individual parsed listings with inherited context.
"""

import re
from typing import Callable

# ── Classification ──────────────────────────────────────────────────

_DIVIDER_RE = re.compile(r'^_{3,}$|^={3,}$|^[-–—]{3,}$|^__{3,}|^\*{3,}$|^⸻$')
_TITLE_CASE_BUILDING_RE = re.compile(r'^\s*🏢\s*([A-Z][A-Za-z .]+(?: [A-Z][A-Za-z .]*)*)')
_UNNUMBERED_BLOCK_START_RE = re.compile(
    r'^\s*(?:[*_`~\s]*)?('
    r'available\s+for\s+(?:\d+(?:\.\d+)?\s*(?:bhk|rk)\s+)?(?:rent|sale|lease)|'
    r'premium\s*/?\s*residential\s+property\s+available|'
    r'.*\bavailable\s+for\s+(?:\d+(?:\.\d+)?\s*(?:bhk|rk)\s+)?(?:rent|sale|lease)\b'
    r')',
    re.I,
)

_AVAILABLE_BHK_RELATION_RE = re.compile(
    r'\bavailable\s+for\s+(?:\d+(?:\.\d+)?\s*(?:bhk|rk)\s+)?(?:rent|sale|lease)\b.*?\b(?:in|at)\b',
    re.I,
)

_KNOWN_LOCALITIES = {"bandra", "bandra west", "bandra east", "andheri", "andheri west", "andheri east", "santacruz", "santacruz west", "santacruz east", "khar", "juhu", "goregaon", "goregaon east", "goregaon west", "malad", "worli", "powai", "bkc", "lokhandwala", "versova", "vile parle", "kurla", "ghatkopar", "mulund", "thane", "vashi", "nerul", "belapur", "kharghar", "wadala", "prabhadevi", "lower parel", "dadar", "mahim", "matunga", "sion", "kings circle", "byculla", "marine lines", "churchgate", "colaba", "cuffe parade", "walkeshwar", "malabar hill", "peddar road", "altamount road", "nepean sea road", "breach candy", "tardeo", "grant road", "mumbai central", "pali hill", "mount mary", "bandstand", "chapel road", "turner road", "waterfield road", "linking road", "sv road", "marve road", "new link road", "oshiwara", "jogeshwari", "kandivali", "borivali", "dahisar", "mira road", "bhayandar", "vasai", "virar", "panvel", "kamothe", "new panvel", "ulwe", "ghansoli", "rabale", "airoli", "koparkhairane", "ghodbunder road", "kolshet road", "pokhran road", "hiranandani", "kasarvadavali", "manpada", "dombivili", "kalyan", "ambarnath", "badlapur", "karjat", "neral", "chandivali", "shastri nagar", "jp road", "dn nagar"}

# ── Property Attribute Patterns ──────────────────────────────────
# These should NEVER be classified as building names

_FLOOR_DESCRIPTIONS = frozenset({
    "lower floor", "lower flr", "lower fl", "low floor", "low flr",
    "middle floor", "mid floor", "mid flr",
    "higher floor", "higher flr", "high floor", "high flr",
    "upper floor", "upper flr", "upper fl",
    "ground floor", "ground flr", "gf",
    "top floor", "top flr",
    "podium", "podium floor", "podium flr",
    "basement", "basement floor",
    "terrace floor", "terrace flr",
    "stilt", "stilt floor",
})

_VIEW_DESCRIPTIONS = frozenset({
    "amenities facing", "amenities view",
    "back facing", "back side",
    "sea facing", "sea view", "sea face",
    "road facing", "road view", "main road facing",
    "garden facing", "garden view", "park facing", "park view",
    "city facing", "city view",
    "pool facing", "pool view",
    "lake facing", "lake view",
    "valley facing", "valley view",
    "open facing", "open view", "open side",
    "east facing", "west facing", "north facing", "south facing",
    "north east facing", "north-west facing",
    "south east facing", "south-west facing",
})

_ORIENTATIONS = frozenset({
    "north facing", "south facing", "east facing", "west facing",
    "north-east facing", "north west facing",
    "south-east facing", "south west facing",
    "north east", "north west", "south east", "south west",
})

_POSITIONS = frozenset({
    "corner", "corner unit", "corner property",
    "end unit", "end property",
    "middle unit",
})

# Combined set of impossible building values
_IMPOSSIBLE_BUILDINGS = _FLOOR_DESCRIPTIONS | _VIEW_DESCRIPTIONS | _ORIENTATIONS | _POSITIONS | frozenset({
    "fully furnished", "semi furnished", "unfurnished",
    "semi-furnished", "fully-furnished",
    "furnished", "un furnished",
    "plug and play", "plug & play", "bare shell",
    "rent", "sale", "lease", "commercial", "office", "shop",
    "available", "available for rent", "available for sale",
    "immediate possession", "ready possession",
    "new launch", "pre launch", "pre-launch",
    "prime location", "premium location",
    "under construction",
})

_FLOOR_RE = re.compile(
    r'\b(' + '|'.join(re.escape(d) for d in sorted(_FLOOR_DESCRIPTIONS, key=len, reverse=True)) + r')\b',
    re.I
)

_VIEW_RE = re.compile(
    r'\b(' + '|'.join(re.escape(v) for v in sorted(_VIEW_DESCRIPTIONS, key=len, reverse=True)) + r')\b',
    re.I
)

_POSITION_RE = re.compile(
    r'\b(' + '|'.join(re.escape(p) for p in sorted(_POSITIONS, key=len, reverse=True)) + r')\b',
    re.I
)

# Hierarchical context patterns
_PROJECT_HEADER_RE = re.compile(
    r'^\s*(?:project|project name|project\s*[-–:])?\s*[-–:]\s*'
    r'([A-Z][A-Za-z0-9 .&\'\-]+(?:\s+[A-Z][A-Za-z0-9 .&\'\-]+)+)',
    re.I
)

_TOWER_HEADER_RE = re.compile(
    r'^\s*(?:(?:tower|towre)\s*[-–:]\s*([A-Z])|'
    r'([A-Z])\s*[-–]?\s*(?:tower|towre))\s*$',
    re.I
)

_WING_HEADER_RE = re.compile(
    r'^\s*(?:(?:wing|wng)\s*[-–:]\s*([A-Z])|'
    r'([A-Z])\s*[-–]?\s*(?:wing|wng))\s*$',
    re.I
)

# Property attribute extraction from lines
_PROPERTY_FLOOR_RE = re.compile(
    r'(?:floor|flr|fl)\s*[-–:]\s*(.+)', re.I
)

# ── Building Name Validation ─────────────────────────────────────

def validate_building_name(name: str | None) -> str | None:
    """Return None if name is an impossible building value (floor, view, furnishing, etc.)"""
    if not name or len(name.strip()) < 3:
        return None
    lower = name.strip().lower()
    # Check against known impossible values
    if lower in _IMPOSSIBLE_BUILDINGS:
        return None
    # Check pattern matches (e.g. "3BHK" as building)
    if re.match(r'^\d+\s*(bhk|rk|bedroom|sqft|sq\s*ft|sft)\b', lower):
        return None
    # Check if it's a price string (with optional currency prefix)
    if re.match(r'^(?:rs\.?\s*|inr\s*|usd\s*|[₹$€])\s*[\d,.]+\s*(cr|crore|lac|lakh|l|k|thousand)\b', lower):
        return None
    # Check if it's a furnishing-only string
    if re.match(r'^(fully|semi|un)\s*-?\s*(furnished|fur)\b', lower):
        return None
    return name.strip()


def extract_property_attributes(text: str) -> dict:
    """Extract floor_description, view, orientation, position from text."""
    result: dict = {
        "floor_description": None,
        "view": None,
        "orientation": None,
        "position": None,
    }
    lower = text.lower()

    # Floor
    floor_match = _FLOOR_RE.search(lower)
    if floor_match:
        result["floor_description"] = floor_match.group(0).strip().title()

    # View
    view_match = _VIEW_RE.search(lower)
    if view_match:
        result["view"] = view_match.group(0).strip().title()

    # Orientation (prefer specific over general facing)
    for orient in sorted(_ORIENTATIONS, key=len, reverse=True):
        if orient in lower:
            result["orientation"] = orient.title()
            break

    # Position
    pos_match = _POSITION_RE.search(lower)
    if pos_match:
        result["position"] = pos_match.group(0).strip().title()

    return result


def extract_hierarchical_context(text: str) -> dict:
    """Extract document-level hierarchical context from message text.

    Returns dict with project_name, tower_name, wing_name, section_intent.
    """
    result: dict = {
        "project_name": None,
        "tower_name": None,
        "wing_name": None,
        "section_intent": None,
    }
    lines = text.strip().split("\n")
    for line in lines:
        stripped = line.strip()

        # Project header
        m = _PROJECT_HEADER_RE.search(stripped)
        if m:
            candidate = m.group(1).strip()
            if len(candidate) >= 5 and not any(
                kw in candidate.lower() for kw in
                ("rent", "sale", "bhk", "sqft", "floor", "facing", "furnished", "available")
            ):
                result["project_name"] = candidate

        # Tower header
        m = _TOWER_HEADER_RE.search(stripped)
        if m:
            letter = (m.group(1) or m.group(2) or "").strip()
            if letter:
                result["tower_name"] = letter.upper() + " Tower"

        # Wing header
        m = _WING_HEADER_RE.search(stripped)
        if m:
            letter = (m.group(1) or m.group(2) or "").strip()
            if letter:
                result["wing_name"] = letter.upper() + " Wing"

        # Section intent (for section-based splitting)
        section_m = _SECTION_HEADER_RE.match(stripped)
        if section_m:
            header_lower = section_m.group(1).lower()
            if header_lower in _INTENT_MAP:
                result["section_intent"] = _INTENT_MAP[header_lower]

    return result


_MULTI_INDICATORS: list[tuple[str, re.Pattern]] = [
    ("area_price_pair", re.compile(
        r'(\d[\d,]*)\s*(sq\.?\s*ft|sqft|sft|sq\s*feet)\s*[-–—:]?\s*'
        r'(?:rs\.?\s*|inr\s*|₹)?\s*([\d,.]+)\s*(?:\/-\s*)?(?:cr|crore|lac|lakh|l|k|thousand|sqft|sq\s*ft|sft)?',
        re.I,
    )),
    ("section_header", re.compile(
        r'^\s*(rent(?:al)?|sale|lease|plug\s*&?\s*play|bare\s*shell|furnished|'
        r'unfurnished|semi\s*furnished|commercial|office|shop)(?:\s*\(.*?\))?\s*:?\s*$',
        re.I,
    )),
    ("multi_bhk", re.compile(
        r'(\d+\s*bhk)[,\s]+(\d+\s*bhk)',
        re.I,
    )),
    ("line_price", re.compile(
        r'^\s*(?:rs\.?\s*|inr\s*|₹)?\s*[\d,]+(?:\.\d+)?\s*'
        r'(?:\/-\s*)?(?:cr|crore|lac|lakh|l|k|thousand)\b',
        re.I,
    )),
    ("bhk_price_pair", re.compile(
        r'(\d+)\s*(bhk|rk)\s*[-–—:]?\s*'
        r'(?:rs\.?\s*|inr\s*|₹)?\s*([\d,.]+)\s*(?:\/-\s*)?(?:cr|crore|lac|lakh|l|k|thousand)',
        re.I,
    )),
]


def classify_message(text: str) -> str:
    """Classify a message into: 'single', 'multi', 'requirement', 'market_update', 'promo'."""
    lines = [l.strip().strip('*_~').strip() for l in text.strip().split("\n") if l.strip()]
    clean_lines = [_clean_line_markup(l) for l in lines]
    lower = text.lower()

    area_price_pairs = 0
    section_headers = 0
    bhk_price_pairs = 0
    numbered_listing_headers = 0

    repeated_block_starts = 0
    available_bhk_in_relations = 0
    for raw_line, line in zip(lines, clean_lines):
        if _MULTI_INDICATORS[0][1].search(line):
            area_price_pairs += 1
        if _MULTI_INDICATORS[1][1].search(line):
            section_headers += 1
        if _MULTI_INDICATORS[4][1].search(line):
            bhk_price_pairs += 1
        if _NUMBERED_LISTING_RE.match(raw_line):
            numbered_listing_headers += 1
        if _UNNUMBERED_BLOCK_START_RE.match(line):
            repeated_block_starts += 1
        if _AVAILABLE_BHK_RELATION_RE.search(line):
            available_bhk_in_relations += 1

    # Count divider lines (________, =====, ---)
    divider_count = sum(1 for line in lines if _DIVIDER_RE.match(line))
    # Count emoji building headers
    building_count = sum(1 for line in lines if _TITLE_CASE_BUILDING_RE.match(line))
    # Count 📍 pin markers (each starts a new listing in bulk-forwarded messages)
    pin_count = sum(1 for line in lines if line.strip().startswith("📍"))
    # Count floor indicator lines (commercial floor-pricing format)
    floor_count = sum(1 for line in lines if _FLOOR_LINE_RE.search(line))

    if divider_count >= 1 and building_count >= 2:
        return "multi"

    if divider_count >= 2:
        return "multi"

    if numbered_listing_headers >= 2:
        return "multi"

    if repeated_block_starts >= 2:
        return "multi"

    if available_bhk_in_relations >= 2:
        return "multi"

    if pin_count >= 2:
        return "multi"

    # 2+ floor lines = commercial floor-pricing format
    if floor_count >= 2:
        return "multi"

    if section_headers >= 2 and (area_price_pairs >= 1 or bhk_price_pairs >= 1):
        return "multi"

    # 2+ explicit area-price pairs is a strong multi signal regardless of line count
    if area_price_pairs >= 2:
        return "multi"

    if (area_price_pairs >= 1 or bhk_price_pairs >= 1) and len(lines) >= 3:
        total_prices = sum(1 for l in lines if _MULTI_INDICATORS[3][1].match(l))
        if total_prices >= 2:
            return "multi"

    if _MULTI_INDICATORS[2][1].search(lower):
        return "multi"

    requirement_words = ["wanted", "require", "looking for", "need", "seeking", "urgent"]
    if any(w in lower for w in requirement_words) and "bhk" in lower:
        return "requirement"

    return "single"


# ── Section / header detection ──────────────────────────────────────

_INTENT_MAP = {
    "rent": "RENT",
    "rental": "RENT",
    "sale": "SELL",
    "sell": "SELL",
    "plug & play": "COMMERCIAL",
    "plug and play": "COMMERCIAL",
    "plug": "COMMERCIAL",
    "bare shell": "COMMERCIAL",
    "commercial": "COMMERCIAL",
    "office": "COMMERCIAL",
    "shop": "COMMERCIAL",
    "retail": "COMMERCIAL",
    "furnished": None,
    "unfurnished": None,
    "semi furnished": None,
}

_FURNISH_MAP = {
    "furnished": "Fully Furnished",
    "fully furnished": "Fully Furnished",
    "plug & play": "Fully Furnished",
    "plug and play": "Fully Furnished",
    "unfurnished": "Unfurnished",
    "semi furnished": "Semi Furnished",
    "bare shell": "Unfurnished",
    "empty": "Unfurnished",
    "bare": "Unfurnished",
}

_SECTION_HEADER_RE = re.compile(
    r'^\s*(rent(?:al)?|sale|sell|lease|plug\s*&?\s*play|'
    r'bare\s*shell|furnished|unfurnished|semi\s*furnished|'
    r'commercial|office|shop|retail)'
    r'(?:\s*\(.*?\))?\s*:?\s*$',
    re.I,
)

_AREA_PRICE_RE = re.compile(
    r'(\d[\d,]*)\s*(sq\.?\s*ft|sqft|sft|sq\s*feet)\s*[-–—:]?\s*'
    r'(?:rs\.?\s*|inr\s*|₹)?\s*([\d,.:/\-]+)\s*(cr|crore|lac|lakh|l|k|thousand)',
    re.I,
)

_AREA_ONLY_RE = re.compile(
    r'(\d[\d,.]*)\s*((?:cr|crore|lac|lakh|l|lacs|lakhs|k|thousand))?\s*(sq\.?\s*ft|sqft|sft|sq\s*feet|carpet)',
    re.I,
)
_AREA_RANGE_RE = re.compile(
    r'(\d[\d,.]*)\s*(?:to|[-–])\s*(\d[\d,.]*)\s*((?:cr|crore|lac|lakh|l|lacs|lakhs|k|thousand))?\s*(sq\.?\s*ft|sqft|sft|sq\s*feet|carpet)',
    re.I,
)
_PRICE_ONLY_RE = re.compile(
    r'(?:(?:cost|rate|price|rent|for\s+sale|for\s+(?:l\s*&?\s*l|lease|rent|leave\s+and\s+licence))\s*:?\s*)?'
    r'(?:rs\.?\s*|inr\s*|₹)?\s*([\d,.:/\-]+)\s*(?:\/-\s*)?(cr|crore|lac|lakh|l|lacs|lakhs|k|thousand|sqft|sq\s*ft|sft)\b',
    re.I,
)
_PER_SQFT_RE = re.compile(
    r'(?:cost|rate|price|rent|for\s+sale|for\s+(?:l\s*&?\s*l|lease|rent|leave\s+and\s+licence))\s*:?\s*'
    r'(?:rs\.?\s*|inr\s*|₹)?\s*([\d,.:/\-]+)\s*(?:\/-\s*)?((?:cr|crore|lac|lakh|l|lacs|lakhs|k|thousand))?'
    r'\s*per\s+sq\b',
    re.I,
)
_INTENT_ON_LINE_RE = re.compile(
    r'(?:for\s+sale|for\s+(?:l\s*&?\s*l|lease|rent|leave\s+and\s+licence))',
    re.I,
)
_AREA_NAKED_RE = re.compile(
    r'(\d[\d,.]*)\s*(?:retail|semi-?\s*retail|commercial|office|shop|showroom|godown|warehouse)\b',
    re.I,
)
_FLOOR_LINE_RE = re.compile(
    r'^\s*(ground\s*\+?\s*one|terrace|basement|stilt)|'
    r'(?:\d+\s*(?:st|nd|rd|th)?\s*(?:floor|flr|fl))\s*(?:to\s+\d+\s*(?:st|nd|rd|th)?\s*(?:floor|flr|fl))?',
    re.I,
)
_PRICE_RANGE_RE = re.compile(
    r'(?:rs\.?\s*|inr\s*|₹)?\s*([\d,.:/\-]+)\s*(?:cr|crore|lac|lakh|l|lacs|lakhs|k|thousand)?\s*'
    r'[-–—]\s*(?:rs\.?\s*|inr\s*|₹)?\s*([\d,.:/\-]+)\s*'
    r'(cr|crore|lac|lakh|l|lacs|lakhs|k|thousand)\b',
    re.I,
)

_BUILDING_HEADER_RE = re.compile(
    r'^\s*(?:project|building|property|complex|tower|wing)\s*[-–—:]\s*(.+)',
    re.I,
)
_BUILDING_NAME_RE = re.compile(r'^\s*(building|project|name)\s*[-–—:]\s*(.+)', re.I)
_NUMBERED_LISTING_RE = re.compile(
    r'^\s*(?:[⭐*•-]\s*)?(\d{1,3})\s*[\).:-]\s+(.*)',
    re.I,
)


def _parse_amount(value: str) -> float | None:
    cleaned = str(value or "").strip().replace(" ", "")
    if not cleaned:
        return None
    if cleaned.count(",") == 1 and not any(sep in cleaned for sep in (".", ":", "-", "/")):
        left, right = cleaned.split(",", 1)
        if len(right) <= 2:
            cleaned = f"{left}.{right}"
        else:
            cleaned = f"{left}{right}"
    else:
        cleaned = cleaned.replace(",", "")
    cleaned = cleaned.replace(":", ".").replace("-", ".").replace("/", ".")
    try:
        return float(cleaned)
    except ValueError:
        return None
_NUMBERED_ANY_RE = re.compile(r'^\s*(?:[⭐*•-]\s*)?(?:\d{1,3})\s*[\).:-]\s*(.+)', re.I)
_LOCATION_LINE_RE = re.compile(r'^\s*(?:📍|location\s*[:\-])\s*(.+)', re.I)
_SIGNATURE_HINT_RE = re.compile(r'\b(?:for inspection|for details|contact|housen realtors|realtors|realty)\b', re.I)


def _extract_building(text: str) -> str | None:
    for line in text.split("\n"):
        m = _BUILDING_HEADER_RE.search(line)
        if m:
            return m.group(1).strip()
        m = _BUILDING_NAME_RE.search(line)
        if m:
            return m.group(2).strip()
    return None


_PAREN_FURNISH_RE = re.compile(r'\((empty|bare|unfurnished)\)', re.I)

def _split_sections(text: str) -> list[dict]:
    """Split a multi-listing message into sections by intent headers.

    Returns list of dicts: {intent, furnishing, lines: [str]}
    """
    raw_lines = text.strip().split("\n")
    lines = [l.strip() for l in raw_lines if l.strip()]

    sections: list[dict] = []
    current: dict | None = None

    for line in lines:
        hm = _SECTION_HEADER_RE.match(_clean_line_markup(line))
        if hm:
            header_raw = hm.group(1).lower()
            intent = _INTENT_MAP.get(header_raw)
            furnishing = _FURNISH_MAP.get(header_raw)
            # Check parenthetical furnishing hint like "Rent (Empty)"
            paren = _PAREN_FURNISH_RE.search(line)
            if paren:
                furnishing = _FURNISH_MAP.get(paren.group(1).lower(), furnishing)
            current = {
                "intent": intent,
                "furnishing": furnishing,
                "lines": [],
            }
            sections.append(current)
        elif current is not None:
            current["lines"].append(line)
        else:
            have_area = bool(_AREA_ONLY_RE.search(line))
            have_price = bool(_PRICE_ONLY_RE.search(line))
            have_bhk_price = bool(_MULTI_INDICATORS[4][1].search(line))
            if (have_area and have_price) or have_bhk_price:
                current = {
                    "intent": None,
                    "furnishing": None,
                    "lines": [line],
                }
                sections.append(current)
                current = None

    return sections


def _clean_line_markup(line: str) -> str:
    return line.strip().strip("*_`~").strip()


def _strip_numbered_prefix(line: str) -> str:
    m = _NUMBERED_ANY_RE.match(line)
    return m.group(1).strip() if m else line.strip()


def _split_numbered_blocks(text: str) -> list[str]:
    """Split numbered WhatsApp lists like '1) 3 BHK || Building' into blocks."""
    lines = [line.strip() for line in text.strip().split("\n") if line.strip()]
    blocks: list[list[str]] = []
    current: list[str] | None = None

    for line in lines:
        if _NUMBERED_LISTING_RE.match(line):
            if current:
                blocks.append(current)
            current = [line]
            continue

        if current is not None:
            if _SIGNATURE_HINT_RE.search(line):
                blocks.append(current)
                current = None
                continue
            current.append(line)

    if current:
        blocks.append(current)

    return ["\n".join(block) for block in blocks]


def _split_by_dividers(text: str) -> list[str]:
    """Split a message by divider lines (________, =======, --------)."""
    lines = text.strip().split("\n")
    blocks: list[list[str]] = []
    current: list[str] = []

    for line in lines:
        if _DIVIDER_RE.match(line.strip()):
            if current and any(l.strip() for l in current):
                blocks.append(current)
            current = []
        else:
            current.append(line)

    if current and any(l.strip() for l in current):
        blocks.append(current)

    return ["\n".join(b) for b in blocks]


def _split_by_pin_markers(text: str) -> list[str]:
    """Split a message into blocks at each 📍 location pin marker.

    Each line starting with 📍 begins a new listing block. Content before
    the first 📍 (header/signature) is discarded. Empty blocks are omitted.
    """
    lines = text.strip().split("\n")
    blocks: list[list[str]] = []
    current: list[str] | None = None

    for line in lines:
        if line.strip().startswith("📍"):
            if current is not None and any(l.strip() for l in current):
                blocks.append(current)
            current = [line]
        elif current is not None:
            current.append(line)

    if current is not None and any(l.strip() for l in current):
        blocks.append(current)

    return ["\n".join(b) for b in blocks]


def _split_repeated_available_blocks(text: str) -> list[str]:
    """Split unnumbered WhatsApp forwards with repeated availability headers."""
    lines = [line.strip() for line in text.strip().split("\n") if line.strip()]
    blocks: list[list[str]] = []
    current: list[str] = []
    signature: list[str] = []
    in_signature = False

    for line in lines:
        clean = _clean_line_markup(line)
        if re.search(r'\b(?:plz|please)\s+(?:c|see|call|contact)|\bmore\s+enquiry\b', clean, re.I):
            in_signature = True
        if in_signature:
            signature.append(line)
            continue

        is_start = bool(_UNNUMBERED_BLOCK_START_RE.match(clean))
        if is_start and current:
            blocks.append(current)
            current = [line]
        else:
            current.append(line)

    if current:
        blocks.append(current)

    if len(blocks) < 2:
        return []

    if signature:
        for block in blocks:
            block.extend(signature)

    return ["\n".join(block) for block in blocks]

def _extract_building_name(text: str) -> str | None:
    """Extract building name from various patterns: 🏢 prefix, 🔹 name 🔹, or all-caps standalone line."""
    lines = text.split("\n")
    clean_lines = [l.strip().strip("🏢 *") for l in lines]

    # Priority 1: 🏢 followed by a proper-looking building name
    for line in lines:
        stripped = line.strip()
        # Extract text after 🏢 up to 🔹 or end of line
        m = re.match(r'🏢\s{0,2}(.+)', stripped)
        if m:
            raw = m.group(1).strip()
            # Stop at 🔹, -, or common keywords
            name = raw.split("🔹")[0].strip()
            name = re.split(r'\s[–—]\s', name)[0].strip()
            name = name.strip(" *-–")
            if not name:
                continue
            lower = name.lower()
            if any(kw in lower for kw in ("rent", "sale", "commercial", "office", "shop", "space for", "premium", "prime", "corporate", "brand", "new", "luxury", "property", "inventory")):
                continue
            if len(name) >= 3:
                return _title_case_name(name)

    # Priority 1.5: "Available for rent/sale/lease X BHK in/at BuildingName"
    for line in lines:
        # Pattern: Available for rent/sale/lease <N>BHK in/at <BuildingName>
        m = re.search(r'\bavailable\s+for\s+(?:rent|sale|lease)\s+\d+\s*bhk\s+(?:in|at)\s+([A-Z][A-Za-z0-9 .&\'\-]+)', line, re.I)
        if m:
            name = m.group(1).strip()
            # Clean up trailing punctuation/keywords
            name = name.split(",")[0].strip()
            name = re.split(r'\s[–—]\s', name)[0].strip()
            name = name.strip(" *-–.,")
            if not name or len(name) < 3:
                continue
            lower = name.lower()
            if any(kw in lower for kw in ("rent", "sale", "commercial", "office", "shop", "space for", "premium", "prime", "corporate", "brand", "new", "luxury", "property", "inventory")):
                continue
            if lower not in _KNOWN_LOCALITIES:
                return _title_case_name(name)

    # Priority 2: 🔹NAME🔹 — text between 🔹 delimiters (common in commercial listings)
    for line in lines:
        m = re.search(r'🔹\s*([A-Z][A-Za-z0-9 .&\'\-]{2,}?)\s*🔹', line)
        if m:
            name = m.group(1).strip()
            if name.upper() == name and len(name) >= 3:
                # Skip if it's a known locality
                if name.lower() not in _KNOWN_LOCALITIES:
                    return _title_case_name(name)

    # Priority 3: all-caps standalone line that looks like a building name
    for cl in clean_lines:
        stripped = cl.strip().strip("📞📱*🔹📍💰🏢")
        stripped = re.sub(r'^[^A-Za-z0-9]+|[^A-Za-z0-9]+$', '', stripped)
        if not stripped or re.search(r'\b\d{9,}\b', stripped):
            continue
        if stripped.isupper() and len(stripped) >= 6 and not any(kw in stripped.lower() for kw in
            ("rent", "sale", "bhk", "sqft", "carpet", "area", "floor", "parking",
             "furnished", "immediate", "possession", "deposit", "landmark", "layout",
             "amenities", "commercial", "office", "shop", "conference", "workstation",
             "cabin", "pantry", "washroom", "security", "backup", "lift", "negotiable",
             "contact", "details", "inspection", "site visit", "more details", "for more",
             "prime", "premium", "pillarless", "profile")):
            if stripped.lower() not in _KNOWN_LOCALITIES:
                return _title_case_name(stripped)

    return None

def _title_case_name(name: str) -> str:
    """Convert an all-caps or mixed building name to title case."""
    if name.isupper():
        known_acronyms = {"BKC", "CHS", "HIG", "MIG", "SRA", "RERA", "MHADA"}
        words = name.split()
        result = []
        for w in words:
            if w.upper() in known_acronyms:
                result.append(w.upper())
            elif len(w) <= 2:
                result.append(w.upper())
            else:
                result.append(w.capitalize())
        return " ".join(result)
    return name

def _parse_divider_block(
    block: str,
    profile_name: str | None,
    hierarchical_ctx: dict | None = None,
) -> dict | None:
    """Parse a single block split by dividers into a listing dict."""
    ctx = hierarchical_ctx or {}
    bhk = _parse_bhk_from_text(block)
    area = _parse_area_from_text(block)
    price, unit = _parse_price_from_text(block)
    location_line = _extract_location_line(block)
    building = _extract_building_name(block)

    # Skip blocks that are clearly headers (no listing data at all)
    if not building and not area and price is None and not location_line:
        return None

    # ── Per-sqft price → compute total ──────────────────────────────
    price_per_sqft = None
    per_sqft_m = _PER_SQFT_RE.search(block)
    if per_sqft_m:
        raw = _parse_amount(per_sqft_m.group(1))
        if raw is not None:
            scale = per_sqft_m.group(2)
            if scale:
                sl = scale.strip().lower().rstrip("s")
                if sl in ("k", "thousand"):
                    raw *= 1000
                elif sl in ("lac", "lakh", "l"):
                    raw *= 100000
                elif sl in ("cr", "crore"):
                    raw *= 10000000
            price_per_sqft = raw

    if price_per_sqft is not None and area is not None and price is None:
        # Per-sqft rate found but _parse_price_from_text didn't get it
        # (e.g., "Rent: ₹225 per sq. ft." with _PARSE_PRICE_ONLY not matching)
        price = price_per_sqft
        unit = "abs"

    if price_per_sqft is not None and area is not None and price is not None and unit == "abs":
        total = price_per_sqft * area
        if total >= 10000000:
            price = round(total / 10000000, 2)
            unit = "Cr"
        elif total >= 100000:
            price = round(total / 100000, 2)
            unit = "Lac"
        elif total >= 1000:
            price = round(total / 1000, 2)
            unit = "K"
        else:
            price = round(total, 2)
            unit = "abs"

    # For blocks where building name wasn't found or is descriptive, try harder
    if not building or any(kw in building.lower() for kw in
        ("rent", "sale", "commercial", "office", "shop", "space for",
         "premium", "prime", "corporate", "property", "setup", "bandra", "andheri", "linking road")):
        # Check for 🔹NAME🔹 pattern as actual building name
        for line in block.split("\n"):
            m = re.search(r'🔹\s*([A-Z][A-Za-z0-9 .&\'\-]{2,}?)\s*🔹', line)
            if m:
                name = m.group(1).strip()
                if name.upper() == name and len(name) >= 3 and name.lower() not in _KNOWN_LOCALITIES:
                    building = _title_case_name(name)
                    break
        else:
            # Fallback: extract multi-word capitalized phrase from descriptive block
            fallback = _extract_name_from_descriptive_line(building or "", block)
            if fallback and fallback.lower() not in _KNOWN_LOCALITIES:
                lower = fallback.lower()
                if not any(kw in lower for kw in ("rent", "sale", "commercial", "office", "shop", "road", "linking", "prime", "premium", "property", "space")):
                    building = fallback

    # Validate building name
    building = validate_building_name(building)

    location_context = "\n".join([v for v in [building, location_line] if v]) or block
    loc = _extract_location_from_text(location_context)

    broker_name, broker_phone = _extract_broker_from_block(block)
    attrs = extract_property_attributes(block)

    listing_source = detect_listing_source(block)

    result: dict = {
        "intent": _infer_intent_from_text(block),
        "principal": None,
        "bhk": bhk,
        "price": price,
        "price_unit": unit,
        "area_sqft": area,
        "furnishing": furnishing,
        "location_raw": shared_building,
        "building_name": validate_building_name(shared_building),
        "landmark_name": shared_building,
        "street_name": None,
        "area": None,
        "micro_market": None,
        "developer": None,
        "broker_name": None,
        "broker_phone": None,
        "forwarded": 0,
        "confidence": 0.85,
        "raw_payload": {"full_text": line},
        "location": loc.get("location") or {},
        # Property attribute fields
        "floor_description": attrs.get("floor_description"),
        "view": attrs.get("view"),
        "orientation": attrs.get("orientation"),
        "position": attrs.get("position"),
        # Hierarchical context
        "project_name": ctx.get("project_name"),
        "tower_name": ctx.get("tower_name"),
        "wing_name": ctx.get("wing_name"),
        # Listing source
        "listing_source": listing_source,
    }
    return result


_PHONE_CANDIDATE_RE = re.compile(r'(?:\+?91[\s-]*)?[6-9](?:[\s-]*\d){9}')
_BROKER_LINE_RE = re.compile(r'(?:contact|call|whatsapp|📞|📱)\s*:?\s*([A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+)*)\s*[-–]?\s*((?:\+?91[\s-]*)?[6-9](?:[\s-]*\d){9})')
_CALL_NAME_CONTACT_RE = re.compile(r'\b(?:call|contact|whatsapp)\s+([A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+){0,3})\s+(?:contact|call|whatsapp)\s*:?\s*((?:\+?91[\s-]*)?[6-9](?:[\s-]*\d){9})', re.I)
_NAME_PHONE_RE = re.compile(r'^([A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+)+)\s*[-–]?\s*((?:\+?91[\s-]*)?[6-9](?:[\s-]*\d){9})$')

def _normalize_indian_phone(value: str | None) -> str | None:
    digits = re.sub(r'\D+', '', value or '')
    if len(digits) == 12 and digits.startswith('91'):
        digits = digits[-10:]
    elif len(digits) == 11 and digits.startswith('0'):
        digits = digits[-10:]
    if len(digits) == 10 and re.match(r'^[6-9]\d{9}$', digits):
        return digits
    return None

def _extract_broker_from_block(text: str) -> tuple[str | None, str | None]:
    """Extract (broker_name, broker_phone) from the end of a block.
    
    A name is only extracted if it appears within 2 lines of a phone number.
    """
    lines = [l.strip() for l in text.strip().split("\n") if l.strip()]
    phone = None
    name = None
    phone_line_idx = -1

    # First pass: find the last phone number
    for i in range(len(lines) - 1, -1, -1):
        clean = re.sub(r'[*_`~📞📱🔹📍💰🏢📍📐🔐]', '', lines[i]).strip()
        phone_match = _PHONE_CANDIDATE_RE.search(clean)
        normalized_phone = _normalize_indian_phone(phone_match.group(0) if phone_match else None)
        if normalized_phone:
            phone = normalized_phone
            phone_line_idx = i
            break

    if not phone:
        return None, None

    # Check the phone line itself for name + phone (e.g. "JUNED MENK 9967252525")
    phone_line_clean = re.sub(r'[*_`~📞📱🔹📍💰🏢📍📐🔐]', '', lines[phone_line_idx]).strip()
    m = _CALL_NAME_CONTACT_RE.search(phone_line_clean)
    if m:
        name = m.group(1).strip()
        phone = _normalize_indian_phone(m.group(2)) or phone
        return name, phone
    m = _BROKER_LINE_RE.search(phone_line_clean)
    if m:
        name = m.group(1).strip()
        phone = _normalize_indian_phone(m.group(2)) or phone
        return name, phone
    m = _NAME_PHONE_RE.search(phone_line_clean)
    if m:
        name = m.group(1).strip()
        phone = _normalize_indian_phone(m.group(2)) or phone
        return name, phone

    # Second pass: look for name within 2 lines above phone line
    start = max(0, phone_line_idx - 2)
    for i in range(phone_line_idx - 1, start - 1, -1):
        line = lines[i]
        clean_line = re.sub(r'[*_`~📞📱🔹📍💰🏢📍📐🔐]', '', line).strip()
        if not clean_line:
            continue

        # Name-only all-caps line (not a data/location field)
        if not re.search(r'\d', clean_line):
            low = clean_line.lower()
            if clean_line.isupper() and len(clean_line) >= 3 and len(clean_line) <= 40:
                if clean_line.startswith('(') and clean_line.endswith(')'):
                    continue  # parenthesized location
                if low in _KNOWN_LOCALITIES:
                    continue  # known locality name
                if not any(kw in low for kw in
                    ("rent", "sale", "bhk", "sqft", "area", "floor", "parking",
                     "furnished", "possession", "deposit", "layout", "amenities",
                     "carpet", "immediate", "negotiable", "inspection", "details",
                     "contact", "call", "whatsapp", "conference", "workstation",
                     "cabin", "pantry", "washroom", "security", "backup", "lift",
                     "landmark", "station", "price", "asking", "location",
                     "commercial", "office", "shop", "coverage", "capacity",
                     "reception", "entrance", "building", "ground", "first",
                     "second", "third", "fourth", "fifth", "sixth", "seventh",
                     "eighth", "ninth", "tenth", "upper", "lower", "basement",
                     "dedicated", "visitor", "ample", "separate", "exclusive",
                     "ready", "restaurant")):
                    name = clean_line.title()
                    break

    return name, phone

def _extract_name_from_descriptive_line(name: str, full_block: str) -> str | None:
    """Extract a proper name from a descriptive line like 'Corporate office setup Lotus Link Square'."""
    lines = full_block.split("\n")

    def _clean_building_candidate(candidate: str) -> str | None:
        candidate = candidate.strip().strip("*_").rstrip(".,;)\"' ")
        if not candidate or len(candidate) < 3:
            return None
        lower = candidate.lower()
        if any(kw in lower for kw in ("rent", "sale", "bhk", "sqft", "metro", "station", "road", "linking", "location", "carpet", "area", "floor", "otla", "parking")):
            return None
        return _title_case_name(candidate)

    # Priority 1: Extract from 📍 location line with dash separator
    for line in lines:
        loc_m = re.match(r'^\s*📍\s*(.+)', line)
        if loc_m:
            loc_text = loc_m.group(1).strip()
            # Try dash-separated: "Area – Building" or "Area – Building, Sub-Locality"
            for dash in ['–', '—', ' - ']:
                if dash in loc_text:
                    parts = loc_text.split(dash, 1)
                    right = parts[1].strip().rstrip(".,;)\"' ")
                    if right and len(right) >= 3:
                        # If comma-separated, try first part as building (e.g. "Brindaban, Poonam Nagar")
                        if ',' in right:
                            first_part = right.split(',')[0].strip()
                            cand = _clean_building_candidate(first_part)
                            if cand:
                                return cand
                        cand = _clean_building_candidate(right)
                        if cand:
                            return cand
            # Try parenthetical: "Area (Near Building)"
            paren_m = re.search(r'\(([^)]+)\)', loc_text)
            if paren_m:
                cand = paren_m.group(1).strip().rstrip(".,;)\"' ")
                # Strip leading prepositions like "Near ", "Opp ", "Opposite ", "Behind "
                cand = re.sub(r'^(near|opp|opposite|behind|next\s+to|adjacent\s+to)\s+', '', cand, flags=re.I)
                cand = cand.strip()
                cand = _clean_building_candidate(cand)
                if cand:
                    return cand
            # Use the full text after 📍 as building (after stripping known area words)
            cand = _clean_building_candidate(loc_text)
            if cand and cand.lower() not in _KNOWN_LOCALITIES:
                return cand
            break

    # Priority 2: existing regex for non-📍 lines (descriptive setups)
    for line in lines:
        stripped = line.strip().strip("🏢 *")
        if not stripped:
            continue
        stripped = re.sub(r'🔹.*$', '', stripped).strip()
        if not stripped:
            continue
        # Look for a capitalized phrase at end of line after common descriptors
        m = re.search(r'(?:setup|in|at|–|-)\s+([A-Za-z0-9 .&\'\-]+(?: [A-Za-z0-9 .&\'\-]+)*)$', stripped)
        if m:
            candidate = m.group(1).strip().rstrip(".,;)")
            lower = candidate.lower()
            if not any(kw in lower for kw in ("rent", "sale", "bhk", "sqft", "metro", "station", "road", "nagar", "linking")) and len(candidate) >= 3:
                return _title_case_name(candidate)
        # Fallback within same line: find a capitalized 2+ word phrase
        parts = stripped.split()
        for i in range(len(parts) - 1):
            if parts[i][0].isupper() and parts[i+1][0].isupper() and len(parts[i]) >= 3 and len(parts[i+1]) >= 3:
                phrase = " ".join(parts[i:])
                phrase = re.sub(r'\s*[,–—].*$', '', phrase)
                lower = phrase.lower()
                if not any(kw in lower for kw in ("rent", "sale", "bhk", "sqft", "metro", "station", "road", "linking", "location", "carpet", "area", "floor", "otla", "parking")):
                    return _title_case_name(phrase.strip().rstrip(".,;)"))
    return None

def _extract_title_parts(block: str) -> tuple[str | None, str | None]:
    first_line = _strip_numbered_prefix(block.split("\n", 1)[0])
    bhk = _parse_bhk_from_text(first_line)
    title = first_line

    if "||" in first_line:
        title = first_line.split("||", 1)[1]
    elif "–" in first_line:
        title = first_line.split("–", 1)[1]
    elif " - " in first_line:
        title = first_line.split(" - ", 1)[1]
    elif bhk:
        title = re.sub(r'^\s*\d+\s*bhk\s*', '', first_line, flags=re.I)
    elif re.search(r'^\s*studio\b', first_line, re.I):
        title = re.sub(r'^\s*studio\s*', '', first_line, flags=re.I)

    title = re.sub(r'\s+', ' ', title).strip(" -*|:")
    if not title or title.lower() in {"option", "options"} or re.search(r'\boptions?\b', title, re.I):
        title = None
    return bhk, title


def _extract_location_line(block: str) -> str | None:
    for line in block.split("\n"):
        m = _LOCATION_LINE_RE.match(line)
        if m:
            return m.group(1).strip()
    return None


def _infer_intent_from_text(text: str) -> str:
    lower = text.lower()
    commercial_text = re.sub(r'\bpost\s+office\b', ' ', lower)
    
    # Priority 1: Check for requirement intent keywords FIRST
    # This prevents messages with "Require..." or "Looking for..." from being
    # misclassified as LISTING just because they contain price/area/location fields
    if re.search(r'\b(require|requirement|requirements|looking\s+for|need|wanted|in\s+search\s+of|client\s+wants|enquiry\s+for|seeking|searching\s+for)\b', lower, re.IGNORECASE):
        return "BUY"
    
    if re.search(r'\b(commercial|office|shop|showroom|warehouse|godown|retail)\b', commercial_text):
        return "COMMERCIAL"
    if re.search(r'\b(rent|rental|lease|tenant)\b', lower):
        return "RENT"
    if re.search(r'\b(outright|sale|sell|resale|ready to move)\b', lower):
        return "SELL"
    return "SELL"


def _parse_numbered_block(
    block: str,
    profile_name: str | None,
    hierarchical_ctx: dict | None = None,
) -> dict | None:
    ctx = hierarchical_ctx or {}
    bhk, building = _extract_title_parts(block)
    area = _parse_area_from_text(block)
    price, unit = _parse_price_from_text(block)
    location_line = _extract_location_line(block)
    location_context = "\n".join([v for v in [building, location_line] if v]) or block
    loc = _extract_location_from_text(location_context)

    if not any([building, area, price, location_line]):
        return None

    # ── Per-sqft price → compute total ──────────────────────────────
    price_per_sqft = None
    per_sqft_m = _PER_SQFT_RE.search(block)
    if per_sqft_m:
        raw = _parse_amount(per_sqft_m.group(1))
        if raw is not None:
            scale = per_sqft_m.group(2)
            if scale:
                sl = scale.strip().lower().rstrip("s")
                if sl in ("k", "thousand"):
                    raw *= 1000
                elif sl in ("lac", "lakh", "l"):
                    raw *= 100000
                elif sl in ("cr", "crore"):
                    raw *= 10000000
            price_per_sqft = raw

    if price_per_sqft is not None and area is not None and price is not None and unit == "abs":
        total = price_per_sqft * area
        if total >= 10000000:
            price = round(total / 10000000, 2)
            unit = "Cr"
        elif total >= 100000:
            price = round(total / 100000, 2)
            unit = "Lac"
        elif total >= 1000:
            price = round(total / 1000, 2)
            unit = "K"
        else:
            price = round(total, 2)
            unit = "abs"

    # Extract broker from signature lines at bottom
    broker_name, broker_phone = _extract_broker_from_block(block)

    # For blocks where building name looks like a contact line, fix it
    if building and re.search(r'\b\d{10}\b', building):
        building = None

    # Validate building name and extract property attributes
    building = validate_building_name(building)
    attrs = extract_property_attributes(block)
    listing_source = detect_listing_source(block)

    result: dict = {
        "intent": _infer_intent_from_text(block),
        "principal": None,
        "bhk": bhk,
        "price": price,
        "price_unit": unit,
        "price_per_sqft": price_per_sqft,
        "area_sqft": area,
        "furnishing": _parse_furnishing_from_text(block),
        "location_raw": location_line or loc.get("location_raw"),
        "building_name": building or loc.get("building_name"),
        "landmark_name": loc.get("landmark_name"),
        "street_name": loc.get("street_name"),
        "area": None,
        "micro_market": loc.get("micro_market"),
        "developer": None,
        "broker_name": broker_name,
        "broker_phone": broker_phone,
        "forwarded": 0,
        "confidence": 0.88,
        "raw_payload": {"full_text": block},
        "location": loc.get("location") or {},
        # Property attribute fields
        "floor_description": attrs.get("floor_description"),
        "view": attrs.get("view"),
        "orientation": attrs.get("orientation"),
        "position": attrs.get("position"),
        # Hierarchical context
        "project_name": ctx.get("project_name"),
        "tower_name": ctx.get("tower_name"),
        "wing_name": ctx.get("wing_name"),
        # Listing source
        "listing_source": listing_source,
    }
    return result


# ── Listing Source Detection ─────────────────────────────────────────
# Mumbai broker slang for indirect inventory

_LISTING_SOURCE_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("INDIRECT", re.compile(
        r'\b(my\s*\+?\s*1|plus\s+1|\+1|on\s+reference|by\s+reference|'
        r'reference|reference\s+basis|share\s+basis|on\s+share|sharing\s+basis|'
        r'indirect|sharing)\b',
        re.I,
    )),
]


def detect_listing_source(text: str) -> str | None:
    """Detect if a listing is Direct, Indirect (+1), or Unknown.

    Returns None (Unknown), 'DIRECT', or 'INDIRECT'.
    Never guesses — only returns INDIRECT if explicit slang is found.
    """
    lower = text.lower()
    for label, pattern in _LISTING_SOURCE_PATTERNS:
        if pattern.search(lower):
            return "INDIRECT"
    return None


# ── Multi-listing parser ────────────────────────────────────────────

# ── Ambiguous price pattern cache ─────────────────────────────────────
# Brokers sometimes write "2.25,/50 cr" meaning "2.25 to 2.50 Cr".
# This cache avoids repeated LLM calls for the same pattern.
_PRICE_CACHE: dict[str, tuple[float | None, str | None]] = {}


def _detect_ambiguous_price_shorthand(text: str) -> str | None:
    """Detect broker shorthand like '2.25,/50 cr' (range shorthand).

    Pattern: a decimal number (X.XX) followed by optional comma+slash or
    just slash, then a small integer (<100), then a price unit.
    Returns the matched shorthand substring if found, else None.
    """
    m = re.search(
        r'(\d+\.\d+)\s*,?\s*/\s*(\d{1,2})\s*'
        r'(cr|crore|lac|lakh|l|lacs|lakhs|k|thousand)\b',
        text, re.I,
    )
    if m:
        first = float(m.group(1))
        second = int(m.group(2))
        unit = m.group(3).lower().rstrip("s")
        # Sanity: first has decimals, second is small (<100).
        # The combined value (first.dd + second as continuation) should be
        # a plausible price increment from first.
        # e.g. 2.25,/50 → 2.25 to 2.50 (50 is the two-digit continuation)
        # If second is > first or the combined range makes sense, flag it.
        if first >= 0.1 and 1 <= second <= 99:
            return m.group(0).strip()
    return None


def _resolve_ambiguous_price(shorthand: str) -> tuple[float | None, str | None]:
    """Resolve a broker price shorthand using cached or LLM result.

    Returns (amount, unit) where amount is the max of the range, or
    (None, None) if resolution fails.  Retries once on failure since
    the LLM provider can be flaky on cold start.
    """
    cache_key = shorthand.strip().lower()
    cached = _PRICE_CACHE.get(cache_key)
    if cached is not None:
        return cached

    system = (
        "You are a price normalizer for Indian real estate WhatsApp messages. "
        "Brokers write shorthands like '2.25,/50 cr' meaning price range 2.25 Cr to 2.50 Cr "
        "(the 50 after the slash is the decimal continuation: .50). "
        "Return ONLY a JSON object with these exact keys: price_min, price_max, unit. "
        "No markdown, no explanation, no code fences. "
        'Example: {"price_min": 2.25, "price_max": 2.5, "unit": "Cr"}'
    )
    prompt = f"Parse this broker price shorthand: {shorthand}"

    for attempt in range(2):
        try:
            from app import _ai_promote
            result = _ai_promote(system, prompt)
            if result:
                clean = result.strip()
                if clean.startswith("```"):
                    start = clean.find("{")
                    end = clean.rfind("}")
                    if start >= 0 and end > start:
                        clean = clean[start:end + 1]
                import json
                parsed = json.loads(clean)
                pmin = parsed.get("price_min")
                pmax = parsed.get("price_max")
                unit = parsed.get("unit", "").lower().rstrip("s")
                if unit in ("cr", "crore"):
                    unit_clean = "Cr"
                elif unit in ("lac", "lakh", "l"):
                    unit_clean = "Lac"
                elif unit in ("k", "thousand"):
                    unit_clean = "K"
                else:
                    break
                if pmin is not None and pmax is not None and 0 < pmin <= pmax:
                    result_val = (pmax, unit_clean)
                    _PRICE_CACHE[cache_key] = result_val
                    return result_val
        except Exception:
            pass
        if attempt == 0:
            import time
            time.sleep(3)
    _PRICE_CACHE[cache_key] = (None, None)
    return None, None


def _parse_price_from_text(text: str) -> tuple[float | None, str | None]:
    """Extract (price_in_raw, unit) from a line.

    If broker shorthand like '2.25,/50 cr' is detected, delegates to
    an LLM normalizer with caching. Clean prices always use fast regex.
    """
    # ── Ambiguous shorthand check (before standard regex) ──────────
    shorthand = _detect_ambiguous_price_shorthand(text)
    if shorthand:
        result = _resolve_ambiguous_price(shorthand)
        if result[0] is not None:
            return result

    range_match = _PRICE_RANGE_RE.search(text)
    if range_match:
        amount = _parse_amount(range_match.group(1))
        unit_raw = range_match.group(3).lower().rstrip("s")
        if amount is None:
            amount = _parse_amount(range_match.group(2))
        if amount is None:
            return None, None
        if unit_raw in ("cr", "crore"):
            return amount, "Cr"
        elif unit_raw in ("lac", "lakh", "l"):
            return amount, "Lac"
        elif unit_raw in ("k", "thousand"):
            return amount, "K"

    m = _PRICE_ONLY_RE.search(text)
    if m:
        amount = _parse_amount(m.group(1))
        if amount is None:
            return None, None
        unit_raw = m.group(2).lower().rstrip("s")
        if unit_raw in ("cr", "crore"):
            return amount, "Cr"
        elif unit_raw in ("lac", "lakh", "l"):
            return amount, "Lac"
        elif unit_raw in ("k", "thousand"):
            return amount, "K"
        elif unit_raw in ("sqft", "sq ft", "sft"):
            return amount, "abs"
    # Try per-sqft price format: "Cost N per sq ft", "For L&L N per sq ft"
    per_m = _PER_SQFT_RE.search(text)
    if per_m:
        amount = _parse_amount(per_m.group(1))
        if amount is not None:
            scale = per_m.group(2)
            if scale:
                scale_lower = scale.strip().lower().rstrip("s")
                if scale_lower in ("k", "thousand"):
                    amount *= 1000
                elif scale_lower in ("lac", "lakh", "l"):
                    amount *= 100000
                elif scale_lower in ("cr", "crore"):
                    amount *= 10000000
            return amount, "abs"
    # Fallback: numbers with ₹/Rs prefix and no explicit unit
    fallback_m = re.search(r'(?:rs\.?\s*|inr\s*|₹)\s*([\d,]+)\s*(?:/-)?\b', text, re.I)
    if fallback_m:
        amount = _parse_amount(fallback_m.group(1))
        if amount is None:
            return None, None
        return amount, "abs"
    # Fallback: "Rent: 65000" pattern (number without ₹ but explicitly rent)
    rent_m = re.search(r'(?:rent|rental|price|asking\s*price)\s*[-–:]\s*(?:rs\.?\s*|inr\s*|₹)?\s*([\d,]+)\b', text, re.I)
    if rent_m:
        amount = _parse_amount(rent_m.group(1))
        if amount is None:
            return None, None
        return amount, "abs"
    return None, None


def _parse_area_from_text(text: str) -> float | None:
    # First try range format: "1000 to 5400 sq ft carpet" → use max value
    range_m = _AREA_RANGE_RE.search(text)
    if range_m:
        val2 = float(range_m.group(2).replace(",", ""))
        scale = range_m.group(3)
        if scale and scale.lower().rstrip("s") in ("k", "thousand"):
            val2 *= 1000
        return val2
    m = _AREA_ONLY_RE.search(text)
    if m:
        val = float(m.group(1).replace(",", ""))
        scale = m.group(2)
        if scale and scale.lower().rstrip("s") in ("k", "thousand"):
            val *= 1000
        return val
    # Try naked area: "5400 Retail", "1000 semi retail"
    naked_m = _AREA_NAKED_RE.search(text)
    if naked_m:
        return float(naked_m.group(1).replace(",", ""))
    return None


def _parse_furnishing_from_text(text: str) -> str | None:
    lower = text.lower()
    if (
        re.search(r'\bfully\s+furnished\b|\bfully\s+fur\b', lower)
        or re.search(r'(?<![a-z0-9])f\s*/\s*f(?![a-z0-9])|(?<![a-z0-9])ff(?![a-z0-9])', lower)
    ):
        return "Fully Furnished"
    if (
        re.search(r'\bsemi\s+furnished\b|\bsemi\s+fur\b', lower)
        or re.search(r'(?<![a-z0-9])s\s*/\s*f(?![a-z0-9])|(?<![a-z0-9])sf(?![a-z0-9])', lower)
    ):
        return "Semi Furnished"
    if (
        re.search(r'\bun\s*-?\s*furnished\b|\bun\s+furn\b', lower)
        or re.search(r'(?<![a-z0-9])u\s*/\s*f(?![a-z0-9])|(?<![a-z0-9])uf(?![a-z0-9])', lower)
    ):
        return "Unfurnished"
    return None


def _parse_bhk_from_text(text: str) -> str | None:
    range_match = re.search(r'(\d+(?:\.\d+)?\s*/\s*\d+(?:\.\d+)?)\s*bhk', text, re.I)
    if range_match:
        return re.sub(r'\s+', '', range_match.group(1)) + " BHK"
    m = re.search(r'(\d+(?:\.\d+)?)\s*(bhk|rk|bedroom|b ed|b e d)', text, re.I)
    if m:
        return m.group(1) + " BHK"
    if re.search(r'\bstudio\b', text, re.I):
        return "Studio"
    return None


def _lines_to_listings(
    text: str,
    section_intent: str | None,
    section_furnish: str | None,
    shared_building: str | None,
    profile_name: str | None,
    hierarchical_ctx: dict | None = None,
) -> list[dict]:
    """Convert a section's text lines into listing dicts with inherited context."""
    ctx = hierarchical_ctx or {}
    results: list[dict] = []
    for line in text.split("\n"):
        line = line.strip()
        if not line:
            continue
        area = _parse_area_from_text(line)
        price, unit = _parse_price_from_text(line)
        if area is None and price is None:
            continue

        bhk = _parse_bhk_from_text(line)
        furnishing = _parse_furnishing_from_text(line) or section_furnish
        attrs = extract_property_attributes(line)
        listing_source = detect_listing_source(line)

        result: dict = {
            "intent": "listing",
            "principal": None,
            "bhk": bhk,
            "price": price,
            "price_unit": unit,
            "area_sqft": area,
            "furnishing": furnishing,
            "location_raw": shared_building,
            "building_name": validate_building_name(shared_building),
            "landmark_name": shared_building,
            "street_name": None,
            "area": None,
            "micro_market": None,
            "developer": None,
            "broker_name": None,
            "broker_phone": None,
            "forwarded": 0,
            "confidence": 0.85,
            "raw_payload": {"full_text": line},
            "location": {},
            # Property attribute fields
            "floor_description": attrs.get("floor_description"),
            "view": attrs.get("view"),
            "orientation": attrs.get("orientation"),
            "position": attrs.get("position"),
            # Hierarchical context
            "project_name": ctx.get("project_name"),
            "tower_name": ctx.get("tower_name"),
            "wing_name": ctx.get("wing_name"),
            # Listing source
            "listing_source": listing_source,
        }
        results.append(result)
    return results


def _extract_location_from_text(text: str) -> dict:
    """Run the location parser on text and return location fields."""
    from lab.location import parse_location
    loc = parse_location(text)
    result = {
        "location_raw": loc.raw,
        "location": loc.to_dict(),
    }
    if loc.raw and len(loc.raw) >= 3:
        if loc.landmark:
            result["landmark_name"] = loc.landmark
        elif loc.building:
            result["landmark_name"] = loc.building
        elif loc.micro_market:
            result["landmark_name"] = loc.micro_market
        elif loc.locality:
            result["landmark_name"] = loc.locality
        if loc.building:
            result["building_name"] = loc.building
        if loc.micro_market:
            result["micro_market"] = loc.micro_market
        if loc.street:
            result["street_name"] = loc.street
    return result


def _enrich_listing_with_building_db(
    listing: dict,
    building_lookup_fn: Callable | None,
) -> dict:
    """Enrich listing with building database info if available."""
    if not building_lookup_fn:
        return listing
    building_name = listing.get("building_name")
    if building_name:
        try:
            found = building_lookup_fn(building_name)
            if found:
                listing["building_name"] = found["canonical_name"]
                listing["developer"] = found.get("developer") or listing.get("developer")
                listing["micro_market"] = found.get("micro_market") or listing.get("micro_market")
                # Store building_id in a temporary field for downstream use
                listing["_building_id"] = found.get("building_id")
                listing["_building_match_confidence"] = found.get("confidence")
        except Exception:
            pass
    return listing


def _split_commercial_floors(text: str) -> list[dict]:
    """Split commercial floor-pricing message into listing dicts.

    Detects lines like '2nd floor', 'ground + one' as block delimiters,
    each followed by area and per-sqft price lines.  When a block has
    multiple intent lines (sale + lease), produces one listing per intent.

    Extracts building name, micro_market, and location context from the
    header lines preceding the first floor indicator.  Computes total
    price from per-sqft rate × area and scales to Cr/Lac/K units.
    """
    lines = [l.strip() for l in text.split("\n") if l.strip()]
    if not lines:
        return []

    # Find floor indicator line indices
    floor_indices = []
    for i, line in enumerate(lines):
        if _FLOOR_LINE_RE.search(line):
            floor_indices.append(i)
    if len(floor_indices) < 2:
        return []

    # ── Extract overall context from header (before first floor line) ──
    header_end = floor_indices[0]
    header_lines = lines[:header_end]
    header_text = "\n".join(header_lines)

    # Extract area values from header as fallback for blocks that lack their own
    header_areas = []
    for hl in header_lines:
        a = _parse_area_from_text(hl)
        if a is not None:
            header_areas.append(a)
    header_max_area = max(header_areas) if header_areas else None

    # Extract location context from header (before first floor indicator)
    # Use header-only parsing to avoid street/road names overwriting micro_market
    header_loc = _extract_location_from_text(header_text) if header_text.strip() else {}
    overall_loc = _extract_location_from_text(text)
    loc_building = None  # commercial listings often lack explicit building names
    # Prefer header-derived location_raw; fall back to overall
    loc_raw = header_loc.get("location_raw") or overall_loc.get("location_raw") or (header_lines[0] if header_lines else None)
    # Prefer header-derived micro_market (less likely to be overwritten by street names)
    loc_micro_market = header_loc.get("micro_market") or overall_loc.get("micro_market")

    # Extract broker info from the full message signature
    broker_name, broker_phone = _extract_broker_from_block(text)

    # ── Build floor blocks ──
    blocks: list[list[str]] = []
    for idx, start in enumerate(floor_indices):
        end = floor_indices[idx + 1] if idx + 1 < len(floor_indices) else len(lines)
        blk = lines[start:end]
        if len(blk) >= 2:
            blocks.append(blk)

    results: list[dict] = []
    for block in blocks:
        floor_line = block[0]
        rest = block[1:]

        # Clean floor description — extract just the floor range/name
        clean_floor = _clean_floor_description(floor_line)

        # Extract area from floor line first, then rest, then header fallback
        area = _parse_area_from_text(floor_line)
        if area is None:
            for line in rest:
                a = _parse_area_from_text(line)
                if a is not None:
                    area = a
                    break
        if area is None and header_max_area is not None:
            area = header_max_area

        # Find all per-sqft price lines (check floor_line too)
        price_lines = []
        candidates = [floor_line] + rest
        for line in candidates:
            # Strip "CAD"/"CAM" to avoid regex interference
            clean_line = re.sub(r'\s*\+\s*(?:cad|cam)\b', '', line, flags=re.I)
            per_m = _PER_SQFT_RE.search(clean_line)
            if per_m:
                amount = _parse_amount(per_m.group(1))
                if amount is not None:
                    scale = per_m.group(2)
                    if scale:
                        sl = scale.strip().lower().rstrip("s")
                        if sl in ("k", "thousand"):
                            amount *= 1000
                        elif sl in ("lac", "lakh", "l"):
                            amount *= 100000
                        elif sl in ("cr", "crore"):
                            amount *= 10000000

                    intent = _detect_intent_from_line(line)
                    price_lines.append({"amount": amount, "intent": intent, "line": line})

        if not price_lines:
            # Fallback: try standard price regex on clean line
            for line in [floor_line] + rest:
                clean_line = re.sub(r'\s*\+\s*(?:cad|cam)\b', '', line, flags=re.I)
                price, unit = _parse_price_from_text(clean_line)
                if price is not None:
                    price_lines.append({"amount": price, "intent": _detect_intent_from_line(line), "line": line})

        for pl in price_lines:
            per_sqft_amount = pl["amount"]

            # Compute total price = per-sqft rate × area
            total_price = None
            total_unit = None
            if per_sqft_amount is not None and area is not None:
                total = per_sqft_amount * area
                if total >= 10000000:
                    total_price = round(total / 10000000, 2)
                    total_unit = "Cr"
                elif total >= 100000:
                    total_price = round(total / 100000, 2)
                    total_unit = "Lac"
                elif total >= 1000:
                    total_price = round(total / 1000, 2)
                    total_unit = "K"
                else:
                    total_price = round(total, 2)
                    total_unit = "abs"
            else:
                total_price = per_sqft_amount
                total_unit = "abs"

            result = {
                "intent": pl["intent"] or _infer_intent_from_text(header_text + "\n" + "\n".join(block)),
                "principal": None,
                "bhk": None,
                "price": total_price,
                "price_unit": total_unit,
                "price_per_sqft": per_sqft_amount,
                "area_sqft": area,
                "furnishing": None,
                "location_raw": loc_raw,
                "building_name": loc_building,
                "landmark_name": loc_building or loc_micro_market,
                "street_name": None,
                "area": None,
                "micro_market": loc_micro_market,
                "developer": None,
                "broker_name": broker_name,
                "broker_phone": broker_phone,
                "forwarded": 0,
                "confidence": 0.85,
                "raw_payload": {"full_text": "\n".join(block)},
                "location": overall_loc.get("location") or {},
                "floor_description": clean_floor,
                "view": None,
                "orientation": None,
                "position": None,
                "project_name": None,
                "tower_name": None,
                "wing_name": None,
                "listing_source": None,
            }
            results.append(result)

    # Filter: only include listings with at least area or price
    results = [r for r in results if r.get("area_sqft") is not None or r.get("price") is not None]

    return results


def _clean_floor_description(floor_line: str) -> str:
    """Extract a clean floor label from a floor line.

    Converts things like '3 rd floor semi retail' -> '3rd Floor',
    '4th floor to 14th floor' -> '4th-14th Floor',
    'Ground + one' -> 'Ground+1'.
    """
    m = re.match(
        r'^\s*((?:ground\s*\+?\s*one|terrace|basement|stilt)'
        r'|\d+\s*(?:st|nd|rd|th)?\s*(?:floor|flr|fl)'
        r'(?:\s*to\s+\d+\s*(?:st|nd|rd|th)?\s*(?:floor|flr|fl))?)',
        floor_line.strip(), re.I
    )
    if m:
        raw = m.group(1).strip()
        # Normalize "Ground + one" -> "Ground+1"
        raw = re.sub(r'\s*\+\s*one\b', '+1', raw, flags=re.I)
        # Normalize "3 rd Floor" -> "3rd Floor" and "2nd floor" -> "2nd Floor"
        raw = re.sub(r'(\d+)\s*(st|nd|rd|th)\s+(?:floor|flr|fl)', r'\1\2 Floor', raw, flags=re.I)
        # Normalize "4th Floor to 14th Floor" -> "4th-14th Floor"
        raw = re.sub(
            r'(\d+(?:st|nd|rd|th)?)\s*(?:floor|flr|fl)\s+to\s+(\d+(?:st|nd|rd|th)?)\s*(?:floor|flr|fl)',
            r'\1-\2 Floor', raw, flags=re.I
        )
        # Normalize standalone floor line: "2nd Floor"
        raw = re.sub(r'\b(floor|flr|fl)\b', 'Floor', raw, flags=re.I)
        # No title-case — just capitalize the first letter
        raw = raw[0].upper() + raw[1:] if raw else raw
        return raw
    return floor_line.strip()


def _detect_intent_from_line(line: str) -> str | None:
    intent_m = _INTENT_ON_LINE_RE.search(line)
    if intent_m:
        it = intent_m.group(0).lower()
        if "sale" in it:
            return "Sale"
        if "l" in it or "lease" in it or "rent" in it or "licence" in it:
            return "Lease"
    if "cost" in line.lower() or "rate" in line.lower():
        return "Lease"
    return None


def parse_multi_message(
    text: str,
    profile_name: str | None = None,
    building_lookup_fn: Callable | None = None,
) -> list[dict]:
    """Parse a multi-listing message into individual listing dicts.

    Each entry has the same structure as parse_message() output.
    Extracts hierarchical context (project, tower, wing) and validates
    building names. Returns empty list if the message doesn't look multi-listing.
    """
    # Extract document-level hierarchical context
    hier_ctx = extract_hierarchical_context(text)

    # Try commercial floor-pricing split (early return - distinct format)
    floor_listings = _split_commercial_floors(text)
    if len(floor_listings) >= 2:
        enriched = []
        for listing in floor_listings:
            listing = _enrich_listing_with_building_db(listing, building_lookup_fn)
            enriched.append(listing)
        return enriched

    numbered_blocks = _split_numbered_blocks(text)
    if len(numbered_blocks) >= 2:
        listings = []
        for i, block in enumerate(numbered_blocks):
            block_ctx = dict(hier_ctx)
            # Check for context overrides within this block
            block_hier = extract_hierarchical_context(block)
            block_ctx.update({k: v for k, v in block_hier.items() if v is not None})
            parsed = _parse_numbered_block(block, profile_name, hierarchical_ctx=block_ctx)
            if parsed:
                parsed = _enrich_listing_with_building_db(parsed, building_lookup_fn)
                listings.append(parsed)
        if listings:
            return listings

    # Try divider-based split (________ separators)
    divider_blocks = _split_by_dividers(text)
    if len(divider_blocks) >= 2:
        listings = []
        for block in divider_blocks:
            block_ctx = dict(hier_ctx)
            block_hier = extract_hierarchical_context(block)
            block_ctx.update({k: v for k, v in block_hier.items() if v is not None})
            parsed = _parse_divider_block(block, profile_name, hierarchical_ctx=block_ctx)
            if parsed:
                parsed = _enrich_listing_with_building_db(parsed, building_lookup_fn)
                listings.append(parsed)
        if len(listings) >= 2:
            return listings

    repeated_blocks = _split_repeated_available_blocks(text)
    if len(repeated_blocks) >= 2:
        listings = []
        for block in repeated_blocks:
            block_ctx = dict(hier_ctx)
            block_hier = extract_hierarchical_context(block)
            block_ctx.update({k: v for k, v in block_hier.items() if v is not None})
            parsed = _parse_divider_block(block, profile_name, hierarchical_ctx=block_ctx)
            if parsed:
                parsed = _enrich_listing_with_building_db(parsed, building_lookup_fn)
                listings.append(parsed)
        if len(listings) >= 2:
            return listings

    # Try 📍 pin-based split (Prakash Jha-style bulk forwards with per-listing pins)
    pin_blocks = _split_by_pin_markers(text)
    if len(pin_blocks) >= 2:
        listings = []
        for block in pin_blocks:
            block_ctx = dict(hier_ctx)
            block_hier = extract_hierarchical_context(block)
            block_ctx.update({k: v for k, v in block_hier.items() if v is not None})
            parsed = _parse_divider_block(block, profile_name, hierarchical_ctx=block_ctx)
            if parsed:
                parsed = _enrich_listing_with_building_db(parsed, building_lookup_fn)
                listings.append(parsed)
        if len(listings) >= 2:
            return listings

    building = _extract_building(text)
    building = validate_building_name(building)
    sections = _split_sections(text)

    if not sections:
        return []

    # Extract shared location context from the full message
    shared_location = _extract_location_from_text(text)

    # Build per-section hierarchical context by blank-line splitting
    # Each blank-line-separated block may carry its own tower/wing context
    raw_lines = text.strip().split("\n")
    raw_blocks: list[list[str]] = [[]]
    for line in raw_lines:
        if line.strip() == "":
            if any(l.strip() for l in raw_blocks[-1]):
                raw_blocks.append([])
        else:
            raw_blocks[-1].append(line)
    if raw_blocks and not any(l.strip() for l in raw_blocks[-1]):
        raw_blocks.pop()

    # Match sections to raw blocks for per-block context
    block_idx = 0
    all_listings: list[dict] = []

    for sec in sections:
        sec_ctx = dict(hier_ctx)
        # Advance through raw blocks to find context for this section
        while block_idx < len(raw_blocks):
            block_text = "\n".join(raw_blocks[block_idx])
            block_hier = extract_hierarchical_context(block_text)
            sec_ctx.update({k: v for k, v in block_hier.items() if v is not None})
            block_idx += 1
            # Check if this block contains the section's first listing line
            if sec["lines"]:
                first_line = sec["lines"][0]
                if first_line in block_text:
                    break

        sec_text = "\n".join(sec["lines"])
        listings = _lines_to_listings(
            sec_text,
            sec["intent"],
            sec["furnishing"],
            building,
            profile_name,
            hierarchical_ctx=sec_ctx,
        )
        # Merge shared location context into each listing
        for listing in listings:
            if shared_location.get("building_name") and not listing.get("building_name"):
                listing["building_name"] = shared_location["building_name"]
            if shared_location.get("landmark_name") and not listing.get("landmark_name"):
                listing["landmark_name"] = shared_location["landmark_name"]
            if shared_location.get("micro_market") and not listing.get("micro_market"):
                listing["micro_market"] = shared_location["micro_market"]
            if shared_location.get("location_raw") and not listing.get("location_raw"):
                listing["location_raw"] = shared_location["location_raw"]
            listing = _enrich_listing_with_building_db(listing, building_lookup_fn)
        all_listings.extend(listings)

    if not all_listings:
        return []

    return all_listings
