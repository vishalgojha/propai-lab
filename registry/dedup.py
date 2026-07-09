"""
Duplicate detection engine with smart auto-merge rules and clustering.
Checks negative knowledge before suggesting any merge.
"""
import re
import sys
import os
from difflib import SequenceMatcher
from itertools import combinations
from collections import defaultdict

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from knowledge.normalization import is_negative_knowledge


def _normalize(s: str) -> str:
    s = s.lower().strip()
    s = re.sub(r'[^a-z0-9\s]', '', s)
    s = re.sub(r'\s+', ' ', s)
    s = s.replace(' building', '')
    s = s.replace(' tower', '')
    s = s.replace(' apartment', '')
    s = s.replace(' chs', '')
    s = s.replace(' chsl', '')
    return s.strip()


def _quick_filter(a: str, b: str) -> bool:
    """Fast pre-filter: skip pairs unlikely to be similar."""
    na, nb = _normalize(a), _normalize(b)
    if na == nb:
        return True
    # Must share first letter
    if na[:1] != nb[:1]:
        return False
    # Length must not differ by more than 60%
    min_len, max_len = min(len(na), len(nb)), max(len(na), len(nb))
    if min_len / max_len < 0.4:
        return False
    return True


def _name_similarity(a: str, b: str) -> float:
    na, nb = _normalize(a), _normalize(b)
    if na == nb:
        return 100.0
    ratio = SequenceMatcher(None, na, nb).ratio()
    if na in nb or nb in na:
        return max(90.0, ratio * 100)
    return ratio * 100


def _has_common_word(a: str, b: str) -> bool:
    words_a = set(_normalize(a).split())
    words_b = set(_normalize(b).split())
    stopwords = {'the', 'a', 'an', 'and', 'of', 'in', 'at', 'on', 'by', 'to', 'for'}
    words_a -= stopwords
    words_b -= stopwords
    return bool(words_a & words_b)


def _extract_number(name: str) -> str | None:
    m = re.search(r'\d+', name)
    return m.group(0) if m else None


def classify_pattern(name_a: str, name_b: str) -> str:
    """Classify the type of difference between two building names."""
    na = _normalize(name_a)
    nb = _normalize(name_b)
    
    # Space difference (e.g., "Metroview" vs "Metro View")
    if na.replace(' ', '') == nb.replace(' ', ''):
        return "space_variation"
    
    # Typo (single char diff)
    if abs(len(na) - len(nb)) <= 2 and SequenceMatcher(None, na, nb).ratio() >= 0.9:
        return "typo"
    
    # Abbreviation
    if SequenceMatcher(None, na.replace(' ', ''), nb.replace(' ', '')).ratio() >= 0.85:
        return "abbreviation"
    
    # Common prefix (e.g., "Lodha Marquise" vs "Lodha Marquise Tower")
    min_len = min(len(na), len(nb))
    if na[:min_len] == nb[:min_len] or na[-(min_len):] == nb[-(min_len):]:
        return "suffix_variation"
    
    # One contains the other
    if na in nb or nb in na:
        return "partial_overlap"
    
    return "other"


