"""
Building Alias Engine

Learns building aliases from broker messages using:
1. Fuzzy similarity (Levenshtein, abbreviations, token overlap)
2. Co-occurrence (same broker, same market, same attributes)
3. Broker consistency (same broker using different names for same building)

Never silently merges. Always shows human-in-the-loop suggestions.
"""

import re
from collections import defaultdict
from difflib import SequenceMatcher
from typing import Optional


# ── Abbreviation mappings ──
ABBREVIATIONS = {
    "bldg": "building",
    "bil": "building",
    "bld": "building",
    "apt": "apartment",
    "apts": "apartments",
    "pkg": "park",
    "pk": "park",
    "hts": "heights",
    "ht": "height",
    "residency": "residency",
    "res": "residency",
    "condo": "condominium",
    "complex": "complex",
    "towers": "towers",
    "tower": "tower",
    "villa": "villa",
    "villas": "villas",
    "nagar": "nagar",
    "colony": "colony",
    "society": "society",
    "chs": "society",
    "coop": "society",
    "estate": "estate",
    "gardens": "gardens",
    "garden": "garden",
    "view": "view",
    "views": "views",
    "point": "point",
    "house": "house",
    "homes": "homes",
    "home": "home",
    "enclave": "enclave",
    "annexe": "annexe",
    "wing": "wing",
    "phase": "phase",
    "block": "block",
}


def normalize_building_name(name: str) -> str:
    """Normalize a building name for comparison."""
    if not name:
        return ""
    
    s = name.lower().strip()
    
    # Remove common suffixes/prefixes
    s = re.sub(r'\b(the|a|an)\b', '', s)
    
    # Expand abbreviations
    tokens = s.split()
    expanded = []
    for t in tokens:
        t_clean = re.sub(r'[^a-z0-9]', '', t)
        if t_clean in ABBREVIATIONS:
            expanded.append(ABBREVIATIONS[t_clean])
        else:
            expanded.append(t_clean)
    
    # Remove empty tokens and rejoin
    expanded = [t for t in expanded if t]
    s = ' '.join(expanded)
    
    # Remove all non-alphanumeric except spaces
    s = re.sub(r'[^a-z0-9\s]', '', s)
    
    # Normalize whitespace
    s = re.sub(r'\s+', ' ', s).strip()
    
    return s


def levenshtein_distance(s1: str, s2: str) -> int:
    """Calculate Levenshtein distance between two strings."""
    if len(s1) < len(s2):
        return levenshtein_distance(s2, s1)
    
    if len(s2) == 0:
        return len(s1)
    
    previous_row = range(len(s2) + 1)
    for i, c1 in enumerate(s1):
        current_row = [i + 1]
        for j, c2 in enumerate(s2):
            insertions = previous_row[j + 1] + 1
            deletions = current_row[j] + 1
            substitutions = previous_row[j] + (c1 != c2)
            current_row.append(min(insertions, deletions, substitutions))
        previous_row = current_row
    
    return previous_row[-1]


def token_similarity(s1: str, s2: str) -> float:
    """Calculate token-based similarity between two strings."""
    tokens1 = set(s1.lower().split())
    tokens2 = set(s2.lower().split())
    
    if not tokens1 or not tokens2:
        return 0.0
    
    intersection = tokens1 & tokens2
    union = tokens1 | tokens2
    
    return len(intersection) / len(union) if union else 0.0


