"""
Local Intelligence Lab — Webhook Receiver + Pipeline + Admin API.

Flow:
  Evolution API webhook → save raw → parse → resolve → store → evaluate
"""
import json
import os
import sys
import asyncio
import uuid
import re
import base64
import ast
import subprocess
from fnmatch import fnmatch
import httpx
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional
from contextlib import asynccontextmanager
from dataclasses import asdict

from fastapi import FastAPI, Request, HTTPException, Body
from fastapi.responses import Response, StreamingResponse
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from lab.storage import SqliteStorage, RawMessage, ParsedObservation, ResolverDecision, Evaluation
from lab.embedding import create_engine, observation_text, pack_embedding, EmbeddingEngine
from lab import ai_chat_engine as chat_engine
from lab import multi_listing
from lab.location import parse_location
from lab.events import get_bus

# ── Bootstrap path to reuse evidence engine ─────────────────────
PROJECT_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_DIR))

from lab.config import DB_PATH, WEBHOOK_SECRET, HOST, PORT, EVOLUTION_INSTANCE, EVOLUTION_API_URL, DOUBLEWORD_API_KEY, load_group_allowlist, save_group_allowlist, PROPAI_WEBHOOK_URL
from evidence.resolver import resolve, resolve_by_landmark, resolve_by_street
from evidence.parsers import parse as broker_parse

# ── Global storage (lazy-initialized, wired in lifespan) ────────
storage: SqliteStorage | None = None

# ── Global embedding engine ─────────────────────────────────────
_embedder: EmbeddingEngine | None = None

def get_embedder() -> EmbeddingEngine:
    global _embedder
    if _embedder is None:
        _embedder = create_engine(prefer_fastembed=False)
    return _embedder

def compute_embedding(parsed: dict) -> bytes | None:
    text = observation_text(parsed)
    if text:
        eng = get_embedder()
        eng.partial_fit([text])
        emb = eng.embed(text)
        return pack_embedding(emb)
    return None

# ── Global scheduler (lazy-initialized, wired in lifespan) ────────
_scheduler = None
BUSINESS_TIMEZONE = "Asia/Kolkata"
BUSINESS_START_HOUR = 10
BUSINESS_END_HOUR = 19

GROUP_MARKET_KEYWORDS = {
    "Bandra": ["bandra", "bkc", "bks"],
    "Khar": ["khar"],
    "Santacruz": ["santacruz", "scruz", "s cruz"],
    "Juhu": ["juhu"],
    "Andheri": ["andheri"],
    "Worli": ["worli"],
    "Colaba": ["colaba"],
    "Chembur": ["chembur"],
    "Wadala": ["wadala"],
    "Malad": ["malad"],
    "Goregaon": ["goregaon"],
    "Thane": ["thane"],
    "SOBO": ["sobo", "south mumbai"],
}

GROUP_SEGMENT_KEYWORDS = {
    "Commercial": ["commercial", "office", "retail", "shop", "showroom"],
    "Rental": ["rent", "rental", "lease"],
    "Requirement": ["requirement", "requirements", "req"],
    "Inventory": ["inventory", "availability", "availabilty", "listing", "listings"],
    "Broadcast": ["broadcast", "brodcast"],
    "Auction": ["auction", "distress"],
}


def parse_group_name(name: str) -> dict:
    lower = (name or "").lower()
    markets = [
        market
        for market, words in GROUP_MARKET_KEYWORDS.items()
        if any(word in lower for word in words)
    ]
    segments = [
        segment
        for segment, words in GROUP_SEGMENT_KEYWORDS.items()
        if any(word in lower for word in words)
    ]
    return {
        "markets": markets,
        "segments": segments,
        "is_real_estate": bool(markets or segments or any(word in lower for word in ["realty", "realtor", "property", "properties", "estate", "broker"])),
    }


def business_window_status() -> dict:
    from zoneinfo import ZoneInfo
    now = datetime.now(ZoneInfo(BUSINESS_TIMEZONE))
    start = now.replace(hour=BUSINESS_START_HOUR, minute=0, second=0, microsecond=0)
    end = now.replace(hour=BUSINESS_END_HOUR, minute=0, second=0, microsecond=0)
    return {
        "mode": "live_webhook_only",
        "timezone": BUSINESS_TIMEZONE,
        "start": "10:00",
        "end": "19:00",
        "active": start <= now < end,
        "now": now.isoformat(),
        "label": "10 AM - 7 PM IST",
    }

def get_scheduler():
    global _scheduler
    if _scheduler is None:
        from lab.scheduler import SyncScheduler
        _scheduler = SyncScheduler()
    return _scheduler
    return _sync_worker


# ═══════════════════════════════════════════════════════════════
# Parser — wraps existing evidence engine
# ═══════════════════════════════════════════════════════════════

_RE = __import__("re")


def _extract_broker_from_signature(text: str) -> tuple[str | None, str | None]:
    """Extract broker name + phone from signature block (end of message)."""
    lines = [l.strip() for l in text.strip().split("\n") if l.strip()]
    if len(lines) < 2:
        return None, None
    bad_name_terms = (
        "location", "inspection", "carpet", "config", "configuration", "building",
        "available", "rent", "rental", "sale", "sell", "lease", "price", "budget",
        "deposit", "possession", "notice", "parking", "furnished", "unfurnished",
        "semi", "call", "contact", "whatsapp", "site visit", "client", "requirement",
        "direct inventory", "mandate", "note", "landmark", "road", "sqft", "floor",
    )

    def valid_signature_name(line: str) -> bool:
        cleaned = re.sub(r'[*_`~]', '', line).strip(" -:")
        if len(cleaned) < 3 or len(cleaned) > 45:
            return False
        low = cleaned.lower()
        if any(term in low for term in bad_name_terms):
            return False
        if re.search(r'\d{3,}|@|http|\.com|www|₹|\b(?:bhk|rk|cr|lac|lakh|sqft|sft)\b', low):
            return False
        if cleaned.count(",") or cleaned.count(":"):
            return False
        return bool(_RE.match(r'^[A-Z][A-Za-z .&-]{2,}$', cleaned))

    # Scan from bottom for signature patterns
    name = None
    phone = None
    for i in range(len(lines) - 1, -1, -1):
        line = lines[i]
        # Phone line
        phone_match = _RE.search(r'(\d{10})', line)
        if phone_match and not phone:
            phone = phone_match.group(1)
            continue
        # Name line — starts with uppercase word, not a phone/email/URL
        if not name and valid_signature_name(line):
            # Skip if it looks like a company name (ends with realty, prop, estate, etc.)
            if not any(kw in line.lower() for kw in ["realty", "property", "estate", "realtors", "consultancy", "enterprises", "ventures"]):
                name = re.sub(r'[*_`~]', '', line).strip(" -:")
    return name, phone


def _compute_parser_confidence(parsed: dict) -> float:
    """Score extraction confidence from independent, parseable signals."""
    weights = {
        "intent": 0.15,
        "principal": 0.08,
        "bhk": 0.14,
        "price": 0.16,
        "location_raw": 0.16,
        "micro_market": 0.10,
        "building_name": 0.08,
        "landmark_name": 0.08,
        "broker_name": 0.08,
        "broker_phone": 0.07,
        "furnishing": 0.05,
        "area_sqft": 0.05,
    }
    score = 0.0
    for field, weight in weights.items():
        value = parsed.get(field)
        if value and value != "Unknown":
            score += weight
    return round(min(score, 1.0), 2)


def _infer_micro_market(text: str | None) -> str | None:
    """Infer a practical micro-market from common short locality mentions."""
    if not text:
        return None
    value = text.lower()
    mappings = [
        (r'\bbkc\b|\bbandra\s+kurla\b', "Bandra BKC"),
        (r'\blilavati\b|\bbandra\b', "Bandra West"),
        (r'\bandheri\s+west\b|\bandheri\b', "Andheri West"),
        (r'\bmalad\b', "Malad West"),
        (r'\bgoregaon\b', "Goregaon"),
        (r'\bsantacruz\b|\bsanta\s+cruz\b', "Santacruz"),
        (r'\bkhar\b', "Khar"),
        (r'\bjuhu\b', "Juhu"),
        (r'\bpowai\b', "Powai"),
        (r'\bworli\b', "Worli"),
    ]
    for pattern, market in mappings:
        if _RE.search(pattern, value):
            return market
    return None


def parse_message(raw_text: str, profile_name: str | None = None) -> dict:
    """
    Parse a WhatsApp message into structured fields.
    Broker-first extraction with intent/principal separation.
    """
    text = raw_text.strip()
    lower = text.lower()
    result = {
        "intent": None,
        "principal": None,
        "bhk": None,
        "price": None,
        "price_unit": None,
        "area_sqft": None,
        "furnishing": None,
        "location_raw": None,
        "building_name": None,
        "landmark_name": None,
        "street_name": None,
        "area": None,
        "micro_market": None,
        "developer": None,
        "broker_name": None,
        "broker_phone": None,
        "forwarded": 0,
        "confidence": 0.0,
        "raw_payload": {},
    }

    # ── 1. Principal (who is behind the message) ──────────────────
    if _RE.search(r'\b(owner\s*(sale|direct|selling)?|direct\s*owner|owner\s*property)\b', lower):
        result["principal"] = "Owner"
    elif _RE.search(r'\b(client\s*(requirement|need|looking|want)|buyer\s*(requirement|need)|requirement)\b', lower):
        result["principal"] = "Buyer Client"
    else:
        result["principal"] = "Unknown"

    # ── 2. Intent (market action) ────────────────────────────────
    is_need = bool(_RE.search(r'\b(wanted|require|need|looking for|seeking|want to|in need of)\b', lower))
    is_pre_launch = bool(_RE.search(r'\b(pre.?launch|pre.?launching|upcoming project|new launch)\b', lower))
    is_rent = bool(_RE.search(r'\b(rent|rental|on rent|for rent|lease|on lease|for lease|tenant)\b', lower))
    is_commercial = bool(_RE.search(r'\b(commercial|office|shop|showroom|warehouse|godown|retail)\b', lower))
    is_sell = bool(_RE.search(r'\b(sale|sell|selling|available|ready to move|resale|for sale)\b', lower))
    is_buy = bool(_RE.search(r'\b(buy|buyer|purchase|wanted|require|need|looking for|seeking|requirement)\b', lower))

    if is_pre_launch:
        result["intent"] = "PRE-LAUNCH"
    elif is_commercial and is_rent:
        result["intent"] = "COMMERCIAL"
    elif is_commercial:
        result["intent"] = "COMMERCIAL"
    elif is_rent and is_need:
        result["intent"] = "RENT"
    elif is_rent:
        result["intent"] = "RENT"
    elif is_sell:
        result["intent"] = "SELL"
    elif is_buy:
        result["intent"] = "BUY"
    else:
        result["intent"] = "SELL"

    # ── 3. Broker identity (highest confidence: profile_name > signature) ──
    clean_profile_name = _clean_person_name(profile_name or "")
    if clean_profile_name and clean_profile_name.lower() not in ("unknown", ""):
        result["broker_name"] = clean_profile_name
    sig_name, sig_phone = _extract_broker_from_signature(text)
    if sig_name:
        # Signature is authoritative if no profile_name
        if not result.get("broker_name"):
            result["broker_name"] = sig_name
    # Phone from signature
    result["broker_phone"] = sig_phone
    # Phone fallback from body
    if not result["broker_phone"]:
        phone_match = _RE.search(r'(\d{10})', text)
        if phone_match:
            result["broker_phone"] = phone_match.group(1)

    # ── 4. Forwarded ─────────────────────────────────────────────
    if _RE.search(r'\b(forwarded|fw[d]?[:.]?|from:|shared by|sent by)\b', lower):
        result["forwarded"] = 1

    # ── 5. Extract BHK ──────────────────────────────────────────
    bhk_match = _RE.search(r'(\d+)\s*(bhk|rk|bedroom|b ed|b e d)', lower)
    if bhk_match:
        result["bhk"] = bhk_match.group(1) + " BHK"
    elif _RE.search(r'\b(studio)\b', lower):
        result["bhk"] = "Studio"
    elif _RE.search(r'\b(1\s*\.\s*5)\s*bhk', lower):
        result["bhk"] = "1.5 BHK"

    # ── 6. Extract price — two-pass: with unit first, then absolute ──
    price_match = _RE.search(
        r'(?:rs\.?\s*|inr\s*|₹)?\s*([\d,]+(?:\.\d+)?)\s*(cr|crore|lac|lakh|l|k|thousand)\b',
        lower,
    )
    if price_match and price_match.group(1).strip():
        amount = float(price_match.group(1).replace(",", ""))
        unit_raw = price_match.group(2).lower()
        if unit_raw in ("cr", "crore"):
            result["price"] = amount * 10000000
            result["price_unit"] = "Cr"
        elif unit_raw in ("lac", "lakh", "l"):
            result["price"] = amount * 100000
            result["price_unit"] = "Lac"
        elif unit_raw in ("k", "thousand"):
            result["price"] = amount * 1000
            result["price_unit"] = "K"
    else:
        abs_match = _RE.search(
            r'(?:rs\.?\s*|inr\s*|₹)\s*([\d,]+(?:\.\d+)?)',
            lower,
        )
        if abs_match and abs_match.group(1).strip():
            amount = float(abs_match.group(1).replace(",", ""))
            result["price"] = amount
            result["price_unit"] = "abs"

    # ── 7. Extract area sqft ────────────────────────────────────
    area_match = _RE.search(r'(\d+[\d,]*)\s*(sq\.?\s*ft|sqft|sft|sq\s*feet)', lower)
    if area_match and area_match.group(1).strip():
        result["area_sqft"] = float(area_match.group(1).replace(",", ""))

    # ── 8. Furnishing ───────────────────────────────────────────
    if any(x in lower for x in ["fully furnished", "fully fur", "ff"]):
        result["furnishing"] = "Fully Furnished"
    elif any(x in lower for x in ["semi furnished", "semi fur", "sf"]):
        result["furnishing"] = "Semi Furnished"
    elif any(x in lower for x in ["unfurnished", "un furn", "uf", "un-furnished"]):
        result["furnishing"] = "Unfurnished"

    # ── 9. Location — structured parsing via location engine ────
    loc = parse_location(text)
    result["location_raw"] = loc.raw
    result["location"] = loc.to_dict()
    if loc.raw and len(loc.raw) >= 3:
        if loc.landmark:
            result["landmark_name"] = loc.landmark
        elif loc.micro_market:
            result["landmark_name"] = loc.micro_market
        elif loc.building:
            result["landmark_name"] = loc.building
        else:
            result["landmark_name"] = loc.raw
        if loc.building:
            result["building_name"] = loc.building
        if loc.micro_market:
            result["micro_market"] = loc.micro_market
        else:
            result["micro_market"] = _infer_micro_market(loc.raw)
        if loc.street:
            result["street_name"] = loc.street

    # ── 10. Developer mention ───────────────────────────────────
    dev_keywords = ["by ", "developer ", "builder ", "promoted by "]
    for kw in dev_keywords:
        idx = lower.find(kw)
        if idx >= 0:
            after = text[idx + len(kw):].strip()
            dev_end = after.find("\n")
            if dev_end > 0:
                after = after[:dev_end]
            result["developer"] = after
            break

    result["confidence"] = _compute_parser_confidence(result)
    result["raw_payload"]["full_text"] = text
    return result


# ═══════════════════════════════════════════════════════════════
# Resolver — returns all candidates with evidence per stage
# ═══════════════════════════════════════════════════════════════

