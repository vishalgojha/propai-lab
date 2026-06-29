"""Multi-listing message classifier and section splitter.

Detects whether a WhatsApp message contains multiple listings
and splits them into individual parsed entries.
"""

import re

# ── Classification ──────────────────────────────────────────────────

_MULTI_INDICATORS: list[tuple[str, re.Pattern]] = [
    ("area_price_pair", re.compile(
        r'(\d[\d,]*)\s*(sq\.?\s*ft|sqft|sft|sq\s*feet)\s*[-–—:]?\s*'
        r'(?:rs\.?\s*|inr\s*|₹)?\s*([\d,.]+)\s*(cr|crore|lac|lakh|l|k|thousand)',
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
        r'(?:cr|crore|lac|lakh|l|k|thousand)\b',
        re.I,
    )),
    ("bhk_price_pair", re.compile(
        r'(\d+)\s*(bhk|rk)\s*[-–—:]?\s*'
        r'(?:rs\.?\s*|inr\s*|₹)?\s*([\d,.]+)\s*(cr|crore|lac|lakh|l|k|thousand)',
        re.I,
    )),
]


def classify_message(text: str) -> str:
    """Classify a message into: 'single', 'multi', 'requirement', 'market_update', 'promo'."""
    lines = [l.strip() for l in text.strip().split("\n") if l.strip()]
    lower = text.lower()

    area_price_pairs = 0
    section_headers = 0
    bhk_price_pairs = 0
    numbered_listing_headers = 0

    for line in lines:
        if _MULTI_INDICATORS[0][1].search(line):
            area_price_pairs += 1
        if _MULTI_INDICATORS[1][1].search(line):
            section_headers += 1
        if _MULTI_INDICATORS[4][1].search(line):
            bhk_price_pairs += 1
        if _NUMBERED_LISTING_RE.match(line):
            numbered_listing_headers += 1

    if numbered_listing_headers >= 2:
        return "multi"

    if area_price_pairs >= 2 or bhk_price_pairs >= 2:
        return "multi"

    if section_headers >= 2 and (area_price_pairs >= 1 or bhk_price_pairs >= 1):
        return "multi"

    if (area_price_pairs >= 1 or bhk_price_pairs >= 1) and len(lines) >= 4:
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
    r'(?:rs\.?\s*|inr\s*|₹)?\s*([\d,.]+)\s*(cr|crore|lac|lakh|l|k|thousand)',
    re.I,
)

_AREA_ONLY_RE = re.compile(r'(\d[\d,]*)\s*(sq\.?\s*ft|sqft|sft|sq\s*feet)', re.I)
_PRICE_ONLY_RE = re.compile(
    r'(?:rs\.?\s*|inr\s*|₹)?\s*([\d,.]+)\s*(cr|crore|lac|lakh|l|k|thousand)\b',
    re.I,
)
_PRICE_RANGE_RE = re.compile(
    r'(?:rs\.?\s*|inr\s*|₹)?\s*([\d,.]+)\s*(?:cr|crore|lac|lakh|l|k|thousand)?\s*'
    r'[-–—]\s*(?:rs\.?\s*|inr\s*|₹)?\s*([\d,.]+)\s*'
    r'(cr|crore|lac|lakh|l|k|thousand)\b',
    re.I,
)

_BUILDING_HEADER_RE = re.compile(
    r'^\s*(?:project|building|property|complex|tower|wing)\s*[-–—:]\s*(.+)',
    re.I,
)
_BUILDING_NAME_RE = re.compile(r'^\s*(building|project|name)\s*[-–—:]\s*(.+)', re.I)
_NUMBERED_LISTING_RE = re.compile(
    r'^\s*(?:[⭐*•-]\s*)?(?:\d{1,3})\s*[\).:-]\s*(?=.*(?:bhk|rk|studio))(.+)',
    re.I,
)
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
        hm = _SECTION_HEADER_RE.match(line)
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
    if re.search(r'\b(commercial|office|shop|showroom|warehouse|godown|retail)\b', lower):
        return "COMMERCIAL"
    if re.search(r'\b(rent|rental|lease|tenant)\b', lower):
        return "RENT"
    if re.search(r'\b(outright|sale|sell|resale|ready to move)\b', lower):
        return "SELL"
    return "SELL"


def _parse_numbered_block(block: str, profile_name: str | None) -> dict | None:
    bhk, building = _extract_title_parts(block)
    area = _parse_area_from_text(block)
    price, unit = _parse_price_from_text(block)
    location_line = _extract_location_line(block)
    location_context = "\n".join([v for v in [building, location_line] if v]) or block
    loc = _extract_location_from_text(location_context)

    if not any([bhk, building, area, price, location_line]):
        return None

    result: dict = {
        "intent": _infer_intent_from_text(block),
        "principal": None,
        "bhk": bhk,
        "price": price,
        "price_unit": unit,
        "area_sqft": area,
        "furnishing": _parse_furnishing_from_text(block),
        "location_raw": location_line or loc.get("location_raw"),
        "building_name": building or loc.get("building_name"),
        "landmark_name": loc.get("landmark_name"),
        "street_name": loc.get("street_name"),
        "area": None,
        "micro_market": loc.get("micro_market"),
        "developer": None,
        "broker_name": None,
        "broker_phone": None,
        "forwarded": 0,
        "confidence": 0.88,
        "raw_payload": {"full_text": block},
        "location": loc.get("location") or {},
    }
    return result


