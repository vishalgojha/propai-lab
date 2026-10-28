"""Deterministic workspace market scope for typed extraction.

Raw WhatsApp ingestion is intentionally broad. Typed extraction is not: it is
limited to the localities explicitly selected in workspace market preferences.
"""

import re
import unicodedata


_LOCALITY_ALIASES = {
    "bkc": ("bkc", "bandra kurla", "bandra kurla complex"),
}


def _fold(value: object) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).casefold()
    text = re.sub(r"[^\w]+", " ", text, flags=re.UNICODE)
    return " ".join(text.split())


def configured_market_localities(preferences: dict | None) -> list[str]:
    """Return the explicit primary/nearby locality selection.

    An absent or empty selection fails closed: the message remains raw-only.
    """
    if not isinstance(preferences, dict):
        return []
    values = []
    for key in ("primary_localities", "nearby_localities"):
        candidates = preferences.get(key) or []
        if isinstance(candidates, str):
            candidates = [candidates]
        for value in candidates:
            folded = _fold(value)
            if folded and folded not in values:
                values.append(folded)
    return values


def message_matches_market_scope(message: str, localities: list[str]) -> bool:
    """Match selected locality phrases in source text using token boundaries."""
    haystack = _fold(message)
    if not haystack or not localities:
        return False
    for locality in localities:
        candidates = _LOCALITY_ALIASES.get(locality, (locality,))
        if any(re.search(rf"(?<!\w){re.escape(candidate)}(?!\w)", haystack) for candidate in candidates):
            return True
    return False


def market_scope_skip_reason(message: str, preferences: dict | None) -> str | None:
    """Return a stable suppression reason, or ``None`` when extraction is allowed."""
    localities = configured_market_localities(preferences)
    if not localities:
        return "market_scope_unconfigured"
    if not message_matches_market_scope(message, localities):
        return "outside_market_scope"
    return None
