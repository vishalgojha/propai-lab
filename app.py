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

from lab.config import DB_PATH, WEBHOOK_SECRET, HOST, PORT, EVOLUTION_INSTANCE, EVOLUTION_API_URL, EVOLUTION_API_KEY, DOUBLEWORD_API_KEY, ENABLE_AI_PROMO, ENABLE_META_PUBLISHING, BAILEYS_STATUS_FILE, load_group_allowlist, save_group_allowlist, PROPAI_WEBHOOK_URL
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
async def get_raw_messages(limit: int = 50, offset: int = 0,
                           group_name: str = "", sender: str = "",
                           sender_phone: str = "", sender_jid: str = ""):
    rows = storage.get_raw_messages(limit, offset, group_name=group_name,
                                    sender=sender, sender_phone=sender_phone,
                                    sender_jid=sender_jid)
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


@app.get("/api/action/dashboard")
async def action_dashboard():
    """Actionable dashboard — every metric answers 'so what?'"""
    stats = storage.get_stats()
    today = datetime.utcnow().strftime("%Y-%m-%d")

    # Messages pending review (unresolved)
    unresolved_count = stats.get("unresolved", 0)
    suggestions_pending = storage.db.execute(
        "SELECT COUNT(*) AS c FROM ai_suggestions WHERE status = 'pending'"
    ).fetchone()["c"]

    # New buildings today
    new_buildings_today = storage.db.execute("""
        SELECT COUNT(*) AS c FROM (
            SELECT DISTINCT rd.building_name
            FROM resolver_decisions rd
            JOIN parsed_output p ON p.id = rd.parsed_id
            WHERE DATE(p.created_at) = ? AND rd.building_name IS NOT NULL
        )
    """, (today,)).fetchone()["c"]

    # Duplicate brokers detected
    dup_brokers = storage.db.execute("""
        SELECT COUNT(*) AS c FROM ai_suggestions
        WHERE agent = 'merge_broker' AND status IN ('pending', 'approved')
    """).fetchone()["c"]

    # Duplicate listings detected
    dup_listings = storage.db.execute("""
        SELECT COUNT(*) AS c FROM ai_suggestions
        WHERE suggestion_type = 'duplicate' AND status IN ('pending', 'approved')
    """).fetchone()["c"]

    # Parser confidence dropped (below 50%)
    low_confidence = storage.db.execute("""
        SELECT COUNT(*) AS c FROM parsed_output
        WHERE confidence < 0.5
    """).fetchone()["c"]

    # Groups disconnected/inactive
    disconnected_groups = storage.db.execute("""
        SELECT COUNT(*) AS c FROM sync_checkpoints
        WHERE status IN ('error', 'disconnected')
    """).fetchone()["c"]

    # Unknown locations discovered
    unknown_locations = storage.db.execute("""
        SELECT COUNT(*) AS c FROM resolver_decisions
        WHERE method = 'unresolved'
    """).fetchone()["c"]

    # Buildings pending approval
    pending_buildings = storage.db.execute("""
        SELECT COUNT(*) AS c FROM ai_suggestions
        WHERE agent = 'building' AND status = 'pending'
    """).fetchone()["c"]

    # Top parser failures
    top_failures = [dict(r) for r in storage.db.execute("""
        SELECT failure_category, COUNT(*) AS c
        FROM resolver_decisions
        WHERE failure_category IS NOT NULL AND failure_category != ''
        GROUP BY failure_category
        ORDER BY c DESC
        LIMIT 5
    """).fetchall()]

    return {
        "pending_review_unresolved": unresolved_count,
        "pending_ai_suggestions": suggestions_pending,
        "new_buildings_today": new_buildings_today,
        "duplicate_brokers_detected": dup_brokers,
        "duplicate_listings_detected": dup_listings,
        "low_confidence_parses": low_confidence,
        "disconnected_groups": disconnected_groups,
        "unknown_locations": unknown_locations,
        "buildings_pending_approval": pending_buildings,
        "top_parser_failures": top_failures,
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


@app.get("/api/markets/{market_name:path}")
async def get_market_detail(market_name: str):
    name = market_name.strip()
    if not name:
        raise HTTPException(400, "Market name is required")
    like_q = f"%{name}%"

    # Buildings in this market
    buildings = [dict(r) for r in storage.db.execute("""
        SELECT building_name, COUNT(*) AS observation_count,
               COUNT(DISTINCT broker_name) AS broker_count
        FROM parsed_output
        WHERE micro_market LIKE ? AND building_name IS NOT NULL AND building_name != ''
        GROUP BY building_name
        ORDER BY observation_count DESC
        LIMIT 20
    """, (like_q,)).fetchall()]

    # Brokers active in this market
    brokers = [dict(r) for r in storage.db.execute("""
        SELECT b.id, b.canonical_name AS name, b.primary_phone,
               bms.observation_count, bms.listing_count, bms.requirement_count
        FROM broker_market_stats bms
        JOIN brokers b ON b.id = bms.broker_id
        WHERE bms.micro_market LIKE ?
        ORDER BY bms.observation_count DESC
        LIMIT 20
    """, (like_q,)).fetchall()]

    # Intent breakdown
    intents = [dict(r) for r in storage.db.execute("""
        SELECT intent, COUNT(*) AS c
        FROM parsed_output
        WHERE micro_market LIKE ? AND intent IS NOT NULL
        GROUP BY intent
        ORDER BY c DESC
    """, (like_q,)).fetchall()]

    # Recently active groups in this market
    groups = [dict(r) for r in storage.db.execute("""
        SELECT r.group_name, COUNT(*) AS observation_count, MAX(r.timestamp) AS last_seen
        FROM parsed_output p
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE p.micro_market LIKE ? AND r.group_name IS NOT NULL
        GROUP BY r.group_name
        ORDER BY last_seen DESC
        LIMIT 10
    """, (like_q,)).fetchall()]

    # Price range summary per BHK
    price_ranges = [dict(r) for r in storage.db.execute("""
        SELECT bhk, COUNT(*) AS sample_count,
               ROUND(AVG(price), 0) AS avg_price,
               MIN(price) AS min_price, MAX(price) AS max_price
        FROM parsed_output
        WHERE micro_market LIKE ? AND price IS NOT NULL AND price > 0 AND bhk IS NOT NULL
        GROUP BY bhk
        ORDER BY sample_count DESC
    """, (like_q,)).fetchall()]

    return {
        "name": name,
        "building_count": len(buildings),
        "broker_count": len(brokers),
        "observation_count": sum(b.get("observation_count", 0) for b in buildings) if buildings else 0,
        "buildings": buildings,
        "brokers": brokers,
        "intents": intents,
        "groups": groups,
        "price_ranges": price_ranges,
    }


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
    fields: dict | None = None
    api_key: str = ""


@app.get("/api/promote/config")
async def promote_config():
    has_meta_credentials = bool(
        os.getenv("META_ACCESS_TOKEN")
        and (os.getenv("META_PAGE_ID") or os.getenv("META_INSTAGRAM_BUSINESS_ID"))
    )
    return {
        "enable_ai_promo": ENABLE_AI_PROMO,
        "enable_meta_publishing": ENABLE_META_PUBLISHING,
        "meta_publish_available": ENABLE_META_PUBLISHING and has_meta_credentials,
    }


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


def _ai_promote_with_key(system: str, prompt: str, api_key: str) -> str | None:
    try:
        from openai import OpenAI
        client = OpenAI(api_key=api_key, base_url="https://api.doubleword.ai/v1")
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
    parsed = dict(detail["parsed"])
    if req.fields:
        allowed_fields = {
            "bhk", "price", "price_unit", "area_sqft", "furnishing", "location_raw",
            "building_name", "landmark_name", "micro_market", "broker_name", "broker_phone",
        }
        for key, value in req.fields.items():
            if key in allowed_fields and value not in (None, ""):
                parsed[key] = value
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

    promo_api_key = req.api_key or DOUBLEWORD_API_KEY
    if req.use_ai and ENABLE_AI_PROMO and promo_api_key:
        try:
            system = "You are a Mumbai real estate marketing assistant. Given property details, write a short promotional ad for the specified channel. Keep it under 120 words. Return only the ad body, no preamble."
            price_str = _promote_price(parsed)
            detail_parts = [v for v in [parsed.get("bhk"), parsed.get("furnishing"), f"{parsed.get('area_sqft', '')} sqft" if parsed.get('area_sqft') else ""] if v]
            prompt = f"Channel: {req.channel}\nBuilding: {parsed.get('building_name', 'N/A')}\nLocation: {parsed.get('micro_market', parsed.get('location_raw', 'N/A'))}\nDetails: {' | '.join(detail_parts)}\nPrice: {price_str}\nBroker: {parsed.get('broker_name', 'N/A')}"
            loop = asyncio.get_running_loop()
            ai_body = await loop.run_in_executor(None, lambda: _ai_promote_with_key(system, prompt, promo_api_key))
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
    model: str = ""


def _doubleword_error_response(exc: Exception) -> JSONResponse:
    status_code = getattr(exc, "status_code", None)
    body = getattr(exc, "body", None)
    message = str(exc)
    if isinstance(body, dict):
        nested = body.get("error")
        if isinstance(nested, dict):
            message = nested.get("message") or nested.get("code") or message
        else:
            message = body.get("message") or message

    if status_code in (401, 403):
        return JSONResponse(
            status_code=status_code,
            content={
                "error": "doubleword_auth_failed" if status_code == 401 else "doubleword_forbidden",
                "message": (
                    "Doubleword rejected this API key. Paste a valid key in Settings."
                    if status_code == 401
                    else "Doubleword accepted the key but denied access. Check that the key has access to the selected model."
                ),
                "detail": message,
            },
        )

    return JSONResponse(
        status_code=502,
        content={
            "error": "doubleword_request_failed",
            "message": "Doubleword AI request failed. Check the API key, model, and Doubleword service status.",
            "detail": message,
        },
    )


@app.get("/api/ai/config")
async def ai_config():
    return {
        "has_server_key": bool(DOUBLEWORD_API_KEY),
        "base_url": chat_engine.BASE_URL,
        "model": chat_engine.MODEL,
    }


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
        reply = chat_engine.get_model_reply(
            msgs,
            sources,
            api_key=api_key,
            db_path=str(DB_PATH),
            model=req.model.strip() or None,
        )
        return reply.content or ""

    try:
        content = await loop.run_in_executor(None, _call)
        return {"content": content, "sources": list(sources.keys())}
    except Exception as exc:
        return _doubleword_error_response(exc)


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


# ═══════════════════════════════════════════════════════════════
# PropAI Companion — official WhatsApp Business mobile interface
# ═══════════════════════════════════════════════════════════════

COMPANION_ROLES = {
    "administrator": {
        "label": "Administrator",
        "permissions": ["full_access", "configure_ai", "configure_waba", "approve_users"],
    },
    "manager": {
        "label": "Manager",
        "permissions": ["read_all", "update_listings", "manage_buyers", "use_ai"],
    },
    "sales_agent": {
        "label": "Sales Agent",
        "permissions": ["view_assigned_inventory", "query_ai", "create_requirements", "promote_listings"],
    },
    "read_only": {
        "label": "Read-only",
        "permissions": ["search_only"],
    },
}

COMPANION_TOOLS = [
    "My Inventory",
    "My Buyers",
    "Market Listings",
    "Market Buyers",
    "Buildings",
    "Brokers",
    "Groups",
    "Markets",
    "Knowledge Graph",
    "Review Center",
    "Promotions",
    "Search",
]


class CompanionTeamMemberRequest(BaseModel):
    name: str
    mobile_number: str
    role: str = "sales_agent"
    assigned_markets: list[str] = []
    active: bool = True
    waba_identity: str = ""


class CompanionConfigRequest(BaseModel):
    whatsapp_business_number: str = ""
    phone_number_id: str = ""
    access_token: str = ""
    verify_token: str = ""
    clear_access_token: bool = False
    clear_verify_token: bool = False


def _mobile_digits(value: str = "") -> str:
    digits = re.sub(r"\D+", "", value or "")
    if len(digits) > 10 and digits.startswith("91"):
        return digits[-10:]
    return digits


def _json_list(value: str | None) -> list[str]:
    if not value:
        return []
    try:
        raw = json.loads(value)
        if isinstance(raw, list):
            return [str(item) for item in raw if item]
    except Exception:
        return []
    return []


def _companion_member(row) -> dict:
    data = dict(row)
    data["assigned_markets"] = _json_list(data.get("assigned_markets"))
    data["active"] = bool(data.get("active"))
    data["role_label"] = COMPANION_ROLES.get(data.get("role"), {}).get("label", data.get("role"))
    return data


def _count_table(table: str) -> int:
    try:
        return storage.db.execute(f"SELECT COUNT(*) AS c FROM {table}").fetchone()["c"]
    except Exception:
        return 0


def _companion_get_config_value(key: str, env_key: str = "") -> str:
    try:
        row = storage.db.execute(
            "SELECT value FROM companion_config WHERE key = ?", (key,)
        ).fetchone()
        if row and row["value"]:
            return row["value"]
    except Exception:
        pass
    return os.getenv(env_key or key, "")


def _companion_set_config_value(key: str, value: str):
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    storage.db.execute(
        """INSERT INTO companion_config (key, value, updated_at)
           VALUES (?,?,?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at""",
        (key, value, now),
    )


def _mask_secret(value: str = "") -> str:
    if not value:
        return ""
    if len(value) <= 8:
        return "••••"
    return f"{value[:4]}••••{value[-4:]}"


def _evolution_headers() -> dict[str, str]:
    key = EVOLUTION_API_KEY or "propai-dev-key"
    return {"apikey": key}


def _evolution_instance_state() -> dict:
    try:
        with httpx.Client(timeout=10.0) as client:
            response = client.get(
                f"{EVOLUTION_API_URL}/instance/connectionState/{EVOLUTION_INSTANCE}",
                headers=_evolution_headers(),
            )
            response.raise_for_status()
            payload = response.json()
    except Exception:
        return {}

    instance = payload.get("instance") if isinstance(payload, dict) else {}
    return instance if isinstance(instance, dict) else {}


def _evolution_instance_info() -> dict:
    try:
        with httpx.Client(timeout=10.0) as client:
            response = client.get(f"{EVOLUTION_API_URL}/instance/fetchInstances", headers=_evolution_headers())
            response.raise_for_status()
            payload = response.json()
    except Exception:
        return {}

    if not isinstance(payload, list):
        return {}
    for inst in payload:
        if isinstance(inst, dict) and inst.get("name") == EVOLUTION_INSTANCE:
            return inst
    return {}


def _baileys_status_file() -> dict:
    candidates = [BAILEYS_STATUS_FILE, PROJECT_DIR / "services" / "baileys-ingestor" / "auth" / "status.json"]
    seen: set[str] = set()
    for path in candidates:
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        try:
            if path.exists():
                data = json.loads(path.read_text())
                if isinstance(data, dict):
                    return data
        except Exception:
            continue
    return {}


def _today_count(table: str, column: str = "created_at", where: str = "1=1") -> int:
    try:
        return storage.db.execute(
            f"SELECT COUNT(*) AS c FROM {table} WHERE DATE({column}) = DATE('now') AND {where}"
        ).fetchone()["c"]
    except Exception:
        return 0


@app.get("/api/companion/overview")
async def companion_overview():
    team_count = _count_table("companion_team_members")
    active_team = storage.db.execute(
        "SELECT COUNT(*) AS c FROM companion_team_members WHERE active = 1"
    ).fetchone()["c"]
    pending_conversations = storage.db.execute(
        "SELECT COUNT(*) AS c FROM companion_conversations WHERE status IN ('needs_human', 'pending_approval')"
    ).fetchone()["c"]
    last_sync_row = storage.db.execute(
        "SELECT MAX(timestamp) AS ts FROM raw_messages"
    ).fetchone()
    last_sync = last_sync_row["ts"] if last_sync_row else None
    inbound_today = _today_count("companion_messages", where="direction = 'inbound'")
    outbound_today = _today_count("companion_messages", where="direction = 'outbound'")
    ai_today = _today_count("ai_usage_log")
    messages_today = _today_count("raw_messages", "timestamp")
    waba_number = (
        _companion_get_config_value("whatsapp_business_number", "WABA_PHONE_NUMBER")
        or _companion_get_config_value("whatsapp_business_number", "WABA_BUSINESS_NUMBER")
    )
    waba_phone_number_id = _companion_get_config_value("phone_number_id", "WABA_PHONE_NUMBER_ID")
    waba_access_token = _companion_get_config_value("access_token", "WABA_ACCESS_TOKEN")
    waba_verify_token = _companion_get_config_value("verify_token", "WABA_VERIFY_TOKEN")
    webhook_health = "ready" if waba_verify_token else "not_configured"
    token_status = "configured" if waba_access_token else "missing"

    knowledge_base_size = {
        "my_inventory": _count_table("listings"),
        "market_listings": _count_table("listings"),
        "market_buyers": storage.db.execute(
            "SELECT COUNT(*) AS c FROM parsed_output WHERE intent IN ('BUY','BUYER','REQUIREMENT','RENTAL_SEEKER')"
        ).fetchone()["c"],
        "brokers": _count_table("brokers"),
        "groups": _count_table("source_sync_jobs"),
        "markets": storage.db.execute(
            "SELECT COUNT(DISTINCT micro_market) AS c FROM parsed_output WHERE micro_market IS NOT NULL AND micro_market != ''"
        ).fetchone()["c"],
    }

    return {
        "connection_status": "connected" if waba_number and token_status == "configured" else "not_connected",
        "whatsapp_business_number": waba_number,
        "connected_team_members": active_team,
        "total_team_members": team_count,
        "last_sync": last_sync,
        "messages_today": messages_today,
        "ai_requests_today": ai_today,
        "pending_conversations": pending_conversations,
        "outbound_messages": outbound_today,
        "inbound_messages": inbound_today,
        "webhook_health": webhook_health,
        "token_status": token_status,
        "knowledge_base_size": knowledge_base_size,
        "waba": {
            "phone_number_id": waba_phone_number_id,
            "has_verify_token": bool(waba_verify_token),
            "has_access_token": bool(waba_access_token),
        },
    }


@app.get("/api/companion/config")
async def companion_config():
    waba_number = (
        _companion_get_config_value("whatsapp_business_number", "WABA_PHONE_NUMBER")
        or _companion_get_config_value("whatsapp_business_number", "WABA_BUSINESS_NUMBER")
    )
    phone_number_id = _companion_get_config_value("phone_number_id", "WABA_PHONE_NUMBER_ID")
    access_token = _companion_get_config_value("access_token", "WABA_ACCESS_TOKEN")
    verify_token = _companion_get_config_value("verify_token", "WABA_VERIFY_TOKEN")
    return {
        "whatsapp_business_number": waba_number,
        "phone_number_id": phone_number_id,
        "has_access_token": bool(access_token),
        "access_token_preview": _mask_secret(access_token),
        "has_verify_token": bool(verify_token),
        "verify_token_preview": _mask_secret(verify_token),
    }


@app.post("/api/companion/config")
async def companion_save_config(req: CompanionConfigRequest):
    if req.whatsapp_business_number.strip():
        _companion_set_config_value("whatsapp_business_number", req.whatsapp_business_number.strip())
    if req.phone_number_id.strip():
        _companion_set_config_value("phone_number_id", req.phone_number_id.strip())

    if req.clear_access_token:
        _companion_set_config_value("access_token", "")
    elif req.access_token.strip():
        _companion_set_config_value("access_token", req.access_token.strip())

    if req.clear_verify_token:
        _companion_set_config_value("verify_token", "")
    elif req.verify_token.strip():
        _companion_set_config_value("verify_token", req.verify_token.strip())

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    storage.db.execute(
        """INSERT INTO companion_audit_log
           (action, target_type, target_id, status, details, created_at)
           VALUES (?,?,?,?,?,?)""",
        (
            "waba_config_updated",
            "companion_config",
            "waba",
            "logged",
            json.dumps({
                "business_number_set": bool(req.whatsapp_business_number.strip()),
                "phone_number_id_set": bool(req.phone_number_id.strip()),
                "access_token_changed": bool(req.access_token.strip() or req.clear_access_token),
                "verify_token_changed": bool(req.verify_token.strip() or req.clear_verify_token),
            }),
            now,
        ),
    )
    storage._commit()
    return await companion_config()


@app.get("/api/companion/webhook")
async def companion_webhook_verify(request: Request):
    mode = request.query_params.get("hub.mode", "")
    token = request.query_params.get("hub.verify_token", "")
    challenge = request.query_params.get("hub.challenge", "")
    expected = _companion_get_config_value("verify_token", "WABA_VERIFY_TOKEN")
    if mode == "subscribe" and expected and token == expected:
        return Response(content=challenge, media_type="text/plain")
    raise HTTPException(403, "Webhook verify token does not match")


@app.post("/api/companion/webhook")
async def companion_webhook_receive(request: Request):
    body = await request.json()
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    storage.db.execute(
        """INSERT INTO companion_audit_log
           (action, target_type, target_id, status, details, created_at)
           VALUES (?,?,?,?,?,?)""",
        (
            "waba_webhook_received",
            "companion_webhook",
            "meta",
            "logged",
            json.dumps({
                "object": body.get("object"),
                "entries": len(body.get("entry", [])) if isinstance(body.get("entry"), list) else 0,
            }),
            now,
        ),
    )
    storage._commit()
    return {"status": "received"}


@app.get("/api/companion/team")
async def companion_team():
    rows = storage.db.execute(
        "SELECT * FROM companion_team_members ORDER BY active DESC, name COLLATE NOCASE"
    ).fetchall()
    return [_companion_member(row) for row in rows]


@app.post("/api/companion/team")
async def companion_add_team_member(req: CompanionTeamMemberRequest):
    name = req.name.strip()
    mobile = _mobile_digits(req.mobile_number)
    if not name:
        raise HTTPException(400, "Name is required")
    if len(mobile) < 10:
        raise HTTPException(400, "Valid mobile number is required")
    if req.role not in COMPANION_ROLES:
        raise HTTPException(400, "Invalid role")
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        cur = storage.db.execute(
            """INSERT INTO companion_team_members
               (name, mobile_number, role, assigned_markets, active, waba_identity, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (
                name,
                mobile,
                req.role,
                json.dumps(req.assigned_markets),
                1 if req.active else 0,
                req.waba_identity.strip(),
                now,
                now,
            ),
        )
        storage.db.execute(
            """INSERT INTO companion_audit_log
               (team_member_id, action, target_type, target_id, status, details, created_at)
               VALUES (?,?,?,?,?,?,?)""",
            (cur.lastrowid, "team_member_registered", "team_member", str(cur.lastrowid), "logged", "{}", now),
        )
        storage._commit()
    except Exception as exc:
        raise HTTPException(400, f"Could not add team member: {exc}")
    row = storage.db.execute("SELECT * FROM companion_team_members WHERE id = ?", (cur.lastrowid,)).fetchone()
    return _companion_member(row)


@app.patch("/api/companion/team/{member_id}")
async def companion_update_team_member(member_id: int, req: CompanionTeamMemberRequest):
    if req.role not in COMPANION_ROLES:
        raise HTTPException(400, "Invalid role")
    mobile = _mobile_digits(req.mobile_number)
    if len(mobile) < 10:
        raise HTTPException(400, "Valid mobile number is required")
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    storage.db.execute(
        """UPDATE companion_team_members
           SET name = ?, mobile_number = ?, role = ?, assigned_markets = ?,
               active = ?, waba_identity = ?, updated_at = ?
           WHERE id = ?""",
        (
            req.name.strip(),
            mobile,
            req.role,
            json.dumps(req.assigned_markets),
            1 if req.active else 0,
            req.waba_identity.strip(),
            now,
            member_id,
        ),
    )
    storage.db.execute(
        """INSERT INTO companion_audit_log
           (team_member_id, action, target_type, target_id, status, details, created_at)
           VALUES (?,?,?,?,?,?,?)""",
        (member_id, "team_member_updated", "team_member", str(member_id), "logged", "{}", now),
    )
    storage._commit()
    row = storage.db.execute("SELECT * FROM companion_team_members WHERE id = ?", (member_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Team member not found")
    return _companion_member(row)


@app.get("/api/companion/roles")
async def companion_roles():
    return COMPANION_ROLES


@app.get("/api/companion/tools")
async def companion_tools():
    return {"tools": COMPANION_TOOLS}


@app.get("/api/companion/conversations")
async def companion_conversations(limit: int = 20):
    rows = storage.db.execute(
        """SELECT c.*, t.name AS team_member_name, t.role AS team_member_role
           FROM companion_conversations c
           LEFT JOIN companion_team_members t ON t.id = c.team_member_id
           ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
           LIMIT ?""",
        (limit,),
    ).fetchall()
    return [dict(row) for row in rows]


@app.get("/api/companion/audit")
async def companion_audit(limit: int = 30):
    rows = storage.db.execute(
        """SELECT a.*, t.name AS team_member_name
           FROM companion_audit_log a
           LEFT JOIN companion_team_members t ON t.id = a.team_member_id
           ORDER BY a.created_at DESC
           LIMIT ?""",
        (limit,),
    ).fetchall()
    return [dict(row) for row in rows]


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
        "message": "Baileys QR is displayed in the terminal. Run 'propai connect' or 'cd services/baileys-ingestor && npm run dev'.",
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
    status = _baileys_status_file()
    if status:
        connected = bool(status.get("connected"))
        connection_state = str(status.get("connection_state") or ("open" if connected else "unknown")).lower()
        return {
            "connected": connected,
            "connection_state": connection_state,
            "instance_name": status.get("instance") or status.get("instance_name") or EVOLUTION_INSTANCE,
            "device_name": status.get("device_name") or "Baileys terminal ingestor",
            "phone_number": status.get("phone_number") or "",
            "display_name": status.get("display_name") or "",
            "connected_since": status.get("connected_since") or None,
            "last_message_at": status.get("last_message_at") or None,
            "total_groups": status.get("total_groups"),
            "messages_captured": status.get("messages_captured"),
        }

    live_state = _evolution_instance_state()
    live_info = _evolution_instance_info()

    live_connection = str(live_state.get("state") or live_info.get("connectionStatus") or "").lower()
    live_connected = live_connection in {"open", "connected", "syncing"}
    live_phone = live_info.get("ownerJid", "")
    live_number = live_phone.split("@")[0] if live_phone else ""
    live_profile = live_info.get("profileName", "") or live_info.get("name", "")
    live_created = live_info.get("createdAt", "")

    if live_connected or live_phone or live_profile:
        formatted_phone = f"+{live_number[:2]} {live_number[2:7]} {live_number[7:]}" if live_number else ""
        return {
            "connected": live_connected or bool(live_phone),
            "connection_state": live_connection or ("open" if live_connected else "unknown"),
            "instance_name": live_info.get("name", EVOLUTION_INSTANCE),
            "device_name": live_info.get("connectionStatus", "Baileys terminal ingestor"),
            "phone_number": formatted_phone or live_number,
            "display_name": live_profile,
            "connected_since": live_created or None,
            "last_message_at": None,
            "total_groups": 0,
            "messages_captured": 0,
        }

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


@app.get("/api/brokers/find")
async def find_broker(name: str = "", phone: str = ""):
    if not name and not phone:
        raise HTTPException(400, "name or phone is required")
    from lab.storage.sqlite import SqliteStorage
    key = SqliteStorage._broker_identity_key(name, phone)
    if not key:
        raise HTTPException(404, "Broker identity key could not be resolved")
    row = storage.db.execute(
        "SELECT id FROM brokers WHERE identity_key = ?", (key,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "Broker not found")
    return {"broker_id": row["id"]}


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


@app.get("/api/buildings/{building_name:path}")
async def get_building_profile(building_name: str):
    name = building_name.strip()
    if not name:
        raise HTTPException(400, "Building name is required")

    # Canonical name from aliases
    alias_row = storage.db.execute(
        "SELECT canonical FROM building_aliases WHERE alias = ?", (name,)
    ).fetchone()
    canonical = alias_row["canonical"] if alias_row else name

    # All aliases
    aliases = [dict(r) for r in storage.db.execute(
        "SELECT alias, confidence FROM building_aliases WHERE canonical = ? ORDER BY confidence DESC",
        (canonical,)
    ).fetchall()]

    # Observations mentioning this building
    observations = [dict(r) for r in storage.db.execute("""
        SELECT p.id, p.intent, p.bhk, p.price, p.price_unit, p.furnishing,
               p.micro_market, p.broker_name, p.broker_phone, p.confidence,
               p.created_at, r.message, r.group_name, r.timestamp
        FROM parsed_output p
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE p.building_name LIKE ?
        ORDER BY p.id DESC
        LIMIT 50
    """, (f"%{canonical}%",)).fetchall()]

    # Brokers who post this building
    brokers = [dict(r) for r in storage.db.execute("""
        SELECT b.id, b.canonical_name AS name, b.primary_phone AS phone,
               bbs.observation_count, bbs.listing_count, bbs.requirement_count, bbs.last_seen_at
        FROM broker_building_stats bbs
        JOIN brokers b ON b.id = bbs.broker_id
        WHERE bbs.building_name LIKE ?
        ORDER BY bbs.observation_count DESC
        LIMIT 20
    """, (f"%{canonical}%",)).fetchall()]

    # Markets this building appears in
    markets = [dict(r) for r in storage.db.execute("""
        SELECT micro_market, COUNT(*) AS occurrence_count
        FROM parsed_output
        WHERE building_name LIKE ? AND micro_market IS NOT NULL AND micro_market != ''
        GROUP BY micro_market
        ORDER BY occurrence_count DESC
    """, (f"%{canonical}%",)).fetchall()]

    # Price stats
    price_stats = [dict(r) for r in storage.db.execute("""
        SELECT intent, bhk, COUNT(*) AS sample_count,
               ROUND(AVG(price), 0) AS avg_price,
               MIN(price) AS min_price, MAX(price) AS max_price
        FROM parsed_output
        WHERE building_name LIKE ? AND price IS NOT NULL AND price > 0
        GROUP BY intent, bhk
        ORDER BY sample_count DESC
    """, (f"%{canonical}%",)).fetchall()]

    # Timeline of discovery
    timeline = [dict(r) for r in storage.db.execute("""
        SELECT DATE(created_at) AS day, COUNT(*) AS observations
        FROM parsed_output
        WHERE building_name LIKE ?
        GROUP BY DATE(created_at)
        ORDER BY day DESC
        LIMIT 30
    """, (f"%{canonical}%",)).fetchall()]

    # Nearby landmarks (from same messages)
    landmarks = [dict(r) for r in storage.db.execute("""
        SELECT p2.landmark_name, COUNT(*) AS co_occurrence
        FROM parsed_output p1
        JOIN parsed_output p2 ON p1.raw_message_id = p2.raw_message_id
        WHERE p1.building_name LIKE ?
          AND p2.landmark_name IS NOT NULL AND p2.landmark_name != ''
          AND p2.id != p1.id
        GROUP BY p2.landmark_name
        ORDER BY co_occurrence DESC
        LIMIT 10
    """, (f"%{canonical}%",)).fetchall()]

    # AI suggestions for this building
    suggestions = [dict(r) for r in storage.db.execute("""
        SELECT id, agent, suggestion_type, title, description, confidence, status, created_at
        FROM ai_suggestions
        WHERE building_name LIKE ? OR expected_building LIKE ? OR extracted_building LIKE ?
        ORDER BY created_at DESC
        LIMIT 10
    """, (f"%{canonical}%", f"%{canonical}%", f"%{canonical}%")).fetchall()]

    return {
        "name": canonical,
        "aliases": aliases,
        "observation_count": len(observations),
        "broker_count": len(brokers),
        "market_count": len(markets),
        "observations": observations,
        "brokers": brokers,
        "markets": markets,
        "price_stats": price_stats,
        "timeline": timeline,
        "landmarks": landmarks,
        "suggestions": suggestions,
    }


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
    q = q.strip()
    like_q = f"%{q}%"
    before_q = f"%{q}"
    after_q = f"{q}%"

    # Build search results grouped by entity type
    result = {"listings": [], "requirements": [], "brokers": [], "buildings": [], "markets": [], "messages": []}

    # Priority: listings first (most useful)
    result["listings"] = [dict(r) for r in storage.db.execute("""
        SELECT fingerprint, intent, bhk, price, price_unit, area_sqft, furnishing,
               location_label, building_name, landmark_name, micro_market,
               broker_name, broker_phone, observation_count, last_seen
        FROM listings
        WHERE broker_name LIKE ? OR building_name LIKE ? OR micro_market LIKE ?
           OR bhk LIKE ? OR location_label LIKE ? OR landmark_name LIKE ?
        ORDER BY observation_count DESC
        LIMIT 8
    """, [like_q] * 6).fetchall()]

    # Requirements
    result["requirements"] = [dict(r) for r in storage.db.execute("""
        SELECT p.id, p.intent, p.bhk, p.price, p.price_unit, p.broker_name, p.broker_phone,
               p.micro_market, p.location_raw, p.created_at, r.message, r.group_name
        FROM parsed_output p
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE p.intent IN ('BUY','RENTAL_SEEKER')
          AND (r.message LIKE ? OR p.broker_name LIKE ? OR p.micro_market LIKE ?
               OR p.bhk LIKE ? OR p.location_raw LIKE ?)
        ORDER BY p.id DESC
        LIMIT 6
    """, [like_q] * 5).fetchall()]

    # Brokers
    result["brokers"] = [dict(r) for r in storage.db.execute("""
        SELECT id, canonical_name AS name, primary_phone AS phone,
               observation_count, listing_count, requirement_count,
               group_count, market_count, avg_ticket
        FROM brokers
        WHERE canonical_name LIKE ? OR primary_phone LIKE ?
        ORDER BY observation_count DESC
        LIMIT 6
    """, [like_q, like_q]).fetchall()]

    # Buildings
    result["buildings"] = [dict(r) for r in storage.db.execute("""
        SELECT DISTINCT rd.building_name AS name, p.micro_market,
               COUNT(*) AS occurrence_count,
               COUNT(DISTINCT p.broker_name) AS broker_count
        FROM resolver_decisions rd
        LEFT JOIN parsed_output p ON p.id = rd.parsed_id
        WHERE rd.building_name IS NOT NULL AND rd.building_name != ''
          AND rd.building_name LIKE ?
        GROUP BY rd.building_name
        ORDER BY occurrence_count DESC
        LIMIT 6
    """, [like_q]).fetchall()]

    # Markets
    result["markets"] = [dict(r) for r in storage.db.execute("""
        SELECT micro_market, COUNT(*) AS observation_count,
               COUNT(DISTINCT building_name) AS building_count,
               COUNT(DISTINCT broker_name) AS broker_count
        FROM parsed_output
        WHERE micro_market IS NOT NULL AND micro_market != ''
          AND micro_market LIKE ?
        GROUP BY micro_market
        ORDER BY observation_count DESC
        LIMIT 6
    """, [like_q]).fetchall()]

    # Raw messages (for full-text search of messages)
    result["messages"] = [dict(r) for r in storage.db.execute("""
        SELECT id, message, group_name, sender, timestamp
        FROM raw_messages
        WHERE message LIKE ?
        ORDER BY id DESC
        LIMIT 6
    """, [like_q]).fetchall()]

    # Remove empty groups
    result = {k: v for k, v in result.items() if v}
    return result


@app.get("/api/search/listings")
async def search_listings(
    intent: str = "", bhk: str = "", building: str = "", micro_market: str = "",
    price_max: float = 0, price_min: float = 0, furnishing: str = "", broker: str = "",
    sort_by: str = "last_seen", limit: int = 10, offset: int = 0,
    group_by_building: bool = True,
):
    """Structured listing search with building grouping and pagination."""
    import math
    from datetime import datetime, timezone, timedelta

    where_clauses = []
    params = []

    if intent and intent != "any":
        where_clauses.append("l.intent = ?")
        params.append(intent.upper())

    if bhk and bhk != "any":
        where_clauses.append("l.bhk = ?")
        params.append(bhk)

    if building:
        where_clauses.append("""(
            l.building_name LIKE ? OR
            l.building_name IN (SELECT canonical FROM building_aliases WHERE alias LIKE ?) OR
            l.building_name IN (SELECT alias FROM building_aliases WHERE canonical LIKE ?) OR
            l.building_name IN (SELECT canonical FROM building_aliases WHERE alias LIKE ?)
        )""")
        bpattern = f"%{building}%"
        params.extend([bpattern, bpattern, bpattern, bpattern])

    if micro_market:
        where_clauses.append("l.micro_market LIKE ?")
        params.append(f"%{micro_market}%")

    if price_max:
        where_clauses.append("l.price <= ?")
        params.append(float(price_max))

    if price_min:
        where_clauses.append("l.price >= ?")
        params.append(float(price_min))

    if furnishing and furnishing != "any":
        where_clauses.append("l.furnishing = ?")
        params.append(furnishing)

    if broker:
        where_clauses.append("l.broker_name LIKE ?")
        params.append(f"%{broker}%")

    where_sql = " AND ".join(where_clauses) if where_clauses else "1=1"

    sort_map = {
        "price": "l.price",
        "last_seen": "l.last_seen",
        "observation_count": "l.observation_count",
    }
    order_sql = sort_map.get(sort_by, "l.last_seen")

    total_count = storage.db.execute(
        f"SELECT COUNT(*) FROM listings l WHERE {where_sql}", params
    ).fetchone()[0]

    listing_params = params.copy()
    listing_params.extend([limit + 50, offset])
    rows = storage.db.execute(f"""
        SELECT l.fingerprint, l.intent, l.bhk, l.price, l.price_unit, l.area_sqft,
               l.furnishing, l.location_label, l.building_name, l.landmark_name,
               l.micro_market, l.broker_name, l.broker_phone,
               l.first_seen, l.last_seen, l.observation_count, l.group_count,
               l.latest_raw_message_id
        FROM listings l
        WHERE {where_sql}
        ORDER BY {order_sql} DESC
        LIMIT ? OFFSET ?
    """, listing_params).fetchall()

    if not rows:
        return {
            "type": "listing_results",
            "total": total_count,
            "results": [],
            "grouped": {},
            "showing": 0,
            "offset": offset,
            "has_more": False,
            "remaining": 0,
            "search_summary": {"total": 0, "brokers": 0, "buildings": 0, "groups": 0},
            "suggestion": "No exact matches found. Try: Nearby markets | Similar buildings | Different budget | Different BHK | Latest listings",
        }

    now = datetime.now(timezone.utc)
    results = []
    for r in rows:
        d = dict(r)
        match_reasons = []
        if bhk and bhk != "any" and d.get("bhk"):
            match_reasons.append(f"✓ {d['bhk']} BHK")
        if intent and d.get("intent"):
            match_reasons.append(f"✓ {d['intent']}")
        if micro_market and d.get("micro_market"):
            match_reasons.append(f"✓ {d['micro_market']}")
        if building and d.get("building_name"):
            match_reasons.append(f"✓ Building match: {d['building_name']}")
        if furnishing and d.get("furnishing"):
            match_reasons.append(f"✓ {d['furnishing']}")

        last_seen = d.get("last_seen")
        age = ""
        if last_seen:
            try:
                last_dt = datetime.fromisoformat(last_seen.replace("Z", "+00:00"))
                diff = now - last_dt
                if diff.days == 0:
                    hours = diff.seconds // 3600
                    age = f"Seen {hours}h ago" if hours > 0 else "Seen just now"
                elif diff.days == 1:
                    age = "Seen yesterday"
                elif diff.days < 7:
                    age = f"Seen {diff.days}d ago"
                else:
                    age = f"Seen {diff.days // 7}w ago"
            except:
                age = ""

        first_seen = d.get("first_seen")
        first_age = ""
        if first_seen:
            try:
                first_dt = datetime.fromisoformat(first_seen.replace("Z", "+00:00"))
                diff = now - first_dt
                if diff.days == 0:
                    first_age = "First seen today"
                elif diff.days == 1:
                    first_age = "First seen yesterday"
                elif diff.days < 7:
                    first_age = f"First seen {diff.days}d ago"
                else:
                    first_age = f"First seen {diff.days // 7}w ago"
            except:
                first_age = ""

        price_val = d.get("price") or 0
        price_formatted = ""
        if price_val >= 1_00_00_000:
            price_formatted = f"₹{price_val / 1_00_00_000:.2f} Cr"
        elif price_val >= 1_00_000:
            price_formatted = f"₹{price_val / 1_00_000:.1f} L"
        elif price_val > 0:
            price_formatted = f"₹{price_val:,.0f}"
        if d.get("price_unit") and d.get("price_unit") != "/sale" and d.get("intent") == "RENT":
            price_formatted += "/month"

        confidence_pct = 0

        latest_msg = ""

        results.append({
            "fingerprint": d.get("fingerprint"),
            "intent": d.get("intent"),
            "bhk": d.get("bhk"),
            "price": d.get("price"),
            "price_formatted": price_formatted,
            "area_sqft": d.get("area_sqft"),
            "furnishing": d.get("furnishing"),
            "location_label": d.get("location_label"),
            "building_name": d.get("building_name") or "Unknown Building",
            "landmark_name": d.get("landmark_name"),
            "micro_market": d.get("micro_market"),
            "broker_name": d.get("broker_name"),
            "broker_phone": d.get("broker_phone"),
            "first_seen": d.get("first_seen"),
            "first_seen_text": first_age,
            "last_seen": d.get("last_seen"),
            "last_seen_text": age,
            "observation_count": d.get("observation_count", 0),
            "group_count": d.get("group_count", 0),
            "confidence": confidence_pct,
            "latest_message": latest_msg,
            "latest_group": "",
            "latest_timestamp": "",
            "latest_sender": "",
            "raw_message_id": d.get("latest_raw_message_id"),
            "match_reasons": match_reasons,
        })

    grouped = {}
    if group_by_building:
        for r in results:
            bname = r["building_name"] or "Unknown Building"
            if bname not in grouped:
                grouped[bname] = {"rentals": 0, "sales": 0, "listings": []}
            if r["intent"] == "RENT":
                grouped[bname]["rentals"] += 1
            elif r["intent"] == "SELL":
                grouped[bname]["sales"] += 1
            grouped[bname]["listings"].append(r)

    brokers_found = len(set(r["broker_name"] for r in results if r["broker_name"]))
    buildings_found = len(set(r["building_name"] for r in results if r["building_name"]))
    groups_found = len(set(r["latest_group"] for r in results if r["latest_group"]))

    return {
        "type": "listing_results",
        "total": total_count,
        "results": results[:limit],
        "grouped": grouped,
        "showing": len(results[:limit]),
        "offset": offset,
        "has_more": total_count > offset + limit,
        "remaining": max(0, total_count - offset - limit),
        "search_summary": {
            "total": total_count,
            "brokers": brokers_found,
            "buildings": buildings_found,
            "groups": groups_found,
        },
    }


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

    # Unnamed groups (no display name in source_sync_jobs)
    unnamed_count = storage.db.execute("""
        SELECT COUNT(*) FROM source_sync_jobs
        WHERE (group_name IS NULL OR group_name = '')
    """).fetchone()[0]

    attention_required = error_groups + inactive_count
    attention_breakdown = {
        "inactive": inactive_count,
        "duplicate": duplicate_groups,
        "unnamed": unnamed_count,
        "error": error_groups,
    }

    # Groups discovered (source_sync_jobs) vs monitored (have messages)
    groups_discovered = storage.db.execute(
        "SELECT COUNT(*) FROM source_sync_jobs WHERE group_id IS NOT NULL"
    ).fetchone()[0]
    groups_monitored = total_groups

    # Webhook healthy
    webhook_ok = last_msg is not None and last_msg >= five_min_ago

    # Capture health metrics
    failed_events = storage.db.execute(
        "SELECT COUNT(*) FROM enrichment_jobs WHERE status = 'failed'"
    ).fetchone()[0]
    pending_enrichment = storage.db.execute(
        "SELECT COUNT(*) FROM enrichment_jobs WHERE status = 'pending'"
    ).fetchone()[0]
    pending_ai = storage.db.execute(
        "SELECT COUNT(*) FROM ai_suggestions WHERE status = 'pending'"
    ).fetchone()[0]

    # Average processing time
    avg_process = storage.db.execute("""
        SELECT AVG(
            strftime('%s', p.created_at) - strftime('%s', r.created_at)
        ) FROM parsed_output p
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE p.created_at >= ?
    """, (day_ago,)).fetchone()[0]

    # Messages per minute today
    msgs_per_min = msgs_today / max(1, (datetime.utcnow().hour * 60 + datetime.utcnow().minute))

    # Parser success rate
    total_parsed_today = storage.db.execute(
        "SELECT COUNT(*) FROM parsed_output WHERE created_at >= ?", (today_start,)
    ).fetchone()[0]
    parser_success_rate = round((total_parsed_today / max(1, msgs_today)) * 100, 1) if msgs_today > 0 else 0

    return {
        # New header structure
        "whatsapp_session": "connected",  # would need actual session check
        "webhook_status": "live" if webhook_ok else "offline",
        "groups_discovered": groups_discovered,
        "groups_monitored": groups_monitored,
        # Legacy fields for compatibility
        "total_groups": total_groups,
        "live_groups": live_groups,
        "msgs_today": msgs_today,
        "last_webhook": last_msg or "never",
        "webhook_healthy": webhook_ok,
        "error_groups": error_groups,
        "duplicate_groups": duplicate_groups,
        "attention_required": attention_required,
        "attention_breakdown": attention_breakdown,
        "inactive_groups": inactive_count,
        "unnamed_groups": unnamed_count,
        "failed_events": failed_events,
        "pending_enrichment": pending_enrichment,
        "pending_ai_suggestions": pending_ai,
        "avg_process_secs": round(avg_process, 1) if avg_process else None,
        # New capture health metrics
        "msgs_per_min": round(msgs_per_min, 1),
        "parser_success_rate": parser_success_rate,
        "queue_backlog": pending_enrichment,
    }


@app.get("/api/audit/timeline")
async def audit_timeline(limit: int = 50):
    """Mixed operational events across the WhatsApp pipeline."""
    events = []
    day_ago = (datetime.utcnow() - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ")

    # Recent webhook messages (sample, not every message)
    raw_rows = storage.db.execute("""
        SELECT 'webhook' as source, created_at as ts, 'message' as subtype,
               group_name as group_jid, sender,
               'Message from ' || sender as label
        FROM raw_messages
        WHERE created_at >= ?
        ORDER BY created_at DESC
        LIMIT 20
    """, (day_ago,)).fetchall()
    for r in raw_rows:
        d = dict(r)
        d["ts"] = d.pop("ts")
        d["group_name"] = _group_jid_to_name(d.pop("group_jid"))
        events.append(d)

    # New groups discovered (first message from a new JID)
    new_group_rows = storage.db.execute("""
        SELECT 'group' as source, MIN(created_at) as ts, 'discovered' as subtype,
               group_name as group_jid, sender,
               'New group discovered' as label
        FROM raw_messages
        WHERE created_at >= ?
        GROUP BY group_name
        ORDER BY MIN(created_at) DESC
        LIMIT 10
    """, (day_ago,)).fetchall()
    for r in new_group_rows:
        d = dict(r)
        d["ts"] = d.pop("ts")
        d["group_name"] = _group_jid_to_name(d.pop("group_jid"))
        events.append(d)

    # Group renamed (groups with multiple display names)
    renamed_rows = storage.db.execute("""
        SELECT 'group' as source, MAX(updated_at) as ts, 'renamed' as subtype,
               group_id as group_jid, group_name,
               'Group renamed: ' || group_name as label
        FROM source_sync_jobs
        WHERE group_name != '' AND group_id IS NOT NULL
        GROUP BY group_id
        HAVING COUNT(DISTINCT group_name) > 1
        ORDER BY MAX(updated_at) DESC
        LIMIT 5
    """).fetchall()
    for r in renamed_rows:
        d = dict(r)
        d["ts"] = d.pop("ts")
        d["group_name"] = d.pop("group_name")
        events.append(d)

    # Duplicate group detected
    dupe_rows = storage.db.execute("""
        SELECT 'duplicate' as source, sj.updated_at as ts, 'detected' as subtype,
               sj.group_id as group_jid, sj.group_name,
               'Duplicate group detected: ' || sj.group_name as label
        FROM source_sync_jobs sj
        WHERE sj.group_name IN (
            SELECT group_name FROM source_sync_jobs
            WHERE group_name != '' AND group_name IS NOT NULL
            GROUP BY group_name HAVING COUNT(*) > 1
        )
        ORDER BY sj.updated_at DESC
        LIMIT 5
    """).fetchall()
    for r in dupe_rows:
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
        FROM enrichment_jobs ej ORDER BY ej.created_at DESC LIMIT 15
    """, (15,)).fetchall()
    for r in enrich_rows:
        events.append(dict(r))

    # AI suggestion events
    sug_rows = storage.db.execute("""
        SELECT 'suggestion' as source, created_at as ts, status as subtype,
               agent, title
        FROM ai_suggestions ORDER BY created_at DESC LIMIT 10
    """, (10,)).fetchall()
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

    # Parser restarts (enrichment worker cycles)
    restart_rows = storage.db.execute("""
        SELECT 'system' as source, created_at as ts, 'restart' as subtype,
               'Parser/enrichment worker restarted' as label
        FROM enrichment_jobs
        WHERE status = 'pending' AND attempts = 0
        ORDER BY created_at DESC LIMIT 3
    """).fetchall()
    for r in restart_rows:
        events.append(dict(r))

    # Live capture status changes (approximate from message gaps)
    # Sort by time descending, take top N
    events.sort(key=lambda e: e.get("ts", ""), reverse=True)
    return events[:limit]


@app.get("/api/audit/top-contributors")
async def audit_top_contributors(limit: int = 10):
    """Top WhatsApp groups by message volume today."""
    today_start = datetime.utcnow().strftime("%Y-%m-%dT00:00:00Z")

    rows = storage.db.execute("""
        SELECT group_name, COUNT(*) as msg_count,
               COUNT(DISTINCT sender) as unique_senders,
               MAX(created_at) as last_msg
        FROM raw_messages
        WHERE created_at >= ?
        GROUP BY group_name
        ORDER BY msg_count DESC
        LIMIT ?
    """, (today_start, limit)).fetchall()

    result = []
    for r in rows:
        d = dict(r)
        d["group_name"] = _group_jid_to_name(d["group_name"])
        d["last_msg"] = d["last_msg"] or "never"
        result.append(d)
    return result


@app.get("/api/audit/groups")
async def audit_groups(q: str = "", status: str = ""):
    """Group explorer with stats per group."""
    day_ago = (datetime.utcnow() - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ")
    week_ago = (datetime.utcnow() - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")

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

        # Active brokers (with parsed observations in last 7 days)
        active_brokers = storage.db.execute("""
            SELECT COUNT(DISTINCT p.broker_name) FROM parsed_output p
            JOIN raw_messages r ON r.id = p.raw_message_id
            WHERE r.group_name = ?
              AND p.broker_name IS NOT NULL AND p.broker_name != ''
              AND r.created_at >= ?
        """, (jid, week_ago)).fetchone()[0] or 0

        # Duplicate %: observations that are likely duplicates (same broker, bhk, price, micro_market seen elsewhere)
        dup_obs = storage.db.execute("""
            SELECT COUNT(*) FROM parsed_output p
            JOIN raw_messages r ON r.id = p.raw_message_id
            WHERE r.group_name = ?
              AND p.broker_name IS NOT NULL AND p.broker_name != ''
              AND p.bhk IS NOT NULL AND p.bhk != ''
              AND p.micro_market IS NOT NULL AND p.micro_market != ''
              AND EXISTS (
                  SELECT 1 FROM parsed_output p2
                  JOIN raw_messages r2 ON r2.id = p2.raw_message_id
                  WHERE r2.group_name != ?
                    AND p2.broker_name = p.broker_name
                    AND p2.bhk = p.bhk
                    AND p2.micro_market = p.micro_market
                    AND (p2.price IS NULL OR p2.price = p.price OR p.price IS NULL)
              )
        """, (jid, jid)).fetchone()[0] or 0
        dup_pct = round(dup_obs / max(1, (obs_info["obs_count"] if obs_info else 0)) * 100, 1)

        # Health score: live + has listings + low unknown locations
        is_live = last_ts and last_ts >= day_ago
        has_error = bool(j.error)
        if has_error:
            group_status = "error"
            health = "unhealthy"
        elif is_live and listing_count > 0 and unknown_locs == 0:
            group_status = "live"
            health = "healthy"
        elif is_live:
            group_status = "live"
            health = "degraded"
        else:
            group_status = "inactive"
            health = "stale"

        # Coverage
        total_obs = obs_info["obs_count"] if obs_info else 0
        resolved_obs = max(0, total_obs - unknown_locs)
        coverage = round(resolved_obs / total_obs * 100, 1) if total_obs > 0 else 0

        markets_str = obs_info["markets"] if obs_info and obs_info["markets"] else 0
        group_name = j.group_name or _group_jid_to_name(jid)

        g = {
            "jid": jid,
            "name": group_name,
            "status": group_status,
            "health": health,
            "error": j.error or "",
            "messages": msg_count,
            "last_activity": last_ts or "",
            "observations": total_obs,
            "listings": listing_count,
            "requirements": req_count,
            "markets_count": markets_str,
            "unknown_locations": unknown_locs,
            "coverage": coverage,
            "active_brokers": active_brokers,
            "duplicate_pct": dup_pct,
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

    # Messages per minute (today)
    total_msgs_today = storage.db.execute(
        "SELECT COUNT(*) FROM raw_messages WHERE created_at >= ?", (today_start,)
    ).fetchone()[0]
    mins_today = max(1, datetime.utcnow().hour * 60 + datetime.utcnow().minute)
    msgs_per_min = round(total_msgs_today / mins_today, 1)

    # Avg processing time
    avg_process = storage.db.execute("""
        SELECT AVG(strftime('%s', p.created_at) - strftime('%s', r.created_at))
        FROM parsed_output p
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE p.created_at >= ?
    """, (today_start,)).fetchone()[0]

    # Parser success rate today
    total_parsed = storage.db.execute(
        "SELECT COUNT(*) FROM parsed_output p JOIN raw_messages r ON r.id = p.raw_message_id WHERE r.created_at >= ?",
        (today_start,)
    ).fetchone()[0]
    parser_success_rate = round(total_parsed / max(1, total_msgs_today) * 100, 1) if total_msgs_today > 0 else 0

    # Queue backlog (pending enrichment + pending AI suggestions)
    pending_enrich = storage.db.execute(
        "SELECT COUNT(*) FROM enrichment_jobs WHERE status = 'pending'"
    ).fetchone()[0]
    pending_ai = storage.db.execute(
        "SELECT COUNT(*) FROM ai_suggestions WHERE status = 'pending'"
    ).fetchone()[0]
    queue_backlog = pending_enrich + pending_ai

    return {
        "msgs_per_min": msgs_per_min,
        "avg_process_secs": round(avg_process, 1) if avg_process else None,
        "parser_success_rate": parser_success_rate,
        "last_webhook": last_msg or "never",
        "queue_backlog": queue_backlog,
        "pending_enrichment": pending_enrich,
        "pending_ai_suggestions": pending_ai,
        "total_msgs_today": total_msgs_today,
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


# ── Legacy QR routes ─────────────────────────────────────────────

@app.get("/qr")
async def qr_page():
    return HTMLResponse(
        """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PropAI Connect</title>
  <style>
    body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0b0f14;color:#e2e8f0;display:grid;place-items:center;min-height:100vh;padding:24px}
    .card{max-width:640px;width:100%;border:1px solid rgba(255,255,255,.08);background:#0d1117;border-radius:18px;padding:24px}
    .muted{color:#94a3b8;line-height:1.6}
    a{color:#3ee88a;text-decoration:none;font-weight:600}
    .row{display:flex;gap:12px;flex-wrap:wrap;margin-top:20px}
    .btn{display:inline-block;padding:10px 14px;border-radius:10px;border:1px solid rgba(255,255,255,.1);color:#e2e8f0;text-decoration:none}
    .primary{background:#3ee88a;color:#04100a;border-color:#3ee88a}
  </style>
</head>
<body>
  <div class="card">
    <h1>Connect WhatsApp from the terminal</h1>
    <p class="muted">PropAI now uses Baileys for the live WhatsApp session. The browser does not generate QR codes anymore.</p>
    <p class="muted">Run <code>propai connect</code> in the project terminal, scan the QR there, then return to <a href="/connections">Connection Center</a>.</p>
    <div class="row">
      <a class="btn primary" href="/connections">Open Connection Center</a>
      <a class="btn" href="/">Go to App</a>
    </div>
  </div>
</body>
</html>"""
    )


@app.get("/qr/image")
async def qr_image():
    return {"error": "terminal_qr", "message": "Baileys QR is displayed in the terminal. Run 'propai connect'."}


@app.get("/connect")
async def connect_page():
    return {"status": "ok", "frontend": "http://localhost:3000/settings", "message": "Use the settings page at http://localhost:3000/settings to connect WhatsApp"}


# ── Entrypoint ──────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    from lab.config import HOST, PORT
    uvicorn.run("lab.app:app", host=HOST, port=PORT, reload=True)