def resolve_parsed(parsed: dict, raw_text: str) -> dict:
    """
    Run multi-path resolver. Returns all candidates with evidence,
    per-stage confidence, and failure categorization.

    Returns:
    {
        "building_id": int | None,      # winner
        "building_name": str | None,
        "parser_confidence": float,      # how confident the parser was
        "resolver_confidence": float,    # how confident the resolver is in the winner
        "final_confidence": float,       # combined score
        "method": "resolved" | "unresolved" | "error",
        "method_detail": str,
        "candidates": [                  # all candidates with evidence
            {
                "building_id": int,
                "building_name": str,
                "confidence": float,
                "reasons": [str],        # why this candidate matches
                "method": str,
                "landmark_id": str | None,
                "landmark_name": str | None,
                "distance_m": int | None,
                "micro_market": str | None,
            },
        ],
        "failure_category": str | None,  # for unresolved: "parser_failure" | "unknown_landmark" | "no_nearby_buildings" | "multiple_candidates" | "malformed"
        "error": str | None,
    }
    """
    # Start with base result
    result = {
        "building_id": None,
        "building_name": None,
        "landmark_id": None,
        "landmark_name": None,
        "street_id": None,
        "street_name": None,
        "project_id": None,
        "project_name": None,
        "developer_name": parsed.get("developer"),
        "parser_confidence": parsed.get("confidence", 0.0),
        "resolver_confidence": 0.0,
        "final_confidence": 0.0,
        "method": "unresolved",
        "method_detail": None,
        "candidates": [],
        "failure_category": None,
        "error": None,
    }

    name = (
        parsed.get("landmark_name")
        or parsed.get("street_name")
        or parsed.get("building_name")
        or parsed.get("location_raw")
        or raw_text
    )
    area = parsed.get("area") or parsed.get("micro_market") or ""
    developer = parsed.get("developer") or ""

    try:
        # ── Collect candidates from all paths ──────────────
        candidates = []
        seen_bids = set()

        # Path A: Landmark match → nearby buildings
        landmark_name = parsed.get("landmark_name")
        if landmark_name:
            from evidence.resolver import CACHE as R_CACHE
            from evidence.resolver import _load_landmarks
            _load_landmarks()
            lm_names = R_CACHE.get("landmarks_by_name", {})
            lm_aliases = R_CACHE.get("landmarks_by_alias", {})
            lm_to_bldgs = R_CACHE.get("lm_to_bldgs", {})
            landmarks_list = R_CACHE.get("landmarks_list", [])

            lm_lower = landmark_name.lower().strip()
            matched_lm = lm_names.get(lm_lower) or lm_aliases.get(lm_lower)
            if not matched_lm:
                # Fuzzy on landmark name
                from difflib import SequenceMatcher
                best_lm = None
                best_ratio = 0.0
                for lm in landmarks_list:
                    ratio = SequenceMatcher(None, lm_lower, lm["name"].lower()).ratio()
                    if ratio > best_ratio and ratio >= 0.70:
                        best_ratio = ratio
                        best_lm = lm
                if best_lm:
                    matched_lm = best_lm
                    result["method_detail"] = f"lm_fuzzy:{best_lm['landmark_id']}"
                else:
                    result["failure_category"] = "unknown_landmark"
                    result["method_detail"] = f"unknown_landmark:{lm_lower}"

            if matched_lm:
                lid = matched_lm["landmark_id"]
                result["landmark_id"] = lid
                result["landmark_name"] = matched_lm.get("name", landmark_name)
                neighbors = lm_to_bldgs.get(lid, [])
                if neighbors:
                    from evidence.resolver import CACHE as R2_CACHE
                    from evidence.resolver import _load_registry
                    _load_registry()
                    buildings = R2_CACHE.get("buildings", {})

                    for link in sorted(neighbors, key=lambda x: x["distance_m"])[:5]:
                        bid = link["building_id"]
                        if bid in seen_bids:
                            continue
                        seen_bids.add(bid)
                        b_info = None
                        for cname, info in buildings.items():
                            if info["building_id"] == bid:
                                b_info = {"canonical_name": info["canonical_name"], "area": info.get("area", ""), "developer": info.get("developer", "")}
                                break

                        conf = max(0.50, 1.0 - (link["distance_m"] / 2000))
                        reasons = [f"{link['distance_m']}m from {matched_lm['name']}"]
                        if b_info and b_info.get("area"):
                            if area and b_info["area"].lower() == area.lower():
                                reasons.append(f"Same area: {area}")

                        candidates.append({
                            "building_id": bid,
                            "building_name": b_info["canonical_name"] if b_info else f"Building #{bid}",
                            "confidence": round(conf, 2),
                            "reasons": reasons,
                            "method": f"lm:{lid}",
                            "landmark_id": lid,
                            "landmark_name": matched_lm.get("name"),
                            "distance_m": link["distance_m"],
                            "micro_market": b_info.get("area", "") if b_info else None,
                        })
                else:
                    result["failure_category"] = "no_nearby_buildings"
                    if not result["method_detail"]:
                        result["method_detail"] = f"lm_no_buildings:{lid}"

        # Path B: Primary resolver call (winner)
        from evidence.resolver import resolve as core_resolve
        bid, conf, method = core_resolve(name, area, developer)

        # Path C: Street match
        street_name = parsed.get("street_name")
        if street_name and not any(c["building_id"] == bid for c in candidates if bid):
            from evidence.resolver import resolve_by_street
            street_bids = resolve_by_street(street_name)
            if street_bids:
                from evidence.resolver import CACHE as R3_CACHE
                from evidence.resolver import _load_registry
                _load_registry()
                buildings = R3_CACHE.get("buildings", {})
                for sbid in street_bids[:5]:
                    if sbid in seen_bids:
                        continue
                    seen_bids.add(sbid)
                    b_info = None
                    for cname, info in buildings.items():
                        if info["building_id"] == sbid:
                            b_info = {"canonical_name": info["canonical_name"], "area": info.get("area", "")}
                            break
                    candidates.append({
                        "building_id": sbid,
                        "building_name": b_info["canonical_name"] if b_info else f"Building #{sbid}",
                        "confidence": 0.75,
                        "reasons": [f"On street: {street_name}"],
                        "method": f"street:{street_name}",
                        "landmark_id": None,
                        "landmark_name": None,
                        "distance_m": None,
                        "micro_market": b_info.get("area", "") if b_info else None,
                    })

        # Add primary winner if not already in candidates
        if bid and bid not in seen_bids:
            from evidence.resolver import CACHE as R4_CACHE
            from evidence.resolver import _load_registry
            _load_registry()
            buildings = R4_CACHE.get("buildings", {})
            b_name = None
            for cname, info in buildings.items():
                if info["building_id"] == bid:
                    b_name = info["canonical_name"]
                    break
            candidates.append({
                "building_id": bid,
                "building_name": b_name or f"Building #{bid}",
                "confidence": round(conf, 2),
                "reasons": [f"Resolver match: {method}"],
                "method": method,
                "landmark_id": result.get("landmark_id"),
                "landmark_name": result.get("landmark_name"),
                "distance_m": None,
                "micro_market": area or None,
            })
            seen_bids.add(bid)

        # Sort candidates by confidence descending
        candidates.sort(key=lambda x: -x["confidence"])

        # Determine winner
        if candidates:
            # If primary resolver found a match, trust it
            # Otherwise use the highest-confidence candidate
            winner = None
            if bid and bid > 0:
                for c in candidates:
                    if c["building_id"] == bid:
                        winner = c
                        break
            if not winner:
                winner = candidates[0]
                bid = winner["building_id"]
                conf = winner["confidence"]
                method = winner["method"]

            result["building_id"] = winner["building_id"]
            result["building_name"] = winner["building_name"]
            result["resolver_confidence"] = max(c["confidence"] for c in candidates if c["building_id"] == bid) if bid else 0.0
            result["final_confidence"] = round(
                result["parser_confidence"] * 0.3 + result["resolver_confidence"] * 0.7, 2
            )
            result["method"] = "resolved"
            result["method_detail"] = method
        else:
            result["resolver_confidence"] = 0.0
            result["final_confidence"] = round(result["parser_confidence"] * 0.3, 2)
            if not result["failure_category"]:
                result["failure_category"] = "no_candidates"
                result["method_detail"] = "no_candidates_found"

        result["candidates"] = candidates

    except Exception as e:
        result["method"] = "error"
        result["error"] = str(e)
        result["failure_category"] = "resolver_error"

    return result


# ═══════════════════════════════════════════════════════════════
# Evaluation tracker
# ═══════════════════════════════════════════════════════════════

def evaluate_parsed(raw_id: int, parsed: dict, expected: Optional[dict] = None):
    """
    Compare extracted fields against expected values.
    If no expected values are provided, stores extracted fields without scoring.
    """
    ev = Evaluation(raw_message_id=raw_id)

    extract_map = {
        "intent": "extracted_intent",
        "principal": "extracted_principal",
        "bhk": "extracted_bhk",
        "price": "extracted_price",
        "price_unit": "extracted_price_unit",
        "area_sqft": "extracted_area_sqft",
        "furnishing": "extracted_furnishing",
        "building_name": "extracted_building",
        "landmark_name": "extracted_landmark",
        "street_name": "extracted_street",
        "area": "extracted_area",
        "micro_market": "extracted_micro_market",
        "developer": "extracted_developer",
        "broker_name": "extracted_broker",
    }
    for extract_key, field_name in extract_map.items():
        setattr(ev, field_name, parsed.get(extract_key))

    expected_map = {
        "intent": "expected_intent",
        "principal": "expected_principal",
        "bhk": "expected_bhk",
        "price": "expected_price",
        "price_unit": "expected_price_unit",
        "area_sqft": "expected_area_sqft",
        "furnishing": "expected_furnishing",
        "building_name": "expected_building",
        "landmark_name": "expected_landmark",
        "street_name": "expected_street",
        "area": "expected_area",
        "micro_market": "expected_micro_market",
        "developer": "expected_developer",
        "broker_name": "expected_broker",
    }
    for extract_key, field_name in expected_map.items():
        exp_val = (expected or {}).get(extract_key)
        setattr(ev, field_name, exp_val)

    # Compute overall accuracy if expected values exist
    if expected:
        correct = 0
        total = 0
        for extract_key in expected_map:
            exp = expected.get(extract_key)
            ext = parsed.get(extract_key)
            if exp is not None:
                total += 1
                if str(exp).strip().lower() == str(ext).strip().lower():
                    correct += 1
        ev.accuracy_overall = round(correct / max(total, 1), 4) if total > 0 else None
        ev.evaluated_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    return storage.save_evaluation(ev)


# ═══════════════════════════════════════════════════════════════
# FastAPI App
# ═══════════════════════════════════════════════════════════════

@asynccontextmanager
async def lifespan(app: FastAPI):
    global storage
    storage = SqliteStorage(DB_PATH)
    storage.init_schema()
    try:
        if storage.db.execute("SELECT COUNT(*) AS c FROM listings").fetchone()["c"] == 0:
            storage.rebuild_listings()
    except Exception as exc:
        print(f"  Listings rebuild skipped: {exc}")
    # Backfill sender_phone from sender_jid for existing rows
    try:
        storage.db.execute(
            "UPDATE raw_messages SET sender_phone = TRIM(REPLACE(SUBSTR(sender_jid, 1, INSTR(sender_jid, '@') - 1), ' ', '')) "
            "WHERE sender_jid IS NOT NULL AND sender_jid != '' AND (sender_phone IS NULL OR sender_phone = '')"
        )
        storage._commit()
    except Exception:
        pass
    # Rebuild broker graph from existing observations
    try:
        result = storage.rebuild_broker_graph()
        print(f"  Broker graph: {result['brokers']} brokers, {result['observations']} observations")
    except Exception as exc:
        print(f"  Broker graph rebuild skipped: {exc}")
    # Run alias learner on startup
    try:
        from agents.alias_learner import check_for_aliases
        check_for_aliases(storage)
    except Exception as exc:
        print(f"  Alias learner skipped: {exc}")
    # Auto-generate API key if missing
    key_path = Path(__file__).parent / ".api_key"
    if not key_path.exists():
        new_key = str(uuid.uuid4())
        key_path.write_text(new_key)
        print(f"  Generated API key: {new_key}")
    print(f"  Lab DB: {DB_PATH}")
    print(f"  Webhook: http://localhost:{PORT}/webhook")
    print(f"  Admin:   http://localhost:{PORT}/")
    yield

app = FastAPI(title="PropAI Local Intelligence Lab", version="0.1.0", lifespan=lifespan)


# ── Webhook (Evolution API) ─────────────────────────────────────

def _register_webhook():
    """Register this server as a webhook target in Evolution API."""
    import httpx

    webhook_url = PROPAI_WEBHOOK_URL or f"http://host.docker.internal:{PORT}/webhook"

    payload = {
        "enabled": True,
        "url": webhook_url,
        "webhook_by_events": False,
        "webhook_base64": False,
        "events": [
            "QRCODE_UPDATED",
            "MESSAGES_UPSERT",
            "MESSAGES_UPDATE",
            "MESSAGES_DELETE",
            "CONNECTION_UPDATE",
            "GROUPS_UPSERT",
            "GROUPS_UPDATE",
            "GROUPS_PARTICIPANTS_UPDATE",
            "SEND_MESSAGE",
        ],
    }
    resp = httpx.post(
        f"{EVOLUTION_API_URL}/webhook/set/{EVOLUTION_INSTANCE}",
        json=payload,
        headers={"apikey": EVOLUTION_API_KEY},
        timeout=10,
    )
    result = resp.json()
    if result.get("success"):
        print(f"  Webhook registered: {webhook_url}")
    else:
        print(f"  [!] Webhook registration response: {result}")

_EVENT_CLASS = {
    "messages.upsert": "message",
    "MESSAGES_UPSERT": "message",
    "MESSAGES_SET": "message",
    "messages.update": "message",
    "messages.delete": "system",
    "connection.update": "connection",
    "qrupdated": "qr",
    "QR_UPDATED": "qr",
    "groups.upsert": "group",
    "groups.update": "group",
    "groups.participants.update": "group",
    "presence.update": "presence",
    "call": "call",
}

def _classify_webhook_event(event: str, data: dict) -> str:
    """Classify an Evolution API webhook event into a pipeline category."""
    base = _EVENT_CLASS.get(event, "system")
    if base == "message":
        msg_data = data.get("data", data)
        if not isinstance(msg_data, dict):
            return "system"
        msg = msg_data.get("message", {})
        has_text = bool(
            msg.get("conversation")
            or (msg.get("extendedTextMessage") or {}).get("text")
            or msg.get("imageMessage")
            or msg.get("videoMessage")
            or msg.get("audioMessage")
            or msg.get("documentMessage")
        )
        if not has_text and not msg:
            return "system"
        if msg and not msg.get("conversation") and not msg.get("extendedTextMessage"):
            return "media"
    return base


class EvolutionWebhook(BaseModel):
    event: str = "message"
    instance: str = "default"
    data: dict = {}


