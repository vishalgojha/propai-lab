"""Small, deterministic plausibility checks for extracted prices.

These helpers validate values produced by extraction.  They deliberately do
not try to classify a message as price-bearing from keywords; the source text
is only used to check whether an already-extracted number is traceable.
"""
from __future__ import annotations

import math
import re
from typing import Any


_NUMBER_RE = re.compile(
    r"(?<![\w])(?P<number>\d[\d,]*(?:\.\d+)?)(?:\s*(?P<unit>crores?|cr|lakhs?|lacs?|lakh|lac|l|thousands?|thousand|k|m|million))?\b",
    re.IGNORECASE,
)
_UNIT_MULTIPLIERS = {
    "cr": 10_000_000,
    "crore": 10_000_000,
    "lac": 100_000,
    "lakh": 100_000,
    "l": 100_000,
    "k": 1_000,
    "thousand": 1_000,
    "m": 1_000_000,
    "million": 1_000_000,
}


def _number(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def price_total_from_psf(
    price: Any,
    price_per_sqft: Any,
    area_sqft: Any,
    *,
    tolerance: float = 0.50,
) -> tuple[float | None, bool]:
    """Return the derived total and whether the supplied total is implausible.

    A 50% tolerance allows for area-basis differences, rounding, and broker
    shorthand while still catching decimal/zero mistakes such as a 10x or 100x
    PSF conversion.  The matcher uses the same rule as extraction.
    """
    total = _number(price)
    rate = _number(price_per_sqft)
    area = _number(area_sqft)
    if rate is None or area is None or rate <= 0 or area <= 0:
        return total, False
    derived = rate * area
    if total is None or total <= 0:
        return derived, False
    return derived, abs(total - derived) / max(abs(total), abs(derived), 1.0) > tolerance


def _source_numbers(source_text: Any) -> list[float]:
    values: list[float] = []
    for match in _NUMBER_RE.finditer(str(source_text or "")):
        try:
            amount = float(match.group("number").replace(",", ""))
        except (TypeError, ValueError):
            continue
        unit = (match.group("unit") or "").casefold().rstrip("s")
        values.append(amount * _UNIT_MULTIPLIERS.get(unit, 1))
    return values


def numeric_value_is_grounded(value: Any, source_text: Any, *, tolerance: float = 0.01) -> bool:
    """Check whether a numeric extraction is represented in the source.

    Commas, decimal formatting, and Indian shorthand units such as ``1.5L``
    are normalized.  No price keyword or keyword adjacency is required.
    """
    candidate = _number(value)
    if candidate is None or candidate <= 0:
        return True
    for observed in _source_numbers(source_text):
        if observed <= 0:
            continue
        if abs(candidate - observed) <= max(1.0, abs(candidate) * tolerance):
            return True
    return False


def extracted_price_values(item: dict[str, Any]) -> list[float]:
    """Collect absolute/rate price values from either AI or typed-shaped data."""
    values: list[float] = []
    price = item.get("price")
    if isinstance(price, dict):
        amount = _number(price.get("amount"))
        if amount is not None and amount > 0:
            unit = str(price.get("unit") or "").casefold().rstrip("s")
            # AI payloads commonly keep the broker's shorthand unit (e.g.
            # ``5 cr``) while the source-grounding scan uses rupees. Compare
            # like with like without changing the payload itself.
            values.append(amount * _UNIT_MULTIPLIERS.get(unit, 1))
    for key in (
        "monthly_rent", "total_asking_price", "computed_total_asking_price",
        "price_per_sqft", "rent_per_sqft",
    ):
        amount = _number(item.get(key))
        if amount is not None and amount > 0:
            values.append(amount)
    return list(dict.fromkeys(values))


def apply_price_plausibility_guard(item: dict[str, Any], source_text: Any) -> dict[str, Any]:
    """Flag implausible or ungrounded extracted prices without deleting them."""
    checked = dict(item or {})
    flags = list(checked.get("validation_flags") or [])
    price = checked.get("price") if isinstance(checked.get("price"), dict) else {}
    price_amount = price.get("amount")
    rate = checked.get("price_per_sqft") or checked.get("rent_per_sqft")
    math_info = checked.get("price_math") if isinstance(checked.get("price_math"), dict) else {}
    rate = rate or math_info.get("rate") or math_info.get("price_per_sqft")
    area = checked.get("carpet_area_sqft") or checked.get("area_sqft")
    area = area or math_info.get("area") or math_info.get("area_sqft")
    total = (
        checked.get("total_asking_price")
        or checked.get("monthly_rent")
        or checked.get("computed_total_asking_price")
    )
    unit = str(price.get("unit") or "").casefold()
    if total is None and unit not in {"per_sqft", "psf"}:
        total = price_amount
    if rate is None and unit in {"per_sqft", "psf"}:
        rate = price_amount
    _, arithmetic_failure = price_total_from_psf(total, rate, area)
    if arithmetic_failure:
        flags.append("price_psf_math_implausible")

    values = extracted_price_values(checked)
    # A total calculated from a grounded rate and area does not need to be
    # printed verbatim in the broker message.  The arithmetic check above is
    # the grounding evidence for that derived value.
    if total is not None and rate is not None and area is not None and not arithmetic_failure:
        total_number = _number(total)
        if total_number is not None:
            values = [
                value for value in values
                if abs(value - total_number) > max(1.0, abs(total_number) * 0.01)
            ]
    grounding_failure = bool(values) and not all(
        numeric_value_is_grounded(value, source_text) for value in values
    )
    if grounding_failure:
        flags.append("price_value_not_traceable_to_source")
    if arithmetic_failure or grounding_failure:
        checked["needs_review"] = True
        score = _number(checked.get("extraction_confidence_score"))
        if score is not None:
            checked["extraction_confidence_score"] = min(score, 0.4)
        if str(checked.get("extraction_confidence") or "").casefold() == "high":
            checked["extraction_confidence"] = "low"
    checked["validation_flags"] = list(dict.fromkeys(flags))
    return checked