def fuzzy_score(name1: str, name2: str) -> float:
    """
    Calculate fuzzy similarity score between two building names.
    Returns 0.0 to 1.0 (1.0 = perfect match).
    """
    n1 = normalize_building_name(name1)
    n2 = normalize_building_name(name2)
    
    if not n1 or not n2:
        return 0.0
    
    # Exact match after normalization
    if n1 == n2:
        return 1.0
    
    # One is prefix/suffix of the other
    if n1.startswith(n2) or n2.startswith(n1):
        shorter = min(len(n1), len(n2))
        longer = max(len(n1), len(n2))
        if shorter / longer > 0.6:
            return 0.85
    
    # SequenceMatcher ratio
    seq_score = SequenceMatcher(None, n1, n2).ratio()
    
    # Token overlap
    token_score = token_similarity(n1, n2)
    
    # Levenshtein-based score
    lev_dist = levenshtein_distance(n1, n2)
    max_len = max(len(n1), len(n2))
    lev_score = 1.0 - (lev_dist / max_len) if max_len > 0 else 0.0
    
    # Weighted combination
    score = (seq_score * 0.4 + token_score * 0.3 + lev_score * 0.3)
    
    return round(score, 3)


def find_alias_candidates(
    building_names: list[str],
    threshold: float = 0.7
) -> list[dict]:
    """
    Find potential alias pairs from a list of building names.
    Returns list of {name1, name2, score} pairs above threshold.
    """
    candidates = []
    n = len(building_names)
    
    for i in range(n):
        for j in range(i + 1, n):
            score = fuzzy_score(building_names[i], building_names[j])
            if score >= threshold:
                candidates.append({
                    "name1": building_names[i],
                    "name2": building_names[j],
                    "score": score,
                })
    
    # Sort by score descending
    candidates.sort(key=lambda x: x["score"], reverse=True)
    return candidates


def find_aliases_by_broker(
    messages: list[dict],
    threshold: float = 0.6
) -> list[dict]:
    """
    Find alias candidates based on broker consistency.
    
    If the same broker uses different building names with the same
    market/BHK/price pattern, they're likely aliases.
    
    messages: list of {broker_name, building_name, micro_market, bhk, price}
    """
    # Group by broker
    by_broker = defaultdict(list)
    for msg in messages:
        if msg.get("broker_name") and msg.get("building_name"):
            by_broker[msg["broker_name"]].append(msg)
    
    candidates = []
    
    for broker, msgs in by_broker.items():
        # Get unique building names for this broker
        buildings = list(set(m["building_name"] for m in msgs))
        
        if len(buildings) < 2:
            continue
        
        # Find fuzzy matches
        for i in range(len(buildings)):
            for j in range(i + 1, len(buildings)):
                score = fuzzy_score(buildings[i], buildings[j])
                if score >= threshold:
                    # Count co-occurrences
                    msgs_i = [m for m in msgs if m["building_name"] == buildings[i]]
                    msgs_j = [m for m in msgs if m["building_name"] == buildings[j]]
                    
                    # Check market overlap
                    markets_i = set(m.get("micro_market", "") for m in msgs_i if m.get("micro_market"))
                    markets_j = set(m.get("micro_market", "") for m in msgs_j if m.get("micro_market"))
                    market_overlap = len(markets_i & markets_j) > 0 if markets_i and markets_j else False
                    
                    # Check BHK overlap
                    bhk_i = set(m.get("bhk", "") for m in msgs_i if m.get("bhk"))
                    bhk_j = set(m.get("bhk", "") for m in msgs_j if m.get("bhk"))
                    bhk_overlap = len(bhk_i & bhk_j) > 0 if bhk_i and bhk_j else False
                    
                    # Boost score for matching market/BHK
                    adjusted_score = score
                    if market_overlap:
                        adjusted_score = min(1.0, adjusted_score + 0.1)
                    if bhk_overlap:
                        adjusted_score = min(1.0, adjusted_score + 0.05)
                    
                    candidates.append({
                        "name1": buildings[i],
                        "name2": buildings[j],
                        "score": round(adjusted_score, 3),
                        "broker": broker,
                        "market_overlap": market_overlap,
                        "bhk_overlap": bhk_overlap,
                        "count_i": len(msgs_i),
                        "count_j": len(msgs_j),
                    })
    
    # Deduplicate and sort
    seen = set()
    unique = []
    for c in sorted(candidates, key=lambda x: x["score"], reverse=True):
        key = tuple(sorted([c["name1"], c["name2"]]))
        if key not in seen:
            seen.add(key)
            unique.append(c)
    
    return unique