@app.post("/webhook")
async def webhook(request: Request):
    """Receive webhook from Evolution API. Route by event type before any processing."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON")

    data = body if isinstance(body, dict) else {}
    event = data.get("event", "")
    instance = data.get("instance", "unknown")

    # ── Classify and route event ──────────────────────────────────
    event_class = _classify_webhook_event(event, data)

    if event_class != "message":
        _handle_system_event(event_class, event, data, instance)
        return {"status": "event_handled", "event": event, "class": event_class}

    # ── Human message ─────────────────────────────────────────────
    msg_data = data.get("data", data)
    key = msg_data.get("key", {})
    msg = msg_data.get("message", {})
    msg_text = (
        msg.get("conversation", "")
        or msg.get("extendedTextMessage", {}).get("text", "")
        or msg.get("imageMessage", {}).get("caption", "")
        or msg.get("videoMessage", {}).get("caption", "")
        or ""
    )
    if not msg_text.strip():
        return {"status": "ignored", "reason": "empty_message"}

    baileys_sender = msg_data.get("sender", {}) or {}
    push_name = msg_data.get("pushName", "") or baileys_sender.get("pushName", "") or ""
    sender_name = baileys_sender.get("name", "") or push_name
    sender_jid = key.get("participant", "") or baileys_sender.get("id", "")
    sender_phone = "".join(ch for ch in str(sender_jid).split("@")[0] if ch.isdigit())
    sender = _format_whatsapp_sender(sender_name, sender_jid)
    group = key.get("remoteJid", "") or msg_data.get("from", "")
    group_name = _resolve_group_name(group)
    timestamp = msg_data.get("messageTimestamp", int(datetime.now(timezone.utc).timestamp()))
    if isinstance(timestamp, (int, float)):
        timestamp = datetime.fromtimestamp(timestamp, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    # Dedup key
    message_id = key.get("id", "")
    remote_jid = key.get("remoteJid", group)
    message_uid = f"baileys::{instance}::{remote_jid}::{message_id}" if message_id and remote_jid else None

    # Save raw message
    from lab.scheduler import PIPELINE_VERSION
    raw_id = storage.save_raw_message(RawMessage(
        group_name=group_name,
        sender=sender,
        sender_jid=sender_jid,
        sender_phone=sender_phone,
        message=msg_text,
        message_type="text",
        timestamp=timestamp,
        source="WHATSAPP",
        raw_payload=json.dumps(data),
        message_uid=message_uid,
        pipeline_version=PIPELINE_VERSION,
        synced_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    ))
    get_bus().publish("message.received", {
        "raw_id": raw_id, "group": group, "sender": sender, "message": msg_text[:200],
    })

    # Parse — single or multi-listing
    msg_class = multi_listing.classify_message(msg_text)
    if msg_class == "multi":
        parsed_listings = multi_listing.parse_multi_message(
            msg_text, profile_name=sender_name or push_name
        )
    else:
        single = parse_message(msg_text, profile_name=sender_name or push_name)
        parsed_listings = [single] if single else []

    if not parsed_listings:
        return {"status": "ignored", "reason": "parse_failed"}

    # Fallback broker identity from sender JID when not found in message
    for pl in parsed_listings:
        if not pl.get("broker_name") or not pl.get("broker_phone"):
            if not pl.get("broker_name"):
                if len(sender_phone) >= 10:
                    pl["broker_name"] = f"+91 {sender_phone[-10:]}"
                elif sender_phone:
                    pl["broker_name"] = f"+{sender_phone}"
            if not pl.get("broker_phone"):
                if len(sender_phone) >= 10:
                    pl["broker_phone"] = sender_phone[-10:]

    parsed_ids: list[int] = []
    for idx, parsed in enumerate(parsed_listings):
        embedding_blob = compute_embedding(parsed) if idx == 0 else None
        obs = ParsedObservation(
            raw_message_id=raw_id,
            listing_index=idx,
            message_type=parsed.get("message_type"),
            intent=parsed.get("intent"),
            principal=parsed.get("principal"),
            bhk=parsed.get("bhk"),
            price=parsed.get("price"),
            price_unit=parsed.get("price_unit"),
            area_sqft=parsed.get("area_sqft"),
            furnishing=parsed.get("furnishing"),
            location_raw=parsed.get("location_raw"),
            location=json.dumps(parsed.get("location")) if parsed.get("location") else None,
            building_name=parsed.get("building_name"),
            landmark_name=parsed.get("landmark_name"),
            street_name=parsed.get("street_name"),
            area=parsed.get("area"),
            micro_market=parsed.get("micro_market"),
            developer=parsed.get("developer"),
            broker_name=parsed.get("broker_name"),
            broker_phone=parsed.get("broker_phone"),
            profile_name=sender_name or push_name,
            forwarded=parsed.get("forwarded", 0),
            confidence=parsed.get("confidence", 0.0),
            raw_payload=json.dumps(parsed.get("raw_payload", {})),
            embedding=embedding_blob,
        )
        parsed_id = storage.save_parsed(obs)
        parsed_ids.append(parsed_id)

        # Resolve (run once, reuse for all listings in a multi)
        if idx == 0 or msg_class != "multi":
            resolver_result = resolve_parsed(parsed, msg_text)
        resolver_result["parsed_id"] = parsed_id
        dec = ResolverDecision(
            parsed_id=parsed_id,
            building_id=resolver_result.get("building_id"),
            building_name=resolver_result.get("building_name"),
            landmark_id=resolver_result.get("landmark_id"),
            landmark_name=resolver_result.get("landmark_name"),
            street_id=resolver_result.get("street_id"),
            street_name=resolver_result.get("street_name"),
            project_id=resolver_result.get("project_id"),
            project_name=resolver_result.get("project_name"),
            developer_name=resolver_result.get("developer_name"),
            parser_confidence=resolver_result.get("parser_confidence", 0.0),
            resolver_confidence=resolver_result.get("resolver_confidence", 0.0),
            final_confidence=resolver_result.get("final_confidence", 0.0),
            method=resolver_result.get("method", "unresolved"),
            method_detail=resolver_result.get("method_detail"),
            candidates=json.dumps(resolver_result.get("candidates", [])),
            failure_category=resolver_result.get("failure_category"),
            error=resolver_result.get("error"),
        )
        storage.save_resolver_decision(dec)

    get_bus().publish("extraction.completed", {
        "parsed_ids": parsed_ids, "raw_id": raw_id, "count": len(parsed_ids),
        "intent": parsed_listings[0].get("intent"), "broker": parsed_listings[0].get("broker_name"),
    })
    get_bus().publish("resolution.completed", {
        "parsed_ids": parsed_ids, "raw_id": raw_id,
        "building": resolver_result.get("building_name"),
        "method": resolver_result.get("method", "unresolved"),
        "confidence": resolver_result.get("final_confidence", 0),
    })

    return {"status": "ok", "raw_id": raw_id, "parsed_ids": parsed_ids, "count": len(parsed_ids)}


def _handle_system_event(event_class: str, event: str, data: dict, instance: str):
    """Handle non-message webhook events (connection, QR, system, etc.)."""
    msg_data = data.get("data", data)
    if event_class == "qr":
        qr_code = msg_data if isinstance(msg_data, dict) else {}
        if not isinstance(msg_data, dict):
            try:
                qr_code = json.loads(msg_data) if isinstance(msg_data, str) else {}
            except (json.JSONDecodeError, TypeError):
                qr_code = {}
        get_bus().publish("qr.updated", {
            "instance": instance,
            "qrcode": qr_code.get("qrcode") or msg_data.get("qrcode", ""),
            "pairingCode": qr_code.get("pairingCode") or msg_data.get("pairingCode"),
        })
    elif event_class == "connection":
        state = ""
        if isinstance(msg_data, dict):
            state = msg_data.get("state", "")
        get_bus().publish("connection.changed", {
            "instance": instance,
            "state": state,
        })
    elif event_class == "group":
        groups_list = msg_data if isinstance(msg_data, list) else [msg_data]
        for g in groups_list:
            if not isinstance(g, dict):
                continue
            jid = g.get("id") or g.get("remoteJid") or ""
            if not jid:
                continue
            name = g.get("name") or g.get("subject") or jid
            participants = len(g.get("participants", [])) if isinstance(g.get("participants"), list) else g.get("size", 0)
            try:
                storage.upsert_sync_job(
                    source="whatsapp", instance=instance,
                    group_id=jid, group_name=name,
                    participants=participants,
                )
            except Exception:
                pass
            get_bus().publish("group.updated", {
                "instance": instance,
                "jid": jid,
                "name": name,
                "participants": participants,
            })
    else:
        get_bus().publish("system.event", {
            "event": event,
            "instance": instance,
            "class": event_class,
        })


def _format_whatsapp_sender(name: str = "", jid: str = "") -> str:
    clean_name = (name or "").strip()
    phone = _phone_from_jid(jid)
    if clean_name and phone:
        return f"{clean_name} ({phone})"
    return clean_name or phone or "unknown"


def _resolve_group_name(jid: str) -> str:
    """Resolve a group JID to the human-readable name from sync_jobs."""
    if not jid or not jid.endswith("@g.us"):
        return jid
    try:
        job = storage.get_job_by_group_jid(jid)
        if job and job.group_name and job.group_name != jid:
            return job.group_name
    except Exception:
        pass
    return jid


def _phone_from_jid(jid: str = "") -> str:
    digits = "".join(ch for ch in str(jid).split("@")[0] if ch.isdigit())
    if not digits:
        return ""
    if digits.startswith("91") and len(digits) >= 12:
        return f"+91 {digits[2:4]}{'X' * 6}{digits[10:12]}"
    if len(digits) >= 10:
        country = digits[:-10]
        local = digits[-10:]
        return f"+{country} {local[:2]}{'X' * 6}{local[-2:]}" if country else f"{local[:2]}{'X' * 6}{local[-2:]}"
    return f"+{digits}"


def _clean_person_name(name: str = "") -> str:
    clean = (name or "").strip()
    if re.fullmatch(r"\+?[\dXx\s().-]{7,}", clean):
        return ""
    clean = re.sub(r"\s*\([^)]*(?:\+?\d|X{2,})[^)]*\)\s*", " ", clean, flags=re.I)
    clean = re.sub(r"\s*\+?[\dXx][\dXx\s().-]{7,}\s*", " ", clean)
    clean = re.sub(r"\s{2,}", " ", clean).strip(" -")
    if re.fullmatch(r"\+?[\dXx\s().-]{7,}", clean):
        return ""
    return clean


# ── Manual ingest endpoint (for testing) ────────────────────────

class IngestRequest(BaseModel):
    message: str
    group: str = "test"
    sender: str = "test-user"
    expected: Optional[dict] = None


@app.post("/ingest")
async def ingest(req: IngestRequest):
    """Manually ingest a message for testing."""
    from lab.scheduler import PIPELINE_VERSION
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    raw_id = storage.save_raw_message(RawMessage(
        group_name=req.group,
        sender=req.sender,
        message=req.message,
        message_type="text",
        timestamp=now,
        source="MANUAL",
        raw_payload=json.dumps({"manual": True}),
        pipeline_version=PIPELINE_VERSION,
        synced_at=now,
    ))

    parsed = parse_message(req.message)
    embedding_blob = compute_embedding(parsed)
    obs = ParsedObservation(
        raw_message_id=raw_id,
        intent=parsed.get("intent"),
        principal=parsed.get("principal"),
        bhk=parsed.get("bhk"),
        price=parsed.get("price"),
        price_unit=parsed.get("price_unit"),
        area_sqft=parsed.get("area_sqft"),
        furnishing=parsed.get("furnishing"),
        location_raw=parsed.get("location_raw"),
        location=json.dumps(parsed.get("location")) if parsed.get("location") else None,
        building_name=parsed.get("building_name"),
        landmark_name=parsed.get("landmark_name"),
        street_name=parsed.get("street_name"),
        area=parsed.get("area"),
        micro_market=parsed.get("micro_market"),
        developer=parsed.get("developer"),
        broker_name=parsed.get("broker_name"),
        broker_phone=parsed.get("broker_phone"),
        forwarded=parsed.get("forwarded", 0),
        confidence=parsed.get("confidence", 0.0),
        raw_payload=json.dumps(parsed.get("raw_payload", {})),
        embedding=embedding_blob,
    )
    parsed_id = storage.save_parsed(obs)

    resolver_result = resolve_parsed(parsed, req.message)
    dec = ResolverDecision(
        parsed_id=parsed_id,
        building_id=resolver_result.get("building_id"),
        building_name=resolver_result.get("building_name"),
        landmark_id=resolver_result.get("landmark_id"),
        landmark_name=resolver_result.get("landmark_name"),
        street_id=resolver_result.get("street_id"),
        street_name=resolver_result.get("street_name"),
        project_id=resolver_result.get("project_id"),
        project_name=resolver_result.get("project_name"),
        developer_name=resolver_result.get("developer_name"),
        parser_confidence=resolver_result.get("parser_confidence", 0.0),
        resolver_confidence=resolver_result.get("resolver_confidence", 0.0),
        final_confidence=resolver_result.get("final_confidence", 0.0),
        method=resolver_result.get("method", "unresolved"),
        method_detail=resolver_result.get("method_detail"),
        candidates=json.dumps(resolver_result.get("candidates", [])),
        failure_category=resolver_result.get("failure_category"),
        error=resolver_result.get("error"),
    )
    storage.save_resolver_decision(dec)

    # Evaluate if expected provided
    if req.expected:
        evaluate_parsed(raw_id, parsed, req.expected)

    return {
        "raw_id": raw_id,
        "parsed_id": parsed_id,
        "parsed": {k: v for k, v in parsed.items() if v is not None},
        "resolver": resolver_result,
    }


# ── Batch evaluation endpoint ───────────────────────────────────

class BatchIngestItem(BaseModel):
    message: str
    expected: Optional[dict] = None


class BatchIngestRequest(BaseModel):
    messages: list[BatchIngestItem]


@app.post("/ingest/batch")
async def ingest_batch(req: BatchIngestRequest):
    results = []
    for item in req.messages:
        r = await ingest(IngestRequest(
            message=item.message,
            expected=item.expected,
        ))
        results.append(r)
    return {"count": len(results), "results": results}


# ── Admin API endpoints ─────────────────────────────────────────

@app.get("/api/raw")
async def get_raw_messages(limit: int = 50, offset: int = 0):
    rows = storage.get_raw_messages(limit, offset)
    return [asdict(r) for r in rows]


@app.get("/api/raw/{raw_id}")
async def get_raw_message(raw_id: int):
    row = storage.get_raw_message(raw_id)
    if not row:
        raise HTTPException(404)
    return asdict(row)


@app.get("/api/parsed")
async def get_parsed(limit: int = 50, offset: int = 0, intent: str = ""):
    return storage.get_parsed(limit, offset, intent=intent)


@app.get("/api/resolver")
async def get_resolver_decisions(limit: int = 50, offset: int = 0, method: str = ""):
    return storage.get_resolver_decisions(limit, offset, method)


@app.get("/api/failed")
async def get_failed(limit: int = 50, offset: int = 0):
    return storage.get_failed(limit, offset)


@app.get("/api/stats")
async def get_stats():
    return storage.get_stats()


# ── Market Intelligence Dashboard ────────────────────────────────

def _today_prefix():
    from datetime import timezone
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _load_evidence_cache():
    """Lazy-load evidence cache for dashboard counts."""
    try:
        from evidence.resolver import _load_registry, _load_landmarks, CACHE
        _load_registry()
        _load_landmarks()
        return CACHE
    except Exception:
        return {}


@app.get("/api/dashboard/activity")
async def dashboard_activity():
    """Today's market activity: messages, new sellers, buyers, rentals, etc."""
    today = _today_prefix()
    activity = storage.dashboard_activity(today)
    types = storage.dashboard_message_types_today(today)
    type_map = {}
    for t in types:
        type_map[t["intent"]] = t["c"]
    activity["message_types"] = type_map
    obs_types = storage.dashboard_obs_types_today(today)
    obs_map = {}
    for t in obs_types:
        obs_map[t["message_type"]] = t["c"]
    activity["observation_types"] = obs_map
    return activity


