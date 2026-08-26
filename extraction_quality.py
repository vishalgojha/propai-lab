"""Source-grounded guards for fields that are commonly cross-wired by AI.

This module deliberately contains no database or provider code.  It is used at
both the AI normalisation boundary and the typed-row boundary so WhatsApp,
self-chat, WABA and MCP intake all get the same protection.
"""

from __future__ import annotations

import re


_SIMPLE_PSF_RE = re.compile(
    r"\b(?P<label>price\s+sale|sale\s+price|sale|quote|rent|rental|rate)\b"
    r"[^0-9]{0,80}(?P<amount>\d[\d,]*(?:\.\d+)?)\s*"
    r"(?P<multiplier>k|thousand|lakh|lac|cr)?\s*"
    r"(?:psf|per\s*/?\s*sq\.?\s*ft|per\s+sqft|per\s+square\s+feet)\b",
    re.IGNORECASE,
)

_CONFIDENCE_LABELS = frozenset({"high", "medium", "low"})


def price_total_needs_quarantine(
    transaction_type: object,
    amount: object,
    asset_type: object = None,
) -> bool:
    """Reject non-property-scale totals at the typed persistence boundary.

    This applies only to a total sale price or monthly rent; PSF rates can be
    smaller and are validated separately.
    """
    try:
        value = float(amount)
    except (TypeError, ValueError):
        return False
    if value <= 0:
        return False
    tx = str(transaction_type or "").strip().casefold()
    asset = str(asset_type or "").strip().casefold()
    if tx == "rent":
        return value < 1_000
    if tx == "sale":
        return value < (1_000_000 if asset == "commercial" else 100_000)
    return False


def _confidence_score(value: object) -> float | None:
    try:
        score = float(value)
    except (TypeError, ValueError):
        return None
    if score != score:  # NaN
        return None
    return max(0.0, min(1.0, score))


def canonicalize_extraction_confidence(item: dict, *, force_review: bool = False) -> dict:
    """Make the numeric score the source of truth for confidence.

    Older AI payloads can contain ``high`` alongside a zero score.  That is
    contradictory and unsafe: downstream consumers must never promote such a
    row based on the label alone.  A missing score is backfilled from the
    label for compatibility, but an explicitly supplied zero remains zero.
    """
    corrected = dict(item or {})
    nested_label = str(corrected.get("extraction_confidence") or "").strip().lower()
    score_present = corrected.get("extraction_confidence_score") is not None
    score = _confidence_score(corrected.get("extraction_confidence_score"))
    if score is None and not score_present:
        score = {
            "high": 0.9,
            "medium": 0.7,
            "low": 0.4,
        }.get(nested_label, _confidence_score(corrected.get("confidence")) or 0.0)
    score = score if score is not None else 0.0
    if force_review or corrected.get("needs_review") is True:
        score = min(score, 0.4)
    label = "high" if score >= 0.85 else ("medium" if score >= 0.6 else "low")
    corrected["extraction_confidence_score"] = score
    corrected["extraction_confidence"] = label
    corrected["confidence"] = score
    return corrected


def extract_simple_psf_rate(source_text: object) -> dict | None:
    """Extract one unambiguous labelled ``<number> psf`` quote.

    This intentionally handles only a plain broker rate line.  If a source
    contains multiple different PSF quotes, semantic selection belongs to the
    extraction pipeline and this guard declines to guess.
    """
    matches = []
    for match in _SIMPLE_PSF_RE.finditer(str(source_text or "")):
        try:
            amount = float(match.group("amount").replace(",", ""))
        except (TypeError, ValueError):
            continue
        multiplier = (match.group("multiplier") or "").lower()
        amount *= {"k": 1_000, "thousand": 1_000, "lakh": 100_000, "lac": 100_000}.get(multiplier, 1)
        matches.append({"amount": amount, "raw_text": match.group(0).strip()})
    if not matches:
        return None
    amounts = {entry["amount"] for entry in matches}
    if len(amounts) != 1:
        return None
    return matches[0]


def apply_price_sanity_guard(item: dict, source_text: object) -> dict:
    """Repair/quarantine an AI PSF amount that contradicts source evidence."""
    corrected = dict(item or {})
    price = corrected.get("price")
    if not isinstance(price, dict):
        return canonicalize_extraction_confidence(corrected)
    source_quote = extract_simple_psf_rate(source_text)
    if source_quote is None:
        return canonicalize_extraction_confidence(corrected)
    try:
        ai_amount = float(price.get("amount"))
    except (TypeError, ValueError):
        ai_amount = None
    source_amount = source_quote["amount"]
    mismatch = (
        ai_amount is not None
        and ai_amount > 0
        and source_amount > 0
        and max(ai_amount, source_amount) / min(ai_amount, source_amount) > 2
    )
    if mismatch:
        corrected["price"] = {
            **price,
            "amount": source_amount,
            "unit": "per_sqft",
            "period": None,
            "raw_price_text": source_quote["raw_text"],
        }
        corrected["needs_review"] = True
        corrected["validation_flags"] = list(dict.fromkeys(
            list(corrected.get("validation_flags") or [])
            + ["price_psf_ai_mismatch_corrected"]
        ))
    return canonicalize_extraction_confidence(corrected, force_review=mismatch)