def evaluate_duplicate(
    name_a: str, area_a: str, developer_a: str | None,
    name_b: str, area_b: str, developer_b: str | None,
    lat_a=None, lon_a=None, lat_b=None, lon_b=None,
) -> dict:
    """
    Evidence-based duplicate evaluation.
    
    First checks negative knowledge — if the pair is known to be
    different buildings, returns immediately without suggesting merge.
    
    Returns: {
        "score": 0-100,
        "action": "auto_merge" | "ask" | "new_building" | "negative_knowledge",
        "evidence": [str],
        "pattern": str,
        "rule_triggered": str,
    }
    """
    # ── Negative knowledge check ────────────────────────────────
    if is_negative_knowledge(name_a, name_b, area_a or area_b):
        return {
            "score": 0,
            "action": "negative_knowledge",
            "evidence": ["⛔ Negative knowledge: these are known to be different buildings"],
            "pattern": classify_pattern(name_a, name_b),
            "rule_triggered": "Negative knowledge — never suggest merge",
        }
    
    evidence = []
    score = 0
    rule_triggered = ""
    pattern = classify_pattern(name_a, name_b)
    
    # ── Evidence 1: Name similarity ──────────────────────────────
    name_score = _name_similarity(name_a, name_b)
    if name_score >= 98:
        evidence.append(f"✓ Name similarity {name_score:.0f}%")
        score += 45
    elif name_score >= 90:
        evidence.append(f"✓ High name similarity {name_score:.0f}%")
        score += 35
    elif name_score >= 80:
        evidence.append(f"~ Moderate name similarity {name_score:.0f}%")
        score += 20
    elif name_score >= 50:
        if _has_common_word(name_a, name_b):
            evidence.append(f"? Low name similarity {name_score:.0f}% but shared keywords")
            score += 8
        else:
            evidence.append(f"✗ Weak name similarity {name_score:.0f}%")
            score += 2
    else:
        evidence.append(f"✗ Weak name similarity {name_score:.0f}%")
        score += 0
    
    # ── Evidence 2: Area match ──────────────────────────────────
    same_area = area_a and area_b and area_a.lower() == area_b.lower()
    if same_area:
        evidence.append(f"✓ Same area: {area_a}")
        score += 30
    else:
        evidence.append(f"~ Different areas: {area_a} vs {area_b}")
    
    # ── Evidence 3: Developer match ─────────────────────────────
    if developer_a and developer_b:
        if developer_a == developer_b:
            evidence.append(f"✓ Same developer: {developer_a}")
            score += 18
        else:
            evidence.append(f"✗ Different developers: {developer_a} vs {developer_b}")
            score -= 10
    elif developer_a or developer_b:
        evidence.append("~ Partial developer info")
        score += 3
    
    # ── Evidence 4: Coordinate proximity (if available) ─────────
    if lat_a and lat_b and lon_a and lon_b:
        dist_km = ((lat_a - lat_b)**2 + (lon_a - lon_b)**2)**0.5 * 111
        if dist_km < 0.5:
            evidence.append(f"✓ Same coordinates ({dist_km:.1f}km apart)")
            score += 20
        elif dist_km < 2:
            evidence.append(f"~ Nearby ({dist_km:.1f}km)")
            score += 5
        else:
            evidence.append(f"✗ Far apart ({dist_km:.1f}km)")
            score -= 10
    
    # ── Evidence 5: Building number match ───────────────────────
    num_a = _extract_number(name_a)
    num_b = _extract_number(name_b)
    if num_a and num_b and num_a == num_b and same_area:
        evidence.append(f"✓ Same building number {num_a} in same area")
        score += 15
    
    score = max(0, min(100, score))
    
    # ── Smart auto-merge rules ──────────────────────────────────
    # Rule 1: Near-identical name + same area + same developer
    if name_score >= 98 and same_area and developer_a and developer_a == developer_b:
        rule_triggered = "Rule 1: name>=98% / same area / same developer"
        action = "auto_merge"
    # Rule 2: Name similarity >= 95 + same area + same number
    elif name_score >= 95 and same_area and num_a and num_a == num_b:
        rule_triggered = "Rule 2: name>=95% / same area / same number"
        action = "auto_merge"
    # Rule 3: Name similarity >= 95 + same area + same coordinates
    elif name_score >= 95 and same_area and lat_a and lat_b and ((lat_a - lat_b)**2 + (lon_a - lon_b)**2)**0.5 * 111 < 0.5:
        rule_triggered = "Rule 3: name>=95% / same area / same coords"
        action = "auto_merge"
    # Rule 4: Space variation + same developer + same area
    elif pattern == "space_variation" and same_area and developer_a and developer_a == developer_b:
        rule_triggered = "Rule 4: space variation / same dev / same area"
        action = "auto_merge"
    # Fallback thresholds
    elif score >= 90:
        if same_area:
            action = "auto_merge"
            rule_triggered = f"Score {score} / same area"
        else:
            action = "ask"
            rule_triggered = f"Score {score} / different areas"
    elif score >= 80:
        action = "ask"
        rule_triggered = f"Score {score}"
    else:
        action = "new_building"
        rule_triggered = f"Score {score}"
    
    return {
        "score": score,
        "action": action,
        "evidence": evidence,
        "pattern": pattern,
        "rule_triggered": rule_triggered,
    }