def find_aliases_by_cooccurrence(
    messages: list[dict],
    threshold: float = 0.5
) -> list[dict]:
    """
    Find alias candidates based on co-occurrence patterns.
    
    If two building names appear with the same attributes
    (market, BHK, price range), they're likely aliases.
    """
    # Group by (market, bhk, price_bucket)
    by_context = defaultdict(list)
    for msg in messages:
        if not msg.get("building_name"):
            continue
        
        market = msg.get("micro_market", "")
        bhk = msg.get("bhk", "")
        price = msg.get("price", 0)
        
        # Bucket price into ranges
        if price and price > 0:
            if price < 1000000:
                price_bucket = "under_10L"
            elif price < 5000000:
                price_bucket = "10L_50L"
            elif price < 10000000:
                price_bucket = "50L_1Cr"
            elif price < 50000000:
                price_bucket = "1Cr_5Cr"
            else:
                price_bucket = "5Cr_plus"
        else:
            price_bucket = "unknown"
        
        context = (market, bhk, price_bucket)
        by_context[context].append(msg["building_name"])
    
    candidates = []
    
    for context, building_list in by_context.items():
        if len(building_list) < 2:
            continue
        
        # Count occurrences of each building
        building_counts = defaultdict(int)
        for b in building_list:
            building_counts[b] += 1
        
        unique_buildings = list(building_counts.keys())
        
        for i in range(len(unique_buildings)):
            for j in range(i + 1, len(unique_buildings)):
                b1, b2 = unique_buildings[i], unique_buildings[j]
                score = fuzzy_score(b1, b2)
                
                if score >= threshold:
                    # Weight by co-occurrence count
                    total = building_counts[b1] + building_counts[b2]
                    cooccurrence_boost = min(1.0, total / 20)  # Max boost at 20+ occurrences
                    adjusted_score = min(1.0, score + cooccurrence_boost * 0.2)
                    
                    candidates.append({
                        "name1": b1,
                        "name2": b2,
                        "score": round(adjusted_score, 3),
                        "context": f"{context[0]} | {context[1]} | {context[2]}",
                        "count_i": building_counts[b1],
                        "count_j": building_counts[b2],
                    })
    
    # Deduplicate
    seen = set()
    unique = []
    for c in sorted(candidates, key=lambda x: x["score"], reverse=True):
        key = tuple(sorted([c["name1"], c["name2"]]))
        if key not in seen:
            seen.add(key)
            unique.append(c)
    
    return unique


def generate_merge_suggestions(
    alias_candidates: list[dict],
    min_confidence: float = 0.7
) -> list[dict]:
    """
    Generate human-in-the-loop merge suggestions from alias candidates.
    """
    suggestions = []
    
    for candidate in alias_candidates:
        if candidate["score"] < min_confidence:
            continue
        
        # Build reason string
        reasons = []
        if candidate.get("broker"):
            reasons.append(f"Same broker: {candidate['broker']}")
        if candidate.get("market_overlap"):
            reasons.append("Same market")
        if candidate.get("bhk_overlap"):
            reasons.append("Same BHK configuration")
        if candidate.get("count_i") and candidate.get("count_j"):
            total = candidate["count_i"] + candidate["count_j"]
            reasons.append(f"Seen {total} times combined")
        
        # Choose canonical (prefer shorter, more common name)
        name1, name2 = candidate["name1"], candidate["name2"]
        canonical = name1 if len(name1) <= len(name2) else name2
        alias = name2 if canonical == name1 else name1
        
        suggestions.append({
            "canonical": canonical,
            "alias": alias,
            "confidence": candidate["score"],
            "reasons": reasons if reasons else ["Fuzzy name similarity"],
            "source": "auto_discovered",
        })
    
    return suggestions