_PRICE_ONLY_RE = re.compile(
    r"^\s*(?:₹|rs\.?|inr)?\s*\d+(?:[,.]\d+)?\s*"
    r"(?:k|thousand|l|lac|lacs|lakh|lakhs|cr|crore|crores)\b"
    r"(?:\s*(?:/\s*(?:month|monthy|mo)|per\s*month))?\s*"
    r"(?:negotiable)?\s*$",
    re.IGNORECASE,
)
_CONFIG_ONLY_RE = re.compile(r"^\s*\d+(?:\.\d+)?\s*(?:bhk|rk)\s*$", re.IGNORECASE)
_NUMBER_ONLY_RE = re.compile(r"^\s*[\d,.]+\s*(?:sq\.?\s*ft|sqft|sft)?\s*$", re.IGNORECASE)
_PHONE_ONLY_RE = re.compile(r"^\s*(?:\+?91[-\s]?)?[6-9]\d{9}\s*$")
_PHONE_IN_TEXT_RE = re.compile(r"(?<!\d)(?:\+?91[-\s]?)?[6-9]\d{9}(?!\d)")
_LOCALITY_ONLY_RE = re.compile(
    r"^\s*(?:near\s+)?(?:bandra|khar|santacruz|andheri|ndheri|juhu|powai|worli|"
    r"lower\s+parel|pali\s+hill|peddar\s+road|mahim|malabar\s+hill|"
    r"chembur|thane|mulund|goregaon|malad|vikhroli|ghatkopar|bkc|"
    r"navi\s+mumbai|matunga|dadar|vile\s+parle)(?:\s+(?:east|west|"
    r"naka|road|hill|east\s+west))?\s*$",
    re.IGNORECASE,
)

_LOCALITY_ALIASES = {
    "ndheri west": "Andheri West",
    "ndheri east": "Andheri East",
    # Keep the display spelling aligned with locality_reference.canonical_locality.
    "bkc": "Bandra Kurla Complex",
    "bandra kurla complex": "Bandra Kurla Complex",
}


def canonical_locality_alias(value: object) -> str:
    """Return a conservative display locality for known source typos.

    This is used for search/enrichment context only; the original WhatsApp
    spelling remains in the stored evidence.
    """
    text = re.sub(r"\s+", " ", clean_source_line(value))
    return _LOCALITY_ALIASES.get(text.casefold(), text)

_NON_BUILDING_RE = re.compile(
    r"\b(?:fully\s+furnished|semi[-\s]?furnished|unfurnished|bare\s+shell|"
    r"\d+(?:\.\d+)?\s*(?:bhk|rk)|purchase|"
    r"higher\s+floor|middle\s+floor|lower\s+floor|ground\s+floor|"
    r"\d+(?:st|nd|rd|th)?\s+floor|car\s+parks?|parking|rent|sale|lease|"
    r"\d+(?:\.\d+)?\s+(?:bathrooms?|washrooms?|toilets?)|"
    r"price|budget|deposit|swimming\s+pool|negotiable|available|on\s+request|direct\s+inventor(?:y|ies)|"
    r"for\s+more\s+details|contact|call|inspection|photos?|options?|"
    r"ownership|thanks?|regards?|pl(?:z|ease)|urgent|requirement|"
    r"client\s+(?:business\s+)?profile|allow\s+\d+\s*hrs?|set\s+up\s+visits?|"
    r"ideal\s+for|(?:with\s+)?(?:a\s+)?(?:backside|rear)\s+exit)\b",
    re.IGNORECASE,
)
_INVALID_BUILDING_LABEL_RE = re.compile(
    r"^\s*swimming\s+pool\b",
    re.IGNORECASE,
)
_GENERIC_BUILDING_LABEL_RE = re.compile(
    r"^(?:(?:[a-z][a-z .'/&-]{1,45})\s*[-–—]\s*)?"
    r"(?:premium|confidential|unnamed|unknown|new)\s+"
    r"(?:tower|building|project|society|property)$",
    re.IGNORECASE,
)


def clean_source_line(value: object) -> str:
    """Remove WhatsApp decoration without changing the evidence text."""
    return re.sub(r"[*_`~]", "", str(value or "")).strip(" \t-–—:•")