@app.get("/api/dashboard/listings")
async def dashboard_listings(limit: int = 20):
    """Recent listings (SELL/RENT/PRE-LAUNCH/COMMERCIAL)."""
    return storage.dashboard_listings(limit)


@app.get("/api/dashboard/requirements")
async def dashboard_requirements(limit: int = 20):
    """Recent requirements (BUY/RENTAL_SEEKER)."""
    return storage.dashboard_requirements(limit)


@app.get("/api/dashboard/signals")
async def dashboard_signals():
    """Market signals and trends."""
    return storage.dashboard_signals()


@app.get("/api/dashboard/coverage")
async def dashboard_coverage():
    """Market memory: groups, messages stored, buildings, landmarks etc."""
    stats = storage.get_stats()
    cache = _load_evidence_cache()
    buildings = cache.get("buildings", {})
    landmarks = cache.get("landmarks_by_name", {})
    dev_buildings = cache.get("dev_buildings", {})
    micro_markets = set()
    for lm in cache.get("landmarks_list", []):
        mm = lm.get("micro_market")
        if mm:
            micro_markets.add(mm)
    jobs = storage.get_sync_jobs(limit=500)
    group_ids = set(j.group_id for j in jobs)
    synced_jobs = [j for j in jobs if j.records_processed and j.records_processed > 0]
    messages_from_groups = sum(j.records_processed or 0 for j in jobs)
    listings_known = storage.db.execute("SELECT COUNT(*) AS c FROM listings").fetchone()["c"]
    return {
        "groups_connected": len(group_ids),
        "messages_stored": stats["total_raw"],
        "listings_known": listings_known,
        "messages_from_groups": 0,
        "capture_mode": "live_webhook_only",
        "business_window": business_window_status(),
        "buildings_known": len(buildings),
        "landmarks_known": len(landmarks),
        "developers_known": len(dev_buildings),
        "micro_markets_known": len(micro_markets),
    }


@app.get("/api/dashboard/live-window")
async def dashboard_live_window():
    return business_window_status()


@app.get("/api/dashboard/feed")
async def dashboard_feed(limit: int = 20):
    """Live intelligence feed of latest messages."""
    return storage.dashboard_feed(limit)


@app.get("/api/dashboard/heatmap")
async def dashboard_heatmap():
    """Listings per micro market."""
    return storage.dashboard_heatmap()


@app.get("/api/dashboard/sync-activity")
async def dashboard_sync_activity():
    """Currently reading group and sync progress."""
    scheduler = get_scheduler()
    st = scheduler.status()
    from lab.scheduler import get_jobs
    jobs = get_jobs(source="whatsapp", status="running")
    running = None
    if jobs:
        j = jobs[0]
        running = {
            "group_name": j.get("group_name", j.get("group_id", "")),
            "group_id": j.get("group_id", ""),
            "records_found": j.get("records_found", 0),
            "records_processed": j.get("records_processed", 0),
        }
    overall = st.get("overall", "idle")
    return {
        "overall": overall,
        "total_jobs": len(get_jobs(source="whatsapp")),
        "running": running,
    }


@app.get("/api/dashboard/graph-growth")
async def dashboard_graph_growth():
    """Today's knowledge graph growth: new buildings, landmarks, etc."""
    today = _today_prefix()
    growth = storage.dashboard_growth(today)
    cache = _load_evidence_cache()
    known_buildings = set(k.lower() for k in cache.get("buildings", {}))
    known_landmarks = set(k.lower() for k in cache.get("landmarks_by_name", {}))
    today_timeline = growth["timeline"][-1] if growth["timeline"] else None
    today_new = {
        "buildings": [],
        "landmarks": [],
        "developers": [],
    }
    if today_timeline and today_timeline["day"] == today:
        for b in today_timeline.get("buildings", []):
            today_new["buildings"].append({
                "name": b,
                "known_in_evidence": b in known_buildings,
            })
        for l in today_timeline.get("landmarks", []):
            today_new["landmarks"].append({
                "name": l,
                "known_in_evidence": l in known_landmarks,
            })
        for d in today_timeline.get("developers", []):
            today_new["developers"].append({
                "name": d,
                "known_in_evidence": False,
            })
    return {
        "timeline": growth["timeline"],
        "totals": {
            "buildings": growth["total_buildings"],
            "landmarks": growth["total_landmarks"],
            "developers": growth["total_developers"],
        },
        "today_new": today_new,
    }


@app.get("/api/dashboard/whatsapp-status")
async def dashboard_whatsapp_status():
    """Detailed WhatsApp connection status."""
    details = _baileys_connection_details()
    phone = (details.get("phone_number") or "").replace("+", "")
    return {
        "connected": details.get("connected", False),
        "instance": details.get("instance_name", "propai-baileys"),
        "phone": phone,
        "profile": details.get("display_name") or "",
        "status": details.get("connection_state") or "",
        "state": details.get("connection_state") or "",
    }


# ═══════════════════════════════════════════════════════════════
# AI Layer — read-only intelligence endpoints
# ═══════════════════════════════════════════════════════════════

class QueryRequest(BaseModel):
    query: str
    k: int = 10


@app.post("/api/ai/query")
async def ai_query(req: QueryRequest):
    """Natural language query over observations using semantic search.
    Embeds the query text, finds nearest neighbours via cosine similarity.
    Returns matching observations with similarity scores.
    """
    eng = get_embedder()
    eng.partial_fit([req.query])
    emb = eng.embed(req.query)
    blob = pack_embedding(emb)
    results = storage.knn_search(blob, k=req.k)
    return {"query": req.query, "count": len(results), "results": results}


@app.get("/api/ai/similar/{observation_id}")
async def ai_similar(observation_id: int, k: int = 10):
    """Find observations semantically similar to a given observation."""
    detail = storage.get_observation_detail(observation_id)
    parsed = detail.get("parsed", {})
    emb = parsed.get("embedding")
    if not emb:
        raise HTTPException(404, "Observation has no embedding")
    results = storage.knn_search(emb, k=k + 1)
    filtered = [r for r in results if r.get("id") != parsed.get("id")][:k]
    return {"observation_id": observation_id, "count": len(filtered), "results": filtered}


@app.get("/api/ai/explain/{observation_id}")
async def ai_explain(observation_id: int):
    """Deterministic explanation of why the parser classified an observation as it did."""
    detail = storage.get_observation_detail(observation_id)
    parsed = detail.get("parsed", {})
    raw = detail.get("raw", {})
    if not parsed:
        raise HTTPException(404, "Observation not found")

    raw_text = raw.get("message", "")
    lower = raw_text.lower()

    rules = []

    # ── Intent rules ──
    if parsed.get("intent") == "PRE-LAUNCH":
        rules.append("intent=PRE-LAUNCH: matched pre-launch/new-launch keywords")
    elif parsed.get("intent") == "COMMERCIAL":
        rules.append("intent=COMMERCIAL: matched commercial keywords (office/shop/warehouse)")
    elif parsed.get("intent") == "RENT":
        rules.append("intent=RENT: matched rental keywords (rent/lease)")
    elif parsed.get("intent") == "SELL":
        if any(x in lower for x in ["sale", "sell", "selling", "available", "ready to move", "resale", "for sale"]):
            rules.append("intent=SELL: matched sale keywords")
        else:
            rules.append("intent=SELL: default (no buy/rent/pre-launch keywords detected)")
    elif parsed.get("intent") == "BUY":
        rules.append("intent=BUY: matched buy/requirement keywords")

    # ── Principal rules ──
    if parsed.get("principal") == "Owner":
        rules.append("principal=Owner: matched owner-sale/direct-owner pattern")
    elif parsed.get("principal") == "Buyer Client":
        rules.append("principal=Buyer Client: matched client-requirement/buyer-need pattern")
    else:
        rules.append("principal=Unknown: no owner or buyer-client pattern detected")

    # ── Broker rules ──
    broker = parsed.get("broker_name")
    profile = parsed.get("profile_name")
    if profile:
        rules.append(f"broker_name='{broker}' from WhatsApp profile name")
    elif broker:
        rules.append(f"broker_name='{broker}' from signature block (bottom-up extraction)")

    # ── Forwarded ──
    if parsed.get("forwarded"):
        rules.append("forwarded=1: message contains forwarded indicator")

    # ── Field extraction ──
    if parsed.get("bhk"):
        rules.append(f"bhk='{parsed['bhk']}': matched BHK pattern")
    if parsed.get("price"):
        rules.append(f"price={parsed['price']} {parsed.get('price_unit','')}: matched price pattern")
    if parsed.get("area_sqft"):
        rules.append(f"area_sqft={parsed['area_sqft']}: matched area pattern")
    if parsed.get("furnishing"):
        rules.append(f"furnishing='{parsed['furnishing']}': matched furnishing keyword")
    if parsed.get("building_name"):
        rules.append(f"building_name='{parsed['building_name']}': extracted from location")
    if parsed.get("landmark_name"):
        rules.append(f"landmark_name='{parsed['landmark_name']}': extracted from location")
    if parsed.get("micro_market"):
        rules.append(f"micro_market='{parsed['micro_market']}': extracted from location")

    # ── Resolver ──
    resolver = detail.get("resolver", {})
    if resolver.get("method") == "resolved":
        rules.append(f"resolver={resolver['method']}: matched building #{resolver.get('building_id')} "
                      f"({resolver.get('building_name', 'unknown')}) with confidence {resolver.get('resolver_confidence', 0)}")
    elif resolver.get("failure_category"):
        rules.append(f"resolver={resolver['method']}: {resolver['failure_category']}")

    return {
        "observation_id": observation_id,
        "parsed": {k: v for k, v in parsed.items() if v is not None and k != "embedding"},
        "rules": rules,
    }


@app.get("/api/ai/summary")
async def ai_summary():
    """Daily market summary: what happened today across all observations."""
    today = _today_prefix()
    activity = storage.dashboard_activity(today)
    types = storage.dashboard_message_types_today(today)
    type_map = {t["intent"]: t["c"] for t in types}

    growth = storage.dashboard_growth(today)
    today_timeline = growth["timeline"][-1] if growth["timeline"] else None

    top_brokers = storage.get_top_brokers_today(today)
    heat = storage.dashboard_heatmap()
    top_markets = [h for h in heat if h.get("c", 0) > 0][:10]

    return {
        "date": today,
        "messages_today": activity.get("messages_today", 0),
        "message_types": type_map,
        "growth": {
            "new_buildings": today_timeline.get("new_buildings", 0) if today_timeline else 0,
            "new_landmarks": today_timeline.get("new_landmarks", 0) if today_timeline else 0,
            "new_developers": today_timeline.get("new_developers", 0) if today_timeline else 0,
        },
        "top_brokers": top_brokers,
        "hot_markets": top_markets,
    }


@app.get("/api/ai/broker/{broker_name:path}")
async def ai_broker(broker_name: str):
    """Broker intelligence from aggregated observations."""
    observations = storage.get_observations_by_broker(broker_name)
    if not observations:
        raise HTTPException(404, f"No observations for broker: {broker_name}")
    total = len(observations)
    intents = {}
    buildings = set()
    markets = set()
    prices = []
    for o in observations:
        i = o.get("intent")
        if i:
            intents[i] = intents.get(i, 0) + 1
        b = o.get("building_name")
        if b:
            buildings.add(b)
        m = o.get("micro_market")
        if m:
            markets.add(m)
        p = o.get("price")
        if p:
            prices.append(p)
    avg_price = round(sum(prices) / len(prices), 2) if prices else None
    last_5 = observations[:5]
    for o in last_5:
        o.pop("embedding", None)
    return {
        "broker_name": broker_name,
        "total_observations": total,
        "intent_breakdown": intents,
        "unique_buildings": list(buildings),
        "unique_markets": list(markets),
        "avg_price": avg_price,
        "last_observations": last_5,
    }


@app.get("/api/ai/building/{building_name:path}")
async def ai_building(building_name: str):
    """Building memory from observations mentioning this building."""
    observations = storage.get_observations_by_building(building_name)
    if not observations:
        raise HTTPException(404, f"No observations for building: {building_name}")
    total = len(observations)
    intents = {}
    prices = []
    brokers = set()
    for o in observations:
        i = o.get("intent")
        if i:
            intents[i] = intents.get(i, 0) + 1
        p = o.get("price")
        if p:
            prices.append(p)
        b = o.get("broker_name")
        if b:
            brokers.add(b)
    avg_price = round(sum(prices) / len(prices), 2) if prices else None
    last_5 = observations[:5]
    for o in last_5:
        o.pop("embedding", None)
    return {
        "building_name": building_name,
        "total_observations": total,
        "intent_breakdown": intents,
        "unique_brokers": list(brokers),
        "avg_price": avg_price,
        "last_observations": last_5,
    }


# ═══════════════════════════════════════════════════════════════
# Promote Listing — ad copy generation
# ═══════════════════════════════════════════════════════════════

class PromoteRequest(BaseModel):
    observation_id: int
    channel: str = "whatsapp"
    use_ai: bool = False


def _promote_highlights(parsed: dict) -> list[str]:
    highlights = []
    if parsed.get("bhk"):
        highlights.append(f"{parsed['bhk']} configuration")
    if parsed.get("area_sqft"):
        highlights.append(f"{parsed['area_sqft']:,} sqft built-up area")
    if parsed.get("furnishing"):
        highlights.append(f"{parsed['furnishing']}")
    if parsed.get("building_name"):
        highlights.append(f"Located at {parsed['building_name']}")
    if parsed.get("landmark_name"):
        highlights.append(f"Near {parsed['landmark_name']}")
    if parsed.get("micro_market"):
        highlights.append(f"Prime location: {parsed['micro_market']}")
    if parsed.get("location_raw") and parsed["location_raw"] not in (parsed.get("micro_market") or "", parsed.get("building_name") or ""):
        highlights.append(f"Area: {parsed['location_raw']}")
    return highlights[:5]


def _promote_price(parsed: dict) -> str:
    price = parsed.get("price")
    unit = parsed.get("price_unit")
    if price and unit == "Cr":
        return f"₹{(price / 1_00_00_000):.2f} Cr"
    if price and unit == "L":
        return f"₹{(price / 1_00_000):.1f} L"
    if price and unit == "lakh":
        return f"₹{(price / 1_00_000):.1f} Lakh"
    if price:
        return f"₹{price:,.0f}"
    return ""


def _promote_headline(parsed: dict, channel: str) -> str:
    bhk = parsed.get("bhk", "Property")
    building = parsed.get("building_name", "")
    market = parsed.get("micro_market", "")
    price = _promote_price(parsed)
    location = market or parsed.get("location_raw", "")
    if channel == "whatsapp":
        parts = [f"🏗️ {bhk}"]
        if building:
            parts.append(f"at {building}")
        if location:
            parts.append(f"in {location}")
        if price:
            parts.append(f"| {price}")
        return " ".join(parts)
    if channel in ("facebook", "instagram"):
        parts = [f"{bhk}"]
        if building:
            parts.append(f"at {building}")
        if location:
            parts.append(f"in {location}")
        if price:
            parts.append(f"— {price}")
        return " ".join(parts)
    return ""