def cluster_review_items(items: list) -> list[dict]:
    """
    Cluster similar review items into batches.
    
    Each batch has:
    - pattern: the type of variation
    - count: number of affected pairs
    - buildings: set of unique building names involved
    - examples: representative examples
    - recommendation: merge or flag
    - confidence: score range
    """
    
    def _get_cluster_key(name_a: str, name_b: str, pattern: str, area_a: str, area_b: str, developer_a, developer_b, score: int, action: str) -> str:
        same_dev = (developer_a and developer_b and developer_a == developer_b)
        same_area = (area_a.lower() == area_b.lower()) if area_a and area_b else False
        
        if pattern == "typo" and same_area:
            return "a_typo_same_area"
        elif pattern == "space_variation":
            return "b_space_variation"
        elif pattern == "abbreviation" and same_area:
            return "c_abbreviation_same_area"
        elif pattern == "suffix_variation" and same_dev and same_area:
            return "d_suffix_same_dev_same_area"
        elif pattern == "suffix_variation" and same_dev:
            return "e_suffix_same_dev_diff_area"
        elif pattern == "suffix_variation" and same_area:
            return "f_suffix_same_area"
        elif same_dev and same_area:
            return "g_same_dev_same_area"
        elif same_dev:
            return "h_same_dev_diff_area"
        elif same_area:
            return "i_same_area_diff_name"
        else:
            return "z_other"
    
    clusters: dict[str, dict] = {}
    cluster_labels = {
        "a_typo_same_area": "Typo variations (same area)",
        "b_space_variation": "Space/join variations",
        "c_abbreviation_same_area": "Abbreviation variations (same area)",
        "d_suffix_same_dev_same_area": "Suffix variations (same developer, same area)",
        "e_suffix_same_dev_diff_area": "Suffix variations (same developer, different area)",
        "f_suffix_same_area": "Suffix variations (same area, different developer)",
        "g_same_dev_same_area": "Same developer + same area + different name",
        "h_same_dev_diff_area": "Same developer + different area",
        "i_same_area_diff_name": "Same area + different name",
        "z_other": "Other patterns",
    }
    
    for item in items:
        key = _get_cluster_key(
            item.get("candidate_a_name", ""),
            item.get("candidate_b_name", ""),
            item.get("pattern", "other"),
            item.get("candidate_a_area", ""),
            item.get("candidate_b_area", ""),
            item.get("developer_a"),
            item.get("developer_b"),
            item.get("confidence_score", 0),
            item.get("recommended_action", "ask"),
        )
        
        if key not in clusters:
            clusters[key] = {
                "pattern": cluster_labels.get(key, key),
                "cluster_key": key,
                "count": 0,
                "buildings": set(),
                "examples": [],
                "scores": [],
                "actions": set(),
                "items": [],
            }
        
        c = clusters[key]
        c["count"] += 1
        c["buildings"].add(item["candidate_a_name"])
        c["buildings"].add(item["candidate_b_name"])
        c["scores"].append(item["confidence_score"])
        c["actions"].add(item.get("recommended_action", "ask"))
        if len(c["examples"]) < 3:
            c["examples"].append((item["candidate_a_name"], item["candidate_b_name"]))
        c["items"].append(item)
    
    # Convert to sorted list
    order = ["a_typo_same_area", "b_space_variation", "c_abbreviation_same_area",
             "d_suffix_same_dev_same_area", "e_suffix_same_dev_diff_area",
             "f_suffix_same_area", "g_same_dev_same_area", "h_same_dev_diff_area",
             "i_same_area_diff_name", "z_other"]
    
    result = []
    for k in order:
        if k in clusters:
            c = clusters[k]
            avg_score = sum(c["scores"]) / len(c["scores"]) if c["scores"] else 0
            result.append({
                "cluster_key": k,
                "pattern": c["pattern"],
                "count": c["count"],
                "unique_buildings": len(c["buildings"]),
                "examples": c["examples"],
                "avg_confidence": round(avg_score, 1),
                "score_range": f"{min(c['scores'])}–{max(c['scores'])}",
                "actions": c["actions"],
                "items": c["items"],
            })
    
    return result
