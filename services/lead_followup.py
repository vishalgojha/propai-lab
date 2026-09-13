"""Approval-first lead triage and grounded follow-up drafts."""
from __future__ import annotations

from typing import Any


def _text(value: Any) -> str:
    return str(value or "").strip()


def priority_for_lead(lead: dict[str, Any], matches: list[dict[str, Any]]) -> str:
    """Return a reproducible queue priority, never a market-quality claim."""
    status = _text(lead.get("status")).lower()
    if status in {"contacted", "closed", "snoozed", "duplicate", "failed"}:
        return "done"
    best = max((float(item.get("match_score") or 0) for item in matches), default=0)
    if best >= 80:
        return "high"
    if best >= 65:
        return "normal"
    return "review"


def build_followup_draft(lead: dict[str, Any], listing: dict[str, Any] | None) -> str:
    """Build a draft only from persisted lead and listing facts."""
    name = _text(lead.get("contact_name")) or "there"
    parsed = lead.get("parsed_requirement") or {}
    if not isinstance(parsed, dict):
        parsed = {}
    title = _text(listing.get("title") if listing else "")
    if not title and listing:
        pieces = [_text(listing.get("bhk")), _text(listing.get("building_name")), _text(listing.get("micro_market"))]
        title = " · ".join(piece for piece in pieces if piece)
    if not title:
        title = _text(lead.get("property_reference")) or "a property matching your enquiry"
    details = []
    if parsed.get("transaction_type"):
        details.append(_text(parsed["transaction_type"]).lower())
    if parsed.get("micro_market"):
        details.append(_text(parsed["micro_market"]))
    context = f" ({', '.join(details)})" if details else ""
    return (
        f"Hi {name}, thanks for your enquiry. I found a potential match: {title}{context}. "
        "Would you like me to share the details and arrange a viewing?"
    )