def _promote_whatsapp(parsed: dict, highlights: list[str]) -> str:
    bhk = parsed.get("bhk", "")
    building = parsed.get("building_name", "")
    market = parsed.get("micro_market", "")
    price = _promote_price(parsed)
    area = f"{parsed['area_sqft']:,} sqft" if parsed.get("area_sqft") else ""
    furnish = parsed.get("furnishing", "")
    broker = parsed.get("broker_name", "")
    phone = re.sub(r"[^0-9]", "", parsed.get("broker_phone") or "")[-10:]
    lines = ["🏗️ *" + _promote_headline(parsed, "whatsapp") + "*", ""]
    if building:
        lines.append(f"📍 {building}")
    if market:
        lines.append(f"📍 {market}")
    detail_parts = [p for p in [bhk, area, furnish] if p]
    if detail_parts:
        lines.append(" | ".join(detail_parts))
    if price:
        lines.append(f"💰 {price}")
    lines.append("")
    lines.append("✨ Highlights:")
    for h in highlights[:4]:
        lines.append(f"  ✅ {h}")
    lines.append("")
    if broker:
        lines.append(f"📞 {broker}")
    if phone and len(phone) == 10:
        lines.append(f"   wa.me/91{phone}")
    return "\n".join(lines)


def _promote_instagram(parsed: dict, highlights: list[str]) -> str:
    bhk = parsed.get("bhk", "")
    building = parsed.get("building_name", "")
    market = parsed.get("micro_market", "")
    price = _promote_price(parsed)
    area = f"{parsed['area_sqft']:,} sqft" if parsed.get("area_sqft") else ""
    furnish = parsed.get("furnishing", "")
    lines = [f"✨ {bhk}" + (f" at {building}" if building else "")]
    if market:
        lines.append(f"📍 {market}")
    if price:
        lines.append(f"💰 {price}")
    lines.append("")
    if area or furnish:
        detail_parts = [p for p in [area, furnish] if p]
        lines.append(" | ".join(detail_parts))
    lines.append("")
    lines.append("What you get:")
    for h in highlights[:4]:
        lines.append(f"✅ {h}")
    lines.append("")
    lines.append("📲 DM for more details or site visit!")
    return "\n".join(lines)


def _promote_facebook(parsed: dict, highlights: list[str]) -> str:
    insta = _promote_instagram(parsed, highlights)
    return insta + "\n\nAvailable for sale/rent. Serious inquiries only."


def _identify_channel_emoji(channel: str) -> str:
    return {"whatsapp": "💬", "facebook": "👍", "instagram": "📸"}.get(channel, "📢")


def _ai_promote(system: str, prompt: str) -> str | None:
    try:
        from openai import OpenAI
        client = OpenAI(api_key=DOUBLEWORD_API_KEY, base_url="https://api.doubleword.ai/v1")
        resp = client.chat.completions.create(
            model="Qwen/Qwen3.6-35B-A3B-FP8",
            messages=[{"role": "system", "content": system}, {"role": "user", "content": prompt}],
            extra_body={"chat_template_kwargs": {"enable_thinking": False}},
            max_tokens=300,
        )
        return resp.choices[0].message.content
    except Exception:
        return None


@app.post("/api/promote/generate")
async def promote_generate(req: PromoteRequest):
    detail = storage.get_observation_detail(req.observation_id)
    if not detail.get("parsed"):
        raise HTTPException(404, "Observation not found")
    parsed = detail["parsed"]
    highlights = _promote_highlights(parsed)
    headline = _promote_headline(parsed, req.channel)

    if req.channel == "whatsapp":
        body = _promote_whatsapp(parsed, highlights)
    elif req.channel == "instagram":
        body = _promote_instagram(parsed, highlights)
    elif req.channel == "facebook":
        body = _promote_facebook(parsed, highlights)
    else:
        raise HTTPException(400, f"Unknown channel: {req.channel}")

    result = {
        "channel": req.channel,
        "emoji": _identify_channel_emoji(req.channel),
        "headline": headline,
        "body": body,
        "highlights": highlights,
        "ai_enhanced": False,
    }

    if req.use_ai and DOUBLEWORD_API_KEY:
        try:
            system = "You are a Mumbai real estate marketing assistant. Given property details, write a short promotional ad for the specified channel. Keep it under 120 words. Return only the ad body, no preamble."
            price_str = _promote_price(parsed)
            detail_parts = [v for v in [parsed.get("bhk"), parsed.get("furnishing"), f"{parsed.get('area_sqft', '')} sqft" if parsed.get('area_sqft') else ""] if v]
            prompt = f"Channel: {req.channel}\nBuilding: {parsed.get('building_name', 'N/A')}\nLocation: {parsed.get('micro_market', parsed.get('location_raw', 'N/A'))}\nDetails: {' | '.join(detail_parts)}\nPrice: {price_str}\nBroker: {parsed.get('broker_name', 'N/A')}"
            loop = asyncio.get_running_loop()
            ai_body = await loop.run_in_executor(None, lambda: _ai_promote(system, prompt))
            if ai_body:
                result["body"] = ai_body
                result["ai_enhanced"] = True
        except Exception:
            pass

    return result


@app.get("/api/evaluations")
async def get_evaluations(limit: int = 50, min_accuracy: float = 0.0):
    rows = storage.get_evaluations(limit)
    if min_accuracy > 0.0:
        rows = [r for r in rows if r.get("accuracy_overall") is None or r["accuracy_overall"] >= min_accuracy]
    return rows


# ═══════════════════════════════════════════════════════════════
# Scraper Data Chat — conversational AI over scraped CSVs
# ═══════════════════════════════════════════════════════════════

class ChatRequest(BaseModel):
    messages: list[dict]
    api_key: str = ""


@app.post("/api/ai/chat")
async def ai_chat(req: ChatRequest):
    api_key = req.api_key or DOUBLEWORD_API_KEY
    if not api_key:
        return {"error": "api_key_required", "message": "Set your Doubleword API key in Chat settings"}

    sources = chat_engine.load_data()
    live = chat_engine.load_live_data(str(DB_PATH))
    sources.update(live)
    if not sources:
        return {"error": "no_data", "message": "No data found. Check CSV files and database."}

    loop = asyncio.get_running_loop()

    def _call():
        system_prompt = chat_engine.build_system_prompt(sources)
        msgs = [{"role": "system", "content": system_prompt}] + req.messages[-20:]
        reply = chat_engine.get_model_reply(msgs, sources, api_key=api_key)
        return reply.content or ""

    content = await loop.run_in_executor(None, _call)
    return {"content": content, "sources": list(sources.keys())}


@app.get("/api/ai/chat/overview")
async def ai_chat_overview():
    sources = chat_engine.load_data()
    live = chat_engine.load_live_data(str(DB_PATH))
    sources.update(live)
    if not sources:
        return {"error": "no_data"}
    return {"overview": chat_engine.build_overview(sources), "sources": list(sources.keys())}


# ── Evidence Inspector ──────────────────────────────────────────

@app.get("/api/observations/{obs_id}")
async def get_observation(obs_id: int):
    """Return full pipeline for a single observation: raw → parsed → resolver → evaluation."""
    result = storage.get_observation_detail(obs_id)
    if not result.get("raw"):
        raise HTTPException(404, "Observation not found")
    return result


# ── Replay ──────────────────────────────────────────────────────

class ReplayStats(BaseModel):
    total: int = 0
    resolved: int = 0
    unresolved: int = 0
    errors: int = 0
    avg_confidence: float = 0.0
    failure_breakdown: dict = {}


@app.post("/api/replay")
async def replay_all():
    """Re-run all stored messages through the current resolver and return accuracy stats."""
    raws = storage.get_all_raw_for_replay()

    stats = ReplayStats()
    stats.total = len(raws)
    failure_counts = {}

    for msg in raws:
        raw_text = msg.message
        parsed_result = parse_message(raw_text)
        resolver_result = resolve_parsed(parsed_result, raw_text)

        if resolver_result["method"] == "resolved":
            stats.resolved += 1
            stats.avg_confidence += resolver_result.get("final_confidence", 0.0)
        elif resolver_result["method"] == "unresolved":
            stats.unresolved += 1
        else:
            stats.errors += 1

        fc = resolver_result.get("failure_category") or "unknown"
        failure_counts[fc] = failure_counts.get(fc, 0) + 1

    if stats.resolved > 0:
        stats.avg_confidence = round(stats.avg_confidence / stats.resolved, 4)

    stats.failure_breakdown = dict(sorted(failure_counts.items(), key=lambda x: -x[1]))

    return stats.model_dump()


# ── Source Sync Endpoints ─────────────────────────────────────────
# IMPORTANT: static routes must come before /sources/{source_name}

@app.get("/api/sources")
async def list_sources():
    """List all registered sources."""
    from lab.ingestion.registry import get_registry
    reg = get_registry()
    sources = []
    for s in reg.all():
        sources.append({
            "name": s.name,
            "version": s.version,
            "connected": s.validate_connection(),
        })
    return {"sources": sources}


@app.get("/api/sources/status")
async def scheduler_status():
    """Return scheduler status and per-source summary."""
    scheduler = get_scheduler()
    st = scheduler.status()
    src_counts = storage.source_summary()
    st["capture_mode"] = "live_webhook_only"
    st["business_window"] = business_window_status()
    st["historical_messages_stored"] = 0
    st["total_messages_stored"] = sum(src_counts.values())
    all_jobs = storage.get_sync_jobs(limit=500)
    source_summary = {}
    for j in all_jobs:
        s = j.source
        if s not in source_summary:
            source_summary[s] = {"total": 0, "complete": 0, "running": 0, "failed": 0, "records": 0}
        source_summary[s]["total"] += 1
        status_key = j.status or "pending"
        source_summary[s][status_key] = source_summary[s].get(status_key, 0) + 1
        source_summary[s]["records"] += j.records_processed or 0
    st["source_summary"] = source_summary
    return st


@app.get("/api/sources/jobs")
async def list_jobs(source: str = "", status: str = "", limit: int = 50):
    """List sync jobs, optionally filtered by source and/or status."""
    jobs = storage.get_sync_jobs(limit=limit, source=source, status=status)
    return [asdict(j) for j in jobs]


