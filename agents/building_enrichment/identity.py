"""Evidence-ranked building identity candidates.

This module deliberately proposes context groups; it never merges buildings.
The enrichment provider can use the strongest few observations to validate a
spelling while the identity resolver keeps ambiguous projects separate.
"""

from __future__ import annotations

from difflib import SequenceMatcher

from agents.building_alias_engine import normalize_building_name


def _tokens(value: str) -> set[str]:
    return {token for token in normalize_building_name(value).split() if len(token) >= 3}


def _overlap(left: str, right: str) -> float:
    a, b = _tokens(left), _tokens(right)
    return len(a & b) / len(a | b) if a and b else 0.0


def rank_identity_candidates(
    observed_name: str,
    observed_locality: str | None,
    candidates: list[dict],
    *,
    max_evidence: int = 5,
) -> list[dict]:
    """Rank bounded candidate buildings using name plus source context.

    ``max_evidence`` is a budget, not a minimum evidence rule.  A candidate
    may be useful with one decisive address/locality match; competing locality
    facts reduce confidence and are surfaced for review.
    """
    observed = normalize_building_name(observed_name)
    locality = normalize_building_name(observed_locality or "")
    ranked: list[dict] = []
    for candidate in candidates:
        if not candidate.get("id") or int(candidate["id"]) == int(candidate.get("observed_id") or -1):
            continue
        name = str(candidate.get("canonical_name") or "")
        if not name:
            continue
        name_score = SequenceMatcher(None, observed, normalize_building_name(name)).ratio()
        candidate_locality = normalize_building_name(candidate.get("micro_market") or "")
        locality_match = bool(locality and candidate_locality and locality == candidate_locality)
        address_overlap = _overlap(str(candidate.get("address") or ""), str(candidate.get("source_address") or ""))
        source_names = list(dict.fromkeys(str(item).strip() for item in (candidate.get("candidate_names") or []) if str(item).strip()))
        name_context = max((_overlap(observed_name, item) for item in source_names), default=0.0)
        score = name_score * 0.55 + (0.2 if locality_match else 0.0) + address_overlap * 0.15 + name_context * 0.1
        evidence = [
            {"kind": "name_similarity", "value": round(name_score, 3)},
            *candidate.get("evidence", []),
        ]
        if locality_match:
            evidence.append({"kind": "same_locality", "value": candidate.get("micro_market")})
        if address_overlap:
            evidence.append({"kind": "address_overlap", "value": round(address_overlap, 3)})
        ranked.append({
            "building_id": int(candidate["id"]),
            "canonical_name": name,
            "micro_market": candidate.get("micro_market"),
            "score": round(min(score, 1.0), 3),
            "evidence": evidence[:max(1, int(max_evidence))],
        })
    return sorted(ranked, key=lambda item: (-item["score"], item["building_id"]))