# ── Multi-listing parser ────────────────────────────────────────────

def _parse_price_from_text(text: str) -> tuple[float | None, str | None]:
    """Extract (price_in_raw, unit) from a line."""
    range_match = _PRICE_RANGE_RE.search(text)
    if range_match:
        amount = float(range_match.group(1).replace(",", ""))
        unit_raw = range_match.group(3).lower()
        if unit_raw in ("cr", "crore"):
            return amount * 10000000, "Cr"
        elif unit_raw in ("lac", "lakh", "l"):
            return amount * 100000, "Lac"
        elif unit_raw in ("k", "thousand"):
            return amount * 1000, "K"

    m = _PRICE_ONLY_RE.search(text)
    if m:
        amount = float(m.group(1).replace(",", ""))
        unit_raw = m.group(2).lower()
        if unit_raw in ("cr", "crore"):
            return amount * 10000000, "Cr"
        elif unit_raw in ("lac", "lakh", "l"):
            return amount * 100000, "Lac"
        elif unit_raw in ("k", "thousand"):
            return amount * 1000, "K"
    return None, None


def _parse_area_from_text(text: str) -> float | None:
    m = _AREA_ONLY_RE.search(text)
    if m:
        return float(m.group(1).replace(",", ""))
    return None


def _parse_furnishing_from_text(text: str) -> str | None:
    lower = text.lower()
    if any(x in lower for x in ["fully furnished", "fully fur", "ff"]):
        return "Fully Furnished"
    if any(x in lower for x in ["semi furnished", "semi fur", "sf"]):
        return "Semi Furnished"
    if any(x in lower for x in ["unfurnished", "un furn", "uf", "un-furnished"]):
        return "Unfurnished"
    return None


def _parse_bhk_from_text(text: str) -> str | None:
    range_match = re.search(r'(\d+\s*/\s*\d+)\s*bhk', text, re.I)
    if range_match:
        return re.sub(r'\s+', '', range_match.group(1)) + " BHK"
    m = re.search(r'(\d+)\s*(bhk|rk|bedroom|b ed|b e d)', text, re.I)
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
) -> list[dict]:
    """Convert a section's text lines into listing dicts."""
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

        result: dict = {
            "intent": section_intent,
            "principal": None,
            "bhk": bhk,
            "price": price,
            "price_unit": unit,
            "area_sqft": area,
            "furnishing": furnishing,
            "location_raw": shared_building,
            "building_name": shared_building,
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
        elif loc.micro_market:
            result["landmark_name"] = loc.micro_market
        elif loc.building:
            result["landmark_name"] = loc.building
        elif loc.locality:
            result["landmark_name"] = loc.locality
        if loc.building:
            result["building_name"] = loc.building
        if loc.micro_market:
            result["micro_market"] = loc.micro_market
        if loc.street:
            result["street_name"] = loc.street
    return result


def parse_multi_message(
    text: str,
    profile_name: str | None = None,
) -> list[dict]:
    """Parse a multi-listing message into individual listing dicts.

    Each entry has the same structure as parse_message() output.
    Returns empty list if the message doesn't look multi-listing.
    """
    numbered_blocks = _split_numbered_blocks(text)
    if len(numbered_blocks) >= 2:
        listings = [
            parsed
            for block in numbered_blocks
            if (parsed := _parse_numbered_block(block, profile_name))
        ]
        if listings:
            return listings

    building = _extract_building(text)
    sections = _split_sections(text)

    if not sections:
        return []

    # Extract shared location context from the full message
    shared_location = _extract_location_from_text(text)

    all_listings: list[dict] = []

    for sec in sections:
        sec_text = "\n".join(sec["lines"])
        listings = _lines_to_listings(
            sec_text,
            sec["intent"],
            sec["furnishing"],
            building,
            profile_name,
        )
        # Merge shared location context into each listing
        for listing in listings:
            # Prefer extracted building over shared_building
            if shared_location.get("building_name") and not listing.get("building_name"):
                listing["building_name"] = shared_location["building_name"]
            if shared_location.get("landmark_name") and not listing.get("landmark_name"):
                listing["landmark_name"] = shared_location["landmark_name"]
            if shared_location.get("micro_market") and not listing.get("micro_market"):
                listing["micro_market"] = shared_location["micro_market"]
            if shared_location.get("location_raw") and not listing.get("location_raw"):
                listing["location_raw"] = shared_location["location_raw"]
        all_listings.extend(listings)

    if not all_listings:
        return []

    return all_listings