@app.get("/api/sources/jobs/{job_id}")
async def get_job_detail(job_id: int):
    """Get details for a specific sync job."""
    job = storage.get_sync_job(job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")
    return asdict(job)


@app.post("/api/sources/stop")
async def scheduler_stop():
    """Stop the sync scheduler."""
    scheduler = get_scheduler()
    scheduler.stop()
    return {"status": "stopping", "message": "Scheduler stop requested"}


@app.post("/api/sources/{source_name}/sync")
async def source_sync(source_name: str):
    """Start sync for a specific source."""
    if source_name == "whatsapp":
        raise HTTPException(
            410,
            "Historical WhatsApp sync is disabled. PropAI captures live webhook messages during 10 AM - 7 PM IST.",
        )
    scheduler = get_scheduler()
    if scheduler.is_running:
        raise HTTPException(409, "Scheduler already running")
    from lab.ingestion.registry import get_registry
    if not get_registry().get(source_name):
        raise HTTPException(404, f"Unknown source: {source_name}")
    started = scheduler.start(source=source_name)
    if not started:
        raise HTTPException(400, "Failed to start scheduler")
    return {"status": "started", "source": source_name, "message": f"Sync started for {source_name}"}


@app.get("/api/sources/{source_name}")
async def get_source(source_name: str):
    """Get details for a specific source."""
    from lab.ingestion.registry import get_registry
    s = get_registry().get(source_name)
    if not s:
        raise HTTPException(404, f"Unknown source: {source_name}")
    return {
        "name": s.name,
        "version": s.version,
        "connected": s.validate_connection(),
    }


# ── Backward-compatible aliases (old /api/sync/* routes) ─────────

@app.post("/api/sync/start")
async def sync_start_legacy():
    """Legacy: start WhatsApp sync."""
    return await source_sync("whatsapp")


@app.post("/api/sync/stop")
async def sync_stop_legacy():
    return await scheduler_stop()


@app.get("/api/sync/status")
async def sync_status_legacy():
    return await scheduler_status()


@app.get("/api/sync/groups")
async def sync_groups_legacy():
    """Legacy: list WhatsApp sync jobs as groups."""
    from lab.scheduler import get_jobs
    return get_jobs(source="whatsapp")


@app.get("/api/sync/connection")
async def sync_connection():
    """Check WhatsApp connection status."""
    details = _baileys_connection_details()
    jobs = storage.get_sync_jobs(limit=500, source="whatsapp") if storage else []
    last_finished = max((j.finished_at for j in jobs if j.finished_at), default=None)
    discovered_groups = len(jobs)
    if details.get("total_groups") is None or discovered_groups > details.get("total_groups", 0):
        details["total_groups"] = discovered_groups
    details.update({
        "api_url": None,
        "ingestor": "baileys",
        "capture_mode": "live_webhook_only",
        "business_window": business_window_status(),
        "historical_sync_state": "disabled",
        "last_sync": last_finished,
        "discovered_jobs": discovered_groups,
        "historical_messages": 0,
        "messages_found": 0,
        "top_message_groups": _top_message_groups(jobs),
    })
    return details


@app.get("/api/sync/qr")
async def sync_qr():
    """Get QR code for WhatsApp login."""
    return {
        "error": "terminal_qr",
        "message": "Baileys QR is displayed in the terminal. Run './propai connect'.",
    }


@app.post("/api/sync/logout")
async def sync_logout():
    """Log out the WhatsApp instance."""
    return {
        "status": "manual",
        "message": "Stop the Baileys process and remove services/baileys-ingestor/auth to log out.",
    }


@app.get("/api/sync/connection-state")
async def sync_connection_state():
    """Get current connection state (open/connecting/closed)."""
    details = _baileys_connection_details()
    return {"state": details["connection_state"], "connected": details["connected"]}


def _baileys_connection_details() -> dict:
    if not storage:
        return {
            "connected": False,
            "connection_state": "unknown",
            "instance_name": "propai-baileys",
            "device_name": "Baileys",
        }

    row = storage.db.execute(
        """SELECT sender, raw_payload, timestamp, synced_at, created_at
           FROM raw_messages
           WHERE raw_payload LIKE '%"instance": "propai-baileys"%'
              OR raw_payload LIKE '%"instance":"propai-baileys"%'
           ORDER BY id DESC LIMIT 1"""
    ).fetchone()
    total = storage.db.execute(
        """SELECT COUNT(*) AS c
           FROM raw_messages
           WHERE raw_payload LIKE '%"instance": "propai-baileys"%'
              OR raw_payload LIKE '%"instance":"propai-baileys"%'"""
    ).fetchone()["c"]
    group_total = storage.db.execute(
        """SELECT COUNT(DISTINCT group_name) AS c
           FROM raw_messages
           WHERE group_name LIKE '%@g.us'
             AND (raw_payload LIKE '%"instance": "propai-baileys"%'
              OR raw_payload LIKE '%"instance":"propai-baileys"%')"""
    ).fetchone()["c"]

    connected = total > 0
    return {
        "connected": connected,
        "connection_state": "open" if connected else "unknown",
        "instance_name": "propai-baileys",
        "device_name": "Baileys terminal ingestor",
        "phone_number": "",
        "display_name": "",
        "connected_since": row["created_at"] if row else None,
        "last_message_at": row["timestamp"] if row else None,
        "total_groups": group_total,
        "messages_captured": total,
    }


def _historical_sync_state(jobs) -> str:
    if not jobs:
        return "not_started"
    if all((j.records_found or 0) == 0 and (j.records_processed or 0) == 0 for j in jobs):
        return "no_historical_messages"
    statuses = {j.status for j in jobs}
    if "running" in statuses:
        return "running"
    if "failed" in statuses:
        return "error"
    if statuses and statuses <= {"complete"}:
        return "complete"
    return "partial"


def _top_message_groups(jobs, limit: int = 5) -> list[dict]:
    ranked = sorted(
        jobs,
        key=lambda j: max(j.records_found or 0, j.records_processed or 0),
        reverse=True,
    )
    return [
        {
            "group_name": j.group_name or j.group_id,
            "group_id": j.group_id,
            "messages": max(j.records_found or 0, j.records_processed or 0),
        }
        for j in ranked[:limit]
    ]


# ── Listing endpoints for frontend ───────────────────────────────

@app.post("/api/rebuild-broker-graph")
async def rebuild_broker_graph():
    result = storage.rebuild_broker_graph()
    return result


@app.get("/api/brokers")
async def list_brokers():
    storage.rebuild_broker_graph()
    rows = storage.db.execute("""
        SELECT id, canonical_name AS name, primary_phone AS phone,
               observation_count, listing_count, requirement_count,
               rental_count, commercial_count, group_count, market_count,
               avg_ticket, first_seen_at, last_seen_at
        FROM brokers
        ORDER BY observation_count DESC, last_seen_at DESC
    """).fetchall()
    brokers = []
    for row in rows:
        broker = dict(row)
        broker["markets"] = [
            dict(r) for r in storage.db.execute("""
                SELECT micro_market, observation_count, listing_count, requirement_count
                FROM broker_market_stats
                WHERE broker_id = ?
                ORDER BY observation_count DESC, last_seen_at DESC
                LIMIT 5
            """, (broker["id"],)).fetchall()
        ]
        broker["buildings"] = [
            dict(r) for r in storage.db.execute("""
                SELECT building_name, observation_count, listing_count, requirement_count
                FROM broker_building_stats
                WHERE broker_id = ?
                ORDER BY observation_count DESC, last_seen_at DESC
                LIMIT 5
            """, (broker["id"],)).fetchall()
        ]
        brokers.append(broker)
    return brokers


@app.get("/api/brokers/{broker_id}")
async def get_broker_profile(broker_id: int):
    storage.rebuild_broker_graph()
    row = storage.db.execute("""
        SELECT id, canonical_name AS name, primary_phone AS phone,
               observation_count, listing_count, requirement_count,
               rental_count, commercial_count, group_count, market_count,
               avg_ticket, first_seen_at, last_seen_at
        FROM brokers
        WHERE id = ?
    """, (broker_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Broker not found")
    broker = dict(row)
    broker["aliases"] = [dict(r) for r in storage.db.execute("""
        SELECT alias, observation_count, first_seen_at, last_seen_at
        FROM broker_aliases
        WHERE broker_id = ?
        ORDER BY observation_count DESC
        LIMIT 20
    """, (broker_id,)).fetchall()]
    broker["phones"] = [dict(r) for r in storage.db.execute("""
        SELECT phone, observation_count, first_seen_at, last_seen_at
        FROM broker_phones
        WHERE broker_id = ?
        ORDER BY observation_count DESC
        LIMIT 10
    """, (broker_id,)).fetchall()]
    broker["markets"] = [dict(r) for r in storage.db.execute("""
        SELECT micro_market, observation_count, listing_count, requirement_count
        FROM broker_market_stats
        WHERE broker_id = ?
        ORDER BY observation_count DESC
        LIMIT 20
    """, (broker_id,)).fetchall()]
    broker["buildings"] = [dict(r) for r in storage.db.execute("""
        SELECT b.building_name, b.observation_count, b.listing_count, b.requirement_count,
               b.last_seen_at
        FROM broker_building_stats b
        WHERE b.broker_id = ?
        ORDER BY b.observation_count DESC
        LIMIT 50
    """, (broker_id,)).fetchall()]
    broker["observations"] = [dict(r) for r in storage.db.execute("""
        SELECT p.id AS parsed_id, p.intent, p.message_type, p.bhk, p.price, p.price_unit,
               p.furnishing, p.building_name, p.micro_market, p.broker_name,
               p.confidence, p.created_at
        FROM broker_observations bo
        JOIN parsed_output p ON p.id = bo.parsed_id
        WHERE bo.broker_id = ?
        ORDER BY bo.seen_at DESC
        LIMIT 100
    """, (broker_id,)).fetchall()]
    return broker


# ── AI Suggestions Queue ─────────────────────────────────────────

class SuggestionAction(BaseModel):
    status: str = "approved"


@app.get("/api/suggestions")
async def list_suggestions(status: str = "pending", limit: int = 50, offset: int = 0):
    return storage.get_suggestions(status=status, limit=limit, offset=offset)


@app.get("/api/suggestions/counts")
async def suggestion_counts():
    return storage.get_suggestion_counts()


@app.post("/api/suggestions/{sug_id}/{action}")
async def act_on_suggestion(sug_id: int, action: str, request: Request):
    if action not in ("approve", "reject", "ignore"):
        raise HTTPException(400, "action must be approve, reject, or ignore")
    status_map = {"approve": "approved", "reject": "rejected", "ignore": "ignored"}
    rejection_reason = ""
    try:
        body = await request.json()
        rejection_reason = body.get("rejection_reason", "") if isinstance(body, dict) else ""
    except Exception:
        pass
    storage.update_suggestion_status(sug_id, status_map[action], rejection_reason=rejection_reason)
    return {"status": "ok"}


@app.post("/api/suggestions/batch")
async def batch_suggestions(request: Request):
    body = await request.json()
    ids = body.get("ids", [])
    action = body.get("action", "approve")
    if action not in ("approve", "reject", "ignore"):
        raise HTTPException(400, "action must be approve, reject, or ignore")
    status_map = {"approve": "approved", "reject": "rejected", "ignore": "ignored"}
    rejection_reason = body.get("rejection_reason", "")
    storage.batch_update_suggestions(ids, status_map[action], rejection_reason=rejection_reason)
    return {"status": "ok", "count": len(ids)}


@app.get("/api/suggestions/memory")
async def suggestion_memory():
    return storage.get_ai_memory_stats()


@app.get("/api/suggestions/usage")
async def suggestion_usage(days: int = 1):
    return storage.get_ai_usage_stats(days=days)


@app.get("/api/price-stats")
async def price_stats_endpoint(market: str = "", bhk: str = "", intent: str = "listing"):
    if market and bhk:
        result = storage.get_price_stats(market, bhk, intent)
        return result or {"error": "not found"}
    rows = storage.db.execute(
        "SELECT * FROM price_stats ORDER BY count DESC LIMIT 100"
    ).fetchall()
    return [dict(r) for r in rows]


@app.get("/api/enrichment-jobs/counts")
async def enrichment_counts():
    counts = {}
    for status in ("pending", "running", "completed", "failed"):
        r = storage.db.execute(
            "SELECT COUNT(*) FROM enrichment_jobs WHERE status = ?", (status,)
        ).fetchone()
        counts[status] = r[0]
    return counts


@app.post("/api/aliases/scan")
async def scan_aliases():
    from agents.alias_learner import check_for_aliases
    check_for_aliases(storage)
    return {"status": "ok"}


@app.post("/api/price-stats/recompute")
async def recompute_price_stats():
    storage.recompute_price_stats()
    return {"status": "ok"}


@app.get("/api/buildings")
async def list_buildings():
    rows = storage.db.execute("""
        SELECT DISTINCT rd.building_name, p.micro_market, COUNT(*) AS occurrences
        FROM resolver_decisions rd
        LEFT JOIN parsed_output p ON p.id = rd.parsed_id
        WHERE rd.building_name IS NOT NULL AND rd.building_name != ''
        GROUP BY rd.building_name
        ORDER BY occurrences DESC
        LIMIT 100
    """).fetchall()
    return [dict(r) for r in rows]


@app.get("/api/groups")
async def list_groups():
    jobs = storage.get_sync_jobs(limit=500, source="whatsapp")
    allowlist = load_group_allowlist()
    groups = []
    for j in jobs:
        try:
            meta = json.loads(j.meta) if isinstance(j.meta, str) else (j.meta or {})
        except (json.JSONDecodeError, TypeError):
            meta = {}
        allowed = any(
            entry.lower() in j.group_name.lower()
            for entry in allowlist
        ) if allowlist else True
        groups.append({
            "jid": j.group_id,
            "name": j.group_name,
            "participants": meta.get("participants", 0),
            "parsed": parse_group_name(j.group_name),
            "records_found": j.records_found or 0,
            "records_processed": j.records_processed or 0,
            "status": j.status,
            "error": j.error,
            "allowed": allowed,
        })
    return sorted(groups, key=lambda g: g["name"].lower())


@app.get("/api/groups/allowlist")
async def get_allowlist():
    """Return the current group allowlist."""
    return load_group_allowlist()


@app.post("/api/groups/allowlist")
async def set_allowlist(request: Request):
    """Set the group allowlist (JSON array of group JIDs or name substrings)."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON")
    if not isinstance(body, list):
        raise HTTPException(400, "Expected a JSON array of strings")
    entries = [str(x).strip() for x in body if x and str(x).strip()]
    save_group_allowlist(entries)
    return {"status": "ok", "count": len(entries)}


@app.delete("/api/groups/allowlist")
async def clear_allowlist():
    """Clear the group allowlist (track all groups)."""
    save_group_allowlist([])
    return {"status": "ok"}


@app.get("/api/listings")
async def list_listings(limit: int = 50, offset: int = 0):
    return storage.get_listings(limit, offset)


@app.get("/api/search")
async def search_messages(q: str = ""):
    if not q:
        return []
    results = storage.db.execute("""
        SELECT p.id, p.intent, p.broker_name, p.broker_phone,
               p.bhk, p.price, p.price_unit, p.area_sqft, p.furnishing,
               p.location_raw, p.landmark_name, p.building_name, p.micro_market,
               p.confidence, r.message, r.group_name, r.timestamp
        FROM parsed_output p
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE r.message LIKE ? OR p.broker_name LIKE ? OR p.micro_market LIKE ?
           OR p.building_name LIKE ? OR p.landmark_name LIKE ?
        LIMIT 50
    """, [f"%{q}%"] * 5)
    return [dict(r) for r in results]


# ── WhatsApp Audit ────────────────────────────────────────────────

def _group_jid_to_name(jid: str) -> str:
    """Resolve a JID to its human-readable name from sync_jobs."""
    row = storage.db.execute(
        "SELECT group_name FROM source_sync_jobs WHERE group_id = ? AND group_name != '' LIMIT 1",
        (jid,)
    ).fetchone()
    if row:
        return row[0]
    return jid.split("@")[0][-8:]  # fallback: last 8 chars of JID

@app.get("/api/audit/dashboard")
async def audit_dashboard():
    now = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    today_start = datetime.utcnow().strftime("%Y-%m-%dT00:00:00Z")
    five_min_ago = (datetime.utcnow() - timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%SZ")
    day_ago = (datetime.utcnow() - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ")

    # Total groups with messages
    total_groups = storage.db.execute(
        "SELECT COUNT(DISTINCT group_name) FROM raw_messages"
    ).fetchone()[0]

    # Live groups (messages in last 5 min)
    live_groups = storage.db.execute(
        "SELECT COUNT(DISTINCT group_name) FROM raw_messages WHERE created_at >= ?",
        (five_min_ago,)
    ).fetchone()[0]

    # Messages today
    msgs_today = storage.db.execute(
        "SELECT COUNT(*) FROM raw_messages WHERE created_at >= ?", (today_start,)
    ).fetchone()[0]

    # Last webhook
    last_msg = storage.db.execute(
        "SELECT MAX(created_at) FROM raw_messages"
    ).fetchone()[0]

    # Groups with errors
    error_groups = storage.db.execute(
        "SELECT COUNT(*) FROM source_sync_jobs WHERE error IS NOT NULL AND error != ''"
    ).fetchone()[0]

    # Duplicate names (multiple groups with same display name)
    dupes = storage.db.execute("""
        SELECT group_name, COUNT(*) as c FROM source_sync_jobs
        WHERE group_name != '' AND group_name IS NOT NULL
        GROUP BY group_name HAVING c > 1
    """).fetchall()
    duplicate_groups = len(dupes)

    # Groups needing attention: errors + no activity in 24h
    inactive_count = storage.db.execute("""
        SELECT COUNT(*) FROM (
            SELECT sj.group_id FROM source_sync_jobs sj
            WHERE sj.group_id NOT IN (
                SELECT DISTINCT group_name FROM raw_messages WHERE created_at >= ?
            )
        )
    """, (day_ago,)).fetchone()[0]
    attention_required = error_groups + inactive_count

    # Capture health
    webhook_ok = last_msg is not None and last_msg >= five_min_ago
    failed_events = storage.db.execute(
        "SELECT COUNT(*) FROM enrichment_jobs WHERE status = 'failed'"
    ).fetchone()[0]
    pending_enrichment = storage.db.execute(
        "SELECT COUNT(*) FROM enrichment_jobs WHERE status = 'pending'"
    ).fetchone()[0]
    pending_ai = storage.db.execute(
        "SELECT COUNT(*) FROM ai_suggestions WHERE status = 'pending'"
    ).fetchone()[0]

    # Average processing time: time between raw_message created_at and parsed_output created_at
    avg_process = storage.db.execute("""
        SELECT AVG(
            strftime('%s', p.created_at) - strftime('%s', r.created_at)
        ) FROM parsed_output p
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE p.created_at >= ?
    """, (day_ago,)).fetchone()[0]

    return {
        "total_groups": total_groups,
        "live_groups": live_groups,
        "msgs_today": msgs_today,
        "last_webhook": last_msg or "never",
        "webhook_healthy": webhook_ok,
        "error_groups": error_groups,
        "duplicate_groups": duplicate_groups,
        "attention_required": attention_required,
        "inactive_groups": inactive_count,
        "failed_events": failed_events,
        "pending_enrichment": pending_enrichment,
        "pending_ai_suggestions": pending_ai,
        "avg_process_secs": round(avg_process, 1) if avg_process else None,
    }


@app.get("/api/audit/timeline")
async def audit_timeline(limit: int = 30):
    """Recent operational events across the pipeline."""
    events = []

    # Recent webhook events
    raw_rows = storage.db.execute("""
        SELECT 'webhook' as source, created_at as ts, message_type as subtype,
               CASE WHEN message_type = 'text' THEN 'Webhook received'
                    ELSE 'Webhook: ' || message_type END as label,
               group_name as group_jid, sender
        FROM raw_messages ORDER BY created_at DESC LIMIT ?
    """, (limit,)).fetchall()
    for r in raw_rows:
        d = dict(r)
        d["ts"] = d.pop("ts")
        d["group_name"] = _group_jid_to_name(d.pop("group_jid"))
        events.append(d)

    # Enrichment events
    enrich_rows = storage.db.execute("""
        SELECT 'enrichment' as source, ej.created_at as ts, ej.status as subtype,
               CASE WHEN ej.status = 'completed' THEN 'Building/location enrichment completed'
                    WHEN ej.status = 'failed' THEN 'Enrichment failed: ' || ej.last_error
                    ELSE 'Enrichment job created' END as label,
               ej.parsed_id as ref
        FROM enrichment_jobs ej ORDER BY ej.created_at DESC LIMIT ?
    """, (limit,)).fetchall()
    for r in enrich_rows:
        events.append(dict(r))

    # AI suggestion events
    sug_rows = storage.db.execute("""
        SELECT 'suggestion' as source, created_at as ts, status as subtype,
               agent, title
        FROM ai_suggestions ORDER BY created_at DESC LIMIT ?
    """, (limit,)).fetchall()
    for r in sug_rows:
        d = dict(r)
        agent = d.pop("agent", "")
        title = d.pop("title", "")
        if agent == "building":
            d["label"] = "AI suggested building: " + title
        elif agent == "location":
            d["label"] = "AI suggested location: " + title
        elif agent == "alias":
            d["label"] = "AI learned alias: " + title
        elif agent == "duplicate_listing":
            d["label"] = "Duplicate listing detected: " + title
        else:
            d["label"] = "AI " + agent + ": " + title
        events.append(d)

    # AI usage events
    usage_rows = storage.db.execute("""
        SELECT 'usage' as source, created_at as ts, agent as subtype,
               tokens_input, tokens_output
        FROM ai_usage_log ORDER BY created_at DESC LIMIT ?
    """, (limit,)).fetchall()
    for r in usage_rows:
        d = dict(r)
        ti = d.pop("tokens_input", 0)
        to = d.pop("tokens_output", 0)
        d["label"] = "AI call: " + d.get("subtype", "") + " (" + str(ti) + " in / " + str(to) + " out)"
        events.append(d)

    # Sort by time descending, take top N
    events.sort(key=lambda e: e.get("ts", ""), reverse=True)
    return events[:limit]


@app.get("/api/audit/groups")
async def audit_groups(q: str = "", status: str = ""):
    """Group explorer with stats per group."""
    day_ago = (datetime.utcnow() - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ")

    # Base: all groups from source_sync_jobs
    jobs = storage.get_sync_jobs(limit=1000, source="whatsapp")
    groups = []
    seen_jids = set()

    for j in jobs:
        jid = j.group_id
        if not jid or jid in seen_jids:
            continue
        seen_jids.add(jid)

        # Stats from raw_messages
        msg_info = storage.db.execute("""
            SELECT COUNT(*) as msg_count,
                   MAX(created_at) as last_ts
            FROM raw_messages WHERE group_name = ?
        """, (jid,)).fetchone()
        msg_count = msg_info["msg_count"] if msg_info else 0
        last_ts = msg_info["last_ts"] if msg_info else j.updated_at

        # Parsed observations stats
        obs_info = storage.db.execute("""
            SELECT COUNT(*) as obs_count,
                   COUNT(DISTINCT micro_market) as markets
            FROM parsed_output p
            JOIN raw_messages r ON r.id = p.raw_message_id
            WHERE r.group_name = ?
        """, (jid,)).fetchone()

        # Listings from this group
        listing_count = storage.db.execute("""
            SELECT COUNT(*) FROM listings l
            JOIN raw_messages r ON r.id = l.latest_raw_message_id
            WHERE r.group_name = ?
        """, (jid,)).fetchone()[0]

        # Requirements
        req_count = storage.db.execute("""
            SELECT COUNT(*) FROM parsed_output p
            JOIN raw_messages r ON r.id = p.raw_message_id
            WHERE r.group_name = ? AND p.intent IN ('BUY', 'RENTAL_SEEKER')
        """, (jid,)).fetchone()[0]

        # Unknown locations
        unknown_locs = storage.db.execute("""
            SELECT COUNT(*) FROM resolver_decisions rd
            JOIN parsed_output p ON p.id = rd.parsed_id
            JOIN raw_messages r ON r.id = p.raw_message_id
            WHERE r.group_name = ? AND rd.method = 'unresolved'
        """, (jid,)).fetchone()[0]

        # Coverage: obs with any resolution / total obs
        total_obs = obs_info["obs_count"] if obs_info else 0
        resolved_obs = max(0, total_obs - unknown_locs)
        coverage = round(resolved_obs / total_obs * 100, 1) if total_obs > 0 else 0

        # Determine status
        is_live = last_ts and last_ts >= day_ago
        has_error = bool(j.error)
        if has_error:
            group_status = "error"
        elif is_live:
            group_status = "live"
        else:
            group_status = "inactive"

        # Markets
        markets_str = obs_info["markets"] if obs_info and obs_info["markets"] else 0

        group_name = j.group_name or _group_jid_to_name(jid)

        g = {
            "jid": jid,
            "name": group_name,
            "status": group_status,
            "error": j.error or "",
            "messages": msg_count,
            "last_activity": last_ts or "",
            "observations": total_obs,
            "listings": listing_count,
            "requirements": req_count,
            "markets_count": markets_str,
            "unknown_locations": unknown_locs,
            "coverage": coverage,
            "parsed": parse_group_name(group_name),
        }

        # Apply filters
        if q and q.lower() not in group_name.lower() and q not in jid:
            continue
        if status == "live" and group_status != "live":
            continue
        if status == "inactive" and group_status != "inactive":
            continue
        if status == "error" and group_status != "error":
            continue

        groups.append(g)

    groups.sort(key=lambda g: g["messages"], reverse=True)
    return groups


@app.get("/api/audit/groups/{jid}")
async def audit_group_detail(jid: str):
    group_name = _group_jid_to_name(jid)

    # Raw stats
    raw_info = storage.db.execute("""
        SELECT COUNT(*) as msg_count, MIN(created_at) as first_seen,
               MAX(created_at) as last_seen
        FROM raw_messages WHERE group_name = ?
    """, (jid,)).fetchone()

    # Observation stats
    obs_rows = storage.db.execute("""
        SELECT p.id, p.intent, p.broker_name, p.building_name, p.micro_market,
               p.bhk, p.price, p.price_unit, p.confidence, r.message, r.timestamp
        FROM parsed_output p
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE r.group_name = ?
        ORDER BY r.created_at DESC LIMIT 50
    """, (jid,)).fetchall()

    # Brokers seen
    broker_count = storage.db.execute("""
        SELECT COUNT(DISTINCT p.broker_name) FROM parsed_output p
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE r.group_name = ? AND p.broker_name IS NOT NULL AND p.broker_name != ''
    """, (jid,)).fetchone()[0]

    # Markets seen
    markets = storage.db.execute("""
        SELECT DISTINCT p.micro_market FROM parsed_output p
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE r.group_name = ? AND p.micro_market IS NOT NULL AND p.micro_market != ''
        ORDER BY p.micro_market
    """, (jid,)).fetchall()

    # Buildings mentioned
    buildings = storage.db.execute("""
        SELECT DISTINCT p.building_name, COUNT(*) as occurrences FROM parsed_output p
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE r.group_name = ? AND p.building_name IS NOT NULL AND p.building_name != ''
        GROUP BY p.building_name ORDER BY occurrences DESC LIMIT 20
    """, (jid,)).fetchall()

    # AI suggestions for this group
    suggestions = storage.db.execute("""
        SELECT s.id, s.agent, s.title, s.description, s.status, s.confidence, s.created_at
        FROM ai_suggestions s
        ORDER BY s.created_at DESC LIMIT 20
    """).fetchall()

    # Resolver quality
    resolved = storage.db.execute("""
        SELECT COUNT(*) FROM resolver_decisions rd
        JOIN parsed_output p ON p.id = rd.parsed_id
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE r.group_name = ? AND rd.method != 'unresolved'
    """, (jid,)).fetchone()[0]

    unresolved = storage.db.execute("""
        SELECT COUNT(*) FROM resolver_decisions rd
        JOIN parsed_output p ON p.id = rd.parsed_id
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE r.group_name = ? AND rd.method = 'unresolved'
    """, (jid,)).fetchone()[0]

    total_resolved = resolved + unresolved
    quality_score = round(resolved / total_resolved * 100, 1) if total_resolved > 0 else 0

    # Sync job info
    sync_job = storage.db.execute("""
        SELECT * FROM source_sync_jobs WHERE group_id = ? LIMIT 1
    """, (jid,)).fetchone()

    return {
        "jid": jid,
        "name": group_name,
        "first_seen": raw_info["first_seen"] if raw_info else "",
        "last_seen": raw_info["last_seen"] if raw_info else "",
        "messages": raw_info["msg_count"] if raw_info else 0,
        "observations": len(obs_rows),
        "brokers": broker_count,
        "markets": [dict(m)["micro_market"] for m in markets],
        "buildings": [dict(b) for b in buildings],
        "listings": sum(1 for r in obs_rows if r["intent"] in ("SELL", "RENT", "COMMERCIAL", "PRE-LAUNCH")),
        "requirements": sum(1 for r in obs_rows if r["intent"] in ("BUY", "RENTAL_SEEKER")),
        "quality_score": quality_score,
        "resolved": resolved,
        "unresolved": unresolved,
        "recent_observations": [dict(r) for r in obs_rows[:20]],
        "suggestions": [dict(s) for s in suggestions[:10]],
        "sync_status": dict(sync_job) if sync_job else None,
    }


@app.get("/api/audit/groups/{jid}/timeline")
async def audit_group_timeline(jid: str):
    """Per-group event timeline."""
    events = []

    # Messages
    raw_rows = storage.db.execute("""
        SELECT created_at as ts, message_type, SUBSTR(message, 1, 60) as msg_preview
        FROM raw_messages WHERE group_name = ? ORDER BY created_at DESC LIMIT 30
    """, (jid,)).fetchall()
    for r in raw_rows:
        events.append({"ts": r["ts"], "label": "Message received (" + (r["msg_preview"] or "") + ")", "type": "message"})

    # Resolver decisions
    res_rows = storage.db.execute("""
        SELECT rd.created_at as ts, rd.method,
               COALESCE(rd.building_name, rd.landmark_name, rd.street_name, 'location') as resolved_to
        FROM resolver_decisions rd
        JOIN parsed_output p ON p.id = rd.parsed_id
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE r.group_name = ? AND rd.method != 'unresolved'
        ORDER BY rd.created_at DESC LIMIT 20
    """, (jid,)).fetchall()
    for r in res_rows:
        events.append({"ts": r["ts"], "label": "Resolved: " + (r["resolved_to"] or "location"), "type": "resolve"})

    events.sort(key=lambda e: e.get("ts", ""), reverse=True)
    return events[:50]


@app.get("/api/audit/duplicates")
async def audit_duplicates():
    """Find potential duplicate groups (same or very similar name)."""
    jobs = storage.db.execute("""
        SELECT group_id, group_name, error, status FROM source_sync_jobs
        WHERE group_name != '' AND group_name IS NOT NULL
        ORDER BY group_name
    """).fetchall()

    from collections import defaultdict
    by_name = defaultdict(list)
    for j in jobs:
        by_name[j["group_name"]].append(dict(j))

    dupes = []
    seen_pairs = set()
    names = list(by_name.keys())
    for i, name_a in enumerate(names):
        for name_b in names[i+1:]:
            # Simple similarity: one name contains the other or very similar
            a_lower = name_a.lower()
            b_lower = name_b.lower()
            if a_lower in b_lower or b_lower in a_lower:
                for ga in by_name[name_a]:
                    for gb in by_name[name_b]:
                        pair_key = tuple(sorted([ga["group_id"], gb["group_id"]]))
                        if pair_key not in seen_pairs:
                            seen_pairs.add(pair_key)
                            dupes.append({
                                "group_a": {"jid": ga["group_id"], "name": ga["group_name"]},
                                "group_b": {"jid": gb["group_id"], "name": gb["group_name"]},
                                "match_type": "name_similarity",
                            })

    # Also detect same-JID groups (shouldn't happen but guard)
    return dupes


@app.get("/api/audit/capture-health")
async def audit_capture_health():
    """Operational diagnostics for the ingestion pipeline."""
    now = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    five_min_ago = (datetime.utcnow() - timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%SZ")
    hour_ago = (datetime.utcnow() - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    today_start = datetime.utcnow().strftime("%Y-%m-%dT00:00:00Z")

    last_msg = storage.db.execute("SELECT MAX(created_at) FROM raw_messages").fetchone()[0]
    webhook_ok = last_msg is not None and last_msg >= five_min_ago

    # Msgs by hour
    msgs_last_hour = storage.db.execute(
        "SELECT COUNT(*) FROM raw_messages WHERE created_at >= ?", (hour_ago,)
    ).fetchone()[0]

    # Failed enrichment
    failed_enrichment = storage.db.execute(
        "SELECT COUNT(*) FROM enrichment_jobs WHERE status = 'failed'"
    ).fetchone()[0]

    # Pending enrichment
    pending_enrich = storage.db.execute(
        "SELECT COUNT(*) FROM enrichment_jobs WHERE status = 'pending'"
    ).fetchone()[0]

    # Enrichment attempts distribution
    retry_count = storage.db.execute(
        "SELECT SUM(attempts) FROM enrichment_jobs WHERE attempts > 0"
    ).fetchone()[0] or 0

    # Avg processing time
    avg_process = storage.db.execute("""
        SELECT AVG(strftime('%s', p.created_at) - strftime('%s', r.created_at))
        FROM parsed_output p
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE p.created_at >= ?
    """, (today_start,)).fetchone()[0]

    # Parser success rate today
    total_msgs = storage.db.execute(
        "SELECT COUNT(*) FROM raw_messages WHERE created_at >= ?", (today_start,)
    ).fetchone()[0]
    total_parsed = storage.db.execute(
        "SELECT COUNT(*) FROM parsed_output p JOIN raw_messages r ON r.id = p.raw_message_id WHERE r.created_at >= ?",
        (today_start,)
    ).fetchone()[0]
    parser_rate = round(total_parsed / total_msgs * 100, 1) if total_msgs > 0 else 0

    return {
        "webhook_healthy": webhook_ok,
        "last_message": last_msg or "never",
        "msgs_last_hour": msgs_last_hour,
        "avg_process_secs": round(avg_process, 1) if avg_process else None,
        "pending_enrichment": pending_enrich,
        "failed_enrichment": failed_enrichment,
        "retry_count": retry_count,
        "parser_success_rate": parser_rate,
        "total_msgs_today": total_msgs,
        "total_parsed_today": total_parsed,
    }


# ── SSE Event Stream ──────────────────────────────────────────────

@app.get("/api/events")
async def event_stream(request: Request):
    """Server-Sent Events endpoint. Subscribe to pipeline events."""
    bus = get_bus()
    queue = bus.sse_queue()

    async def generate():
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15)
                    yield f"event: {event['type']}\ndata: {json.dumps(event)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            bus.remove_queue(queue)

    return StreamingResponse(generate(), media_type="text/event-stream")


# ── Root redirect to Next.js frontend ────────────────────────────

@app.get("/")
async def root():
    return RedirectResponse("http://localhost:3000")


@app.get("/health")
async def health():
    return {"status": "ok", "db": str(DB_PATH)}


@app.get("/api/key")
async def api_key():
    key_path = Path(__file__).parent / ".api_key"
    token = key_path.read_text().strip() if key_path.exists() else ""
    return {"key": token, "path": str(key_path)}


# ── Serve QR code via proxy to Evolution API ────────────────────

QR_PAGE = None

def _get_qr_page():
    global QR_PAGE
    if QR_PAGE is not None:
        return QR_PAGE
    QR_PAGE = HTMLResponse("""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Connect Your Market — PropAI</title>
<style>
/* ── PropAI Design System (matches app.propai.live) ── */
:root{
  --background:#ffffff;--foreground:#0a0a0a;
  --card:#ffffff;--card-foreground:#0a0a0a;
  --primary:#171717;--primary-foreground:#fafafa;
  --secondary:#f5f5f5;--secondary-foreground:#171717;
  --muted:#f5f5f5;--muted-foreground:#737373;
  --accent:#f5f5f5;--accent-foreground:#171717;
  --blue:#2563eb;--blue-hover:#1d4ed8;
  --destructive:#ef4444;
  --border:#e5e5e5;
  --input:#e5e5e5;
  --ring:#0a0a0a;
  --radius:0.5rem;
  --radius-xl:0.75rem;
  --shadow:0 1px 2px 0 rgba(0,0,0,0.05);
  --shadow-md:0 4px 6px -1px rgba(0,0,0,0.1),0 2px 4px -2px rgba(0,0,0,0.1);
  --font:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica Neue,Arial,sans-serif;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{font-size:14px}
body{font-family:var(--font);background:#f8fafc;color:var(--foreground);-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
::selection{background:var(--blue);color:#fff}

/* ── Header ── */
.header{position:sticky;top:0;z-index:50;display:flex;align-items:center;justify-content:space-between;height:64px;padding:0 40px;background:rgba(255,255,255,0.95);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-bottom:1px solid var(--border);box-shadow:var(--shadow);flex-shrink:0}
.header-left{display:flex;align-items:center;gap:12px}
.logo{display:flex;align-items:center;gap:10px;text-decoration:none}
.logo-icon{width:40px;height:40px;border-radius:var(--radius-xl);background:var(--primary);display:flex;align-items:center;justify-content:center;color:#fff;font-size:18px;box-shadow:var(--shadow-md)}
.logo-text{font-size:18px;font-weight:700;color:var(--foreground);letter-spacing:-0.02em}
.header-right{display:flex;align-items:center;gap:16px}
.badge{display:inline-flex;align-items:center;padding:2px 10px;border-radius:9999px;font-size:12px;font-weight:500;border:1px solid var(--border);color:var(--muted-foreground);background:var(--card)}
.conn-status{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:500;color:var(--muted-foreground)}
.conn-dot{width:8px;height:8px;border-radius:50%;background:#fbbf24;flex-shrink:0}
.conn-dot.connected{background:#22c55e}
.conn-dot.error{background:var(--destructive)}

/* ── Layout ── */
.app{display:flex;flex-direction:column;min-height:100vh}
.main{flex:1;display:flex;align-items:center;justify-content:center;padding:32px 40px}
.main-inner{width:100%;max-width:900px;display:flex;flex-direction:column;align-items:center;gap:32px;animation:onboardFade 0.5s ease-out}

/* ── Hero ── */
.hero{text-align:center;max-width:540px}
.hero h1{font-size:30px;font-weight:800;letter-spacing:-0.03em;line-height:1.15;color:var(--foreground)}
.hero p{font-size:15px;color:var(--muted-foreground);margin-top:8px;line-height:1.6}
.hero .tagline{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:500;color:var(--blue);margin-bottom:12px}

/* ── Onboarding Card ── */
.onboard-card{display:flex;gap:40px;background:var(--card);border:1px solid var(--border);border-radius:var(--radius-xl);padding:40px 48px;box-shadow:var(--shadow);width:100%;animation:onboardCard 0.4s ease-out}
.qr-zone{display:flex;flex-direction:column;align-items:center;gap:16px;flex-shrink:0;min-width:280px}
.qr-frame{position:relative;width:232px;height:232px;border-radius:var(--radius);background:var(--muted);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;overflow:hidden}
.qr-frame img{width:216px;height:216px;border-radius:6px;display:block;transition:opacity 0.3s}
.qr-frame img.loading{opacity:0}
.qr-frame .qr-placeholder{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;color:var(--muted-foreground);font-size:13px;background:var(--muted);transition:opacity 0.3s}
.qr-frame .qr-placeholder.hidden{opacity:0;pointer-events:none}
.qr-timer{font-size:12px;font-weight:500;color:var(--muted-foreground);font-variant-numeric:tabular-nums;display:flex;align-items:center;gap:4px}
.qr-status{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:500;color:var(--muted-foreground)}
.qr-status .pulse{width:8px;height:8px;border-radius:50%;background:var(--blue);animation:qrPulse 1.8s ease-in-out infinite}
.qr-note{font-size:11px;color:var(--muted-foreground);text-align:center;line-height:1.4}

/* ── Steps ── */
.steps-zone{flex:1;display:flex;flex-direction:column;justify-content:center;gap:4px}
.steps-title{font-size:11px;font-weight:600;color:var(--muted-foreground);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px}
.step-item{display:flex;align-items:center;gap:12px;padding:8px 0}
.step-num{width:24px;height:24px;border-radius:6px;background:var(--secondary);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--muted-foreground);flex-shrink:0}
.step-icon{width:18px;height:18px;color:var(--muted-foreground);flex-shrink:0;display:flex;align-items:center;justify-content:center}
.step-icon svg{width:16px;height:16px}
.step-label{font-size:13px;font-weight:500;color:var(--foreground)}
.step-label.active{color:var(--blue);font-weight:600}
.step-connector{height:14px;margin-left:36px;border-left:1.5px dashed var(--border)}

/* ── Info Bar ── */
.info-bar{display:flex;gap:16px 24px;flex-wrap:wrap;justify-content:center;padding:16px 32px;background:var(--card);border:1px solid var(--border);border-radius:var(--radius);width:100%;animation:onboardCard 0.4s ease-out 0.1s both}
.info-item{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted-foreground)}
.info-item .check{width:16px;height:16px;border-radius:50%;background:rgba(34,197,94,0.12);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.info-item .check svg{width:9px;height:9px;color:#22c55e}

/* ── Footer ── */
.footer{text-align:center;padding:20px 40px;border-top:1px solid var(--border);background:var(--card)}
.footer-brand{font-size:12px;font-weight:500;color:var(--muted-foreground)}
.footer-disclaimer{font-size:11px;color:var(--muted-foreground);margin-top:4px;max-width:520px;margin-left:auto;margin-right:auto;line-height:1.5;opacity:0.7}

/* ── Animations ── */
@keyframes onboardFade{from{opacity:0}to{opacity:1}}
@keyframes onboardCard{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes qrPulse{0%,100%{opacity:0.5;transform:scale(1)}50%{opacity:1;transform:scale(1.4)}}

/* ── Responsive ── */
@media(max-width:820px){.onboard-card{flex-direction:column;align-items:center;padding:32px 24px}.qr-zone{min-width:auto}.steps-zone{width:100%}.header{padding:0 20px}.main{padding:24px 20px}.footer{padding:16px 20px}}
</style>
</head>
<body>
<div class="app">
  <header class="header">
    <div class="header-left">
      <a class="logo" href="/">
        <div class="logo-icon">⚡</div>
        <span class="logo-text">PropAI</span>
      </a>
    </div>
    <div class="header-right">
      <span class="badge">v1.0.0</span>
      <div class="conn-status" id="connStatus">
        <span class="conn-dot" id="connDot"></span>
        <span id="connLabel">Waiting for connection...</span>
      </div>
    </div>
  </header>

  <div class="main">
    <div class="main-inner">
      <div class="hero">
        <div class="tagline">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          WhatsApp &rarr; Organized Properties
        </div>
        <h1>Connect Your Market</h1>
        <p>Scan your WhatsApp to let PropAI build your local market memory from your broker groups &mdash; so you never miss a listing, price shift, or opportunity.</p>
      </div>

      <div class="onboard-card">
        <div class="qr-zone">
          <div class="qr-frame" id="qrFrame">
            <img id="qrImage" class="loading" src="/qr/image?t=" alt="QR Code">
            <div class="qr-placeholder" id="qrPlaceholder">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><line x1="3" y1="10" x2="3" y2="14"/><line x1="10" y1="3" x2="14" y2="3"/><line x1="10" y1="21" x2="14" y2="21"/><line x1="21" y1="10" x2="21" y2="14"/><line x1="10" y1="14" x2="14" y2="14"/></svg>
              Loading QR...
            </div>
          </div>
          <div class="qr-timer" id="qrTimer">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            Refreshes in <span id="timerCount">30</span>s
          </div>
          <div class="qr-status">
            <span class="pulse" id="pulseDot"></span>
            <span id="statusLabel">Waiting for scan...</span>
          </div>
          <div class="qr-note">The QR refreshes automatically if it expires.</div>
        </div>

        <div class="steps-zone">
          <div class="steps-title">How to connect</div>
          <div class="step-item">
            <div class="step-num">1</div>
            <span class="step-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></span>
            <span class="step-label">Open WhatsApp on your phone</span>
          </div>
          <div class="step-connector"></div>
          <div class="step-item">
            <div class="step-num">2</div>
            <span class="step-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></span>
            <span class="step-label">Go to Settings</span>
          </div>
          <div class="step-connector"></div>
          <div class="step-item">
            <div class="step-num">3</div>
            <span class="step-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg></span>
            <span class="step-label">Tap Linked Devices</span>
          </div>
          <div class="step-connector"></div>
          <div class="step-item">
            <div class="step-num">4</div>
            <span class="step-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg></span>
            <span class="step-label">Tap Link a Device</span>
          </div>
          <div class="step-connector"></div>
          <div class="step-item">
            <div class="step-num" style="background:rgba(37,99,235,0.1);border-color:var(--blue);color:var(--blue)">5</div>
            <span class="step-icon" style="color:var(--blue)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><rect x="7" y="7" width="10" height="10"/><line x1="3" y1="3" x2="7" y2="7"/><line x1="21" y1="3" x2="17" y2="7"/><line x1="3" y1="21" x2="7" y2="17"/><line x1="21" y1="21" x2="17" y2="17"/></svg></span>
            <span class="step-label active">Scan this QR code</span>
          </div>
        </div>
      </div>

      <div class="info-bar">
        <div class="info-item"><span class="check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>End-to-end encrypted</div>
        <div class="info-item"><span class="check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>Read-only historical import</div>
        <div class="info-item"><span class="check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>No messages modified</div>
        <div class="info-item"><span class="check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>Disconnect anytime</div>
      </div>
    </div>
  </div>

  <footer class="footer">
    <div class="footer-brand">Powered by <strong>Chaos Craft Labs</strong></div>
    <div class="footer-disclaimer">Your WhatsApp credentials are never stored. Authentication is handled directly through the official WhatsApp Web session.</div>
  </footer>
</div>

<script>
class QRController {
  constructor(opts = {}) {
    this.imageEl = document.getElementById('qrImage');
    this.placeholderEl = document.getElementById('qrPlaceholder');
    this.statusLabel = document.getElementById('statusLabel');
    this.connDot = document.getElementById('connDot');
    this.connLabel = document.getElementById('connLabel');
    this.pulseDot = document.getElementById('pulseDot');
    this.timerEl = document.getElementById('timerCount');
    this.refreshInterval = opts.refreshInterval || 30000;
    this.url = opts.url || '/qr/image';
    this.timer = null;
    this.countdown = null;
    this.secondsLeft = this.refreshInterval / 1000;
    this.initialLoad();
    this.startAutoRefresh();
    this.startCountdown();
  }

  async initialLoad() {
    this.imageEl.classList.add('loading');
    this.placeholderEl.classList.remove('hidden');
    try {
      const ts = Date.now();
      const res = await fetch(this.url + '?t=' + ts);
      if (res.ok) {
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const data = await res.json();
          if (data.error === 'already_connected') {
            this.imageEl.classList.remove('loading');
            this.placeholderEl.classList.add('hidden');
            this.setStatus('connected');
            this.stopAutoRefresh();
            setTimeout(() => { window.location.href = '/'; }, 1500);
            return;
          }
        }
        this.imageEl.src = this.url + '?t=' + ts;
        this.imageEl.onload = () => {
          this.imageEl.classList.remove('loading');
          this.placeholderEl.classList.add('hidden');
          this.setStatus('waiting');
          this.secondsLeft = this.refreshInterval / 1000;
          this.updateTimerDisplay();
        };
        this.imageEl.onerror = () => {
          this.imageEl.classList.remove('loading');
          this.setStatus('error');
        };
      } else {
        this.imageEl.classList.remove('loading');
        this.setStatus('error');
      }
    } catch(e) {
      this.imageEl.classList.remove('loading');
      this.setStatus('error');
    }
  }

  refresh() {
    this.initialLoad();
  }

  startCountdown() {
    this.countdown = setInterval(() => {
      this.secondsLeft--;
      this.updateTimerDisplay();
      if (this.secondsLeft <= 0) {
        this.secondsLeft = this.refreshInterval / 1000;
      }
    }, 1000);
  }

  updateTimerDisplay() {
    this.timerEl.textContent = Math.max(0, this.secondsLeft);
  }

  setStatus(state) {
    switch(state) {
      case 'waiting':
        this.statusLabel.textContent = 'Waiting for scan\u2026';
        this.pulseDot.style.animation = 'qrPulse 1.8s ease-in-out infinite';
        this.pulseDot.style.background = 'var(--blue)';
        break;
      case 'connected':
        this.statusLabel.textContent = 'Connected';
        this.pulseDot.style.background = '#22c55e';
        this.pulseDot.style.animation = 'none';
        this.connDot.className = 'conn-dot connected';
        this.connLabel.textContent = 'Connected';
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        if (this.countdown) { clearInterval(this.countdown); this.countdown = null; }
        break;
      case 'error':
        this.statusLabel.textContent = 'Connection error \u2014 retrying\u2026';
        this.pulseDot.style.background = 'var(--destructive)';
        this.pulseDot.style.animation = 'qrPulse 1.8s ease-in-out infinite';
        this.connDot.className = 'conn-dot error';
        this.connLabel.textContent = 'Error';
        break;
    }
  }

  startAutoRefresh() {
    this.timer = setInterval(() => this.refresh(), this.refreshInterval);
  }

  stopAutoRefresh() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.countdown) { clearInterval(this.countdown); this.countdown = null; }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const qr = new QRController();
  setInterval(async () => {
    try {
      const res = await fetch('/api/sync/connection');
      const data = await res.json();
      if (data.connected) {
        qr.setStatus('connected');
        qr.stopAutoRefresh();
        setTimeout(() => { window.location.href = '/'; }, 1500);
      }
    } catch(e) {}
  }, 5000);
});
</script>
</body>
</html>""")
    return QR_PAGE


@app.get("/qr/image")
async def qr_image():
    try:
        api_key = Path(".api_key").read_text().strip()
    except FileNotFoundError:
        api_key = "propai-dev-key"
    try:
        async with httpx.AsyncClient() as client:
            r = await client.get(
                "http://localhost:8080/instance/connect/propai-scraper",
                headers={"apikey": api_key}
            )
            data = r.json()
            # Evolution API returns {"count":0} when instance already connected
            if data.get("count") == 0:
                return {"error": "already_connected"}
            b64 = data.get("base64", "")
            if not b64:
                return {"error": "no qr code"}
            if "," in b64:
                b64 = b64.split(",")[1]
            return Response(
                content=base64.b64decode(b64),
                media_type="image/png"
            )
    except Exception as e:
        return {"error": str(e)}


@app.get("/connect")
async def connect_page():
    return {"status": "ok", "frontend": "http://localhost:3000/settings", "message": "Use the settings page at http://localhost:3000/settings to connect WhatsApp"}


# ── Entrypoint ──────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    from lab.config import HOST, PORT
    uvicorn.run("lab.app:app", host=HOST, port=PORT, reload=True)