def building_name_problem(value: object, *, locality: str | None = None) -> str | None:
    """Return a stable validation code when ``value`` is not a building name."""
    text = clean_source_line(value)
    if not text:
        return None
    compact = re.sub(r"\s+", " ", text).strip()
    lowered = compact.casefold()
    if _PRICE_ONLY_RE.fullmatch(compact):
        return "building_name_is_price"
    if _CONFIG_ONLY_RE.fullmatch(compact):
        return "building_name_is_configuration"
    if _NUMBER_ONLY_RE.fullmatch(compact):
        return "building_name_is_number"
    if _PHONE_ONLY_RE.fullmatch(compact):
        return "building_name_is_phone"
    embedded_phone = _PHONE_IN_TEXT_RE.search(compact)
    if embedded_phone:
        # Remove the contact before re-validating the remainder so punctuation
        # and whitespace do not hide the fact that this is broker/contact text.
        remainder = clean_source_line(_PHONE_IN_TEXT_RE.sub(" ", compact))
        if len(remainder) < 3:
            return "building_name_contains_phone"
        if remainder != compact and building_name_problem(remainder, locality=locality):
            return "building_name_contains_phone"
        # A text-like remainder ("Sailee", "Office", etc.) is still not
        # evidence of a physical building. Quarantine the original value and
        # let source-slice repair look for a real building name.
        return "building_name_contains_phone"
    if locality and lowered == clean_source_line(locality).casefold():
        return "building_name_is_locality"
    if _LOCALITY_ONLY_RE.fullmatch(compact):
        return "building_name_is_locality"
    if _INVALID_BUILDING_LABEL_RE.search(compact):
        return "building_name_is_listing_text"
    if _NON_BUILDING_RE.search(compact):
        return "building_name_is_listing_text"
    if _GENERIC_BUILDING_LABEL_RE.fullmatch(compact):
        return "building_name_is_generic_descriptor"
    if len(compact) < 3 or len(compact) > 100:
        return "building_name_bad_length"
    return None


def _candidate_lines(source_text: str) -> list[str]:
    return [clean_source_line(line) for line in str(source_text or "").splitlines()]


def _meaningful_tokens(value: object) -> set[str]:
    stop = {
        "the", "and", "at", "in", "for", "near", "road", "west", "east",
        "tower", "building", "heights", "residency", "residential",
    }
    return {
        token for token in re.findall(r"[a-z0-9]+", str(value or "").casefold())
        if len(token) >= 3 and token not in stop
    }


def infer_building_from_slice(
    source_text: str,
    *,
    locality: str | None = None,
    bhk: object = None,
) -> str | None:
    """Find a conservative building line in the current listing slice.

    This is intentionally allowed to return ``None``.  It must never promote a
    price, floor, furnishing, locality, broker footer, or configuration into a
    building merely to fill a blank field.
    """
    lines = _candidate_lines(source_text)
    bhk_re = re.compile(r"\b\d+(?:\.\d+)?\s*(?:bhk|rk)\b", re.IGNORECASE)
    start = 0
    for index, line in enumerate(lines):
        if bhk_re.search(line) or (bhk is not None and str(bhk).strip() and str(bhk).casefold() in line.casefold()):
            start = index + 1
            break
    locality_value = clean_source_line(locality).casefold() if locality else None
    for line in lines[start:start + 6]:
        if not line or len(line) > 90:
            continue
        if locality_value and line.casefold() == locality_value:
            continue
        if building_name_problem(line, locality=locality):
            continue
        if re.search(r"\b(?:sq\.?\s*ft|sqft|carpet|area|rent|sale|lease|deposit|floor|"
                     r"parking|possession|inspection|details|contact|call)\b", line, re.IGNORECASE):
            continue
        if not re.search(r"[A-Za-z]", line):
            continue
        return line.strip(" .,;:")
    return None


def repair_building_assignment(
    item: dict,
    source_text: str,
    *,
    ai_item: dict | None = None,
) -> dict:
    """Repair or quarantine a building value against its own source slice."""
    locality = item.get("micro_market") or item.get("location_raw")
    current = (
        item.get("building_name")
        or item.get("building_name_raw_candidate")
        or (ai_item or {}).get("building_name_raw_candidate")
    )
    problem = building_name_problem(current, locality=locality)
    if not problem and current:
        # A valid-looking name copied from a sibling block is still unsafe.
        # Require at least one meaningful token in this item's source slice;
        # aliases can then be resolved downstream without allowing a totally
        # unrelated building to leak across blocks.
        if _meaningful_tokens(current).isdisjoint(_meaningful_tokens(source_text)):
            problem = "building_name_not_in_source_slice"
    if not problem:
        return item

    replacement = infer_building_from_slice(
        source_text,
        locality=locality,
        bhk=item.get("bhk"),
    )
    item["building_name"] = replacement
    flags = list(item.get("validation_flags") or [])
    flags.append(problem)
    flags.append("building_name_source_repaired" if replacement else "building_name_unresolved")
    item["validation_flags"] = list(dict.fromkeys(flags))
    item["needs_review"] = True

    if isinstance(ai_item, dict):
        ai_item["building_name"] = replacement
        ai_flags = list(ai_item.get("validation_flags") or [])
        ai_item["validation_flags"] = list(dict.fromkeys(ai_flags + flags))
        ai_item["needs_review"] = True
    return item
