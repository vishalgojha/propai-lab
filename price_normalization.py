"""Source-grounded price normalization shared by extraction write paths."""

from __future__ import annotations

import re

_UNIT_MULTIPLIERS = {
    "cr": 10_000_000,
    "crore": 10_000_000,
    "crores": 10_000_000,
    "lac": 100_000,
    "lacs": 100_000,
    "lakh": 100_000,
    "lakhs": 100_000,
    "l": 100_000,
    "k": 1_000,
    "thousand": 1_000,
    "thousands": 1_000,
}
_EXPLICIT_PRICE_RE = re.compile(
    r"([\d,]+(?:[.:]\d+)?)\s*[.\-/]*\s*"
    r"(cr|crores?|lac?s?|lakhs?|l|k|thousands?)\b",
    re.IGNORECASE,
)
_RENTAL_LANGUAGE_RE = re.compile(
    r"\b(?:rent|rental|lease|monthly|per\s+month|deposit|tenancy|"
    r"lock[- ]?in|notice\s+period|lease\s+out|for\s+rent|on\s+rent|"
    r"pkg|pckg|packg|package)\b",
    re.IGNORECASE,
)
_SALE_LANGUAGE_RE = re.compile(
    r"\b(?:sale|sell|resale|purchase|outright|outrate|for\s+sale|"
    r"available\s+sale|sale\s+price|asking)\b",
    re.IGNORECASE,
)


def parse_explicit_price(raw_text: str | None) -> tuple[float, str] | None:
    match = _EXPLICIT_PRICE_RE.search(str(raw_text or ""))
    if not match:
        return None
    try:
        amount = float(match.group(1).replace(",", "").replace(":", "."))
    except ValueError:
        return None
    unit = match.group(2).lower().rstrip("s")
    return amount, unit


def price_to_rupees(value: object, unit: object = None) -> float | None:
    if value in (None, ""):
        return None
    try:
        amount = float(value)
    except (TypeError, ValueError):
        return None
    multiplier = _UNIT_MULTIPLIERS.get(str(unit or "").strip().lower(), 1)
    return amount * multiplier


def canonical_price_rupees(value: object, unit: object = None, raw_text: str | None = None) -> float | None:
    explicit = parse_explicit_price(raw_text)
    if explicit:
        amount, explicit_unit = explicit
        return price_to_rupees(amount, explicit_unit)
    return price_to_rupees(value, unit)


def canonical_rental_price_rupees(
    value: object,
    unit: object = None,
    raw_text: str | None = None,
) -> float | None:
    """Normalize Mumbai residential-rent decimal ``k`` shorthand.

    Local brokers sometimes write ``1.30k`` for 1.30 lakh, not 1,300.  This
    rule is intentionally opt-in for rental paths; ordinary ``130k`` remains
    130,000 and sale/commercial paths keep the normal ``k`` meaning.
    """
    text = str(raw_text or "")
    shorthand = re.search(r"(?<![\d.])(\d+\.\d+)\s*k\b", text, re.IGNORECASE)
    if shorthand:
        return float(shorthand.group(1)) * 100_000
    normalized = canonical_price_rupees(value, unit, raw_text)
    if normalized is None:
        return None

    # In Mumbai rental broadcasts, a bare monthly quote such as
    # ``Monthly Rent :- 140`` means ₹1.40 lakh (140 thousand), not ₹140/month. Only apply
    # this residential-rent convention when the source explicitly identifies
    # the number as rent/monthly rent and no money unit was supplied. Explicit
    # k/lakh/crore/PSF values remain governed by the canonical parser above.
    has_explicit_money_unit = parse_explicit_price(text) is not None
    rent_context = re.search(r"\b(?:rent|rental|monthly|lease|on\s+lease)\b", text, re.IGNORECASE)
    unit_key = str(unit or "").strip().lower()
    if (
        not has_explicit_money_unit
        and rent_context
        and unit_key in {"", "total", "abs", "absolute", "inr", "rupees"}
        and 0 < normalized < 1_000
    ):
        return normalized * 1_000
    return normalized


def canonical_commercial_rental_price_rupees(
    value: object,
    unit: object = None,
    raw_text: str | None = None,
) -> float | None:
    """Normalize commercial ``package/pkg`` quotes as ordinary monthly rent.

    ``PKG`` is a broker abbreviation for a monthly rental package in the
    commercial market.  It is not a deposit or a CAM calculation.  When a
    package quote has no explicit lakh unit, small decimal values such as
    ``1.30k`` follow the same Indian broker shorthand as residential rent.
    """
    text = str(raw_text or "")
    if re.search(r"\b(?:pkg|pckg|packg|package)\b", text, re.IGNORECASE):
        shorthand = re.search(r"(?<![\d.])(\d+\.\d+)\s*k\b", text, re.IGNORECASE)
        if shorthand:
            return float(shorthand.group(1)) * 100_000
        explicit = parse_explicit_price(text)
        if explicit:
            amount, explicit_unit = explicit
            return price_to_rupees(amount, explicit_unit)
        try:
            amount = float(value)
        except (TypeError, ValueError):
            return None
        # Package-only quotes are conventionally lakh-scale in this market.
        return amount * 100_000 if abs(amount) < 10_000 else amount
    return canonical_price_rupees(value, unit, raw_text)


def source_transaction_type(raw_text: str | None, proposed: str | None) -> str:
    """Source-ground a provider transaction label without whole-message guessing."""
    text = str(raw_text or "")
    explicit = parse_explicit_price(text)
    has_sale_marker = bool(_SALE_LANGUAGE_RE.search(text))
    has_rent_marker = bool(_RENTAL_LANGUAGE_RE.search(text))
    if has_sale_marker and not has_rent_marker:
        return "sale"
    if has_rent_marker and not has_sale_marker:
        return "rent"
    if explicit and not has_rent_marker:
        return "sale"
    return proposed if proposed in {"sale", "rent"} else "sale"


def rent_price_needs_review(monthly_rent: object, raw_text: str | None) -> bool:
    amount = price_to_rupees(monthly_rent)
    return amount is not None and amount > 5_000_000
