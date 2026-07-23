"""
Local Intelligence Lab — Webhook Receiver + Pipeline + Admin API.

Flow:
  WhatsApp ingestor webhook → save raw → parse → resolve → store → evaluate
"""
import json
import logging
import os
import sys
import asyncio

_logger = logging.getLogger(__name__)
import time
import httpx
import uuid
import re
import base64
import ast
import subprocess
import hmac
import jwt as pyjwt
import threading
from concurrent.futures import ThreadPoolExecutor
from fnmatch import fnmatch
from datetime import datetime, timedelta, timezone


# ── WhatsApp text sanitizer (post-process, unconditional safety net) ──────────
def sanitize_whatsapp_text(text: str) -> str:
    """Strip markdown/bullets/headers that the model shouldn't emit for WhatsApp."""
    if not isinstance(text, str):
        return str(text) if text is not None else ""
    # **bold** → bold
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
    # *italic* → italic
    text = re.sub(r"\*(.+?)\*", r"\1", text)
    # strip leading bullets (• or -)
    text = re.sub(r"^[•\-]\s+", "", text, flags=re.M)
    # strip markdown headers (# ## ###)
    text = re.sub(r"^#{1,6}\s*", "", text, flags=re.M)
    return text.strip()


def _looks_like_echo_misfire(user_msg: str, assistant_msg: str, threshold: float = 0.6) -> bool:
    """Flag responses that substantially echo the user's own message back —
    a strong signal the model misclassified a data query as small talk."""
    if not user_msg:
        return False
    user_tokens = set(user_msg.lower().split())
    assistant_tokens = set(assistant_msg.lower().split())
    if not user_tokens:
        return False
    overlap = len(user_tokens & assistant_tokens) / len(user_tokens)
    return overlap >= threshold
from pathlib import Path
from typing import Optional
from contextlib import asynccontextmanager
from dataclasses import asdict

from fastapi import FastAPI, Request, HTTPException, Body, Depends, Query, Security, Header
from fastapi.responses import Response, StreamingResponse, FileResponse
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel


class ProfileUpdate(BaseModel):
    first_name: str
    last_name: str = ""
    email: str = ""
    city: str = ""

from storage import Storage, SupabaseStorage, RawMessage, ParsedObservation, ResolverDecision, Evaluation, LLMProvider, ProviderOutageEvent, set_tenant_id, get_tenant_id
from lab.embedding import create_engine, observation_text, pack_embedding, EmbeddingEngine
from lab import ai_chat_engine as chat_engine
from lab import multi_listing
from lab.location import parse_location
from lab.events import get_bus

# ── Bootstrap path to reuse evidence engine ─────────────────────
PROJECT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_DIR))

from lab.config import HOST, PORT, DOUBLEWORD_API_KEY, ENABLE_AI_PROMO, ENABLE_META_PUBLISHING, STATUS_FILE, SUPABASE_URL, SUPABASE_SERVICE_KEY, load_excluded_groups, save_excluded_groups, load_group_allowlist, save_group_allowlist
try:
    from lab.config import FRONTEND_URL
except ImportError:
    FRONTEND_URL = os.getenv("FRONTEND_URL", "https://app.propai.live")
from evidence.resolver import resolve, resolve_by_landmark, resolve_by_street
from evidence.parsers import parse as broker_parse

# ── Global storage (lazy-initialized, wired in lifespan) ────────
storage: Storage | None = None

# Keep webhook extraction off the request path without allowing message bursts
# to create an unbounded number of threads that starve API health/auth routes.
_EXTRACTION_WORKERS = max(1, int(os.getenv("WEBHOOK_EXTRACTION_WORKERS", "8")))
_EXTRACTION_PENDING_LIMIT = max(
    _EXTRACTION_WORKERS,
    int(os.getenv("WEBHOOK_EXTRACTION_PENDING_LIMIT", "64")),
)
_EXTRACTION_EXECUTOR = ThreadPoolExecutor(
    max_workers=_EXTRACTION_WORKERS,
    thread_name_prefix="propai-extract",
)
_EXTRACTION_SLOTS = threading.BoundedSemaphore(_EXTRACTION_PENDING_LIMIT)

# ── Media storage for listing photos ──────────────────────────
MEDIA_DIR = PROJECT_DIR / "media" / "listing_photos"
MEDIA_DIR.mkdir(parents=True, exist_ok=True)

PIC_TOKEN_RE = re.compile(r'\bPIC-(\d+)-([A-F0-9]+)\b')

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

    phone_candidate_re = re.compile(r'(?:\+?91[\s-]*)?[6-9](?:[\s-]*\d){9}')

    def normalize_phone_candidate(value: str | None) -> str | None:
        digits = re.sub(r'\D+', '', value or '')
        if len(digits) == 12 and digits.startswith('91'):
            digits = digits[-10:]
        elif len(digits) == 11 and digits.startswith('0'):
            digits = digits[-10:]
        if len(digits) == 10 and re.match(r'^[6-9]\d{9}$', digits):
            return digits
        return None

    # Scan from bottom for signature patterns
    name = None
    phone = None
    for i in range(len(lines) - 1, -1, -1):
        line = lines[i]
        # Phone line
        phone_match = phone_candidate_re.search(line)
        normalized_phone = normalize_phone_candidate(phone_match.group(0) if phone_match else None)
        if normalized_phone and not phone:
            phone = normalized_phone
            continue
        # Name line — starts with uppercase word, not a phone/email/URL
        if not name and valid_signature_name(line):
            # Skip if it looks like a company name (ends with realty, prop, estate, etc.)
            if not any(kw in line.lower() for kw in ["realty", "property", "estate", "realtors", "consultancy", "enterprises", "ventures"]):
                name = re.sub(r'[*_`~]', '', line).strip(" -:")
    return name, phone


_CONTACT_RE = re.compile(
    r'(?:(?:contact|call|whatsapp)\s*[*]?)?'
    r'([A-Z][a-zA-Z]+(?: +[A-Z][a-zA-Z]+)*)'
    r'\s*[-:–]+\s*[*]?\+?\s*(\d{5}\s?\d{5}|\d{10})'
)

_EMOJI_CONTACT_RE = re.compile(
    r'📞\s*[*]?'
    r'(?:([A-Z][a-zA-Z]+(?: +[A-Z][a-zA-Z]+)*)\s*[-:–]?\s*[*]?\+?\s*)?'
    r'(\d{5}\s?\d{5}|\d{10})'
)

_NON_NAME_RE = re.compile(
    r'(?i)\b(?:for|inspection|details|contact|call|whatsapp|more|and|our|the|this|any|all|visit|connect|available|connect|price|rent|sale|bhk|sqft|floor)\b'
)

_CONTACT_NAME_BLACKLIST = {
    "for", "inspection", "details", "call", "contact", "whatsapp",
    "available", "price", "rent", "sale", "bhk",
}


def _is_valid_contact_name(name: str) -> bool:
    """Check if extracted name looks like a real person's name."""
    if len(name) < 2 or len(name) > 40:
        return False
    if _NON_NAME_RE.search(name):
        return False
    return True


def _extract_all_contacts(text: str) -> list[dict]:
    """Extract all name-phone contact pairs from a message body."""
    contacts: list[dict] = []
    seen_phones: set[str] = set()

    for m in _CONTACT_RE.finditer(text):
        name = m.group(1).strip()
        phone = m.group(2).replace(" ", "")
        if len(phone) != 10:
            continue
        if phone in seen_phones:
            continue
        if not _is_valid_contact_name(name):
            continue
        seen_phones.add(phone)
        contacts.append({"name": name, "phone": phone})

    for m in _EMOJI_CONTACT_RE.finditer(text):
        phone = m.group(2).replace(" ", "")
        if len(phone) != 10:
            continue
        if phone in seen_phones:
            continue
        seen_phones.add(phone)
        name = m.group(1).strip() if m.group(1) else ""
        if not _is_valid_contact_name(name):
            continue
        contacts.append({"name": name, "phone": phone})

    return contacts


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


# ── Knowledge Observation Extraction ─────────────────────────────

_BUILDING_WORDS = {"building", "tower", "wing", "phase", "house", "apartment", "residency", "enclave", "park", "heights", "vista", "gardens", "court", "plaza", "square", "manor", "estate", "villas", "towers", "complex", "society", "chsl", "co-operative"}

_LOCALITY_KEYWORDS = {"west", "east", "road", "market", "station", "colony", "village", "nagar", "gaon", "pada", "village", "junction", "cross", "link", "avenue", "street", "lane", "marg", "chardis", "circus"}


_ENTITY_ADJECTIVE_BLACKLIST = frozenset({
    "large", "small", "big", "huge", "tiny", "spacious", "compact",
    "luxurious", "beautiful", "lovely", "amazing", "stunning",
    "premium", "exclusive", "superior", "deluxe", "standard",
    "modern", "contemporary", "classic", "elegant",
    "converted", "conversion", "combined", "knocked", "merged",
    "new", "old", "brand", "ready", "semi", "fully",
    "higher", "lower", "front", "rear", "corner", "end",
    "road", "lane", "street", "avenue",
    "parking", "deck", "terrace", "balcony", "garden",
    "view", "open", "vastu",
    "available", "direct", "inventory",
    "urgent", "immediate", "negotiable", "affordable",
    "rare", "independent", "separate", "private",
    "west", "north", "south", "facing",
    "upper", "lower", "ground", "top", "middle", "basement",
    "good", "great", "best", "super", "top", "fine",
    "special", "exclusive", "sole",
    "owner", "selling", "sale", "rent", "rental",
    "call", "contact", "details", "price", "rate", "cost",
    "walking", "walkable",
    "with", "without", "for", "to", "from", "of", "by", "at", "in", "on",
    "and", "or", "the", "a", "an", "is", "has", "have", "are", "was",
    "this", "that", "these", "those", "it", "its", "all", "each", "every",
    "being", "been", "just", "only", "also", "very", "too",
    "more", "less", "most", "least", "some", "any", "no", "not",
    "up", "down", "out", "off", "over", "under", "through", "across",
    "along", "around", "about", "between", "among", "before", "after",
})

def _extract_entity_mentions(text: str) -> list[str]:
    """Extract potential entity names (buildings, localities) from conversation text."""
    if not text:
        return []
    candidates = set()
    # Find capitalized multi-word sequences that look like entity names
    for m in re.finditer(r'\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+)\b', text):
        phrase = m.group(1)
        lower = phrase.lower()
        words = lower.split()
        # Skip if it's clearly not an entity
        if re.search(r'(?i)\b(the|this|that|from|with|have|been|would|could|should|please|thanks|regards|sent|forward)\b', lower):
            continue
        if len(phrase) < 6:
            continue
        # Skip if every word is a blacklisted adjective
        if words and all(w in _ENTITY_ADJECTIVE_BLACKLIST for w in words):
            continue
        candidates.add(phrase)
    # Also find known building names from the listings table
    if storage is not None:
        try:
            known = storage.db.execute(
                "SELECT DISTINCT building_name FROM listings WHERE building_name IS NOT NULL AND building_name != '' LIMIT 500"
            ).fetchall()
            for row in known:
                bn = row["building_name"]
                if bn and bn.lower() in text.lower():
                    candidates.add(bn.strip())
        except Exception:
            pass
    return list(candidates)[:20]


def _merge_observation(
    entity_type: str,
    entity_name: str,
    observation_type: str,
    observation_text: str,
    broker_name: str,
    broker_phone: str,
    parsed_id: int | None,
    raw_id: int | None,
    now: str,
):
    """Merge an observation into knowledge_observations — update count if similar exists."""
    if storage is None:
        return
    norm_entity = entity_name.strip().lower()
    norm_type = observation_type.strip().lower()

    existing = storage.db.execute(
        """SELECT id, observation_count, observation_text
           FROM knowledge_observations
           WHERE LOWER(entity_name) = ? AND entity_type = ? AND observation_type = ?
             AND source_broker_phone = ?
           ORDER BY id DESC LIMIT 1""",
        (norm_entity, entity_type, norm_type, broker_phone or ""),
    ).fetchone()

    if existing:
        storage.db.execute(
            """UPDATE knowledge_observations
               SET observation_count = observation_count + 1,
                   observation_text = ?,
                   updated_at = ?,
                   source_parsed_id = ?,
                   source_raw_id = ?
               WHERE id = ?""",
            (observation_text, now, parsed_id, raw_id, existing["id"]),
        )
    else:
        confidence = 1
        _count_other_brokers = storage.db.execute(
            """SELECT COUNT(DISTINCT source_broker_phone) as c
               FROM knowledge_observations
               WHERE LOWER(entity_name) = ? AND entity_type = ? AND observation_type = ?
                 AND source_broker_phone IS NOT NULL AND source_broker_phone != ''""",
            (norm_entity, entity_type, norm_type),
        ).fetchone()
        if _count_other_brokers and _count_other_brokers["c"] >= 2:
            confidence = 3
        elif _count_other_brokers and _count_other_brokers["c"] >= 1:
            confidence = 2

        storage.db.execute(
            """INSERT INTO knowledge_observations
               (entity_type, entity_name, observation_type, observation_text,
                confidence, observation_count, source_broker_name, source_broker_phone,
                source_parsed_id, source_raw_id, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)""",
            (entity_type, entity_name.strip(), norm_type, observation_text,
             confidence, broker_name, broker_phone or "", parsed_id, raw_id, now, now),
        )


def _get_relevant_observations(entity_names: list[str], limit: int = 10) -> list[dict]:
    """Fetch observations relevant to the given entity names, sorted by confidence."""
    if not entity_names or storage is None:
        return []
    placeholders = ",".join("?" for _ in entity_names)
    lower_names = [n.strip().lower() for n in entity_names]
    rows = storage.db.execute(
        f"""SELECT entity_type, entity_name, observation_type, observation_text,
                   confidence, observation_count, source_broker_name
            FROM knowledge_observations
            WHERE LOWER(entity_name) IN ({placeholders})
            ORDER BY confidence DESC, observation_count DESC
            LIMIT ?""",
        (*lower_names, limit),
    ).fetchall()
    return [dict(r) for r in rows]


_FURNISHING_CANONICAL_PATTERNS = [
    (re.compile(r'\b(fully\s+furnished|full\s+furnished|fully\s+fur|f\s*/\s*f|ff)\b', re.I), "fully_furnished"),
    (re.compile(r'\b(semi\s+furnished|semi\s+fur|s\s*/\s*f|sf)\b', re.I), "semi_furnished"),
    (re.compile(r'\b(unfurnished|un\s*furnished|u\s*/\s*f|uf)\b', re.I), "unfurnished"),
    (re.compile(r'\b(plug\s*&\s*play|plug\s+and\s+play)\b', re.I), "plug_and_play"),
    (re.compile(r'\b(bare\s+shell)\b', re.I), "bare_shell"),
]


def _normalize_furnishing_canonical(text: str) -> str | None:
    for pattern, canonical in _FURNISHING_CANONICAL_PATTERNS:
        if pattern.search(text):
            return canonical
    return None


def _infer_transaction_type(text: str, intent: str | None = None) -> str | None:
    """
    Infer transaction type from intent primarily, then text keywords.
    Intent is more reliable than keyword matching.
    """
    # Intent-based inference (most reliable)
    if intent == "RENT":
        return "rent"
    if intent == "LEASE":
        return "lease"
    if intent == "SELL":
        return "sale"
    if intent == "BUY":
        return "sale"  # buyer requirement = sale listing
    if intent == "COMMERCIAL":
        # For commercial, check text for rent vs sale
        lower = text.lower()
        if re.search(r'\b(for\s+rent|rent|rental|on\s+rent|for\s+lease|on\s+lease)\b', lower):
            return "rent"
        if re.search(r'\b(lease)\b', lower):
            return "lease"
        return "sale"
    
    # Fallback: keyword-based (legacy behavior)
    lower = text.lower()
    if re.search(r'\b(for\s+rent|rent|rental|on\s+rent|for\s+lease|on\s+lease)\b', lower):
        return "rent"
    if re.search(r'\b(lease)\b', lower):
        return "lease"
    if re.search(r'\b(for\s+sale|sale|sell|selling|resale)\b', lower):
        return "sale"
    return None


def _infer_asset_and_property_type(text: str, intent: str | None) -> tuple[str | None, str | None]:
    lower = text.lower()
    commercial_hint = bool(_RE.search(r'\b(commercial|office|shop|showroom|warehouse|godown|retail)\b', lower))
    # If commercial hint present, force commercial regardless of intent
    if intent == "COMMERCIAL" or commercial_hint:
        if "office" in lower:
            return "commercial", "office"
        if "showroom" in lower:
            return "commercial", "showroom"
        if "shop" in lower or "retail" in lower:
            return "commercial", "shop"
        if "warehouse" in lower:
            return "commercial", "warehouse"
        if "godown" in lower:
            return "commercial", "godown"
        if "bare shell" in lower:
            return "commercial", "bare_shell"
        if "plug and play" in lower or "plug & play" in lower:
            return "commercial", "plug_and_play"
        return "commercial", "other"

    if "villa" in lower or "bungalow" in lower:
        return "residential", "villa"
    if "plot" in lower or "land" in lower:
        return "residential", "plot"
    if "independent house" in lower or "independent home" in lower or "independent" in lower:
        return "residential", "independent_house"
    if "studio" in lower:
        return "residential", "studio"
    if "duplex" in lower:
        return "residential", "duplex"
    if "penthouse" in lower:
        return "residential", "penthouse"
    if "jodi" in lower:
        return "residential", "jodi"
    if _RE.search(r'\bflat\b|\bapartment\b|\bhome\b', lower) or _RE.search(r'\d+(?:\.\d+)?\s*bhk', lower):
        return "residential", "apartment"
    return "residential", None


def _extract_timing_fields(text: str) -> dict:
    lower = text.lower()
    result = {
        "availability_status": None,
        "possession_status": None,
        "possession_date": None,
        "available_from": None,
        "ready_by": None,
        "construction_stage": None,
        "launch_timeline": None,
        "expected_possession": None,
    }

    available_from_m = re.search(r'(?im)\bavailable\s+from\b\s*[:\-]?\s*(.+)$', text)
    if available_from_m:
        raw = available_from_m.group(1).strip().strip("*_`~ ")
        if raw:
            result["available_from"] = raw
            result["availability_status"] = "coming_soon"
            result["possession_status"] = "Coming Soon"

    possession_m = re.search(r'(?im)\bpossession\b\s*[:\-]?\s*(.+)$', text)
    if possession_m:
        raw = possession_m.group(1).strip().strip("*_`~ ")
        if raw:
            result["possession_date"] = raw
            result["expected_possession"] = raw
            result["construction_stage"] = "under_construction"
            result["availability_status"] = result["availability_status"] or "under_construction"
            result["possession_status"] = result["possession_status"] or "Under Construction"

    if re.search(r'\bunder\s+construction\b', lower):
        result["availability_status"] = result["availability_status"] or "under_construction"
        result["construction_stage"] = result["construction_stage"] or "under_construction"
        result["possession_status"] = result["possession_status"] or "Under Construction"
    elif re.search(r'\bpre[-\s]?launch\b|\bnew\s+launch\b|\bupcoming\s+project\b', lower):
        result["availability_status"] = result["availability_status"] or "coming_soon"
        result["construction_stage"] = result["construction_stage"] or "pre_launch"
        result["possession_status"] = result["possession_status"] or "Coming Soon"
    elif re.search(r'\bready\s+to\s+move\b|\bimmediate\s+possession\b|\bready\b', lower):
        result["availability_status"] = result["availability_status"] or "available"
        result["construction_stage"] = result["construction_stage"] or "ready"
        result["possession_status"] = result["possession_status"] or "Ready"

    if re.search(r'\bavailable\b', lower) and not result["availability_status"]:
        result["availability_status"] = "available"
        result["possession_status"] = "Available"

    ready_by_m = re.search(r'(?im)\bready\s+by\b\s*[:\-]?\s*(.+)$', text)
    if ready_by_m:
        raw = ready_by_m.group(1).strip().strip("*_`~ ")
        if raw:
            result["ready_by"] = raw
            result["availability_status"] = result["availability_status"] or "coming_soon"

    return result


def _extract_price_per_sqft(text: str) -> float | None:
    patterns = [
        r'(?i)(?:rate|price|asking(?:\s+price)?|rent|cost)\s*[:\-]?\s*(?:rs\.?\s*|inr\s*|₹)?\s*([\d,]+(?:\.\d+)?)\s*(?:\/-\s*)?(?:psf|psft|per\s+sq\.?\s*ft|per\s+sqft|per\s+square\s+foot)\b',
        r'(?i)(?:rs\.?\s*|inr\s*|₹)?\s*([\d,]+(?:\.\d+)?)\s*(?:\/-\s*)?(?:psf|psft|per\s+sq\.?\s*ft|per\s+sqft|per\s+square\s+foot)\b',
    ]
    for pattern in patterns:
        m = re.search(pattern, text)
        if m and m.group(1).strip():
            try:
                return float(m.group(1).replace(",", ""))
            except ValueError:
                continue
    return None


def _infer_commercial_use_type(text: str) -> str | None:
    lower = text.lower()
    if "office" in lower:
        return "office"
    if "showroom" in lower or "flagship" in lower:
        return "showroom"
    if "shop" in lower or "retail" in lower:
        return "shop"
    if "warehouse" in lower:
        return "warehouse"
    if "godown" in lower:
        return "godown"
    return None


def _infer_fitout_status(text: str, furnishing: str | None = None) -> str | None:
    lower = text.lower()
    if furnishing:
        f = furnishing.lower()
        if "fully" in f:
            return "fully_furnished"
        if "semi" in f:
            return "semi_furnished"
        if "unfurnished" in f:
            return "bare_shell"
    if re.search(r'\bplug\s*&\s*play\b|\bplug\s+and\s+play\b', lower):
        return "plug_and_play"
    if "warm shell" in lower or "warmshell" in lower or "warmshell" in lower:
        return "warm_shell"
    if re.search(r'\bbare\s*shell\b', lower):
        return "bare_shell"
    if re.search(r'\bfully\s+furnished\b|\bfully\s+fur\b|\bff\b', lower):
        return "fully_furnished"
    if re.search(r'\bsemi\s+furnished\b|\bsemi\s+fur\b|\bsf\b', lower):
        return "semi_furnished"
    return None


def _infer_occupancy_type(text: str) -> str | None:
    lower = text.lower()
    if re.search(r'\bunder\s+construction\b', lower):
        return "under_construction"
    if re.search(r'\boccupied\b', lower):
        return "occupied"
    if re.search(r'\bvacant\b|\bempty\b', lower):
        return "vacant"
    if re.search(r'\bready\s+to\s+move\b|\bimmediate\s+possession\b', lower):
        return "vacant"
    return None


def parse_message(raw_text: str, profile_name: str | None = None) -> dict:
    """
    Parse a WhatsApp message into structured fields.
    Broker-first extraction with intent/principal separation.
    """
    # Pre-process: normalize emoji, abbreviations, formatting
    from normalize import preprocess_for_parsing, normalize_whatsapp_message
    text = preprocess_for_parsing(raw_text)
    lower = text.lower()
    # Also get full normalization result for metadata
    normalized_result = normalize_whatsapp_message(raw_text)
    result = {
        "intent": None,
        "principal": None,
        "bhk": None,
        "configuration": None,
        "price": None,
        "price_unit": None,
        "price_model": None,
        "price_per_sqft": None,
        "monthly_rent": None,
        "total_asking_price": None,
        "area_sqft": None,
        "furnishing": None,
        "furnishing_canonical": None,
        "location_raw": None,
        "building_name": None,
        "landmark_name": None,
        "street_name": None,
        "area": None,
        "micro_market": None,
        "developer": None,
        "asset_type": None,
        "property_type": None,
        "transaction_type": None,
        "commercial_use_type": None,
        "fitout_status": None,
        "occupancy_type": None,
        "floor_range": None,
        "rent_per_sqft": None,
        "availability_status": None,
        "possession_status": None,
        "possession_date": None,
        "available_from": None,
        "ready_by": None,
        "construction_stage": None,
        "launch_timeline": None,
        "expected_possession": None,
        "deposit": None,
        "lock_in_period": None,
        "notice_period": None,
        "lease_term": None,
        "recurring_charges": None,
        "freehold_status": None,
        "oc_status": None,
        "broker_name": None,
        "broker_phone": None,
        "forwarded": 0,
        "confidence": 0.0,
        "raw_payload": {},
        "normalized_message": normalized_result["cleaned"],
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
    commercial_text = _RE.sub(r'\bpost\s+office\b', ' ', lower)
    is_commercial = bool(_RE.search(r'\b(commercial|office|shop|showroom|warehouse|godown|retail)\b', commercial_text))
    is_sell = bool(_RE.search(r'\b(sale|sell|selling|available|ready to move|resale|for sale)\b', lower))
    is_buy = bool(_RE.search(r'\b(buy|buyer|purchase|wanted|require|need|looking for|seeking|requirement)\b', lower))

    if is_pre_launch:
        result["intent"] = "PRE-LAUNCH"
    elif is_buy:
        result["intent"] = "BUY"
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
        result["intent"] = None

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

    # ── 3b. Extract all team member contacts ────────────────────────
    all_contacts = _extract_all_contacts(text)
    # Filter: exclude contacts without a name (likely broker restating own number),
    # and exclude the broker's own phone if known
    broker_phone_clean = (result.get("broker_phone") or "").replace(" ", "")
    result["team_members"] = [
        c for c in all_contacts
        if c.get("name") and c["phone"] != broker_phone_clean
    ]

    # ── 4. Forwarded ─────────────────────────────────────────────
    if _RE.search(r'\b(forwarded|fw[d]?[:.]?|from:|shared by|sent by)\b', lower):
        result["forwarded"] = 1

# ── 5. Extract BHK ──────────────────────────────────────────
    bhk_match = _RE.search(r'(\d+(?:\.\d+)?)\s*(bhk|rk|bedroom|b ed|b e d)', lower)
    if bhk_match:
        result["bhk"] = bhk_match.group(1) + " BHK"
    elif _RE.search(r'\b(studio)\b', lower):
        result["bhk"] = "Studio"

    # Clear BHK for commercial intent early (before asset type inference)
    if result.get("intent") == "COMMERCIAL":
        result["bhk"] = None

    # ── 5b. Residential/commercial schema map ───────────────────
    asset_type, property_type = _infer_asset_and_property_type(text, result.get("intent"))
    result["asset_type"] = asset_type
    result["property_type"] = property_type
    result["transaction_type"] = _infer_transaction_type(text)
    result["configuration"] = result.get("bhk")
    if result["asset_type"] == "commercial":
        result["configuration"] = None
        # Ensure BHK is cleared for commercial asset type too
        result["bhk"] = None

    # ── 6. Extract price — with ambiguous-shorthand guard ─────────
    # Normalize broker "colon-decimal" typos like "3:00 cr" → "3.00 cr" so the
    # price regex doesn't match the trailing "00" as a standalone ₹0 amount.
    text = re.sub(
        r"(\d)\s*:\s*(\d+)\s*(cr|crore|lac|lakh|l|lacs|lakhs|k|thousand)\b",
        lambda m: f"{m.group(1)}.{m.group(2)} {m.group(3)}",
        text,
        flags=re.I,
    )
    lower = text.lower()

    price_from_explicit_line = False
    if result["price"] is None:
        explicit_price_line = None
        for raw_line in text.splitlines():
            line = sanitize_whatsapp_text(raw_line).strip()
            if not line:
                continue
            if not re.search(r'\b(?:rent|rental|asking\s+price)\b', line, re.I):
                continue
            explicit_price_line = _RE.search(
                r'(?i)\b(?:rent|rental|asking\s+price)\b\s*[:\-]\s*'
                r'(?:rs\.?\s*|inr\s*|₹)?\s*([\d,]+(?:\.\d+)?)\s*'
                r'(cr|crore|lacs?|lakhs?|l|k|thousand)?\b',
                line,
            )
            if explicit_price_line:
                break
        if explicit_price_line:
            amount = float(explicit_price_line.group(1).replace(",", ""))
            unit_raw = (explicit_price_line.group(2) or "").lower().rstrip("s")
            if unit_raw in ("cr", "crore"):
                result["price"] = amount
                result["price_unit"] = "Cr"
            elif unit_raw in ("lac", "lakh", "l"):
                result["price"] = amount
                result["price_unit"] = "Lac"
            elif unit_raw in ("k", "thousand"):
                result["price"] = amount
                result["price_unit"] = "K"
            else:
                if amount >= 100000:
                    result["price"] = round(amount / 100000, 2)
                    result["price_unit"] = "Lac"
                else:
                    result["price"] = amount
                    result["price_unit"] = "abs"
            price_from_explicit_line = True

    # Check for broker shorthand "X.XX,/YY unit" before standard regex
    ambiguous_m = re.search(
        r'(\d+\.\d+)\s*,?\s*/\s*(\d{1,2})\s*'
        r'(cr|crore|lac|lakh|l|lacs|lakhs|k|thousand)\b',
        text, re.I,
    )
    if ambiguous_m:
        first = float(ambiguous_m.group(1))
        second = int(ambiguous_m.group(2))
        if first >= 0.1 and 1 <= second <= 99:
            shorthand = ambiguous_m.group(0).strip()
            system = (
                "You are a price normalizer for Indian real estate WhatsApp messages. "
                "Brokers write shorthands like '2.25,/50 cr' meaning price range 2.25 Cr to 2.50 Cr "
                "(the 50 after the slash is the decimal continuation: .50). "
                "Return ONLY a JSON object with these exact keys: price_min, price_max, unit. "
                "No markdown, no explanation, no code fences. "
                'Example: {"price_min": 2.25, "price_max": 2.5, "unit": "Cr"}'
            )
            prompt = f"Parse this broker price shorthand: {shorthand}"
            for retry in range(2):
                try:
                    from app import _ai_promote
                    ai_result = _ai_promote(system, prompt)
                    if ai_result:
                        clean = ai_result.strip()
                        if clean.startswith("```"):
                            start = clean.find("{")
                            end = clean.rfind("}")
                            if start >= 0 and end > start:
                                clean = clean[start:end + 1]
                        parsed = json.loads(clean)
                        pmin = parsed.get("price_min")
                        pmax = parsed.get("price_max")
                        unit_raw = (parsed.get("unit") or "").lower().rstrip("s")
                        if pmin is not None and pmax is not None and 0 < pmin <= pmax:
                            if unit_raw in ("cr", "crore"):
                                result["price"] = pmax
                                result["price_unit"] = "Cr"
                            elif unit_raw in ("lac", "lakh", "l"):
                                result["price"] = pmax
                                result["price_unit"] = "Lac"
                            elif unit_raw in ("k", "thousand"):
                                result["price"] = pmax
                                result["price_unit"] = "K"
                            break
                except Exception:
                    pass
                if retry == 0:
                    import time
                    time.sleep(3)

    if result.get("price") is None and not price_from_explicit_line:
        price_match = _RE.search(
            r'(?:rs\.?\s*|inr\s*|₹)?\s*([\d,]+(?:\.\d+)?)\s*(cr|crore|lacs?|lakhs?|l|k|thousand)\b',
            lower,
        )
        if price_match and price_match.group(1).strip():
            try:
                amount = float(price_match.group(1).replace(",", ""))
            except ValueError:
                amount = None
            if amount and amount > 0:
                unit_raw = price_match.group(2).lower()
                unit_raw = unit_raw.rstrip("s")
                if unit_raw in ("cr", "crore"):
                    result["price"] = amount
                    result["price_unit"] = "Cr"
                elif unit_raw in ("lac", "lakh", "l"):
                    result["price"] = amount
                    result["price_unit"] = "Lac"
                elif unit_raw in ("k", "thousand"):
                    result["price"] = amount
                    result["price_unit"] = "K"
        else:
            abs_match = _RE.search(
                r'(?:rs\.?\s*|inr\s*|₹)\s*([\d,]+(?:\.\d+)?)',
                lower,
            )
            if abs_match and abs_match.group(1).strip():
                try:
                    amount = float(abs_match.group(1).replace(",", ""))
                except ValueError:
                    amount = None
                if amount and amount > 0:
                    result["price"] = amount
                    result["price_unit"] = "abs"

    price_per_sqft = _extract_price_per_sqft(text)
    if price_per_sqft is not None:
        result["price_per_sqft"] = price_per_sqft
        result["price_model"] = "psf"
    elif result.get("price") is not None:
        result["price_model"] = "total"

    # Sanity check: if tagged as rent but price is absurdly high (>= 1 Cr),
    # it's almost certainly a sale price mis-tagged. Flip to sale.
    if result.get("transaction_type") == "rent" and result.get("price") is not None:
        unit = (result.get("price_unit") or "").lower()
        price_val = result["price"]
        # Convert to absolute rupees
        if unit in ("cr", "crore", "crores"):
            price_inr = price_val * 1_00_00_000
        elif unit in ("lac", "lakh", "lakhs", "l"):
            price_inr = price_val * 1_00_000
        elif unit in ("k", "thousand"):
            price_inr = price_val * 1_000
        else:
            price_inr = price_val
        # Any Mumbai rent >= 1 Cr is data error (top luxury ~15-20L/month)
        if price_inr >= 1_00_00_000:
            result["transaction_type"] = "sale"

    if result["asset_type"] == "commercial":
        result["commercial_use_type"] = _infer_commercial_use_type(text)
        result["fitout_status"] = _infer_fitout_status(text, result.get("furnishing"))
        result["occupancy_type"] = _infer_occupancy_type(text)
        result["floor_range"] = result.get("floor_range") or None
        if result.get("price_per_sqft") is not None:
            result["rent_per_sqft"] = result["price_per_sqft"]

    # ── 7. Extract area sqft ────────────────────────────────────
    area_match = _RE.search(r'(\d+[\d,]*)\s*(sq\.?\s*ft|sqft|sft|sq\s*feet)', lower)
    if area_match and area_match.group(1).strip():
        result["area_sqft"] = float(area_match.group(1).replace(",", ""))

    # ── 8. Furnishing ───────────────────────────────────────────
    if (
        _RE.search(r'\bfully\s+furnished\b|\bfully\s+fur\b', lower)
        or _RE.search(r'(?<![a-z0-9])f\s*/\s*f(?![a-z0-9])|(?<![a-z0-9])ff(?![a-z0-9])', lower)
    ):
        result["furnishing"] = "Fully Furnished"
    elif (
        _RE.search(r'\bsemi\s+furnished\b|\bsemi\s+fur\b', lower)
        or _RE.search(r'(?<![a-z0-9])s\s*/\s*f(?![a-z0-9])|(?<![a-z0-9])sf(?![a-z0-9])', lower)
    ):
        result["furnishing"] = "Semi Furnished"
    elif (
        _RE.search(r'\bun\s*-?\s*furnished\b|\bun\s+furn\b', lower)
        or _RE.search(r'(?<![a-z0-9])u\s*/\s*f(?![a-z0-9])|(?<![a-z0-9])uf(?![a-z0-9])', lower)
    ):
        result["furnishing"] = "Unfurnished"
    result["furnishing_canonical"] = _normalize_furnishing_canonical(text) or _normalize_furnishing_canonical(result.get("furnishing") or "")

    timing_fields = _extract_timing_fields(text)
    result.update(timing_fields)
    if result.get("transaction_type") == "rent" and result.get("price") is not None:
        result["monthly_rent"] = result["price"]
    elif result.get("transaction_type") == "sale" and result.get("price") is not None:
        result["total_asking_price"] = result["price"]
    elif result.get("transaction_type") == "lease" and result.get("price") is not None:
        result["monthly_rent"] = result["price"]

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
            # Only use raw as landmark if it looks like a real entity
            # (contains at least one capitalized word that is not pure noise)
            raw_words = loc.raw.split()
            has_proper_entity = any(
                w[0].isupper() and w.lower() not in {
                    "large", "small", "big", "new", "old", "converted",
                    "available", "spacious", "luxury", "premium", "beautiful",
                    "good", "great", "best", "top", "super", "fine",
                    "upper", "lower", "upper", "ground", "top", "middle",
                    "front", "rear", "corner", "end", "direct",
                    "urgent", "immediate", "ready", "brand", "fully",
                    "semi", "unfurnished", "furnished", "negotiable",
                    "affordable", "exclusive", "special", "rare",
                    "independent", "private", "separate",
                    "with", "for", "to", "from", "of", "by", "at", "in", "on",
                    "and", "or", "the", "a", "an", "is", "has", "have",
                    "this", "that", "it", "its", "all", "each", "every",
                    "just", "only", "also", "very", "too",
                    "more", "less", "some", "any", "no", "not",
                    "up", "down", "out", "off", "over", "under", "through",
                    "along", "around", "about", "between", "before", "after",
                }
                for w in raw_words
            )
            if has_proper_entity:
                result["landmark_name"] = loc.raw
        if loc.building:
            result["building_name"] = loc.building
        # Fallback: "Building Name X" or "Building: X" pattern
        if not result["building_name"]:
            bm = _RE.search(
                r'(?:building\s*name\s*[:.]?\s*|building\s*[:.]?\s+|project\s*[:.]?\s+|complex\s*[:.]?\s+)'
                r'([A-Z][A-Za-z0-9][A-Za-z0-9 .&\'\-/]{2,})',
                text,
                _RE.I,
            )
            if bm:
                candidate = bm.group(1).strip().rstrip("., ")
                # Don't capture across newlines
                candidate = candidate.split("\n")[0].strip()
                if len(candidate) >= 4 and not _RE.search(r'\b(rent|sale|bhk|sqft|price|call|contact|carpet|built.?up|super\s+area|plot\s+area|road\s+facing|modular|gas\s+pipeline| floor | storey | wing | tower)\b', candidate, _RE.I):
                    result["building_name"] = candidate
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
    # Store normalized version for search/indexing
    from normalize import preprocess_for_parsing
    result["normalized_message"] = preprocess_for_parsing(raw_text)
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
        "micro_market": parsed.get("micro_market"),
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
            b_area = None
            for cname, info in buildings.items():
                if info["building_id"] == bid:
                    b_name = info["canonical_name"]
                    b_area = info.get("area")
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
                "micro_market": b_area or area or None,
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
            result["micro_market"] = winner.get("micro_market") or result.get("micro_market")
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
    using_supabase = bool(SUPABASE_URL and SUPABASE_SERVICE_KEY)
    if not using_supabase:
        raise RuntimeError("Supabase is required. Set SUPABASE_URL and SUPABASE_SERVICE_KEY.")
    print(f"  Using Supabase backend: {SUPABASE_URL}")
    storage = SupabaseStorage(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    try:
        print("  Supabase schema managed by migrations — skipping local init")
    except Exception as exc:
        print(f"  Listings rebuild skipped: {exc}")
    # Auto-generate API key if missing
    key_path = Path(__file__).parent / ".api_key"
    if not key_path.exists():
        new_key = str(uuid.uuid4())
        key_path.write_text(new_key)
        print(f"  Generated API key: {new_key}")
    if SUPABASE_JWT_SECRET:
        print(f"  Lab DB: {SUPABASE_URL}")
    else:
        print(f"  Lab DB: {SUPABASE_URL}")
    if _jwks_client:
        print(f"  [auth] JWKS client ready — verifying ES256 tokens from {SUPABASE_URL}")
    else:
        print("  [auth] WARNING: JWKS client NOT initialized — auth disabled")
    print(f"  Webhook: http://localhost:{PORT}/webhook")
    print(f"  Admin:   http://localhost:{PORT}/")
    # Provider probe loop: hits every configured LLM provider every 60s and
    # writes results to provider_outage_log. Feeds /admin/providers.
    provider_probe_task = asyncio.create_task(_provider_probe_loop())
    print("  Provider probe loop started (60s cadence)")
    backfill_task = asyncio.create_task(_history_backfill_loop())
    print("  History backfill loop started (6h cadence)")
    yield
    backfill_task.cancel()
    try:
        await backfill_task
    except (asyncio.CancelledError, Exception):
        pass
    provider_probe_task.cancel()
    try:
        await provider_probe_task
    except (asyncio.CancelledError, Exception):
        pass

app = FastAPI(
    title="PropAI Local Intelligence Lab",
    version="0.1.0",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
)

# ElevenLabs agent webhooks use the same raw-message → extraction path as
# WhatsMeow/WABA ingestion.  Mounting the router here makes its documented
# endpoints real rather than a dead, separately-maintained module.
from business_api import router as business_api_router
app.include_router(business_api_router)


# ── Global error handler for debugging ───────────────────────────
@app.exception_handler(Exception)
async def global_exception_handler(request, exc):
    import traceback
    tb = traceback.format_exc()
    print(f"[global] unhandled: {exc}\n{tb}", flush=True)
    return JSONResponse(
        status_code=500,
        content={"error": str(exc)[:500], "line": tb.splitlines()[-3] if len(tb.splitlines()) >= 3 else ""},
    )


# ── Webhook ─────────────────────────────────────────────────────

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
    "GROUPS_REFRESHED": "group",
    "CONVERSATIONS_UPSERT": "conversation",
    "presence.update": "presence",
    "call": "call",
}

def _classify_webhook_event(event: str, data: dict) -> str:
    """Classify a webhook event into a pipeline category."""
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
    return base


def _whatsapp_message_text(msg: dict) -> str:
    """Keep every supported WhatsApp message in the raw stream, even without a caption."""
    return (
        msg.get("conversation", "")
        or (msg.get("extendedTextMessage") or {}).get("text", "")
        or (msg.get("imageMessage") or {}).get("caption", "")
        or (msg.get("videoMessage") or {}).get("caption", "")
        or (msg.get("documentMessage") or {}).get("caption", "")
        or (msg.get("documentMessage") or {}).get("fileName", "")
        or ("[Voice message]" if msg.get("audioMessage") else "")
        or ("[Image]" if msg.get("imageMessage") else "")
        or ("[Video]" if msg.get("videoMessage") else "")
        or ("[Document]" if msg.get("documentMessage") else "")
        or ("[Sticker]" if msg.get("stickerMessage") else "")
        or ""
    )


def _whatsapp_message_type(msg: dict) -> str:
    for message_type in ("image", "video", "audio", "document", "sticker"):
        if msg.get(f"{message_type}Message"):
            return message_type
    return "text"


def _whatsapp_attachment_metadata(msg: dict, media: dict | None = None) -> dict:
    media = media or {}
    typed = next(
        (msg.get(f"{kind}Message") or {} for kind in ("image", "video", "audio", "document", "sticker")
         if msg.get(f"{kind}Message")),
        {},
    )
    return {
        "image": bool(msg.get("imageMessage")),
        "video": bool(msg.get("videoMessage")),
        "audio": bool(msg.get("audioMessage")),
        "document": bool(msg.get("documentMessage")),
        "sticker": bool(msg.get("stickerMessage")),
        "mime_type": typed.get("mimetype", ""),
        "file_name": (msg.get("documentMessage") or {}).get("fileName", ""),
        "storage_path": media.get("storage_path", ""),
        "file_length": media.get("file_length"),
        "capture_error": media.get("error", ""),
    }


def _is_blocked_whatsapp_conversation(jid: str) -> bool:
    jid = (jid or "").strip().lower()
    return (
        not jid
        or jid == "status@broadcast"
        or jid == "broadcast"
        or jid.endswith("@broadcast")
        or jid.endswith("@newsletter")
    )


def _coerce_whatsapp_timestamp(value) -> str:
    if value in (None, ""):
        return ""
    try:
        if isinstance(value, str):
            stripped = value.strip()
            if not stripped:
                return ""
            if re.fullmatch(r"\d+(?:\.\d+)?", stripped):
                value = float(stripped)
            else:
                parsed = datetime.fromisoformat(stripped.replace("Z", "+00:00"))
                return parsed.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        if isinstance(value, (int, float)):
            seconds = float(value)
            if seconds > 10_000_000_000:
                seconds = seconds / 1000
            return datetime.fromtimestamp(seconds, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except Exception:
        return ""
    return ""


_REAL_ESTATE_SIGNAL_RE = re.compile(
    r"\b("
    r"bhk|rk|bed(?:room)?|flat|apartment|office|shop|showroom|warehouse|godown|"
    r"retail|commercial|carpet|built\s*up|sq\.?\s*ft|sqft|sft|floor|parking|"
    r"society|chsl|tower|building|project|villa|bungalow|duplex|penthouse|plot|"
    r"land|tenant|landlord|possession|pre\s*launch"
    r")\b",
    re.IGNORECASE,
)
_REAL_ESTATE_ACTION_RE = re.compile(
    r"\b("
    r"sale|sell|selling|resale|available|rent|rental|lease|leased|buyer|buy|"
    r"purchase|wanted|require|requirement|looking\s+for|need|seeking"
    r")\b",
    re.IGNORECASE,
)
_NON_REAL_ESTATE_TOPIC_RE = re.compile(
    r"\b("
    r"stock|stocks|share|shares|equity|trading|investing|investor|wealth\s+creation|"
    r"mutual\s+fund|nifty|sensex|portfolio|crypto|bitcoin|ipo|jhunjhunwala"
    r")\b",
    re.IGNORECASE,
)


def _parsed_source_text(parsed: dict, fallback: str = "") -> str:
    raw_payload = parsed.get("raw_payload")
    if isinstance(raw_payload, dict) and isinstance(raw_payload.get("full_text"), str):
        return raw_payload["full_text"]
    return fallback or ""


def _parsed_has_market_anchor(parsed: dict, raw_text: str = "") -> bool:
    """Require concrete real-estate anchors before promoting parser output."""
    text = raw_text or _parsed_source_text(parsed)
    has_property_signal = bool(_REAL_ESTATE_SIGNAL_RE.search(text))
    has_market_action = bool(_REAL_ESTATE_ACTION_RE.search(text))
    has_non_real_estate_topic = bool(_NON_REAL_ESTATE_TOPIC_RE.search(text))

    if has_non_real_estate_topic and not has_property_signal:
        return False

    if parsed.get("bhk") or parsed.get("area_sqft") or parsed.get("building_name"):
        return True

    if parsed.get("micro_market"):
        return has_property_signal or has_market_action or bool(parsed.get("price"))

    return has_property_signal and (has_market_action or bool(parsed.get("price")))



# ── Parser helpers ──────────────────────────────────────────────────
def generate_summary_title(parsed: dict, raw_text: str = "") -> str | None:
    lower = raw_text.lower()
    intent = (parsed.get("intent") or "").upper()
    message_type = (parsed.get("message_type") or "").upper()

    def clean_label(value) -> str:
        text = re.sub(r"\s+", " ", str(value or "").replace("_", " ")).strip(" ,|-\n\t")
        if text.upper() in {"", "UNKNOWN", "LISTING", "REQUIREMENT", "PROPERTY", "TEXT"}:
            return ""
        return text

    def format_price(value, unit: str = "") -> str:
        if isinstance(value, str):
            already_formatted = re.sub(r"\s+", " ", value).strip()
            if re.search(r"(?i)(?:₹|\brs\.?\b|\binr\b).*(?:\bcr\b|\bcrore\b|\blac\b|\blakh\b|\bk\b)", already_formatted):
                return already_formatted.replace("Rs.", "₹").replace("Rs", "₹")
            value = re.sub(r"[^\d.]", "", already_formatted)
        try:
            number = float(value)
        except (TypeError, ValueError):
            return ""
        if number <= 0:
            return ""
        normalized_unit = clean_label(unit).lower()
        if normalized_unit in {"cr", "crore", "crores"}:
            return f"₹{number:g} Cr"
        if normalized_unit in {"lac", "lakh", "lakhs", "l"}:
            return f"₹{number:g} L"
        if normalized_unit in {"k", "thousand"}:
            return f"₹{number:g} K"
        if number >= 10_000_000:
            return f"₹{number / 10_000_000:g} Cr"
        if number >= 100_000:
            return f"₹{number / 100_000:g} L"
        if number >= 1_000:
            return f"₹{number / 1_000:g} K"
        return ""

    # 1. Detect property type from raw text
    prop_type = clean_label(parsed.get("property_type"))
    prop_pats = [
        (r'\bflat\b', "Flat"),
        (r'\bapartment\b', "Apartment"),
        (r'\bpenthouse\b', "Penthouse"),
        (r'\bduplex\b', "Duplex"),
        (r'\bstudio\b', "Studio"),
        (r'\bbungalow\b', "Bungalow"),
        (r'\bvilla\b', "Villa"),
        (r'\bhouse\b', "House"),
        (r'\bshop\b', "Shop"),
        (r'\bshowroom\b', "Showroom"),
        (r'\brestaurant\b', "Restaurant"),
        (r'\bgym\b', "Gym"),
        (r'\bgymkhana\b', "Gymkhana"),
        (r'\bsalon\b', "Salon"),
        (r'\bclinic\b', "Clinic"),
        (r'\boutlet\b', "Outlet"),
        (r'\bretail\b', "Retail"),
        (r'\bcafe\b', "Cafe"),
        (r'\bhotel\b', "Hotel"),
        (r'\b(?:marriage|banquet|party)\s*hall\b', "Banquet Hall"),
        (r'\bhall\b', "Hall"),
        (r'\b(?:co[- ])?working|shared\s+office\b', "Co-Working"),
        (r'\b(?:office|commercial)\b', "Commercial Office"),
        (r'\bgodown\b', "Godown"),
        (r'\bwarehouse\b', "Warehouse"),
        (r'\bfactory\b', "Factory"),
        (r'\bworkshop\b', "Workshop"),
        (r'\bplot\b', "Plot"),
        (r'\bland\b', "Land"),
        (r'\bsite\b', "Site"),
    ]
    if not prop_type:
        for pat, label in prop_pats:
            if re.search(pat, lower):
                prop_type = label
                break

    # 2. Detect transaction type from raw text
    trans_type = clean_label(parsed.get("transaction_type")).upper()
    if re.search(r'\bpre.?leased?\b', lower):
        trans_type = "PRE-LEASED"
    elif re.search(r'\bleased?\b', lower):
        trans_type = "LEASE"
    elif re.search(r'\bfor\s+sale\b', lower) or re.search(r'\bonsale\b', lower):
        trans_type = "SALE"
    elif re.search(r'\b(?:for\s+)?rent\b', lower):
        trans_type = "RENT"

    # 3. Fallback to parsed intent if no transaction found
    if not trans_type:
        if intent in {"RENT", "LEASE", "RENTAL_SEEKER"}:
            trans_type = "RENT"
        elif intent in {"SELL", "SALE", "BUY", "BUYER"}:
            trans_type = "SALE"

    bhk = clean_label(parsed.get("bhk") or parsed.get("configuration"))
    if re.fullmatch(r"\d+(?:\.\d+)?", bhk):
        bhk = f"{bhk} BHK"
    furnishing = clean_label(parsed.get("furnishing") or parsed.get("furnishing_canonical"))
    furnishing = re.sub(r"\bsemi furnished\b", "semi-furnished", furnishing, flags=re.IGNORECASE)
    subject = bhk.upper() if bhk and len(bhk) <= 8 else bhk
    if prop_type and (not subject or prop_type.lower() not in subject.lower()):
        subject = f"{subject} {prop_type}".strip()
    subject = subject or ("commercial property" if (parsed.get("asset_type") or "").lower() == "commercial" else "property")
    try:
        area_sqft = float(parsed.get("area_sqft") or 0)
    except (TypeError, ValueError):
        area_sqft = 0
    area_value = f"{int(area_sqft):,}" if area_sqft.is_integer() else f"{area_sqft:,.2f}".rstrip("0").rstrip(".")
    area_text = f"{area_value} sqft" if area_sqft > 0 else ""

    # 5. Location — from parsed first, then fall back to raw text
    loc = parsed.get("micro_market") or parsed.get("location_raw") or parsed.get("area")
    if not loc:
        loc_pats = [
            r'Andheri\s*\(\s*[EW]\s*\)',
            r'Andheri\s+(?:East|West)',
            r'Bandra\s+(?:East|West)',
            r'Bandra', r'Juhu',
            r'Khar\s+(?:East|West)', r'Khar',
            r'Dadar', r'Worli',
            r'Malad\s+(?:East|West)', r'Powai',
            r'Goregaon\s+(?:East|West)',
            r'Kandivali\s+(?:East|West)',
            r'Borivali\s+(?:East|West)',
            r'Dombivli', r'Thane',
            r'Navi\s+Mumbai', r'Nerul', r'Vashi', r'Panvel',
            r'Chembur', r'Kurla', r'Ghatkopar',
            r'Vile\s+Parle', r'Lower\s+Para?l',
            r'Prabhadevi', r'Marine\s+Lines?',
            r'Colaba', r'Churchgate', r'Fort', r'Byculla',
            r'Mahim', r'Matunga', r'Sion', r'Wadala',
            r'Dahisar', r'Mira\s+Road', r'Bhayandar',
            r'Vasai', r'Virar', r'Kalyan',
        ]
        for pat in loc_pats:
            lm = re.search(pat, raw_text, re.IGNORECASE)
            if lm:
                loc = lm.group(0)
                loc = re.sub(r'\(\s*([EW])\s*\)',
                             lambda m: {"E": "East", "W": "West"}.get(m.group(1).upper(), m.group(1)),
                             loc).replace("_", " ").strip()
                break
    loc = clean_label(loc)

    # 6. Building name — from parsed first, then fall back to raw text (first line only, conservative)
    bldg = parsed.get("building_name")
    if not bldg:
        first_line = raw_text.split("\n")[0].strip()
        bm = re.search(r'["\u201C\u201D]([^"\u201C\u201D]{3,50})["\u201C\u201D]', first_line)
        if bm:
            cand = bm.group(1).strip().strip("_").strip()
            if cand and not re.search(r'(price|lac|cr|sqft|floor|contact|call|property|available|building|tower)', cand, re.IGNORECASE):
                bldg = cand
    bldg = clean_label(bldg)
    places: list[str] = []
    for place in (bldg, loc):
        if place and not any(place.casefold() in existing.casefold() or existing.casefold() in place.casefold() for existing in places):
            places.append(place)
    place_text = ", ".join(places)

    price_text = format_price(
        parsed.get("price") or parsed.get("monthly_rent") or parsed.get("total_asking_price"),
        parsed.get("price_unit") or "",
    )
    is_requirement = message_type == "REQUIREMENT" or intent in {
        "BUY", "BUYER", "REQUIREMENT", "RENTAL_SEEKER", "WANTED"
    }
    is_rent = trans_type in {"RENT", "LEASE", "RENTAL"}

    descriptor = " ".join(part for part in (furnishing.lower(), subject) if part).strip()
    if area_text:
        descriptor += f" with {area_text}"
    article = "an" if descriptor[:1].lower() in "aeiou" else "a"
    if is_requirement:
        title = f"Looking to {'rent' if is_rent else 'buy'} {article} {descriptor}"
        if place_text:
            title += f" in {place_text}"
        if price_text:
            title += f" with a {'monthly ' if is_rent else ''}budget of {price_text}"
    else:
        title = descriptor[:1].upper() + descriptor[1:]
        title += f" for {'rent' if is_rent else 'sale'}"
        if place_text:
            title += f" at {place_text}"
        if price_text:
            title += f" for {price_text}{' per month' if is_rent else ''}"

    return re.sub(r"\s+", " ", title).strip()


def _parsed_display_label(parsed: dict) -> str:
    if (parsed.get("asset_type") or "").lower() == "commercial":
        label = parsed.get("commercial_use_type") or parsed.get("property_type") or "Commercial"
        return str(label).replace("_", " ").title()
    bhk = parsed.get("bhk")
    if bhk:
        return bhk
    prop_type = parsed.get("property_type")
    if prop_type:
        return str(prop_type).replace("_", " ").title()
    return "Property"


def _demote_weak_property_parse(parsed: dict, raw_text: str = "") -> dict:
    """Keep casual/chatty messages searchable without turning them into listings."""
    if _parsed_has_market_anchor(parsed, raw_text):
        return parsed
    cleaned = dict(parsed)
    for key in (
        "intent",
        "price_unit",
        "furnishing",
        "location_raw",
        "location",
        "landmark_name",
        "street_name",
        "area",
        "developer",
        "broker_name",
        "broker_phone",
    ):
        cleaned[key] = None
    cleaned["price"] = None
    cleaned["confidence"] = 0.0
    return cleaned


@app.post("/webhook")
async def webhook(request: Request):
    """Receive webhook from WhatsApp ingestor.

    Layer 1 — Raw Storage: writes the message immediately with processed=false.
    Returns fast. Async workers pick up unprocessed messages for extraction.
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON")

    data = body if isinstance(body, dict) else {}
    event = data.get("event", "")
    msg_data_for_instance = data.get("data", {}) if isinstance(data.get("data", {}), dict) else {}
    instance = data.get("instance") or msg_data_for_instance.get("instance") or "unknown"
    webhook_broker_id = msg_data_for_instance.get("broker_id", "")

    # ── Resolve tenant from broker_id ──────────────────────────────
    resolved_tenant_id = DEFAULT_TENANT_ID
    if webhook_broker_id:
        try:
            conn = await asyncio.to_thread(
                storage.get_org_whatsapp_connection_by_broker_id, webhook_broker_id
            )
            if conn and conn.get("organization_id"):
                resolved_tenant_id = conn["organization_id"]
        except Exception as exc:
            print(f"[webhook] tenant resolve error: {exc}", flush=True)

    # ── Classify and route event ──────────────────────────────────
    try:
        event_class = _classify_webhook_event(event, data)
    except Exception as exc:
        print(f"[webhook] classify error: {exc}", flush=True)
        event_class = "system"

    if event_class != "message":
        # A full group directory can contain hundreds of entries. It is
        # recoverable and must not hold the durable message outbox behind a
        # long series of Supabase calls.
        if event_class in {"group", "conversation"}:
            asyncio.create_task(
                asyncio.to_thread(
                    _handle_system_event,
                    event_class,
                    event,
                    data,
                    instance,
                    resolved_tenant_id,
                )
            )
        else:
            await asyncio.to_thread(
                _handle_system_event,
                event_class,
                event,
                data,
                instance,
                resolved_tenant_id,
            )
        return {"status": "event_handled", "event": event, "class": event_class}

    # ── Human message — Layer 1: Raw Storage only ─────────────────
    msg_data = data.get("data", data)
    key = msg_data.get("key", {})
    msg = msg_data.get("message", {})
    msg_text = _whatsapp_message_text(msg)
    if not msg_text.strip():
        return {"status": "ignored", "reason": "empty_message"}

    sender_data = msg_data.get("sender", {}) or {}
    push_name = msg_data.get("pushName", "") or sender_data.get("pushName", "") or ""
    sender_name = sender_data.get("name", "") or push_name
    sender_jid = key.get("participant", "") or sender_data.get("id", "")
    # WhatsApp can identify a group sender by a Meta LID (`user@lid`) while
    # whatsmeow's LID store resolves the same person to a phone JID. The
    # resolved value is currently sent as either a full `@s.whatsapp.net` JID
    # or bare digits. Both are a valid contact route and must win over the LID.
    participant_phone_jid = key.get("participantAlt", "") or key.get("participant_pn", "") or sender_data.get("phone", "")
    resolved_phone = _canonical_phone_from_jid(str(participant_phone_jid))
    sender_phone = resolved_phone or (
        _canonical_phone_from_jid(sender_jid)
        if str(sender_jid).endswith("@s.whatsapp.net")
        else ""
    )
    # Fallback: when ingestor's inline LID store fails, look up the group_members
    # directory which is populated on group-directory-sync with LID→phone mappings.
    if not sender_phone and str(sender_jid).endswith("@lid"):
        group_jid = key.get("remoteJid", "") or msg_data.get("from", "")
        try:
            gm = await asyncio.to_thread(
                storage.resolve_lid_from_group_members, str(sender_jid), str(group_jid)
            )
            if gm:
                sender_phone = _canonical_phone_from_jid(str(gm.get("member_phone") or ""))
                if not sender_name or sender_name == "unknown":
                    sender_name = str(gm.get("display_name") or "").strip() or sender_name
        except Exception as exc:
            print(f"[webhook] LID fallback error: {exc}", flush=True)
    sender = _format_whatsapp_sender(sender_name, sender_jid, sender_phone)
    group = key.get("remoteJid", "") or msg_data.get("from", "")
    if _is_blocked_whatsapp_conversation(group) or (sender_jid and _is_blocked_whatsapp_conversation(sender_jid)):
        return {"status": "ignored", "reason": "blocked_whatsapp_conversation", "jid": group}
    supplied_conversation_name = (
        msg_data.get("conversationName")
        or msg_data.get("chatName")
        or msg_data.get("conversation_name")
        or ""
    ).strip()
    group_name = supplied_conversation_name or await asyncio.to_thread(_resolve_group_name, group)
    is_dm = str(group).endswith("@s.whatsapp.net") or str(group).endswith("@lid")
    raw_group_name = "" if is_dm else group_name
    if supplied_conversation_name and str(group).endswith("@g.us"):
        try:
            await asyncio.to_thread(
                storage.upsert_sync_job,
                "whatsapp",
                instance or msg_data.get("instance", ""),
                group,
                supplied_conversation_name,
                0,
                "complete",
            )
        except Exception as exc:
            print(f"[webhook] group name upsert error: {exc}", flush=True)

    # Generate stable message UID for dedup
    message_id = msg_data.get("key", {}).get("id") or msg_data.get("id") or str(uuid.uuid4())
    # The same WhatsApp group message can be captured by multiple customer
    # phones. Deduplicate within one connection, never across workspaces.
    message_uid = f"{webhook_broker_id or resolved_tenant_id}:{group}:{message_id}"

    # Check for duplicate before writing
    try:
        existing = await asyncio.to_thread(storage.get_raw_by_uid, message_uid)
        if existing:
            return {"status": "duplicate", "raw_id": existing.id, "message": "already_saved"}
    except Exception:
        pass

    # Save raw message — immediate, no blocking
    try:
        from lab.scheduler import PIPELINE_VERSION
    except ImportError:
        PIPELINE_VERSION = "0.0.0"
    try:
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        message_timestamp = _coerce_whatsapp_timestamp(
            msg_data.get("messageTimestamp") or msg_data.get("timestamp")
        ) or now
        raw = RawMessage(
            tenant_id=resolved_tenant_id,
            group_name=raw_group_name,
            sender=sender,
            sender_jid=sender_jid,
            sender_phone=sender_phone,
            message=msg_text,
            message_type=_whatsapp_message_type(msg),
            is_group=str(group).endswith("@g.us"),
            attachments=json.dumps(_whatsapp_attachment_metadata(msg, msg_data.get("media"))),
            reply_context=json.dumps(
                msg.get("extendedTextMessage", {}).get("contextInfo", {})
                or msg.get("imageMessage", {}).get("contextInfo", {})
                or msg.get("videoMessage", {}).get("contextInfo", {})
                or {}
            ),
            timestamp=message_timestamp,
            source="WHATSAPP",
            raw_payload=json.dumps(data),
            message_uid=message_uid,
            pipeline_version=PIPELINE_VERSION,
            synced_at=now,
            processed=False,
        )

        def save_scoped_raw() -> int:
            previous = get_tenant_id()
            try:
                set_tenant_id(resolved_tenant_id)
                return storage.save_raw_message(raw)
            finally:
                set_tenant_id(previous)

        raw_id = await asyncio.to_thread(save_scoped_raw)
        # A message is also activity on a WhatsApp conversation. Keep this
        # separate from extraction so the raw WhatsApp mirror stays current
        # even when AI parsing is delayed or unavailable.
        conversation_type = (
            "group" if str(group).endswith("@g.us")
            else "broadcast" if str(group).endswith("@broadcast")
            else "direct"
        )
        try:
            await asyncio.to_thread(
                storage.touch_whatsapp_conversation,
                resolved_tenant_id,
                webhook_broker_id or "legacy",
                instance,
                group,
                conversation_type,
                message_timestamp,
            )
        except Exception as exc:
            print(f"[webhook] conversation activity update failed: {exc}", flush=True)
    except Exception as exc:
        print(f"[webhook] save_raw_message error: {exc}", flush=True)
        return {"error": f"save_raw_message: {exc}", "status": "failed"}

    # Publish event for async workers and live UI
    try:
        get_bus().publish("message.received", {
            "raw_id": raw_id,
            "group": group,
            "group_name": group_name,
            "sender": sender,
            "sender_jid": sender_jid,
            "sender_phone": sender_phone,
            "sender_name": sender_name,
            "message": msg_text[:200],
            "message_uid": message_uid,
            "instance": instance,
            "is_dm": is_dm,
        })
    except Exception as exc:
        print(f"[webhook] bus publish error: {exc}", flush=True)

    # ── Schedule async extraction in background ───────────────────
    extraction_ctx = {
        "sender_name": sender_name,
        "push_name": push_name,
        "sender_jid": sender_jid,
        "sender_phone": sender_phone,
        "group": group,
        "group_name": group_name,
        "msg_text": msg_text,
        "instance": instance,
        "is_dm": is_dm,
        "message_uid": message_uid,
        "message_id": message_id,
        "msg": msg,
        "tenant_id": resolved_tenant_id,
    }
    if not _schedule_raw_extraction(raw_id, extraction_ctx):
        # Slot pool saturated: retry with backoff (self-healing) instead of
        # dropping. If retries exhaust, the message remains processed=False and
        # the poll-based extraction_worker picks it up — never silently lost.
        _retry_schedule_raw_extraction(raw_id, extraction_ctx)

    # ── Proactively fetch sender profile picture (fire-and-forget) ──
    if sender_jid and "@s.whatsapp.net" in sender_jid:
        asyncio.create_task(_maybe_fetch_profile_picture(sender_jid, webhook_broker_id, resolved_tenant_id))

    return {"status": "ok", "raw_id": raw_id, "message": "saved"}


def _schedule_raw_extraction(raw_id: int, ctx: dict) -> bool:
    if not _EXTRACTION_SLOTS.acquire(blocking=False):
        return False
    try:
        loop = asyncio.get_running_loop()
        future = loop.run_in_executor(_EXTRACTION_EXECUTOR, _process_single_raw, raw_id, ctx)
    except Exception as exc:
        _EXTRACTION_SLOTS.release()
        print(f"[webhook] schedule extraction error: {exc}", flush=True)
        return False

    def release_slot(completed):
        _EXTRACTION_SLOTS.release()
        try:
            error = completed.exception()
        except Exception as exc:
            error = exc
        if error:
            print(f"[webhook] extraction error raw_id={raw_id}: {error}", flush=True)

    future.add_done_callback(release_slot)
    return True


# When the in-memory slot pool is saturated (a burst exceeding the pending
# limit), the message is NOT dropped — it stays processed=False in the DB and
# the poll-based extraction_worker would normally catch it. To stay resilient
# even if that worker isn't running, we retry the in-memory schedule after a
# short backoff so the burst drains as slots free up.
def _retry_schedule_raw_extraction(raw_id: int, ctx: dict, attempt: int = 0):
    if _schedule_raw_extraction(raw_id, ctx):
        return
    if attempt >= 5:
        # Exhausted retries: leave it for the poll worker (processed=False).
        print(
            f"[webhook] extraction deferred raw_id={raw_id}: queue saturated; "
            "message stays unprocessed for poll worker",
            flush=True,
        )
        return
    try:
        loop = asyncio.get_running_loop()
        loop.call_later(0.5 * (attempt + 1), _retry_schedule_raw_extraction, raw_id, ctx, attempt + 1)
    except Exception:
        print(
            f"[webhook] extraction deferred raw_id={raw_id}: queue saturated; "
            "message stays unprocessed for poll worker",
            flush=True,
        )


_PROFILE_PICTURE_FETCHED: set[str] = set()
_PROFILE_PICTURE_LOCK = asyncio.Lock()


async def _maybe_fetch_profile_picture(jid: str, broker_id: str, tenant_id: str):
    """Fetch and cache a sender's WhatsApp profile picture (fire-and-forget).

    Only fetches once per JID per process lifetime to avoid hammering the
    ingestor on busy group chats.  The 6-hour expiry in the proxy endpoint
    handles staleness for subsequent requests.
    """
    if not jid or "@s.whatsapp.net" not in jid:
        return
    async with _PROFILE_PICTURE_LOCK:
        if jid in _PROFILE_PICTURE_FETCHED:
            return
        _PROFILE_PICTURE_FETCHED.add(jid)
    try:
        phone = jid.split("@")[0].replace("+", "").strip()
        cached = storage.get_profile_photo(jid, tenant_id=tenant_id) if hasattr(storage, "get_profile_photo") else None
        if cached and cached.get("profile_photo_url") and cached.get("profile_photo_fetched_at"):
            try:
                fetched_at = datetime.fromisoformat(str(cached["profile_photo_fetched_at"]))
                if (datetime.now(timezone.utc) - fetched_at).total_seconds() < 6 * 3600:
                    return
            except Exception:
                pass
        _, resp = await _first_ingestor_response(
            "GET",
            f"/profile-picture?jid={jid}" + (f"&broker_id={broker_id}" if broker_id else ""),
            timeout=8,
        )
        if resp is None or resp.status_code >= 300:
            return
        data = resp.json()
        pic_url = data.get("url", "")
        if pic_url and data.get("ok"):
            storage.update_profile_photo(jid, pic_url, data.get("id", ""), tenant_id=tenant_id)
    except Exception:
        pass


def _process_single_raw(raw_id: int, ctx: dict):
    """Thin wrapper — delegates to the shared extraction module."""
    from extraction import process_raw_message
    # Each worker owns its Supabase client. Sharing the request client's mutable
    # tenant context across extraction threads can leak state between workspaces.
    process_raw_message(raw_id, ctx)


def _handle_system_event(event_class: str, event: str, data: dict, instance: str, tenant_id: str | None = None):
    """Handle non-message webhook events (connection, QR, system, etc.)."""
    tenant_id = tenant_id or DEFAULT_TENANT_ID
    msg_data = data.get("data", data)
    if event.startswith("WHATSAPP_") or event_class in {"presence", "call"}:
        try:
            storage.db.execute(
                """INSERT INTO whatsapp_events
                   (tenant_id, broker_id, event_type, chat_jid, sender_jid, message_ids, payload, occurred_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    tenant_id,
                    (msg_data.get("broker_id", "") if isinstance(msg_data, dict) else ""),
                    event,
                    (msg_data.get("chat_jid", "") if isinstance(msg_data, dict) else ""),
                    (msg_data.get("sender_jid", "") if isinstance(msg_data, dict) else ""),
                    json.dumps(msg_data.get("message_ids", []) if isinstance(msg_data, dict) else []),
                    json.dumps(data),
                    _coerce_whatsapp_timestamp(msg_data.get("timestamp") if isinstance(msg_data, dict) else None)
                    or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                ),
            )
        except Exception as exc:
            print(f"[webhook] whatsapp event persistence failed: {exc}", flush=True)
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
    elif event_class == "conversation":
        conversations = data.get("conversations") or []
        broker_id = (msg_data.get("broker_id", "") if isinstance(msg_data, dict) else "") or "legacy"
        try:
            persisted = storage.upsert_whatsapp_conversations(
                tenant_id, broker_id, instance, conversations,
            )
            get_bus().publish("whatsapp.conversations.updated", {
                "instance": instance,
                "broker_id": broker_id,
                "count": persisted,
            })
        except Exception as exc:
            print(f"[webhook] conversation directory persistence failed: {exc}", flush=True)
    elif event_class == "group":
        groups_list = data.get("groups") or (msg_data if isinstance(msg_data, list) else [msg_data])
        incoming_jids = set()
        directory_rows = []
        broker_id = (msg_data.get("broker_id", "") if isinstance(msg_data, dict) else "") or "legacy"
        is_full_refresh = bool(data.get("groups"))
        for g in groups_list:
            if not isinstance(g, dict):
                continue
            jid = g.get("id") or g.get("remoteJid") or ""
            if not jid:
                continue
            incoming_jids.add(jid)
            name = g.get("name") or g.get("subject") or jid
            raw_participants = g.get("participants", []) if isinstance(g.get("participants"), list) else []
            participants = len(raw_participants) if raw_participants else g.get("size", 0)
            directory_rows.append({
                "jid": jid,
                "type": "group",
                "name": name,
                "message_count": 0,
                "source": "group_directory",
                "metadata": {"participants": participants},
            })
            participant_rows = []
            participant_jids = set()
            for participant in raw_participants:
                if not isinstance(participant, dict):
                    continue
                member_jid = (
                    participant.get("id")
                    or participant.get("phone_jid")
                    or participant.get("lid")
                    or ""
                )
                member_jid = str(member_jid).strip()
                if not member_jid:
                    continue
                participant_jids.add(member_jid)
                phone_source = str(
                    participant.get("phone_jid")
                    or participant.get("id")
                    or participant.get("lid")
                    or ""
                ).strip()
                participant_rows.append({
                    "member_jid": member_jid,
                    "member_phone": storage._normalize_phone(phone_source) or None,
                    "display_name": str(participant.get("display_name") or "").strip() or None,
                    "is_admin": bool(participant.get("is_admin") or participant.get("is_super_admin")),
                })
            try:
                storage.upsert_sync_job(
                    source="whatsapp", instance=instance,
                    group_id=jid, group_name=name,
                    participants=participants,
                    status="complete",
                )
            except Exception as e:
                print(f"  upsert sync job failed for {jid}: {e}")
            if participant_rows:
                try:
                    storage.upsert_group_members(tenant_id, jid, participant_rows)
                except Exception as exc:
                    print(f"[webhook] group member persistence failed for {jid}: {exc}", flush=True)
            if is_full_refresh:
                try:
                    removed_members = storage.prune_group_members(
                        tenant_id=tenant_id,
                        group_id=jid,
                        keep_member_jids=participant_jids,
                    )
                    if removed_members:
                        print(f"  Removed {removed_members} stale members for {jid}")
                except Exception as exc:
                    print(f"[webhook] prune group members failed for {jid}: {exc}", flush=True)
            get_bus().publish("group.updated", {
                "instance": instance,
                "jid": jid,
                "name": name,
                "participants": participants,
            })
        if directory_rows:
            try:
                storage.upsert_whatsapp_conversations(
                    tenant_id, broker_id, instance, directory_rows,
                )
            except Exception as exc:
                print(f"[webhook] group directory conversation persistence failed: {exc}", flush=True)
        # On full refresh, remove stale groups no longer in this instance's list
        if data.get("groups") and incoming_jids:
            try:
                removed = storage.prune_sync_jobs(
                    source="whatsapp", instance=instance,
                    keep_jids=incoming_jids,
                )
                if removed:
                    print(f"  Removed {removed} stale groups for {instance}")
            except Exception as e:
                print(f"  prune sync jobs failed: {e}")
    else:
        get_bus().publish("system.event", {
            "event": event,
            "instance": instance,
            "class": event_class,
        })


def _format_whatsapp_sender(name: str = "", jid: str = "", phone: str = "") -> str:
    clean_name = (name or "").strip()
    display_phone = _masked_phone_from_digits(phone) or ("" if str(jid).endswith("@lid") else _phone_from_jid(jid))
    if clean_name:
        return clean_name
    return display_phone or "unknown"


def _resolve_group_name(jid: str) -> str:
    """Resolve a group JID to the human-readable name from sync_jobs.
    For DMs (person JIDs), return a formatted name."""
    if not jid:
        return jid
    
    # Group JIDs
    if jid.endswith("@g.us"):
        try:
            if _table_exists("sync_jobs"):
                row = storage.db.execute(
                    "SELECT group_name FROM sync_jobs WHERE group_id = ? AND group_name IS NOT NULL AND group_name != '' LIMIT 1",
                    (jid,),
                ).fetchone()
                if row and row[0] and row[0] != jid:
                    return row[0]
        except Exception:
            pass
        return _group_jid_to_name(jid)
    
    # DM JIDs (person JIDs) — empty string = direct conversation in inbox
    if jid.endswith("@s.whatsapp.net") or jid.endswith("@lid"):
        return ""
    
    return jid


def _phone_from_jid(jid: str = "") -> str:
    digits = _digits_from_whatsapp_id(jid)
    return _masked_phone_from_digits(digits)


def _canonical_phone_from_jid(jid: str = "") -> str:
    digits = _digits_from_whatsapp_id(jid)
    if not digits:
        return ""
    if digits.startswith("91") and len(digits) >= 12:
        return digits[:12]
    if len(digits) >= 10:
        return digits[-10:]
    return digits


def _masked_phone_from_digits(digits: str = "") -> str:
    if not digits:
        return ""
    if digits.startswith("91") and len(digits) >= 12:
        return f"+91 {digits[2:4]}{'X' * 6}{digits[10:12]}"
    if len(digits) >= 10:
        country = digits[:-10]
        local = digits[-10:]
        return f"+{country} {local[:2]}{'X' * 6}{local[-2:]}" if country else f"{local[:2]}{'X' * 6}{local[-2:]}"
    return f"+{digits}"


def _digits_from_whatsapp_id(value: str = "") -> str:
    # WhatsApp owner IDs can look like 919820056180:26@s.whatsapp.net.
    # The part after ":" is the linked-device suffix, not the phone number.
    local_part = str(value or "").split("@")[0].split(":")[0]
    return "".join(ch for ch in local_part if ch.isdigit())


def _display_phone_from_whatsapp_id(value: str = "") -> str:
    digits = _digits_from_whatsapp_id(value)
    if not digits:
        return ""
    if digits.startswith("91") and len(digits) >= 12:
        local = digits[2:12]
        return f"+91 {local}"
    if len(digits) > 10:
        country = digits[:-10]
        local = digits[-10:]
        return f"+{country} {local[:5]} {local[5:]}"
    if len(digits) == 10:
        return f"{digits[:5]} {digits[5:]}"
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

class BatchCreateRequest(BaseModel):
    batch_type: str = "observation_extraction"
    max_messages: int = 0  # 0 = all conversational messages

class BatchCreateResponse(BaseModel):
    id: int
    batch_api_id: str | None = None
    status: str
    total_requests: int
    stats_snapshot: str = ""

class BatchInfo(BaseModel):
    id: int
    batch_type: str
    batch_api_id: str | None
    status: str
    total_requests: int
    completed_count: int
    failed_count: int
    input_file_id: str | None
    output_file_id: str | None
    error_message: str | None
    stats_snapshot: str | None
    created_at: str
    updated_at: str

class IngestRequest(BaseModel):
    message: str
    group: str = "test"
    sender: str = "test-user"
    expected: Optional[dict] = None


# ── Auth / Tenant helpers ──────────────────────────────────────────────

SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET", "")
SUPABASE_URL = os.getenv("SUPABASE_URL", "")

# JWKS client for ES256 token verification (Supabase default)
_jwks_client = None
if SUPABASE_URL:
    try:
        _jwks_client = pyjwt.PyJWKClient(f"{SUPABASE_URL}/auth/v1/.well-known/jwks.json")
        print(f"  [auth] JWKS client initialized from {SUPABASE_URL}", flush=True)
    except Exception as e:
        print(f"  [auth] WARNING: JWKS client init failed: {e}", flush=True)
if not _jwks_client:
    import warnings
    warnings.warn(
        "Could not initialize JWKS client. JWT authentication will be disabled.",
        stacklevel=2,
    )

security_scheme = HTTPBearer(auto_error=False)


def verify_supabase_token(token: str) -> dict | None:
    try:
        algorithm = pyjwt.get_unverified_header(token).get("alg")
        if algorithm == "HS256":
            if not SUPABASE_JWT_SECRET:
                print("[auth] HS256 token received but JWT secret is not configured", flush=True)
                return None
            return pyjwt.decode(
                token,
                SUPABASE_JWT_SECRET,
                algorithms=["HS256"],
                audience="authenticated",
                options={"require": ["sub", "exp"]},
            )
        if algorithm != "ES256" or not _jwks_client:
            print(f"[auth] Unsupported JWT algorithm: {algorithm}", flush=True)
            return None
        signing_key = _jwks_client.get_signing_key_from_jwt(token)
        payload = pyjwt.decode(
            token,
            signing_key.key,
            algorithms=["ES256"],
            audience="authenticated",
            options={"require": ["sub", "exp"]},
        )
        return payload
    except pyjwt.ExpiredSignatureError:
        return None
    except pyjwt.InvalidSignatureError:
        print("[auth] JWT signature mismatch", flush=True)
        return None
    except pyjwt.PyJWKClientError as e:
        # JWT missing kid or no matching key - try all JWKS keys
        try:
            keys = _jwks_client.get_keys()
            for key in keys:
                try:
                    payload = pyjwt.decode(
                        token, key.key, algorithms=["ES256"],
                        audience="authenticated", options={"require": ["sub", "exp"]}
                    )
                    return payload
                except Exception:
                    continue
        except Exception:
            pass
        print(f"[auth] JWT rejected: {type(e).__name__}: {e}", flush=True)
        return None
    except Exception as e:
        print(f"[auth] JWT rejected: {type(e).__name__}: {e}", flush=True)
        return None


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Security(security_scheme),
) -> dict | None:
    if credentials is None:
        print("[auth] No Bearer token in request", flush=True)
        return None
    payload = verify_supabase_token(credentials.credentials)
    if payload is None:
        print(f"[auth] Token rejected (len={len(credentials.credentials)})", flush=True)
        return None
    return {
        "id": payload.get("sub"),
        "email": payload.get("email", ""),
        "phone": payload.get("phone", ""),
    }


async def require_user(user: dict | None = Depends(get_current_user)) -> dict:
    if user is None:
        raise HTTPException(401, "Authentication required")
    return user


@app.get("/debug/auth")
async def debug_auth(request: Request):
    """Diagnostic endpoint — no auth required. Shows exactly what's happening with JWT."""
    auth_header = request.headers.get("authorization", "")
    result = {
        "jwks_client_ready": bool(_jwks_client),
        "supabase_url": SUPABASE_URL,
        "authorization_header_present": bool(auth_header),
        "authorization_header_prefix": auth_header[:20] + "..." if len(auth_header) > 20 else auth_header,
    }
    if not auth_header:
        result["diagnosis"] = "NO_TOKEN: Authorization header is missing. Frontend is not sending the token."
    elif not auth_header.startswith("Bearer "):
        result["diagnosis"] = f"BAD_FORMAT: Authorization header starts with '{auth_header[:10]}', expected 'Bearer ...'"
    elif not _jwks_client:
        result["diagnosis"] = "NO_JWKS_CLIENT: JWKS client not initialized. Check SUPABASE_URL env var."
    else:
        token = auth_header[7:]
        try:
            signing_key = _jwks_client.get_signing_key_from_jwt(token)
            payload = pyjwt.decode(token, signing_key.key, algorithms=["ES256"],
                                  audience="authenticated",
                                  options={"require": ["sub", "exp"]})
            result["diagnosis"] = "VALID: Token decoded successfully. Auth should be working."
            result["payload_sub"] = payload.get("sub")
            result["payload_email"] = payload.get("email")
        except pyjwt.ExpiredSignatureError:
            result["diagnosis"] = "EXPIRED: Token is valid but expired. User needs to re-login."
        except pyjwt.InvalidSignatureError:
            result["diagnosis"] = "SIGNATURE_MISMATCH: Token signature verification failed."
        except pyjwt.DecodeError as e:
            result["diagnosis"] = f"DECODE_ERROR: Token is not valid JWT. {e}"
        except Exception as e:
            result["diagnosis"] = f"UNKNOWN_ERROR: {type(e).__name__}: {e}"
    return result


@app.post("/ingest")
async def ingest(req: IngestRequest, user: dict = Depends(require_user)):
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

    parsed = _demote_weak_property_parse(parse_message(req.message), req.message)
    if not _parsed_has_market_anchor(parsed, req.message):
        return {
            "status": "ignored",
            "reason": "no_real_estate_anchor",
            "raw_id": raw_id,
            "parsed_id": None,
        }
    embedding_blob = compute_embedding(parsed)
    obs = ParsedObservation(
        raw_message_id=raw_id,
        intent=parsed.get("intent"),
        principal=parsed.get("principal"),
        bhk=parsed.get("bhk"),
        configuration=parsed.get("configuration"),
        price=parsed.get("price"),
        price_unit=parsed.get("price_unit"),
        price_model=parsed.get("price_model"),
        price_per_sqft=parsed.get("price_per_sqft"),
        monthly_rent=parsed.get("monthly_rent"),
        total_asking_price=parsed.get("total_asking_price"),
        area_sqft=parsed.get("area_sqft"),
        furnishing=parsed.get("furnishing"),
        furnishing_canonical=parsed.get("furnishing_canonical"),
        location_raw=parsed.get("location_raw"),
        location=json.dumps(parsed.get("location")) if parsed.get("location") else None,
        building_name=parsed.get("building_name"),
        landmark_name=parsed.get("landmark_name"),
        street_name=parsed.get("street_name"),
        area=parsed.get("area"),
        micro_market=parsed.get("micro_market"),
        developer=parsed.get("developer"),
        asset_type=parsed.get("asset_type"),
        property_type=parsed.get("property_type"),
        transaction_type=parsed.get("transaction_type"),
        commercial_use_type=parsed.get("commercial_use_type"),
        fitout_status=parsed.get("fitout_status"),
        occupancy_type=parsed.get("occupancy_type"),
        floor_range=parsed.get("floor_range"),
        rent_per_sqft=parsed.get("rent_per_sqft"),
        availability_status=parsed.get("availability_status"),
        possession_status=parsed.get("possession_status"),
        possession_date=parsed.get("possession_date"),
        available_from=parsed.get("available_from"),
        ready_by=parsed.get("ready_by"),
        construction_stage=parsed.get("construction_stage"),
        launch_timeline=parsed.get("launch_timeline"),
        expected_possession=parsed.get("expected_possession"),
        broker_name=parsed.get("broker_name"),
        broker_phone=parsed.get("broker_phone"),
        forwarded=parsed.get("forwarded", 0),
        confidence=parsed.get("confidence", 0.0),
        raw_payload=json.dumps(parsed.get("raw_payload", {})),
        embedding=embedding_blob,
        summary_title=generate_summary_title(parsed, req.message),
        deal_tags=list(parsed.get("deal_tags") or []),
        additional_charges=list(parsed.get("additional_charges") or []),
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
async def ingest_batch(req: BatchIngestRequest, user: dict = Depends(require_user)):
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
async def get_raw_messages(user: dict = Depends(require_user), limit: int = 50, offset: int = 0,
                           group_name: str = "", sender: str = "",
                           sender_phone: str = "", sender_jid: str = ""):
    rows = storage.get_raw_messages(limit, offset, group_name=group_name,
                                    sender=sender, sender_phone=sender_phone,
                                    sender_jid=sender_jid)
    payload = [asdict(r) for r in rows]
    raw_ids = [row["id"] for row in payload]
    if raw_ids:
        try:
            parsed_res = storage.client.table("parsed_output").select(
                "raw_message_id,id,intent,broker_name,broker_phone,"
                "building_name,micro_market,landmark_name,location_raw,confidence"
            ).in_("raw_message_id", raw_ids).order("confidence", desc=True).order("id", desc=True).execute()
            parsed_rows = parsed_res.data or []
            parsed_by_raw: dict[int, dict] = {}
            for row in parsed_rows:
                raw_id = row.get("raw_message_id")
                if raw_id and raw_id not in parsed_by_raw:
                    has_value = any(
                        (row.get(f) or "").strip()
                        for f in ("broker_phone","broker_name","building_name",
                                  "micro_market","landmark_name","location_raw")
                    )
                    if has_value:
                        parsed_by_raw[raw_id] = row
            for row in payload:
                parsed = parsed_by_raw.get(row["id"])
                if parsed:
                    row["broker_name"] = parsed.get("broker_name") or ""
                    row["broker_phone"] = parsed.get("broker_phone") or ""
                    row["parsed_id"] = parsed.get("parsed_id")
                    row["parsed_intent"] = parsed.get("intent") or ""
                    row["building_name"] = parsed.get("building_name") or ""
                    row["micro_market"] = parsed.get("micro_market") or ""
                    row["landmark_name"] = parsed.get("landmark_name") or ""
                    row["location_raw"] = parsed.get("location_raw") or ""
        except Exception as e:
            import logging
            logging.warning(f"[api/raw] parsed_output enrichment failed: {e}")
    return payload


@app.get("/api/raw/{raw_id}")
async def get_raw_message(raw_id: int, user: dict = Depends(require_user)):
    row = storage.get_raw_message(raw_id)
    if not row:
        raise HTTPException(404)
    payload = asdict(row)
    parsed = storage.db.execute(
        """
        SELECT id AS parsed_id, intent,
               broker_name, broker_phone,
               building_name, micro_market, landmark_name, location_raw
        FROM parsed_output
        WHERE raw_message_id = ?
          AND (
            (broker_phone IS NOT NULL AND TRIM(broker_phone) != '')
            OR (broker_name IS NOT NULL AND TRIM(broker_name) != '')
            OR (building_name IS NOT NULL AND TRIM(building_name) != '')
            OR (micro_market IS NOT NULL AND TRIM(micro_market) != '')
            OR (landmark_name IS NOT NULL AND TRIM(landmark_name) != '')
            OR (location_raw IS NOT NULL AND TRIM(location_raw) != '')
          )
        ORDER BY confidence DESC, id DESC
        LIMIT 1
        """,
        (raw_id,),
    ).fetchone()
    if parsed:
        payload["broker_name"] = parsed["broker_name"] or ""
        payload["broker_phone"] = parsed["broker_phone"] or ""
        payload["parsed_id"] = parsed["parsed_id"]
        payload["parsed_intent"] = parsed["intent"] or ""
        payload["building_name"] = parsed["building_name"] or ""
        payload["micro_market"] = parsed["micro_market"] or ""
        payload["landmark_name"] = parsed["landmark_name"] or ""
        payload["location_raw"] = parsed["location_raw"] or ""
    return payload


# Shared default organization used when no tenant context is provided
# (e.g. unauthenticated feed endpoints). Brokers/observations are seeded
# under this tenant, so scoping to it keeps the inbox populated.
DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000010"


async def get_tenant_context(
    user: dict | None = Depends(get_current_user),
    x_tenant_id: str | None = Header(None),
) -> str | None:
    # Never trust a browser tenant header without verifying membership.
    # A stale localStorage value from another login must not cross tenants.
    set_tenant_id(None)
    tid = None
    if user:
        orgs = await asyncio.to_thread(storage.get_user_organizations, user["id"])
        allowed_ids = {str(org.get("id")) for org in orgs if org.get("id")}
        requested_id = str(x_tenant_id or "").strip()
        if requested_id and requested_id in allowed_ids:
            tid = requested_id
        else:
            tid = await asyncio.to_thread(_resolve_user_organization_id, user)
    # Public endpoints use the shared feed, but authenticated users never
    # inherit an arbitrary or stale shared tenant from the request header.
    if not tid:
        tid = DEFAULT_TENANT_ID
    set_tenant_id(tid)
    return tid


def _resolve_user_organization_id(user: dict) -> str | None:
    orgs = storage.get_user_organizations(user["id"])
    if orgs:
        try:
            for org in sorted(orgs, key=lambda o: o.get("created_at") or "", reverse=True):
                phones = storage.list_org_whatsapp_connections(org["id"])
                if phones:
                    return org["id"]
        except Exception:
            pass
        return orgs[0]["id"]

    # Auto-create an organization for new signups
    import re as _re, uuid as _uuid
    email = user.get("email", "")
    metadata = user.get("user_metadata") or {}
    workspace_name = (
        metadata.get("workspace_name")
        or metadata.get("agency_name")
        or metadata.get("company_name")
        or metadata.get("organization_name")
        or metadata.get("full_name", "")
        or email.split("@")[0]
    )
    raw_name = workspace_name or email.split("@")[0]
    slug = _re.sub(r"[^a-z0-9]+", "-", raw_name.lower()).strip("-") or "workspace"
    if len(slug) > 40:
        slug = slug[:40]
    existing = storage.get_organization_by_slug(slug)
    if existing:
        slug = f"{slug}-{_uuid.uuid4().hex[:6]}"
    display_name = raw_name or email.split("@")[0] or "My Workspace"
    org = storage.create_organization(name=display_name, slug=slug)
    if org:
        tid = org["id"]
        owner_role = storage.get_system_role("owner")
        storage.add_organization_member(tid, user["id"], owner_role.get("id") if owner_role else None)
        storage.create_team_member(
            name=display_name,
            email=email,
            organization_id=tid,
            permission_keys=["view_inbox", "reply_whatsapp"],
        )
        return tid
    return None


def _resolve_active_organization_id(user: dict, tenant_id: str | None) -> str:
    if tenant_id and tenant_id != DEFAULT_TENANT_ID:
        try:
            user_org_ids = {
                str(org.get("id"))
                for org in storage.get_user_organizations(user["id"])
                if org.get("id")
            }
            if tenant_id in user_org_ids:
                return tenant_id
        except Exception:
            pass
    resolved = _resolve_user_organization_id(user)
    if resolved:
        return resolved
    return tenant_id if tenant_id and tenant_id != DEFAULT_TENANT_ID else DEFAULT_TENANT_ID


async def _require_org_permission(user: dict, org_id: str, permission_key: str) -> None:
    if await asyncio.to_thread(storage.is_super_admin, user["id"]):
        return
    allowed = await asyncio.to_thread(
        storage.user_has_org_permission, user["id"], org_id, permission_key
    )
    if not allowed:
        raise HTTPException(403, f"Missing permission: {permission_key}")


async def _scoped_phone(phone_id: int, org_id: str) -> dict:
    phone = await asyncio.to_thread(storage.get_whatsapp_connection_unscoped, phone_id)
    if not phone or str(phone.get("organization_id")) != str(org_id):
        raise HTTPException(404, "Phone not found")
    return phone


async def require_tenant(
    tenant_id: str | None = Depends(get_tenant_context),
) -> str:
    if tenant_id is None:
        raise HTTPException(403, "No organization membership found")
    return tenant_id


@app.get("/api/inbox/threads")
async def inbox_threads(
    request: Request,
    user: dict | None = Depends(get_current_user),
    limit: int = 500, offset: int = 0,
    tenant_id: str | None = Depends(get_tenant_context),
):
    # Allow internal token auth (for ingestor backfill calls)
    if user is None:
        expected = (os.getenv("PROPAI_INTERNAL_TOKEN", "").strip()
                    or os.getenv("SUPABASE_SERVICE_KEY", "").strip())
        supplied = request.headers.get("X-PropAI-Internal-Token", "").strip()
        if not expected or not hmac.compare_digest(supplied, expected):
            raise HTTPException(401, "Authentication required")
    return storage.get_inbox_threads(limit, offset, tenant_id=tenant_id)


@app.get("/api/chats")
async def list_chats(user: dict = Depends(require_user), limit: int = 500, offset: int = 0,
                     tenant_id: str | None = Depends(get_tenant_context)):
    return storage.get_chats(limit, offset, tenant_id=tenant_id)


@app.get("/api/chats/{chat_id}/messages")
async def chat_messages(chat_id: str, user: dict = Depends(require_user), limit: int = 200, offset: int = 0,
                        tenant_id: str | None = Depends(get_tenant_context)):
    rows = storage.get_chat_messages(chat_id, limit, offset, tenant_id=tenant_id)
    return [asdict(r) for r in rows]


@app.get("/api/chats/{chat_id}")
async def get_chat(chat_id: str, tenant_id: str | None = Depends(get_tenant_context), user: dict = Depends(require_user)):
    for chat in storage.get_chats(1000, 0, tenant_id=tenant_id):
        if str(chat.get("chat_id") or chat.get("conversation_key") or "") == chat_id:
            return chat
    messages = storage.get_chat_messages(chat_id, 1, 0, tenant_id=tenant_id)
    if not messages:
        raise HTTPException(status_code=404, detail="Chat not found")
    row = asdict(messages[0])
    row["chat_id"] = chat_id
    row["conversation_key"] = chat_id
    row["conversation_name"] = row.get("group_name") or row.get("sender") or chat_id
    row["message_count"] = 1
    return row


@app.get("/api/inbox/slugs")
async def inbox_slugs(user: dict = Depends(require_user)):
    """Return saved inbox view configurations (slugs) for the tabs."""
    return [
        {"slug": "brokers", "label": "Brokers", "view_type": "brokers", "is_default": True},
    ]


@app.get("/api/inbox/views")
async def get_saved_inbox_views(user: dict = Depends(require_user), tenant_id: str | None = Depends(get_tenant_context)):
    """List all saved inbox views."""
    return storage.get_saved_inbox_views(tenant_id=tenant_id)


@app.get("/api/inbox/views/{slug}")
async def get_saved_inbox_view(slug: str, user: dict = Depends(require_user), tenant_id: str | None = Depends(get_tenant_context)):
    """Get a specific saved inbox view by slug."""
    view = storage.get_saved_inbox_view(slug, tenant_id=tenant_id)
    if view is None:
        raise HTTPException(status_code=404, detail="View not found")
    return view


@app.post("/api/inbox/views")
async def create_saved_inbox_view(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
    slug: str = "",
    name: str = "",
    filters: dict = {},
    description: str = "",
    is_default: bool = False,
    is_shared: bool = False,
):
    """Create a new saved inbox view."""
    try:
        view_id = storage.create_saved_inbox_view(slug, name, filters, description, is_default, is_shared, tenant_id=tenant_id)
        return {"id": view_id, "slug": slug, "name": name}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.put("/api/inbox/views/{slug}")
async def update_saved_inbox_view(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
    slug: str = "",
    name: str | None = None,
    filters: dict | None = None,
    description: str | None = None,
    is_default: bool | None = None,
    is_shared: bool | None = None,
):
    """Update a saved inbox view."""
    ok = storage.update_saved_inbox_view(slug, name, filters, description, is_default, is_shared, tenant_id=tenant_id)
    if not ok:
        raise HTTPException(status_code=404, detail="View not found")
    return {"ok": True, "slug": slug}


@app.delete("/api/inbox/views/{slug}")
async def delete_saved_inbox_view(slug: str, user: dict = Depends(require_user), tenant_id: str | None = Depends(get_tenant_context)):
    """Delete a saved inbox view."""
    ok = storage.delete_saved_inbox_view(slug, tenant_id=tenant_id)
    if not ok:
        raise HTTPException(status_code=404, detail="View not found")
    return {"ok": True, "slug": slug}


@app.get("/api/parsed")
async def get_parsed(limit: int = 50, offset: int = 0, intent: str = "", user: dict = Depends(require_user)):
    return storage.get_parsed(limit, offset, intent=intent)


@app.get("/api/observations/feed")
async def get_observations_feed(
    user: dict = Depends(require_user),
    limit: int = 50, offset: int = 0,
    broker_key: str = "", intent: str = "",
    phone: str = "",
    tenant_id: str | None = Depends(get_tenant_context),
):
    bk = broker_key or phone
    return storage.get_observations_feed(
        limit,
        offset,
        broker_key=bk,
        intent=intent,
        tenant_id=tenant_id,
    )


@app.get("/api/brokers/feed")
async def get_brokers_feed(
    user: dict = Depends(require_user),
    limit: int = 50, offset: int = 0,
    min_observations: int = 2,
    tenant_id: str | None = Depends(get_tenant_context),
):
    return storage.get_brokers_feed(
        limit,
        offset,
        min_observations=min_observations,
        tenant_id=tenant_id,
    )


@app.get("/api/resolver")
async def get_resolver_decisions(limit: int = 50, offset: int = 0, method: str = "", user: dict = Depends(require_user)):
    return storage.get_resolver_decisions(limit, offset, method)


@app.get("/api/failed")
async def get_failed(limit: int = 50, offset: int = 0, user: dict = Depends(require_user)):
    return storage.get_failed(limit, offset)


@app.get("/api/stats")
async def get_stats(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    return await asyncio.to_thread(storage.get_stats)


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


@app.get("/api/dashboard/time-window")
async def dashboard_time_window(window: str = "today", user: dict = Depends(require_user)):
    """Dashboard metrics for a specific time window."""
    now = datetime.now(timezone.utc)

    windows = {
        "today":      (now.strftime("%Y-%m-%d"), now.strftime("%Y-%m-%d")),
        "yesterday":  ((now - timedelta(days=1)).strftime("%Y-%m-%d"), (now - timedelta(days=1)).strftime("%Y-%m-%d")),
        "7d":         ((now - timedelta(days=6)).strftime("%Y-%m-%d"), now.strftime("%Y-%m-%d")),
        "30d":        ((now - timedelta(days=29)).strftime("%Y-%m-%d"), now.strftime("%Y-%m-%d")),
    }

    labels = {
        "today": "Today",
        "yesterday": "Yesterday",
        "7d": "Last 7 Days",
        "30d": "Last 30 Days",
        "all": "All Time",
    }

    if window == "all":
        start_date, end_date = None, None
    elif window in windows:
        start_date, end_date = windows[window]
    else:
        start_date, end_date = windows["today"]

    # Messages count
    if start_date:
        msg_count = storage.db.execute(
            "SELECT COUNT(*) FROM raw_messages WHERE date(timestamp) >= ? AND date(timestamp) <= ?",
            (start_date, end_date),
        ).fetchone()[0]
        total_msgs = storage.db.execute("SELECT COUNT(*) FROM raw_messages").fetchone()[0]
        # Listings by intent in window
        listings_in_window = storage.db.execute(
            """SELECT COALESCE(p.intent, p.message_type, 'UNKNOWN') as intent, COUNT(DISTINCT l.id) as c
               FROM listings l
               JOIN listing_observations lo ON lo.listing_id = l.id
               LEFT JOIN parsed_output p ON p.id = lo.parsed_id
               WHERE date(lo.seen_at) >= ? AND date(lo.seen_at) <= ?
               GROUP BY 1""",
            (start_date, end_date),
        ).fetchall()
        total_listings = storage.db.execute("SELECT COUNT(*) FROM listings").fetchone()[0]
        # Low confidence in window
        needs_review = storage.db.execute(
            "SELECT COUNT(*) FROM parsed_output WHERE date(created_at) >= ? AND date(created_at) <= ? AND confidence < 0.5",
            (start_date, end_date),
        ).fetchone()[0]
        total_needs_review = storage.db.execute(
            "SELECT COUNT(*) FROM parsed_output WHERE confidence < 0.5"
        ).fetchone()[0]
    else:
        msg_count = storage.db.execute("SELECT COUNT(*) FROM raw_messages").fetchone()[0]
        total_msgs = msg_count
        listings_in_window = storage.db.execute(
            """SELECT COALESCE(p.intent, p.message_type, 'UNKNOWN') as intent, COUNT(DISTINCT l.id) as c
               FROM listings l
               JOIN listing_observations lo ON lo.listing_id = l.id
               LEFT JOIN parsed_output p ON p.id = lo.parsed_id
                GROUP BY 1""",
        ).fetchall()
        total_listings = storage.db.execute("SELECT COUNT(*) FROM listings").fetchone()[0]
        needs_review = storage.db.execute("SELECT COUNT(*) FROM parsed_output WHERE confidence < 0.5").fetchone()[0]
        total_needs_review = needs_review

    intents = {r["intent"]: r["c"] for r in listings_in_window}

    return {
        "window": window,
        "label": labels.get(window, "Today"),
        "messages": msg_count,
        "total_messages": total_msgs,
        "supply": intents.get("SELL", 0),
        "total_supply": intents.get("SELL", 0) if window == "all" else storage.db.execute("SELECT COUNT(*) FROM listings WHERE intent='SELL'").fetchone()[0],
        "demand": intents.get("BUY", 0),
        "total_demand": intents.get("BUY", 0) if window == "all" else storage.db.execute("SELECT COUNT(*) FROM listings WHERE intent='BUY'").fetchone()[0],
        "rentals": intents.get("RENT", 0) + intents.get("COMMERCIAL", 0),
        "total_rentals": (intents.get("RENT", 0) + intents.get("COMMERCIAL", 0)) if window == "all" else storage.db.execute("SELECT COUNT(*) FROM listings WHERE intent IN ('RENT','COMMERCIAL')").fetchone()[0],
        "needs_review": needs_review,
        "total_needs_review": total_needs_review,
        "start_date": start_date,
        "end_date": end_date,
    }


@app.get("/api/dashboard/activity")
async def dashboard_activity(user: dict = Depends(require_user)):
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
async def dashboard_listings(limit: int = 20, user: dict = Depends(require_user)):
    """Recent listings (SELL/RENT/PRE-LAUNCH/COMMERCIAL)."""
    return storage.dashboard_listings(limit)


@app.get("/api/dashboard/requirements")
async def dashboard_requirements(limit: int = 20, user: dict = Depends(require_user)):
    """Recent requirements (BUY/RENTAL_SEEKER)."""
    return storage.dashboard_requirements(limit)


@app.get("/api/dashboard/signals")
async def dashboard_signals(user: dict = Depends(require_user)):
    """Market signals and trends."""
    return storage.dashboard_signals()


@app.get("/api/dashboard/coverage")
async def dashboard_coverage(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
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
async def action_dashboard(user: dict = Depends(require_user)):
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
async def dashboard_live_window(user: dict = Depends(require_user)):
    return business_window_status()


@app.get("/api/dashboard/feed")
async def dashboard_feed(limit: int = 20, user: dict = Depends(require_user)):
    """Live intelligence feed of latest messages."""
    return storage.dashboard_feed(limit)


@app.get("/api/dashboard/heatmap")
async def dashboard_heatmap(user: dict = Depends(require_user)):
    """Listings per micro market."""
    return storage.dashboard_heatmap()


@app.get("/api/markets/{market_name:path}")
async def get_market_detail(market_name: str, user: dict = Depends(require_user)):
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
async def dashboard_sync_activity(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    """Currently reading group and sync progress."""
    try:
        overall = get_scheduler().status().get("overall", "idle")
    except Exception:
        overall = "idle"
    jobs = []
    all_jobs = []
    try:
        all_jobs = await asyncio.to_thread(storage.get_sync_jobs, limit=500, source="whatsapp") if storage else []
        jobs = [j for j in all_jobs if getattr(j, "status", "") == "running"]
    except Exception as exc:
        print(f"[sync-activity] sync_jobs unavailable: {exc}", flush=True)
    running = None
    if jobs:
        j = jobs[0]
        running = {
            "group_name": getattr(j, "group_name", "") or getattr(j, "group_id", ""),
            "group_id": getattr(j, "group_id", ""),
            "records_found": getattr(j, "records_found", 0) or 0,
            "records_processed": getattr(j, "records_processed", 0) or 0,
        }
    # Extraction progress
    raw_total = 0
    raw_processed = 0
    try:
        raw_total, raw_processed = await asyncio.gather(
            asyncio.to_thread(_raw_count_all, tenant_id),
            asyncio.to_thread(_raw_count_processed, tenant_id),
        )
    except Exception:
        pass
    lag = await asyncio.to_thread(_raw_extraction_lag, tenant_id)
    return {
        "overall": overall,
        "total_jobs": len(all_jobs),
        "running": running,
        "extraction": {
            "total_raw": raw_total,
            "processed": raw_processed,
            "pending": raw_total - raw_processed,
            "pct": round(raw_processed / raw_total * 100, 1) if raw_total else 0,
            "lag": lag,
        },
    }


@app.get("/api/extraction/progress")
async def extraction_progress(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    """Current extraction pipeline progress (async worker status)."""
    total, processed = await asyncio.gather(
        asyncio.to_thread(_raw_count_all, tenant_id),
        asyncio.to_thread(_raw_count_processed, tenant_id),
    )
    pending = total - processed
    # Recent activity window
    from datetime import timedelta
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    recent_processed = 0
    try:
        res = storage.client.table("raw_messages").select("id", count="exact")\
            .eq("processed", True)\
            .gte("processed_at", cutoff).execute()
        recent_processed = res.count if hasattr(res, "count") else 0
    except Exception:
        pass
    lag = await asyncio.to_thread(_raw_extraction_lag, tenant_id)
    return {
        "total_raw_messages": total,
        "processed": processed,
        "pending": pending,
        "progress_pct": round(processed / total * 100, 1) if total else 0,
        "recently_processed_1h": recent_processed,
        "lag": lag,
    }


def _raw_count_all(tenant_id: str | None = None) -> int:
    try:
        query = storage.client.table("raw_messages").select("id", count="exact")
        if tenant_id:
            query = query.eq("tenant_id", tenant_id)
        res = query.execute()
        return res.count if hasattr(res, "count") else 0
    except Exception:
        return 0


def _raw_count_processed(tenant_id: str | None = None) -> int:
    try:
        query = storage.client.table("raw_messages").select("id", count="exact")\
            .eq("processed", True)
        if tenant_id:
            query = query.eq("tenant_id", tenant_id)
        res = query.execute()
        return res.count if hasattr(res, "count") else 0
    except Exception:
        return 0


def _raw_extraction_lag(tenant_id: str | None = None) -> dict:
    """Return a lightweight extraction lag snapshot for alerting/UI."""
    from datetime import timedelta

    now = datetime.now(timezone.utc)
    cutoff_15m = (now - timedelta(minutes=15)).isoformat()
    cutoff_60m = (now - timedelta(hours=1)).isoformat()
    pending_over_15m = 0
    pending_over_60m = 0
    oldest_pending_at = None

    try:
        query = storage.client.table("raw_messages").select("created_at", count="exact")\
            .eq("processed", False).lt("created_at", cutoff_15m)
        if tenant_id:
            query = query.eq("tenant_id", tenant_id)
        res = query.execute()
        pending_over_15m = res.count if hasattr(res, "count") else 0
    except Exception:
        pass
    try:
        query = storage.client.table("raw_messages").select("created_at", count="exact")\
            .eq("processed", False).lt("created_at", cutoff_60m)
        if tenant_id:
            query = query.eq("tenant_id", tenant_id)
        res = query.execute()
        pending_over_60m = res.count if hasattr(res, "count") else 0
    except Exception:
        pass
    try:
        query = storage.client.table("raw_messages").select("created_at")\
            .eq("processed", False).order("created_at", desc=False).limit(1)
        if tenant_id:
            query = query.eq("tenant_id", tenant_id)
        res = query.execute()
        if res.data:
            oldest_pending_at = res.data[0].get("created_at")
    except Exception:
        pass

    oldest_pending_age_minutes = None
    if oldest_pending_at:
        try:
            oldest_dt = datetime.fromisoformat(str(oldest_pending_at).replace("Z", "+00:00"))
            oldest_pending_age_minutes = max(0, int((now - oldest_dt).total_seconds() // 60))
        except Exception:
            oldest_pending_age_minutes = None

    if pending_over_60m > 0:
        status = "error"
    elif pending_over_15m > 0:
        status = "warning"
    else:
        status = "healthy"

    return {
        "status": status,
        "pending_over_15m": pending_over_15m,
        "pending_over_60m": pending_over_60m,
        "oldest_pending_at": oldest_pending_at,
        "oldest_pending_age_minutes": oldest_pending_age_minutes,
    }


@app.get("/api/dashboard/graph-growth")
async def dashboard_graph_growth(user: dict = Depends(require_user)):
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


def _select_workspace_whatsapp_status(phones: list[dict], statuses: list[dict]) -> dict:
    broker_ids = {str(phone.get("broker_id") or "") for phone in phones}
    broker_ids.discard("")
    owned_statuses = [
        status
        for status in statuses
        if str(status.get("broker_id") or "") in broker_ids
    ]
    return next((status for status in owned_statuses if status.get("connected")), None) or (
        owned_statuses[0] if owned_statuses else {}
    )


@app.get("/api/dashboard/whatsapp-status")
async def dashboard_whatsapp_status(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    """Return WhatsApp status for the authenticated workspace only."""
    org_id = _resolve_active_organization_id(user, tenant_id)
    phones = await asyncio.to_thread(storage.list_org_whatsapp_connections, org_id)
    details: dict = {}
    if phones:
        statuses_map, ingestor_reachable, ingestor_error = await _merged_ingestor_list(timeout=2)
        statuses: list[dict] = list(statuses_map.values())
        now = time.time()
        statuses.extend(
            status
            for status, seen_at in _broker_live_statuses.values()
            if now - seen_at <= 45
        )
        details = _select_workspace_whatsapp_status(phones, statuses)
        if not details and ingestor_reachable:
            details = {"connection_state": "stopped", "connected": False}
        elif not details and ingestor_error:
            details = {"connection_state": "unavailable", "connected": False}

    phone = details.get("phone_number") or ""
    return {
        "connected": details.get("connected", False),
        "instance": details.get("instance_name", "propai-whatsmeow"),
        "phone": phone,
        "profile": details.get("display_name") or "",
        "status": details.get("connection_state") or "",
        "state": details.get("connection_state") or "",
        "status_stale": bool(details.get("status_stale")),
        "connected_since": details.get("connected_since") or None,
    }


_CAPTURED_UNUSED_CAPS = frozenset({"Read Receipts", "Typing Presence"})

_ALWAYS_ON_CAPS = frozenset({
    "Outgoing Messages",
    "History Sync",
    "Profile Pictures",
    "Group Directory",
    "Media Download",
    "Media Upload",
    "Self-Chat Agent",
})

_CAPABILITY_TYPE_KEY: dict[str, str] = {
    "Text Messages": "text",
    "Images": "image",
    "Video": "video",
    "Audio": "audio",
    "Documents": "document",
    "Stickers": "sticker",
    "Location": "location",
    "Live Location": "live_location",
    "Contact Cards": "contact",
    "Contact Arrays": "contacts_array",
    "Reactions": "reaction",
    "Poll Creation": "poll_creation",
    "Poll Updates": "poll_update",
    "Edited Messages": "edited",
}

_FALLBACK_CAPABILITIES: list[dict] = [
    {"name": "Text Messages", "icon": "MessageSquare", "description": "Plain text from any group, with sender, group, and timestamp."},
    {"name": "Images", "icon": "Image", "description": "Image messages: caption and sender captured; full media downloaded on demand."},
    {"name": "Video", "icon": "Video", "description": "Video messages: caption plus thumbnail; full download on demand."},
    {"name": "Audio", "icon": "Mic", "description": "Voice notes and audio files; transcribed automatically."},
    {"name": "Documents", "icon": "FileText", "description": "PDFs and file attachments; filename and mimetype captured."},
    {"name": "Stickers", "icon": "Smile", "description": "Sticker messages: metadata captured, sticker image not stored."},
    {"name": "Location", "icon": "MapPin", "description": "Static shared locations: latitude, longitude, label, and address."},
    {"name": "Live Location", "icon": "Navigation", "description": "Real-time location streams from any participant."},
    {"name": "Contact Cards", "icon": "Users", "description": "Shared vCards: phone, name, and organisation extracted."},
    {"name": "Contact Arrays", "icon": "Contact", "description": "Multi-contact shares parsed into individual cards."},
    {"name": "Reactions", "icon": "SmilePlus", "description": "Emoji reactions on any observed message."},
    {"name": "Poll Creation", "icon": "BarChart3", "description": "Polls created in groups: options and voters captured."},
    {"name": "Poll Updates", "icon": "Vote", "description": "Per-option vote tally updates as votes come in."},
    {"name": "Edited Messages", "icon": "Pencil", "description": "Edit events re-linked to the original message."},
    {"name": "Outgoing Messages", "icon": "ArrowUpRight", "description": "Messages your phone sends, kept in sync for your own listings."},
    {"name": "History Sync", "icon": "Clock", "description": "Initial backfill of recent messages on first connect."},
    {"name": "Read Receipts", "icon": "CheckCheck", "description": "Blue-tick events captured but not yet surfaced in the UI."},
    {"name": "Typing Presence", "icon": "Pencil", "description": "Typing indicators captured but not yet surfaced in the UI."},
    {"name": "Profile Pictures", "icon": "Camera", "description": "Profile picture changes tracked per JID."},
    {"name": "Group Directory", "icon": "Users", "description": "Group metadata: name, participants, admins, and subject changes."},
    {"name": "Media Download", "icon": "Download", "description": "On-demand download of incoming media to workspace storage."},
    {"name": "Media Upload", "icon": "Upload", "description": "Outbound media uploads for sending files, images, and video."},
    {"name": "Self-Chat Agent", "icon": "Bot", "description": "Sends structured replies to your Message Yourself chat so PropAI can act on them."},
]

_CAPABILITY_WINDOW_DAYS = 7


def _capability_type_counts(tenant_id: str | None) -> dict[str, dict]:
    if not _table_exists("raw_messages"):
        return {}
    try:
        rows = storage.db.execute(
            """
            SELECT COALESCE(message_type, 'text') AS t,
                   COUNT(*) AS c,
                   MAX(created_at) AS last_seen
            FROM raw_messages
            WHERE tenant_id = ?
              AND created_at >= now() - interval '7 days'
            GROUP BY t
            """,
            (tenant_id,),
        ).fetchall()
    except Exception as exc:
        print(f"[capabilities] type-count query failed: {exc}", flush=True)
        return {}
    counts: dict[str, dict] = {}
    for row in rows or []:
        try:
            last_seen = row["last_seen"]
            if last_seen and hasattr(last_seen, "isoformat"):
                last_seen_str = last_seen.isoformat()
            else:
                last_seen_str = str(last_seen) if last_seen else None
            counts[str(row["t"])] = {
                "count": int(row["c"] or 0),
                "last_seen": last_seen_str,
            }
        except (KeyError, TypeError, ValueError, AttributeError):
            continue
    return counts


def _capability_coverage(tenant_id: str | None) -> dict:
    """Return aggregate coverage stats: total messages, unique chats, unique groups.

    Used to answer "is whatsmeow ingesting all my groups?" — idle caps just mean
    that no messages of that type arrived in the window, not that ingestion
    failed. These numbers let the user verify their ingestor is pulling from
    the full set of groups they expect.
    """
    empty = {"total_messages": 0, "unique_chats": 0, "unique_groups": 0,
             "unique_broadcasts": 0, "oldest_message": None, "newest_message": None}
    if not _table_exists("raw_messages"):
        return empty
    try:
        rows = storage.db.execute(
            """
            SELECT COUNT(*) AS total,
                   COUNT(DISTINCT remote_jid) AS chats,
                   COUNT(DISTINCT CASE WHEN remote_jid LIKE '%@g.us' THEN remote_jid END) AS groups,
                   COUNT(DISTINCT CASE WHEN remote_jid LIKE '%@broadcast' THEN remote_jid END) AS broadcasts,
                   MIN(created_at) AS oldest,
                   MAX(created_at) AS newest
            FROM (
                SELECT raw_payload->'data'->'key'->>'remoteJid' AS remote_jid, created_at
                FROM raw_messages
                WHERE tenant_id = ?
                  AND created_at >= now() - interval '7 days'
            ) sub
            """,
            (tenant_id,),
        ).fetchall()
    except Exception as exc:
        print(f"[capabilities] coverage query failed: {exc}", flush=True)
        return empty
    if not rows:
        return empty
    row = rows[0]
    try:
        oldest = row["oldest"]
        newest = row["newest"]
        return {
            "total_messages": int(row["total"] or 0),
            "unique_chats": int(row["chats"] or 0),
            "unique_groups": int(row["groups"] or 0),
            "unique_broadcasts": int(row["broadcasts"] or 0),
            "oldest_message": oldest.isoformat() if hasattr(oldest, "isoformat") else (str(oldest) if oldest else None),
            "newest_message": newest.isoformat() if hasattr(newest, "isoformat") else (str(newest) if newest else None),
        }
    except (KeyError, TypeError, ValueError, AttributeError):
        return empty


def _compute_capability_status(
    name: str,
    type_data: dict[str, dict],
    any_phone: bool,
    any_connected: bool,
) -> tuple[str, int, str | None]:
    if name in _CAPTURED_UNUSED_CAPS:
        return "captured_unused", 0, None
    if name in _ALWAYS_ON_CAPS:
        if any_connected:
            return "active", 0, None
        if any_phone:
            return "partial", 0, None
        return "not_available", 0, None
    type_key = _CAPABILITY_TYPE_KEY.get(name)
    data = type_data.get(type_key) if type_key else None
    count = int(data["count"]) if data else 0
    last_seen = data["last_seen"] if data else None
    if count > 0:
        return "active", count, last_seen
    if any_phone:
        return "partial", 0, None
    return "not_available", 0, None


@app.get("/api/ingestor/capabilities")
async def get_ingestor_capabilities(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    """Return what message types the whatsmeow ingestor captures, with live per-workspace status."""
    org_id = _resolve_active_organization_id(user, tenant_id)
    phones = await asyncio.to_thread(storage.list_org_whatsapp_connections, org_id)
    any_phone = bool(phones)

    statuses_map, _, _ = await _merged_ingestor_list(timeout=2)
    statuses: list[dict] = list(statuses_map.values())
    now = time.time()
    statuses.extend(
        status for status, seen_at in _broker_live_statuses.values()
        if now - seen_at <= 45
    )
    broker_ids = {str(phone.get("broker_id") or "") for phone in phones}
    broker_ids.discard("")
    any_connected = any(
        bool(status.get("connected"))
        for status in statuses
        if str(status.get("broker_id") or "") in broker_ids
    )

    ingestor_payload: dict | None = None
    _, resp = await _first_ingestor_response("GET", "/capabilities", timeout=3)
    if resp is not None and resp.status_code == 200:
        try:
            ingestor_payload = resp.json()
        except Exception:
            ingestor_payload = None
    canonical = (ingestor_payload or {}).get("capabilities") or _FALLBACK_CAPABILITIES

    type_data = _capability_type_counts(tenant_id)

    out: list[dict] = []
    for cap in canonical:
        entry = {k: v for k, v in cap.items() if k in {"name", "icon", "description"}}
        status, evidence, last_seen = _compute_capability_status(
            cap.get("name", ""), type_data, any_phone, any_connected
        )
        entry["status"] = status
        entry["evidence_count"] = evidence
        if last_seen:
            entry["last_seen"] = last_seen
        out.append(entry)

    return {
        "capabilities": out,
        "instance": (ingestor_payload or {}).get("instance", "unknown"),
        "version": (ingestor_payload or {}).get("version", "unknown"),
        "any_connected": any_connected,
        "any_phone": any_phone,
        "window_days": _CAPABILITY_WINDOW_DAYS,
        "source": "ingestor" if ingestor_payload else "fallback",
        "coverage": _capability_coverage(tenant_id),
    }


@app.get("/api/ingestor/status")
async def get_ingestor_status(user: dict = Depends(require_user), tenant_id: str | None = Depends(get_tenant_context)):
    """Return combined WhatsApp ingestor status for the WhatsWow panel."""
    org_id = _resolve_active_organization_id(user, tenant_id)
    phones = await asyncio.to_thread(storage.list_org_whatsapp_connections, org_id)
    statuses_map, _, _ = await _merged_ingestor_list(timeout=2)
    statuses: list[dict] = list(statuses_map.values())
    now = time.time()
    statuses.extend(
        status for status, seen_at in _broker_live_statuses.values()
        if now - seen_at <= 45
    )
    merged = _select_workspace_whatsapp_status(phones, statuses)
    merged["phones"] = phones
    merged["ingestor_statuses"] = statuses
    return merged


# ═══════════════════════════════════════════════════════════════
# AI Layer — read-only intelligence endpoints
# ═══════════════════════════════════════════════════════════════

@app.get("/api/market/access")
async def market_access_status(
    user: dict | None = Depends(get_current_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    """Access gate for shared market intelligence.

    Signup alone is not a trial. The market unlocks after the workspace has
    synced data at least once and remains available during later WhatsApp
    outages. Billing can replace this flag without changing the contract.
    """
    details = await asyncio.to_thread(_connection_details)
    connected = bool(details.get("connected"))
    sync_ready = await asyncio.to_thread(_market_sync_ready, details)
    paid_active = False
    trial_active = sync_ready
    unlocked = paid_active or trial_active

    reason = "ready"
    message = "Market Inbox is available for this connected workspace."
    if sync_ready and not connected:
        reason = "offline_data_available"
        message = "WhatsApp is temporarily disconnected. Previously synced market data remains available."
    elif not connected:
        reason = "connect_whatsapp"
        message = "Connect WhatsApp and start your trial to unlock your personalized broker market feed."
    elif not sync_ready:
        reason = "sync_pending"
        message = "WhatsApp is connected. PropAI is waiting for the first sync record before opening Market Inbox."

    # Check if WABA (WhatsApp Business API) is configured — allows outbound even without whatsmeow
    waba_configured = bool(await asyncio.to_thread(_business_api_get_config_value, "access_token", "WABA_ACCESS_TOKEN"))

    return {
        "authenticated": bool(user),
        "tenant_id": tenant_id,
        "whatsapp_connected": connected,
        "waba_configured": waba_configured,
        "initial_sync_complete": sync_ready,
        "trial_active": trial_active,
        "paid_active": paid_active,
        "market_unlocked": unlocked,
        "trial_started_at": details.get("connected_since") if trial_active else None,
        "trial_ends_at": None,
        "reason": reason,
        "message": message,
    }


class QueryRequest(BaseModel):
    query: str
    k: int = 10


@app.post("/api/ai/query")
async def ai_query(req: QueryRequest, user: dict = Depends(require_user)):
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
async def ai_similar(observation_id: int, k: int = 10, user: dict = Depends(require_user)):
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
async def ai_explain(observation_id: int, user: dict = Depends(require_user)):
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
async def ai_summary(user: dict = Depends(require_user)):
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
async def ai_broker(broker_name: str, user: dict = Depends(require_user)):
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
async def ai_building(building_name: str, user: dict = Depends(require_user)):
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
async def promote_config(user: dict = Depends(require_user)):
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
    label = _parsed_display_label(parsed)
    building = parsed.get("building_name", "")
    market = parsed.get("micro_market", "")
    price = _promote_price(parsed)
    location = market or parsed.get("location_raw", "")
    if channel == "whatsapp":
        parts = [f"🏗️ {label}"]
        if building:
            parts.append(f"at {building}")
        if location:
            parts.append(f"in {location}")
        if price:
            parts.append(f"| {price}")
        return " ".join(parts)
    if channel in ("facebook", "instagram"):
        parts = [f"{label}"]
        if building:
            parts.append(f"at {building}")
        if location:
            parts.append(f"in {location}")
        if price:
            parts.append(f"— {price}")
        return " ".join(parts)
    return ""


def _promote_whatsapp(parsed: dict, highlights: list[str]) -> str:
    label = _parsed_display_label(parsed)
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
    detail_parts = [p for p in [label, area, furnish] if p]
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
    label = _parsed_display_label(parsed)
    building = parsed.get("building_name", "")
    market = parsed.get("micro_market", "")
    price = _promote_price(parsed)
    area = f"{parsed['area_sqft']:,} sqft" if parsed.get("area_sqft") else ""
    furnish = parsed.get("furnishing", "")
    lines = [f"✨ {label}" + (f" at {building}" if building else "")]
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
        from llm import get_client, get_model
        client = get_client()
        model = get_model()
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": prompt}],
            max_tokens=300,
        )
        usage = getattr(resp, "usage", None)
        try:
            from usage_logger import log_ai_usage
            log_ai_usage(
                agent="promote",
                model=model,
                tokens_input=getattr(usage, "prompt_tokens", 0) or 0,
                tokens_output=getattr(usage, "completion_tokens", 0) or 0,
            )
        except Exception:
            pass
        return resp.choices[0].message.content
    except Exception:
        return None


def _ai_promote_with_key(system: str, prompt: str, api_key: str) -> str | None:
    try:
        from llm import get_client, get_model
        client = get_client() if not api_key else OpenAI(api_key=api_key, base_url="https://api.doubleword.ai/v1")
        # A browser-supplied key can override credentials, never the configured model.
        model = get_model()
        resp = client.chat.completions.create(
            model=model,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": prompt}],
            max_tokens=300,
        )
        usage = getattr(resp, "usage", None)
        try:
            from usage_logger import log_ai_usage
            log_ai_usage(
                agent="promote",
                model=model,
                tokens_input=getattr(usage, "prompt_tokens", 0) or 0,
                tokens_output=getattr(usage, "completion_tokens", 0) or 0,
            )
        except Exception:
            pass
        return resp.choices[0].message.content
    except Exception:
        return None


@app.post("/api/promote/generate")
async def promote_generate(req: PromoteRequest, user: dict = Depends(require_user)):
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

    promo_api_key = req.api_key or ""
    if req.use_ai and ENABLE_AI_PROMO:
        try:
            system = "You are a Mumbai real estate marketing assistant. Given property details, write a short promotional ad for the specified channel. Keep it under 120 words. Return only the ad body, no preamble."
            price_str = _promote_price(parsed)
            detail_parts = [v for v in [_parsed_display_label(parsed), parsed.get("furnishing"), f"{parsed.get('area_sqft', '')} sqft" if parsed.get('area_sqft') else ""] if v]
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
async def get_evaluations(limit: int = 50, min_accuracy: float = 0.0, user: dict = Depends(require_user)):
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
    session_id: str = ""
    broker_phone: str = ""
    source: str = ""


class SelfChatRequest(BaseModel):
    text: str
    sender_jid: str = ""
    message_id: str = ""
    push_name: str = ""
    messages: list[dict] = []
    model: str = ""


class InternalSelfChatRequest(BaseModel):
    broker_id: str
    text: str
    message_id: str = ""
    sender_jid: str = ""


_LISTING_SEARCH_BLOCKERS = re.compile(
    r"\b(broker|brokers|sender|senders|group|groups|duplicate|duplicates|trend|trends|market action|audit|remember|memory)\b",
    re.IGNORECASE,
)
_LISTING_SEARCH_SIGNAL = re.compile(
    r"\b(\d+(?:\.\d+)?\s*bhk|studio|rent|rental|rentals|lease|sale|sales|sell|buy|purchase|available|availability|flat|apartment|property|listing|listings)\b",
    re.IGNORECASE,
)
_KNOWN_MARKETS = [
    "Bandra East",
    "Bandra West",
    "Bandra",
    "Andheri East",
    "Andheri West",
    "Andheri",
    "Santacruz East",
    "Santacruz West",
    "Santacruz",
    "Juhu",
    "Khar West",
    "Khar",
    "BKC",
    "Lower Parel",
    "Worli",
    "Sion",
    "Goregaon East",
    "Goregaon West",
    "Goregaon",
    "Lokhandwala",
    "Malad East",
    "Malad West",
    "Malad",
    "Powai",
    "Chembur",
    "Dadar",
    "Prabhadevi",
    "Pali Hill",
    "Kalina",
]

_NEARBY_MARKETS = {
    "Bandra East": ["BKC", "Kalina", "Santacruz East", "Khar West", "Bandra West", "Santacruz West"],
    "Bandra West": ["Khar West", "Pali Hill", "Santacruz West", "Bandra East", "Juhu", "BKC"],
    "Bandra": ["Bandra West", "Bandra East", "Khar West", "BKC", "Santacruz West"],
    "BKC": ["Bandra East", "Kalina", "Santacruz East", "Khar West", "Bandra West"],
    "Khar West": ["Bandra West", "Santacruz West", "Pali Hill", "Juhu", "Bandra East"],
    "Khar": ["Khar West", "Bandra West", "Santacruz West", "Pali Hill", "Juhu"],
    "Santacruz East": ["Kalina", "BKC", "Bandra East", "Santacruz West", "Andheri East"],
    "Santacruz West": ["Khar West", "Juhu", "Bandra West", "Santacruz East", "Andheri West"],
    "Santacruz": ["Santacruz West", "Santacruz East", "Khar West", "Juhu", "Kalina"],
    "Andheri West": ["Juhu", "Lokhandwala", "Goregaon West", "Santacruz West", "Andheri East"],
    "Andheri East": ["Kalina", "Santacruz East", "Powai", "Andheri West", "Goregaon East"],
    "Andheri": ["Andheri West", "Andheri East", "Juhu", "Lokhandwala", "Goregaon East"],
    "Juhu": ["Santacruz West", "Khar West", "Andheri West", "Bandra West", "Lokhandwala"],
    "Goregaon West": ["Lokhandwala", "Andheri West", "Malad West", "Goregaon East"],
    "Goregaon East": ["Andheri East", "Powai", "Goregaon West", "Malad East"],
    "Goregaon": ["Goregaon West", "Goregaon East", "Andheri West", "Malad West"],
    "Malad West": ["Goregaon West", "Malad East", "Lokhandwala"],
    "Malad East": ["Goregaon East", "Malad West", "Powai"],
    "Malad": ["Malad West", "Malad East", "Goregaon West"],
}

_INTENT_SEARCH_VERBS = re.compile(
    r"\b(show|find|search|list|latest|top|give|fetch|look\s+up|do\s+we\s+have|any|available|availability)\b",
    re.IGNORECASE,
)
_INTENT_SAVE_VERBS = re.compile(r"\b(save|add|store|note|remember)\b", re.IGNORECASE)
_INTENT_NOTE_VERBS = re.compile(r"\b(note|notes|summari[sz]e|remember|log|record)\b", re.IGNORECASE)
_INTENT_CORRECTION_VERBS = re.compile(r"\b(correct|correction|update|change|mistake|wrong|actually|remove|delete)\b", re.IGNORECASE)
_INTENT_REQUIREMENT_NOUNS = re.compile(r"\b(requirement|requirements|buyer|buyers|client|clients|tenant|tenants|demand|against|matches?)\b", re.IGNORECASE)
_INTENT_LISTING_NOUNS = re.compile(r"\b(listing|listings|property|properties|flat|apartment|rentals?|sale|sell|buy|purchase|available|availability)\b", re.IGNORECASE)


def _user_message_texts(messages: list[dict]) -> list[str]:
    return [
        str(m.get("content") or "").strip()
        for m in messages
        if m.get("role") == "user" and str(m.get("content") or "").strip()
    ]


def _looks_like_property_terms(text: str) -> bool:
    lowered = text.lower()
    return bool(
        re.search(r"\b\d+(?:\.\d+)?\s*bhk\b|\bstudio\b", lowered)
        or any(re.search(rf"\b{re.escape(market.lower())}\b", lowered) for market in _KNOWN_MARKETS)
        or re.search(r"\b(?:₹|rs\.?\s*)?\d+(?:\.\d+)?\s*(?:cr|crore|crores|l|lac|lakh|lakhs|k)\b", lowered)
    )


def _classify_workspace_intent(messages: list[dict]) -> dict:
    """Classify the action before extracting fields.

    The old router let broad extractors compete. That made messages like
    "save this requirement" look like requirement searches because they also
    contained BHK/locality/budget terms.
    """
    user_messages = _user_message_texts(messages)
    if not user_messages:
        return {"intent": "UNKNOWN", "reason": "no_user_message"}

    latest = user_messages[-1]
    latest_lower = latest.lower()
    combined_with_previous = f"{user_messages[-2]} {latest}" if len(user_messages) > 1 else latest

    has_save = bool(_INTENT_SAVE_VERBS.search(latest_lower))
    has_requirement_noun = bool(_INTENT_REQUIREMENT_NOUNS.search(latest_lower))
    if has_save and (has_requirement_noun or re.search(r"\b(it|this|that)\b", latest_lower)):
        return {"intent": "SAVE_REQUIREMENT", "reason": "explicit_save_requirement"}

    has_note = bool(_INTENT_NOTE_VERBS.search(latest_lower))
    has_correction = bool(_INTENT_CORRECTION_VERBS.search(latest_lower))
    mentions_client_target = bool(re.search(r"\b(?:for|about|on)\s+[a-z][a-z .'-]{1,50}", latest_lower))
    if has_correction and (has_note or mentions_client_target):
        return {"intent": "UPDATE_CLIENT_NOTE", "reason": "client_note_correction"}
    if has_note and (mentions_client_target or len(user_messages) > 1):
        return {"intent": "SAVE_CLIENT_NOTE", "reason": "client_note"}

    if _extract_database_coverage_query(messages):
        return {"intent": "DATABASE_COVERAGE", "reason": "database_coverage"}

    if re.search(r"\b(nearby|similar|adjacent|around|other)\s+(market|markets|localit|areas?)\b", latest_lower):
        return {"intent": "NEARBY_MARKETS", "reason": "nearby_market_terms"}

    has_search = bool(_INTENT_SEARCH_VERBS.search(latest_lower))
    if has_search and re.search(r"\b(broker|brokers|agent|agents|dealer|dealers|who deals|who works)\b", latest_lower):
        return {"intent": "SEARCH_BROKERS", "reason": "broker_search"}

    if has_search and bool(_INTENT_REQUIREMENT_NOUNS.search(latest_lower)):
        return {"intent": "SEARCH_REQUIREMENTS", "reason": "requirement_search"}

    if has_search and (_INTENT_LISTING_NOUNS.search(latest_lower) or _looks_like_property_terms(combined_with_previous)):
        return {"intent": "SEARCH_LISTINGS", "reason": "listing_search"}

    return {"intent": "UNKNOWN", "reason": "no_explicit_action"}


def _extract_simple_listing_query(messages: list[dict]) -> dict | None:
    user_messages = _user_message_texts(messages)
    if not user_messages:
        return None

    text = user_messages[-1]
    lowered = text.lower()
    top_match = re.search(r"\b(?:top|best|show|give|need|want)?\s*(\d{1,2})\s*(?:of\s+)?(?:them|these|those|results|listings|properties)?\b", lowered)
    followup_limit = int(top_match.group(1)) if top_match else 0
    is_contextual_listing_followup = bool(
        followup_limit and re.search(r"\b(them|these|those|results|listings|properties|top|best)\b", lowered)
    )

    if is_contextual_listing_followup and len(user_messages) > 1:
        for previous in reversed(user_messages[:-1]):
            previous_args = _extract_simple_listing_query([{"role": "user", "content": previous}])
            if previous_args:
                previous_args = dict(previous_args)
                previous_args["limit"] = max(1, min(followup_limit, 10))
                previous_args["followup"] = True
                return previous_args

    if len(text) > 180 or _LISTING_SEARCH_BLOCKERS.search(text) or not _LISTING_SEARCH_SIGNAL.search(text):
        return None

    requested_limit_match = re.search(r"\b(?:top|latest|show|give)\s+(\d{1,2})\b", lowered)
    requested_limit = int(requested_limit_match.group(1)) if requested_limit_match else 5
    args: dict = {"limit": max(1, min(requested_limit, 10)), "sort_by": "last_seen", "group_by_building": True}

    bhk_match = re.search(r"\b(\d+(?:\.\d+)?)\s*bhk\b", lowered)
    if bhk_match:
        args["bhk"] = bhk_match.group(1)
    elif re.search(r"\bstudio\b", lowered):
        args["bhk"] = "STUDIO"

    if re.search(r"\b(rent|rental|rentals|lease|available|availability)\b", lowered):
        args["intent"] = "RENT"
    elif re.search(r"\b(sale|sales|sell|buy|purchase)\b", lowered):
        args["intent"] = "SELL"

    for market in _KNOWN_MARKETS:
        if re.search(rf"\b{re.escape(market.lower())}\b", lowered):
            args["micro_market"] = market
            break

    if "micro_market" not in args:
        loc_match = re.search(
            r"\b(?:in|at|near|around)\s+([a-z][a-z\s]{2,40}?)(?:\s+(?:under|below|above|over|with|for|rent|sale|buy|available)\b|[?.!,]|$)",
            lowered,
        )
        if loc_match:
            locality = " ".join(part.capitalize() for part in loc_match.group(1).split())
            if locality:
                args["micro_market"] = locality

    price_match = re.search(r"\b(?:under|below|upto|up to|max)\s*(?:₹|rs\.?\s*)?(\d+(?:\.\d+)?)\s*(cr|crore|crores|l|lac|lakh|lakhs|k)?\b", lowered)
    if price_match:
        amount = float(price_match.group(1))
        unit = (price_match.group(2) or "").lower()
        if unit in {"cr", "crore", "crores"}:
            amount *= 1_00_00_000
        elif unit in {"l", "lac", "lakh", "lakhs"}:
            amount *= 1_00_000
        elif unit == "k":
            amount *= 1_000
        args["price_max"] = amount

    if not any(key in args for key in ("bhk", "intent", "micro_market", "building", "price_max")):
        return None

    return args


def _extract_nearby_market_query(messages: list[dict]) -> dict | None:
    user_messages = _user_message_texts(messages)
    if not user_messages:
        return None

    latest = user_messages[-1].lower()
    if not re.search(r"\b(nearby|similar|adjacent|around|other)\s+(market|markets|localit|areas?)\b", latest):
        return None

    for previous in reversed(user_messages[:-1]):
        args = _extract_simple_listing_query([{"role": "user", "content": previous}])
        if args and args.get("micro_market"):
            args = dict(args)
            args["origin_market"] = args.pop("micro_market")
            return args

    for market in _KNOWN_MARKETS:
        if re.search(rf"\b{re.escape(market.lower())}\b", latest):
            return {"origin_market": market, "limit": 10, "sort_by": "last_seen", "group_by_building": True}

    return {"limit": 10, "sort_by": "last_seen", "group_by_building": True}


def _extract_simple_broker_query(messages: list[dict]) -> dict | None:
    user_messages = _user_message_texts(messages)
    if not user_messages:
        return None

    text = user_messages[-1]
    lowered = text.lower()
    if not re.search(r"\b(broker|brokers|agent|agents|dealer|dealers|who deals|who works)\b", lowered):
        return None

    args: dict = {"limit": 8}
    for market in _KNOWN_MARKETS:
        if re.search(rf"\b{re.escape(market.lower())}\b", lowered):
            args["micro_market"] = market
            break

    if "micro_market" not in args:
        loc_match = re.search(
            r"\b(?:in|at|near|around|for)\s+([a-z][a-z\s]{2,40}?)(?:\s+(?:with|who|top|active|broker|brokers|agent|agents)\b|[?.!,]|$)",
            lowered,
        )
        if loc_match:
            locality = " ".join(part.capitalize() for part in loc_match.group(1).split())
            if locality:
                args["micro_market"] = locality

    return args


def _extract_requirement_match_query(messages: list[dict]) -> dict | None:
    user_messages = _user_message_texts(messages)
    if not user_messages:
        return None

    latest = user_messages[-1].lower()
    wants_requirements = re.search(r"\b(requirement|requirements|buyer|buyers|client|clients|demand|against|match|matches)\b", latest)
    if not wants_requirements:
        return None

    args = _extract_simple_listing_query([{"role": "user", "content": user_messages[-1]}])
    if not args and len(user_messages) > 1:
        for previous in reversed(user_messages[:-1]):
            args = _extract_simple_listing_query([{"role": "user", "content": previous}])
            if args:
                break
    if not args:
        return None

    args = dict(args)
    args["limit"] = max(1, min(int(args.get("limit") or 5), 10))
    return args


def _extract_save_requirement_query(messages: list[dict]) -> dict | None:
    user_messages = _user_message_texts(messages)
    if not user_messages:
        return None

    latest = user_messages[-1]
    latest_lower = latest.lower()
    explicit_save = re.search(
        r"\b(save|add|store|note|remember)\b.*\b(requirement|requirements|client|buyer|tenant)\b"
        r"|\b(requirement|requirements)\b.*\b(save|add|store|note|remember)\b",
        latest_lower,
    )
    if not explicit_save:
        return None

    source_text = latest
    if len(user_messages) > 1 and re.search(r"\b(it|this|that)\b", latest_lower):
        source_text = user_messages[-2]

    details = source_text.strip()
    if not details:
        return None

    combined = f"{details} {latest}" if source_text != latest else details
    lowered = combined.lower()

    args: dict = {"source_text": details, "notes": details}

    client_match = re.search(
        r"\bclient\s+([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,4})",
        details,
        flags=re.IGNORECASE,
    )
    if client_match:
        name = client_match.group(1).strip()
        name = re.split(r"\s+(?:looking|needs?|wants?|seeking|requirement)\b", name, maxsplit=1, flags=re.IGNORECASE)[0].strip()
        if name:
            args["client_name"] = " ".join(part.capitalize() for part in name.split())
    if "client_name" not in args:
        args["client_name"] = "WhatsApp Client"

    if re.search(r"\b(rent|rental|lease|tenant|per\s+month|lock\s*in|lock-in)\b", lowered):
        args["intent"] = "RENT"
    else:
        args["intent"] = "BUY"

    bhks = re.findall(r"\b(\d+(?:\.\d+)?)\s*bhk\b", lowered, flags=re.IGNORECASE)
    if bhks:
        unique_bhks = []
        for bhk in bhks:
            label = f"{bhk:g} BHK" if isinstance(bhk, float) else f"{bhk} BHK"
            if label not in unique_bhks:
                unique_bhks.append(label)
        args["bhk"] = "/".join(unique_bhks[:3])

    for market in _KNOWN_MARKETS:
        if re.search(rf"\b{re.escape(market.lower())}\b", lowered):
            args["micro_market"] = market
            break

    furnishing_parts = []
    if re.search(r"\bfully\s+furnished\b", lowered):
        furnishing_parts.append("Fully Furnished")
    if re.search(r"\bsemi\s+furnished\b", lowered):
        furnishing_parts.append("Semi Furnished")
    if furnishing_parts:
        args["furnishing"] = "/".join(furnishing_parts)

    budget_match = re.search(
        r"\bbudget\s*(?:is|of|around|approx(?:imately)?|:)?\s*(?:₹|rs\.?\s*)?"
        r"(\d+(?:\.\d+)?)\s*(?:-|to|–|—)\s*(\d+(?:\.\d+)?)\s*"
        r"(cr|crore|crores|l|lac|lakh|lakhs|k)?\b",
        lowered,
    )
    if not budget_match:
        budget_match = re.search(
            r"\b(?:under|below|upto|up to|max|budget)\s*(?:₹|rs\.?\s*)?"
            r"(\d+(?:\.\d+)?)\s*(cr|crore|crores|l|lac|lakh|lakhs|k)?\b",
            lowered,
        )

    def amount_to_rupees(value: str, unit: str | None) -> float:
        amount = float(value)
        unit = (unit or "").lower()
        if unit in {"cr", "crore", "crores"}:
            return amount * 1_00_00_000
        if unit in {"l", "lac", "lakh", "lakhs"}:
            return amount * 1_00_000
        if unit == "k":
            return amount * 1_000
        return amount

    if budget_match:
        if len(budget_match.groups()) == 3:
            unit = budget_match.group(3)
            args["price_min"] = amount_to_rupees(budget_match.group(1), unit)
            args["price_max"] = amount_to_rupees(budget_match.group(2), unit)
        else:
            args["price_max"] = amount_to_rupees(budget_match.group(1), budget_match.group(2))

    lock_in = re.search(r"\b(\d+(?:\.\d+)?)\s*months?\s+lock\s*in\b|\block\s*in\s*(?:of\s*)?(\d+(?:\.\d+)?)\s*months?\b", lowered)
    if lock_in:
        months = lock_in.group(1) or lock_in.group(2)
        args["notes"] = f"{details}\nLock-in: {months} months"

    if not any(args.get(key) for key in ("bhk", "micro_market", "price_max", "furnishing")):
        return None

    return args


def _format_requirement_budget(args: dict) -> str:
    price_min = args.get("price_min")
    price_max = args.get("price_max")

    def fmt(value: object) -> str:
        try:
            amount = float(value)
        except (TypeError, ValueError):
            return ""
        if amount >= 1_00_00_000:
            return f"₹{amount / 1_00_00_000:g} Cr"
        if amount >= 1_00_000:
            return f"₹{amount / 1_00_000:g} L"
        return f"₹{amount:,.0f}"

    if price_min and price_max:
        return f"{fmt(price_min)}-{fmt(price_max)}"
    if price_max:
        return f"up to {fmt(price_max)}"
    return ""


def _save_requirement_response(args: dict) -> dict:
    store = _get_client_store()
    client_name = str(args.get("client_name") or "WhatsApp Client").strip()
    resolved = store.resolve_client(client_name) if hasattr(store, "resolve_client") else None
    client_id = resolved.get("id") if resolved else None
    if client_id:
        client_name = resolved.get("name") or client_name
    else:
        client_id = store.create_client(client_name, notes="Created from WhatsApp self-chat requirement.")

    requirement_id = store.add_client_requirement(
        int(client_id),
        str(args.get("intent") or "BUY").upper(),
        bhk=args.get("bhk"),
        price_min=args.get("price_min"),
        price_max=args.get("price_max"),
        micro_market=args.get("micro_market"),
        furnishing=args.get("furnishing"),
        notes=args.get("notes") or args.get("source_text") or "",
    )

    details = " · ".join(
        part
        for part in [
            str(args.get("intent") or "").upper(),
            str(args.get("bhk") or "").strip(),
            str(args.get("micro_market") or "").strip(),
            _format_requirement_budget(args),
            str(args.get("furnishing") or "").strip(),
        ]
        if part
    )
    return {
        "content": f"Saved requirement for {client_name}." + (f" {details}." if details else ""),
        "blocks": [
            {
                "type": "summary",
                "title": "Requirement Saved",
                "body": f"Client #{client_id}, requirement #{requirement_id}.",
            }
        ],
        "sources": ["clients", "client_requirements"],
        "status_steps": ["Parsed save request", "Saved client", "Saved requirement"],
        "trace": {"route": "deterministic_save_requirement", "args": args, "client_id": client_id, "requirement_id": requirement_id},
    }


def _extract_client_target_and_note(text: str) -> tuple[str, str]:
    clean = (text or "").strip()
    patterns = [
        r"\b(?:for|about|on)\s+([A-Za-z][A-Za-z .'-]{1,50}?)(?:\s*[:,-]\s*|\s+that\s+|\s+is\s+|\s+was\s+)(.+)$",
        r"\b([A-Za-z][A-Za-z .'-]{1,50}?)\s+(?:note|notes)\s*[:,-]\s*(.+)$",
        r"\b(?:note|notes|remember|record|log)\s+([A-Za-z][A-Za-z .'-]{1,50}?)(?:\s*[:,-]\s*|\s+that\s+)(.+)$",
    ]
    for pattern in patterns:
        match = re.search(pattern, clean, flags=re.IGNORECASE | re.DOTALL)
        if match:
            client = re.sub(r"\b(note|notes|correction|update|client)\b", "", match.group(1), flags=re.IGNORECASE)
            client = re.sub(r"\s+", " ", client).strip(" .,:;-")
            note = match.group(2).strip()
            if client and note:
                return client, note

    target_only = re.search(r"\b(?:for|about|on)\s+([A-Za-z][A-Za-z .'-]{1,50})\b", clean, flags=re.IGNORECASE)
    if target_only:
        client = re.sub(r"\b(note|notes|correction|update|client)\b", "", target_only.group(1), flags=re.IGNORECASE)
        client = re.sub(r"\s+", " ", client).strip(" .,:;-")
        return client, ""

    return "", clean


def _extract_client_note_query(messages: list[dict], correction: bool = False) -> dict | None:
    user_messages = _user_message_texts(messages)
    if not user_messages:
        return None

    latest = user_messages[-1]
    client_name, note_body = _extract_client_target_and_note(latest)
    if not note_body and len(user_messages) > 1:
        note_body = user_messages[-2].strip()

    if not client_name:
        return None

    remove_latest = bool(re.search(r"\b(remove|delete)\b.*\b(last|latest|previous)\b.*\b(note|notes)\b", latest, re.IGNORECASE))
    replace_latest = bool(re.search(r"\b(replace|overwrite)\b.*\b(last|latest|previous)\b.*\b(note|notes)\b", latest, re.IGNORECASE))
    note_body = re.sub(r"^\s*(note|notes|correction|update|remember|record|log)\s*[:,-]?\s*", "", note_body, flags=re.IGNORECASE).strip()
    if not note_body and not remove_latest:
        return None

    return {
        "client_name": " ".join(part.capitalize() for part in client_name.split()),
        "body": note_body,
        "source_text": latest,
        "note_type": "correction" if correction else "note",
        "remove_latest": remove_latest,
        "replace_latest": replace_latest,
    }


def _client_note_response(args: dict) -> dict:
    store = _get_client_store()
    client_query = str(args.get("client_name") or "").strip()
    resolved = store.resolve_client(client_query) if hasattr(store, "resolve_client") else None
    if resolved:
        client_id = int(resolved["id"])
        client_name = resolved.get("name") or client_query
        match_method = resolved.get("match_method", "exact")
    else:
        client_name = client_query
        client_id = store.create_client(client_name, notes="Created from WhatsApp self-chat notes.")
        match_method = "created"

    if hasattr(store, "add_client_alias"):
        store.add_client_alias(client_id, client_query, source="whatsapp_note", confidence=0.9)

    if args.get("remove_latest"):
        latest_note = store.get_latest_client_note(client_id) if hasattr(store, "get_latest_client_note") else None
        if not latest_note:
            return {
                "content": f"No active notes found for {client_name}.",
                "blocks": [],
                "sources": ["client_notes"],
                "trace": {"route": "deterministic_client_note_remove", "client_id": client_id},
            }
        store.update_client_note(int(latest_note["id"]), latest_note["body"], is_active=0)
        return {
            "content": f"Removed latest active note for {client_name}.",
            "blocks": [{"type": "summary", "title": "Note Removed", "body": f"Note #{latest_note['id']} marked inactive."}],
            "sources": ["client_notes"],
            "trace": {"route": "deterministic_client_note_remove", "client_id": client_id, "note_id": latest_note["id"]},
        }

    supersedes_note_id = None
    if args.get("replace_latest") and hasattr(store, "get_latest_client_note"):
        latest_note = store.get_latest_client_note(client_id)
        supersedes_note_id = int(latest_note["id"]) if latest_note else None

    note_id = store.add_client_note(
        client_id,
        str(args.get("body") or ""),
        note_type=str(args.get("note_type") or "note"),
        source_text=str(args.get("source_text") or ""),
        confidence=0.95 if args.get("note_type") == "correction" else 0.9,
        supersedes_note_id=supersedes_note_id,
    )
    action = "Updated notes" if args.get("note_type") == "correction" else "Saved note"
    return {
        "content": f"{action} for {client_name}.",
        "blocks": [
            {
                "type": "summary",
                "title": "Client Note",
                "body": f"Client #{client_id}, note #{note_id}. Match: {match_method}.",
            }
        ],
        "sources": ["clients", "client_aliases", "client_notes"],
        "status_steps": ["Resolved client", "Saved client note"],
        "trace": {"route": "deterministic_client_note", "client_id": client_id, "note_id": note_id, "args": args},
    }


def _extract_database_coverage_query(messages: list[dict]) -> bool:
    user_messages = [
        str(m.get("content") or "").strip()
        for m in messages
        if m.get("role") == "user" and str(m.get("content") or "").strip()
    ]
    if not user_messages:
        return False

    lowered = user_messages[-1].lower()
    has_database = re.search(r"\b(data|database|db|access|source|sources|coverage|what can you access)\b", lowered)
    has_propai = "propai" in lowered or "database" in lowered or "db" in lowered
    return bool(has_database and has_propai)


def _greeting_text(name: str | None = None) -> str:
    hour = datetime.now().hour
    display = f" {name}" if name else ""
    if hour < 12:
        return f"Morning{display}! What's on your mind?"
    if hour < 17:
        return f"Hey{display}, how's it going?"
    return f"Hey{display}, what are we working on?"


def _casual_small_talk_responses() -> list[str]:
    return [
        "Doing great! What can I help you find?",
        "All good here! What are you looking for?",
        "Busy as always, but ready to help. What do you need?",
        "Can't complain! What's up?",
        "Smooth sailing. How can I assist?",
    ]


def _get_casual_response(messages: list[dict]) -> dict | None:
    """Check the last user message for casual/greeting content. Returns a natural response or None."""
    import random
    latest = ""
    for message in reversed(messages):
        if message.get("role") == "user":
            latest = str(message.get("content") or "").strip()
            break
    if not latest:
        return None
    lowered = latest.lower().strip(".!?,;")

    # ── Extract user name if shared ──
    name = None
    identity_match = re.search(r"\bi'?m?\s+(.+?)(?:\.|\?|,|$)", latest, re.IGNORECASE)
    if identity_match:
        candidate = identity_match.group(1).strip()
        if candidate.lower() not in {"good", "just", "not", "fine", "ok", "alright", "ready", "done", "here"}:
            name = candidate

    # ── Greetings ──
    greeting_pattern = re.compile(
        r"^(hi|hey|hello|howdy|yo|sup|hey there|hello there|hiya|heyy|heyyy)"
        r"( .+)?[.!]*$", re.IGNORECASE
    )
    time_greeting_pattern = re.compile(
        r"^(good\s+)?(morning|afternoon|evening)"
        r"(\s+(dude|boss|bro|sir|ma'am|vishal|propai|team))?[.!]*$", re.IGNORECASE
    )
    if greeting_pattern.match(lowered) or time_greeting_pattern.match(lowered.strip()):
        return {
            "content": _greeting_text(name),
            "blocks": [{"type": "greeting", "body": _greeting_text(name)}],
            "sources": [],
            "trace": {"route": "casual"},
        }

    # ── How are you / Check-in ──
    how_are_you_pattern = re.compile(
        r"^(how (are|'re|was|'s) (you|things|it going|everything|your day)"
        r"|(what('s| is) up|how's it hanging|how do you do|how are you doing)"
        r"|(you (good|ok|alright)\??))[.!?]*$", re.IGNORECASE
    )
    if how_are_you_pattern.match(lowered):
        reply = random.choice(_casual_small_talk_responses())
        return {
            "content": reply,
            "blocks": [{"type": "greeting", "body": reply}],
            "sources": [],
            "trace": {"route": "casual"},
        }

    # ── Thanks ──
    thanks_pattern = re.compile(
        r"^(thanks|thank you|thanks a lot|thank you so much|thanks much"
        r"|appreciate it|appreciate that|cheers|ta|thx|ty)[.!]*$", re.IGNORECASE
    )
    if thanks_pattern.match(lowered):
        reply = random.choice([
            "You're welcome! Anything else?",
            "Happy to help! What's next?",
            "Anytime! Need anything else?",
            "Glad I could help!",
        ])
        return {
            "content": reply,
            "blocks": [{"type": "greeting", "body": reply}],
            "sources": [],
            "trace": {"route": "casual"},
        }

    # ── Goodbyes ──
    goodbye_pattern = re.compile(
        r"^(bye|goodbye|see you|see ya|see you later|talk later|talk soon"
        r"|gotta go|got to go|gotta run|cya|later|catch you later"
        r"|peace out|take care)[.!]*$", re.IGNORECASE
    )
    if goodbye_pattern.match(lowered):
        reply = random.choice([
            "See you later!",
            "Take care!",
            "Catch you later!",
            "Bye! Hit me up anytime.",
        ])
        return {
            "content": reply,
            "blocks": [{"type": "greeting", "body": reply}],
            "sources": [],
            "trace": {"route": "casual"},
        }

    # ── Simple acknowledgments ──
    ack_pattern = re.compile(
        r"^(ok|okay|alright|sure|got it|understood|cool|nice|great|awesome"
        r"|good|fine|perfect|roger|done|works|makes sense)[.!]*$", re.IGNORECASE
    )
    if ack_pattern.match(lowered):
        return {
            "content": "Got it. What's next?",
            "blocks": [{"type": "greeting", "body": "Got it. What's next?"}],
            "sources": [],
            "trace": {"route": "casual"},
        }

    # ── Identity / Intro ──
    identity_intro = re.compile(
        r"^(who are you|what are you|tell me about yourself"
        r"|what can you do|how can you help|what do you do)[.!?]*$", re.IGNORECASE
    )
    if identity_intro.match(lowered):
        reply = (
            "I'm PropAI — your WhatsApp broker assistant. I help you search listings, "
            "track requirements, find brokers, and keep an eye on the market. "
            "Just ask me anything about properties, brokers, buildings, or markets."
        )
        return {
            "content": reply,
            "blocks": [{"type": "greeting", "body": reply}],
            "sources": [],
            "trace": {"route": "casual"},
        }

    # ── "I am <name>" context (solo, without rings_bell) ──
    if identity_match and not re.search(r"\b(ring a bell|know me|remember me|who am i)\b", lowered):
        if name and name.lower() not in {"good", "just", "fine", "ok", "alright", "ready", "done", "here"}:
            reply = f"Nice to meet you, {name}! How can I help?"
            return {
                "content": reply,
                "blocks": [{"type": "greeting", "body": reply}],
                "sources": [],
                "trace": {"route": "casual_identity"},
            }

    return None


# ── Intent Router ──────────────────────────────────────────────
# Shared by WhatsApp self-chat, AI Chat, and Ask PropAI.
# Returns a response dict if intent is matched, or None for LLM fallback.

_CAPABILITY_SIGNALS = re.compile(
    r"\b(what (?:can|do) you (?:access|see)|"
    r"do you have (?:access to (?:the )?(?:database|data|system)|(?:a )?database (?:access|connection))|"
    r"what (?:data|datasets?|tools?) (?:do you have|can you use|are available)|"
    r"your (?:capabilities?|abilities|features?)|"
    r"what are you able to|"
    r"can you (?:access|write to|modify|delete) (?:the )?(?:database|data|system|tables?))\b",
    re.IGNORECASE,
)


def _has_query_signals(text: str) -> bool:
    """Check whether text contains signals suggesting a data query (vs conversation)."""
    lowered = text.lower()
    query_keywords = [
        "bhk", "rent", "buy", "sale", "lease", "price", "budget", "area", "sqft",
        "broker", "agent", "dealer", "builder", "owner",
        "building", "complex", "tower", "society", "project",
        "locality", "market", "area", "neighbourhood", "neighborhood",
        "flat", "apartment", "office", "shop", "property", "commercial",
        "listing", "listings", "properties", "deal", "requirement", "requirements",
        "show", "find", "search", "look", "need", "want",
        "cr", "lakh", "lac", "thousand", "crore",
        "bandra", "andheri", "juhu", "khar", "powai", "malad", "goregaon",
        "santacruz", "vile parle", "dadar", "worli", "lower parel", "bkc", "kalina",
        "lokhandwala", "pali hill", "chembur", "navi mumbai", "thane",
        "duplicate", "merge", "alias",
        "how many", "how much", "count ", "list ", "top ",
        "compare", "versus", "vs",
    ]
    return any(kw in lowered for kw in query_keywords)


def _assert_model_url_match(model: str, base_url: str) -> None:
    """Log a warning if the model string doesn't match the provider's base URL.

    This catches silent misrouting where a model intended for one provider
    ends up being sent to a different provider's endpoint.
    """
    known_mappings = [
        (["nvidia/"], ["integrate.api.nvidia.com"]),
        (["gemini-"], ["generativelanguage.googleapis.com"]),
        (["deepseek-ai/"], ["api.doubleword.ai"]),
        (["llama-", "mixtral-"], ["api.groq.com", "api.cerebras.ai"]),
    ]
    model_lower = model.lower()
    matched_providers = []
    for models, base_patterns in known_mappings:
        if any(model_lower.startswith(m) for m in models):
            matched_providers.append((models, base_patterns))
    if not matched_providers:
        return
    url_lower = base_url.lower()
    for models, base_patterns in matched_providers:
        if not any(p in url_lower for p in base_patterns):
            _logger.error(
                "MODEL-URL MISMATCH: model '%s' suggests %s but base_url is '%s' — "
                "request will be silently misrouted!",
                model, models, base_url,
            )


def _format_listing_price(item: dict) -> str:
    price = item.get("price")
    if price in (None, ""):
        return ""
    try:
        value = float(price)
    except (TypeError, ValueError):
        return str(price)
    unit = str(item.get("price_unit") or "").lower()
    is_rent = item.get("intent") == "RENT"
    suffix = "/month" if is_rent else ""
    if is_rent and unit in {"", "none", "null", "abs"}:
        if 0 < value < 100:
            return f"₹{value:g} L/month"
        if 100 <= value < 1000:
            return f"₹{value:g} K/month"
        if 1000 <= value < 10000:
            return f"₹{value / 1000:g} L/month"
    if unit in {"lac", "lakh", "l"}:
        return f"₹{value:g} L{suffix}"
    if unit in {"cr", "crore"}:
        return f"₹{value:g} Cr"
    if unit == "k":
        return f"₹{value:g} K{suffix}"
    if value >= 1_00_00_000:
        return f"₹{value / 1_00_00_000:.2f} Cr"
    if value >= 1_00_000:
        return f"₹{value / 1_00_000:.1f} L{suffix}"
    return f"₹{value:,.0f}{suffix}"


def _normalize_real_phone(value: object) -> str:
    digits = re.sub(r"\D+", "", str(value or ""))
    if len(digits) == 10:
        return digits
    if len(digits) == 12 and digits.startswith("91"):
        return digits[-10:]
    if len(digits) == 11 and digits.startswith("0"):
        return digits[-10:]
    return ""


def _is_plausible_listing_result(item: dict, args: dict) -> bool:
    requested_intent = str(args.get("intent") or "").upper()
    item_intent = str(item.get("intent") or "").upper()
    if requested_intent and item_intent and item_intent != requested_intent:
        return False

    requested_bhk = str(args.get("bhk") or "").strip().upper()
    item_bhk = str(item.get("bhk") or "").strip().upper()
    if requested_bhk and requested_bhk != "STUDIO":
        compact_requested = requested_bhk.replace(" ", "")
        compact_item = item_bhk.replace(" ", "")
        if compact_item and compact_requested not in compact_item:
            return False

    if requested_intent == "RENT":
        unit = str(item.get("price_unit") or "").strip().lower()
        try:
            price = float(item.get("price")) if item.get("price") not in (None, "") else 0
        except (TypeError, ValueError):
            price = 0
        if unit in {"cr", "crore", "crores"}:
            return False
        if unit in {"abs", "absolute", "rupees", "rs", "inr", ""} and price >= 1_00_00_000:
            return False

    return True


def _raw_listing_fallback(args: dict, limit: int = 10) -> tuple[int, list[dict]]:
    con = getattr(storage, "db", None) if storage is not None else None
    if con is None:
        raise RuntimeError("Database is not available")

    where_clauses = []
    params: list[object] = []

    intent = str(args.get("intent") or "").strip().upper()
    if intent:
        where_clauses.append("EXISTS (SELECT 1 FROM parsed_output p WHERE p.raw_message_id = r.id AND p.intent = ?)")
        params.append(intent)

    bhk = str(args.get("bhk") or "").strip()
    if bhk:
        bhk_label = bhk if bhk.upper().endswith("BHK") or bhk.upper() == "STUDIO" else f"{bhk} BHK"
        bhk_compact = bhk_label.replace(" ", "")
        where_clauses.append("(r.message LIKE ? OR r.message LIKE ?)")
        params.extend([f"%{bhk_label}%", f"%{bhk_compact}%"])

    market = str(args.get("micro_market") or "").strip()
    if market:
        like = f"%{market}%"
        where_clauses.append("r.message LIKE ?")
        params.append(like)

    building = str(args.get("building") or "").strip()
    if building:
        like = f"%{building}%"
        where_clauses.append("r.message LIKE ?")
        params.append(like)

    price_max = args.get("price_max")
    if price_max:
        where_clauses.append("EXISTS (SELECT 1 FROM parsed_output p WHERE p.raw_message_id = r.id AND p.price IS NOT NULL AND p.price <= ?)")
        params.append(float(price_max))

    where_sql = " AND ".join(where_clauses) if where_clauses else "1=1"
    try:
        broad_total = con.execute(
            f"""
            SELECT COUNT(DISTINCT r.id)
            FROM raw_messages r
            WHERE {where_sql}
            """,
            params,
        ).fetchone()[0]

        rows = con.execute(
            f"""
            SELECT
                r.id AS raw_message_id,
                r.group_name,
                r.sender_phone,
                r.sender,
                r.timestamp,
                r.message AS original_message,
                (
                    SELECT p.intent FROM parsed_output p
                    WHERE p.raw_message_id = r.id AND p.intent IS NOT NULL AND p.intent != ''
                    ORDER BY p.confidence DESC LIMIT 1
                ) AS intent,
                (
                    SELECT p.broker_name FROM parsed_output p
                    WHERE p.raw_message_id = r.id AND p.broker_name IS NOT NULL AND p.broker_name != ''
                    ORDER BY p.confidence DESC LIMIT 1
                ) AS broker_name,
                (
                    SELECT p.broker_phone FROM parsed_output p
                    WHERE p.raw_message_id = r.id AND p.broker_phone IS NOT NULL AND p.broker_phone != ''
                    ORDER BY p.confidence DESC LIMIT 1
                ) AS broker_phone
            FROM raw_messages r
            WHERE {where_sql}
            ORDER BY r.timestamp DESC
            LIMIT ?
            """,
            (*params, max(limit * 100, 250)),
        ).fetchall()

        results: list[dict] = []
        for row in rows:
            item = dict(row)
            message = str(item.get("original_message") or "")
            needle = market or building or bhk
            if needle:
                idx = message.lower().find(needle.lower())
                if idx >= 0:
                    start = max(0, idx - 180)
                    end = min(len(message), idx + 420)
                    snippet = message[start:end].strip()
                else:
                    snippet = message[:600].strip()
            else:
                snippet = message[:600].strip()

            if bhk:
                snippet_lower = snippet.lower()
                if bhk_label.lower() not in snippet_lower and bhk_compact.lower() not in snippet_lower:
                    continue

            item["original_message"] = snippet
            item["fingerprint"] = f"raw:{item.get('raw_message_id')}"
            item["bhk"] = bhk_label if bhk else None
            item["price"] = None
            item["price_unit"] = ""
            item["area_sqft"] = None
            item["furnishing"] = ""
            item["building_name"] = None
            item["landmark_name"] = None
            item["micro_market"] = market or ""
            item["location_label"] = market or building or ""
            item["first_seen"] = item.get("timestamp")
            item["last_seen"] = item.get("timestamp")
            item["observation_count"] = 1
            item["group_count"] = 1 if item.get("group_name") else 0
            item["broker_phone"] = item.get("broker_phone") or item.get("sender_phone") or ""
            item["broker_name"] = item.get("broker_name") or item.get("sender") or ""
            item["match_reasons"] = [
                reason
                for reason in [
                    f"Raw message mentions {market}" if market else "",
                    f"Raw message mentions {bhk_label}" if bhk else "",
                    item.get("intent") or "",
                ]
                if reason
            ]
            item["source"] = "parsed_whatsapp_message"
            results.append(item)

        return len(results) if rows else int(broad_total or 0), results[:limit]
    finally:
        pass


def _listing_search_response(args: dict) -> dict:
    requested_limit = max(1, min(int(args.get("limit") or 5), 10))
    tool_args = dict(args)
    tool_args["limit"] = max(requested_limit * 3, requested_limit)
    raw = chat_engine.execute_tool("market_search", tool_args, {}, db_path=getattr(storage, "db", None))
    try:
        payload = json.loads(raw)
    except Exception:
        return {
            "content": "I could not search listings right now.",
            "blocks": [{"type": "error_state", "title": "Listing search failed", "body": str(raw)}],
            "sources": ["unique_listings"],
            "status_steps": ["Searching saved properties"],
        }

    results = payload.get("results") or []
    if isinstance(results, list):
        results = [item for item in results if isinstance(item, dict) and _is_plausible_listing_result(item, args)]
        results = results[:requested_limit]
    for item in results:
        item["price_formatted"] = _format_listing_price(item)

    bhk_label = f"{args['bhk']} BHK " if args.get("bhk") and str(args.get("bhk")).upper() != "STUDIO" else ""
    intent_label = "rentals" if args.get("intent") == "RENT" else "sale properties" if args.get("intent") == "SELL" else "properties"
    market_label = f" in {args['micro_market']}" if args.get("micro_market") else ""
    query_label = f"{bhk_label}{intent_label}{market_label}".strip()
    total = int(payload.get("total") or 0)

    fallback_total = 0
    fallback_results: list[dict] = []
    if not results:
        fallback_total, fallback_results = _raw_listing_fallback(args)
        for item in fallback_results:
            item["price_formatted"] = _format_listing_price(item)

    if not results and not fallback_results:
        suggestions = []
        if args.get("micro_market"):
            suggestions.append(f"Show all 3 BHK rentals near {args['micro_market']}" if args.get("bhk") else f"Show all rentals near {args['micro_market']}")
        suggestions.extend(["Search nearby markets", "Show latest rentals", "Show requirements instead"])
        return {
            "content": f"No exact matches found for {query_label}.",
            "blocks": [
                {
                    "type": "empty_state",
                    "title": "No exact matches",
                    "body": f"PropAI searched saved WhatsApp property records for {query_label}.",
                    "actions": [{"label": option, "value": option} for option in suggestions[:4]],
                },
                {"type": "suggested_questions", "title": "Try next", "items": suggestions[:4]},
            ],
            "sources": ["unique_listings"],
            "status_steps": ["Parsed property search", "Searched saved properties", "Rendered results"],
            "trace": {"route": "deterministic_listing_search", "args": args},
        }

    if not results and fallback_results:
        shown = len(fallback_results)
        return {
            "content": f"Found {fallback_total} raw WhatsApp matches for {query_label}. Showing the latest {shown}.",
            "blocks": [
                {
                    "type": "summary",
                    "title": "Raw WhatsApp Matches",
                    "body": "These matches came from parsed/raw WhatsApp messages because the normalized property record did not have the locality indexed exactly.",
                },
                {
                    "type": "listing_cards",
                    "title": query_label.title(),
                    "subtitle": f"{fallback_total} raw WhatsApp matches",
                    "items": fallback_results,
                    "body": "Sorted by latest captured message",
                },
                {
                    "type": "suggested_questions",
                    "title": "Refine",
                    "items": [
                        f"Show brokers for {query_label}",
                        f"Show only sale {query_label}",
                        f"Show only rental {query_label}",
                        f"Search nearby Bandra listings",
                    ],
                },
            ],
            "sources": ["market_feed", "raw_messages", "parsed_output"],
            "status_steps": ["Parsed property search", "Searched saved properties", "Searched raw WhatsApp messages", "Rendered results"],
            "trace": {"route": "deterministic_listing_raw_fallback", "args": args, "total": fallback_total},
        }

    shown = len(results)
    remaining = max(0, total - shown)
    return {
        "content": f"Found {total} {query_label}. Showing the latest {shown}." + (f" {remaining} more available." if remaining else ""),
        "blocks": [
            {
                "type": "summary",
                "title": "Result",
                "body": f"Found {total} {query_label}. Showing the latest {shown} saved from WhatsApp." + (f" {remaining} more available." if remaining else ""),
            },
            {
                "type": "listing_cards",
                "title": query_label.title(),
                "subtitle": f"{total} matching property records",
                "items": results,
                "body": "Sorted by latest seen",
            },
            {
                "type": "suggested_questions",
                "title": "Refine",
                "items": [
                    f"{query_label} under 3 L",
                    f"Furnished {query_label}",
                    f"Show brokers for {query_label}",
                    f"Show original messages for {query_label}",
                ],
            },
        ],
        "sources": ["unique_listings"],
        "status_steps": ["Parsed property search", "Searched saved properties", "Rendered results"],
        "trace": {"route": "deterministic_listing_search", "args": args, "total": total},
    }


def _requirement_match_response(args: dict) -> dict:
    limit = max(1, min(int(args.get("limit") or 5), 10))
    listing_intent = str(args.get("intent") or "").upper()
    requirement_intents = ("RENTAL_SEEKER",) if listing_intent == "RENT" else ("BUY", "BUYER")

    where = ["p.intent IN ({})".format(",".join("?" for _ in requirement_intents))]
    params: list[object] = list(requirement_intents)

    bhk = str(args.get("bhk") or "").strip()
    if bhk:
        bhk_label = bhk if bhk.upper().endswith("BHK") else f"{bhk} BHK"
        where.append("(p.bhk LIKE ? OR r.message LIKE ? OR r.message LIKE ?)")
        params.extend([f"%{bhk}%", f"%{bhk_label}%", f"%{bhk_label.replace(' ', '')}%"])

    market = str(args.get("micro_market") or "").strip()
    if market:
        like = f"%{market}%"
        where.append("(p.micro_market LIKE ? OR p.location_raw LIKE ? OR p.area LIKE ? OR r.message LIKE ?)")
        params.extend([like, like, like, like])

    building = str(args.get("building") or "").strip()
    if building:
        like = f"%{building}%"
        where.append("(p.building_name LIKE ? OR r.message LIKE ?)")
        params.extend([like, like])

    price = args.get("price")
    price_max = args.get("price_max") or price
    if price_max:
        try:
            max_value = float(price_max)
            where.append("(p.price IS NULL OR p.price = 0 OR p.price >= ?)")
            params.append(max_value)
        except (TypeError, ValueError):
            pass

    where_sql = " AND ".join(where)
    def run_requirement_query(sql_where: str, sql_params: list[object]):
        count = storage.db.execute(
            f"""
            SELECT COUNT(*)
            FROM parsed_output p
            JOIN raw_messages r ON r.id = p.raw_message_id
            WHERE {sql_where}
            """,
            sql_params,
        ).fetchone()[0]

        result_rows = storage.db.execute(
            f"""
            SELECT
                p.id,
                p.intent,
                p.bhk,
                p.price,
                p.price_unit,
                p.area_sqft,
                p.furnishing,
                p.building_name,
                p.micro_market,
                p.location_raw,
                p.broker_name,
                p.broker_phone,
                p.confidence,
                r.message,
                r.group_name,
                r.sender,
                r.sender_phone,
                r.timestamp
            FROM parsed_output p
            JOIN raw_messages r ON r.id = p.raw_message_id
            WHERE {sql_where}
            GROUP BY r.id
            ORDER BY COALESCE(r.timestamp, p.created_at, r.created_at) DESC, p.id DESC
            LIMIT ?
            """,
            (*sql_params, max(limit * 3, limit)),
        ).fetchall()
        return count, result_rows

    total, rows = run_requirement_query(where_sql, params)
    used_broad_fallback = False
    if not rows and requirement_intents != ("BUY", "BUYER", "RENTAL_SEEKER"):
        broad_where = ["p.intent IN ('BUY','BUYER','RENTAL_SEEKER')"] + where[1:]
        broad_params = params[len(requirement_intents):]
        total, rows = run_requirement_query(" AND ".join(broad_where), broad_params)
        used_broad_fallback = bool(rows)

    items: list[dict] = []
    seen_requirement_keys: set[tuple[str, str, str, str]] = set()
    for row in rows:
        item = dict(row)
        item["price_formatted"] = _format_listing_price(item)
        item["broker_name"] = item.get("broker_name") or item.get("sender") or ""
        item["broker_phone"] = _normalize_real_phone(item.get("broker_phone")) or _normalize_real_phone(item.get("sender_phone"))
        if item["broker_phone"] and str(item["broker_name"]).strip().startswith("+"):
            item["broker_name"] = "Broker"
        dedupe_key = (
            item.get("broker_phone") or item.get("broker_name") or "",
            str(item.get("bhk") or ""),
            str(item.get("price") or ""),
            str(item.get("micro_market") or item.get("location_raw") or "")[:80],
        )
        if dedupe_key in seen_requirement_keys:
            continue
        seen_requirement_keys.add(dedupe_key)
        item["match_reasons"] = [
            reason
            for reason in [
                f"{bhk} BHK" if bhk else "",
                market if market else "",
                "Rental seeker" if listing_intent == "RENT" else "Buyer requirement",
            ]
            if reason
        ]
        item["original_message"] = str(item.get("message") or "")[:500]
        items.append(item)
        if len(items) >= limit:
            break

    bhk_label = f"{bhk} BHK " if bhk else ""
    intent_label = "rental requirements" if listing_intent == "RENT" and not used_broad_fallback else "buyer/rental requirements"
    market_label = f" in {market}" if market else ""
    query_label = f"{bhk_label}{intent_label}{market_label}".strip()

    if not items:
        return {
            "content": f"No matching requirements found for {query_label}.",
            "blocks": [
                {
                    "type": "empty_state",
                    "title": "No matching requirements",
                    "body": f"PropAI searched latest captured buyer/rental requirements for {query_label}.",
                    "actions": [
                        {"label": "Try nearby markets", "value": "Search nearby markets"},
                        {"label": "Show latest requirements", "value": "Show latest requirements"},
                    ],
                }
            ],
            "sources": ["parsed_output", "raw_messages"],
            "status_steps": ["Parsed property post", "Searched requirements", "Rendered latest matches"],
            "trace": {"route": "deterministic_requirement_match", "args": args, "total": total},
        }

    remaining = max(0, int(total or 0) - len(items))
    return {
        "content": f"Found {total} matching {intent_label}. Showing latest {len(items)}." + (f" {remaining} more available." if remaining else ""),
        "blocks": [
            {
                "type": "matching_buyers",
                "title": query_label.title(),
                "subtitle": f"{total} matching requirements, latest first",
                "items": items,
                "body": "Broker details included for direct follow-up.",
            },
            {
                "type": "suggested_questions",
                "title": "Next",
                "items": [
                    "Show next 5 requirements",
                    "Only requirements with phone numbers",
                    f"Search nearby markets for {query_label}",
                    "Copy WhatsApp summary",
                ],
            },
        ],
        "sources": ["parsed_output", "raw_messages"],
        "status_steps": ["Parsed property post", "Searched requirements", "Sorted latest first", "Rendered broker contacts"],
        "trace": {"route": "deterministic_requirement_match", "args": args, "total": total},
    }


def _broker_search_response(args: dict) -> dict:
    market = str(args.get("micro_market") or "").strip()
    limit = max(1, min(int(args.get("limit") or 8), 20))
    params: list[object] = []
    where = "WHERE broker_name IS NOT NULL AND broker_name != ''"
    if market:
        where += " AND (micro_market LIKE ? OR location_raw LIKE ? OR building_name LIKE ?)"
        like = f"%{market}%"
        params.extend([like, like, like])

    rows = storage.db.execute(
        f"""
        SELECT
            broker_name,
            COALESCE(NULLIF(broker_phone, ''), '') AS broker_phone,
            COUNT(*) AS posts,
            SUM(CASE WHEN intent IN ('SELL','RENT','COMMERCIAL','COMMERCIAL_SALE','COMMERCIAL_RENTAL') THEN 1 ELSE 0 END) AS listings,
            SUM(CASE WHEN intent IN ('BUY','BUYER','RENTAL_SEEKER') THEN 1 ELSE 0 END) AS requirements,
            COUNT(DISTINCT micro_market) AS markets,
            COUNT(DISTINCT r.group_name) AS groups,
            MAX(r.timestamp) AS last_seen
        FROM parsed_output p
        JOIN raw_messages r ON r.id = p.raw_message_id
        {where}
        GROUP BY broker_name, broker_phone
        ORDER BY posts DESC
        LIMIT ?
        """,
        (*params, limit),
    ).fetchall()

    items = [dict(row) for row in rows]
    label = f" in {market}" if market else ""
    if not items:
        return {
            "content": f"No broker activity found{label}.",
            "blocks": [
                {
                    "type": "empty_state",
                    "title": "No brokers found",
                    "body": f"PropAI searched captured WhatsApp records for broker activity{label}.",
                }
            ],
            "sources": ["brokers", "market_feed"],
            "status_steps": ["Searched broker activity"],
            "trace": {"route": "deterministic_broker_search", "args": args},
        }

    return {
        "content": f"Top {len(items)} brokers{label} by captured WhatsApp activity.",
        "blocks": [
            {
                "type": "broker_cards",
                "title": f"Top Brokers{label}",
                "items": [
                    {
                        "name": item.get("broker_name"),
                        "phone": item.get("broker_phone"),
                        "observations": item.get("posts"),
                        "listings": item.get("listings"),
                        "requirements": item.get("requirements"),
                        "groups": item.get("groups"),
                        "last_seen": item.get("last_seen"),
                    }
                    for item in items
                ],
            }
        ],
        "sources": ["brokers", "market_feed"],
        "status_steps": ["Searched broker activity", "Ranked by post count"],
        "trace": {"route": "deterministic_broker_search", "args": args},
    }


def _nearby_markets_response(args: dict) -> dict:
    origin = str(args.get("origin_market") or "").strip()
    if not origin:
        return {
            "content": "Tell me the starting market and I can search nearby areas.",
            "blocks": [
                {
                    "type": "empty_state",
                    "title": "Starting market needed",
                    "body": "PropAI needs a locality such as Bandra East, BKC, Andheri West, or Santacruz West to search nearby markets.",
                    "actions": [
                        {"label": "3 BHK rentals near Bandra East", "value": "Show 3 BHK rentals near Bandra East"},
                        {"label": "2 BHK rentals near Andheri West", "value": "Show 2 BHK rentals near Andheri West"},
                    ],
                }
            ],
            "sources": ["unique_listings"],
            "status_steps": ["Waiting for starting market"],
            "trace": {"route": "deterministic_nearby_markets", "args": args},
        }

    nearby = _NEARBY_MARKETS.get(origin)
    if not nearby:
        origin_lower = origin.lower()
        nearby = [m for m in _KNOWN_MARKETS if m != origin and (origin_lower in m.lower() or m.lower() in origin_lower)]
    nearby = nearby or [m for m in _KNOWN_MARKETS if m != origin][:6]

    base_args = {
        key: value
        for key, value in args.items()
        if key in {"intent", "bhk", "building", "price_max", "price_min", "furnishing"}
    }
    base_args.update({"limit": 3, "sort_by": "last_seen", "group_by_building": True})

    rows = []
    cards = []
    total = 0
    for market in nearby[:8]:
        search_args = dict(base_args)
        search_args["micro_market"] = market
        raw = chat_engine.execute_tool("market_search", search_args, {}, db_path=getattr(storage, "db", None))
        try:
            payload = json.loads(raw)
        except Exception:
            continue

        count = int(payload.get("total") or 0)
        total += count
        if not count:
            continue

        items = payload.get("results") or []
        brokers = len({item.get("broker_name") for item in items if item.get("broker_name")})
        buildings = len({item.get("building_name") for item in items if item.get("building_name")})
        rows.append([market, f"{count:,}", f"{brokers} brokers in latest sample, {buildings} buildings"])
        for item in items:
            item["price_formatted"] = item.get("price_formatted") or _format_listing_price(item)
            item["match_reasons"] = [
                reason
                for reason in [
                    f"Nearby market: {market}",
                    f"{args.get('bhk')} BHK" if args.get("bhk") else "",
                    args.get("intent") or "",
                ]
                if reason
            ]
            cards.append(item)

    bhk_label = f"{args['bhk']} BHK " if args.get("bhk") and str(args.get("bhk")).upper() != "STUDIO" else ""
    intent_label = "rentals" if args.get("intent") == "RENT" else "sale properties" if args.get("intent") == "SELL" else "properties"
    query_label = f"{bhk_label}{intent_label} near {origin}".strip()

    if not rows:
        return {
            "content": f"No nearby market matches found for {query_label}.",
            "blocks": [
                {
                    "type": "empty_state",
                    "title": "No nearby matches",
                    "body": f"PropAI searched nearby markets for {query_label} in saved WhatsApp property records.",
                    "actions": [
                        {"label": "Show latest rentals", "value": "Show latest rentals"},
                        {"label": f"Show all rentals near {origin}", "value": f"Show all rentals near {origin}"},
                    ],
                }
            ],
            "sources": ["unique_listings"],
            "status_steps": ["Found nearby markets", "Searched saved properties", "Rendered results"],
            "trace": {"route": "deterministic_nearby_markets", "args": args, "nearby": nearby},
        }

    return {
        "content": f"Found {total:,} {query_label} across nearby markets. Showing the latest {min(len(cards), 10)}.",
        "blocks": [
            {"type": "table", "title": f"Nearby Markets From {origin}", "rows": rows},
            {
                "type": "listing_cards",
                "title": query_label.title(),
                "subtitle": f"{total:,} matching property records across nearby markets",
                "items": cards[:10],
                "body": "Sorted by latest seen within each nearby market",
            },
            {
                "type": "suggested_questions",
                "title": "Refine",
                "items": [
                    f"Show all rentals near {origin}",
                    f"{query_label} under 3 L",
                    f"Show brokers near {origin}",
                    "Show requirements instead",
                ],
            },
        ],
        "sources": ["unique_listings"],
        "status_steps": ["Found nearby markets", "Searched saved properties", "Rendered results"],
        "trace": {"route": "deterministic_nearby_markets", "args": args, "nearby": nearby},
    }


def _database_coverage_response() -> dict:
    sources = chat_engine.load_data()
    sources.update(chat_engine.load_live_data(getattr(storage, "db", None)))

    labels = {
        "portal_listings": "Portal listings",
        "buildings": "Building directory",
        "overview": "Platform overview",
        "brokers": "Broker profiles",
        "unique_listings": "WhatsApp unique properties",
        "market_feed": "Recent WhatsApp posts",
        "building_matches": "Building matches",
        "unresolved_messages": "Unresolved messages",
        "pending_suggestions": "Pending suggestions",
    }
    fields = {
        "portal_listings": "building, locality, BHK, sqft, furnishing, price, source",
        "buildings": "building names and localities used for matching",
        "overview": "message, property, broker, and match counts",
        "brokers": "name, phone, activity, markets, groups, last seen",
        "unique_listings": "intent, BHK, price, building, broker, groups, first/last seen",
        "market_feed": "recent group posts, requirements, listings, brokers, timestamps",
        "building_matches": "matched building/landmark, confidence, status",
        "unresolved_messages": "messages needing parser or human review",
        "pending_suggestions": "AI suggestions waiting for review",
    }

    rows = []
    for key, src in sources.items():
        df = src.get("df") if isinstance(src, dict) else None
        rows.append([labels.get(key, key.replace("_", " ").title()), f"{len(df):,}" if df is not None else "0", fields.get(key, src.get("description", "") if isinstance(src, dict) else "")])

    return {
        "content": f"PropAI has read-only access to {len(rows)} local datasets in this workspace: listings, buildings, brokers, WhatsApp messages, parser review data, and suggestions.",
        "blocks": [
            {
                "type": "table",
                "title": "Search Coverage",
                "rows": rows,
            },
            {
                "type": "suggested_questions",
                "title": "Try asking",
                "items": [
                    "Who are top brokers in Bandra?",
                    "Show 3 BHK rentals in Andheri",
                    "Which messages need review?",
                    "Show recent Chandak Unicorn listings",
                ],
            },
        ],
        "sources": list(sources.keys()),
        "status_steps": ["Loaded local PropAI database coverage", "Ready for database queries"],
        "trace": {"route": "deterministic_database_coverage"},
    }


def _compact_whatsapp_line(value: object, limit: int = 260) -> str:
    text = str(value or "")
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    text = re.sub(r"__([^_]+)__", r"\1", text)
    text = re.sub(r"\*([^*\n]+)\*", r"\1", text)
    text = re.sub(r"_([^_\n]+)_", r"\1", text)
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"^#{1,6}\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def _workspace_response_to_whatsapp(response: dict) -> str:
    if not isinstance(response, dict):
        return _compact_whatsapp_line(response, 1800) or "I could not process that."

    if response.get("error"):
        return _compact_whatsapp_line(response.get("message") or response.get("error"), 1600)

    blocks = response.get("blocks") or []
    has_listing_cards = any(isinstance(block, dict) and block.get("type") == "listing_cards" for block in blocks)

    lines: list[str] = []
    content = _compact_whatsapp_line(response.get("content"), 220 if has_listing_cards else 500)
    if content and not has_listing_cards:
        lines.append(content)
    seen_snippets = {re.sub(r"\W+", "", content.lower())[:160]} if content else set()

    for block in blocks[:4]:
        if not isinstance(block, dict):
            continue
        block_type = block.get("type")
        if has_listing_cards and block_type == "summary":
            continue

        if block_type == "listing_cards":
            items = block.get("items") or block.get("results") or []
            if isinstance(items, list) and items:
                if content:
                    lines.append(content)
                for item in items[:5]:
                    if not isinstance(item, dict):
                        continue
                    heading = (
                        item.get("building_name")
                        or item.get("building")
                        or item.get("location_label")
                        or item.get("micro_market")
                        or "Property"
                    )
                    if str(heading).strip().lower() in {"unknown building", "unknown", "none"}:
                        heading = item.get("location_label") or item.get("micro_market") or "Property"
                    price = item.get("price_formatted") or item.get("price") or ""
                    area = item.get("area_sqft")
                    try:
                        area_text = f"{int(float(area))} sqft" if area not in (None, "") else ""
                    except (TypeError, ValueError):
                        area_text = str(area or "")
                    details = " · ".join(
                        str(part).strip()
                        for part in [item.get("bhk"), area_text, item.get("furnishing")]
                        if part not in (None, "")
                    )
                    broker_name = str(item.get("broker_name") or "").strip()
                    broker_phone = _normalize_real_phone(item.get("broker_phone"))
                    broker = " / ".join(part for part in [broker_name, broker_phone] if part)
                    tail = " · ".join(str(part).strip() for part in [price, details, broker] if str(part or "").strip())
                    lines.append(_compact_whatsapp_line(f"{len(lines) if content else len(lines) + 1}. {heading}: {tail}", 190))
            continue

        if block_type == "table":
            rows = block.get("rows") or []
            if isinstance(rows, list) and rows:
                if lines:
                    lines.append("")
                lines.append(_compact_whatsapp_line(block.get("title") or "Results", 120))
                for row in rows[:8]:
                    if isinstance(row, (list, tuple)):
                        label = str(row[0]) if len(row) > 0 else ""
                        metric = str(row[1]) if len(row) > 1 else ""
                        detail = str(row[2]) if len(row) > 2 else ""
                        lines.append(_compact_whatsapp_line(f"- {label}: {metric} records. {detail}", 220))
                    elif isinstance(row, dict):
                        label = row.get("name") or row.get("title") or row.get("dataset") or "Row"
                        metric = row.get("count") or row.get("records") or ""
                        lines.append(_compact_whatsapp_line(f"- {label} {metric}", 200))
            continue

        if block_type in {"broker_cards", "buyer_cards", "matching_buyers"}:
            items = block.get("items") or block.get("rows") or block.get("results") or []
            if isinstance(items, list) and items:
                if lines:
                    lines.append("")
                lines.append(_compact_whatsapp_line(block.get("title") or "Results", 120))
                for idx, item in enumerate(items[:5], start=1):
                    if isinstance(item, dict):
                        label = item.get("name") or item.get("broker_name") or item.get("building_name") or item.get("title") or "Broker"
                        phone = _normalize_real_phone(item.get("phone") or item.get("broker_phone"))
                        market = item.get("micro_market") or item.get("location_raw") or ""
                        need = " · ".join(
                            str(part).strip()
                            for part in [item.get("bhk"), item.get("price_formatted") or item.get("price"), market]
                            if str(part or "").strip()
                        )
                        metric = item.get("count") or item.get("observations") or item.get("listings") or item.get("score") or ""
                        contact = " / ".join(str(part).strip() for part in [label, phone] if str(part or "").strip())
                        lines.append(_compact_whatsapp_line(f"{idx}. {contact}: {need or metric}", 220))
            continue

        body = block.get("body") or block.get("summary") or block.get("description")
        if body:
            clean_body = _compact_whatsapp_line(body, 400)
            body_key = re.sub(r"\W+", "", clean_body.lower())[:160]
            if body_key and body_key in seen_snippets:
                continue
            seen_snippets.add(body_key)
            if lines:
                lines.append("")
            title = block.get("title")
            if title:
                lines.append(_compact_whatsapp_line(title, 120))
            lines.append(clean_body)

    text = "\n".join(line for line in lines if line is not None).strip()
    if not text:
        text = "I found a response, but it had no readable text."
    if len(text) > 3200:
        text = text[:3190].rstrip() + "\n…"
    return sanitize_whatsapp_text(text)


# ── WhatsApp self-chat helpers ────────────────────────────────────


_SELF_CHAT_BULLET = "• "
_SELF_CHAT_MAX_BULLETS = 3
_SELF_CHAT_MAX_CHARS = 420

_CASUAL_CHAT_SIGNAL = re.compile(
    r"^\s*(hi|hello|hey|hiya|yo|hola|good\s*(morning|afternoon|evening)|"
    r"thanks|thank\s*you|thx|ok|okay|cool|nice|great|got\s*it|"
    r"who\s*are\s*you|what\s*can\s*you\s*do|how\s*are\s*you|"
    r"bye|see\s*you|cya)\b",
    re.IGNORECASE,
)

_DATA_QUERY_SIGNAL = re.compile(
    r"\b(\d+(?:\.\d+)?\s*bhk|studio|rent|rental|lease|sale|buy|purchase|"
    r"flat|apartment|property|listing|broker|building|locality|"
    r"market|trend|audit|recent|latest|today|yesterday|this\s*week|last\s*week)\b",
    re.IGNORECASE,
)


def _is_casual_self_chat(text: str) -> bool:
    """Heuristic: short greeting/thanks/identity question — no tool calls needed."""
    stripped = (text or "").strip()
    if len(stripped) > 60:
        return False
    if _DATA_QUERY_SIGNAL.search(stripped):
        return False
    return bool(_CASUAL_CHAT_SIGNAL.match(stripped))


def _build_self_chat_system_prompt(sources: dict) -> str:
    """Strict bullet-only prompt for the WhatsApp self-chat agent.

    This deliberately does NOT inherit build_system_prompt() — the workspace
    contract (JSON blocks, listing_cards, exports) contradicts the WhatsApp
    surface. The model gets one job: answer in bullets, plain text only.
    """
    # Identity is shared with workspace chat. Only presentation differs on
    # WhatsApp, so product truth cannot drift between the two surfaces.
    identity = chat_engine._read_prompt_file("identity.md")
    now = datetime.now()
    time_str = now.strftime("%a, %d %b %Y %I:%M %p")
    overview = sources.get("overview", "") or ""
    overview_line = f"\nDATA SNAPSHOT:\n{overview[:600]}\n" if overview else ""
    return f"""{identity or 'You are PropAI, a Mumbai real-estate broker assistant.'}

You are PropAI in WhatsApp Message-Yourself chat. Today is {time_str}.

OUTPUT RULES — non-negotiable:
- EVERY reply uses bulleted points. Use '• ' prefix for each bullet.
- NEVER write flowing paragraphs. NEVER write multi-sentence prose blocks.
- NEVER return JSON, code fences, markdown tables, or UI blocks.
- Each bullet must fit on one WhatsApp line (under ~120 chars).
- Lead with the answer in bullet 1. Follow with only essential context.
- Maximum 3 bullets per reply. If you have more, pick the most important.
- For greetings or identity questions, respond with 1-2 bullets only.
- This QR-linked self-chat is authenticated. Never ask the user to log in to the portal.
- For a listing/requirement search, use market_search against the global published marketplace. Never claim database access is unavailable before trying it.
- Do not claim a listing was found, saved, or updated unless a tool result confirms it.
- For real-estate queries, format like:
  • <Property>: <price>, <bhk>, <area> sqft — <micro_market>
  • Broker: <name> / <phone>
- Numbers above 999: write as 1.2L (lac), 3.5Cr (crore), 25K. Do NOT write ₹1,20,000.
- Do not ask the user to open the dashboard. If a UI is genuinely required, say so in one bullet.{overview_line}"""


def _format_self_chat_response(text: str) -> str:
    """Force-bullet post-processor.

    The model sometimes still emits paragraphs even with a strict prompt.
    This function is the safety net: split any prose into sentence-sized
    bullets, prefix every non-empty line with '• ', cap to 8 bullets and
    ~1600 chars total so it fits a single WhatsApp reply.
    """
    if not text:
        return ""

    cleaned = text.strip()

    # Strip JSON code fences the model occasionally leaks. Extract the JSON
    # content (don't delete it!) so we can pull out the "content"/"reply"
    # field instead of rendering the raw JSON.
    fence_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", cleaned, flags=re.DOTALL)
    if fence_match:
        try:
            parsed = json.loads(fence_match.group(1))
            if isinstance(parsed, dict):
                cleaned = (
                    parsed.get("content")
                    or parsed.get("summary")
                    or parsed.get("reply")
                    or parsed.get("text")
                    or ""
                )
        except (json.JSONDecodeError, ValueError):
            # Fall through with the rest of the text minus the fence.
            cleaned = (cleaned[: fence_match.start()] + cleaned[fence_match.end() :]).strip()
    else:
        # Generic non-JSON fence: drop it but keep surrounding text.
        cleaned = re.sub(r"```(?!json)[^`]*```", "", cleaned, flags=re.DOTALL).strip()

    # If the entire reply is a JSON object, extract its "content" field if present.
    if cleaned.startswith("{") and cleaned.endswith("}"):
        try:
            parsed = json.loads(cleaned)
            if isinstance(parsed, dict):
                cleaned = (
                    parsed.get("content")
                    or parsed.get("summary")
                    or parsed.get("reply")
                    or parsed.get("text")
                    or ""
                )
        except (json.JSONDecodeError, ValueError):
            pass

    if not cleaned:
        return ""

    # Strip existing bullet markers before re-bulleting to avoid double prefixes.
    cleaned = re.sub(r"^[\s>]*[-*•·]+\s*", "", cleaned, flags=re.MULTILINE)

    # Split into atomic bullets: by newline first, then by sentence for each
    # paragraph. Even short prose paragraphs must be broken into sentence-sized
    # bullets so the user sees a list, not a wall of text.
    raw_lines: list[str] = []
    for line in cleaned.splitlines():
        line = line.strip()
        if not line:
            continue
        # Split on sentence terminators AND commas that introduce a new clause.
        # Keep numerical/currency tokens intact by matching a capital letter
        # or bullet character after the terminator.
        sentence_parts = re.split(r"(?<=[.!?])\s+(?=[A-Z•])|\s*,\s+(?=[a-z])", line)
        for part in sentence_parts:
            part = part.strip().rstrip(",.;:")
            if part:
                # Hard cap per bullet to keep it on one WhatsApp line.
                raw_lines.append(part[:140])

    if not raw_lines:
        return ""

    # De-duplicate near-identical bullets (LLM sometimes repeats).
    seen: set[str] = set()
    deduped: list[str] = []
    for line in raw_lines:
        key = re.sub(r"\W+", "", line.lower())[:80]
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append(line)

    # Prefix with bullet and cap.
    bulleted = [_SELF_CHAT_BULLET + line for line in deduped[:_SELF_CHAT_MAX_BULLETS]]

    text_out = "\n".join(bulleted)
    if len(text_out) > _SELF_CHAT_MAX_CHARS:
        text_out = text_out[: _SELF_CHAT_MAX_CHARS - 1].rstrip() + "…"
    # Skip sanitize_whatsapp_text — it strips leading '• ' which would undo
    # the bullets we just added. The model output is already markdown-stripped
    # above (JSON fences, bold, leading dashes).
    return text_out


async def _run_self_chat_agent(
    messages: list[dict],
    model: str = "",
    session_id: str = "whatsapp",
    casual: bool = False,
    tenant_id: str | None = None,
) -> dict:
    """Lightweight variant of _run_workspace_agent for the WhatsApp self-chat path.

    Differences vs. _run_workspace_agent:
    - Strict bullet-only system prompt (no workspace JSON contract).
    - Casual chat → no tool calls, no observation gathering, no live-data load.
    - Data chat → max_tool_rounds=1 instead of 2.
    - Prefers fastest available provider (Cerebras > Gemini > default).
    - Tighter timeout (30s instead of 90s).
    """
    import llm as _llm

    from ai_chat_engine import get_memory

    # Memory only matters if the conversation actually spans multiple turns.
    # Self-chat is mostly single-shot, so we skip memory writes for casual.
    if not casual:
        memory = get_memory(session_id)
        for msg in messages:
            role = msg.get("role", "")
            content = str(msg.get("content", "")).strip()
            if content:
                if not memory.working or memory.working[-1].get("content") != content:
                    memory.add(role, content)

    configured_model = model.strip()
    api_key = ""
    base_url = ""
    provider_name = ""
    # Self-chat prefers the fastest healthy provider. Try Cerebras → Gemini
    # before falling back to the chain default (NVIDIA NIM, which is slow).
    try:
        fast = _llm.get_fast_client()
        api_key = fast.api_key
        base_url = (
            fast.base_url.base_url.rstrip("/")
            if hasattr(fast.base_url, "base_url")
            else str(fast.base_url).rstrip("/")
        )
        configured_model = configured_model or _llm.get_fast_model()
        provider_name = _llm.get_fast_provider_name()
    except Exception:
        pass
    if not api_key or api_key == "none":
        # Fallback to default chain.
        try:
            client = _llm.get_client()
            api_key = client.api_key
            base_url = (
                client.base_url.base_url.rstrip("/")
                if hasattr(client.base_url, "base_url")
                else str(client.base_url).rstrip("/")
            )
            configured_model = configured_model or _llm.get_model()
            provider_name = _llm.get_provider_name()
        except Exception:
            pass
    if not api_key or api_key == "none":
        return {
            "error": "api_key_required",
            "message": "No LLM provider is available for self-chat.",
        }

    _logger.info(
        "Self-chat agent resolved provider: %s | model=%s | casual=%s",
        provider_name, configured_model, casual,
    )

    # Casual chat: no data loading, no tools, just a fast text reply.
    sources: dict = {}
    if not casual:
        sources = chat_engine.load_data()
        live = chat_engine.load_live_data(getattr(storage, "db", None))
        if isinstance(live, dict):
            sources.update(live)
        if not sources:
            return {"error": "no_data", "message": "No PropAI data is available yet."}

        last_user = next(
            (str(message.get("content") or "").strip() for message in reversed(messages)
             if message.get("role") == "user"),
            "",
        )
        deterministic_query = chat_engine.parse_market_search_request(last_user)
        if deterministic_query:
            try:
                result = await asyncio.to_thread(
                    chat_engine.execute_tool,
                    "market_search",
                    deterministic_query,
                    sources,
                    getattr(storage, "db", None),
                    tenant_id,
                )
                return chat_engine.deterministic_market_response(
                    deterministic_query, result, sources
                )
            except Exception as exc:
                _logger.warning("Self-chat deterministic market search failed: %s", exc)
                return chat_engine.deterministic_market_response(
                    deterministic_query, "", sources
                )

    loop = asyncio.get_running_loop()

    def _call():
        system_prompt = _build_self_chat_system_prompt(sources)
        # Casual chat: strip tools entirely so the model can't be tempted.
        max_rounds = 0 if casual else 1
        context_parts: list[str] = []
        if not casual:
            try:
                memory = get_memory(session_id)
                context_parts.append(memory.build_context())
            except Exception:
                pass
        context_parts.append(messages[-1].get("content", "") if messages else "")
        context = "\n\n".join(p for p in context_parts if p).strip()
        msgs = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": context or "Hello."},
        ]
        reply = chat_engine.get_model_reply(
            msgs,
            sources,
            api_key=api_key,
            model=configured_model or None,
            base_url=base_url,
            max_tool_rounds=max_rounds,
            db_path=getattr(storage, "db", None),
            tenant_id=tenant_id,
        )
        if reply.content and not casual:
            try:
                memory = get_memory(session_id)
                memory.add("assistant", reply.content)
            except Exception:
                pass
        return chat_engine.normalize_workspace_response(reply.content or "", sources)

    import contextvars

    request_context = contextvars.copy_context()
    try:
        return await asyncio.wait_for(
            loop.run_in_executor(None, request_context.run, _call),
            timeout=30,
        )
    except asyncio.TimeoutError:
        return {"error": "agent_timeout", "message": "Self-chat agent timed out."}


async def _stream_self_chat_reply(text: str) -> dict | None:
    """Direct OpenAI streaming for casual self-chat (no tool plumbing).

    Bypasses chat_engine.get_model_reply entirely because that path is sync
    and tool-aware. For casual chat we want first-token-on-the-wire fast —
    the user already sees a typing indicator; streaming keeps total time
    close to TTFT instead of waiting for the full completion.

    Returns the final formatted reply (PropAI-prefixed, bullet-formatted) on
    success, or None on failure. Progress chunks are sent via the channel
    passed in (or logged if channel is None).
    """
    import llm as _llm

    api_key = ""
    base_url = ""
    configured_model = ""
    try:
        fast = _llm.get_fast_client()
        api_key = fast.api_key
        base_url = (
            fast.base_url.base_url.rstrip("/")
            if hasattr(fast.base_url, "base_url")
            else str(fast.base_url).rstrip("/")
        )
        configured_model = _llm.get_fast_model()
    except Exception:
        pass
    if not api_key or api_key == "none":
        return None

    sources: dict = {}
    try:
        sources = chat_engine.load_data()
        live = chat_engine.load_live_data(getattr(storage, "db", None))
        if isinstance(live, dict):
            sources.update(live)
    except Exception:
        pass

    system_prompt = _build_self_chat_system_prompt(sources)
    user_text = (text or "").strip()[:1800] or "Hello."

    try:
        from openai import OpenAI

        client = OpenAI(api_key=api_key, base_url=base_url)
        stream = client.chat.completions.create(
            model=configured_model or _llm.get_fast_model(),
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_text},
            ],
            stream=True,
            stream_options={"include_usage": True},
            max_tokens=400,
            temperature=0.4,
        )
        chunks: list[str] = []
        usage_info = None
        for chunk in stream:
            try:
                delta = (
                    chunk.choices[0].delta.content
                    if chunk.choices and chunk.choices[0].delta
                    else None
                )
            except (AttributeError, IndexError):
                delta = None
            if delta:
                chunks.append(delta)
            if getattr(chunk, "usage", None):
                usage_info = chunk.usage
        # Log token usage for cost tracking
        try:
            from usage_logger import log_ai_usage
            log_ai_usage(
                agent="self_chat",
                model=configured_model or _llm.get_fast_model(),
                tokens_input=getattr(usage_info, "prompt_tokens", 0) or 0,
                tokens_output=getattr(usage_info, "completion_tokens", 0) or 0,
            )
        except Exception:
            pass
        full = "".join(chunks).strip()
        if not full:
            return None
        formatted = _format_self_chat_response(full)
        if not formatted:
            return None
        return "PropAI- " + formatted
    except Exception as exc:
        _logger.warning("self-chat streaming failed: %s", exc)
        return None


async def _run_workspace_agent(
    messages: list[dict],
    model: str = "",
    session_id: str = "whatsapp",
    tenant_id: str | None = None,
) -> dict:
    # Conversation memory
    from ai_chat_engine import get_memory
    memory = get_memory(session_id)
    for msg in messages:
        role = msg.get("role", "")
        content = str(msg.get("content", "")).strip()
        if content:
            if not memory.working or memory.working[-1].get("content") != content:
                memory.add(role, content)

    # Topic-aware compaction
    last_user = ""
    for msg in reversed(messages):
        if msg.get("role") == "user":
            last_user = str(msg.get("content", "")).strip()
            break
    if last_user and memory.detect_topic_change(last_user) and len(memory.working) > 2:
        memory.compact_topic()
    memory.prune()

    import llm as _llm
    configured_model = model.strip()
    api_key = ""
    base_url = ""
    provider_name = ""
    # Use the shared provider chain (NVIDIA×3 → Groq → Gemini → Cerebras → Doubleword)
    try:
        api_key = _llm.get_client().api_key
        base_url = _llm.get_client().base_url.base_url.rstrip("/") if hasattr(_llm.get_client().base_url, "base_url") else str(_llm.get_client().base_url).rstrip("/")
        configured_model = configured_model or _llm.get_model()
        provider_name = _llm.get_provider_name()
    except Exception:
        pass
    if not api_key or api_key == "none":
        provider = await asyncio.to_thread(storage.get_active_llm_provider)
        if provider:
            api_key = (provider.api_key or "").strip()
            base_url = (provider.base_url or "https://api.doubleword.ai/v1").strip().rstrip("/")
            configured_model = configured_model or (provider.model_name or "").strip()
            provider_name = provider.provider_name
    if not api_key or api_key == "none":
        return {
            "error": "api_key_required",
            "message": "No LLM provider is available. Set NVIDIA_API_KEY or another provider key.",
        }
    _logger.info(
        "Workspace agent resolved provider: %s | model=%s | base_url=%s",
        provider_name, configured_model, base_url,
    )

    # Model-URL assertion: warn loudly if the model doesn't match the provider's base URL
    if configured_model and base_url:
        _assert_model_url_match(configured_model, base_url)

    sources = chat_engine.load_data()
    live = chat_engine.load_live_data(getattr(storage, "db", None))
    sources.update(live)
    if not sources:
        return {"error": "no_data", "message": "No PropAI data is available yet."}

    # Gather relevant knowledge observations for entities mentioned in conversation
    conv_text = " ".join(m.get("content", "") for m in messages if m.get("content"))
    entity_candidates = _extract_entity_mentions(conv_text)
    relevant_obs = _get_relevant_observations(entity_candidates, limit=8)

    loop = asyncio.get_running_loop()

    def _call():
        system_prompt = chat_engine.build_system_prompt(sources)
        system_prompt += """

WHATSAPP SELF-CHAT MODE:
- The sender is authenticated through their QR-linked WhatsApp connection. Never ask them to log in to the portal.
- You have access to their live PropAI database through tools. For a search or inventory question, call the tool; never claim database access is unavailable before trying it.
- Reply in at most 3 short lines (or up to 5 compact result bullets). No tables, greetings, repeated summaries, or filler.
- Never claim a listing/requirement was saved, searched, or found unless the tool result says so.
- Never return JSON, markdown tables, or UI blocks — plain text only.
"""
        if relevant_obs:
            obs_lines = ["\nKNOWLEDGE OBSERVATIONS (accumulated from previous conversations):"]
            for obs in relevant_obs:
                conf_label = {1: "low", 2: "low-medium", 3: "medium", 4: "medium-high", 5: "high"}.get(obs["confidence"], "low")
                obs_lines.append(f"- [{conf_label} confidence, {obs['observation_count']} report(s)] {obs['observation_text']}")
            obs_lines.append("Use these as background context. Never state them as proven facts. Qualify confidence naturally.\n")
            system_prompt += "\n".join(obs_lines)

        context = memory.build_context()
        msgs = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": context},
        ]
        reply = chat_engine.get_model_reply(
            msgs,
            sources,
            api_key=api_key,
            model=configured_model or None,
            base_url=base_url,
            max_tool_rounds=2,
            tenant_id=tenant_id,
        )
        if reply.content:
            memory.add("assistant", reply.content)
        # Echo-detection guardrail: catch "Nice to meet you" misfires on data queries
        last_user = next((m.get("content", "") for m in reversed(messages) if m.get("role") == "user"), "")
        assistant_reply = reply.content or ""
        if _looks_like_echo_misfire(last_user, assistant_reply):
            # Log for review; could also force a retry with explicit tool reminder
            import logging
            logging.warning(
                "possible_echo_misfire",
                extra={"user_msg": last_user[:200], "assistant_msg": assistant_reply[:200]}
            )
        return chat_engine.normalize_workspace_response(reply.content or "", sources)

    # run_in_executor does not propagate contextvars by itself. Preserve the
    # organization selected by the self-chat control plane so tools and storage
    # reads inside the model loop stay scoped to the broker's workspace.
    import contextvars
    request_context = contextvars.copy_context()
    return await asyncio.wait_for(
        loop.run_in_executor(None, request_context.run, _call),
        timeout=90,
    )


@app.post("/api/internal/self-chat")
async def internal_self_chat(req: InternalSelfChatRequest, request: Request):
    expected_token = (
        os.getenv("PROPAI_INTERNAL_TOKEN", "").strip()
        or os.getenv("SUPABASE_SERVICE_KEY", "").strip()
    )
    supplied_token = request.headers.get("X-PropAI-Internal-Token", "").strip()
    if not expected_token:
        raise HTTPException(503, "Internal service authentication is not configured")
    if not hmac.compare_digest(supplied_token, expected_token):
        raise HTTPException(401, "Invalid internal service token")

    connection = await asyncio.to_thread(
        storage.get_org_whatsapp_connection_by_broker_id,
        req.broker_id.strip(),
    )
    if not connection and req.sender_jid:
        sender_phone = re.sub(r"\D+", "", req.sender_jid.split("@", 1)[0])
        connection = await asyncio.to_thread(
            storage.get_active_org_whatsapp_connection_by_phone, sender_phone
        )
    if not connection:
        raise HTTPException(404, "Unknown WhatsApp connection")
    if not connection.get("is_active", True):
        raise HTTPException(403, "WhatsApp connection is inactive")
    if not connection.get("self_chat_enabled", True):
        raise HTTPException(403, "Self-chat assistant is disabled for this phone")

    text = req.text.strip()
    if not text:
        return {"reply": ""}

    set_tenant_id(connection.get("organization_id") or DEFAULT_TENANT_ID)
    casual = _is_casual_self_chat(text)
    wants_stream = casual or _stream_self_chat_enabled()

    if wants_stream:
        return StreamingResponse(
            _self_chat_ndjson(text, req.broker_id, casual=casual),
            media_type="application/x-ndjson",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    try:
        response = await _run_self_chat_agent(
            [{"role": "user", "content": text[:1800]}],
            session_id=f"whatsmeow:{req.broker_id}",
            casual=casual,
            tenant_id=connection.get("organization_id") or DEFAULT_TENANT_ID,
        )
        if isinstance(response, dict) and response.get("error"):
            return JSONResponse(status_code=503, content=response)
        raw_reply = _workspace_response_to_whatsapp(response) if response.get("content") or response.get("blocks") else ""
        if not raw_reply:
            raw_reply = response.get("content") or ""
        # Force bullets — last line of defense against prose replies.
        reply = _format_self_chat_response(raw_reply) if raw_reply else ""
        if reply:
            reply = "PropAI- " + reply
        return {"reply": reply}
    except asyncio.TimeoutError:
        return JSONResponse(status_code=504, content={"error": "agent_timeout"})


def _stream_self_chat_enabled() -> bool:
    """Allow forcing streaming for data queries via env var for debugging."""
    val = (os.getenv("PROPAI_SELF_CHAT_STREAM") or "").strip().lower()
    return val in {"1", "true", "yes", "on"}


async def _self_chat_ndjson(text: str, broker_id: str, casual: bool):
    """Yield NDJSON events for the self-chat stream.

    Event shape (line-delimited JSON, newline-terminated):
      {"event":"chunk","delta":"• Hello"}
      {"event":"chunk","delta":" there"}
      {"event":"done","reply":"PropAI- • Hello there"}
      (or {"event":"error","message":"..."} on failure)
    """
    try:
        if casual:
            reply = await _stream_self_chat_reply(text)
            if reply:
                # Stream one fake chunk + done so the Go side gets a final reply.
                yield _ndjson_line({"event": "chunk", "delta": reply})
                yield _ndjson_line({"event": "done", "reply": reply})
                return
            # Streaming failed — fall through to the sync path.
            _logger.info("self-chat streaming returned None; falling back to sync path")
        # Data path (or streaming fallback): run sync, stream the full reply.
        response = await _run_self_chat_agent(
            [{"role": "user", "content": text[:1800]}],
            session_id=f"whatsmeow:{broker_id}",
            casual=casual,
            tenant_id=get_tenant_id() or DEFAULT_TENANT_ID,
        )
        if isinstance(response, dict) and response.get("error"):
            yield _ndjson_line({"event": "error", "message": response.get("message") or response.get("error") or "agent_error"})
            return
        raw_reply = _workspace_response_to_whatsapp(response) if response.get("content") or response.get("blocks") else ""
        if not raw_reply:
            raw_reply = response.get("content") or ""
        reply = _format_self_chat_response(raw_reply) if raw_reply else ""
        if reply:
            reply = "PropAI- " + reply
        if reply:
            yield _ndjson_line({"event": "chunk", "delta": reply})
            yield _ndjson_line({"event": "done", "reply": reply})
        else:
            yield _ndjson_line({"event": "error", "message": "empty_reply"})
    except asyncio.TimeoutError:
        yield _ndjson_line({"event": "error", "message": "agent_timeout"})
    except Exception as exc:
        _logger.warning("self-chat NDJSON generator failed: %s", exc)
        yield _ndjson_line({"event": "error", "message": str(exc)[:200]})


def _ndjson_line(payload: dict) -> bytes:
    return (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")


@app.post("/api/self-chat")
async def self_chat(req: SelfChatRequest, user: dict = Depends(require_user)):
    text = req.text.strip()
    if not text:
        return {"reply": ""}

    messages = []
    for item in (req.messages or [])[-10:]:
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        content = str(item.get("content") or "").strip()
        if role in {"user", "assistant"} and content:
            messages.append({"role": role, "content": content[:1800]})
    if not messages or messages[-1].get("role") != "user" or messages[-1].get("content") != text:
        messages.append({"role": "user", "content": text})

    try:
        response = await _run_workspace_agent(messages, req.model, session_id=req.sender_jid or "whatsapp")
        return {
            "reply": _workspace_response_to_whatsapp(response),
            "sources": response.get("sources", []) if isinstance(response, dict) else [],
            "trace": response.get("trace", {}) if isinstance(response, dict) else {},
        }
    except asyncio.TimeoutError:
        return JSONResponse(
            status_code=504,
            content={"reply": "The PropAI database query timed out. Try a narrower question."},
        )
    except Exception as exc:
        error = _doubleword_error_response(exc)
        try:
            payload = json.loads(error.body.decode("utf-8"))
        except Exception:
            payload = {"message": str(exc)}
        return JSONResponse(
            status_code=error.status_code,
            content={"reply": payload.get("message") or payload.get("detail") or str(exc), "error": payload},
        )


class SendMessageRequest(BaseModel):
    remote_jid: str
    text: str
    quoted_message_id: str = ""
    quoted_remote_jid: str = ""
    quoted_participant: str = ""
    quoted_from_me: bool = False
    broker_id: str = ""


async def get_current_team_member(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
) -> dict:
    email = (user.get("email") or "").strip().lower()
    phone = (user.get("phone") or "").strip()
    org_id = tenant_id
    member = storage.get_team_member_by_email(email, org_id=org_id) if email else None
    if not member and phone:
        members = storage.list_team_members(org_id=org_id)
        normalized_phone = phone.replace("+", "")
        member = next(
            (
                m
                for m in members
                if (m.get("phone") or "").strip().replace("+", "") == normalized_phone
                and m.get("is_active")
            ),
            None,
        )
    if not member or not member.get("is_active"):
        name = (user.get("user_metadata", {}).get("full_name") or email or "User").strip()
        try:
            member = storage.create_team_member(
                name=name,
                email=email,
                phone=phone,
                role="member",
                permission_keys=["view_inbox", "reply_whatsapp"],
                organization_id=org_id,
            )
        except Exception:
            raise HTTPException(403, "No active team member is linked to this account")
    member["permission_keys"] = storage._perm_keys(member["permissions"])
    return member


@app.post("/api/send")
async def send_message(req: SendMessageRequest, member: dict = Depends(get_current_team_member)):
    check_permission(member, "reply_whatsapp")
    text = req.text.strip()
    if not text:
        return JSONResponse(status_code=400, content={"success": False, "error": "text is required"})
    if not req.remote_jid:
        return JSONResponse(status_code=400, content={"success": False, "error": "remote_jid is required"})

    try:
        ingestor_url = _send_url()
        payload = {
            "remoteJid": req.remote_jid,
            "text": text,
        }
        org_id = member.get("organization_id")
        if org_id:
            connections = await asyncio.to_thread(storage.list_org_whatsapp_connections, org_id)
            connections = [row for row in connections if row.get("is_active", True)]
            explicit_access = await asyncio.to_thread(
                storage.get_member_whatsapp_access, member["id"], org_id
            )
            if explicit_access:
                allowed_numbers = {
                    str(row.get("whatsapp_number") or "")
                    for row in explicit_access if row.get("can_send")
                }
                connections = [
                    row for row in connections
                    if str(row.get("phone_number") or "") in allowed_numbers
                ]
            requested_broker_id = req.broker_id.strip()
            if requested_broker_id:
                connections = [
                    row for row in connections
                    if str(row.get("broker_id") or "") == requested_broker_id
                ]
            if not connections:
                raise HTTPException(403, "No WhatsApp phone is available for this team member")
            selected_broker_id = str(connections[0].get("broker_id") or "").strip()
            if selected_broker_id:
                payload["brokerId"] = selected_broker_id
        if req.quoted_message_id:
            payload["quotedMessageId"] = req.quoted_message_id
            payload["quotedRemoteJid"] = req.quoted_remote_jid or req.remote_jid
            payload["quotedParticipant"] = req.quoted_participant
            payload["quotedFromMe"] = req.quoted_from_me

        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                f"{ingestor_url}/send-message", json=payload, headers=_ingestor_auth_headers()
            )

        response_body = {}
        if response.text:
            try:
                response_body = response.json()
            except Exception:
                response_body = {"raw": response.text[:1000]}

        try:
            storage.log_activity(
                team_member_id=member["id"],
                action="reply_whatsapp_sent" if response.status_code < 400 else "reply_whatsapp_failed",
                target_type="whatsapp_conversation",
                target_id=req.remote_jid,
                details={
                    "surface": "inbox",
                    "reply_text": text[:500],
                    "quoted_message_id": req.quoted_message_id or "",
                    "quoted_remote_jid": req.quoted_remote_jid or "",
                    "quoted_participant": req.quoted_participant or "",
                    "quoted_from_me": bool(req.quoted_from_me),
                    "transport_status_code": response.status_code,
                    "transport_response": response_body,
                },
            )
        except Exception as exc:
            print(f"[activity-log] failed to record whatsapp reply: {exc}", flush=True)

        return JSONResponse(
            status_code=response.status_code,
            content=response_body if response.text else {"success": False, "error": "empty response"},
        )
    except httpx.ConnectError:
        try:
            storage.log_activity(
                team_member_id=member["id"],
                action="reply_whatsapp_failed",
                target_type="whatsapp_conversation",
                target_id=req.remote_jid,
                details={
                    "surface": "inbox",
                    "reply_text": text[:500],
                    "error": "Cannot reach WhatsApp ingestor",
                },
            )
        except Exception as exc:
            print(f"[activity-log] failed to record whatsapp reply error: {exc}", flush=True)
        return JSONResponse(
            status_code=502,
            content={"success": False, "error": "Cannot reach WhatsApp ingestor. Is WhatsApp connected?"},
        )
    except Exception as exc:
        try:
            storage.log_activity(
                team_member_id=member["id"],
                action="reply_whatsapp_failed",
                target_type="whatsapp_conversation",
                target_id=req.remote_jid,
                details={
                    "surface": "inbox",
                    "reply_text": text[:500],
                    "error": str(exc),
                },
            )
        except Exception as log_exc:
            print(f"[activity-log] failed to record whatsapp reply exception: {log_exc}", flush=True)
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(exc)},
        )

# ════════════════════════════════════════════════════════════════
# Public API for www.propai.live (no auth required)
# ════════════════════════════════════════════════════════════════

@app.get("/public/listings")
async def public_listings(
    micro_market: str | None = None,
    bhk: str | None = None,
    intent: str | None = None,
    min_price: float | None = None,
    max_price: float | None = None,
    limit: int = 20,
    offset: int = 0,
):
    """
    Public listings endpoint for www.propai.live.
    No auth required. Filters: micro_market, bhk, intent, min_price, max_price.
    Returns listings without broker_name/broker_phone.
    """
    try:
        # Build query with filters
        query = """
            SELECT l.id, l.fingerprint, l.intent, l.bhk, l.price, l.price_unit,
                   l.price_per_sqft, l.area_sqft, l.furnishing, l.location_label,
                   l.building_name, l.landmark_name, l.micro_market, l.street_name,
                   l.developer, l.floor_description, l.view, l.orientation,
                   l.pic_token, l.listing_source, l.first_seen, l.last_seen,
                   l.observation_count, l.group_count
            FROM listings l
            LEFT JOIN brokers b ON l.broker_name = b.canonical_name
            WHERE l.last_seen > now() - interval '30 days'
              AND l.observation_count >= 2
              AND (b.is_hidden = false OR b.is_hidden IS NULL)
        """
        params = []

        if micro_market:
            params.append(micro_market)
            query += f" AND l.micro_market = ${len(params)}"
        if bhk:
            params.append(bhk)
            query += f" AND l.bhk = ${len(params)}"
        if intent:
            params.append(intent)
            query += f" AND l.intent = ${len(params)}"
        if min_price is not None:
            params.append(min_price)
            query += f" AND l.price >= ${len(params)}"
        if max_price is not None:
            params.append(max_price)
            query += f" AND l.price <= ${len(params)}"

        query += f" ORDER BY l.last_seen DESC LIMIT {limit} OFFSET {offset}"

        rows = storage.db.execute(query, params)
        return {"listings": rows.fetchall(), "count": len(rows.fetchall())}
    except Exception as exc:
        return JSONResponse(status_code=500, content={"error": str(exc)})


class PublicLeadRequest(BaseModel):
    listing_id: int
    client_name: str
    client_phone: str
    message: str | None = None


@app.post("/public/leads")
async def public_create_lead(req: PublicLeadRequest):
    """
    Create a lead from www.propai.live.
    No auth required. Validates client_phone, looks up broker from listing,
    inserts lead, and attempts WhatsApp notification (best-effort).
    """
    # Validate Indian mobile number (10 digits, optionally with +91/91/0)
    digits = "".join(ch for ch in req.client_phone if ch.isdigit())
    if len(digits) == 10:
        norm_phone = "91" + digits
    elif len(digits) == 11 and digits.startswith("0"):
        norm_phone = "91" + digits[1:]
    elif len(digits) == 12 and digits.startswith("91"):
        norm_phone = digits
    else:
        return JSONResponse(status_code=400, content={"error": "Invalid client phone number"})

    # Look up listing to get broker_phone
    res = storage.db.execute(
        "SELECT id, broker_name, broker_phone, building_name, micro_market FROM listings WHERE id = $1",
        [req.listing_id]
    )
    listing = res.fetchone()
    if not listing:
        return JSONResponse(status_code=404, content={"error": "Listing not found"})

    broker_phone = listing.get("broker_phone")
    broker_name = listing.get("broker_name")
    broker_id = None

    # If listing has no broker_phone, try to get it from brokers table via broker_name
    if not broker_phone and broker_name:
        res = storage.db.execute(
            "SELECT id, primary_phone FROM brokers WHERE canonical_name = $1 AND is_hidden = false",
            [broker_name]
        )
        broker = res.fetchone()
        if broker:
            broker_phone = broker.get("primary_phone")
            broker_id = broker.get("id")

    # If still no broker_phone, try to find broker by name
    if not broker_phone and broker_name:
        res = storage.db.execute(
            "SELECT id, primary_phone FROM brokers WHERE canonical_name = $1 AND is_hidden = false",
            [broker_name]
        )
        broker = res.fetchone()
        if broker:
            broker_phone = broker.get("primary_phone")
            broker_id = broker.get("id")

    # Also try to resolve broker_id from broker_phone if we have it
    if broker_phone and not broker_id:
        phone_variants = [
            broker_phone,
            broker_phone.replace("+91", "").replace("+91 ", "").replace(" ", ""),
            "".join(ch for ch in broker_phone if ch.isdigit())
        ]
        for variant in phone_variants:
            res = storage.db.execute(
                "SELECT id FROM brokers WHERE primary_phone = $1",
                [variant]
            )
            broker = res.fetchone()
            if broker:
                broker_id = broker.get("id")
                break

    if not broker_phone:
        return JSONResponse(status_code=500, content={"error": "Listing has no broker phone"})

    # Insert lead
    res = storage.db.execute(
        """
        INSERT INTO leads (listing_id, broker_id, client_name, client_phone, message, source, status)
        VALUES ($1, $2, $3, $4, $5, 'www_portal', 'new')
        RETURNING id, status, created_at
        """,
        [req.listing_id, broker_id, req.client_name.strip(), norm_phone, (req.message or "").strip()]
    )
    lead = res.fetchone()

    # Attempt notification (best-effort, don't fail the request)
    building_or_market = listing.get("building_name") or listing.get("micro_market") or "the listing"
    notify_text = (
        f"New PropAI enquiry — {req.client_name.strip()} ({norm_phone}) "
        f"is interested in your listing at {building_or_market}. "
        f"{(req.message or '').strip()}"
    )
    notify_result = {"ok": False, "error": "not_attempted"}
    try:
        notify_result = await _notify_broker_of_lead(broker_phone, notify_text)
    except Exception as exc:
        notify_result = {"ok": False, "error": f"notify_exception: {exc}"}

    # Best-effort status update - don't fail the request if it fails
    try:
        if notify_result and notify_result.get("ok"):
            storage.db.execute(
                "UPDATE leads SET status = 'notified' WHERE id = $1",
                [lead["id"]]
            )
        else:
            error_msg = "Unknown error"
            if notify_result:
                error_msg = str(notify_result.get("error", "Unknown error"))
            storage.db.execute(
                "UPDATE leads SET status = 'notify_failed', notify_error = $1 WHERE id = $2",
                [error_msg, lead["id"]]
            )
    except Exception as exc:
        # Ignore update failures - lead was created successfully
        pass

    return {"lead_id": lead["id"], "status": "created"}


def _send_url() -> str:
    url = os.getenv("PROPAI_SEND_URL", "")
    if url:
        return url.rstrip("/")
    try:
        status_file = os.getenv("STATUS_FILE", str(config.STATUS_FILE))
        if os.path.exists(status_file):
            with open(status_file) as f:
                status = json.load(f)
            port = status.get("send_port", 3001)
            return f"http://127.0.0.1:{port}"
    except Exception:
        pass
    return "http://127.0.0.1:3001"


async def _notify_broker_of_lead(broker_phone: str, text: str) -> dict:
    """
    Send a lead notification to a broker via whatsmeow ingestor.
    This is a system call, not user-initiated, so no auth checks.
    """
    # Normalize phone to JID format
    digits = "".join(ch for ch in broker_phone if ch.isdigit())
    if not digits:
        return {"ok": False, "error": "Invalid broker phone"}
    # Ensure Indian format: 91XXXXXXXXXX
    if len(digits) == 10:
        digits = "91" + digits
    elif len(digits) == 11 and digits.startswith("0"):
        digits = "91" + digits[1:]
    elif not digits.startswith("91"):
        digits = "91" + digits[-10:]
    remote_jid = f"{digits}@s.whatsapp.net"

    payload = {"remoteJid": remote_jid, "text": text}
    # Use INGESTOR_INTERNAL_URL env var (Coolify internal hostname)
    url = os.getenv("INGESTOR_INTERNAL_URL", "").rstrip("/")
    if not url:
        url = _send_url()
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                f"{url}/send-message", json=payload, headers=_ingestor_auth_headers()
            )
            if resp.status_code < 300:
                return {"ok": True, "status_code": resp.status_code}
            return {"ok": False, "error": f"HTTP {resp.status_code}: {resp.text}"}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


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
async def ai_config(user: dict = Depends(require_user)):
    import llm as _llm
    info = _llm.get_provider_info()
    return {
        "has_server_key": info.get("provider_name") != "none",
        "base_url": info.get("base_url", ""),
        "model": info.get("model_name", ""),
        "provider": info.get("provider_name", "none"),
    }


# ── Chat Suggestion Chips ──────────────────────────────────────

_chip_cache: dict = {}
_chip_cache_at: float = 0.0

@app.get("/api/chat/suggestions")
async def chat_suggestions(user: dict = Depends(require_user)):
    now = time.time()
    if _chip_cache and (now - _chip_cache_at) < 3600:
        return _chip_cache

    week_ago = (datetime.utcnow() - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")

    top_building = storage.db.execute("""
        SELECT p.building_name, COUNT(*) AS cnt FROM parsed_output p
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE p.building_name IS NOT NULL AND p.building_name != ''
          AND r.timestamp >= ?
        GROUP BY p.building_name ORDER BY cnt DESC LIMIT 1
    """, (week_ago,)).fetchone()

    top_supply_market = storage.db.execute("""
        SELECT p.micro_market, COUNT(*) AS cnt FROM parsed_output p
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE p.intent IN ('SELL','RENT','COMMERCIAL')
          AND p.micro_market IS NOT NULL AND p.micro_market != ''
          AND r.timestamp >= ?
        GROUP BY p.micro_market ORDER BY cnt DESC LIMIT 1
    """, (week_ago,)).fetchone()

    top_demand_market = storage.db.execute("""
        SELECT p.micro_market, COUNT(*) AS cnt FROM parsed_output p
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE p.intent IN ('BUY','RENTAL_SEEKER')
          AND p.micro_market IS NOT NULL AND p.micro_market != ''
          AND r.timestamp >= ?
        GROUP BY p.micro_market ORDER BY cnt DESC LIMIT 1
    """, (week_ago,)).fetchone()

    top_commercial_market = storage.db.execute("""
        SELECT p.micro_market, COUNT(*) AS cnt FROM parsed_output p
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE p.intent = 'COMMERCIAL'
          AND p.micro_market IS NOT NULL AND p.micro_market != ''
          AND r.timestamp >= ?
        GROUP BY p.micro_market ORDER BY cnt DESC LIMIT 1
    """, (week_ago,)).fetchone()

    top_rental_market = storage.db.execute("""
        SELECT p.micro_market, COUNT(*) AS cnt FROM parsed_output p
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE p.intent = 'RENT'
          AND p.micro_market IS NOT NULL AND p.micro_market != ''
          AND r.timestamp >= ?
        GROUP BY p.micro_market ORDER BY cnt DESC LIMIT 1
    """, (week_ago,)).fetchone()

    def _val(row):
        return row[0] if row else None

    def _with_fallback(seven_day_result, fallback_query, params=()):
        v = _val(seven_day_result)
        if v is not None:
            return v
        row = storage.db.execute(fallback_query, params).fetchone()
        return row[0] if row else None

    result = {
        "top_building": _with_fallback(
            top_building,
            "SELECT p.building_name, COUNT(*) AS cnt FROM parsed_output p "
            "JOIN raw_messages r ON r.id = p.raw_message_id "
            "WHERE p.building_name IS NOT NULL AND p.building_name != '' "
            "GROUP BY p.building_name ORDER BY cnt DESC LIMIT 1"
        ),
        "top_supply_market": _with_fallback(
            top_supply_market,
            "SELECT p.micro_market, COUNT(*) AS cnt FROM parsed_output p "
            "JOIN raw_messages r ON r.id = p.raw_message_id "
            "WHERE p.intent IN ('SELL','RENT','COMMERCIAL') "
            "AND p.micro_market IS NOT NULL AND p.micro_market != '' "
            "GROUP BY p.micro_market ORDER BY cnt DESC LIMIT 1"
        ),
        "top_demand_market": _with_fallback(
            top_demand_market,
            "SELECT p.micro_market, COUNT(*) AS cnt FROM parsed_output p "
            "JOIN raw_messages r ON r.id = p.raw_message_id "
            "WHERE p.intent IN ('BUY','RENTAL_SEEKER') "
            "AND p.micro_market IS NOT NULL AND p.micro_market != '' "
            "GROUP BY p.micro_market ORDER BY cnt DESC LIMIT 1"
        ),
        "top_commercial_market": _with_fallback(
            top_commercial_market,
            "SELECT p.micro_market, COUNT(*) AS cnt FROM parsed_output p "
            "JOIN raw_messages r ON r.id = p.raw_message_id "
            "WHERE p.intent = 'COMMERCIAL' "
            "AND p.micro_market IS NOT NULL AND p.micro_market != '' "
            "GROUP BY p.micro_market ORDER BY cnt DESC LIMIT 1"
        ),
        "top_rental_market": _with_fallback(
            top_rental_market,
            "SELECT p.micro_market, COUNT(*) AS cnt FROM parsed_output p "
            "JOIN raw_messages r ON r.id = p.raw_message_id "
            "WHERE p.intent = 'RENT' "
            "AND p.micro_market IS NOT NULL AND p.micro_market != '' "
            "GROUP BY p.micro_market ORDER BY cnt DESC LIMIT 1"
        ),
    }
    result["top_broker_building"] = result["top_building"]

    _chip_cache.clear()
    _chip_cache.update(result)
    _chip_cache_at = now
    return result


# ── AI Chat Sessions CRUD ──────────────────────────────────────

@app.get("/api/ai/chat/sessions")
async def list_chat_sessions(broker_phone: str = "", limit: int = 50, user: dict = Depends(require_user), tenant_id: str | None = Depends(get_tenant_context)):
    if not broker_phone:
        return []
    return storage.list_chat_sessions(broker_phone, limit=limit, tenant_id=tenant_id)


@app.post("/api/ai/chat/sessions")
async def create_chat_session(broker_phone: str = "", title: str = "New chat", user: dict = Depends(require_user), tenant_id: str | None = Depends(get_tenant_context)):
    if not broker_phone:
        raise HTTPException(400, "broker_phone required")
    return storage.create_chat_session(broker_phone, title=title, tenant_id=tenant_id) or {}


@app.get("/api/ai/chat/sessions/{session_id}/messages")
async def get_chat_session_messages(session_id: str, user: dict = Depends(require_user), tenant_id: str | None = Depends(get_tenant_context)):
    session = storage.get_chat_session(session_id, tenant_id=tenant_id)
    if not session:
        raise HTTPException(404, "Session not found")
    return storage.get_ai_chat_messages(session_id, tenant_id=tenant_id)


@app.delete("/api/ai/chat/sessions/{session_id}")
async def delete_chat_session(session_id: str, user: dict = Depends(require_user), tenant_id: str | None = Depends(get_tenant_context)):
    storage.delete_chat_session(session_id, tenant_id=tenant_id)
    return {"ok": True}


@app.post("/api/ai/chat")
async def ai_chat(req: ChatRequest, user: dict = Depends(require_user), tenant_id: str | None = Depends(get_tenant_context)):
    # Conversation memory (session-aware, not just message count)
    from ai_chat_engine import get_memory
    session_id = req.session_id or "default"
    memory = get_memory(session_id)

    # Populate memory with incoming messages (idempotent — skips already-seen content)
    for msg in req.messages:
        role = msg.get("role", "")
        content = str(msg.get("content", "")).strip()
        if content:
            if not memory.working or memory.working[-1].get("content") != content:
                memory.add(role, content)

    # Persist messages to DB if session_id provided
    def _persist(role: str, content: str) -> None:
        if not req.session_id or not content:
            return
        try:
            storage.add_chat_message(req.session_id, role, content, tenant_id=tenant_id)
            storage.touch_chat_session(req.session_id, tenant_id=tenant_id)
        except Exception:
            pass

    # Auto-title: if this is the first user message, title the session
    def _maybe_title(text: str) -> None:
        if not req.session_id or not text:
            return
        try:
            msgs = storage.get_ai_chat_messages(req.session_id, limit=3, tenant_id=tenant_id)
            user_msgs = [m for m in msgs if m.get("role") == "user"]
            if len(user_msgs) <= 1:
                title = text[:80].strip()
                storage.update_chat_session_title(req.session_id, title, tenant_id=tenant_id)
        except Exception:
            pass

    broker = None
    if req.broker_phone:
        try:
            _bp = storage.get_user_profile(req.broker_phone, tenant_id=tenant_id)
            if _bp and (_bp.get("first_name") or _bp.get("last_name")):
                broker = {
                    "name": f"{_bp.get('first_name', '')} {_bp.get('last_name', '')}".strip(),
                    "phone": req.broker_phone,
                    "city": _bp.get("city", ""),
                }
        except Exception:
            pass

    # If there are no query signals, use the LLM conversational path without tools.
    last_user = ""
    for msg in reversed(req.messages):
        if msg.get("role") == "user":
            last_user = str(msg.get("content", "")).strip()
            break

    _is_inbox = req.source == "inbox"

    # Capability questions → tool-enabled prompt, text-only mode (no tool calls)
    if last_user and _CAPABILITY_SIGNALS.search(last_user):
        try:
            cap_sources = chat_engine.load_data()
            cap_live = chat_engine.load_live_data(getattr(storage, "db", None))
            cap_sources.update(cap_live)
            if cap_sources:
                cap_msgs = [
                    {"role": "system", "content": chat_engine.build_system_prompt(cap_sources, broker=broker)},
                    {"role": "user", "content": last_user},
                ]
                loop = asyncio.get_running_loop()
                cap_reply = await asyncio.wait_for(
                    loop.run_in_executor(
                        None,
                        lambda: chat_engine.get_model_reply(
                            cap_msgs, cap_sources, api_key=req.api_key or "",
                            model=req.model.strip() or None, max_tool_rounds=0,
                        ),
                    ),
                    timeout=30,
                )
                text = (cap_reply.content or "").strip() or "I can help with that."
                _persist("user", last_user)
                _persist("assistant", text)
                _maybe_title(last_user)
                return {
                    "content": text,
                    "blocks": [{"type": "summary", "body": text}],
                    "sources": list(cap_sources.keys()),
                    "status_steps": [],
                    "trace": {"route": "capability_llm"},
                }
        except Exception:
            pass  # fall through to conversational path

    if last_user and not _has_query_signals(last_user):
        try:
            loop = asyncio.get_running_loop()
            reply = await asyncio.wait_for(
                loop.run_in_executor(
                    None,
                    lambda: chat_engine.get_conversational_reply(
                        req.messages, api_key=req.api_key or "", model=req.model.strip() or None, broker=broker
                    ),
                ),
                timeout=30,
            )
            text = (reply.content or "").strip()
            if text:
                _persist("user", last_user)
                _persist("assistant", text)
                _maybe_title(last_user)
                return {
                    "content": text,
                    "blocks": [{"type": "greeting", "body": text}],
                    "sources": [],
                    "status_steps": [],
                    "trace": {"route": "conversational_llm"},
                }
            else:
                return {
                    "content": "AI returned an empty response. Please try again.",
                    "blocks": [{"type": "error", "body": "AI returned an empty response. Please try again."}],
                    "sources": [],
                    "status_steps": [],
                    "trace": {"route": "conversational_empty"},
                }
        except Exception as exc:
            return {
                "content": f"AI chat failed: {exc}. Please try again.",
                "blocks": [{"type": "error", "body": f"AI chat failed: {exc}. Please try again."}],
                "sources": [],
                "trace": {"route": "conversational_error"},
            }

    # Topic-aware context compaction
    if last_user and memory.detect_topic_change(last_user) and len(memory.working) > 2:
        memory.compact_topic()
    memory.prune()

    sources = chat_engine.load_data()
    try:
        live = chat_engine.load_live_data(getattr(storage, "db", None))
        sources.update(live)
    except Exception:
        pass
    if not sources:
        return {"error": "no_data", "message": "No data found. Check CSV files and database."}

    # Concrete property questions must reach the market database regardless of
    # whether an LLM happens to choose a tool call. The model remains available
    # for broader analysis, but it is no longer the search gatekeeper.
    deterministic_query = chat_engine.parse_market_search_request(last_user)
    if deterministic_query:
        try:
            search_result = await asyncio.to_thread(
                chat_engine.execute_tool,
                "market_search",
                deterministic_query,
                sources,
                getattr(storage, "db", None),
                tenant_id,
            )
            response = chat_engine.deterministic_market_response(
                deterministic_query, search_result, sources
            )
            _persist("user", last_user)
            _persist("assistant", response.get("content", ""))
            _maybe_title(last_user)
            return response
        except Exception as exc:
            _logger.warning("Deterministic market search failed: %s", exc)
            response = chat_engine.deterministic_market_response(
                deterministic_query, "", sources
            )
            _persist("user", last_user)
            _persist("assistant", response.get("content", ""))
            _maybe_title(last_user)
            return response

    loop = asyncio.get_running_loop()

    def _call():
        system_prompt = chat_engine.build_system_prompt(sources, broker=broker)
        context = memory.build_context()
        msgs = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": context},
        ]
        reply = chat_engine.get_model_reply(
            msgs,
            sources,
            api_key=req.api_key or "",
            model=req.model.strip() or None,
            max_tool_rounds=2,
        )
        # Store assistant reply in memory
        if reply.content:
            memory.add("assistant", reply.content)
        return chat_engine.normalize_workspace_response(reply.content or "", sources)

    try:
        response = await asyncio.wait_for(loop.run_in_executor(None, _call), timeout=90)
        _persist("user", last_user)
        _persist("assistant", response.get("content", ""))
        _maybe_title(last_user)
        return response
    except asyncio.TimeoutError:
        return JSONResponse(
            status_code=504,
            content={"error": "timeout", "message": "Request timed out. Try a simpler query."},
        )
    except Exception as exc:
        return _doubleword_error_response(exc)


@app.get("/api/ai/chat/overview")
async def ai_chat_overview(user: dict = Depends(require_user)):
    sources = chat_engine.load_data()
    live = chat_engine.load_live_data(getattr(storage, "db", None))
    sources.update(live)
    if not sources:
        return {"error": "no_data"}
    return {"overview": chat_engine.build_overview(sources), "sources": list(sources.keys())}


# ── Evidence Inspector ──────────────────────────────────────────

@app.get("/api/observations/{obs_id}")
async def get_observation(obs_id: int, user: dict = Depends(require_user)):
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
async def replay_all(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    """Re-run all stored messages through the current resolver and return accuracy stats."""
    raws = storage.get_all_raw_for_replay(tenant_id=tenant_id)

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
async def list_sources(user: dict = Depends(require_user)):
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
async def scheduler_status(user: dict = Depends(require_user)):
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
async def list_jobs(source: str = "", status: str = "", limit: int = 50, user: dict = Depends(require_user)):
    """List sync jobs, optionally filtered by source and/or status."""
    jobs = storage.get_sync_jobs(limit=limit, source=source, status=status)
    return [asdict(j) for j in jobs]


@app.get("/api/sources/jobs/{job_id}")
async def get_job_detail(job_id: int, user: dict = Depends(require_user)):
    """Get details for a specific sync job."""
    job = storage.get_sync_job(job_id)
    if not job:
        raise HTTPException(404, f"Job {job_id} not found")
    return asdict(job)


@app.post("/api/sources/stop")
async def scheduler_stop(user: dict = Depends(require_user)):
    """Stop the sync scheduler."""
    scheduler = get_scheduler()
    scheduler.stop()
    return {"status": "stopping", "message": "Scheduler stop requested"}


@app.post("/api/sources/{source_name}/sync")
async def source_sync(source_name: str, user: dict = Depends(require_user)):
    """Start sync for a specific source."""
    if source_name == "whatsapp":
        raise HTTPException(
            410,
            "WhatsApp history sync is automatic after QR pairing. PropAI stores live and historical messages through the WhatsApp ingestor.",
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
async def get_source(source_name: str, user: dict = Depends(require_user)):
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


class BusinessApiTeamMemberRequest(BaseModel):
    name: str
    mobile_number: str
    role: str = "sales_agent"
    assigned_markets: list[str] = []
    active: bool = True
    waba_identity: str = ""


class BusinessApiConfigRequest(BaseModel):
    whatsapp_business_number: str = ""
    phone_number_id: str = ""
    access_token: str = ""
    verify_token: str = ""
    clear_access_token: bool = False
    clear_verify_token: bool = False


PROPAI_SHARED_WABA_NUMBER = "+917021045254"


def _mobile_digits(value: str = "") -> str:
    digits = re.sub(r"\D+", "", value or "")
    if len(digits) > 10 and digits.startswith("91"):
        return digits[-10:]
    return digits


def _is_propai_shared_waba(value: str = "") -> bool:
    return _mobile_digits(value) == _mobile_digits(PROPAI_SHARED_WABA_NUMBER)


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


def _business_api_member(row) -> dict:
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


def _table_exists(table: str) -> bool:
    try:
        row = storage.db.execute(
            "SELECT 1 FROM information_schema.tables "
            "WHERE table_schema = 'public' AND table_name = ?",
            (table,),
        ).fetchone()
        return row is not None
    except Exception:
        return False


def _business_api_get_config_value(key: str, env_key: str = "") -> str:
    try:
        row = storage.db.execute(
            "SELECT value FROM business_api_config WHERE key = ?", (key,)
        ).fetchone()
        if row and row["value"]:
            return row["value"]
    except Exception:
        pass
    return os.getenv(env_key or key, "")


def _business_api_set_config_value(key: str, value: str):
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    storage.db.execute(
        """INSERT INTO business_api_config (key, value, updated_at)
           VALUES (?,?,?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at""",
        (key, value, now),
    )
    storage.db.commit()


def _market_sync_ready(details: dict) -> bool:
    captured = details.get("messages_captured")
    try:
        if captured is not None and int(captured) > 0:
            return True
    except Exception:
        pass
    return _count_table("raw_messages") > 0


def _mask_secret(value: str = "") -> str:
    if not value:
        return ""
    if len(value) <= 8:
        return "••••"
    return f"{value[:4]}••••{value[-4:]}"


_memory_status: dict = {}
_previous_status: dict = {}
_broker_live_statuses: dict[str, tuple[dict, float]] = {}
_last_live_connection_status: dict = {}
_last_live_connection_seen_at: float = 0.0
_CONNECTION_CACHE_GRACE_SECONDS = 90.0


def _normalize_connection_snapshot(status: dict | None) -> dict:
    status = status or {}
    connected = bool(status.get("connected"))
    connection_state = str(status.get("connection_state") or ("open" if connected else "unknown")).lower()
    return {
        "connected": connected,
        "connection_state": connection_state,
        "instance_name": status.get("instance") or status.get("instance_name") or "propai-whatsapp",
        "device_name": status.get("device_name") or "WhatsApp ingestor",
        "phone_number": _display_phone_from_whatsapp_id(status.get("phone_number") or ""),
        "display_name": status.get("display_name") or "",
        "connected_since": status.get("connected_since") or None,
        "last_message_at": status.get("last_message_at") or None,
        "total_groups": status.get("total_groups"),
        "messages_captured": status.get("messages_captured"),
        "status_stale": bool(status.get("status_stale")),
    }


def _should_cache_connection_snapshot(status: dict | None) -> bool:
    if not status:
        return False
    state = str(status.get("connection_state") or "").lower()
    return bool(status.get("connected")) or state in {"open", "qr", "connecting", "scanning", "reconnecting"}


def _cache_connection_snapshot(status: dict | None) -> None:
    global _last_live_connection_status, _last_live_connection_seen_at
    if not _should_cache_connection_snapshot(status):
        return
    _last_live_connection_status = _normalize_connection_snapshot(status)
    _last_live_connection_seen_at = time.time()

def _status_file() -> dict:
    # Prefer the file — ingestor writes synchronously, so it's always current.
    # Memory is a fallback for when no file exists yet.
    candidates = [
        STATUS_FILE,
        PROJECT_DIR / "status.json",
        Path("/data/status.json"),
        Path("/data/status_default.json"),
    ]
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
    if _memory_status:
        return _memory_status
    return {"connection_state": "unknown", "connected": False}


def _status_file_debug() -> dict:
    candidates = [
        STATUS_FILE,
        PROJECT_DIR / "status.json",
        Path("/data/status.json"),
        Path("/data/status_default.json"),
    ]
    seen: set[str] = set()
    candidate_results = []
    for path in candidates:
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        result = {
            "path": key,
            "exists": False,
            "readable": False,
            "parse_error": None,
            "data_preview": None,
        }
        try:
            if path.exists():
                result["exists"] = True
                content = path.read_text()
                data = json.loads(content)
                if isinstance(data, dict):
                    result["readable"] = True
                    result["data_preview"] = {k: data[k] for k in list(data.keys())[:8]}
        except Exception as exc:
            result["parse_error"] = str(exc)
        candidate_results.append(result)
    return {
        "candidates": candidate_results,
        "memory_status_available": bool(_memory_status),
        "memory_status_preview": _memory_status if _memory_status else None,
    }


@app.get("/api/debug/sync/status-file")
async def debug_sync_status_file(user: dict = Depends(require_user)):
    return _status_file_debug()


@app.get("/api/debug/sync/connection")
async def debug_sync_connection(user: dict = Depends(require_user)):
    status = _status_file()
    return {
        "status_source": "memory" if _memory_status and not status.get("connection_state") else "file_or_memory",
        "connection_state": status.get("connection_state"),
        "connected": status.get("connected"),
        "qr": status.get("qr"),
        "qr_available": status.get("qr_available"),
        "status_preview": {k: status[k] for k in list(status.keys())[:12]},
        "computed_connection_details": _connection_details(),
    }


def _status_has_live_signal(status: dict | None) -> bool:
    if not status:
        return False
    state = str(status.get("connection_state") or "").lower()
    if status.get("connected") or status.get("qr") or status.get("phone_number"):
        return True
    return state not in ("", "unknown")


def _today_count(table: str, column: str = "created_at", where: str = "1=1") -> int:
    try:
        return storage.db.execute(
            f"SELECT COUNT(*) AS c FROM {table} WHERE DATE({column}) = DATE('now') AND {where}"
        ).fetchone()["c"]
    except Exception:
        return 0


@app.get("/api/business-api/overview")
async def business_api_overview(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    team_count = _count_table("business_api_team_members")
    active_team = storage.db.execute(
        "SELECT COUNT(*) AS c FROM business_api_team_members WHERE active = 1"
    ).fetchone()["c"]
    pending_conversations = storage.db.execute(
        "SELECT COUNT(*) AS c FROM business_api_conversations WHERE status IN ('needs_human', 'pending_approval')"
    ).fetchone()["c"]
    last_sync_row = storage.db.execute(
        "SELECT MAX(timestamp) AS ts FROM raw_messages"
    ).fetchone()
    last_sync = last_sync_row["ts"] if last_sync_row else None
    inbound_today = _today_count("business_api_messages", where="direction = 'inbound'")
    outbound_today = _today_count("business_api_messages", where="direction = 'outbound'")
    ai_today = _today_count("ai_usage_log")
    messages_today = _today_count("raw_messages", "timestamp")
    is_super_admin = await asyncio.to_thread(storage.is_super_admin, user["id"])
    if is_super_admin:
        waba_values = _platform_waba_values()
    else:
        org_id = _resolve_active_organization_id(user, tenant_id)
        waba_values = await _workspace_waba_values(org_id)
    waba_number = str(waba_values.get("whatsapp_business_number") or "")
    waba_phone_number_id = str(waba_values.get("phone_number_id") or "")
    waba_access_token = str(waba_values.get("access_token") or "")
    waba_verify_token = str(waba_values.get("verify_token") or "")
    waba_is_shared = _is_propai_shared_waba(waba_number)
    outbound_allowed = bool(
        waba_number
        and waba_phone_number_id
        and waba_access_token
        and (is_super_admin or not waba_is_shared)
    )
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
        "connection_status": "connected" if outbound_allowed else "not_connected",
        "whatsapp_business_number": waba_number,
        "shared_waba_number": PROPAI_SHARED_WABA_NUMBER,
        "waba_owner": "propai" if waba_is_shared else ("broker" if waba_number else "none"),
        "outbound_allowed": outbound_allowed,
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


def _platform_waba_values() -> dict:
    return {
        "whatsapp_business_number": (
            _business_api_get_config_value("whatsapp_business_number", "WABA_PHONE_NUMBER")
            or _business_api_get_config_value("whatsapp_business_number", "WABA_BUSINESS_NUMBER")
        ),
        "phone_number_id": _business_api_get_config_value("phone_number_id", "WABA_PHONE_NUMBER_ID"),
        "access_token": _business_api_get_config_value("access_token", "WABA_ACCESS_TOKEN"),
        "verify_token": _business_api_get_config_value("verify_token", "WABA_VERIFY_TOKEN"),
    }


def _waba_callback_url(org_id: str | None = None) -> str:
    base = os.getenv("PUBLIC_API_URL", "https://api.propai.live").rstrip("/")
    path = "/api/whatsapp/cloud/webhook"
    return f"{base}{path}/{org_id}" if org_id else f"{base}{path}"


async def _workspace_waba_values(org_id: str) -> dict:
    getter = getattr(storage, "get_org_waba_connection", None)
    if not getter:
        return {}
    try:
        return await asyncio.to_thread(getter, org_id) or {}
    except Exception as exc:
        # During a rolling deploy the API may start before the migration lands.
        print(f"[waba-config] workspace lookup failed org={org_id}: {exc}", flush=True)
        return {}


async def _business_api_config_for(user: dict, tenant_id: str | None) -> dict:
    is_super_admin = await asyncio.to_thread(storage.is_super_admin, user["id"])
    if is_super_admin:
        values = _platform_waba_values()
        number = values["whatsapp_business_number"]
        configured = bool(number and values["phone_number_id"] and values["access_token"])
        return {
            "is_super_admin": True,
            "can_manage_platform": True,
            "whatsapp_business_number": number,
            "shared_waba_number": PROPAI_SHARED_WABA_NUMBER,
            "waba_owner": "propai" if number else "none",
            "outbound_allowed": configured,
            "phone_number_id": values["phone_number_id"],
            "has_access_token": bool(values["access_token"]),
            "access_token_preview": _mask_secret(values["access_token"]),
            "has_verify_token": bool(values["verify_token"]),
            "verify_token_preview": _mask_secret(values["verify_token"]),
            "webhook_callback_url": _waba_callback_url(),
        }

    org_id = _resolve_active_organization_id(user, tenant_id)
    values = await _workspace_waba_values(org_id)
    number = str(values.get("whatsapp_business_number") or "")
    configured = bool(
        values.get("is_active", True)
        and number
        and values.get("phone_number_id")
        and values.get("access_token")
    )
    return {
        "is_super_admin": False,
        "can_manage_platform": False,
        "whatsapp_business_number": number,
        "shared_waba_number": PROPAI_SHARED_WABA_NUMBER,
        "waba_owner": "broker" if number else "none",
        "outbound_allowed": configured,
        "phone_number_id": str(values.get("phone_number_id") or ""),
        "has_access_token": bool(values.get("access_token")),
        "access_token_preview": "",
        "has_verify_token": bool(values.get("verify_token")),
        "verify_token_preview": "",
        "webhook_callback_url": _waba_callback_url(org_id),
    }


@app.get("/api/business-api/config")
async def business_api_config(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    return await _business_api_config_for(user, tenant_id)


@app.post("/api/business-api/config")
async def business_api_save_config(
    req: BusinessApiConfigRequest,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    is_super_admin = await asyncio.to_thread(storage.is_super_admin, user["id"])
    org_id = None if is_super_admin else _resolve_active_organization_id(user, tenant_id)
    if org_id:
        await _require_org_permission(user, org_id, "manage_whatsapp")

    requested_number = req.whatsapp_business_number.strip()
    if requested_number and _is_propai_shared_waba(requested_number) and not is_super_admin:
        raise HTTPException(
            403,
            "PropAI shared WABA is reserved for the assistant. Connect a number owned by your workspace.",
        )

    if is_super_admin:
        if requested_number:
            _business_api_set_config_value("whatsapp_business_number", requested_number)
        if req.phone_number_id.strip():
            _business_api_set_config_value("phone_number_id", req.phone_number_id.strip())
        if req.clear_access_token:
            _business_api_set_config_value("access_token", "")
        elif req.access_token.strip():
            _business_api_set_config_value("access_token", req.access_token.strip())
        if req.clear_verify_token:
            _business_api_set_config_value("verify_token", "")
        elif req.verify_token.strip():
            _business_api_set_config_value("verify_token", req.verify_token.strip())
    else:
        current = await _workspace_waba_values(org_id)
        values = {
            "whatsapp_business_number": requested_number or current.get("whatsapp_business_number"),
            "phone_number_id": req.phone_number_id.strip() or current.get("phone_number_id"),
            "access_token": (
                "" if req.clear_access_token else req.access_token.strip() or current.get("access_token")
            ),
            "verify_token": (
                "" if req.clear_verify_token else req.verify_token.strip() or current.get("verify_token")
            ),
            "is_active": True,
        }
        missing = [
            label
            for key, label in (
                ("whatsapp_business_number", "WhatsApp Business Number"),
                ("phone_number_id", "Phone Number ID"),
                ("access_token", "Access Token"),
                ("verify_token", "Verify Token"),
            )
            if not values.get(key)
        ]
        if missing:
            raise HTTPException(400, f"Missing: {', '.join(missing)}")
        upsert = getattr(storage, "upsert_org_waba_connection", None)
        if not upsert:
            raise HTTPException(503, "Workspace WABA storage is not available")
        try:
            await asyncio.to_thread(upsert, org_id, values)
        except Exception as exc:
            print(f"[waba-config] workspace save failed org={org_id}: {exc}", flush=True)
            raise HTTPException(503, "Could not save workspace WABA configuration") from exc

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    storage.db.execute(
        """INSERT INTO business_api_audit_log
           (action, target_type, target_id, status, details, created_at)
           VALUES (?,?,?,?,?,?)""",
        (
            "waba_config_updated",
            "org_waba_connection" if org_id else "business_api_config",
            org_id or "platform",
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
    return await _business_api_config_for(user, tenant_id)


@app.get("/api/business-api/webhook")
async def business_api_webhook_verify(request: Request):
    mode = request.query_params.get("hub.mode", "")
    token = request.query_params.get("hub.verify_token", "")
    challenge = request.query_params.get("hub.challenge", "")
    expected = _business_api_get_config_value("verify_token", "WABA_VERIFY_TOKEN")
    if mode == "subscribe" and expected and token == expected:
        return Response(content=challenge, media_type="text/plain")
    raise HTTPException(403, "Webhook verify token does not match")


async def _download_waba_media(media_id: str, access_token: str = "") -> dict | None:
    """Download media from WhatsApp Business API. Returns {filename, filepath, mime_type} or None."""
    access_token = access_token or _business_api_get_config_value("access_token", "WABA_ACCESS_TOKEN")
    if not access_token:
        return None
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(
                f"https://graph.facebook.com/v21.0/{media_id}",
                params={"access_token": access_token},
            )
            if resp.status_code != 200:
                return None
            media_info = resp.json()
            url = media_info.get("url")
            mime_type = media_info.get("mime_type", "image/jpeg")
            if not url:
                return None
            file_resp = await client.get(url, params={"access_token": access_token})
            if file_resp.status_code != 200:
                return None
            ext = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}.get(mime_type, ".jpg")
            filename = f"{media_id}{ext}"
            filepath = str(MEDIA_DIR / filename)
            MEDIA_DIR.mkdir(parents=True, exist_ok=True)
            Path(filepath).write_bytes(file_resp.content)
            return {"filename": filename, "filepath": filepath, "mime_type": mime_type}
    except Exception:
        return None


async def _resolve_waba_webhook_config(body: dict, org_id: str | None = None) -> tuple[dict, str | None]:
    phone_number_id = ""
    sender_phone = ""
    for entry in body.get("entry", []) if isinstance(body, dict) else []:
        for change in entry.get("changes", []):
            value = change.get("value") or {}
            metadata = value.get("metadata") or {}
            phone_number_id = str(metadata.get("phone_number_id") or "").strip()
            messages = value.get("messages") or []
            if messages and not sender_phone:
                sender_phone = re.sub(r"\D+", "", str(messages[0].get("from") or ""))
            if phone_number_id:
                break
    if org_id:
        values = await _workspace_waba_values(org_id)
        if not values or str(values.get("phone_number_id") or "") != phone_number_id:
            raise HTTPException(403, "Webhook phone number does not belong to this workspace")
        return values, org_id
    getter = getattr(storage, "get_org_waba_connection_by_phone_number_id", None)
    if getter and phone_number_id:
        try:
            values = await asyncio.to_thread(getter, phone_number_id)
            if values:
                return values, str(values.get("organization_id") or "") or None
        except Exception as exc:
            print(f"[waba-webhook] workspace resolve failed: {exc}", flush=True)
    # The shared PropAI number is an assistant entry point. A number paired by
    # QR inside an authenticated workspace is already a verified workspace
    # identity. Resolve that first; a profile phone is merely a fallback.
    if sender_phone:
        try:
            connection = await asyncio.to_thread(
                storage.get_active_org_whatsapp_connection_by_phone, sender_phone
            )
            if connection and connection.get("organization_id"):
                return _platform_waba_values(), str(connection["organization_id"])
        except Exception as exc:
            print(f"[waba-webhook] QR connection workspace resolve failed: {exc}", flush=True)
        try:
            profile = await asyncio.to_thread(storage.get_user_profile, sender_phone, "")
            auth_user_id = str((profile or {}).get("auth_user_id") or "")
            if auth_user_id:
                orgs = await asyncio.to_thread(storage.get_user_organizations, auth_user_id)
                active = next((row for row in orgs if row.get("id")), None)
                if active:
                    return _platform_waba_values(), str(active["id"])
        except Exception as exc:
            print(f"[waba-webhook] shared sender workspace resolve failed: {exc}", flush=True)
    return _platform_waba_values(), None


async def _process_business_api_webhook(
    body: dict,
    org_id: str | None = None,
    resolved_config: dict | None = None,
):
    waba_config, resolved_tenant_id = (
        (resolved_config, org_id)
        if resolved_config is not None
        else await _resolve_waba_webhook_config(body, org_id)
    )
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    processed = []

    for entry in body.get("entry", []):
        for change in entry.get("changes", []):
            value = change.get("value", {})
            for msg in value.get("messages", []):
                msg_from = msg.get("from", "")
                msg_id = msg.get("id", "")
                msg_type = msg.get("type", "")
                caption = ""
                pic_token = ""
                media_id = ""
                stored_inbound = False
                sender_name = ""

                # Only persist text-bearing message types. Meta sends
                # type=unsupported for voice calls / payments / etc with
                # no body; writing those as raw rows creates inbox orphans.
                if msg_type not in _BUSINESS_API_PERSISTABLE_TYPES:
                    print(
                        f"[waba-webhook] skipping non-persistable msg_type={msg_type!r} "
                        f"id={msg_id} from={msg_from}",
                        flush=True,
                    )
                    processed.append({"type": "msg_type_skipped", "msg_type": msg_type, "id": msg_id})
                    continue

                # Track 24h session window — user messaged us
                try:
                    _waba_session_update(msg_from, direction="inbound")
                except Exception:
                    pass

                if msg_type == "image":
                    img = msg.get("image", {})
                    media_id = img.get("id", "")
                    caption = img.get("caption", "") or ""

                elif msg_type == "text":
                    caption = msg.get("text", {}).get("body", "")

                if caption:
                    m = PIC_TOKEN_RE.search(caption)
                    if m:
                        pic_token = m.group(0)
                        listing_id = int(m.group(1))
                        listing_data = storage.get_listing_by_pic_token(pic_token)
                        if listing_data:
                            if msg_type == "image" and media_id:
                                dl = await _download_waba_media(
                                    media_id, str(waba_config.get("access_token") or "")
                                )
                                if dl:
                                    contact = (value.get("contacts") or [{}])[0]
                                    sender_name = contact.get("profile", {}).get("name", "") if contact else ""
                                    photo_id = storage.save_listing_photo(
                                        listing_id=listing_id,
                                        pic_token=pic_token,
                                        media_id=media_id,
                                        filename=dl["filename"],
                                        filepath=dl["filepath"],
                                        mime_type=dl["mime_type"],
                                        caption=caption,
                                        sender_phone=msg_from,
                                        sender_name=sender_name,
                                    )
                                    processed.append({"type": "listing_photo_saved", "listing_id": listing_id, "photo_id": photo_id})
                                else:
                                    processed.append({"type": "media_download_failed", "listing_id": listing_id, "media_id": media_id})
                            elif msg_type == "text":
                                processed.append({"type": "pic_token_received_no_image", "listing_id": listing_id, "pic_token": pic_token, "from": msg_from})

                # Store ALL inbound messages in raw_messages (not just PIC tokens)
                # so they appear in the inbox
                try:
                    contact = (value.get("contacts") or [{}])[0]
                    sender_name = contact.get("profile", {}).get("name", "") if contact else ""
                    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                    digits = msg_from.replace("+", "").replace(" ", "").replace("-", "").strip()
                    if digits.startswith("0"):
                        digits = digits[1:]
                    sender_jid = f"{digits}@s.whatsapp.net"

                    inserted = storage.db.execute(
                        """INSERT INTO raw_messages
                           (tenant_id, group_name, sender, sender_jid, sender_phone, message, message_type,
                            source, timestamp, raw_payload, message_uid, synced_at, created_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                           ON CONFLICT DO NOTHING""",
                        (
                            resolved_tenant_id or DEFAULT_TENANT_ID,
                            sender_jid,
                            sender_name or msg_from,
                            sender_jid,
                            digits,
                            caption if caption else (msg.get("image", {}).get("caption", "") if msg_type == "image" else f"[{msg_type}]"),
                            msg_type,
                            "WABA_INBOUND",
                            now_iso,
                            json.dumps({"waba_message_id": msg_id, "from": msg_from}),
                            f"waba-in-{msg_id}",
                            now_iso,
                            now_iso,
                        ),
                    ).rowcount
                    stored_inbound = inserted > 0
                    if stored_inbound:
                        processed.append({"type": "message_stored", "from": msg_from, "msg_type": msg_type})
                    else:
                        processed.append({"type": "duplicate_message_ignored", "from": msg_from, "msg_type": msg_type})
                except Exception as exc:
                    print(f"[waba-webhook] failed to store inbound message: {exc}", flush=True)

                # Meta retries webhook deliveries. Only trigger the agent when the
                # unique inbound row was inserted, otherwise one user message can
                # receive multiple bot replies.
                if stored_inbound and msg_type == "text" and caption.strip():
                    asyncio.create_task(
                        _handle_waba_agent_reply(
                            to=msg_from,
                            text=caption.strip(),
                            inbound_message_id=msg_id,
                            sender_name=sender_name or msg_from,
                            waba_config=waba_config,
                            tenant_id=resolved_tenant_id,
                        )
                    )

        # Handle delivery status updates (sent / delivered / read)
        for status in value.get("statuses", []):
            status_id = status.get("id", "")
            status_status = status.get("status", "")  # sent, delivered, read, failed
            status_timestamp = status.get("timestamp", "")
            if status_id and status_status:
                try:
                    storage.db.execute(
                        """UPDATE raw_messages SET delivery_status = ?, delivery_updated_at = ?
                           WHERE message_uid = ? OR message_uid LIKE ?""",
                        (status_status, now, status_id, f"%{status_id}%"),
                    )
                    processed.append({"type": "delivery_status", "message_id": status_id, "status": status_status})
                except Exception as exc:
                    print(f"[waba-webhook] failed to update delivery status: {exc}", flush=True)

    storage.db.execute(
        """INSERT INTO business_api_audit_log
           (action, target_type, target_id, status, details, created_at)
           VALUES (?,?,?,?,?,?)""",
        (
            "waba_webhook_received",
            "business_api_webhook",
            "meta",
            "logged",
            json.dumps({
                "object": body.get("object"),
                "entries": len(body.get("entry", [])) if isinstance(body.get("entry"), list) else 0,
                "messages_processed": len(processed),
                "processed": processed,
            }),
            now,
        ),
    )
    return {"status": "received", "processed": processed}


@app.post("/api/business-api/webhook")
async def business_api_webhook_receive(request: Request):
    return await _process_business_api_webhook(await request.json())


# ── WhatsApp Cloud API webhook aliases ────────────────────────────
# Meta may be configured to hit /api/whatsapp/cloud/webhook; route to the same handlers.

@app.get("/api/whatsapp/cloud/webhook")
async def whatsapp_cloud_webhook_verify(request: Request):
    return await business_api_webhook_verify(request)


@app.post("/api/whatsapp/cloud/webhook")
async def whatsapp_cloud_webhook_receive(request: Request):
    return await business_api_webhook_receive(request)


@app.get("/api/whatsapp/cloud/webhook/{org_id}")
async def whatsapp_workspace_cloud_webhook_verify(org_id: str, request: Request):
    values = await _workspace_waba_values(org_id)
    expected = str(values.get("verify_token") or "")
    mode = request.query_params.get("hub.mode", "")
    supplied = request.query_params.get("hub.verify_token", "")
    challenge = request.query_params.get("hub.challenge", "")
    if mode == "subscribe" and expected and hmac.compare_digest(supplied, expected):
        return Response(content=challenge, media_type="text/plain")
    raise HTTPException(403, "Webhook verify token does not match")


@app.post("/api/whatsapp/cloud/webhook/{org_id}")
async def whatsapp_workspace_cloud_webhook_receive(org_id: str, request: Request):
    body = await request.json()
    values, resolved_org_id = await _resolve_waba_webhook_config(body, org_id)
    return await _process_business_api_webhook(
        body, org_id=resolved_org_id, resolved_config=values
    )


# Types we persist to raw_messages from the WABA webhook. Anything outside
# this set (e.g. "unsupported" for voice calls / payments, "reaction" events
# without body text, "system" notifications) is logged and dropped so the
# inbox feed doesn't accumulate orphan rows.
_BUSINESS_API_PERSISTABLE_TYPES: frozenset[str] = frozenset({
    "text", "image", "video", "audio", "document", "sticker",
    "location", "contacts",
})


# ── WABA 24h Session Tracking ────────────────────────────────────

def _waba_session_update(chat_id: str, direction: str = "inbound"):
    """Update waba_sessions table. Inbound messages open the 24h window."""
    now = datetime.now(timezone.utc)
    try:
        existing = storage.db.execute(
            "SELECT chat_id, last_user_at FROM waba_sessions WHERE chat_id = ?", (chat_id,)
        ).fetchone()

        if direction == "inbound":
            # User messaged us — open/refresh the 24h window
            if existing:
                storage.db.execute(
                    "UPDATE waba_sessions SET last_user_at = ?, session_active = true, updated_at = ? WHERE chat_id = ?",
                    (now.isoformat(), now.isoformat(), chat_id),
                )
            else:
                storage.db.execute(
                    "INSERT INTO waba_sessions (chat_id, last_user_at, session_active, created_at, updated_at) VALUES (?, ?, true, ?, ?)",
                    (chat_id, now.isoformat(), now.isoformat(), now.isoformat()),
                )
        elif direction == "outbound":
            # We sent a message — just update updated_at
            if existing:
                storage.db.execute(
                    "UPDATE waba_sessions SET updated_at = ? WHERE chat_id = ?",
                    (now.isoformat(), chat_id),
                )
            else:
                storage.db.execute(
                    "INSERT INTO waba_sessions (chat_id, last_user_at, session_active, created_at, updated_at) VALUES (?, ?, true, ?, ?)",
                    (chat_id, now.isoformat(), now.isoformat(), now.isoformat()),
                )
    except Exception as exc:
        print(f"[waba-session] failed to update session for {chat_id}: {exc}", flush=True)


def _waba_session_status(chat_id: str) -> dict:
    """Check if a WABA 24h session is active for a given chat.
    Returns {active, remaining_seconds, last_user_at, expired}."""
    try:
        row = storage.db.execute(
            "SELECT last_user_at, session_active FROM waba_sessions WHERE chat_id = ?", (chat_id,)
        ).fetchone()
        if not row:
            return {"active": False, "remaining_seconds": 0, "last_user_at": None, "expired": True}

        last_user_at_str = row["last_user_at"]
        if isinstance(last_user_at_str, str):
            last_user_at = datetime.fromisoformat(last_user_at_str.replace("Z", "+00:00"))
        else:
            last_user_at = last_user_at_str

        now = datetime.now(timezone.utc)
        elapsed = (now - last_user_at).total_seconds()
        remaining = max(0, 86400 - elapsed)  # 86400 = 24h in seconds
        active = remaining > 0

        if not active and row["session_active"]:
            # Mark as expired
            try:
                storage.db.execute(
                    "UPDATE waba_sessions SET session_active = false WHERE chat_id = ?", (chat_id,)
                )
            except Exception:
                pass

        return {
            "active": active,
            "remaining_seconds": int(remaining),
            "last_user_at": last_user_at_str,
            "expired": not active,
        }
    except Exception as exc:
        print(f"[waba-session] failed to check session for {chat_id}: {exc}", flush=True)
        return {"active": False, "remaining_seconds": 0, "last_user_at": None, "expired": True}


# ── WABA Outbound Messaging ───────────────────────────────────────

async def _waba_send_message(
    to: str,
    text: str,
    msg_type: str = "text",
    waba_config: dict | None = None,
) -> dict:
    """Send a message via WhatsApp Business API Graph endpoint.
    `to` should be a phone number in format 919876543210 (no + or spaces).
    Returns {success, message_id, error}."""
    values = waba_config or _platform_waba_values()
    phone_number_id = str(values.get("phone_number_id") or "")
    access_token = str(values.get("access_token") or "")
    if not phone_number_id or not access_token:
        return {"success": False, "error": "WABA not configured (phone_number_id or access_token missing)"}

    # Normalize phone: strip +, spaces, leading 0
    digits = to.replace("+", "").replace(" ", "").replace("-", "").strip()
    if digits.startswith("0"):
        digits = digits[1:]
    if not digits.isdigit() or len(digits) < 10:
        return {"success": False, "error": f"Invalid phone number: {to}"}

    url = f"https://graph.facebook.com/v21.0/{phone_number_id}/messages"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
    }
    body = {
        "messaging_product": "whatsapp",
        "to": digits,
        "type": msg_type,
    }
    if msg_type == "text":
        body["text"] = {"body": text}
    elif msg_type == "template":
        body["template"] = text  # caller passes full template object
    else:
        body["text"] = {"body": text}

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(url, json=body, headers=headers)
        data = resp.json() if resp.text else {}
        if resp.status_code == 200 and data.get("messages"):
            msg_id = data["messages"][0].get("id", "")
            return {"success": True, "message_id": msg_id, "to": digits}
        error_msg = data.get("error", {}).get("message", resp.text[:500])
        return {"success": False, "error": error_msg, "status_code": resp.status_code, "response": data}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


async def _handle_waba_agent_reply(
    to: str,
    text: str,
    inbound_message_id: str,
    sender_name: str = "",
    waba_config: dict | None = None,
    tenant_id: str | None = None,
) -> None:
    """Run the workspace agent for one WABA message and send one reply."""
    try:
        previous_tenant = get_tenant_id()
        set_tenant_id(tenant_id or DEFAULT_TENANT_ID)
        response = await _run_workspace_agent(
            [{"role": "user", "content": text[:1800]}],
            session_id=f"waba:{tenant_id or DEFAULT_TENANT_ID}:{to}",
            tenant_id=tenant_id or DEFAULT_TENANT_ID,
        )
        if isinstance(response, dict) and response.get("error"):
            raise RuntimeError(response.get("message") or response["error"])

        reply = _workspace_response_to_whatsapp(response).strip()
        if not reply:
            raise RuntimeError("agent returned an empty reply")

        result = await _waba_send_message(to, reply, waba_config=waba_config)
        if not result.get("success"):
            raise RuntimeError(result.get("error") or "WABA send failed")

        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        digits = re.sub(r"\D+", "", to)
        sender_jid = f"{digits}@s.whatsapp.net"
        storage.db.execute(
            """INSERT INTO raw_messages
               (tenant_id, group_name, sender, sender_jid, sender_phone, message, message_type,
                source, timestamp, raw_payload, message_uid, delivery_status, synced_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                tenant_id or DEFAULT_TENANT_ID,
                sender_jid,
                "PropAI Agent",
                sender_jid,
                digits,
                reply,
                "text",
                "WABA_OUTBOUND",
                now_iso,
                json.dumps({
                    "waba_message_id": result.get("message_id", ""),
                    "reply_to": inbound_message_id,
                    "sender_name": sender_name,
                }),
                f"waba-{result.get('message_id') or uuid.uuid4()}",
                "sent",
                now_iso,
                now_iso,
            ),
        )
        try:
            _waba_session_update(f"{digits}@s.whatsapp.net", direction="outbound")
        except Exception:
            pass
    except Exception as exc:
        print(
            f"[waba-agent] reply failed inbound_message_id={inbound_message_id}: {exc}",
            flush=True,
        )
    finally:
        if 'previous_tenant' in locals():
            set_tenant_id(previous_tenant)


class WabaSendRequest(BaseModel):
    to: str  # phone number (digits, with or without +91)
    text: str
    remote_jid: str = ""  # optional: the JID of the conversation to store the message against


@app.post("/api/waba/send")
async def waba_send_message(
    req: WabaSendRequest,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    text = req.text.strip()
    if not text:
        raise HTTPException(400, "text is required")
    if not req.to:
        raise HTTPException(400, "to (phone number) is required")

    # Check 24h session window
    digits_raw = req.to.replace("+", "").replace(" ", "").replace("-", "").strip()
    if digits_raw.startswith("0"):
        digits_raw = digits_raw[1:]
    chat_id = f"{digits_raw}@s.whatsapp.net"
    session = _waba_session_status(chat_id)
    if session.get("expired"):
        return JSONResponse(
            status_code=403,
            content={
                "success": False,
                "error": "session_expired",
                "message": "24-hour reply window has expired. The customer must message you first before you can send.",
                "remaining_seconds": 0,
            },
        )

    is_super_admin = await asyncio.to_thread(storage.is_super_admin, user["id"])
    org_id = _resolve_active_organization_id(user, tenant_id)
    if not is_super_admin:
        await _require_org_permission(user, org_id, "reply_whatsapp")
        waba_config = await _workspace_waba_values(org_id)
        if not waba_config:
            raise HTTPException(409, "Connect your workspace WABA before sending")
    else:
        waba_config = _platform_waba_values()

    result = await _waba_send_message(req.to, text, waba_config=waba_config)

    # Store outbound message in raw_messages so it appears in inbox
    try:
        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        digits = req.to.replace("+", "").replace(" ", "").replace("-", "").strip()
        if digits.startswith("0"):
            digits = digits[1:]
        sender_jid = f"{digits}@s.whatsapp.net"

        storage.db.execute(
            """INSERT INTO raw_messages
               (tenant_id, group_name, sender, sender_jid, sender_phone, message, message_type,
                source, timestamp, raw_payload, message_uid, delivery_status, synced_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                org_id,
                req.remote_jid or sender_jid,
                "You",
                sender_jid,
                digits,
                text,
                "text",
                "WABA_OUTBOUND",
                now_iso,
                json.dumps({"waba_message_id": result.get("message_id", ""), "to": digits}),
                f"waba-{result.get('message_id', '') or int(time.time() * 1000)}",
                "sent" if result.get("success") else None,
                now_iso,
                now_iso,
            ),
        )
    except Exception as exc:
        print(f"[waba-send] failed to store outbound message: {exc}", flush=True)

    # Track outbound in session
    try:
        _waba_session_update(chat_id, direction="outbound")
    except Exception:
        pass

    # Log activity
    try:
        storage.log_activity(
            action="waba_message_sent" if result.get("success") else "waba_message_failed",
            target_type="waba_outbound",
            target_id=req.to,
            status="sent" if result.get("success") else "failed",
            details={
                "to": req.to,
                "text_preview": text[:200],
                "message_id": result.get("message_id", ""),
                "error": result.get("error", ""),
            },
        )
    except Exception:
        pass

    status_code = 200 if result.get("success") else 502
    return JSONResponse(status_code=status_code, content=result)


@app.get("/api/waba/session/{chat_id:path}")
async def waba_session_status(chat_id: str, user: dict = Depends(require_user)):
    """Check 24h session window for a given chat_id (e.g. '919876543210@s.whatsapp.net')."""
    return _waba_session_status(chat_id)


@app.get("/api/waba/sessions")
async def waba_sessions_bulk(user: dict = Depends(require_user)):
    """Get all active session statuses. Returns list of {chat_id, active, remaining_seconds, last_user_at}."""
    try:
        rows = storage.db.execute(
            "SELECT chat_id, last_user_at, session_active FROM waba_sessions WHERE session_active = true ORDER BY last_user_at DESC"
        ).fetchall()
        results = []
        now = datetime.now(timezone.utc)
        for row in rows:
            last_user_at_str = row["last_user_at"]
            if isinstance(last_user_at_str, str):
                last_user_at = datetime.fromisoformat(last_user_at_str.replace("Z", "+00:00"))
            else:
                last_user_at = last_user_at_str
            elapsed = (now - last_user_at).total_seconds()
            remaining = max(0, 86400 - elapsed)
            results.append({
                "chat_id": row["chat_id"],
                "active": remaining > 0,
                "remaining_seconds": int(remaining),
                "last_user_at": last_user_at_str,
            })
        return results
    except Exception as exc:
        return JSONResponse(status_code=500, content={"error": str(exc)})


@app.get("/api/business-api/team")
async def business_api_team(user: dict = Depends(require_user)):
    rows = storage.db.execute(
        "SELECT * FROM business_api_team_members ORDER BY active DESC, name COLLATE NOCASE"
    ).fetchall()
    return [_business_api_member(row) for row in rows]


@app.post("/api/business-api/team")
async def business_api_add_team_member(req: BusinessApiTeamMemberRequest, user: dict = Depends(require_user)):
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
            """INSERT INTO business_api_team_members
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
            """INSERT INTO business_api_audit_log
               (team_member_id, action, target_type, target_id, status, details, created_at)
               VALUES (?,?,?,?,?,?,?)""",
            (cur.lastrowid, "team_member_registered", "team_member", str(cur.lastrowid), "logged", "{}", now),
        )
    except Exception as exc:
        raise HTTPException(400, f"Could not add team member: {exc}")
    row = storage.db.execute("SELECT * FROM business_api_team_members WHERE id = ?", (cur.lastrowid,)).fetchone()
    return _business_api_member(row)


@app.patch("/api/business-api/team/{member_id}")
async def business_api_update_team_member(member_id: int, req: BusinessApiTeamMemberRequest, user: dict = Depends(require_user)):
    if req.role not in COMPANION_ROLES:
        raise HTTPException(400, "Invalid role")
    mobile = _mobile_digits(req.mobile_number)
    if len(mobile) < 10:
        raise HTTPException(400, "Valid mobile number is required")
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    storage.db.execute(
        """UPDATE business_api_team_members
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
        """INSERT INTO business_api_audit_log
           (team_member_id, action, target_type, target_id, status, details, created_at)
           VALUES (?,?,?,?,?,?,?)""",
        (member_id, "team_member_updated", "team_member", str(member_id), "logged", "{}", now),
    )
    row = storage.db.execute("SELECT * FROM business_api_team_members WHERE id = ?", (member_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Team member not found")
    return _business_api_member(row)


@app.get("/api/business-api/roles")
async def business_api_roles(user: dict = Depends(require_user)):
    return COMPANION_ROLES


@app.get("/api/business-api/tools")
async def business_api_tools(user: dict = Depends(require_user)):
    return {"tools": COMPANION_TOOLS}


@app.get("/api/business-api/conversations")
async def business_api_conversations(limit: int = 20, user: dict = Depends(require_user)):
    rows = storage.db.execute(
        """SELECT c.*, t.name AS team_member_name, t.role AS team_member_role
           FROM business_api_conversations c
           LEFT JOIN business_api_team_members t ON t.id = c.team_member_id
           ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
           LIMIT ?""",
        (limit,),
    ).fetchall()
    return [dict(row) for row in rows]


@app.get("/api/business-api/audit")
async def business_api_audit(limit: int = 30, user: dict = Depends(require_user)):
    rows = storage.db.execute(
        """SELECT a.*, t.name AS team_member_name
           FROM business_api_audit_log a
           LEFT JOIN business_api_team_members t ON t.id = a.team_member_id
           ORDER BY a.created_at DESC
           LIMIT ?""",
        (limit,),
    ).fetchall()
    return [dict(row) for row in rows]


@app.get("/api/sync/connection")
async def sync_connection(user: dict = Depends(require_user)):
    """Check WhatsApp connection status."""
    details = await _live_connection_details()
    jobs = storage.get_sync_jobs(limit=500, source="whatsapp") if storage else []
    last_finished = max((j.finished_at for j in jobs if j.finished_at), default=None)
    discovered_groups = len(jobs)
    historical_messages = 0
    total_messages = 0
    try:
        historical_messages = storage.db.execute(
            "SELECT COUNT(*) AS c FROM raw_messages WHERE raw_payload LIKE '%\"source\":\"history_sync\"%' OR raw_payload LIKE '%\"source\": \"history_sync\"%'"
        ).fetchone()["c"]
    except Exception:
        historical_messages = 0
    try:
        total_messages = storage.db.execute("SELECT COUNT(*) AS c FROM raw_messages").fetchone()["c"]
    except Exception:
        total_messages = 0
    if details.get("total_groups") is None or discovered_groups > details.get("total_groups", 0):
        details["total_groups"] = discovered_groups
    details.update({
        "api_url": None,
        "ingestor": "whatsapp",
        "capture_mode": "live_and_history_webhook",
        "business_window": business_window_status(),
        "historical_sync_state": _historical_sync_state(jobs),
        "last_sync": last_finished,
        "discovered_jobs": discovered_groups,
        "historical_messages": historical_messages,
        "messages_found": total_messages,
        "top_message_groups": _top_message_groups(jobs),
    })
    return details


@app.get("/api/sync/qr")
async def sync_qr(user: dict = Depends(require_user)):
    """Get QR code for WhatsApp login."""
    status = await _live_connection_details()
    qr = status.get("qr")
    if qr:
        return {"qr": qr, "available": True}
    details = status
    if details.get("connected"):
        return {
            "qr": None,
            "available": False,
            "connected": True,
            "message": "WhatsApp is already connected.",
        }
    if status.get("qr_available") and not qr:
        return {"qr": None, "available": False, "message": "QR being generated, try again"}
    return {"qr": None, "available": False, "message": f"QR not available: {status.get('connection_state', 'unknown')}"}


INGESTOR_INTERNAL_URL = os.getenv("INGESTOR_INTERNAL_URL", "http://ingestor:3001")
INGESTOR_PUBLIC_URL = os.getenv("INGESTOR_PUBLIC_URL", "http://egn4dqsw3xxmhb9noorm85do.62.238.18.85.sslip.io")


def _ingestor_urls() -> list[str]:
    urls = []
    for candidate in (INGESTOR_INTERNAL_URL, INGESTOR_PUBLIC_URL):
        candidate = (candidate or "").rstrip("/")
        if candidate and candidate not in urls:
            urls.append(candidate)
    return urls


def _ingestor_auth_headers() -> dict[str, str]:
    token = (
        os.getenv("PROPAI_INTERNAL_TOKEN", "").strip()
        or os.getenv("SUPABASE_SERVICE_KEY", "").strip()
    )
    return {"X-PropAI-Internal-Token": token} if token else {}


def _normalize_ingestor_status(status: dict | None) -> dict:
    if not isinstance(status, dict):
        return {}
    normalized = dict(status)
    broker_id = str(normalized.get("broker_id") or "").strip()
    if broker_id:
        normalized["broker_id"] = broker_id
    return normalized


def _status_preference_score(status: dict) -> int:
    score = 0
    if status.get("connected"):
        score += 100
    state = str(status.get("connection_state") or "").strip().lower()
    if state in {"open", "connected"}:
        score += 50
    elif state not in {"", "unknown", "unavailable"}:
        score += 10
    if status.get("qr"):
        score += 25
    if status.get("phone_number"):
        score += 10
    if status.get("display_name"):
        score += 5
    if status.get("connected_since"):
        score += 5
    return score


def _looks_like_useful_health_status(status: dict, broker_id: str) -> bool:
    if not isinstance(status, dict):
        return False
    payload_broker_id = str(status.get("broker_id") or "").strip()
    if broker_id and payload_broker_id and payload_broker_id != broker_id:
        return False
    state = str(status.get("connection_state") or "").strip().lower()
    if state and state not in {"unknown", "unavailable"}:
        return True
    return bool(
        status.get("connected")
        or status.get("qr")
        or status.get("phone_number")
        or status.get("display_name")
        or status.get("connected_since")
    )


async def _first_ingestor_response(
    method: str,
    path: str,
    *,
    timeout: float = 10,
    **kwargs,
) -> tuple[str | None, httpx.Response | None]:
    urls = _ingestor_urls()
    if not urls:
        return None, None
    request_headers = {**_ingestor_auth_headers(), **(kwargs.pop("headers", {}) or {})}
    first_failure: tuple[str | None, httpx.Response | None] = (None, None)
    async with httpx.AsyncClient(timeout=timeout) as client:
        async def request_one(base_url: str) -> tuple[str, httpx.Response | None]:
            try:
                return base_url, await client.request(
                    method, f"{base_url}{path}", headers=request_headers, **kwargs
                )
            except httpx.RequestError:
                return base_url, None

        tasks = [asyncio.create_task(request_one(base_url)) for base_url in urls]
        try:
            for completed in asyncio.as_completed(tasks):
                base_url, response = await completed
                if response is not None and response.status_code < 300:
                    return base_url, response
                if response is not None and first_failure[1] is None:
                    first_failure = (base_url, response)
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
    return first_failure


async def _all_ingestor_responses(
    method: str,
    path: str,
    *,
    timeout: float = 10,
    **kwargs,
) -> list[tuple[str, httpx.Response]]:
    urls = _ingestor_urls()
    if not urls:
        return []
    request_headers = {**_ingestor_auth_headers(), **(kwargs.pop("headers", {}) or {})}
    responses: list[tuple[str, httpx.Response]] = []
    async with httpx.AsyncClient(timeout=timeout) as client:
        async def request_one(base_url: str) -> tuple[str, httpx.Response | None]:
            try:
                return base_url, await client.request(
                    method, f"{base_url}{path}", headers=request_headers, **kwargs
                )
            except httpx.RequestError:
                return base_url, None

        tasks = [asyncio.create_task(request_one(base_url)) for base_url in urls]
        try:
            for completed in asyncio.as_completed(tasks):
                base_url, response = await completed
                if response is not None:
                    responses.append((base_url, response))
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
    return responses


async def _best_ingestor_health_status(broker_id: str, *, timeout: float = 2) -> dict:
    fallback: dict = {}
    for _, response in await _all_ingestor_responses(
        "GET", "/health", timeout=timeout, params={"broker_id": broker_id}
    ):
        if response.status_code >= 300:
            continue
        try:
            payload = _normalize_ingestor_status(response.json())
        except Exception:
            continue
        if payload and _looks_like_useful_health_status(payload, broker_id):
            return payload
        if not fallback and payload:
            fallback = payload
    return fallback


async def _best_ingestor_status_for_broker(broker_id: str, *, timeout: float = 2) -> dict:
    broker_id = str(broker_id or "").strip()
    if not broker_id:
        return {}
    merged, _, _ = await _merged_ingestor_list(timeout=timeout)
    status = merged.get(broker_id, {})
    if status and _looks_like_useful_health_status(status, broker_id):
        return status
    status = await _best_ingestor_health_status(broker_id, timeout=timeout)
    if status and _looks_like_useful_health_status(status, broker_id):
        return status
    cached_status, seen_at = _broker_live_statuses.get(broker_id, ({}, 0.0))
    if cached_status and time.time() - seen_at <= 45:
        return cached_status
    return status or {}


async def _merged_ingestor_list(timeout: float = 2) -> tuple[dict[str, dict], bool, str]:
    merged: dict[str, dict] = {}
    ingestor_reachable = False
    ingestor_error = ""
    for _, response in await _all_ingestor_responses("GET", "/list", timeout=timeout):
        if response.status_code >= 300:
            if not ingestor_error:
                ingestor_error = _ingestor_failure_message(response)
            continue
        ingestor_reachable = True
        try:
            statuses = response.json()
        except ValueError:
            if not ingestor_error:
                ingestor_error = "WhatsApp service returned an invalid status response."
            continue
        if not isinstance(statuses, list):
            continue
        for raw_status in statuses:
            status = _normalize_ingestor_status(raw_status)
            broker_id = str(status.get("broker_id") or "").strip()
            if not broker_id:
                continue
            current = merged.get(broker_id)
            if current is None or _status_preference_score(status) >= _status_preference_score(current):
                merged[broker_id] = status
    return merged, ingestor_reachable, ingestor_error


def _ingestor_failure_message(response: httpx.Response | None) -> str:
    if response is None:
        return "WhatsApp service is unavailable. Try again in a moment."
    if response.status_code == 401:
        return "WhatsApp service authentication failed. PROPAI_INTERNAL_TOKEN must match on the API and ingestor services."
    if response.status_code == 503:
        return "WhatsApp service authentication is not configured on the ingestor."
    if response.status_code == 409:
        return "This phone session is active on another ingestor instance. Redeploy the ingestor once, then retry."
    try:
        payload = response.json()
        detail = str(payload.get("error") or payload.get("detail") or "").strip()
    except (ValueError, AttributeError):
        detail = ""
    return detail or f"WhatsApp service returned HTTP {response.status_code}."


@app.post("/api/sync/refresh-qr")
async def sync_refresh_qr(user: dict = Depends(require_user)):
    """Force the ingestor to clear its session and generate a fresh QR code."""
    errors = []
    async with httpx.AsyncClient(timeout=10) as client:
        for base_url in _ingestor_urls():
            try:
                resp = await client.post(
                    f"{base_url}/reset?broker_id=default", headers=_ingestor_auth_headers()
                )
                if resp.status_code == 200:
                    return {
                        "ok": True,
                        "ingestor_url": base_url,
                        "message": "Session cleared, QR should appear shortly",
                    }
                errors.append(f"{base_url}: {resp.status_code}")
            except httpx.RequestError as e:
                errors.append(f"{base_url}: {e}")
    return {"ok": False, "message": "Cannot reach ingestor", "errors": errors}


@app.post("/api/sync/history-backfill")
async def sync_history_backfill(limit: int = 25, count: int = 50, user: dict = Depends(require_user)):
    """Ask the WhatsApp phone for older messages before the latest known messages."""
    limit = max(1, min(int(limit or 25), 100))
    count = max(1, min(int(count or 50), 50))
    errors = []
    async with httpx.AsyncClient(timeout=35) as client:
        for base_url in _ingestor_urls():
            try:
                resp = await client.post(
                    f"{base_url}/history/backfill",
                    params={"broker_id": "default", "limit": limit, "count": count},
                    headers=_ingestor_auth_headers(),
                )
                payload = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {"message": resp.text}
                return {"ok": resp.status_code < 300, "status_code": resp.status_code, "ingestor_url": base_url, **payload}
            except httpx.RequestError as e:
                errors.append(f"{base_url}: {e}")
    return {"ok": False, "message": "Cannot reach ingestor", "errors": errors}


@app.post("/api/sync/status")
async def sync_status_update(request: Request):
    """Receive connection status from the WhatsApp ingestor."""
    global _memory_status, _previous_status
    expected_token = (
        os.getenv("PROPAI_INTERNAL_TOKEN", "").strip()
        or os.getenv("SUPABASE_SERVICE_KEY", "").strip()
    )
    supplied_token = request.headers.get("X-PropAI-Internal-Token", "").strip()
    if not expected_token:
        raise HTTPException(503, "Internal service authentication is not configured")
    if not hmac.compare_digest(supplied_token, expected_token):
        raise HTTPException(401, "Invalid internal service token")
    try:
        body = await request.json()
        _previous_status = _memory_status
        _memory_status = body
        _cache_connection_snapshot(body)
        broker_id = str(body.get("broker_id") or "").strip()
        if broker_id:
            _broker_live_statuses[broker_id] = (body, time.time())
        phone_number = str(body.get("phone_number") or "").strip()
        display_name = str(body.get("display_name") or "").strip()
        if storage and broker_id and (phone_number or display_name):
            updates: dict[str, object] = {"is_active": True}
            if phone_number:
                updates["phone_number"] = phone_number
            if display_name:
                updates["instance_name"] = display_name
            try:
                await asyncio.to_thread(
                    storage.update_org_whatsapp_connection_by_broker_id,
                    broker_id,
                    updates,
                )
            except Exception as exc:
                print(f"[sync/status] persist failed for broker {broker_id}: {exc}", flush=True)
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.get("/api/sync/events")
async def sync_events():
    """SSE endpoint that streams real-time connection status changes."""
    async def current_sync_status() -> dict:
        raw = _memory_status if _memory_status else _status_file()
        if _status_has_live_signal(raw):
            return raw
        details = await _live_connection_details()
        return {
            **raw,
            "connected": details.get("connected", False),
            "connection_state": details.get("connection_state", "unknown"),
            "phone_number": details.get("phone_number") or raw.get("phone_number"),
            "display_name": details.get("display_name") or raw.get("display_name"),
            "connected_since": details.get("connected_since") or raw.get("connected_since"),
            "last_message_at": details.get("last_message_at") or raw.get("last_message_at"),
        }

    async def event_stream():
        seen: dict = {}
        initial = await current_sync_status()
        yield f"event: status\ndata: {json.dumps(initial)}\n\n"
        while True:
            try:
                await asyncio.sleep(1.5)
                current = await current_sync_status()
                prev = seen
                seen = dict(current)
                cs = current.get("connection_state", "")
                prev_cs = prev.get("connection_state", "")

                # Always emit transition events when state changes
                if current != prev:
                    if cs == "open" and current.get("connected"):
                        yield f"event: connected\ndata: {json.dumps(seen)}\n\n"
                    elif cs in ("closed", "logged_out"):
                        reason = current.get("disconnect_reason", cs)
                        yield f"event: disconnected\ndata: {json.dumps({'reason': reason, 'status': seen})}\n\n"
                    elif cs == "error":
                        yield f"event: error\ndata: {json.dumps({'reason': current.get('error', 'unknown'), 'status': seen})}\n\n"
                    elif cs == "qr" and current.get("qr"):
                        if prev_cs != "qr":
                            yield f"event: qr_ready\ndata: {json.dumps({'qr': current.get('qr')})}\n\n"
                    elif prev_cs == "qr" and cs not in ("", prev_cs) and cs != "open":
                        yield f"event: qr_scanned\ndata: {json.dumps({'connection_state': cs or 'authenticating'})}\n\n"

                # Always send heartbeat — prevents proxy timeout killing the connection
                yield f"event: heartbeat\ndata: {json.dumps({'connection_state': cs, 'connected': current.get('connected', False)})}\n\n"
            except asyncio.CancelledError:
                break
            except Exception:
                yield f"event: heartbeat\ndata: {json.dumps({'connection_state': 'unknown', 'connected': False})}\n\n"
    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/api/sync/logout")
async def sync_logout(user: dict = Depends(require_user)):
    """Disconnect the WhatsApp session and clear stored credentials."""
    errors = []
    async with httpx.AsyncClient(timeout=10) as client:
        for base_url in _ingestor_urls():
            try:
                resp = await client.post(
                    f"{base_url}/disconnect?broker_id=default", headers=_ingestor_auth_headers()
                )
                if resp.status_code == 200:
                    return {"ok": True, "message": "WhatsApp session disconnected"}
                errors.append(f"{base_url}: {resp.status_code}")
            except httpx.RequestError as e:
                errors.append(f"{base_url}: {e}")
    return {"ok": False, "message": "Cannot reach ingestor to disconnect", "errors": errors}


@app.get("/api/sync/connection-state")
async def sync_connection_state(user: dict = Depends(require_user)):
    """Get current connection state (open/connecting/closed)."""
    details = await _live_connection_details()
    return {"state": details["connection_state"], "connected": details["connected"]}


def _connection_details() -> dict:
    status = _status_file()
    if _status_has_live_signal(status):
        _cache_connection_snapshot(status)
        return _normalize_connection_snapshot(status)

    cached = _last_live_connection_status if _last_live_connection_status else None
    if cached and _last_live_connection_seen_at > 0:
        age = time.time() - _last_live_connection_seen_at
        if age <= _CONNECTION_CACHE_GRACE_SECONDS:
            stale = dict(cached)
            stale["status_stale"] = True
            return stale

    total_groups = 0
    messages_captured = 0
    if storage:
        try:
            jobs = storage.get_sync_jobs(limit=500, source="whatsapp") if hasattr(storage, "get_sync_jobs") else []
            total_groups = len(jobs)
        except Exception:
            pass
        if hasattr(storage, "db") and storage.db:
            try:
                messages_captured = storage.db.execute("SELECT COUNT(*) AS c FROM raw_messages").fetchone()["c"]
            except Exception:
                pass

    return {
        "connected": False,
        "connection_state": "unknown",
        "instance_name": "propai-whatsapp",
        "device_name": "WhatsApp ingestor",
        "phone_number": "",
        "display_name": "",
        "connected_since": None,
        "last_message_at": None,
        "total_groups": total_groups,
        "messages_captured": messages_captured,
        "status_stale": False,
    }


async def _live_connection_details(timeout: float = 2) -> dict:
    details = _connection_details()
    merged, ingestor_reachable, ingestor_error = await _merged_ingestor_list(timeout=timeout)
    if not merged:
        if not ingestor_reachable and ingestor_error:
            details["live_status_error"] = ingestor_error
        return details
    best = max(merged.values(), key=_status_preference_score)
    broker_id = str(best.get("broker_id") or "").strip()
    if not best or not _looks_like_useful_health_status(best, broker_id):
        return details
    details.update(_normalize_connection_snapshot(best))
    details["connected"] = bool(best.get("connected"))
    details["connection_state"] = str(best.get("connection_state") or details.get("connection_state") or "unknown").lower()
    details["status_stale"] = False
    details["live_status_error"] = ""
    return details


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
    if not storage or not hasattr(storage, "db"):
        return []
    try:
        rows = storage.db.execute(
            "SELECT group_name, COUNT(*) AS c FROM raw_messages "
            "WHERE COALESCE(group_name, '') != '' "
            "GROUP BY group_name ORDER BY c DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [
            {"group_name": r["group_name"], "group_id": r["group_name"], "messages": r["c"]}
            for r in rows
        ]
    except Exception:
        pass
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
async def rebuild_broker_graph(user: dict = Depends(require_user)):
    result = storage.rebuild_broker_graph()
    return result


@app.post("/api/rebuild-observation-graph")
async def rebuild_observation_graph(user: dict = Depends(require_user)):
    result = storage.rebuild_observation_graph()
    return result


@app.get("/api/brokers")
async def list_brokers(user: dict = Depends(require_user)):
    storage.rebuild_broker_graph()
    rows = storage.db.execute("""
        SELECT id, canonical_name, primary_phone,
               observation_count, listing_count, requirement_count,
               rental_count, commercial_count, group_count, market_count,
               building_count, active_days_30, first_seen_at, last_seen_at
        FROM brokers
        ORDER BY observation_count DESC, last_seen_at DESC
    """).fetchall()
    brokers = []
    for row in rows:
        broker = dict(row)
        broker["aliases"] = [
            dict(r) for r in storage.db.execute("""
                SELECT alias, observation_count
                FROM broker_aliases
                WHERE broker_id = ?
                ORDER BY observation_count DESC
                LIMIT 8
            """, (broker["id"],)).fetchall()
        ]
        broker["phones"] = [
            dict(r) for r in storage.db.execute("""
                SELECT phone, observation_count
                FROM broker_phones
                WHERE broker_id = ?
                ORDER BY observation_count DESC
                LIMIT 5
            """, (broker["id"],)).fetchall()
        ]
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
        broker["recent_observations"] = [
            dict(r) for r in storage.db.execute("""
                SELECT p.intent, p.message_type, p.bhk, p.furnishing,
                       p.building_name, p.micro_market, p.location_raw,
                       p.summary_title, substr(r.message, 1, 220) AS message
                FROM broker_observations bo
                JOIN parsed_output p ON p.id = bo.parsed_id
                LEFT JOIN raw_messages r ON r.id = p.raw_message_id
                WHERE bo.broker_id = ?
                ORDER BY bo.seen_at DESC
                LIMIT 8
            """, (broker["id"],)).fetchall()
        ]
        broker["groups"] = [
            {
                "group_name": _group_jid_to_name(r["group_name"]),
                "observation_count": r["observation_count"],
                "listing_count": r["listing_count"],
                "requirement_count": r["requirement_count"],
                "last_seen_at": r["last_seen_at"],
            }
            for r in storage.db.execute("""
                SELECT group_name,
                       COUNT(*) AS observation_count,
                       SUM(CASE WHEN role = 'listing' THEN 1 ELSE 0 END) AS listing_count,
                       SUM(CASE WHEN role = 'requirement' THEN 1 ELSE 0 END) AS requirement_count,
                       MAX(seen_at) AS last_seen_at
                FROM broker_observations
                WHERE broker_id = ? AND group_name IS NOT NULL AND group_name != ''
                GROUP BY group_name
                ORDER BY observation_count DESC, last_seen_at DESC
                LIMIT 5
            """, (broker["id"],)).fetchall()
        ]
        search_parts = [
            broker.get("name"),
            broker.get("phone"),
            *(item.get("alias") for item in broker["aliases"]),
            *(item.get("phone") for item in broker["phones"]),
            *(item.get("micro_market") for item in broker["markets"]),
            *(item.get("building_name") for item in broker["buildings"]),
            *(item.get("group_name") for item in broker["groups"]),
        ]
        for item in broker["recent_observations"]:
            search_parts.extend([
                item.get("intent"),
                item.get("message_type"),
                item.get("bhk"),
                item.get("furnishing"),
                item.get("building_name"),
                item.get("micro_market"),
                item.get("location_raw"),
                item.get("summary_title"),
                item.get("message"),
            ])
        broker["search_text"] = " ".join(str(part) for part in search_parts if part).lower()
        brokers.append(broker)
    return brokers


# ── Knowledge Observations API ───────────────────────────────────

@app.get("/api/knowledge/observations")
async def get_knowledge_observations(
    user: dict = Depends(require_user),
    entity_type: str = "",
    entity_name: str = "",
    broker_phone: str = "",
    limit: int = 50,
):
    """Fetch knowledge observations with optional filters."""
    if storage is None:
        return []
    clauses = []
    params: list = []
    if entity_type:
        clauses.append("entity_type = ?")
        params.append(entity_type)
    if entity_name:
        clauses.append("LOWER(entity_name) LIKE ?")
        params.append(f"%{entity_name.lower()}%")
    if broker_phone:
        clauses.append("source_broker_phone = ?")
        params.append(broker_phone)
    where = " AND ".join(clauses) if clauses else "1=1"
    rows = storage.db.execute(
        f"""SELECT id, entity_type, entity_name, observation_type, observation_text,
                   confidence, observation_count, source_broker_name, source_broker_phone,
                   created_at, updated_at
            FROM knowledge_observations
            WHERE {where}
            ORDER BY confidence DESC, observation_count DESC, updated_at DESC
            LIMIT ?""",
        (*params, limit),
    ).fetchall()
    return [dict(r) for r in rows]


@app.get("/api/knowledge/observations/stats")
async def knowledge_observation_stats(user: dict = Depends(require_user)):
    """Return aggregate stats about knowledge observations."""
    if storage is None:
        return {}
    total = storage.db.execute("SELECT COUNT(*) FROM knowledge_observations").fetchone()[0]
    by_type = storage.db.execute(
        """SELECT observation_type, COUNT(*) as c
           FROM knowledge_observations GROUP BY observation_type ORDER BY c DESC"""
    ).fetchall()
    by_entity = storage.db.execute(
        """SELECT entity_type, COUNT(*) as c
           FROM knowledge_observations GROUP BY entity_type ORDER BY c DESC"""
    ).fetchall()
    top_entities = storage.db.execute(
        """SELECT entity_name, entity_type, COUNT(*) as c, MAX(confidence) as conf
           FROM knowledge_observations
           GROUP BY entity_name, entity_type
           ORDER BY c DESC LIMIT 20"""
    ).fetchall()
    return {
        "total": total,
        "by_type": [dict(r) for r in by_type],
        "by_entity_type": [dict(r) for r in by_entity],
        "top_entities": [dict(r) for r in top_entities],
    }


# ── Batch Observation Processing (OpenAI-compatible Batch API) ──

_LISTING_ONLY_RE = re.compile(
    r'(?i)\b(bhk|sqft|sft|carpet|furnished|unfurnished|possession|parking|deposit|negotiable|available for)\b'
)
_CONVERSATIONAL_RE = re.compile(
    r'(?i)\b(client|view|feedback|problem|issue|like|dislike|suggest|feel|think|say|said|told|mention|notic|facing|faced|facing issue|too small|too big|too costly|expensive|cheap|good|bad|nice|great|worst|better|worse|reject|accept|prefer|want|need|looking for|requirement)\b'
)


def _looks_conversational(text: str) -> bool:
    if len(text) < 50:
        return False
    if _LISTING_ONLY_RE.findall(text) and not _CONVERSATIONAL_RE.search(text):
        return False
    return True


def _iso_now() -> str:
    """Current UTC time as ISO 8601 with 3-digit milliseconds, JS-compatible."""
    n = datetime.now(timezone.utc)
    return n.strftime("%Y-%m-%dT%H:%M:%S.") + f"{n.microsecond // 1000:03d}Z"


def _generate_batch_jsonl(max_messages: int = 0) -> tuple[list[dict], str]:
    """Generate JSONL lines for observation extraction batch. Returns (rows, jsonl_path)."""
    import json
    from ai_chat_engine import _OBSERVATION_PROMPT
    from llm import get_model
    model_name = get_model()

    out_dir = Path("/tmp/opencode")
    out_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    jsonl_path = str(out_dir / f"obs_batch_{ts}.jsonl")

    rows = storage.db.execute(
        """SELECT id, broker_name, broker_phone, raw_payload
           FROM parsed_output
           WHERE raw_payload IS NOT NULL AND raw_payload != ''
           ORDER BY id"""
    ).fetchall()

    batch_lines = []
    batch_rows = []
    for r in rows:
        try:
            rp = json.loads(r["raw_payload"]) if isinstance(r["raw_payload"], str) else r["raw_payload"]
        except (json.JSONDecodeError, TypeError):
            continue
        text = (rp or {}).get("full_text", "")
        if not text or not _looks_conversational(text):
            continue
        line = {
            "custom_id": f"obs_{r['id']}",
            "method": "POST",
            "url": "/v1/chat/completions",
            "body": {
                "model": model_name,
                "messages": [
                    {"role": "system", "content": _OBSERVATION_PROMPT},
                    {"role": "user", "content": text},
                ],
                "temperature": 0.1,
                "max_tokens": 512,
            },
        }
        batch_lines.append(json.dumps(line))
        batch_rows.append({
            "parsed_id": r["id"],
            "broker_name": r["broker_name"] or "",
            "broker_phone": r["broker_phone"] or "",
            "text_preview": text[:100],
        })
        if max_messages > 0 and len(batch_lines) >= max_messages:
            break

    Path(jsonl_path).write_text("\n".join(batch_lines))
    return batch_rows, jsonl_path


@app.post("/api/knowledge/observations/batch")
async def create_observation_batch(req: BatchCreateRequest, user: dict = Depends(require_user)):
    """Create a new batch observation extraction job."""
    if storage is None:
        return {"error": "storage not available"}

    # Generate JSONL
    rows, jsonl_path = _generate_batch_jsonl(req.max_messages)
    if not rows:
        return BatchCreateResponse(id=0, status="no_data", total_requests=0)

    # Get API client
    from openai import OpenAI
    client = OpenAI(api_key=DOUBLEWORD_API_KEY, base_url="https://api.doubleword.ai/v1")

    # Upload file
    with open(jsonl_path, "rb") as f:
        file_obj = client.files.create(file=f, purpose="batch")

    # Create batch
    batch = client.batches.create(
        input_file_id=file_obj.id,
        endpoint="/v1/chat/completions",
        completion_window="24h",
    )

    # Save to DB
    stats = {
        "total": len(rows),
        "sample": rows[:3],
    }
    cursor = storage.db.execute(
        """INSERT INTO observation_batches
           (batch_type, batch_api_id, status, total_requests, input_file_id, input_path, stats_snapshot, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (req.batch_type, batch.id, batch.status or "pending", len(rows),
         file_obj.id, jsonl_path, json.dumps(stats),
         _iso_now(), _iso_now()),
    )
    batch_db_id = cursor.lastrowid

    return BatchCreateResponse(
        id=batch_db_id,
        batch_api_id=batch.id,
        status=batch.status or "pending",
        total_requests=len(rows),
        stats_snapshot=json.dumps(stats),
    )


@app.get("/api/knowledge/observations/batches")
async def list_observation_batches(user: dict = Depends(require_user)):
    """List all observation extraction batches."""
    if storage is None:
        return []
    rows = storage.db.execute(
        """SELECT id, batch_type, batch_api_id, status, total_requests,
                  completed_count, failed_count, input_file_id, output_file_id,
                  error_message, stats_snapshot, created_at, updated_at
           FROM observation_batches
           ORDER BY created_at DESC
           LIMIT 50"""
    ).fetchall()
    return [dict(r) for r in rows]


@app.get("/api/knowledge/observations/batches/{batch_id}")
async def get_observation_batch(batch_id: int, user: dict = Depends(require_user)):
    """Get a single batch record."""
    if storage is None:
        return {"error": "no storage"}
    row = storage.db.execute(
        """SELECT id, batch_type, batch_api_id, status, total_requests,
                  completed_count, failed_count, input_file_id, output_file_id,
                  error_message, stats_snapshot, created_at, updated_at
           FROM observation_batches WHERE id = ?""",
        (batch_id,),
    ).fetchone()
    if not row:
        return {"error": "not found"}
    return dict(row)


@app.post("/api/knowledge/observations/batches/{batch_id}/check")
async def check_batch_status(batch_id: int, user: dict = Depends(require_user)):
    """Poll doubleword.ai API for current batch status and update local DB."""
    if storage is None:
        return {"error": "no storage"}
    row = storage.db.execute(
        "SELECT * FROM observation_batches WHERE id = ?", (batch_id,)
    ).fetchone()
    if not row or not row["batch_api_id"]:
        return {"error": "no batch_api_id"}
    if row["status"] in ("completed", "failed", "cancelled"):
        return {"status": row["status"], "note": "already terminal"}

    from openai import OpenAI
    client = OpenAI(api_key=DOUBLEWORD_API_KEY, base_url="https://api.doubleword.ai/v1")
    try:
        api_batch = client.batches.retrieve(row["batch_api_id"])
    except Exception as e:
        return {"error": str(e)}

    new_status = api_batch.status or row["status"]
    output_file_id = getattr(api_batch, "output_file_id", None)
    error_message = getattr(api_batch, "errors", None)
    if error_message and not isinstance(error_message, str):
        error_message = str(error_message)

    storage.db.execute(
        """UPDATE observation_batches
           SET status = ?, output_file_id = ?, error_message = ?,
               completed_count = ?, failed_count = ?,
               updated_at = ?
           WHERE id = ?""",
        (new_status, output_file_id, error_message,
         (api_batch.request_counts.completed if api_batch.request_counts else 0),
         (api_batch.request_counts.failed if api_batch.request_counts else 0),
         _iso_now(),
          batch_id),
    )
    return {
        "status": new_status,
        "output_file_id": output_file_id,
        "completed": api_batch.request_counts.completed if api_batch.request_counts else 0,
        "failed": api_batch.request_counts.failed if api_batch.request_counts else 0,
        "total": row["total_requests"],
    }


@app.post("/api/knowledge/observations/batches/{batch_id}/apply")
async def apply_batch_results(batch_id: int, user: dict = Depends(require_user)):
    """Download completed batch results and merge into knowledge_observations."""
    if storage is None:
        return {"error": "no storage"}
    row = storage.db.execute(
        "SELECT * FROM observation_batches WHERE id = ?", (batch_id,)
    ).fetchone()
    if not row:
        return {"error": "not found"}
    if not row["output_file_id"]:
        return {"error": "no output file — batch may not be complete"}
    if row["status"] != "completed":
        return {"error": f"batch status is {row['status']}, not completed"}

    from openai import OpenAI
    client = OpenAI(api_key=DOUBLEWORD_API_KEY, base_url="https://api.doubleword.ai/v1")

    # Download results
    try:
        content = client.files.content(row["output_file_id"]).text
    except Exception as e:
        return {"error": f"download failed: {e}"}

    # Parse results
    import json
    lines = [l for l in content.strip().split("\n") if l.strip()]
    merged = 0
    errors = 0
    now = _iso_now()

    for line in lines:
        try:
            result = json.loads(line)
        except json.JSONDecodeError:
            errors += 1
            continue
        custom_id = result.get("custom_id", "")
        if not custom_id.startswith("obs_"):
            continue
        parsed_id = int(custom_id.split("_", 1)[1])
        body = result.get("response", {}).get("body", {})
        choice = (body.get("choices") or [None])[0]
        content_text = (choice or {}).get("message", {}).get("content", "")
        if not content_text:
            continue
        try:
            observations = json.loads(content_text)
        except json.JSONDecodeError:
            continue
        if not isinstance(observations, list):
            continue

        # Look up broker info for this parsed_id
        broker_row = storage.db.execute(
            "SELECT broker_name, broker_phone FROM parsed_output WHERE id = ?",
            (parsed_id,),
        ).fetchone()
        broker_name = (broker_row["broker_name"] or "") if broker_row else ""
        broker_phone = (broker_row["broker_phone"] or "") if broker_row else ""

        for obs in observations:
            if not obs.get("entity_type") or not obs.get("entity_name") or not obs.get("observation_text"):
                continue
            try:
                _merge_observation(
                    entity_type=obs["entity_type"],
                    entity_name=obs["entity_name"],
                    observation_type=obs.get("observation_type", "building_feedback"),
                    observation_text=obs["observation_text"],
                    broker_name=broker_name,
                    broker_phone=broker_phone,
                    parsed_id=parsed_id,
                    raw_id=None,
                    now=now,
                )
                merged += 1
            except Exception:
                errors += 1

    storage.db.execute(
        """UPDATE observation_batches
           SET status = 'applied', updated_at = ?
           WHERE id = ?""",
        (now, batch_id),
    )
    return {"merged": merged, "errors": errors, "total_lines": len(lines)}


@app.get("/api/broker-summary")
async def broker_summary(name: str = "", phone: str = "", user: dict = Depends(require_user)):
    """On-the-fly broker summary from listings table (no broker sync required)."""
    empty = {"total_listings": 0, "intents": {}, "top_bhk": [], "markets": [], "price_range_sale": "", "price_range_rent": ""}
    if not name and not phone:
        return empty
    q = "SELECT intent, bhk, price, price_unit, micro_market, observation_count FROM listings WHERE "
    params: list[str] = []
    clauses: list[str] = []
    if name:
        clauses.append("broker_name LIKE ?")
        params.append(f"%{name}%")
    if phone:
        clauses.append("broker_phone LIKE ?")
        params.append(f"%{phone}%")
    q += " AND ".join(clauses)
    rows = storage.db.execute(q, params).fetchall()

    total = len(rows)
    intents: dict[str, int] = {}
    bhk_dist: dict[str, int] = {}
    markets: dict[str, int] = {}
    prices_sale: list[float] = []
    prices_rent: list[float] = []

    for r in rows:
        d = dict(r)
        intent = d["intent"] or "UNKNOWN"
        intents[intent] = intents.get(intent, 0) + 1
        bhk = d["bhk"] or "?"
        bhk_dist[bhk] = bhk_dist.get(bhk, 0) + 1
        market = d["micro_market"] or "?"
        markets[market] = markets.get(market, 0) + 1
        if d["price"] and d["price_unit"]:
            p = float(d["price"])
            if intent in ("RENT", "LEASE"):
                prices_rent.append(p)
            else:
                prices_sale.append(p)

    def _fmt_price_range(prices: list[float]) -> str:
        if not prices:
            return ""
        prices.sort()
        if len(prices) == 1:
            return f"₹{prices[0]:,.0f}"
        return f"₹{prices[0]:,.0f} – ₹{prices[-1]:,.0f}"

    top_markets = sorted(markets, key=markets.__getitem__, reverse=True)[:3]

    # Aggregate team members from recent parsed_output raw_payload
    team_members: list[dict] = []
    seen_tm: set[str] = set()
    tm_query = "SELECT raw_payload FROM parsed_output WHERE"
    tm_params: list[str] = []
    tm_clauses: list[str] = []
    if name:
        tm_clauses.append("broker_name LIKE ?")
        tm_params.append(f"%{name}%")
    if phone:
        tm_clauses.append("broker_phone LIKE ?")
        tm_params.append(f"%{phone}%")
    tm_query += " AND ".join(tm_clauses) + " AND raw_payload LIKE '%team_member%' ORDER BY id DESC LIMIT 50"
    for r in storage.db.execute(tm_query, tm_params).fetchall():
        try:
            rp = json.loads(r["raw_payload"]) if isinstance(r["raw_payload"], str) else r["raw_payload"]
            for tm in (rp.get("team_members") or []):
                if not tm.get("name"):
                    continue
                key = tm.get("name", "") + "|" + tm.get("phone", "")
                if key not in seen_tm and key != "|":
                    seen_tm.add(key)
                    team_members.append(tm)
        except (json.JSONDecodeError, TypeError):
            pass

    return {
        "total_listings": total,
        "intents": intents,
        "top_bhk": sorted(bhk_dist, key=bhk_dist.__getitem__, reverse=True)[:3],
        "markets": top_markets,
        "price_range_sale": _fmt_price_range(prices_sale),
        "price_range_rent": _fmt_price_range(prices_rent),
        "team_members": team_members,
    }


@app.get("/api/brokers/find")
async def find_broker(name: str = "", phone: str = "", user: dict = Depends(require_user)):
    if not name and not phone:
        raise HTTPException(400, "name or phone is required")
    digits = re.sub(r"\D+", "", phone or "")
    if len(digits) >= 10:
        key = f"phone:{digits[-10:]}"
    else:
        normalized_name = re.sub(r"\s+", " ", (name or "").strip().lower())
        key = f"name:{normalized_name}" if normalized_name else None
    if not key:
        raise HTTPException(404, "Broker identity key could not be resolved")
    row = storage.db.execute(
        "SELECT id FROM brokers WHERE identity_key = ?", (key,)
    ).fetchone()
    if not row:
        # Parsed broker identities can arrive before the materialized broker graph is refreshed.
        storage.rebuild_broker_graph()
        row = storage.db.execute(
            "SELECT id FROM brokers WHERE identity_key = ?", (key,)
        ).fetchone()
    if not row:
        raise HTTPException(404, "Broker not found")
    return {"broker_id": row["id"]}


@app.get("/api/brokers/{broker_id}")
async def get_broker_profile(broker_id: int, user: dict = Depends(require_user)):
    storage.rebuild_broker_graph()
    row = storage.db.execute("""
        SELECT id, canonical_name AS name, primary_phone AS phone,
               observation_count, listing_count, requirement_count,
               rental_count, commercial_count, group_count, market_count,
               building_count, active_days_30, first_seen_at, last_seen_at
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
    broker["groups"] = [
        {
            "group_name": _group_jid_to_name(r["group_name"]),
            "observation_count": r["observation_count"],
            "listing_count": r["listing_count"],
            "requirement_count": r["requirement_count"],
            "last_seen_at": r["last_seen_at"],
        }
        for r in storage.db.execute("""
            SELECT group_name,
                   COUNT(*) AS observation_count,
                   SUM(CASE WHEN role = 'listing' THEN 1 ELSE 0 END) AS listing_count,
                   SUM(CASE WHEN role = 'requirement' THEN 1 ELSE 0 END) AS requirement_count,
                   MAX(seen_at) AS last_seen_at
            FROM broker_observations
            WHERE broker_id = ? AND group_name IS NOT NULL AND group_name != ''
            GROUP BY group_name
            ORDER BY observation_count DESC, last_seen_at DESC
            LIMIT 30
        """, (broker_id,)).fetchall()
    ]
    broker["observations"] = [dict(r) for r in storage.db.execute("""
        SELECT p.id AS parsed_id, p.intent, p.message_type, p.bhk, p.price, p.price_unit,
               p.furnishing, p.building_name, p.micro_market, p.broker_name,
               p.confidence, p.created_at, bo.role, bo.group_name, bo.seen_at
        FROM broker_observations bo
        JOIN parsed_output p ON p.id = bo.parsed_id
        WHERE bo.broker_id = ?
        ORDER BY bo.seen_at DESC
        LIMIT 100
    """, (broker_id,)).fetchall()]
    # Add daily activity timeline for last 60 days
    try:
        timeline = storage.db.execute("""
            SELECT DATE(seen_at) AS day, COUNT(*) AS count
            FROM broker_observations
            WHERE broker_id = ? AND seen_at IS NOT NULL
              AND seen_at >= DATE('now', '-60 days')
            GROUP BY DATE(seen_at)
            ORDER BY day ASC
        """, (broker_id,)).fetchall()
        broker["timeline"] = [{"day": r[0], "count": r[1]} for r in timeline]
    except Exception:
        broker["timeline"] = []

    # Unique contribution highlights: buildings where this broker is sole or majority source
    try:
        highlights = storage.db.execute("""
            SELECT
                b.building_name,
                b.observation_count AS broker_obs,
                (SELECT COUNT(*) FROM broker_observations WHERE building_name = b.building_name) AS total_obs
            FROM broker_building_stats b
            WHERE b.broker_id = ?
              AND b.observation_count > 0
            ORDER BY b.observation_count DESC
            LIMIT 50
        """, (broker_id,)).fetchall()
        contribution = []
        for h in highlights:
            bldg = h["building_name"]
            bo = h["broker_obs"]
            to = h["total_obs"]
            if to > 0:
                pct = round(bo / to * 100)
                if pct >= 70:
                    contribution.append({
                        "building_name": bldg,
                        "broker_obs": bo,
                        "total_obs": to,
                        "share_pct": pct,
                        "is_exclusive": pct == 100,
                    })
        broker["contribution_highlights"] = contribution[:10]
    except Exception:
        broker["contribution_highlights"] = []

    return broker


@app.get("/api/brokers/{broker_id}/share-card")
async def get_broker_share_card(broker_id: int, user: dict = Depends(require_user)):
    storage.rebuild_broker_graph()
    row = storage.db.execute("""
        SELECT id, canonical_name AS name, primary_phone AS phone,
               observation_count, listing_count, requirement_count,
               rental_count, commercial_count, group_count, market_count,
               building_count, active_days_30, first_seen_at, last_seen_at
        FROM brokers
        WHERE id = ?
    """, (broker_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Broker not found")

    broker = dict(row)

    markets = [dict(r) for r in storage.db.execute("""
        SELECT micro_market, observation_count, listing_count, requirement_count
        FROM broker_market_stats
        WHERE broker_id = ?
        ORDER BY observation_count DESC
        LIMIT 3
    """, (broker_id,)).fetchall()]

    groups = [
        {
            "group_name": _group_jid_to_name(r["group_name"]),
            "observation_count": r["observation_count"],
        }
        for r in storage.db.execute("""
            SELECT group_name, COUNT(*) AS observation_count
            FROM broker_observations
            WHERE broker_id = ? AND group_name IS NOT NULL AND group_name != ''
            GROUP BY group_name
            ORDER BY observation_count DESC
            LIMIT 5
        """, (broker_id,)).fetchall()
    ]

    def _is_masked(name):
        if not name:
            return False
        return name.startswith("+") or "XXX" in name

    def _disp_phone(phone):
        if not phone:
            return ""
        digits = re.sub(r"\D+", "", phone)
        local = digits[-10:] if len(digits) >= 10 else digits
        if len(local) != 10:
            return ""
        return f"+91 {local[:5]} {local[5:]}"

    card_data = {
        "broker_name": _disp_phone(broker["phone"]) if _is_masked(broker["name"]) else (broker["name"] or "Unknown Broker"),
        "is_masked": _is_masked(broker["name"]),
        "phone_display": _disp_phone(broker["phone"]),
        "total_observations": broker["observation_count"] or 0,
        "supply_count": broker["listing_count"] or 0,
        "demand_count": broker["requirement_count"] or 0,
        "top_markets": markets,
        "top_groups": groups,
        "first_seen": broker["first_seen_at"],
        "last_active": broker["last_seen_at"],
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M"),
    }

    return card_data


@app.post("/api/brokers/{broker_id}/share-card/snapshot")
async def save_broker_share_card_snapshot(broker_id: int, user: dict = Depends(require_user)):
    import hashlib
    storage.rebuild_broker_graph()
    row = storage.db.execute("""
        SELECT id, canonical_name AS name, primary_phone AS phone,
               observation_count, listing_count, requirement_count,
               rental_count, commercial_count, group_count, market_count,
               building_count, active_days_30, first_seen_at, last_seen_at
        FROM brokers
        WHERE id = ?
    """, (broker_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Broker not found")

    token = hashlib.sha256(f"{broker_id}:{datetime.now(timezone.utc).isoformat()}:{uuid.uuid4()}".encode()).hexdigest()[:32]

    broker = dict(row)
    markets = [dict(r) for r in storage.db.execute("""
        SELECT micro_market, observation_count, listing_count, requirement_count
        FROM broker_market_stats
        WHERE broker_id = ?
        ORDER BY observation_count DESC
        LIMIT 3
    """, (broker_id,)).fetchall()]
    groups = [
        {
            "group_name": _group_jid_to_name(r["group_name"]),
            "observation_count": r["observation_count"],
        }
        for r in storage.db.execute("""
            SELECT group_name, COUNT(*) AS observation_count
            FROM broker_observations
            WHERE broker_id = ? AND group_name IS NOT NULL AND group_name != ''
            GROUP BY group_name
            ORDER BY observation_count DESC
            LIMIT 5
        """, (broker_id,)).fetchall()
    ]

    def _is_masked(name):
        if not name:
            return False
        return name.startswith("+") or "XXX" in name

    def _disp_phone(phone):
        if not phone:
            return ""
        digits = re.sub(r"\D+", "", phone)
        local = digits[-10:] if len(digits) >= 10 else digits
        if len(local) != 10:
            return ""
        return f"+91 {local[:5]} {local[5:]}"

    card_data = {
        "broker_name": _disp_phone(broker["phone"]) if _is_masked(broker["name"]) else (broker["name"] or "Unknown Broker"),
        "is_masked": _is_masked(broker["name"]),
        "phone_display": _disp_phone(broker["phone"]),
        "total_observations": broker["observation_count"] or 0,
        "supply_count": broker["listing_count"] or 0,
        "demand_count": broker["requirement_count"] or 0,
        "top_markets": markets,
        "top_groups": groups,
        "first_seen": broker["first_seen_at"],
        "last_active": broker["last_seen_at"],
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M"),
    }

    storage.db.execute(
        "INSERT INTO share_cards (token, broker_id, card_data, created_at) VALUES (?, ?, ?, ?)",
        (token, broker_id, json.dumps(card_data), datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")),
    )
    storage.db.commit()

    return {"token": token, "url": f"/api/share/brokers/{token}"}


@app.post("/api/observations/{obs_id}/teach")
async def teach_observation(obs_id: int, data: dict, user: dict = Depends(require_user)):
    result = storage.teach_observation(obs_id, data)
    return result


@app.post("/api/brokers/{phone}/hide")
async def hide_broker(phone: str, user: dict = Depends(require_user)):
    result = storage.hide_broker(phone)
    if not result.get("success"):
        raise HTTPException(404, "Broker not found")
    return result


@app.post("/api/brokers/{phone}/unhide")
async def unhide_broker(phone: str, user: dict = Depends(require_user)):
    result = storage.unhide_broker(phone)
    if not result.get("success"):
        raise HTTPException(404, "Broker not found")
    return result


@app.get("/api/clients/{client_id}/messages")
async def get_client_messages(client_id: int, limit: int = 100, offset: int = 0, user: dict = Depends(require_user)):
    return storage.get_client_messages(client_id, limit, offset)


@app.get("/api/share/brokers/{token}")
async def get_shared_broker_card(token: str):
    row = storage.db.execute(
        "SELECT card_data, created_at FROM share_cards WHERE token = ?",
        (token,),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Share card not found or expired")
    card = json.loads(row["card_data"])
    card["token"] = token
    return card


# ── AI Suggestions Queue ─────────────────────────────────────────

class SuggestionAction(BaseModel):
    status: str = "approved"


@app.get("/api/suggestions")
async def list_suggestions(status: str = "pending", limit: int = 50, offset: int = 0, user: dict = Depends(require_user)):
    return storage.get_suggestions(status=status, limit=limit, offset=offset)


@app.get("/api/suggestions/counts")
async def suggestion_counts(user: dict = Depends(require_user)):
    return storage.get_suggestion_counts()


@app.post("/api/suggestions/{sug_id}/{action}")
async def act_on_suggestion(sug_id: int, action: str, request: Request, user: dict = Depends(require_user)):
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
async def batch_suggestions(request: Request, user: dict = Depends(require_user)):
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
async def suggestion_memory(user: dict = Depends(require_user)):
    return storage.get_ai_memory_stats()


@app.get("/api/suggestions/usage")
async def suggestion_usage(days: int = 1, user: dict = Depends(require_user)):
    return storage.get_ai_usage_stats(days=days)


@app.get("/api/price-stats")
async def price_stats_endpoint(market: str = "", bhk: str = "", intent: str = "listing", user: dict = Depends(require_user)):
    if market and bhk:
        result = storage.get_price_stats(market, bhk, intent)
        return result or {"error": "not found"}
    rows = storage.db.execute(
        "SELECT * FROM price_stats ORDER BY count DESC LIMIT 100"
    ).fetchall()
    return [dict(r) for r in rows]


@app.get("/api/enrichment-jobs/counts")
async def enrichment_counts(user: dict = Depends(require_user)):
    counts = {}
    for status in ("pending", "running", "completed", "failed"):
        r = storage.db.execute(
            "SELECT COUNT(*) FROM enrichment_jobs WHERE status = ?", (status,)
        ).fetchone()
        counts[status] = r[0]
    return counts


@app.post("/api/aliases/scan")
async def scan_aliases(user: dict = Depends(require_user)):
    from agents.alias_learner import check_for_aliases
    check_for_aliases(storage)
    return {"status": "ok"}


@app.post("/api/price-stats/recompute")
async def recompute_price_stats(user: dict = Depends(require_user)):
    storage.recompute_price_stats()
    return {"status": "ok"}


@app.get("/api/buildings")
async def list_buildings(limit: int = 100, offset: int = 0, status: str = "", user: dict = Depends(require_user)):
    """List buildings from the knowledge graph."""
    where = ""
    params = []
    if status:
        where = "WHERE b.status = ?"
        params.append(status)

    rows = storage.db.execute(f"""
        SELECT b.id, b.building_id, b.canonical_name, b.micro_market, b.developer,
               b.address, b.pincode, b.latitude, b.longitude,
               b.observed_listings, b.observed_brokers, b.observed_requirements,
               b.last_enriched, b.enrichment_confidence, b.status,
               b.created_at, b.updated_at,
               (SELECT COUNT(*) FROM building_name_aliases WHERE building_id = b.id) as alias_count
        FROM buildings b
        {where}
        ORDER BY b.observed_listings DESC, b.canonical_name ASC
        LIMIT ? OFFSET ?
    """, params + [limit, offset]).fetchall()

    total = storage.db.execute(f"SELECT COUNT(*) FROM buildings b {where}", params).fetchone()[0]
    return {"buildings": [dict(r) for r in rows], "total": total, "limit": limit, "offset": offset}


@app.get("/api/buildings/{building_id:path}")
async def get_building_profile(building_id: str, user: dict = Depends(require_user)):
    """Get full building profile by building_id (BLD-XXXXXXX) or canonical name."""
    # Try to find by building_id first
    if building_id.startswith("BLD-"):
        building = storage.get_building(building_id=building_id)
    else:
        # Try by canonical name
        building = storage.get_building(canonical_name=building_id)

    if not building:
        raise HTTPException(404, f"Building '{building_id}' not found")

    profile = storage.get_building_profile(building["id"])
    if not profile:
        raise HTTPException(404, f"Building profile not found")

    return profile


@app.post("/api/buildings/{building_id}/refresh")
async def refresh_building(building_id: str, provider: str = "", user: dict = Depends(require_user)):
    """Trigger enrichment refresh for a building."""
    if building_id.startswith("BLD-"):
        building = storage.get_building(building_id=building_id)
    else:
        building = storage.get_building(canonical_name=building_id)

    if not building:
        raise HTTPException(404, f"Building '{building_id}' not found")

    if provider:
        storage.create_building_enrichment_job(building["id"], provider, priority=10)
    else:
        from agents.building_enrichment.providers import get_all_providers
        for p in get_all_providers():
            storage.create_building_enrichment_job(building["id"], p.name, priority=10)

    return {"status": "ok", "message": f"Enrichment jobs created for {building['canonical_name']}"}


@app.get("/api/buildings/{building_id}/aliases")
async def get_building_aliases(building_id: str, user: dict = Depends(require_user)):
    """Get all aliases for a building."""
    if building_id.startswith("BLD-"):
        building = storage.get_building(building_id=building_id)
    else:
        building = storage.get_building(canonical_name=building_id)

    if not building:
        raise HTTPException(404, f"Building '{building_id}' not found")

    aliases = storage.get_building_aliases(building["id"])
    return aliases


@app.post("/api/buildings/discover")
async def discover_buildings(user: dict = Depends(require_user)):
    """Discover canonical buildings from parsed observations."""
    from agents.building_enrichment.discovery import BuildingDiscovery
    discovery = BuildingDiscovery(storage)
    discovered = discovery.discover_from_observations(min_observations=2)
    return {
        "discovered": len(discovered),
        "new": len([d for d in discovered if not d.get("already_existed")]),
        "existing": len([d for d in discovered if d.get("already_existed")]),
        "buildings": discovered[:20],
    }


@app.post("/api/buildings/refresh-counts")
async def refresh_building_counts(user: dict = Depends(require_user)):
    """Recalculate observed_listings, observed_brokers, observed_requirements for all buildings."""
    storage.refresh_building_counts()
    total = storage.db.execute("SELECT COUNT(*) FROM buildings").fetchone()[0]
    with_listings = storage.db.execute("SELECT COUNT(*) FROM buildings WHERE observed_listings > 0").fetchone()[0]
    return {"status": "ok", "total_buildings": total, "with_listings": with_listings}


@app.get("/api/buildings/enrichment/dashboard")
async def building_enrichment_dashboard(user: dict = Depends(require_user)):
    """Get building enrichment dashboard stats."""
    stats = storage.get_building_enrichment_stats()
    return stats


@app.get("/api/buildings/enrichment/jobs")
async def building_enrichment_jobs(status: str = "", limit: int = 50, user: dict = Depends(require_user)):
    """List building enrichment jobs."""
    if status:
        rows = storage.db.execute("""
            SELECT j.*, b.building_id as building_code, b.canonical_name
            FROM building_enrichment_jobs j
            JOIN buildings b ON b.id = j.building_id
            WHERE j.status = ?
            ORDER BY j.created_at DESC
            LIMIT ?
        """, (status, limit)).fetchall()
    else:
        rows = storage.db.execute("""
            SELECT j.*, b.building_id as building_code, b.canonical_name
            FROM building_enrichment_jobs j
            JOIN buildings b ON b.id = j.building_id
            ORDER BY j.created_at DESC
            LIMIT ?
        """, (limit,)).fetchall()

    return [dict(r) for r in rows]


@app.get("/api/buildings/enrichment/history")
async def building_enrichment_history(building_id: str = "", limit: int = 50, user: dict = Depends(require_user)):
    """Get enrichment history."""
    if building_id:
        if building_id.startswith("BLD-"):
            building = storage.get_building(building_id=building_id)
        else:
            building = storage.get_building(canonical_name=building_id)

        if not building:
            raise HTTPException(404, f"Building '{building_id}' not found")

        rows = storage.db.execute("""
            SELECT * FROM building_enrichment_history
            WHERE building_id = ?
            ORDER BY created_at DESC
            LIMIT ?
        """, (building["id"], limit)).fetchall()
    else:
        rows = storage.db.execute("""
            SELECT h.*, b.canonical_name, b.building_id as building_code
            FROM building_enrichment_history h
            JOIN buildings b ON b.id = h.building_id
            ORDER BY h.created_at DESC
            LIMIT ?
        """, (limit,)).fetchall()

    return [dict(r) for r in rows]


@app.get("/api/igr/districts")
async def igr_districts(rest_of_maharashtra: bool = True, user: dict = Depends(require_user)):
    """Get available IGR districts."""
    from agents.igr_scraper import IGRScraper
    scraper = IGRScraper()
    return scraper.get_districts(rest_of_maharashtra=rest_of_maharashtra)


@app.get("/api/igr/tahsils")
async def igr_tahsils(district_code: str, user: dict = Depends(require_user)):
    """Get tahsils for a district."""
    from agents.igr_scraper import IGRScraper
    scraper = IGRScraper()
    return scraper.get_tahsils(district_code)


@app.get("/api/igr/villages")
async def igr_villages(district_code: str, tahsil_code: str, user: dict = Depends(require_user)):
    """Get villages for a tahsil."""
    from agents.igr_scraper import IGRScraper
    scraper = IGRScraper()
    return scraper.get_villages(district_code, tahsil_code)


@app.get("/api/igr/search")
async def igr_search(
    user: dict = Depends(require_user),
    district_code: str = "6",
    tahsil_code: str = "9 ",
    village: str = "",
    property_no: str = "",
    year: int = 2025,
    building_id: str = "",
):
    """
    Search IGR Maharashtra for property registrations.

    Note: IGR requires exact CTS/Survey/Milkat numbers.
    Searching by building name is NOT supported by IGR.
    """
    from agents.igr_scraper import IGRScraper

    if not village:
        raise HTTPException(400, "Village name is required")

    scraper = IGRScraper()
    results = scraper.search_property_details(
        district_code=district_code,
        tahsil_code=tahsil_code,
        village=village,
        property_no=property_no,
        year=year,
    )

    results_list = [
        {
            "index_no": r.index_no,
            "document_type": r.document_type,
            "registration_date": r.registration_date,
            "deed_date": r.deed_date,
            "property_description": r.property_description,
            "building_name": r.building_name,
            "area": r.area,
            "consideration_amount": r.consideration_amount,
            "stamp_duty_paid": r.stamp_duty_paid,
            "sro": r.sro,
        }
        for r in results
    ]

    saved = 0
    if building_id and results_list:
        building = storage.get_building(building_id=building_id)
        if building:
            saved = storage.save_igr_results(
                building_db_id=building["id"],
                results=results_list,
                district=district_code,
                village=village,
                property_no=property_no,
            )

    return {
        "district": district_code,
        "tahsil": tahsil_code,
        "village": village,
        "property_no": property_no,
        "year": year,
        "results": results_list,
        "total": len(results_list),
        "saved_to_history": saved,
        "note": "IGR requires exact CTS/Survey numbers. Building name search is not supported.",
    }


@app.get("/api/groups")
async def list_groups(user: dict = Depends(require_user)):
    jobs = storage.get_sync_jobs(limit=500, source="whatsapp")
    group_markets = storage.get_group_markets()
    opt_out_list = load_excluded_groups()
    groups = []
    for j in jobs:
        try:
            meta = json.loads(j.meta) if isinstance(j.meta, str) else (j.meta or {})
        except (json.JSONDecodeError, TypeError):
            meta = {}
        # Member count comes from the column (populated by the ingestor on group refresh)
        participants = j.participants or meta.get("participants", 0) or 0
        # Tags: merge name-parsed markets/segments with data-derived markets
        parsed = parse_group_name(j.group_name)
        derived = group_markets.get(j.group_name) or []
        merged_markets = list(dict.fromkeys([*parsed.get("markets", []), *derived]))
        enriched = {**parsed, "markets": merged_markets}
        excluded = any(
            entry.lower() in j.group_name.lower() or entry.lower() == str(j.group_id).lower()
            for entry in opt_out_list
        ) if opt_out_list else False
        groups.append({
            "jid": j.group_id,
            "name": j.group_name,
            "participants": participants,
            "parsed": enriched,
            "records_found": j.records_found or 0,
            "records_processed": j.records_processed or 0,
            "status": j.status,
            "error": j.error,
            "allowed": not excluded,
            "excluded": excluded,
        })
    return sorted(groups, key=lambda g: g["name"].lower())


@app.get("/api/whatsapp/conversations")
async def list_whatsapp_conversations(
    types: str = "group,broadcast",
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    """Workspace-scoped WhatsApp directory, independent of market parsing."""
    allowed = {"group", "broadcast", "direct"}
    requested = [value.strip() for value in types.split(",") if value.strip() in allowed]
    # Keep this directory on the exact same workspace resolver used by the
    # connected-phone header and Connections page. A stale/default tenant
    # context must never make a broker's live WhatsApp mirror look empty.
    active_org_id = await asyncio.to_thread(
        _resolve_active_organization_id, user, tenant_id,
    )
    return await asyncio.to_thread(
        storage.get_whatsapp_conversations,
        active_org_id,
        requested or ["group", "broadcast"],
        1000,
    )


@app.get("/api/groups/opt-out")
async def get_opt_out_list(user: dict = Depends(require_user)):
    """Return the current group opt-out list."""
    return load_excluded_groups()


@app.post("/api/groups/opt-out")
async def set_opt_out_list(request: Request, user: dict = Depends(require_user)):
    """Set the group opt-out list (JSON array of group JIDs or name substrings)."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON")
    if not isinstance(body, list):
        raise HTTPException(400, "Expected a JSON array of strings")
    entries = [str(x).strip() for x in body if x and str(x).strip()]
    save_excluded_groups(entries)
    return {"status": "ok", "count": len(entries)}


@app.delete("/api/groups/opt-out")
async def clear_opt_out_list(user: dict = Depends(require_user)):
    """Clear the group opt-out list (track all groups)."""
    save_excluded_groups([])
    return {"status": "ok"}


@app.get("/api/groups/allowlist")
async def get_allowlist(user: dict = Depends(require_user)):
    """Backward-compatible alias for the group opt-out list."""
    return load_excluded_groups()


@app.post("/api/groups/allowlist")
async def set_allowlist(request: Request, user: dict = Depends(require_user)):
    """Backward-compatible alias for the group opt-out list."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON")
    if not isinstance(body, list):
        raise HTTPException(400, "Expected a JSON array of strings")
    entries = [str(x).strip() for x in body if x and str(x).strip()]
    save_excluded_groups(entries)
    return {"status": "ok", "count": len(entries)}


@app.delete("/api/groups/allowlist")
async def clear_allowlist(user: dict = Depends(require_user)):
    """Backward-compatible alias for clearing the group opt-out list."""
    save_excluded_groups([])
    return {"status": "ok"}


@app.get("/api/listings")
async def list_listings(limit: int = 50, offset: int = 0, user: dict = Depends(require_user)):
    return storage.get_listings(limit, offset)


@app.get("/api/listings/{listing_id}")
async def get_listing_detail(listing_id: int, user: dict = Depends(require_user)):
    """Get a single listing by ID with full details.
    NOTE: SELECT * includes tenant_nationality_preference (INTERNAL ONLY).
    This is safe here because this endpoint is behind require_user (admin),
    NOT a public-facing route. Do not expose to propai.live / consumer surfaces.
    """
    try:
        res = storage.client.table("listings").select("*").eq("id", listing_id).limit(1).execute()
        if not res.data:
            raise HTTPException(404, "Listing not found")
        listing = res.data[0]
        sources = []
        try:
            src_res = storage.client.table("parsed").select(
                "id, intent, role, message_type, bhk, price, price_unit, "
                "area_sqft, furnishing, building_name, micro_market, confidence, "
                "created_at, raw_message_id"
            ).eq("listing_id", listing_id).order("created_at", desc=True).limit(50).execute()
            sources = src_res.data or []
        except Exception:
            pass
        photos = []
        try:
            ph_res = storage.client.table("listing_photos").select(
                "id, media_id, filename, mime_type, caption, sender_phone, sender_name, created_at"
            ).eq("listing_id", listing_id).order("created_at", desc=True).limit(20).execute()
            photos = [{
                **p,
                "url": f"/api/media/photos/{p['id']}"
            } for p in (ph_res.data or [])]
        except Exception:
            pass
        raw_msg = None
        raw_msg_id = listing.get("representative_raw_message_id") or listing.get("latest_raw_message_id")
        if raw_msg_id:
            try:
                raw_res = storage.client.table("raw_messages").select(
                    "id, content, sender_name, sender_phone, group_name, "
                    "timestamp, message_type, media_type"
                ).eq("id", raw_msg_id).limit(1).execute()
                if raw_res.data:
                    raw_msg = raw_res.data[0]
            except Exception:
                pass
        return {**listing, "sources": sources, "photos": photos, "raw_message": raw_msg}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Failed to fetch listing: {e}")


@app.get("/api/listings/{listing_id}/sources")
async def get_listing_sources(listing_id: int, user: dict = Depends(require_user)):
    """Get source observations that contributed to a listing."""
    return storage.get_listing_sources(listing_id)


@app.get("/api/listings/{listing_id}/photos")
async def list_listing_photos(listing_id: int, user: dict = Depends(require_user)):
    """Get photos for a listing."""
    photos = storage.get_listing_photos(listing_id)
    return [{
        "id": p["id"],
        "media_id": p["media_id"],
        "filename": p["filename"],
        "mime_type": p["mime_type"],
        "caption": p["caption"],
        "sender_phone": p["sender_phone"],
        "sender_name": p["sender_name"],
        "created_at": p["created_at"],
        "url": f"/api/media/photos/{p['id']}",
    } for p in photos]


@app.get("/api/media/photos/{photo_id}")
async def serve_listing_photo(photo_id: int, user: dict = Depends(require_user)):
    """Serve a listing photo file."""
    row = storage.db.execute(
        "SELECT * FROM listing_photos WHERE id = ?", (photo_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "Photo not found")
    p = dict(row)
    filepath = p.get("filepath", "")
    if not filepath or not Path(filepath).exists():
        raise HTTPException(404, "Photo file not found on disk")
    mime = p.get("mime_type", "image/jpeg")
    return FileResponse(filepath, media_type=mime)


@app.post("/api/listings/{listing_id}/photos")
async def upload_listing_photo(listing_id: int, request: Request, user: dict = Depends(require_user)):
    """Upload a photo for a listing (for testing/admin via multipart)."""
    pic_token = storage.get_or_create_pic_token(listing_id)
    if not pic_token:
        raise HTTPException(500, "Could not generate PIC token")
    form = await request.form()
    file = form.get("file")
    if not file or not hasattr(file, "filename") or not file.filename:
        raise HTTPException(400, "No file provided")
    content = await file.read()
    ext = Path(file.filename).suffix or ".jpg"
    media_id = f"upload_{uuid.uuid4().hex[:12]}"
    filename = f"{media_id}{ext}"
    filepath = str(MEDIA_DIR / filename)
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    Path(filepath).write_bytes(content)
    mime = file.content_type or "image/jpeg"
    caption = form.get("caption", "")
    sender_phone = form.get("sender_phone", "")
    sender_name = form.get("sender_name", "")
    photo_id = storage.save_listing_photo(
        listing_id=listing_id,
        pic_token=pic_token,
        media_id=media_id,
        filename=filename,
        filepath=filepath,
        mime_type=mime,
        caption=caption,
        sender_phone=sender_phone,
        sender_name=sender_name,
    )
    return {"id": photo_id, "filename": filename, "url": f"/api/media/photos/{photo_id}"}


@app.get("/api/parsed/{parsed_id}/sources")
async def get_parsed_sources(parsed_id: int, user: dict = Depends(require_user)):
    """Get source observations that contributed to a parsed output."""
    return storage.get_parsed_sources(parsed_id)


@app.get("/api/search")
async def search_messages(q: str = "", user: dict = Depends(require_user)):
    if not q:
        return []
    q = q.strip()
    like_q = f"%{q}%"
    before_q = f"%{q}"
    after_q = f"{q}%"

    # Build search results grouped by entity type
    result = {"listings": [], "requirements": [], "brokers": [], "buildings": [], "markets": [], "messages": []}

    try:
        # Priority: listings first (most useful)
        try:
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
        except Exception:
            result["listings"] = []

        # Requirements
        try:
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
        except Exception:
            result["requirements"] = []

        # Brokers
        try:
            result["brokers"] = [dict(r) for r in storage.db.execute("""
                SELECT id, canonical_name AS name, primary_phone AS phone,
                       observation_count, listing_count, requirement_count,
                       group_count, market_count, avg_ticket
                FROM brokers
                WHERE canonical_name LIKE ? OR primary_phone LIKE ?
                ORDER BY observation_count DESC
                LIMIT 6
            """, [like_q, like_q]).fetchall()]
        except Exception:
            result["brokers"] = []

        # Buildings
        try:
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
        except Exception:
            result["buildings"] = []

        # Markets
        try:
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
        except Exception:
            result["markets"] = []

        # Raw messages (for full-text search of messages)
        try:
            result["messages"] = [dict(r) for r in storage.db.execute("""
                SELECT id, message, group_name, sender, timestamp
                FROM raw_messages
                WHERE message LIKE ?
                ORDER BY id DESC
                LIMIT 6
            """, [like_q]).fetchall()]
        except Exception:
            result["messages"] = []
    except Exception:
        pass

    # Remove empty groups
    result = {k: v for k, v in result.items() if v}
    return result


@app.get("/api/search/raw")
async def search_raw_messages(q: str = "", limit: int = 20, offset: int = 0, user: dict = Depends(require_user)):
    """Full-text search over raw messages using FTS5. Primary search path for knowledge OS."""
    if not q:
        return {"results": [], "count": 0}

    q = q.strip()

    def _resolve_group_name(group_name: str) -> str:
        if group_name and "@g.us" in group_name:
            resolved = storage.db.execute(
                "SELECT group_name FROM source_sync_jobs WHERE group_id = ? LIMIT 1",
                (group_name,)
            ).fetchone()
            if resolved:
                return resolved[0]
        return group_name

    def _row_to_result(row: Any, snippet: str | None = None) -> dict:
        return {
            "id": row[0],
            "group_name": _resolve_group_name(row[1]),
            "sender": row[2],
            "sender_phone": row[3],
            "message": row[4],
            "timestamp": row[5],
            "source": row[6],
            "snippet": snippet if snippet is not None else (row[4][:200] if row[4] else ""),
        }

    # FTS5 search
    try:
        rows = storage.db.execute("""
            SELECT rm.id, rm.group_name, rm.sender, rm.sender_phone,
                   rm.message, rm.timestamp, rm.source,
                   snippet(raw_messages_fts, 0, '<mark>', '</mark>', '...', 40) as snippet
            FROM raw_messages_fts fts
            JOIN raw_messages rm ON rm.id = fts.rowid
            WHERE raw_messages_fts MATCH ?
            ORDER BY rank
            LIMIT ? OFFSET ?
        """, (q, limit, offset)).fetchall()

        # Get total count
        count_row = storage.db.execute("""
            SELECT COUNT(*) FROM raw_messages_fts WHERE raw_messages_fts MATCH ?
        """, (q,)).fetchone()
        total = count_row[0] if count_row else 0

        return {"results": [_row_to_result(r, r[7]) for r in rows], "count": total, "query": q}

    except Exception as e:
        # Fallback to LIKE search if FTS fails
        try:
            like_q = f"%{q}%"
            rows = storage.db.execute("""
                SELECT id, group_name, sender, sender_phone, message, timestamp, source
                FROM raw_messages
                WHERE message LIKE ? OR group_name LIKE ? OR sender LIKE ?
                ORDER BY id DESC
                LIMIT ? OFFSET ?
            """, (like_q, like_q, like_q, limit, offset)).fetchall()

            count_row = storage.db.execute("""
                SELECT COUNT(*) FROM raw_messages
                WHERE message LIKE ? OR group_name LIKE ? OR sender LIKE ?
            """, (like_q, like_q, like_q)).fetchone()
            total = count_row[0] if count_row else 0
            return {"results": [_row_to_result(r) for r in rows], "count": total, "query": q}
        except Exception as like_error:
            logging.warning("[api/search/raw] FTS and LIKE search failed: %s / %s", e, like_error)

        try:
            rows = storage.get_raw_messages(limit=max(limit + offset, 1000), offset=0)
            needle = q.casefold()
            filtered = []
            for row in rows:
                haystack = " ".join(
                    str(part)
                    for part in (
                        getattr(row, "message", "") or "",
                        getattr(row, "group_name", "") or "",
                        getattr(row, "sender", "") or "",
                        getattr(row, "sender_phone", "") or "",
                        getattr(row, "source", "") or "",
                    )
                ).casefold()
                if needle in haystack:
                    filtered.append({
                        "id": getattr(row, "id", None),
                        "group_name": _resolve_group_name(getattr(row, "group_name", "") or ""),
                        "sender": getattr(row, "sender", "") or "",
                        "sender_phone": getattr(row, "sender_phone", "") or "",
                        "message": getattr(row, "message", "") or "",
                        "timestamp": getattr(row, "timestamp", "") or "",
                        "source": getattr(row, "source", "") or "",
                        "snippet": (getattr(row, "message", "") or "")[:200],
                    })
            total = len(filtered)
            return {"results": filtered[offset:offset + limit], "count": total, "query": q, "fallback": "python_scan"}
        except Exception as scan_error:
            logging.warning("[api/search/raw] python fallback failed: %s", scan_error)
            return {"results": [], "count": 0, "query": q, "fallback": "empty"}


@app.get("/api/search/raw/sender")
async def search_raw_by_sender(sender: str = "", limit: int = 50, user: dict = Depends(require_user)):
    """Search raw messages by sender name or phone."""
    if not sender:
        return {"results": [], "count": 0}

    like_q = f"%{sender}%"
    rows = storage.db.execute("""
        SELECT id, group_name, sender, sender_phone, message, timestamp, source
        FROM raw_messages
        WHERE sender LIKE ? OR sender_phone LIKE ?
        ORDER BY id DESC
        LIMIT ?
    """, (like_q, like_q, limit)).fetchall()

    results = []
    for r in rows:
        group_name = r[1]
        if group_name and '@g.us' in group_name:
            resolved = storage.db.execute(
                "SELECT group_name FROM source_sync_jobs WHERE group_id = ? LIMIT 1",
                (group_name,)
            ).fetchone()
            if resolved:
                group_name = resolved[0]

        results.append({
            "id": r[0],
            "group_name": group_name,
            "sender": r[2],
            "sender_phone": r[3],
            "message": r[4],
            "timestamp": r[5],
            "source": r[6],
        })

    return {"results": results, "count": len(results), "query": sender}


@app.get("/api/search/raw/group")
async def search_raw_by_group(group_jid: str = "", limit: int = 50, user: dict = Depends(require_user)):
    """Search raw messages by group JID or name."""
    if not group_jid:
        return {"results": [], "count": 0}

    # Try to find by JID or name
    rows = storage.db.execute("""
        SELECT id, group_name, sender, sender_phone, message, timestamp, source
        FROM raw_messages
        WHERE group_name = ? OR group_name LIKE ?
        ORDER BY id DESC
        LIMIT ?
    """, (group_jid, f"%{group_jid}%", limit)).fetchall()

    results = []
    for r in rows:
        group_name = r[1]
        if group_name and '@g.us' in group_name:
            resolved = storage.db.execute(
                "SELECT group_name FROM source_sync_jobs WHERE group_id = ? LIMIT 1",
                (group_name,)
            ).fetchone()
            if resolved:
                group_name = resolved[0]

        results.append({
            "id": r[0],
            "group_name": group_name,
            "sender": r[2],
            "sender_phone": r[3],
            "message": r[4],
            "timestamp": r[5],
            "source": r[6],
        })

    return {"results": results, "count": len(results), "query": group_jid}


@app.get("/api/memory/jids")
async def search_jid_memory(q: str = "", limit: int = 20, user: dict = Depends(require_user)):
    return storage.search_jid_memory(q, limit)


@app.get("/api/memory/jids/{jid_key:path}")
async def get_jid_memory_profile(jid_key: str, user: dict = Depends(require_user)):
    profile = storage.get_jid_profile(jid_key)
    if not profile:
        raise HTTPException(404, "JID profile not found")
    return profile


@app.post("/api/memory/rebuild")
async def rebuild_jid_memory(limit: int = 0, user: dict = Depends(require_user)):
    return storage.rebuild_jid_memory(limit)


@app.get("/api/search/market")
async def market_search(
    user: dict = Depends(require_user),
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


# ── Knowledge Trainer ──────────────────────────────────────────────

@app.get("/api/trainer/terms")
async def get_trainer_terms(status: str | None = None, limit: int = 100, user: dict = Depends(require_user)):
    return storage.get_trainer_terms(status=status, limit=limit)

@app.get("/api/trainer/stats")
async def get_trainer_stats(user: dict = Depends(require_user)):
    return storage.get_trainer_stats()

@app.get("/api/trainer/discover")
async def discover_unknown_terms(limit: int = 50, user: dict = Depends(require_user)):
    return storage.find_unknown_terms(limit=limit)

@app.post("/api/trainer/resolve")
async def resolve_trainer_term(request: Request, user: dict = Depends(require_user)):
    body = await request.json()
    term_id = body.get("term_id")
    status = body.get("status")
    if not term_id or not status:
        raise HTTPException(400, "term_id and status required")
    if status not in ("building", "society", "landmark", "locality", "combined_locality", "other", "ignored"):
        raise HTTPException(400, "Invalid status")
    notes = body.get("notes", "")
    expands_to = body.get("expands_to")
    ok = storage.resolve_trainer_term(term_id, status, "user", notes, expands_to=expands_to)
    return {"status": "ok" if ok else "error"}

@app.post("/api/trainer/batch")
async def batch_trainer(request: Request, user: dict = Depends(require_user)):
    body = await request.json()
    items = body.get("items", [])
    for item in items:
        term_id = item.get("term_id")
        status = item.get("status")
        notes = item.get("notes", "")
        if term_id and status:
            storage.resolve_trainer_term(term_id, status, "user", notes)
    return {"status": "ok", "count": len(items)}

@app.post("/api/trainer/scan")
async def scan_for_unknown(user: dict = Depends(require_user)):
    """Scan raw messages for unknown terms and add to trainer queue."""
    import re
    unknowns = storage.find_unknown_terms(limit=100)
    added = 0
    blacklisted = 0
    candidates = 0
    for u in unknowns:
        if not u.get("already_in_trainer"):
            context = u.get("contexts", [""])[0] if u.get("contexts") else ""
            raw_ids = u.get("raw_ids", [])
            result = storage.add_trainer_term(
                u["term"],
                context=context,
                raw_message_id=raw_ids[0] if raw_ids else None,
            )
            if isinstance(result, dict):
                if result.get("status") == "candidate":
                    candidates += 1
                elif result.get("error") == "blacklisted":
                    blacklisted += 1
                elif "term" in result:
                    added += 1
            else:
                added += 1
    return {"status": "ok", "discovered": len(unknowns), "added": added, "blacklisted": blacklisted, "candidates": candidates}


@app.get("/api/trainer/candidates")
async def list_learning_candidates(limit: int = 100, status: str = "candidate", user: dict = Depends(require_user)):
    """List learning candidates — low-confidence phrases that may need human review."""
    try:
        where = "WHERE status = ?" if status else ""
        params = [status] if status else []
        rows = storage.db.execute(f"""
            SELECT id, phrase, frequency, confidence,
                   first_seen, last_seen, contexts, raw_message_ids, source, status
            FROM knowledge_learning_candidates
            {where}
            ORDER BY frequency DESC, confidence DESC
            LIMIT ?
        """, (*params, limit)).fetchall()
        return [
            {
                "id": r[0], "phrase": r[1], "frequency": r[2],
                "confidence": r[3], "first_seen": r[4], "last_seen": r[5],
                "contexts": json.loads(r[6]) if r[6] else [],
                "raw_message_ids": json.loads(r[7]) if r[7] else [],
                "source": r[8], "status": r[9],
            }
            for r in rows
        ]
    except Exception as e:
        return {"error": str(e)}


@app.post("/api/trainer/candidates/{candidate_id}/promote")
async def promote_learning_candidate(candidate_id: int, user: dict = Depends(require_user)):
    """Promote a learning candidate to the knowledge trainer."""
    try:
        row = storage.db.execute(
            "SELECT phrase, contexts, raw_message_ids FROM knowledge_learning_candidates WHERE id = ?",
            (candidate_id,)
        ).fetchone()
        if not row:
            raise HTTPException(404, "Candidate not found")
        phrase, contexts_json, raw_ids_json = row
        contexts = json.loads(contexts_json) if contexts_json else []
        raw_ids = json.loads(raw_ids_json) if raw_ids_json else []
        result = storage.add_trainer_term(
            phrase,
            context=(contexts or [""])[0],
            raw_message_id=(raw_ids or [None])[0],
        )
        if isinstance(result, dict) and "error" in result:
            return {"status": "error", "error": result["error"]}
        # Mark candidate as promoted
        storage.db.execute(
            "UPDATE knowledge_learning_candidates SET status = 'promoted' WHERE id = ?",
            (candidate_id,)
        )
        storage.db.commit()
        return {"status": "promoted", "phrase": phrase}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/api/trainer/inline-resolve")
async def inline_trainer_resolve(request: Request, user: dict = Depends(require_user)):
    """Resolve a term directly from inline selection (bypass trainer queue if possible)."""
    body = await request.json()
    text = body.get("text", "").strip()
    raw_message_id = body.get("raw_message_id")
    status = body.get("status")
    notes = body.get("notes", "")
    if not text or not status:
        raise HTTPException(400, "text and status required")
    if status not in ("building", "society", "landmark", "locality", "combined_locality", "other", "ignored"):
        raise HTTPException(400, "Invalid status")
    existing = storage.db.execute(
        "SELECT id FROM knowledge_trainer WHERE term = ?", (text,)
    ).fetchone()
    if existing:
        term_id = existing[0]
    else:
        # Add to trainer first
        context = ""
        if raw_message_id:
            msg_row = storage.db.execute(
                "SELECT message FROM raw_messages WHERE id = ?", (raw_message_id,)
            ).fetchone()
            if msg_row:
                context = (msg_row[0] or "")[:120]
        result = storage.add_trainer_term(text, context=context, raw_message_id=raw_message_id, force_trainer=True)
        if "error" in result:
            raise HTTPException(500, result["error"])
        term_id = storage.db.execute(
            "SELECT id FROM knowledge_trainer WHERE term = ?", (text,)
        ).fetchone()[0]

    expands_to = body.get("expands_to")
    ok = storage.resolve_trainer_term(term_id, status, "user", notes, expands_to=expands_to)
    return {"status": "ok" if ok else "error", "term": text}


# ── Combined Locality Expansion Rules ─────────────────────────────

@app.get("/api/trainer/combined-localities")
async def list_combined_localities(user: dict = Depends(require_user)):
    """List all combined locality expansion rules."""
    rows = storage.db.execute("""
        SELECT id, surface, expands_to, created_at
        FROM combined_locality_rules
        ORDER BY created_at DESC
    """).fetchall()
    return [
        {
            "id": r[0], "surface": r[1],
            "expands_to": json.loads(r[2]) if r[2] else [],
            "created_at": r[3],
        }
        for r in rows
    ]


# ── Trainer Localities API ────────────────────────────────────────

@app.get("/api/trainer/localities")
async def get_trainer_localities(user: dict = Depends(require_user)):
    """Get known localities for the combined locality dialog."""
    rows = storage.db.execute("""
        SELECT canonical, COUNT(*) as cnt
        FROM knowledge_aliases
        WHERE entity_type = 'market'
        GROUP BY canonical
        ORDER BY cnt DESC
    """).fetchall()
    return {
        "localities": [
            {"name": r[0], "count": r[1]}
            for r in rows
        ]
    }


# ── Knowledge Records API ────────────────────────────────────────

@app.get("/api/knowledge/records")
async def get_knowledge_records(
    limit: int = 100,
    offset: int = 0,
    q: str | None = None,
    content_type: str | None = None,
    user: dict = Depends(require_user),
):
    """Get knowledge records with optional filtering."""
    return storage.get_knowledge_records(limit=limit, offset=offset, q=q, content_type=content_type)

@app.get("/api/knowledge/search")
async def search_knowledge(
    q: str,
    limit: int = 20,
    offset: int = 0,
    content_type: str | None = None,
    user: dict = Depends(require_user),
):
    """Search knowledge records using FTS5."""
    return storage.search_knowledge_records(q, limit=limit, offset=offset, content_type=content_type)

@app.get("/api/knowledge/stats")
async def get_knowledge_stats(user: dict = Depends(require_user)):
    """Get knowledge records statistics."""
    return storage.get_knowledge_stats()

@app.get("/api/knowledge/embeddings/stats")
async def get_embedding_stats(user: dict = Depends(require_user)):
    """Get embedding statistics."""
    return storage.get_embedding_stats()

@app.post("/api/knowledge/embeddings/embed-all")
async def embed_all_records(user: dict = Depends(require_user)):
    """Generate embeddings for all knowledge records."""
    from knowledge.embedder import get_embedder
    embedder = get_embedder(storage.db)
    count = embedder.embed_all_records()
    return {"status": "ok", "embedded": count}

@app.get("/api/knowledge/search/semantic")
async def semantic_search(q: str, limit: int = 10, user: dict = Depends(require_user)):
    """Search knowledge records using semantic similarity."""
    return storage.search_knowledge_with_embeddings(q, limit=limit)

@app.post("/api/knowledge/classify")
async def classify_records(request: Request, user: dict = Depends(require_user)):
    """Classify unclassified knowledge records using AI."""
    from knowledge.classifier import classify_and_store
    body = await request.json() if request.headers.get("content-type") == "application/json" else {}
    limit = body.get("limit", 50)
    result = classify_and_store(storage.db, limit=limit)
    return {"status": "ok", **result}

@app.post("/api/knowledge/classify/single")
async def classify_single(request: Request, user: dict = Depends(require_user)):
    """Classify a single message."""
    from knowledge.classifier import classify
    body = await request.json()
    message = body.get("message", "")
    if not message:
        raise HTTPException(400, "message required")
    return classify(message)

@app.get("/api/knowledge/intelligence")
async def get_intelligence_report(user: dict = Depends(require_user)):
    """Generate a full intelligence report."""
    from knowledge.intelligence import get_engine
    engine = get_engine(storage.db)
    return engine.generate_full_report()

@app.get("/api/knowledge/intelligence/digest")
async def get_daily_digest(days: int = 7, user: dict = Depends(require_user)):
    """Get daily digest of market activity."""
    from knowledge.intelligence import get_engine
    engine = get_engine(storage.db)
    return engine.get_daily_digest(days=days)

@app.get("/api/knowledge/intelligence/prices")
async def get_price_insights(user: dict = Depends(require_user)):
    """Get price insights and patterns."""
    from knowledge.intelligence import get_engine
    engine = get_engine(storage.db)
    return engine.get_price_insights()

@app.get("/api/knowledge/intelligence/coverage")
async def get_market_coverage(user: dict = Depends(require_user)):
    """Get market coverage analysis."""
    from knowledge.intelligence import get_engine
    engine = get_engine(storage.db)
    return engine.get_market_coverage()

@app.get("/api/knowledge/intelligence/brokers")
async def get_broker_insights(user: dict = Depends(require_user)):
    """Get broker activity insights."""
    from knowledge.intelligence import get_engine
    engine = get_engine(storage.db)
    return engine.get_broker_insights()

@app.get("/api/knowledge/intelligence/anomalies")
async def get_anomalies(user: dict = Depends(require_user)):
    """Detect anomalies in the data."""
    from knowledge.intelligence import get_engine
    engine = get_engine(storage.db)
    return engine.get_anomalies()

@app.get("/api/knowledge/intelligence/actionable")
async def get_actionable_insights(user: dict = Depends(require_user)):
    """Get actionable insights for the broker."""
    from knowledge.intelligence import get_engine
    engine = get_engine(storage.db)
    return engine.get_actionable_insights()

@app.get("/api/knowledge/aliases")
async def get_knowledge_aliases(entity_type: str | None = None, limit: int = 100, user: dict = Depends(require_user)):
    """Get knowledge aliases."""
    if entity_type:
        rows = storage.db.execute("""
            SELECT alias, canonical, entity_type, confidence, source, intel
            FROM knowledge_aliases
            WHERE entity_type = ?
            ORDER BY confidence DESC
            LIMIT ?
        """, (entity_type, limit)).fetchall()
    else:
        rows = storage.db.execute("""
            SELECT alias, canonical, entity_type, confidence, source, intel
            FROM knowledge_aliases
            ORDER BY confidence DESC
            LIMIT ?
        """, (limit,)).fetchall()

    result = []
    for r in rows:
        item = {"alias": r[0], "canonical": r[1], "entity_type": r[2], "confidence": r[3], "source": r[4]}
        item["intel"] = (json.loads(r[5]) if r[5] and r[5] != "{}" else None) if len(r) > 5 else None
        result.append(item)
    return result

@app.post("/api/knowledge/aliases")
async def add_knowledge_alias(request: Request, user: dict = Depends(require_user)):
    """Add a knowledge alias."""
    body = await request.json()
    alias = body.get("alias")
    canonical = body.get("canonical")
    entity_type = body.get("entity_type")
    if not alias or not canonical or not entity_type:
        raise HTTPException(400, "alias, canonical, and entity_type required")
    ok = storage.add_knowledge_alias(alias, canonical, entity_type, source="user")
    return {"status": "ok" if ok else "error"}

@app.get("/api/knowledge/learning-cards")
async def get_learning_cards(status: str = "pending", limit: int = 100, user: dict = Depends(require_user)):
    """Get learning cards."""
    return storage.get_learning_cards(status=status, limit=limit)

@app.post("/api/knowledge/learning-cards/{card_id}/resolve")
async def resolve_learning_card(card_id: int, request: Request, user: dict = Depends(require_user)):
    """Resolve a learning card."""
    body = await request.json()
    resolved_type = body.get("resolved_type")
    resolved_value = body.get("resolved_value")
    if not resolved_type or not resolved_value:
        raise HTTPException(400, "resolved_type and resolved_value required")
    ok = storage.resolve_learning_card(card_id, resolved_type, resolved_value, "user")
    return {"status": "ok" if ok else "error"}

@app.get("/api/knowledge/alias-intel/{alias}")
async def get_entity_intel(alias: str, user: dict = Depends(require_user)):
    """Get aggregated intel for a specific entity alias."""
    intel = storage.get_entity_intel(alias)
    if intel is None:
        raise HTTPException(404, "Alias not found or no intel available")
    row = storage.db.execute(
        "SELECT alias, canonical, entity_type, source, created_at FROM knowledge_aliases WHERE alias = ?",
        (alias.lower(),),
    ).fetchone()
    return {
        "alias": row[0] if row else alias,
        "canonical": row[1] if row else alias,
        "entity_type": row[2] if row else "unknown",
        "source": row[3] if row else "",
        "created_at": row[4] if row else "",
        "intel": intel,
    }

@app.get("/api/knowledge/{record_id}")
async def get_knowledge_record(record_id: int, user: dict = Depends(require_user)):
    """Get a single knowledge record."""
    record = storage.get_knowledge_record(record_id)
    if not record:
        raise HTTPException(404, "Record not found")
    return record

@app.patch("/api/knowledge/{record_id}")
async def update_knowledge_record(record_id: int, request: Request, user: dict = Depends(require_user)):
    """Update a knowledge record."""
    body = await request.json()
    ok = storage.update_knowledge_record(record_id, body)
    return {"status": "ok" if ok else "error"}


# ── WhatsApp Audit ────────────────────────────────────────────────

def _group_jid_to_name(jid: str) -> str:
    """Resolve a JID to its human-readable name from sync_jobs."""
    value = str(jid or "")
    if not value:
        return "Unknown"
    try:
        if _table_exists("sync_jobs"):
            row = storage.db.execute(
                "SELECT group_name FROM sync_jobs WHERE group_id = ? AND group_name IS NOT NULL AND group_name != '' LIMIT 1",
                (value,),
            ).fetchone()
            if row:
                return row[0]
    except Exception:
        pass
    try:
        if _table_exists("source_sync_jobs"):
            row = storage.db.execute(
                "SELECT group_name FROM source_sync_jobs WHERE group_id = ? AND group_name IS NOT NULL AND group_name != '' LIMIT 1",
                (value,),
            ).fetchone()
            if row:
                return row[0]
    except Exception:
        pass
    if "@" not in value:
        return value[:80]
    # For group JIDs, try to show a meaningful fallback
    if value.endswith("@g.us"):
        raw = value.split("@")[0]
        suffix = raw[-4:] if len(raw) >= 4 else raw
        return f"WhatsApp Group {suffix}" if suffix else "WhatsApp Group"
    if value.endswith("@s.whatsapp.net") or value.endswith("@lid"):
        raw = value.split("@")[0]
        digits = raw.replace("-", "")
        if len(digits) >= 10:
            return f"+91 {digits[-10:][:5]} {digits[-10:][5:]}"
        return "Unknown Contact"
    return "Unknown"


def _audit_row_value(row, key_or_idx, default=None):
    if row is None:
        return default
    keys = key_or_idx if isinstance(key_or_idx, (tuple, list)) else (key_or_idx,)
    for key in keys:
        try:
            return row[key]
        except Exception:
            continue
    return default


def _audit_scalar(sql: str, params=(), default=0):
    try:
        row = storage.db.execute(sql, params).fetchone()
        if row is None:
            return default
        value = row[0]
        return default if value is None else value
    except Exception as exc:
        print(f"[audit] scalar failed: {exc} :: {sql[:120]}", flush=True)
        return default


def _audit_rows(sql: str, params=()):
    try:
        return storage.db.execute(sql, params).fetchall()
    except Exception as exc:
        print(f"[audit] rows failed: {exc} :: {sql[:120]}", flush=True)
        return []


def _audit_count(table: str) -> int:
    return _count_table(table) if _table_exists(table) else 0


def _audit_timestamp(value) -> str:
    """Return a consistently comparable UTC timestamp for audit read models."""
    if value is None:
        return ""
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return str(value)


def _audit_group_display_name(jid: str) -> str:
    """Format an already-loaded group identifier without another DB query."""
    value = str(jid or "").strip()
    if not value:
        return "Unknown group"
    if "@" not in value:
        return value[:80]
    if value.endswith("@g.us"):
        raw = value.split("@", 1)[0]
        suffix = raw[-4:] if len(raw) >= 4 else raw
        return f"WhatsApp Group {suffix}" if suffix else "WhatsApp Group"
    return "Unknown group"


_AUDIT_BUILDING_LABEL_PATTERN = (
    r'^[[:space:]*_`🏢]*(?:building|bldg(?:[[:space:]]+name)?|'
    r'project(?:[[:space:]]+name)?)[[:space:]*_`]*[:=-]+'
    r'[[:space:]*_`"]*([^\n\r]+)'
)

_AUDIT_BUILDING_PLACEHOLDERS = {
    "brand new",
    "brand new building",
    "building",
    "call",
    "details on request",
    "new",
    "new building",
    "on call",
    "please call",
    "preferably new",
    "well maintained",
}


def _clean_audit_building_name(value: str | None) -> str | None:
    """Keep only credible names from explicit Building/Project labels."""
    name = re.sub(r"\s+", " ", str(value or "")).strip()
    name = re.sub(r"^[\s:;,\-–—*_`\"'“”‘’]+", "", name)
    name = re.sub(r"[\s:;,*_`\"'“”‘’]+$", "", name).strip()
    if not 3 <= len(name) <= 80 or not re.search(r"[A-Za-z]", name):
        return None

    comparison = re.sub(r"[^a-z0-9]+", " ", name.casefold()).strip()
    if comparison in _AUDIT_BUILDING_PLACEHOLDERS:
        return None
    if re.search(
        r"\b(?:available|bhk|budget|call|carpet|details?|floor|furnished|"
        r"lease|maintained|parking|photo|possession|preferably|rent|request|"
        r"sale|sqft|video)\b",
        comparison,
    ):
        return None
    if re.fullmatch(r"[a-z0-9]+ wing", comparison):
        return None
    return name


def _audit_buildings_for_group(
    tenant_id: str,
    jid: str,
    group_name: str,
    limit: int = 20,
) -> list[dict]:
    """Count conservative building mentions directly from source messages."""
    rows = _audit_rows(
        """
        SELECT building_match[1] AS building_name, COUNT(*) AS occurrences
        FROM raw_messages r
        CROSS JOIN LATERAL regexp_matches(
            COALESCE(r.message, ''), ?, 'gim'
        ) AS building_match
        WHERE r.tenant_id = ? AND (r.group_name = ? OR r.group_name = ?)
        GROUP BY building_match[1]
        ORDER BY occurrences DESC
        LIMIT 500
        """,
        (_AUDIT_BUILDING_LABEL_PATTERN, tenant_id, jid, group_name),
    )

    aggregated: dict[str, dict] = {}
    for row in rows:
        name = _clean_audit_building_name(
            _audit_row_value(row, ("building_name", 0), "")
        )
        if not name:
            continue
        key = re.sub(r"[^a-z0-9]+", " ", name.casefold()).strip()
        occurrences = int(_audit_row_value(row, ("occurrences", 1), 0) or 0)
        current = aggregated.setdefault(
            key, {"building_name": name, "occurrences": 0}
        )
        current["occurrences"] += occurrences

    return sorted(
        aggregated.values(),
        key=lambda item: (-item["occurrences"], item["building_name"].casefold()),
    )[:limit]

@app.get("/api/audit/dashboard")
async def audit_dashboard(user: dict = Depends(require_user)):
    now = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    today_start = datetime.utcnow().strftime("%Y-%m-%dT00:00:00Z")
    five_min_ago = (datetime.utcnow() - timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%SZ")
    day_ago = (datetime.utcnow() - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ")

    def _scalar(sql: str, params=(), default=0):
        try:
            row = storage.db.execute(sql, params).fetchone()
            if row is None:
                return default
            return row[0]
        except Exception:
            return default

    total_groups = _scalar("SELECT COUNT(DISTINCT group_name) FROM raw_messages")
    live_groups = _scalar("SELECT COUNT(DISTINCT group_name) FROM raw_messages WHERE created_at >= ?", (five_min_ago,))
    msgs_today = _scalar("SELECT COUNT(*) FROM raw_messages WHERE created_at >= ?", (today_start,))
    last_msg = _scalar("SELECT MAX(created_at) FROM raw_messages", default=None)

    duplicate_groups = _scalar("""
        SELECT COUNT(*) FROM (
            SELECT group_name FROM raw_messages
            WHERE group_name IS NOT NULL AND group_name != ''
            GROUP BY group_name
            HAVING COUNT(*) > 1
        )
    """)

    inactive_count = _scalar("""
        SELECT COUNT(*) FROM (
            SELECT group_name FROM raw_messages
            GROUP BY group_name
            HAVING MAX(created_at) < ?
        )
    """, (day_ago,))

    unnamed_count = _scalar("""
        SELECT COUNT(DISTINCT group_name) FROM raw_messages
        WHERE group_name IS NULL OR group_name = ''
    """)
    error_groups = 0

    attention_required = error_groups + inactive_count
    attention_breakdown = {
        "inactive": inactive_count,
        "duplicate": duplicate_groups,
        "unnamed": unnamed_count,
        "error": error_groups,
    }

    groups_discovered = total_groups
    groups_monitored = total_groups

    # Webhook healthy
    webhook_ok = last_msg is not None and last_msg >= five_min_ago

    # Capture health metrics
    failed_events = 0
    pending_enrichment = 0
    pending_ai = 0
    avg_process = None

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
async def audit_timeline(limit: int = 50, user: dict = Depends(require_user)):
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
    """).fetchall()
    for r in enrich_rows:
        events.append(dict(r))

    # AI suggestion events
    sug_rows = storage.db.execute("""
        SELECT 'suggestion' as source, created_at as ts, status as subtype,
               agent, title
        FROM ai_suggestions ORDER BY created_at DESC LIMIT 10
    """).fetchall()
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
async def audit_top_contributors(limit: int = 10, user: dict = Depends(require_user)):
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
def audit_groups_v2(
    q: str = "",
    status: str = "",
    user: dict = Depends(require_user),
    tenant_id: str = Depends(require_tenant),
):
    """Fresh group audit backed by raw_messages and parsed_output only.

    Uses SQL aggregation instead of fetching all rows into Python.
    Returns ~163 rows (one per group) instead of 400K+ rows.
    """
    day_ago = (datetime.utcnow() - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ")
    query = (q or "").strip().lower()

    if not _table_exists("raw_messages"):
        return {
            "groups": [],
            "total_unique_senders": 0,
            "total_unique_participants": 0,
            "total_membership_rows": 0,
            "duplicate_memberships": 0,
            "connected_groups": 0,
            "posting_groups_24h": 0,
            "errors": [],
        }

    has_parsed = _table_exists("parsed_output")
    has_group_members = _table_exists("group_members")
    has_sync_jobs = _table_exists("sync_jobs")
    errors: list[str] = []

    # ── Query 1: aggregate raw_messages by group_name ──
    try:
        rm_rows = _audit_rows(
            "SELECT group_name, COUNT(*) AS messages, "
            "COUNT(DISTINCT sender) AS senders_count, "
            "MAX(created_at) AS last_activity "
            "FROM raw_messages "
            "WHERE tenant_id = ? AND group_name IS NOT NULL AND group_name != '' "
            "GROUP BY group_name",
            (tenant_id,),
        )
    except Exception as exc:
        errors.append(f"raw_messages aggregate failed: {exc}")
        rm_rows = []

    stats: dict[str, dict] = {}
    for row in rm_rows:
        # Supabase's SQL bridge serializes rows through JSONB. JSON object key
        # order is not a SQL column-order contract, so always read by alias.
        gn = _audit_row_value(row, ("group_name", 0), "") or ""
        if not gn:
            continue
        stats[gn] = {
            "messages": int(_audit_row_value(row, ("messages", 1), 0) or 0),
            "senders_count": int(_audit_row_value(row, ("senders_count", 2), 0) or 0),
            "last_activity": _audit_row_value(row, ("last_activity", 3), "") or "",
            "observations": 0, "requirements": 0, "listings": 0,
            "markets_count": 0, "unknown_locations": 0, "identities_count": 0,
        }

    # ── Query 2: aggregate parsed_output by group_name ──
    if has_parsed and stats:
        try:
            po_rows = _audit_rows(
                "SELECT rm.group_name, "
                "COUNT(DISTINCT rm.id) AS observations, "
                "COUNT(DISTINCT CASE WHEN UPPER(po.intent) IN ('BUY','BUYER','REQUIREMENT','RENTAL_SEEKER','TENANT') THEN (po.raw_message_id::text || ':' || COALESCE(po.listing_index, 0)::text) END) AS requirements, "
                "COUNT(DISTINCT CASE WHEN po.id IS NOT NULL AND UPPER(po.intent) NOT IN ('BUY','BUYER','REQUIREMENT','RENTAL_SEEKER','TENANT') THEN (po.raw_message_id::text || ':' || COALESCE(po.listing_index, 0)::text) END) AS listings, "
                "COUNT(DISTINCT CASE WHEN po.micro_market IS NOT NULL AND po.micro_market != '' THEN po.micro_market END) AS markets_count, "
                "COUNT(DISTINCT CASE WHEN (po.location_raw IS NOT NULL AND po.location_raw != '') AND (po.micro_market IS NULL OR po.micro_market = '') THEN (po.raw_message_id::text || ':' || COALESCE(po.listing_index, 0)::text) END) AS unknown_locations, "
                "COUNT(DISTINCT COALESCE(NULLIF(po.broker_name, ''), NULLIF(po.profile_name, ''), NULLIF(rm.sender, ''))) AS identities "
                "FROM parsed_output po "
                "JOIN raw_messages rm ON po.raw_message_id = rm.id "
                "WHERE rm.tenant_id = ? AND rm.group_name IS NOT NULL AND rm.group_name != '' "
                "GROUP BY rm.group_name",
                (tenant_id,),
            )
            for row in po_rows:
                gn = _audit_row_value(row, ("group_name", 0), "") or ""
                if gn not in stats:
                    continue
                g = stats[gn]
                g["observations"] = int(_audit_row_value(row, ("observations", 1), 0) or 0)
                g["requirements"] = int(_audit_row_value(row, ("requirements", 2), 0) or 0)
                g["listings"] = int(_audit_row_value(row, ("listings", 3), 0) or 0)
                g["markets_count"] = int(_audit_row_value(row, ("markets_count", 4), 0) or 0)
                g["unknown_locations"] = int(_audit_row_value(row, ("unknown_locations", 5), 0) or 0)
                g["identities_count"] = int(_audit_row_value(row, ("identities", 6), 0) or 0)
        except Exception as exc:
            errors.append(f"parsed_output aggregate failed: {exc}")

    # ── Query 3: total unique senders across all groups ──
    # Use resolved identities (broker_name > profile_name > sender) to match
    # per-group identities_count and avoid raw JID inflation / deflation.
    total_unique_senders = 0
    try:
        if has_parsed:
            sender_row = _audit_rows(
                "SELECT COUNT(DISTINCT COALESCE(NULLIF(po.broker_name, ''), "
                "NULLIF(po.profile_name, ''), NULLIF(rm.sender, ''))) "
                "AS total_unique_senders "
                "FROM parsed_output po "
                "JOIN raw_messages rm ON po.raw_message_id = rm.id "
                "WHERE rm.tenant_id = ? AND rm.group_name IS NOT NULL AND rm.group_name != ''",
                (tenant_id,),
            )
        else:
            sender_row = _audit_rows(
                "SELECT COUNT(DISTINCT sender) AS total_unique_senders FROM raw_messages "
                "WHERE tenant_id = ? AND group_name IS NOT NULL AND group_name != ''",
                (tenant_id,),
            )
        if sender_row:
            total_unique_senders = int(
                _audit_row_value(sender_row[0], ("total_unique_senders", 0), 0) or 0
            )
    except Exception:
        pass

    total_membership_rows = 0
    total_unique_participants = 0
    duplicate_memberships = 0
    connected_groups = 0
    if has_group_members:
        try:
            member_row = _audit_rows(
                "SELECT COUNT(*) AS total_membership_rows, "
                "COUNT(DISTINCT COALESCE(NULLIF(member_phone, ''), NULLIF(member_jid, ''))) AS total_unique_participants, "
                "COUNT(DISTINCT group_id) AS connected_groups "
                "FROM group_members "
                "WHERE tenant_id = ?",
                (tenant_id,),
            )
            if member_row:
                total_membership_rows = int(_audit_row_value(member_row[0], ("total_membership_rows", 0), 0) or 0)
                total_unique_participants = int(_audit_row_value(member_row[0], ("total_unique_participants", 1), 0) or 0)
                connected_groups = int(_audit_row_value(member_row[0], ("connected_groups", 2), 0) or 0)
                duplicate_memberships = max(0, total_membership_rows - total_unique_participants)
        except Exception as exc:
            errors.append(f"group_members aggregate failed: {exc}")
    elif has_sync_jobs:
        try:
            sync_row = _audit_rows(
                "SELECT COUNT(DISTINCT group_id) AS connected_groups, "
                "COALESCE(SUM(participants), 0) AS total_membership_rows "
                "FROM sync_jobs "
                "WHERE source = ? AND group_id IS NOT NULL AND group_id != ''",
                ("whatsapp",),
            )
            if sync_row:
                connected_groups = int(_audit_row_value(sync_row[0], ("connected_groups", 0), 0) or 0)
                total_membership_rows = int(_audit_row_value(sync_row[0], ("total_membership_rows", 1), 0) or 0)
        except Exception:
            pass
    # Fallback: compute unique participants from raw_messages when group_members is absent
    if not has_group_members and not total_unique_participants:
        try:
            up_row = _audit_rows(
                "SELECT COUNT(DISTINCT sender) AS total_unique_participants FROM raw_messages "
                "WHERE tenant_id = ? AND group_name IS NOT NULL AND group_name != ''",
                (tenant_id,),
            )
            if up_row:
                total_unique_participants = int(
                    _audit_row_value(up_row[0], ("total_unique_participants", 0), 0) or 0
                )
                if not duplicate_memberships and total_membership_rows > total_unique_participants:
                    duplicate_memberships = total_membership_rows - total_unique_participants
        except Exception:
            pass

    groups = []
    for gn, g in stats.items():
        name = _audit_group_display_name(gn)
        messages = g["messages"]
        last_activity = _audit_timestamp(g["last_activity"])
        observations = g["observations"]
        unknown_locations = g["unknown_locations"]
        is_live = bool(last_activity and last_activity >= day_ago)
        coverage = round(((observations - unknown_locations) / max(1, observations)) * 100, 1) if observations else 0
        group_status = "live" if is_live else "inactive"
        health = "healthy" if is_live and unknown_locations == 0 else ("degraded" if is_live else "stale")

        if query and query not in name.lower() and query not in gn.lower():
            continue
        if status == "live" and group_status != "live":
            continue
        if status == "inactive" and group_status != "inactive":
            continue
        if status == "error":
            continue

        groups.append({
            "jid": gn,
            "name": name,
            "status": group_status,
            "health": health,
            "error": "",
            "messages": messages,
            "last_activity": last_activity,
            "observations": observations,
            "listings": g["listings"],
            "requirements": g["requirements"],
            "markets_count": g["markets_count"],
            "unknown_locations": unknown_locations,
            "coverage": coverage,
            "active_brokers": g["identities_count"],
            "senders_count": g["senders_count"],
            "duplicate_pct": 0,
            "parsed": parse_group_name(name),
        })

    posting_groups_24h = sum(1 for group in groups if group["status"] == "live")

    return {
        "groups": groups,
        "total_unique_senders": total_unique_senders,
        "total_unique_participants": total_unique_participants,
        "total_membership_rows": total_membership_rows,
        "duplicate_memberships": duplicate_memberships,
        "connected_groups": connected_groups,
        "posting_groups_24h": posting_groups_24h,
        "errors": errors,
    }


@app.get("/api/audit/groups/{jid}")
async def audit_group_detail(
    jid: str,
    user: dict = Depends(require_user),
    tenant_id: str = Depends(require_tenant),
):
    group_name = _group_jid_to_name(jid)
    lookup_values = (tenant_id, jid, group_name)

    # Raw stats
    raw_info = storage.db.execute("""
        SELECT COUNT(*) as msg_count, MIN(created_at) as first_seen,
               MAX(created_at) as last_seen
        FROM raw_messages
        WHERE tenant_id = ? AND (group_name = ? OR group_name = ?)
    """, lookup_values).fetchone()

    # Observation stats
    obs_rows = storage.db.execute("""
        SELECT p.id, p.intent, p.broker_name, p.building_name, p.micro_market,
               p.bhk, p.price, p.price_unit, p.confidence, r.message, r.timestamp
        FROM parsed_output p
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE r.tenant_id = ? AND (r.group_name = ? OR r.group_name = ?)
        ORDER BY r.created_at DESC LIMIT 50
    """, lookup_values).fetchall()

    # Brokers seen
    broker_count = storage.db.execute("""
        SELECT COUNT(DISTINCT p.broker_name) FROM parsed_output p
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE r.tenant_id = ? AND (r.group_name = ? OR r.group_name = ?)
          AND p.broker_name IS NOT NULL AND p.broker_name != ''
    """, lookup_values).fetchone()[0]

    # Markets seen
    markets = storage.db.execute("""
        SELECT DISTINCT p.micro_market FROM parsed_output p
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE r.tenant_id = ? AND (r.group_name = ? OR r.group_name = ?)
          AND p.micro_market IS NOT NULL AND p.micro_market != ''
        ORDER BY p.micro_market
    """, lookup_values).fetchall()

    # Buildings mentioned — use explicit source labels, not parser guesses.
    buildings = _audit_buildings_for_group(tenant_id, jid, group_name)

    # AI suggestions for this group
    suggestions = storage.db.execute("""
        SELECT s.id, s.agent, s.title, s.description, s.status, s.confidence, s.created_at
        FROM ai_suggestions s
        WHERE s.tenant_id = ?
        ORDER BY s.created_at DESC LIMIT 20
    """, (tenant_id,)).fetchall()

    # Resolver quality
    resolved = storage.db.execute("""
        SELECT COUNT(*) FROM resolver_decisions rd
        JOIN parsed_output p ON p.id = rd.parsed_id
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE r.tenant_id = ? AND (r.group_name = ? OR r.group_name = ?)
          AND rd.method != 'unresolved'
    """, lookup_values).fetchone()[0]

    unresolved = storage.db.execute("""
        SELECT COUNT(*) FROM resolver_decisions rd
        JOIN parsed_output p ON p.id = rd.parsed_id
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE r.tenant_id = ? AND (r.group_name = ? OR r.group_name = ?)
          AND rd.method = 'unresolved'
    """, lookup_values).fetchone()[0]

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
        "buildings": buildings,
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
async def audit_group_timeline(
    jid: str,
    user: dict = Depends(require_user),
    tenant_id: str = Depends(require_tenant),
):
    """Per-group event timeline."""
    events = []
    group_name = _group_jid_to_name(jid)
    lookup_values = (tenant_id, jid, group_name)

    # Messages
    raw_rows = storage.db.execute("""
        SELECT created_at as ts, message_type, SUBSTR(message, 1, 60) as msg_preview
        FROM raw_messages
        WHERE tenant_id = ? AND (group_name = ? OR group_name = ?)
        ORDER BY created_at DESC LIMIT 30
    """, lookup_values).fetchall()
    for r in raw_rows:
        events.append({"ts": r["ts"], "label": "Message received (" + (r["msg_preview"] or "") + ")", "type": "message"})

    # Resolver decisions
    res_rows = storage.db.execute("""
        SELECT rd.created_at as ts, rd.method,
               COALESCE(rd.building_name, rd.landmark_name, rd.street_name, 'location') as resolved_to
        FROM resolver_decisions rd
        JOIN parsed_output p ON p.id = rd.parsed_id
        JOIN raw_messages r ON r.id = p.raw_message_id
        WHERE r.tenant_id = ? AND (r.group_name = ? OR r.group_name = ?)
          AND rd.method != 'unresolved'
        ORDER BY rd.created_at DESC LIMIT 20
    """, lookup_values).fetchall()
    for r in res_rows:
        events.append({"ts": r["ts"], "label": "Resolved: " + (r["resolved_to"] or "location"), "type": "resolve"})

    events.sort(key=lambda e: e.get("ts", ""), reverse=True)
    return events[:50]


@app.get("/api/audit/duplicates")
def audit_duplicates(
    user: dict = Depends(require_user),
    tenant_id: str = Depends(require_tenant),
):
    """Find potential duplicate groups (same or very similar name)."""
    jobs = _audit_rows(
        "SELECT group_name AS group_id, group_name, '' AS error, 'captured' AS status "
        "FROM raw_messages "
        "WHERE tenant_id = ? AND COALESCE(group_name, '') != '' "
        "GROUP BY group_name ORDER BY group_name",
        (tenant_id,),
    )

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


@app.get("/api/audit/group-overlap")
def audit_group_overlap(
    limit: int = 20,
    user: dict = Depends(require_user),
    tenant_id: str = Depends(require_tenant),
):
    """Rank groups by shared senders so users can avoid parsing duplicate groups."""
    if not _table_exists("raw_messages"):
        return {"pairs": [], "groups": []}

    try:
        rows = _audit_rows(
            "SELECT group_name, sender "
            "FROM raw_messages "
            "WHERE COALESCE(group_name, '') != '' "
            "  AND COALESCE(sender, '') != '' "
            "  AND tenant_id = ? "
            "GROUP BY group_name, sender",
            (tenant_id,),
        )
    except Exception as exc:
        return {"pairs": [], "groups": [], "error": str(exc)}

    from collections import defaultdict
    sender_groups: dict[str, set[str]] = defaultdict(set)
    group_senders: dict[str, set[str]] = defaultdict(set)

    for row in rows:
        group_name = str(_audit_row_value(row, ("group_name", 0), "") or "").strip()
        sender = str(_audit_row_value(row, ("sender", 1), "") or "").strip()
        if not group_name or not sender:
            continue
        sender_groups[sender].add(group_name)
        group_senders[group_name].add(sender)

    pair_counts: dict[tuple[str, str], int] = defaultdict(int)
    for groups in sender_groups.values():
        if len(groups) < 2:
            continue
        ordered = sorted(groups)
        for i, a in enumerate(ordered):
            for b in ordered[i + 1:]:
                pair_counts[(a, b)] += 1

    pairs = []
    for (group_a, group_b), shared in pair_counts.items():
        a_total = len(group_senders.get(group_a, set()))
        b_total = len(group_senders.get(group_b, set()))
        if a_total == 0 or b_total == 0:
            continue
        overlap_pct = round((shared / max(1, min(a_total, b_total))) * 100, 1)
        if shared < 2 and overlap_pct < 25:
            continue
        keep_group, skip_group = (group_a, group_b)
        keep_total, skip_total = (a_total, b_total)
        if b_total > a_total or (b_total == a_total and group_b < group_a):
            keep_group, skip_group = group_b, group_a
            keep_total, skip_total = b_total, a_total
        pairs.append({
            "group_a": {"jid": group_a, "name": _audit_group_display_name(group_a), "senders": a_total},
            "group_b": {"jid": group_b, "name": _audit_group_display_name(group_b), "senders": b_total},
            "shared_senders": shared,
            "overlap_pct": overlap_pct,
            "keep": {"jid": keep_group, "name": _audit_group_display_name(keep_group), "senders": keep_total},
            "skip": {"jid": skip_group, "name": _audit_group_display_name(skip_group), "senders": skip_total},
            "reason": "highest sender overlap",
        })

    pairs.sort(key=lambda p: (p["shared_senders"], p["overlap_pct"]), reverse=True)
    return {
        "pairs": pairs[: max(1, min(limit, 50))],
        "groups": [
            {
                "jid": jid,
                "name": _audit_group_display_name(jid),
                "senders": len(senders),
            }
            for jid, senders in sorted(group_senders.items(), key=lambda item: len(item[1]), reverse=True)
        ][: max(1, min(limit, 50))],
    }


@app.get("/api/audit/capture-health")
def audit_capture_health(
    user: dict = Depends(require_user),
    tenant_id: str = Depends(require_tenant),
):
    """Operational diagnostics for the ingestion pipeline."""
    now_dt = datetime.utcnow()
    today_start = now_dt.strftime("%Y-%m-%dT00:00:00Z")
    five_min_ago = (now_dt - timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%SZ")

    errors: list[str] = []
    row = None
    try:
        row = storage.db.execute(
            "WITH scope AS (SELECT ?::uuid AS tenant_id, ?::timestamptz AS today_start) "
            "SELECT "
            "COUNT(*) AS total_raw, "
            "COUNT(*) FILTER (WHERE rm.created_at >= scope.today_start) AS raw_today, "
            "MAX(created_at) AS last_msg, "
            "(SELECT COUNT(DISTINCT raw_message_id) FROM parsed_output WHERE tenant_id = scope.tenant_id) AS total_parsed, "
            "(SELECT COUNT(DISTINCT raw_message_id) FROM parsed_output WHERE tenant_id = scope.tenant_id AND created_at >= scope.today_start) AS parsed_today, "
            "(SELECT COUNT(*) FROM knowledge_records WHERE tenant_id = scope.tenant_id) AS total_kr, "
            "(SELECT COUNT(*) FROM observations WHERE tenant_id = scope.tenant_id) AS total_obs, "
            "(SELECT COUNT(*) FROM observation_evidence WHERE tenant_id = scope.tenant_id) AS total_oe, "
            "(SELECT COUNT(*) FROM brokers WHERE tenant_id = scope.tenant_id) AS total_brokers, "
            "(SELECT COUNT(*) FROM enrichment_jobs WHERE tenant_id = scope.tenant_id AND status = 'pending') AS pending_enrich, "
            "(SELECT COUNT(*) FROM ai_suggestions WHERE tenant_id = scope.tenant_id AND status = 'pending') AS pending_ai "
            "FROM raw_messages rm CROSS JOIN scope WHERE rm.tenant_id = scope.tenant_id "
            "GROUP BY scope.tenant_id, scope.today_start",
            (tenant_id, today_start),
        ).fetchone()
    except Exception as exc:
        errors.append(f"capture metrics unavailable: {exc}")

    total_raw = int(_audit_row_value(row, "total_raw", 0) or 0)
    raw_today = int(_audit_row_value(row, "raw_today", 0) or 0)
    total_parsed = int(_audit_row_value(row, "total_parsed", 0) or 0)
    parsed_today = int(_audit_row_value(row, "parsed_today", 0) or 0)
    total_kr = int(_audit_row_value(row, "total_kr", 0) or 0)
    total_obs = int(_audit_row_value(row, "total_obs", 0) or 0)
    total_oe = int(_audit_row_value(row, "total_oe", 0) or 0)
    total_brokers = int(_audit_row_value(row, "total_brokers", 0) or 0)
    # Fallback: when the brokers table is empty (identity resolution not yet run),
    # count unique resolved identities from parsed_output so "Brokers Overall"
    # is never a misleading zero while data exists.
    if total_brokers == 0:
        try:
            fb = storage.db.execute(
                "SELECT COUNT(DISTINCT COALESCE(NULLIF(po.broker_name, ''), "
                "NULLIF(po.profile_name, ''), NULLIF(rm.sender, ''))) "
                "FROM parsed_output po "
                "JOIN raw_messages rm ON po.raw_message_id = rm.id "
                "WHERE rm.tenant_id = ?",
                (tenant_id,),
            ).fetchone()
            if fb:
                total_brokers = int(fb[0] or 0)
        except Exception:
            pass
    last_msg = _audit_row_value(row, "last_msg")
    pending_enrich = int(_audit_row_value(row, "pending_enrich", 0) or 0)
    pending_ai = int(_audit_row_value(row, "pending_ai", 0) or 0)

    webhook_ok = bool(last_msg and _audit_timestamp(last_msg) >= five_min_ago)
    mins_today = max(1, now_dt.hour * 60 + now_dt.minute)
    msgs_per_min = round(raw_today / mins_today, 1)
    parser_success_rate = round(min(100.0, total_parsed / max(1, total_raw) * 100), 1)

    return {
        "stage": {
            "raw_messages": total_raw,
            "parsed_output": total_parsed,
            "knowledge_records": total_kr,
            "observations": total_obs,
            "observation_evidence": total_oe,
            "brokers": total_brokers,
        },
        "today": {
            "raw_messages": raw_today,
            "parsed_output": parsed_today,
        },
        "msgs_per_min": msgs_per_min,
        "parser_success_rate": parser_success_rate,
        "last_webhook": _audit_timestamp(last_msg) or "never",
        "webhook_ok": webhook_ok,
        "queue_backlog": (pending_enrich or 0) + (pending_ai or 0),
        "pending_enrichment": pending_enrich,
        "pending_ai_suggestions": pending_ai,
        "total_msgs_today": raw_today,
        "total_parsed_today": parsed_today,
        "avg_process_secs": None,
        "errors": errors,
        "degraded": bool(errors),
    }


@app.get("/api/audit/intelligence")
async def audit_intelligence_v2(user: dict = Depends(require_user)):
    """Fresh WhatsApp audit read model backed by current PropAI tables."""
    now_dt = datetime.utcnow()
    today = now_dt.strftime("%Y-%m-%d")
    today_start = now_dt.strftime("%Y-%m-%dT00:00:00Z")
    five_min_ago = (now_dt - timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%SZ")
    day_ago = (now_dt - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ")
    week_ago = (now_dt - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")

    total_raw = _audit_scalar("SELECT COUNT(*) FROM raw_messages WHERE tenant_id = ?", (tenant_id,), 0) if _table_exists("raw_messages") else 0
    total_parsed = _audit_scalar("SELECT COUNT(DISTINCT raw_message_id) FROM parsed_output WHERE tenant_id = ?", (tenant_id,), 0) if _table_exists("parsed_output") else 0
    total_groups = _audit_scalar("SELECT COUNT(DISTINCT group_name) FROM raw_messages WHERE tenant_id = ? AND COALESCE(group_name, '') != ''", (tenant_id,), 0) if _table_exists("raw_messages") else 0
    active_groups_24h = _audit_scalar("SELECT COUNT(DISTINCT group_name) FROM raw_messages WHERE tenant_id = ? AND created_at >= ? AND COALESCE(group_name, '') != ''", (tenant_id, day_ago), 0) if _table_exists("raw_messages") else 0
    msgs_today = _audit_scalar("SELECT COUNT(*) FROM raw_messages WHERE tenant_id = ? AND created_at >= ?", (tenant_id, today_start), 0) if _table_exists("raw_messages") else 0
    parsed_today = _audit_scalar("SELECT COUNT(DISTINCT raw_message_id) FROM parsed_output WHERE tenant_id = ? AND created_at >= ?", (tenant_id, today_start), 0) if _table_exists("parsed_output") else 0
    last_msg = _audit_scalar("SELECT MAX(created_at) FROM raw_messages WHERE tenant_id = ?", (tenant_id,), None) if _table_exists("raw_messages") else None
    webhook_ok = bool(last_msg and str(last_msg) >= five_min_ago)
    parser_success = round(min(100.0, (total_parsed / max(1, total_raw)) * 100), 1)

    knowledge_records = _audit_scalar("SELECT COUNT(*) FROM knowledge_records WHERE tenant_id = ?", (tenant_id,), 0) if _table_exists("knowledge_records") else total_raw
    searchable_records = _audit_count("knowledge_records_fts") or knowledge_records
    embeddings_count = _audit_count("embeddings")
    indexed_records = searchable_records or knowledge_records
    recall_ready_pct = round(min(100.0, (indexed_records / max(1, knowledge_records)) * 100), 1) if knowledge_records else 0

    attachment_count = _audit_scalar("SELECT COUNT(*) FROM raw_messages WHERE tenant_id = ? AND COALESCE(message_type, 'text') != 'text'", (tenant_id,), 0) if _table_exists("raw_messages") else 0
    communities_count = _audit_scalar("SELECT COUNT(DISTINCT group_name) FROM raw_messages WHERE tenant_id = ? AND lower(group_name) LIKE '%community%'", (tenant_id,), 0) if _table_exists("raw_messages") else 0
    broadcast_count = _audit_scalar("""
        SELECT COUNT(DISTINCT group_name) FROM raw_messages
        WHERE tenant_id = ?
          AND (group_name LIKE '%@broadcast'
               OR group_name = 'status@broadcast'
               OR lower(group_name) LIKE '%broadcast%')
    """, (tenant_id,), 0) if _table_exists("raw_messages") else 0
    direct_message_count = _audit_scalar("""
        SELECT COUNT(*) FROM raw_messages
        WHERE tenant_id = ?
          AND (group_name LIKE '%@s.whatsapp.net'
               OR group_name LIKE '%@lid')
    """, (tenant_id,), 0) if _table_exists("raw_messages") else 0

    total_brokers = _audit_scalar("SELECT COUNT(*) FROM brokers WHERE tenant_id = ?", (tenant_id,), 0) if _table_exists("brokers") else 0
    total_jids = _audit_scalar("SELECT COUNT(*) FROM jid_profiles WHERE tenant_id = ?", (tenant_id,), 0) if _table_exists("jid_profiles") else 0
    unique_phones = _audit_scalar("SELECT COUNT(DISTINCT phone) FROM jid_profiles WHERE tenant_id = ? AND phone IS NOT NULL AND phone != ''", (tenant_id,), 0) if _table_exists("jid_profiles") else 0
    named_contacts = _audit_scalar("SELECT COUNT(*) FROM jid_profiles WHERE tenant_id = ? AND COALESCE(display_name, '') NOT IN ('', 'Unknown')", (tenant_id,), 0) if _table_exists("jid_profiles") else 0
    unnamed_contacts = max(0, total_jids - named_contacts)
    new_brokers_today = _audit_scalar("SELECT COUNT(*) FROM brokers WHERE tenant_id = ? AND date(first_seen_at) = ?", (tenant_id, today), 0) if _table_exists("brokers") else 0
    new_brokers_week = _audit_scalar("SELECT COUNT(*) FROM brokers WHERE tenant_id = ? AND first_seen_at >= ?", (tenant_id, week_ago), 0) if _table_exists("brokers") else 0
    recently_active = _audit_scalar("SELECT COUNT(*) FROM brokers WHERE tenant_id = ? AND last_seen_at >= ?", (tenant_id, week_ago), 0) if _table_exists("brokers") else 0
    jids_no_phone = _audit_scalar("SELECT COUNT(*) FROM jid_profiles WHERE tenant_id = ? AND (phone IS NULL OR phone = '')", (tenant_id,), 0) if _table_exists("jid_profiles") else 0

    total_listings = _audit_scalar("SELECT COUNT(*) FROM listings WHERE tenant_id = ?", (tenant_id,), 0) if _table_exists("listings") else 0
    sell_count = _audit_scalar("SELECT COUNT(*) FROM listings WHERE tenant_id = ? AND upper(COALESCE(intent, '')) IN ('SELL','SELLER','SALE','COMMERCIAL_SALE','PRE-LAUNCH')", (tenant_id,), 0) if _table_exists("listings") else 0
    rent_count = _audit_scalar("SELECT COUNT(*) FROM listings WHERE tenant_id = ? AND upper(COALESCE(intent, '')) IN ('RENT','RENTAL','LEASE','COMMERCIAL_RENTAL')", (tenant_id,), 0) if _table_exists("listings") else 0
    commercial_count = _audit_scalar("SELECT COUNT(*) FROM listings WHERE tenant_id = ? AND upper(COALESCE(intent, '')) LIKE '%COMMERCIAL%'", (tenant_id,), 0) if _table_exists("listings") else 0
    total_requirements = _audit_scalar("""
        SELECT COUNT(DISTINCT raw_message_id) FROM parsed_output
        WHERE tenant_id = ? AND upper(COALESCE(intent, '')) IN ('BUY','BUYER','REQUIREMENT','RENTAL_SEEKER','TENANT')
    """, (tenant_id,), 0) if _table_exists("parsed_output") else 0

    markets_observed = _audit_scalar("SELECT COUNT(DISTINCT micro_market) FROM parsed_output WHERE tenant_id = ? AND COALESCE(micro_market, '') != ''", (tenant_id,), 0) if _table_exists("parsed_output") else 0
    buildings_observed = _audit_scalar("SELECT COUNT(*) FROM buildings WHERE tenant_id = ?", (tenant_id,), 0) if _table_exists("buildings") else 0
    buildings_with_data = _audit_scalar("SELECT COUNT(*) FROM buildings WHERE tenant_id = ? AND COALESCE(observed_listings, 0) > 0", (tenant_id,), 0) if _table_exists("buildings") else 0
    developers_observed = _audit_scalar("SELECT COUNT(DISTINCT developer) FROM parsed_output WHERE tenant_id = ? AND COALESCE(developer, '') != ''", (tenant_id,), 0) if _table_exists("parsed_output") else 0
    localities_observed = _audit_scalar("SELECT COUNT(DISTINCT area) FROM parsed_output WHERE tenant_id = ? AND COALESCE(area, '') != ''", (tenant_id,), 0) if _table_exists("parsed_output") else 0
    landmarks_observed = _audit_scalar("SELECT COUNT(DISTINCT landmark_name) FROM parsed_output WHERE tenant_id = ? AND COALESCE(landmark_name, '') != ''", (tenant_id,), 0) if _table_exists("parsed_output") else 0

    latest_records = _audit_rows("""
        SELECT id, created_at, group_name, sender, message
        FROM raw_messages
        WHERE tenant_id = ?
        ORDER BY created_at DESC
        LIMIT 12
    """, (tenant_id,)) if _table_exists("raw_messages") else []

    group_rows = []
    if _table_exists("raw_messages") and _table_exists("parsed_output"):
        group_rows = _audit_rows("""
            SELECT rm.group_name,
                   COUNT(DISTINCT rm.id) AS messages,
                   COUNT(DISTINCT rm.sender) AS unique_senders,
                   MAX(rm.created_at) AS last_seen,
                   COUNT(DISTINCT CASE WHEN po.id IS NOT NULL THEN (po.raw_message_id::text || ':' || COALESCE(po.listing_index, 0)::text) END) AS observations,
                   COUNT(DISTINCT CASE WHEN upper(COALESCE(po.intent, '')) IN ('BUY','BUYER','REQUIREMENT','RENTAL_SEEKER','TENANT') THEN (po.raw_message_id::text || ':' || COALESCE(po.listing_index, 0)::text) END) AS requirements,
                   COUNT(DISTINCT CASE WHEN po.id IS NOT NULL AND upper(COALESCE(po.intent, '')) NOT IN ('BUY','BUYER','REQUIREMENT','RENTAL_SEEKER','TENANT') THEN (po.raw_message_id::text || ':' || COALESCE(po.listing_index, 0)::text) END) AS listings,
                   COUNT(DISTINCT NULLIF(po.micro_market, '')) AS markets,
                   COUNT(DISTINCT NULLIF(po.building_name, '')) AS buildings
            FROM raw_messages rm
            LEFT JOIN parsed_output po ON po.raw_message_id = rm.id
            WHERE rm.tenant_id = ? AND COALESCE(rm.group_name, '') != ''
            GROUP BY rm.group_name
            ORDER BY messages DESC
            LIMIT 20
        """, (tenant_id,))
    elif _table_exists("raw_messages"):
        group_rows = _audit_rows("""
            SELECT group_name, COUNT(*) AS messages, COUNT(DISTINCT sender) AS unique_senders,
                   MAX(created_at) AS last_seen, 0 AS observations, 0 AS requirements,
                   0 AS listings, 0 AS markets, 0 AS buildings
            FROM raw_messages
            WHERE tenant_id = ?
            GROUP BY group_name
            ORDER BY messages DESC
            LIMIT 20
        """, (tenant_id,))

    top_brokers = _audit_rows("""
        SELECT canonical_name, primary_phone, observation_count, listing_count,
               requirement_count, group_count, first_seen_at, last_seen_at
        FROM brokers
        WHERE tenant_id = ?
        ORDER BY observation_count DESC
        LIMIT 15
    """, (tenant_id,)) if _table_exists("brokers") else []

    broker_reach = _audit_rows("""
        SELECT broker_name,
               COUNT(DISTINCT rm.group_name) AS groups,
               COUNT(DISTINCT rm.id) AS observations,
               MIN(rm.created_at) AS first_seen,
               MAX(rm.created_at) AS last_seen
        FROM parsed_output po
        JOIN raw_messages rm ON po.raw_message_id = rm.id
        WHERE rm.tenant_id = ? AND COALESCE(broker_name, '') != ''
        GROUP BY broker_name
        ORDER BY groups DESC, observations DESC
        LIMIT 10
    """, (tenant_id,)) if _table_exists("parsed_output") and _table_exists("raw_messages") else []

    market_stats = _audit_rows("""
        SELECT micro_market,
               COUNT(DISTINCT rm.id) AS total,
               SUM(CASE WHEN upper(COALESCE(intent, '')) NOT IN ('BUY','BUYER','REQUIREMENT','RENTAL_SEEKER','TENANT') THEN 1 ELSE 0 END) AS residential,
               SUM(CASE WHEN upper(COALESCE(intent, '')) LIKE '%COMMERCIAL%' THEN 1 ELSE 0 END) AS commercial,
               COUNT(DISTINCT broker_name) AS brokers
        FROM parsed_output po
        JOIN raw_messages rm ON po.raw_message_id = rm.id
        WHERE rm.tenant_id = ? AND COALESCE(micro_market, '') != ''
        GROUP BY micro_market
        ORDER BY total DESC
        LIMIT 20
    """, (tenant_id,)) if _table_exists("parsed_output") and _table_exists("raw_messages") else []

    top_markets = _audit_rows("""
        SELECT micro_market, COUNT(DISTINCT broker_name) AS brokers
        FROM parsed_output po
        JOIN raw_messages rm ON po.raw_message_id = rm.id
        WHERE rm.tenant_id = ? AND COALESCE(micro_market, '') != ''
        GROUP BY micro_market
        ORDER BY brokers DESC
        LIMIT 10
    """, (tenant_id,)) if _table_exists("parsed_output") and _table_exists("raw_messages") else []

    suggestions = []
    if total_raw == 0:
        suggestions.append({"type": "capture_empty", "message": "No WhatsApp messages captured yet.", "action": "connect_whatsapp", "count": 1})
    if total_parsed and parser_success < 30:
        suggestions.append({"type": "parser_health", "message": "Parser success is low. Review message format issues.", "action": "review_format", "count": total_parsed})
    if unnamed_contacts:
        suggestions.append({"type": "contact_cleanup", "message": f"{unnamed_contacts} WhatsApp identities have no saved name.", "action": "review_unnamed", "count": unnamed_contacts})

    return {
        "network": {
            "total_groups": total_groups,
            "active_groups_24h": active_groups_24h,
            "total_messages": total_raw,
            "knowledge_records": knowledge_records,
            "attachments": attachment_count,
            "communities": communities_count,
            "broadcasts": broadcast_count,
            "direct_messages": direct_message_count,
            "messages_today": msgs_today,
            "parsed_today": parsed_today,
            "parser_success": parser_success,
            "last_message": str(last_msg or "never"),
            "webhook_healthy": webhook_ok,
        },
        "brokers": {
            "total": total_brokers,
            "total_jids": total_jids,
            "unique_phones": unique_phones,
            "named_contacts": named_contacts,
            "unnamed_contacts": unnamed_contacts,
            "new_today": new_brokers_today,
            "new_this_week": new_brokers_week,
            "recently_active": recently_active,
            "jids_no_phone": jids_no_phone,
            "top": [
                {
                    "name": _audit_row_value(r, 0, ""),
                    "phone": _audit_row_value(r, 1, ""),
                    "observations": _audit_row_value(r, 2, 0) or 0,
                    "listings": _audit_row_value(r, 3, 0) or 0,
                    "requirements": _audit_row_value(r, 4, 0) or 0,
                    "groups": _audit_row_value(r, 5, 0) or 0,
                    "first_seen": _audit_row_value(r, 6, ""),
                    "last_seen": _audit_row_value(r, 7, ""),
                }
                for r in top_brokers
            ],
        },
        "cleanup": {"duplicate_phones": [], "duplicate_names": [], "brokers_no_market": 0},
        "listings": {
            "total": total_listings,
            "sell": sell_count,
            "rent": rent_count,
            "commercial": commercial_count,
            "requirements": total_requirements,
        },
        "coverage": {
            "markets": markets_observed,
            "buildings": buildings_observed,
            "buildings_with_data": buildings_with_data,
            "developers": developers_observed,
            "localities": localities_observed,
            "landmarks": landmarks_observed,
            "market_stats": [
                {"name": r[0], "total": r[1] or 0, "residential": r[2] or 0, "commercial": r[3] or 0, "brokers": r[4] or 0}
                for r in market_stats
            ],
            "top_markets": [{"name": r[0], "brokers": r[1] or 0} for r in top_markets],
            "coverage_gaps": [],
        },
        "capture": {
            "status": "connected" if webhook_ok else ("stale" if total_raw else "empty"),
            "last_message": str(last_msg or "never"),
            "messages_captured": total_raw,
            "knowledge_records": knowledge_records,
            "attachments": attachment_count,
            "communities": communities_count,
            "groups": total_groups,
            "broadcasts": broadcast_count,
            "direct_messages": direct_message_count,
            "latest_records": [
                {
                    "id": r[0],
                    "time": str(r[1] or ""),
                    "conversation": _audit_group_display_name(str(r[2] or "")),
                    "sender": str(r[3] or ""),
                    "preview": str(r[4] or "")[:180],
                    "stored": True,
                }
                for r in latest_records
            ],
        },
        "search_coverage": {
            "messages": total_raw,
            "indexed": indexed_records,
            "searchable": searchable_records,
            "embeddings": embeddings_count,
            "recall_ready": recall_ready_pct,
        },
        "learning": {"unknown_terms": 0, "needs_review": 0, "recently_learned": []},
        "groups": [
            {
                "name": _audit_group_display_name(str(r[0] or "")),
                "jid": str(r[0] or ""),
                "messages": r[1] or 0,
                "unique_senders": r[2] or 0,
                "listings": r[6] or 0,
                "requirements": r[5] or 0,
                "markets": r[7] or 0,
                "buildings": r[8] or 0,
                "signal_ratio": round(((r[4] or 0) / max(1, r[1] or 0)) * 100, 1),
                "last_seen": str(r[3] or ""),
            }
            for r in group_rows
        ],
        "broker_reach": [
            {"name": r[0], "groups": r[1] or 0, "observations": r[2] or 0, "first_seen": r[3], "last_seen": r[4]}
            for r in broker_reach
        ],
        "suggestions": suggestions,
    }


@app.get("/api/audit/insights")
def audit_insights(
    user: dict = Depends(require_user),
    tenant_id: str = Depends(require_tenant),
):
    """Compact, tenant-scoped intelligence used by the broker audit dashboard."""
    empty = {
        "daily_flow": [],
        "markets": [],
        "brokers": [],
        "exclusive_members": {},
        "total_unique_brokers": 0,
        "total_broker_appearances": 0,
    }
    try:
        week_ago = (datetime.utcnow() - timedelta(days=6)).strftime("%Y-%m-%dT00:00:00Z")

        flow_rows = _audit_rows(
            "SELECT (rm.created_at)::date AS day, COUNT(DISTINCT rm.id) AS posts, "
            "COUNT(DISTINCT CASE WHEN UPPER(COALESCE(po.intent, '')) IN "
            "('BUY','BUYER','REQUIREMENT','RENTAL_SEEKER','TENANT') THEN (po.raw_message_id::text || ':' || COALESCE(po.listing_index, 0)::text) END) AS requirements, "
            "COUNT(DISTINCT CASE WHEN UPPER(COALESCE(po.intent, '')) NOT IN "
            "('BUY','BUYER','REQUIREMENT','RENTAL_SEEKER','TENANT') THEN (po.raw_message_id::text || ':' || COALESCE(po.listing_index, 0)::text) END) AS listings "
            "FROM raw_messages rm JOIN parsed_output po ON po.raw_message_id = rm.id "
            "WHERE rm.tenant_id = $1 AND rm.created_at >= $2 "
            "GROUP BY (rm.created_at)::date ORDER BY day",
            (tenant_id, week_ago),
        ) if _table_exists("raw_messages") and _table_exists("parsed_output") else []

        market_rows = _audit_rows(
            "SELECT po.micro_market, COUNT(DISTINCT rm.id) AS posts, "
            "COUNT(DISTINCT CASE WHEN UPPER(COALESCE(po.intent, '')) IN "
            "('BUY','BUYER','REQUIREMENT','RENTAL_SEEKER','TENANT') THEN (po.raw_message_id::text || ':' || COALESCE(po.listing_index, 0)::text) END) AS requirements, "
            "COUNT(DISTINCT CASE WHEN UPPER(COALESCE(po.intent, '')) NOT IN "
            "('BUY','BUYER','REQUIREMENT','RENTAL_SEEKER','TENANT') THEN (po.raw_message_id::text || ':' || COALESCE(po.listing_index, 0)::text) END) AS listings, "
            "COUNT(DISTINCT COALESCE(NULLIF(po.broker_phone, ''), NULLIF(po.broker_name, ''), rm.sender)) AS brokers "
            "FROM parsed_output po JOIN raw_messages rm ON po.raw_message_id = rm.id "
            "WHERE rm.tenant_id = $1 AND rm.created_at >= $2 AND COALESCE(po.micro_market, '') != '' "
            "GROUP BY po.micro_market ORDER BY posts DESC LIMIT 8",
            (tenant_id, week_ago),
        ) if _table_exists("raw_messages") and _table_exists("parsed_output") else []

        broker_rows = _audit_rows(
            "SELECT canonical_name, observation_count, listing_count, requirement_count, "
            "group_count, market_count, last_seen_at FROM brokers "
            "WHERE tenant_id = $1 ORDER BY observation_count DESC LIMIT 8",
            (tenant_id,),
        ) if _table_exists("brokers") else []

        exclusive_rows = _audit_rows(
            "WITH memberships AS ("
            "SELECT sender, COUNT(DISTINCT group_name) AS group_count "
            "FROM raw_messages WHERE tenant_id = $1 AND COALESCE(group_name, '') != '' GROUP BY sender), "
            "exclusive AS ("
            "SELECT rm.group_name, COUNT(DISTINCT rm.sender) AS exclusive_members "
            "FROM raw_messages rm JOIN memberships m ON m.sender = rm.sender "
            "WHERE rm.tenant_id = $2 AND m.group_count = 1 GROUP BY rm.group_name) "
            "SELECT group_name, exclusive_members FROM exclusive "
            "ORDER BY exclusive_members DESC LIMIT 12",
            (tenant_id, tenant_id),
        ) if _table_exists("raw_messages") else []

        total_unique_brokers = _audit_scalar(
            "SELECT COUNT(DISTINCT COALESCE(NULLIF(broker_phone, ''), NULLIF(broker_name, ''), rm.sender)) "
            "FROM parsed_output po JOIN raw_messages rm ON po.raw_message_id = rm.id "
            "WHERE rm.tenant_id = $1",
            (tenant_id,),
        ) if _table_exists("parsed_output") else 0
        total_broker_appearances = _audit_scalar(
            "SELECT COUNT(DISTINCT po.raw_message_id || ':' || COALESCE(po.listing_index, 0)) "
            "FROM parsed_output po JOIN raw_messages rm ON po.raw_message_id = rm.id "
            "WHERE rm.tenant_id = $1 AND COALESCE(NULLIF(po.broker_phone, ''), NULLIF(po.broker_name, ''), rm.sender) != ''",
            (tenant_id,),
        ) if _table_exists("parsed_output") else 0

        return {
            "daily_flow": [
                {
                    "date": str(_audit_row_value(r, ("day", 0), "")),
                    "posts": _audit_row_value(r, ("posts", 1), 0) or 0,
                    "requirements": _audit_row_value(r, ("requirements", 2), 0) or 0,
                    "listings": _audit_row_value(r, ("listings", 3), 0) or 0,
                }
                for r in flow_rows
            ],
            "markets": [
                {
                    "name": _audit_row_value(r, ("micro_market", 0), ""),
                    "posts": _audit_row_value(r, ("posts", 1), 0) or 0,
                    "requirements": _audit_row_value(r, ("requirements", 2), 0) or 0,
                    "listings": _audit_row_value(r, ("listings", 3), 0) or 0,
                    "brokers": _audit_row_value(r, ("brokers", 4), 0) or 0,
                }
                for r in market_rows
            ],
            "brokers": [
                {
                    "name": _audit_row_value(r, ("canonical_name", 0), "") or "Unknown broker",
                    "posts": _audit_row_value(r, ("observation_count", 1), 0) or 0,
                    "listings": _audit_row_value(r, ("listing_count", 2), 0) or 0,
                    "requirements": _audit_row_value(r, ("requirement_count", 3), 0) or 0,
                    "groups": _audit_row_value(r, ("group_count", 4), 0) or 0,
                    "markets": _audit_row_value(r, ("market_count", 5), 0) or 0,
                    "last_seen": _audit_timestamp(_audit_row_value(r, ("last_seen_at", 6))),
                }
                for r in broker_rows
            ],
            "exclusive_members": {
                str(_audit_row_value(r, ("group_name", 0), "")): (
                    int(_audit_row_value(r, ("exclusive_members", 1), 0) or 0)
                )
                for r in exclusive_rows
            },
            "total_unique_brokers": int(total_unique_brokers or 0),
            "total_broker_appearances": int(total_broker_appearances or 0),
        }
    except Exception as exc:
        print(f"[audit] insights failed: {exc}", flush=True)
        return empty


@app.get("/api/audit/search-evidence")
def audit_search_evidence(user: dict = Depends(require_user), q: str = ""):
    """Exact evidence summary for a term in captured WhatsApp knowledge."""
    term = (q or "").strip()
    if not term:
        return {
            "query": "",
            "count": 0,
            "first_seen": "",
            "last_seen": "",
            "groups": 0,
            "unique_senders": 0,
            "top_groups": [],
            "recent": [],
        }

    tokens = re.findall(r"[\w]+", term.lower(), flags=re.UNICODE)
    if not tokens:
        return {
            "query": term,
            "count": 0,
            "first_seen": "",
            "last_seen": "",
            "groups": 0,
            "unique_senders": 0,
            "top_groups": [],
            "recent": [],
        }

    filters = " AND ".join(["(message LIKE $%d OR sender LIKE $%d OR group_name LIKE $%d)" % (i * 3 + 1, i * 3 + 2, i * 3 + 3) for i in range(len(tokens))])
    params = [value for token in tokens for value in (f"%{token}%", f"%{token}%", f"%{token}%")]

    summary = storage.db.execute(f"""
        SELECT COUNT(*) AS count,
               MIN(timestamp) AS first_seen,
               MAX(timestamp) AS last_seen,
               COUNT(DISTINCT group_name) AS groups,
               COUNT(DISTINCT COALESCE(NULLIF(sender_phone, ''), NULLIF(sender_jid, ''), sender)) AS unique_senders
        FROM raw_messages
        WHERE {filters}
    """, params).fetchone()

    top_groups = storage.db.execute(f"""
        SELECT group_name, COUNT(*) AS count
        FROM raw_messages
        WHERE {filters}
        GROUP BY group_name
        ORDER BY count DESC
        LIMIT 6
    """, params).fetchall()

    recent = storage.db.execute(f"""
        SELECT id, timestamp, group_name, sender, message
        FROM raw_messages
        WHERE {filters}
        ORDER BY timestamp DESC
        LIMIT 6
    """, params).fetchall()
    return {
        "query": term,
        "count": summary["count"] if summary else 0,
        "first_seen": summary["first_seen"] if summary else "",
        "last_seen": summary["last_seen"] if summary else "",
        "groups": summary["groups"] if summary else 0,
        "unique_senders": summary["unique_senders"] if summary else 0,
        "top_groups": [
            {"name": _group_jid_to_name(r["group_name"]), "count": r["count"]}
            for r in top_groups
        ],
        "recent": [
            {
                "id": r["id"],
                "time": r["timestamp"],
                "conversation": _group_jid_to_name(r["group_name"]),
                "sender": r["sender"],
                "preview": (r["message"] or "")[:180],
            }
            for r in recent
        ],
    }

@app.get("/api/events")
async def event_stream(request: Request, user: dict = Depends(require_user)):
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
    return RedirectResponse(FRONTEND_URL)


@app.get("/health")
async def health():
    return {"status": "ok"}


# ── User Profile ──────────────────────────────────────────────────

@app.get("/api/profile")
async def get_profile(user: dict = Depends(require_user), tenant_id: str | None = Depends(get_tenant_context)):
    profile = storage.get_user_profile(auth_user_id=user.get("id", ""), tenant_id=tenant_id)
    return profile or {}


@app.post("/api/profile")
async def save_profile(body: ProfileUpdate, user: dict = Depends(require_user), tenant_id: str | None = Depends(get_tenant_context)):
    phone = user.get("phone", "")
    profile = storage.save_user_profile(phone, body.model_dump(), auth_user_id=user.get("id", ""), tenant_id=tenant_id)
    if not profile:
        raise HTTPException(500, "Profile could not be saved")
    return profile


@app.get("/api/profile-picture/{jid:path}")
async def get_profile_picture(jid: str, broker_id: str = "", user: dict = Depends(require_user), tenant_id: str | None = Depends(get_tenant_context)):
    """Proxy profile picture URL from the WhatsApp ingestor.  Caches in user_profiles."""
    jid = jid.strip()
    if not jid:
        raise HTTPException(400, "jid is required")

    # Check cache — refresh if older than 6 hours
    cached = storage.get_profile_photo(jid, tenant_id=tenant_id) if hasattr(storage, "get_profile_photo") else None
    if cached and cached.get("profile_photo_url") and cached.get("profile_photo_fetched_at"):
        try:
            fetched_at = datetime.fromisoformat(str(cached["profile_photo_fetched_at"]))
            if (datetime.now(timezone.utc) - fetched_at).total_seconds() < 6 * 3600:
                return {"ok": True, "url": cached["profile_photo_url"], "jid": jid, "cached": True}
        except Exception:
            pass

    # Forward to ingestor
    broker_param = f"&broker_id={broker_id}" if broker_id else ""
    existing_param = f"&existing_id={cached['profile_photo_id']}" if cached and cached.get("profile_photo_id") else ""
    _, resp = await _first_ingestor_response(
        "GET",
        f"/profile-picture?jid={jid}{broker_param}{existing_param}",
        timeout=8,
    )
    if resp is None or resp.status_code >= 400:
        if resp is not None and resp.status_code == 404:
            return {"ok": True, "url": "", "jid": jid, "note": "no_profile_picture"}
        raise HTTPException(502, "Profile picture fetch failed")

    try:
        data = resp.json()
    except Exception:
        raise HTTPException(502, "Invalid response from WhatsApp service")

    if not data.get("ok"):
        raise HTTPException(502, data.get("error", "Profile picture fetch failed"))

    if data.get("unchanged"):
        return {"ok": True, "url": cached["profile_photo_url"] if cached else "", "jid": jid, "cached": True}

    pic_url = data.get("url", "")
    pic_id = data.get("id", "")
    if pic_url:
        storage.update_profile_photo(jid, pic_url, pic_id, tenant_id=tenant_id) if hasattr(storage, "update_profile_photo") else None

    return {"ok": True, "url": pic_url, "jid": jid, "id": pic_id}


@app.get("/api/key")
async def api_key(user: dict = Depends(require_user)):
    key_path = Path(__file__).parent / ".api_key"
    token = key_path.read_text().strip() if key_path.exists() else ""
    return {"key": token, "path": str(key_path)}


# ── Legacy QR routes ─────────────────────────────────────────────

@app.get("/qr")
async def qr_page(user: dict = Depends(require_user)):
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
    <h1>Connect WhatsApp</h1>
    <p class="muted">Open the Connections page in the app to scan the QR code for WhatsApp pairing.</p>
    <div class="row">
      <a class="btn primary" href="/connections">Open Connection Center</a>
      <a class="btn" href="/">Go to App</a>
    </div>
  </div>
</body>
</html>"""
    )


@app.get("/qr/image")
async def qr_image(user: dict = Depends(require_user)):
    return {"error": "qr_in_frontend", "message": "QR is displayed in the app dashboard. Open the Connections page in the PropAI frontend."}


@app.get("/connect")
async def connect_page(user: dict = Depends(require_user)):
    return {"status": "ok", "frontend": f"{FRONTEND_URL}/settings", "message": f"Use the settings page at {FRONTEND_URL}/settings to connect WhatsApp"}


# ── Requirement-Listing Matching ──────────────────────────────────

@app.post("/api/requirements/match")
async def match_requirements(user: dict = Depends(require_user)):
    """Run the matcher to compute requirement-listing matches."""
    total = storage.match_requirements()
    return {"matched": total}


@app.get("/api/requirements/matches/summary")
async def requirement_matches_summary(user: dict = Depends(require_user)):
    """Get match counts for all requirements (for table display)."""
    summary = storage.get_match_summary()
    # Build a lookup dict
    return {str(m["requirement_id"]): {"count": m["match_count"], "best": m["best_score"]} for m in summary}


@app.get("/api/requirements/{req_id}/matches")
async def requirement_matches(req_id: int, limit: int = 20, user: dict = Depends(require_user)):
    """Get matching listings for a specific requirement."""
    matches = storage.get_requirement_matches(req_id, limit=limit)
    return {"requirement_id": req_id, "matches": matches, "count": len(matches)}


# ── Building Alias Engine ────────────────────────────────────────

@app.post("/api/buildings/aliases/discover")
async def discover_building_aliases(min_confidence: float = 0.7, user: dict = Depends(require_user)):
    """Discover new building alias candidates."""
    suggestions = storage.discover_alias_candidates(min_confidence=min_confidence)
    saved = storage.save_alias_suggestions(suggestions)
    return {"discovered": len(suggestions), "saved": saved, "suggestions": suggestions[:20]}


@app.get("/api/buildings/aliases/suggestions")
async def get_alias_suggestions(status: str = "pending", limit: int = 50, user: dict = Depends(require_user)):
    """Get alias suggestions for review."""
    suggestions = storage.get_alias_suggestions(status=status, limit=limit)
    return {"suggestions": suggestions, "count": len(suggestions)}


@app.post("/api/buildings/aliases/{suggestion_id}/review")
async def review_alias_suggestion(suggestion_id: int, approved: bool, user: dict = Depends(require_user)):
    """Approve or reject an alias suggestion."""
    success = storage.review_alias_suggestion(suggestion_id, approved)
    if not success:
        return {"error": "Suggestion not found"}, 404
    return {"success": True, "approved": approved}


@app.get("/api/buildings/aliases/stats")
async def alias_stats(user: dict = Depends(require_user)):
    """Get alias engine statistics."""
    return storage.get_alias_stats()


@app.post("/api/buildings/aliases/normalize")
async def normalize_building_name(name: str, user: dict = Depends(require_user)):
    """Normalize a building name using learned aliases."""
    normalized = storage.normalize_building_name(name)
    return {"original": name, "normalized": normalized, "changed": name != normalized}


def _get_client_store():
    if storage is None:
        raise RuntimeError("Storage is not initialized")
    return storage


@app.get("/api/clients")
async def list_clients(q: str = "", limit: int = 20, user: dict = Depends(require_user)):
    return _get_client_store().get_clients(q)[:limit]


@app.post("/api/clients")
async def create_client(body: dict, user: dict = Depends(require_user)):
    name = body.get("name", "").strip()
    if not name:
        return JSONResponse(status_code=400, content={"error": "name_required"})
    cid = _get_client_store().create_client(name, body.get("phone"), body.get("email"), body.get("notes", ""))
    return {"id": cid, "name": name}


@app.get("/api/clients/{client_id}")
async def get_client(client_id: int, user: dict = Depends(require_user)):
    c = _get_client_store().get_client(client_id)
    if not c:
        return JSONResponse(status_code=404, content={"error": "not_found"})
    c["requirements"] = _get_client_store().get_client_requirements(client_id)
    c["candidates"] = _get_client_store().get_client_candidates(client_id)
    c["aliases"] = _get_client_store().get_client_aliases(client_id)
    c["notes"] = _get_client_store().get_client_notes(client_id)
    return c


@app.put("/api/clients/{client_id}")
async def update_client(client_id: int, body: dict, user: dict = Depends(require_user)):
    _get_client_store().update_client(client_id, **body)
    return {"ok": True}


@app.post("/api/clients/{client_id}/aliases")
async def add_client_alias(client_id: int, body: dict, user: dict = Depends(require_user)):
    alias = str(body.get("alias") or "").strip()
    if not alias:
        return JSONResponse(status_code=400, content={"error": "alias_required"})
    alias_id = _get_client_store().add_client_alias(
        client_id,
        alias,
        source=body.get("source", "manual"),
        confidence=float(body.get("confidence", 1.0)),
    )
    if alias_id is None:
        return JSONResponse(status_code=409, content={"error": "alias_exists_for_another_client"})
    return {"id": alias_id}


@app.get("/api/clients/{client_id}/notes")
async def list_client_notes(client_id: int, active_only: bool = True, limit: int = 100, user: dict = Depends(require_user)):
    return _get_client_store().get_client_notes(client_id, active_only=active_only, limit=max(1, min(limit, 500)))


@app.post("/api/clients/{client_id}/notes")
async def add_client_note(client_id: int, body: dict, user: dict = Depends(require_user)):
    note = str(body.get("body") or "").strip()
    if not note:
        return JSONResponse(status_code=400, content={"error": "body_required"})
    note_id = _get_client_store().add_client_note(
        client_id,
        note,
        note_type=body.get("note_type", "note"),
        source_text=body.get("source_text", ""),
        source_jid=body.get("source_jid", ""),
        source_message_id=body.get("source_message_id", ""),
        confidence=float(body.get("confidence", 1.0)),
        supersedes_note_id=body.get("supersedes_note_id"),
    )
    return {"id": note_id}


@app.put("/api/clients/notes/{note_id}")
async def update_client_note(note_id: int, body: dict, user: dict = Depends(require_user)):
    note = str(body.get("body") or "").strip()
    if not note:
        return JSONResponse(status_code=400, content={"error": "body_required"})
    _get_client_store().update_client_note(
        note_id,
        note,
        note_type=body.get("note_type"),
        is_active=body.get("is_active"),
    )
    return {"ok": True}


@app.post("/api/clients/{client_id}/requirements")
async def add_requirement(client_id: int, body: dict, user: dict = Depends(require_user)):
    intent = body.get("intent", "BUY").upper()
    rid = _get_client_store().add_client_requirement(
        client_id, intent,
        bhk=body.get("bhk"),
        price_min=body.get("price_min"),
        price_max=body.get("price_max"),
        micro_market=body.get("micro_market"),
        building_name=body.get("building_name"),
        area_sqft_min=body.get("area_sqft_min"),
        area_sqft_max=body.get("area_sqft_max"),
        furnishing=body.get("furnishing"),
        use_type=body.get("use_type"),
        notes=body.get("notes", ""),
    )
    return {"id": rid}


@app.get("/api/clients/{client_id}/candidates")
async def list_candidates(client_id: int, status: str = None, user: dict = Depends(require_user)):
    rows = _get_client_store().get_client_candidates(client_id, status)
    for row in rows:
        row["availability"] = _get_client_store().estimate_candidate_availability(row)
    return rows


@app.get("/api/my/requirements")
async def list_my_requirements(limit: int = 200, user: dict = Depends(require_user)):
    reqs = _get_client_store().get_all_active_requirements()
    return reqs[:max(1, min(limit, 1000))]


@app.get("/api/my/inventory")
async def list_my_inventory(status: str = "", limit: int = 200, user: dict = Depends(require_user)):
    normalized_status = status.strip() or None
    rows = _get_client_store().get_all_active_candidates(normalized_status, max(1, min(limit, 1000)))
    for row in rows:
        row["availability"] = _get_client_store().estimate_candidate_availability(row)
    return rows


@app.post("/api/clients/{client_id}/candidates")
async def add_candidate(client_id: int, body: dict, user: dict = Depends(require_user)):
    cid = _get_client_store().add_property_candidate(
        client_id,
        listing_id=body.get("listing_id"),
        message_id=body.get("message_id"),
        building_name=body.get("building_name"),
        micro_market=body.get("micro_market"),
        bhk=body.get("bhk"),
        price=body.get("price"),
        price_unit=body.get("price_unit"),
        area_sqft=body.get("area_sqft"),
        furnishing=body.get("furnishing"),
        confidence=body.get("confidence", 0),
        match_breakdown=body.get("match_breakdown"),
        source_text=body.get("source_text", ""),
        notes=body.get("notes", ""),
        source_timestamp=body.get("source_timestamp"),
        availability_status=body.get("availability_status", "unknown"),
    )
    if cid is None:
        return JSONResponse(status_code=409, content={"error": "already_added"})
    return {"id": cid}


@app.put("/api/clients/candidates/{candidate_id}/status")
async def update_candidate_status(candidate_id: int, body: dict, user: dict = Depends(require_user)):
    status = body.get("status", "viewed")
    _get_client_store().update_candidate_status(candidate_id, status)
    return {"ok": True}


@app.put("/api/clients/candidates/{candidate_id}/availability")
async def update_candidate_availability(candidate_id: int, body: dict, user: dict = Depends(require_user)):
    status = body.get("availability_status", "unknown")
    _get_client_store().update_candidate_availability(candidate_id, status, body.get("availability_checked_at"))
    return {"ok": True}


# ── Match Clients ──────────────────────────────────────────────────

@app.post("/api/clients/match")
async def match_clients_to_listing(body: dict, user: dict = Depends(require_user)):
    """Match a listing against all active client requirements."""
    price = body.get("price", 0)
    bhk = body.get("bhk", "")
    micro_market = body.get("micro_market", "")
    area_sqft = body.get("area_sqft", 0)
    building_name = body.get("building_name", "")
    furnishing = body.get("furnishing", "")
    intent = body.get("intent", "")

    requirements = _get_client_store().get_all_active_requirements()
    matches = []

    for req in requirements:
        score = 0
        breakdown = {}

        # Intent match (must match)
        req_intent = (req.get("intent") or "").upper()
        if intent and req_intent and intent.upper() != req_intent:
            continue  # Skip if intent doesn't match

        # BHK match (30%)
        if bhk and req.get("bhk"):
            req_bhk = req["bhk"].replace(" BHK", "").strip()
            msg_bhk = bhk.replace(" BHK", "").strip()
            if req_bhk == msg_bhk:
                score += 30
                breakdown["bhk"] = {"match": True, "score": 30}
            elif abs(int(req_bhk or 0) - int(msg_bhk or 0)) <= 1:
                score += 15
                breakdown["bhk"] = {"match": "close", "score": 15}
            else:
                breakdown["bhk"] = {"match": False, "score": 0}
        else:
            score += 15  # Unknown = partial match
            breakdown["bhk"] = {"match": "unknown", "score": 15}

        # Price match (25%)
        if price and req.get("price_min") is not None and req.get("price_max") is not None:
            if req["price_min"] <= price <= req["price_max"]:
                score += 25
                breakdown["price"] = {"match": True, "score": 25}
            elif price < req["price_min"]:
                ratio = price / req["price_min"] if req["price_min"] else 0
                if ratio >= 0.8:
                    score += 12
                    breakdown["price"] = {"match": "close_low", "score": 12}
                else:
                    breakdown["price"] = {"match": False, "score": 0}
            else:
                ratio = req["price_max"] / price if price else 0
                if ratio >= 0.8:
                    score += 12
                    breakdown["price"] = {"match": "close_high", "score": 12}
                else:
                    breakdown["price"] = {"match": False, "score": 0}
        else:
            score += 12
            breakdown["price"] = {"match": "unknown", "score": 12}

        # Location match (25%)
        if micro_market and req.get("micro_market"):
            if micro_market.lower() == req["micro_market"].lower():
                score += 25
                breakdown["location"] = {"match": True, "score": 25}
            elif micro_market.lower() in (req["micro_market"] or "").lower() or (req["micro_market"] or "").lower() in micro_market.lower():
                score += 15
                breakdown["location"] = {"match": "partial", "score": 15}
            else:
                breakdown["location"] = {"match": False, "score": 0}
        else:
            score += 12
            breakdown["location"] = {"match": "unknown", "score": 12}

        # Area match (10%)
        if area_sqft and (req.get("area_sqft_min") is not None or req.get("area_sqft_max") is not None):
            amin = req.get("area_sqft_min") or 0
            amax = req.get("area_sqft_max") or 99999
            if amin <= area_sqft <= amax:
                score += 10
                breakdown["area"] = {"match": True, "score": 10}
            else:
                breakdown["area"] = {"match": False, "score": 0}
        else:
            score += 5
            breakdown["area"] = {"match": "unknown", "score": 5}

        # Building match (10%)
        if building_name and req.get("building_name"):
            if building_name.lower() == req["building_name"].lower():
                score += 10
                breakdown["building"] = {"match": True, "score": 10}
            else:
                breakdown["building"] = {"match": False, "score": 0}
        else:
            score += 5
            breakdown["building"] = {"match": "unknown", "score": 5}

        matches.append({
            "requirement": req,
            "score": min(score, 100),
            "breakdown": breakdown,
        })

    matches.sort(key=lambda x: x["score"], reverse=True)
    return {"matches": matches[:10]}


# ── Follow-ups ──────────────────────────────────────────────────────

@app.get("/api/follow-ups")
async def list_follow_ups(client_id: int = None, status: str = "pending", user: dict = Depends(require_user)):
    return _get_client_store().get_follow_ups(client_id, status)


@app.post("/api/follow-ups")
async def create_follow_up(body: dict, user: dict = Depends(require_user)):
    fid = _get_client_store().create_follow_up(
        client_id=body.get("client_id"),
        message_id=body.get("message_id"),
        building_name=body.get("building_name"),
        broker_phone=body.get("broker_phone"),
        follow_up_type=body.get("follow_up_type", "call"),
        title=body.get("title", ""),
        notes=body.get("notes", ""),
        due_date=body.get("due_date", ""),
        due_time=body.get("due_time"),
    )
    return {"id": fid}


@app.put("/api/follow-ups/{follow_up_id}/done")
async def complete_follow_up(follow_up_id: int, user: dict = Depends(require_user)):
    _get_client_store().complete_follow_up(follow_up_id)
    return {"ok": True}


# ── AI Context Actions ─────────────────────────────────────────────

@app.post("/api/actions/resolve-building")
async def action_resolve_building(body: dict, user: dict = Depends(require_user)):
    """Resolve a building name from selected text."""
    text = body.get("text", "")
    # Try to extract building name
    import re
    # Look for common patterns: "Building Name", "*Building Name*"
    building_match = re.search(r'(?:^|\n)\s*\*?([A-Z][A-Za-z0-9\s]+?)(?:\*|\n|$)', text)
    building_name = building_match.group(1).strip() if building_match else None

    if not building_name:
        # Try fuzzy match against known buildings
        words = text.split()
        for i in range(len(words)):
            for j in range(i + 2, min(i + 5, len(words) + 1)):
                candidate = " ".join(words[i:j])
                normalized = storage.normalize_building_name(candidate)
                if normalized and normalized != candidate:
                    building_name = normalized
                    break
            if building_name:
                break

    if not building_name:
        return {"resolved": False, "text": text}

    # Look up in buildings table
    row = storage.db.execute(
        "SELECT * FROM buildings WHERE canonical_name = ?", (building_name,)
    ).fetchone()

    # Get aliases
    aliases = storage.db.execute(
        "SELECT alias FROM building_aliases WHERE canonical = ?", (building_name,)
    ).fetchall()

    # Get past listings
    listings = storage.db.execute(
        "SELECT price, bhk, micro_market, furnishing, intent FROM listings WHERE building_name = ? ORDER BY last_seen DESC LIMIT 10",
        (building_name,)
    ).fetchall()

    return {
        "resolved": True,
        "building_name": building_name,
        "details": dict(row) if row else None,
        "aliases": [a[0] for a in aliases],
        "past_listings": [dict(l) for l in listings],
    }


@app.post("/api/actions/forward-to-client")
async def action_forward_to_client(body: dict, user: dict = Depends(require_user)):
    """Generate a clean client-friendly version of selected text."""
    text = body.get("text", "")

    # Clean up the text
    import re
    cleaned = text

    # Remove phone spam patterns
    cleaned = re.sub(r'(?:📞|📱|☎️|tel:?)\s*[\d\s\-\+]+', '', cleaned)
    cleaned = re.sub(r'\d{10,}', '', cleaned)  # Long phone numbers

    # Remove emoji spam (more than 2 consecutive)
    cleaned = re.sub(r'([\U0001f600-\U0001f650]){3,}', '', cleaned)

    # Remove broker signatures
    cleaned = re.sub(r'(?:regards?|thanks?|thank you|best|cheers?)[\s,.*_\-]*$.*', '', cleaned, flags=re.IGNORECASE | re.MULTILINE)

    # Clean up extra whitespace
    cleaned = re.sub(r'\n{3,}', '\n\n', cleaned)
    cleaned = re.sub(r'[ \t]{2,}', ' ', cleaned)

    return {"original": text, "cleaned": cleaned.strip()}


@app.post("/api/actions/summarize")
async def action_summarize(body: dict, user: dict = Depends(require_user)):
    """Summarize selected text using AI."""
    text = body.get("text", "")
    # Use the AI chat engine for summarization
    from ai_chat_engine import get_model_reply, load_data, load_live_data, build_system_prompt
    from lab.config import DOUBLEWORD_API_KEY

    sources = load_data()
    live = load_live_data(getattr(storage, "db", None))
    sources.update(live)

    system_prompt = """You are PropAI. Summarize the following real estate message concisely.
    Extract: Building, Location, Price, BHK, Area, Furnishing, Intent (Buy/Rent/Sell).
    Return as a clean structured summary. No markdown. No extra text."""

    msgs = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": f"Summarize this:\n\n{text}"},
    ]

    try:
        reply = get_model_reply(msgs, sources, api_key=DOUBLEWORD_API_KEY, max_tool_rounds=0)
        return {"summary": reply.content or "Could not summarize."}
    except Exception as e:
        return {"summary": f"Error: {str(e)}"}


@app.post("/api/actions/ask-propai")
async def action_ask_propai(body: dict, user: dict = Depends(require_user)):
    """Ask PropAI about selected text with full context."""
    text = body.get("text", "")
    message_id = body.get("message_id")
    context = body.get("context", {})

    # Build context-enhanced prompt
    prompt = f"""About this message:
{text}

Context:
- Building: {context.get('building_name', 'Unknown')}
- Broker: {context.get('broker_name', 'Unknown')}
- Market: {context.get('micro_market', 'Unknown')}
- Previous messages in this conversation: {context.get('conversation_count', 0)}

What should I know about this?"""

    from ai_chat_engine import get_model_reply, load_data, load_live_data, build_system_prompt
    from lab.config import DOUBLEWORD_API_KEY

    sources = load_data()
    live = load_live_data(getattr(storage, "db", None))
    sources.update(live)

    system_prompt = build_system_prompt(sources)
    msgs = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": prompt},
    ]

    try:
        reply = get_model_reply(msgs, sources, api_key=DOUBLEWORD_API_KEY, max_tool_rounds=2)
        return {"response": reply.content or "Could not process."}
    except Exception as e:
        return {"response": f"Error: {str(e)}"}


# ── Entrypoint ──────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    from lab.config import HOST, PORT
    uvicorn.run("lab.app:app", host=HOST, port=PORT, reload=True)





@app.get("/api/auth/me")
async def auth_me(
    user: dict | None = Depends(get_current_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    if not user:
        return {"authenticated": False}
    orgs = storage.get_user_organizations(user["id"]) if user else []
    return {
        "authenticated": True,
        "user": user,
        "organizations": orgs,
        "active_tenant": tenant_id,
        "is_super_admin": storage.is_super_admin(user["id"]) if user else False,
    }


@app.get("/api/orgs")
async def list_organizations(
    limit: int = 100, offset: int = 0,
    user: dict | None = Depends(get_current_user),
):
    if user and storage.is_super_admin(user["id"]):
        return storage.list_organizations(limit, offset)
    if not user:
        raise HTTPException(401, "Authentication required")
    return storage.get_user_organizations(user["id"])


@app.get("/api/orgs/current")
async def current_organization(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    if not tenant_id:
        raise HTTPException(404, "No organization found")
    org = storage.get_organization(tenant_id)
    if org:
        return org
    orgs = storage.get_user_organizations(user["id"])
    if not orgs:
        raise HTTPException(404, "No organization found")
    return orgs[0]


@app.get("/api/orgs/{org_id}")
async def get_organization(org_id: str, user: dict = Depends(require_user)):
    org = storage.get_organization(org_id)
    if not org:
        raise HTTPException(404, "Organization not found")
    return org


@app.patch("/api/orgs/{org_id}")
async def update_organization(org_id: str, body: dict, user: dict = Depends(require_user)):
    allowed = {"name", "is_active"}
    updates = {k: v for k, v in body.items() if k in allowed}
    if not updates:
        raise HTTPException(400, "No valid fields to update")
    ok = storage.update_organization(org_id, **updates)
    if not ok:
        raise HTTPException(404, "Organization not found")
    return {"ok": True}


@app.get("/api/orgs/{org_id}/members")
async def list_members(org_id: str, user: dict = Depends(require_user)):
    return storage.list_organization_members(org_id)


@app.post("/api/orgs/{org_id}/members")
async def add_member(org_id: str, body: dict, user: dict = Depends(require_user)):
    user_id = body.get("user_id")
    role_id = body.get("role_id")
    if not user_id:
        raise HTTPException(400, "user_id is required")
    result = storage.add_organization_member(org_id, user_id, role_id)
    if not result:
        raise HTTPException(400, "Failed to add member")
    return result


@app.delete("/api/orgs/{org_id}/members/{user_id}")
async def remove_member(org_id: str, user_id: str, user: dict = Depends(require_user)):
    ok = storage.remove_organization_member(org_id, user_id)
    if not ok:
        raise HTTPException(404, "Member not found")
    return {"ok": True}


@app.patch("/api/orgs/{org_id}/members/{user_id}/role")
async def update_member_role(org_id: str, user_id: str, body: dict, user: dict = Depends(require_user)):
    role_id = body.get("role_id")
    if not role_id:
        raise HTTPException(400, "role_id is required")
    ok = storage.update_member_role(org_id, user_id, role_id)
    if not ok:
        raise HTTPException(404, "Member not found")
    return {"ok": True}


@app.get("/api/orgs/{org_id}/roles")
async def list_org_roles(org_id: str, user: dict = Depends(require_user)):
    system_roles = storage.list_roles(org_id=None)
    org_roles = storage.list_roles(org_id=org_id)
    return {"system_roles": system_roles, "org_roles": org_roles}


@app.post("/api/orgs/{org_id}/roles")
async def create_org_role(org_id: str, body: dict, user: dict = Depends(require_user)):
    name = body.get("name")
    slug = body.get("slug")
    if not name or not slug:
        raise HTTPException(400, "name and slug are required")
    result = storage.create_role(org_id, name, slug, body.get("description", ""))
    if not result:
        raise HTTPException(400, "Failed to create role")
    return result


@app.get("/api/roles/{role_id}/permissions")
async def get_role_permissions(role_id: int, user: dict = Depends(require_user)):
    return {"permissions": storage.get_role_permissions(role_id)}


@app.put("/api/roles/{role_id}/permissions")
async def set_role_permissions(role_id: int, body: dict, user: dict = Depends(require_user)):
    keys = body.get("permissions", [])
    if not isinstance(keys, list):
        raise HTTPException(400, "permissions must be a list of keys")
    storage.set_role_permissions(role_id, keys)
    return {"ok": True}


@app.get("/api/permissions")
async def list_all_permissions(user: dict = Depends(require_user)):
    return {"permissions": storage.list_permissions()}


@app.get("/api/orgs/{org_id}/whatsapp")
async def list_org_whatsapp(org_id: str, user: dict = Depends(require_user)):
    active_org_id = _resolve_active_organization_id(user, org_id)
    if org_id != DEFAULT_TENANT_ID and str(org_id) != str(active_org_id) and not storage.is_super_admin(user["id"]):
        raise HTTPException(404, "Organization not found")
    org_id = active_org_id
    return storage.list_org_whatsapp_connections(org_id)


@app.post("/api/orgs/{org_id}/whatsapp")
async def add_org_whatsapp(org_id: str, body: dict, user: dict = Depends(require_user)):
    phone = body.get("phone_number")
    if not phone:
        raise HTTPException(400, "phone_number is required")
    if org_id == DEFAULT_TENANT_ID or not storage.get_organization(org_id):
        org_id = _resolve_active_organization_id(user, org_id)
    await _require_org_permission(user, org_id, "manage_whatsapp")
    count = storage.count_org_phones(org_id)
    if count >= 3:
        raise HTTPException(400, "Maximum 3 phones per organization")
    import uuid as _uuid
    broker_id = f"phone-{_uuid.uuid4().hex[:12]}"
    result = storage.add_org_whatsapp_connection(org_id, phone, body.get("instance_name", ""), broker_id)
    if not result:
        raise HTTPException(400, "Failed to add WhatsApp connection")
    async with httpx.AsyncClient(timeout=10) as client:
        for base_url in _ingestor_urls():
            try:
                resp = await client.post(
                    f"{base_url}/connect?broker_id={broker_id}", headers=_ingestor_auth_headers()
                )
                if resp.status_code == 200:
                    break
            except httpx.RequestError:
                continue
    return result


@app.delete("/api/whatsapp/{conn_id}")
async def remove_org_whatsapp(conn_id: int, user: dict = Depends(require_user)):
    row = storage.get_whatsapp_connection_unscoped(conn_id)
    if not row:
        raise HTTPException(404, "Connection not found")
    await _require_org_permission(user, str(row["organization_id"]), "manage_whatsapp")
    broker_id = row.get("broker_id", "")
    if broker_id:
        async with httpx.AsyncClient(timeout=10) as client:
            for base_url in _ingestor_urls():
                try:
                    await client.post(
                        f"{base_url}/disconnect?broker_id={broker_id}", headers=_ingestor_auth_headers()
                    )
                    break
                except httpx.RequestError:
                    continue
    ok = storage.remove_org_whatsapp_connection(conn_id)
    return {"ok": ok}


@app.get("/api/phones")
async def list_phones(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
    include_live: bool = True,
):
    org_id = _resolve_active_organization_id(user, tenant_id)
    phones = await asyncio.to_thread(storage.list_org_whatsapp_connections, org_id)
    ingestor_statuses = {}
    ingestor_reachable = False
    ingestor_error = ""
    if include_live:
        ingestor_statuses, ingestor_reachable, ingestor_error = await _merged_ingestor_list(timeout=2)
        now = time.time()
        for broker_id, (cached_status, seen_at) in _broker_live_statuses.items():
            if broker_id not in ingestor_statuses and now - seen_at <= 45:
                ingestor_statuses[broker_id] = cached_status
    result = []
    for phone in phones:
        broker_id = phone.get("broker_id", "")
        status = ingestor_statuses.get(broker_id)
        # A successful /list response with no matching session is a known
        # stopped state, not an endlessly pending status check.
        has_live_status = ingestor_reachable or status is not None
        status = status or {}
        result.append({
            **phone,
            "connected": bool(status.get("connected")) if has_live_status else None,
            "connection_state": status.get(
                "connection_state", "stopped" if ingestor_reachable else "unavailable"
            ),
            "phone_number_live": status.get("phone_number") or phone.get("phone_number", ""),
            "display_name": status.get("display_name") or phone.get("instance_name", ""),
            "connected_since": status.get("connected_since", ""),
            "last_message_at": status.get("last_message_at", ""),
            "qr_available": status.get("qr_available", False),
            "total_messages_received": status.get("total_messages_received", 0),
            "live_status_available": has_live_status,
            "live_status_error": "" if has_live_status else ingestor_error,
        })
    return {"phones": result}


@app.post("/api/phones")
async def create_phone(
    body: dict,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    try:
        import uuid as _uuid
        phone_number = body.get("phone_number", "").strip()
        instance_name = body.get("instance_name", "").strip()
        org_id = _resolve_active_organization_id(user, tenant_id)
        await _require_org_permission(user, org_id, "manage_whatsapp")
        existing_phones = await asyncio.to_thread(storage.list_org_whatsapp_connections, org_id)
        if not phone_number:
            placeholder = next((row for row in existing_phones if (
                not str(row.get("phone_number") or "").strip()
                or str(row.get("phone_number") or "").startswith("Unpaired")
            )), None)
            if placeholder:
                updates: dict = {}
                if instance_name and not placeholder.get("instance_name"):
                    updates["instance_name"] = instance_name
                if updates:
                    updated = storage.update_org_whatsapp_connection(placeholder["id"], updates)
                    if updated:
                        placeholder = updated
                broker_id = placeholder.get("broker_id", "")
                if broker_id:
                    await _first_ingestor_response("POST", "/connect", timeout=10, params={"broker_id": broker_id})
                return placeholder
        if len(existing_phones) >= 3:
            raise HTTPException(400, "Maximum 3 phones per organization")
        broker_id = f"phone-{_uuid.uuid4().hex[:12]}"
        if not phone_number:
            phone_number = f"Unpaired:{broker_id}"
        result = storage.add_org_whatsapp_connection(org_id, phone_number, instance_name, broker_id)
        if not result:
            raise HTTPException(400, "Failed to create phone")
        await _first_ingestor_response("POST", "/connect", timeout=10, params={"broker_id": broker_id})
        return result
    except HTTPException:
        raise
    except Exception as e:
        if "unique" in str(e).lower() or "duplicate" in str(e).lower():
            raise HTTPException(400, "A phone with this number already exists in your organization")
        raise HTTPException(500, f"Failed to create phone: {str(e)}")


@app.get("/api/phones/{phone_id}")
async def get_phone(
    phone_id: int,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    org_id = _resolve_active_organization_id(user, tenant_id)
    phone = await _scoped_phone(phone_id, org_id)
    broker_id = phone.get("broker_id", "")
    status = await _best_ingestor_status_for_broker(broker_id, timeout=2)
    has_live_status = bool(status)
    return {
        **phone,
        "connected": bool(status.get("connected")) if has_live_status else None,
        "connection_state": status.get("connection_state", "unknown"),
        "phone_number_live": status.get("phone_number") or phone.get("phone_number", ""),
        "display_name": status.get("display_name") or phone.get("instance_name", ""),
        "connected_since": status.get("connected_since", ""),
        "last_message_at": status.get("last_message_at", ""),
        "qr_available": status.get("qr_available", False),
        "qr": status.get("qr", ""),
        "total_messages_received": status.get("total_messages_received", 0),
        "live_status_available": has_live_status,
    }


@app.patch("/api/phones/{phone_id}")
async def update_phone(
    phone_id: int,
    body: dict,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    org_id = _resolve_active_organization_id(user, tenant_id)
    await _require_org_permission(user, org_id, "manage_whatsapp")
    await _scoped_phone(phone_id, org_id)
    allowed = {"instance_name", "self_chat_enabled"}
    updates = {key: body[key] for key in allowed if key in body}
    if "instance_name" in updates:
        updates["instance_name"] = str(updates["instance_name"]).strip()[:100]
    if "self_chat_enabled" in updates and not isinstance(updates["self_chat_enabled"], bool):
        raise HTTPException(400, "self_chat_enabled must be a boolean")
    if not updates:
        raise HTTPException(400, "No valid fields to update")
    updates["updated_at"] = datetime.now(timezone.utc).isoformat()
    result = await asyncio.to_thread(storage.update_org_whatsapp_connection, phone_id, updates)
    if not result:
        raise HTTPException(404, "Phone not found")
    return result


@app.delete("/api/phones/{phone_id}")
async def delete_phone(
    phone_id: int,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    org_id = _resolve_active_organization_id(user, tenant_id)
    await _require_org_permission(user, org_id, "manage_whatsapp")
    phone = await _scoped_phone(phone_id, org_id)
    broker_id = phone.get("broker_id", "")
    if broker_id:
        _, cleanup_response = await _first_ingestor_response(
            "POST", "/delete-session", timeout=10, params={"broker_id": broker_id}
        )
        # Support a rolling deploy where the API is newer than the ingestor.
        if cleanup_response is not None and cleanup_response.status_code == 404:
            await _first_ingestor_response(
                "POST", "/disconnect", timeout=10, params={"broker_id": broker_id}
            )
    ok = await asyncio.to_thread(storage.remove_org_whatsapp_connection, phone_id)
    if not ok:
        raise HTTPException(500, "Phone could not be removed from the workspace")
    return {"ok": True}


@app.post("/api/phones/{phone_id}/reset")
async def reset_phone(
    phone_id: int,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    org_id = _resolve_active_organization_id(user, tenant_id)
    await _require_org_permission(user, org_id, "manage_whatsapp")
    phone = await _scoped_phone(phone_id, org_id)
    broker_id = phone.get("broker_id", "")
    _, resp = await _first_ingestor_response("POST", "/reset", timeout=10, params={"broker_id": broker_id})
    if resp is not None and resp.status_code == 200:
        return {"ok": True, "message": "Session cleared, QR should appear shortly"}
    raise HTTPException(502, _ingestor_failure_message(resp))


@app.post("/api/phones/{phone_id}/disconnect")
async def disconnect_phone(
    phone_id: int,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    org_id = _resolve_active_organization_id(user, tenant_id)
    await _require_org_permission(user, org_id, "manage_whatsapp")
    phone = await _scoped_phone(phone_id, org_id)
    broker_id = phone.get("broker_id", "")
    _, resp = await _first_ingestor_response("POST", "/disconnect", timeout=10, params={"broker_id": broker_id})
    if resp is not None and resp.status_code == 200:
        return {"ok": True, "message": "Phone disconnected"}
    raise HTTPException(502, _ingestor_failure_message(resp))


@app.post("/api/phones/{phone_id}/connect")
async def connect_phone(
    phone_id: int,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    org_id = _resolve_active_organization_id(user, tenant_id)
    await _require_org_permission(user, org_id, "manage_whatsapp")
    phone = await _scoped_phone(phone_id, org_id)
    broker_id = phone.get("broker_id", "")
    if not broker_id:
        raise HTTPException(400, "Phone is missing broker_id")
    _, resp = await _first_ingestor_response("POST", "/connect", timeout=10, params={"broker_id": broker_id})
    if resp is not None and resp.status_code == 200:
        return resp.json()
    # Never proxy an ingestor 401 as an API 401: the browser would incorrectly
    # refresh the user's Supabase session.  Ingestor failures are dependencies.
    raise HTTPException(502, _ingestor_failure_message(resp))


async def _admin_whatsapp_session(phone: dict, live_status: dict | None = None) -> dict:
    broker_id = str(phone.get("broker_id") or "").strip()
    status: dict = live_status or {}
    if broker_id and live_status is None:
        status = await _best_ingestor_status_for_broker(broker_id, timeout=2)
    return {
        **phone,
        "connected": bool(status.get("connected")),
        "connection_state": status.get("connection_state", "unknown"),
        "phone_number_live": status.get("phone_number") or phone.get("phone_number", ""),
        "display_name": status.get("display_name") or phone.get("instance_name", ""),
        "connected_since": status.get("connected_since", ""),
        "last_message_at": status.get("last_message_at", ""),
        "qr_available": status.get("qr_available", False),
        "total_messages_received": status.get("total_messages_received", 0),
        "live_status_available": bool(status),
    }


@app.get("/api/admin/whatsapp/sessions")
async def admin_list_whatsapp_sessions(user: dict = Depends(require_user)):
    if not await asyncio.to_thread(storage.is_super_admin, user["id"]):
        raise HTTPException(403, "Super admin access required")
    phones = await asyncio.to_thread(storage.list_all_whatsapp_connections)
    statuses, _, _ = await _merged_ingestor_list(timeout=3)
    sessions = [
        await _admin_whatsapp_session(
            phone, statuses.get(str(phone.get("broker_id") or ""), {})
        )
        for phone in phones
    ]
    return {"sessions": sessions}


@app.patch("/api/admin/whatsapp/sessions/{phone_id}")
async def admin_update_whatsapp_session(
    phone_id: int, body: dict, user: dict = Depends(require_user)
):
    if not await asyncio.to_thread(storage.is_super_admin, user["id"]):
        raise HTTPException(403, "Super admin access required")
    phone = await asyncio.to_thread(storage.get_whatsapp_connection_unscoped, phone_id)
    if not phone:
        raise HTTPException(404, "Phone not found")
    allowed = {"instance_name", "is_active", "self_chat_enabled"}
    updates = {key: body[key] for key in allowed if key in body}
    for key in ("is_active", "self_chat_enabled"):
        if key in updates and not isinstance(updates[key], bool):
            raise HTTPException(400, f"{key} must be a boolean")
    if "instance_name" in updates:
        updates["instance_name"] = str(updates["instance_name"]).strip()[:100]
    if not updates:
        raise HTTPException(400, "No valid fields to update")
    updates["updated_at"] = datetime.now(timezone.utc).isoformat()
    result = await asyncio.to_thread(storage.update_org_whatsapp_connection, phone_id, updates)
    if updates.get("is_active") is False:
        broker_id = str(phone.get("broker_id") or "").strip()
        if broker_id:
            await _first_ingestor_response(
                "POST", "/disconnect", timeout=10, params={"broker_id": broker_id}
            )
    return await _admin_whatsapp_session(result or phone)



@app.get("/api/admin/orgs")
async def admin_list_organizations(
    limit: int = 100, offset: int = 0,
    user: dict = Depends(require_user),
):
    if not storage.is_super_admin(user["id"]):
        raise HTTPException(403, "Super admin access required")
    return storage.list_organizations(limit, offset)


@app.get("/api/admin/stats")
async def admin_stats(user: dict = Depends(require_user)):
    if not storage.is_super_admin(user["id"]):
        raise HTTPException(403, "Super admin access required")
    orgs = storage.list_organizations(limit=1000)
    return {
        "total_organizations": len(orgs),
        "total_active": sum(1 for o in orgs if o.get("is_active")),
        "organizations": orgs,
    }


@app.get("/api/admin/super-admins")
async def list_super_admins(user: dict = Depends(require_user)):
    if not storage.is_super_admin(user["id"]):
        raise HTTPException(403, "Super admin access required")
    return storage.list_super_admins()


@app.post("/api/admin/super-admins")
async def add_super_admin_endpoint(body: dict, user: dict = Depends(require_user)):
    if not storage.is_super_admin(user["id"]):
        raise HTTPException(403, "Super admin access required")
    user_id = body.get("user_id")
    if not user_id:
        raise HTTPException(400, "user_id is required")
    result = storage.add_super_admin(user_id, body.get("phone", ""))
    if not result:
        raise HTTPException(400, "Failed to add super admin")
    return result


@app.delete("/api/admin/super-admins/{user_id}")
async def remove_super_admin_endpoint(user_id: str, user: dict = Depends(require_user)):
    if not storage.is_super_admin(user["id"]):
        raise HTTPException(403, "Super admin access required")
    ok = storage.remove_super_admin(user_id)
    if not ok:
        raise HTTPException(404, "Super admin not found")
    return {"ok": True}


# ═══════════════════════════════════════════════════════════════
# Auth & Permission Helpers
# ═══════════════════════════════════════════════════════════════

from fastapi import Header

async def get_current_member(x_team_member_id: int = Header(None)) -> dict:
    if not x_team_member_id:
        # Default to owner if no header provided
        members = storage.list_team_members()
        owner = next((m for m in members if m["role"] == "owner"), None)
        return owner or {"id": 0, "permissions": 1023, "name": "System"}
    
    m = storage.get_team_member(x_team_member_id)
    if not m or not m["is_active"]:
        raise HTTPException(403, "Invalid or inactive team member")
    m["permission_keys"] = storage._perm_keys(m["permissions"])
    return m


def check_permission(member: dict, perm_key: str):
    if perm_key not in member.get("permission_keys", []):
        raise HTTPException(403, f"Missing permission: {perm_key}")


_PERMISSION_DEFS = [
    {"key": "view_inbox", "label": "View Market Inbox"},
    {"key": "reply_whatsapp", "label": "Reply from WhatsApp"},
    {"key": "save_requirements", "label": "Save Requirements"},
    {"key": "save_listings", "label": "Save Listings"},
    {"key": "export_contacts", "label": "Export Contacts"},
    {"key": "view_broker_numbers", "label": "View Broker Numbers"},
    {"key": "add_team_members", "label": "Add Team Members"},
    {"key": "delete_data", "label": "Delete Data"},
    {"key": "ai_actions", "label": "AI Actions"},
    {"key": "bulk_broadcast", "label": "Bulk Broadcast"},
]


@app.get("/api/workspace/permissions")
async def workspace_permissions(user: dict = Depends(require_user)):
    return {"permissions": _PERMISSION_DEFS}


@app.get("/api/workspace/me")
async def workspace_me(member: dict = Depends(get_current_team_member)):
    return member


@app.get("/api/workspace/members")
async def list_team_members(member: dict = Depends(get_current_member)):
    members = storage.list_team_members()
    for m in members:
        m["permission_keys"] = storage._perm_keys(m["permissions"])
    return {"members": members}


@app.get("/api/workspace/members/{member_id}")
async def get_team_member(member_id: int, member: dict = Depends(get_current_member)):
    m = storage.get_team_member(member_id)
    if not m:
        raise HTTPException(404, "Team member not found")
    m["permission_keys"] = storage._perm_keys(m["permissions"])
    return m


@app.post("/api/workspace/members")
async def create_team_member(body: dict, member: dict = Depends(get_current_member)):
    check_permission(member, "add_team_members")
    required = ("name",)
    if not body.get("name"):
        raise HTTPException(400, "name is required")
    m = storage.create_team_member(
        name=body["name"],
        email=body.get("email", ""),
        phone=body.get("phone", ""),
        role=body.get("role", "member"),
        permission_keys=body.get("permission_keys"),
        linked_broker_phone=body.get("linked_broker_phone"),
    )
    return m


@app.put("/api/workspace/members/{member_id}")
async def update_team_member(member_id: int, body: dict, member: dict = Depends(get_current_member)):
    check_permission(member, "add_team_members")
    m = storage.update_team_member(member_id, **body)
    if not m:
        raise HTTPException(404, "Team member not found")
    m["permission_keys"] = storage._perm_keys(m["permissions"])
    return m


@app.delete("/api/workspace/members/{member_id}")
async def deactivate_team_member(member_id: int, member: dict = Depends(get_current_member)):
    check_permission(member, "add_team_members")
    ok = storage.deactivate_team_member(member_id)
    return {"deleted": ok}


# ── Custom Team Roles ─────────────────────────────────────────────

@app.get("/api/workspace/roles")
async def list_team_roles(user: dict = Depends(require_user)):
    return {"roles": storage.list_team_roles()}


@app.post("/api/workspace/roles")
async def create_team_role(body: dict, member: dict = Depends(get_current_member)):
    check_permission(member, "add_team_members")
    name = body.get("name", "").strip()
    if not name:
        raise HTTPException(400, "Role name is required")
    role = storage.create_team_role(name, body.get("permission_keys", []))
    if not role:
        raise HTTPException(500, "Failed to create role")
    return role


@app.put("/api/workspace/roles/{role_id}")
async def update_team_role(role_id: int, body: dict, member: dict = Depends(get_current_member)):
    check_permission(member, "add_team_members")
    role = storage.get_team_role(role_id)
    if not role:
        raise HTTPException(404, "Role not found")
    if role.get("is_system"):
        raise HTTPException(403, "Cannot edit system roles")
    updated = storage.update_team_role(role_id, body.get("name"), body.get("permission_keys"))
    return updated or {"error": "update failed"}


@app.delete("/api/workspace/roles/{role_id}")
async def delete_team_role(role_id: int, member: dict = Depends(get_current_member)):
    check_permission(member, "add_team_members")
    role = storage.get_team_role(role_id)
    if not role:
        raise HTTPException(404, "Role not found")
    if role.get("is_system"):
        raise HTTPException(403, "Cannot delete system roles")
    ok = storage.delete_team_role(role_id)
    return {"deleted": ok}


@app.get("/api/workspace/activity")
async def list_activity(limit: int = 50, offset: int = 0,
                        action: str = None, team_member_id: int = None,
                        member: dict = Depends(get_current_member)):
    rows = storage.list_activity(
        limit=limit, offset=offset,
        action=action, team_member_id=team_member_id
    )
    return {"activity": rows, "limit": limit, "offset": offset}


@app.post("/api/workspace/activity")
async def log_activity(body: dict, member: dict = Depends(get_current_member)):
    if not body.get("action"):
        raise HTTPException(400, "action is required")
    ident = storage.log_activity(
        team_member_id=member["id"],
        action=body["action"],
        target_type=body.get("target_type", ""),
        target_id=body.get("target_id", ""),
        details=body.get("details"),
        ip_address=body.get("ip_address", ""),
    )
    return {"id": ident}


@app.get("/api/workspace/whatsapp-access")
async def list_whatsapp_access(
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    org_id = _resolve_active_organization_id(user, tenant_id)
    await _require_org_permission(user, org_id, "manage_whatsapp")
    rows = await asyncio.to_thread(storage.list_whatsapp_access, org_id)
    return {"access": rows}


@app.put("/api/workspace/whatsapp-access")
async def set_whatsapp_access(
    body: dict,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    org_id = _resolve_active_organization_id(user, tenant_id)
    await _require_org_permission(user, org_id, "manage_whatsapp")
    required = ("team_member_id", "whatsapp_number")
    for k in required:
        if k not in body:
            raise HTTPException(400, f"{k} is required")
    result = storage.set_whatsapp_access(
        team_member_id=body["team_member_id"],
        whatsapp_number=body["whatsapp_number"],
        can_send=body.get("can_send", False),
        can_view_messages=body.get("can_view_messages", True),
        org_id=org_id,
    )
    if not result:
        raise HTTPException(404, "Team member or WhatsApp phone not found")
    return result


@app.get("/api/workspace/chat-assignment")
async def get_chat_assignment(whatsapp_number: str = "", remote_jid: str = "",
                              member: dict = Depends(get_current_member)):
    if not whatsapp_number or not remote_jid:
        raise HTTPException(400, "whatsapp_number and remote_jid are required")
    result = storage.get_chat_assignment(whatsapp_number, remote_jid)
    return result or {"assigned_to": None, "taken_over_by": None}


@app.post("/api/workspace/chat-assignment/assign")
async def assign_chat(body: dict, member: dict = Depends(get_current_member)):
    check_permission(member, "add_team_members")
    required = ("whatsapp_number", "remote_jid", "team_member_id")
    for k in required:
        if k not in body:
            raise HTTPException(400, f"{k} is required")
    result = storage.assign_chat(
        body["whatsapp_number"], body["remote_jid"], body["team_member_id"]
    )
    return result


@app.post("/api/workspace/chat-assignment/take-over")
async def take_over_chat(body: dict, member: dict = Depends(get_current_member)):
    check_permission(member, "reply_whatsapp")
    required = ("whatsapp_number", "remote_jid", "team_member_id")
    for k in required:
        if k not in body:
            raise HTTPException(400, f"{k} is required")
    result = storage.take_over_chat(
        body["whatsapp_number"], body["remote_jid"], body["team_member_id"]
    )
    return result


@app.post("/api/workspace/chat-assignment/release")
async def release_chat(body: dict, member: dict = Depends(get_current_member)):
    check_permission(member, "reply_whatsapp")
    required = ("whatsapp_number", "remote_jid")
    for k in required:
        if k not in body:
            raise HTTPException(400, f"{k} is required")
    result = storage.release_chat(
        body["whatsapp_number"], body["remote_jid"]
    )
    return result or {}


# ── LLM Providers ────────────────────────────────────────────


@app.get("/api/workspace/llm-providers")
async def list_llm_providers(user: dict = Depends(require_user), tenant_id: str | None = Depends(get_tenant_context)):
    providers = storage.get_llm_providers(tenant_id=tenant_id)
    # Mask API keys
    for p in providers:
        if p.api_key and len(p.api_key) > 8:
            p.api_key = p.api_key[:4] + "****" + p.api_key[-4:]
        elif p.api_key:
            p.api_key = "****"
    return {"providers": [asdict(p) for p in providers]}


@app.get("/api/workspace/llm-providers/active")
async def get_active_llm_provider(user: dict = Depends(require_user), tenant_id: str | None = Depends(get_tenant_context)):
    # Return what llm.py is actually using at request time (env-var chain)
    import llm as _llm
    try:
        active = _llm.get_provider_info()
        if active.get("provider_name") and active.get("provider_name") != "none":
            active["source"] = "runtime_env"
            active["source_label"] = "Runtime config (Coolify / env)"
            return active
    except Exception:
        pass
    # Fallback: return DB-stored provider
    provider = storage.get_active_llm_provider(tenant_id=tenant_id)
    if not provider:
        return {"provider_name": "none", "base_url": "", "model_name": "", "source": "none", "source_label": "Unconfigured"}
    if provider.api_key:
        provider.api_key = ""
    data = asdict(provider)
    data["source"] = "database"
    data["source_label"] = "Workspace DB"
    return data


@app.post("/api/workspace/llm-providers")
async def save_llm_provider(body: dict, user: dict = Depends(require_user), tenant_id: str | None = Depends(get_tenant_context)):
    required = ("provider_name",)
    for k in required:
        if k not in body:
            raise HTTPException(400, f"{k} is required")
    api_key = str(body.get("api_key", "") or "")
    # Detect masked/redacted API key and treat as "keep existing"
    if "****" in api_key or "••••" in api_key or "●●●●" in api_key:
        api_key = ""
    provider = LLMProvider(
        id=body.get("id", 0),
        provider_name=str(body.get("provider_name", "")),
        provider_type=str(body.get("provider_type", "openai")),
        api_key=api_key,
        base_url=str(body.get("base_url", "")),
        model_name=str(body.get("model_name", "")),
        is_active=1 if body.get("is_active") else 0,
    )
    provider_id = storage.save_llm_provider(provider, tenant_id=tenant_id)
    return {"id": provider_id}


PROBE_OK_LATENCY_THRESHOLD_MS = 5000


async def _probe_provider(api_key: str, base_url: str, model_name: str, timeout_s: float = 15.0) -> dict:
    """Hit a provider with a tiny 'Respond with exactly: OK' prompt.

    Returns a normalised dict with keys:
        status      → "ok" | "slow" | "timeout" | "http" | "error"
        latency_ms  → integer
        http_status → int | None
        error_kind  → str | None
        error_msg   → str | None
    Never raises. Designed to be called from a background loop and from the
    manual-test endpoint with the same shape so outage evidence and ad-hoc
    tests stay comparable.
    """
    empty = {"status": "error", "latency_ms": 0, "http_status": None,
             "error_kind": "missing_credentials", "error_msg": "no API key"}
    if not api_key or not base_url:
        return empty
    if not model_name:
        return {**empty, "error_kind": "missing_model", "error_msg": "no model configured"}
    url = base_url.rstrip("/") + "/chat/completions"
    payload = {
        "model": model_name,
        "messages": [{"role": "user", "content": "Respond with exactly: OK"}],
        "max_tokens": 10,
    }
    start = time.time()
    try:
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            resp = await client.post(
                url,
                json=payload,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
            )
        latency_ms = int((time.time() - start) * 1000)
        if resp.status_code == 200:
            status = "slow" if latency_ms > PROBE_OK_LATENCY_THRESHOLD_MS else "ok"
            return {"status": status, "latency_ms": latency_ms, "http_status": 200,
                    "error_kind": None, "error_msg": None}
        try:
            detail = resp.json()
        except Exception:
            detail = resp.text[:200]
        msg = f"HTTP {resp.status_code}: {str(detail)[:180]}"
        return {"status": "http", "latency_ms": latency_ms, "http_status": resp.status_code,
                "error_kind": "non_2xx", "error_msg": msg}
    except httpx.TimeoutException:
        latency_ms = int((time.time() - start) * 1000)
        return {"status": "timeout", "latency_ms": latency_ms, "http_status": None,
                "error_kind": "timeout", "error_msg": f"Request timed out after {timeout_s}s"}
    except Exception as exc:
        latency_ms = int((time.time() - start) * 1000)
        return {"status": "error", "latency_ms": latency_ms, "http_status": None,
                "error_kind": type(exc).__name__, "error_msg": str(exc)[:200]}


@app.post("/api/workspace/llm-providers/test")
async def test_llm_provider(body: dict, user: dict = Depends(require_user)):
    api_key = str(body.get("api_key", "") or "")
    base_url = str(body.get("base_url", "") or "")
    model_name = str(body.get("model_name", "") or "")
    result = await _probe_provider(api_key, base_url, model_name)
    success = result["status"] in ("ok", "slow")
    out = {"success": success, "status": result["status"],
           "latency_ms": result["latency_ms"], "latency": round(result["latency_ms"] / 1000.0, 2)}
    if result["http_status"] is not None:
        out["http_status"] = result["http_status"]
    if not success:
        out["error"] = result["error_msg"]
    return out


@app.delete("/api/workspace/llm-providers/{provider_id}")
async def delete_llm_provider(provider_id: int, user: dict = Depends(require_user), tenant_id: str | None = Depends(get_tenant_context)):
    ok = storage.delete_llm_provider(provider_id, tenant_id=tenant_id)
    return {"deleted": ok}


# ═══════════════════════════════════════════════════════════════
# Provider Health (admin outage evidence)
#
# _probe_provider hits a single LLM with a tiny "Respond with exactly: OK"
# prompt and returns a normalised dict {status, latency_ms, http_status,
# error_kind, error_msg}. _provider_probe_loop runs every 60s, probes every
# configured provider across all tenants, and writes the result to
# provider_outage_log. The /admin/providers UI reads from that table.
# ═══════════════════════════════════════════════════════════════

PROVIDER_PROBE_INTERVAL_S = 60
HISTORY_BACKFILL_INTERVAL_S = 6 * 3600  # every 6 hours


async def _run_provider_probe_and_log(provider_row: dict) -> None:
    """Probe one provider row (raw dict from storage) and append to outage log."""
    api_key = provider_row.get("api_key") or ""
    base_url = provider_row.get("base_url") or ""
    model_name = provider_row.get("model_name") or ""
    pid = int(provider_row.get("id") or 0)
    pname = str(provider_row.get("provider_name") or "unknown")
    try:
        result = await _probe_provider(api_key, base_url, model_name, timeout_s=15.0)
    except Exception as exc:
        result = {
            "status": "error",
            "latency_ms": 0,
            "http_status": None,
            "error_kind": type(exc).__name__,
            "error_msg": str(exc)[:200],
        }
    event = ProviderOutageEvent(
        provider_id=pid,
        provider_name=pname,
        provider_type=str(provider_row.get("provider_type") or "unknown"),
        model_name=model_name,
        status=result["status"],
        latency_ms=result["latency_ms"],
        http_status=result["http_status"] or 0,
        error_kind=result["error_kind"] or "",
        error_msg=result["error_msg"] or "",
    )
    try:
        await asyncio.to_thread(storage.insert_provider_outage_event, event)
    except Exception as exc:
        print(f"  [provider-probe] FAILED to log result for {pname} (id={pid}): "
              f"{exc.__class__.__name__}: {str(exc)[:200]}")


async def _provider_probe_loop() -> None:
    """Background loop: every PROVIDER_PROBE_INTERVAL_S, probe every configured
    LLM provider across all tenants. Sleep first so the server has time to
    finish booting before we hit external APIs.
    """
    await asyncio.sleep(10)
    while True:
        try:
            providers = await asyncio.to_thread(storage.list_all_llm_providers)
            if not providers:
                await asyncio.sleep(PROVIDER_PROBE_INTERVAL_S)
                continue
            await asyncio.gather(
                *[_run_provider_probe_and_log(p) for p in providers],
                return_exceptions=True,
            )
        except Exception as exc:
            print(f"  [provider-probe] loop error: {exc.__class__.__name__}: {exc}")
        await asyncio.sleep(PROVIDER_PROBE_INTERVAL_S)


async def _history_backfill_loop() -> None:
    """Periodic background loop: every HISTORY_BACKFILL_INTERVAL_S, ask the
    WhatsApp ingestor to request older messages from WhatsApp for all known
    conversations.  The ingestor calls BuildHistorySyncRequest per chat and
    WhatsApp returns history asynchronously through HistorySync events which
    flow back through /webhook.
    """
    await asyncio.sleep(60)  # let server finish booting
    while True:
        try:
            urls = _ingestor_urls()
            if not urls:
                await asyncio.sleep(HISTORY_BACKFILL_INTERVAL_S)
                continue
            async with httpx.AsyncClient(timeout=45) as client:
                for base_url in urls:
                    try:
                        resp = await client.post(
                            f"{base_url}/history/backfill",
                            params={"broker_id": "default", "limit": 50, "count": 50},
                            headers=_ingestor_auth_headers(),
                        )
                        body = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
                        if resp.status_code < 300 and body.get("ok"):
                            requested = body.get("requested", 0)
                            skipped = body.get("skipped", 0)
                            print(f"  [history-backfill] requested={requested} skipped={skipped} via {base_url}")
                        else:
                            print(f"  [history-backfill] {base_url} returned {resp.status_code}: {body.get('error', body)}")
                    except httpx.RequestError as e:
                        print(f"  [history-backfill] {base_url} unreachable: {e}")
        except Exception as exc:
            print(f"  [history-backfill] loop error: {exc.__class__.__name__}: {exc}")
        await asyncio.sleep(HISTORY_BACKFILL_INTERVAL_S)


def _classify_provider_status(events: list[dict], now_ts: float) -> str:
    """Pure helper: turn a sorted-newest-first event list into a status string.

    Rules (matches /admin/providers UI badges):
      up        → last probe is ok/slow and <= 5 min old
      degraded  → last probe is ok/slow but slow; OR error rate > 20% in last 30 min
      down      → last probe is timeout/http/error; OR no successful probe in last 10 min
      unknown   → no probes in last 30 min
    """
    if not events:
        return "unknown"
    newest = events[0]
    newest_ts = _parse_event_ts(newest)
    age_s = now_ts - newest_ts if newest_ts else 9e9
    if age_s > 1800:
        return "unknown"
    if newest["status"] in ("timeout", "http", "error"):
        return "down"
    if newest["status"] == "slow":
        return "degraded"
    cutoff_30 = now_ts - 1800
    cutoff_10 = now_ts - 600
    recent_30 = [e for e in events if (_parse_event_ts(e) or 0) >= cutoff_30]
    recent_10 = [e for e in events if (_parse_event_ts(e) or 0) >= cutoff_10]
    if recent_10 and not any(e["status"] in ("ok", "slow") for e in recent_10):
        return "down"
    if recent_30:
        failures = sum(1 for e in recent_30 if e["status"] != "ok")
        if failures / max(len(recent_30), 1) > 0.20:
            return "degraded"
    return "up"


def _parse_event_ts(event: dict) -> float | None:
    """Parse an event timestamp (ISO 8601 with timezone) into a Unix epoch."""
    ts = event.get("ts")
    if not ts:
        return None
    try:
        if isinstance(ts, str):
            return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
        return float(ts)
    except Exception:
        return None


def _summarise_provider(events: list[dict], now_ts: float) -> dict:
    """Aggregate events into the dict shape the /admin/providers UI renders."""
    latencies = [int(e.get("latency_ms") or 0) for e in events
                 if e.get("status") in ("ok", "slow")]
    latencies.sort()
    p50 = latencies[len(latencies) // 2] if latencies else 0
    p95 = latencies[int(len(latencies) * 0.95)] if latencies else 0
    status = _classify_provider_status(events, now_ts)
    newest = events[0] if events else {}
    last_error = next((e for e in events if e.get("status") != "ok"), None)
    return {
        "status": status,
        "probe_count": len(events),
        "p50_ms": p50,
        "p95_ms": p95,
        "last_probe_ts": newest.get("ts"),
        "last_status": newest.get("status"),
        "last_latency_ms": int(newest.get("latency_ms") or 0) if newest else 0,
        "last_error": last_error,
    }


def _bucket_history(events: list[dict], bucket_minutes: int = 5,
                    window_hours: int = 24) -> list[dict]:
    """Bin events into time buckets for the 24h timeline strip.

    Returns newest-first list of {ts_bucket, ok_count, fail_count, total}.
    """
    if not events:
        return []
    now_ts = time.time()
    bucket_s = bucket_minutes * 60
    cutoff = now_ts - window_hours * 3600
    bins: dict[int, dict] = {}
    for e in events:
        ts = _parse_event_ts(e)
        if ts is None or ts < cutoff:
            continue
        bucket = int(ts // bucket_s) * bucket_s
        b = bins.setdefault(bucket, {"ts_bucket": bucket, "ok_count": 0, "fail_count": 0, "total": 0})
        b["total"] += 1
        if e.get("status") == "ok":
            b["ok_count"] += 1
        else:
            b["fail_count"] += 1
    return sorted(bins.values(), key=lambda b: -b["ts_bucket"])


@app.get("/api/admin/ai-usage")
async def admin_ai_usage(days: int = 7, user: dict = Depends(require_user)):
    """Super-admin only: AI cost dashboard — who spent what on which model."""
    if not await asyncio.to_thread(storage.is_super_admin, user["id"]):
        raise HTTPException(403, "Super admin only")
    return storage.get_ai_usage_stats(days=min(max(days, 1), 90))


@app.get("/api/admin/providers/health")
async def admin_provider_health(user: dict = Depends(require_user)):
    """Current health per provider: status, p50/p95, last probe, last error.

    Reads the last 30 min of probe results for each configured provider and
    classifies status (up/degraded/down/unknown). Used by /admin/providers.
    """
    providers = await asyncio.to_thread(storage.list_all_llm_providers)
    now_ts = time.time()
    out_providers = []
    worst = "up"
    rank = {"up": 0, "degraded": 1, "unknown": 2, "down": 3}
    # One card per configured row. Multiple rows with the same provider_name
    # (e.g. several NVIDIA keys) each get their own card so a single bad key
    # doesn't hide behind a healthy one. Events are filtered by provider_id so
    # probe rows are never mixed across rows that share a name.
    for prow in providers:
        pid = int(prow.get("id") or 0)
        events = await asyncio.to_thread(
            storage.list_provider_outage_events_by_provider_id, 30, pid, 200
        )
        summary = _summarise_provider(events, now_ts)
        out_providers.append({
            "provider_id": pid,
            "provider_name": str(prow.get("provider_name") or ""),
            "provider_type": str(prow.get("provider_type") or ""),
            "model_name": str(prow.get("model_name") or ""),
            "base_url": str(prow.get("base_url") or ""),
            "is_active": bool(prow.get("is_active")),
            "tenant_id": prow.get("tenant_id"),
            **summary,
        })
        if rank[summary["status"]] > rank[worst]:
            worst = summary["status"]
    return {
        "providers": out_providers,
        "overall": worst,
        "now_ts": now_ts,
    }


@app.get("/api/admin/providers/history")
async def admin_provider_history(user: dict = Depends(require_user),
                                  hours: int = 24, bucket_minutes: int = 5):
    """24h timeline per provider row, bucketed by 5 min.

    Powers the timeline strip in /admin/providers. Each bucket reports
    ok_count, fail_count, total so the UI can colour the cell. Bucketed
    by provider_id (not provider_name) so per-key outages stay distinct
    when several rows share a provider type (NVIDIA x4, etc.).
    """
    if hours not in (1, 6, 24, 168):
        hours = 24
    if bucket_minutes not in (1, 5, 15, 60):
        bucket_minutes = 5
    since_minutes = hours * 60
    events = await asyncio.to_thread(
        storage.list_provider_outage_events, since_minutes, None, 5000
    )
    # Build a per-row series. Keyed by (provider_id, provider_name) so the
    # frontend can match a card to its timeline by provider_id.
    by_row: dict[int, dict] = {}
    for e in events:
        pid = int(e.get("provider_id") or 0)
        if pid not in by_row:
            by_row[pid] = {
                "provider_id": pid,
                "provider_name": e.get("provider_name", "unknown"),
                "events": [],
            }
        by_row[pid]["events"].append(e)
    return {
        "hours": hours,
        "bucket_minutes": bucket_minutes,
        "providers": [
            {
                "provider_id": row["provider_id"],
                "provider_name": row["provider_name"],
                "buckets": _bucket_history(row["events"], bucket_minutes, hours),
            }
            for row in by_row.values()
        ],
    }


@app.post("/api/admin/providers/probe/{provider_id}")
async def admin_provider_probe_now(provider_id: int, user: dict = Depends(require_user)):
    """Manual trigger: probe one provider immediately and append to log.

    Surfaces probe + insert errors to the UI (previously swallowed by a
    print-only except handler, which is why the page showed NO DATA even
    after the user clicked Probe now).
    """
    providers = await asyncio.to_thread(storage.list_all_llm_providers)
    target = next((p for p in providers if int(p.get("id") or 0) == provider_id), None)
    if not target:
        return {"probed": False, "error": f"provider_id {provider_id} not found"}
    api_key = str(target.get("api_key") or "")
    base_url = str(target.get("base_url") or "")
    model_name = str(target.get("model_name") or "")
    result = await _probe_provider(api_key, base_url, model_name, timeout_s=15.0)
    event = ProviderOutageEvent(
        provider_id=provider_id,
        provider_name=str(target.get("provider_name") or "unknown"),
        provider_type=str(target.get("provider_type") or "unknown"),
        model_name=model_name,
        status=result["status"],
        latency_ms=result["latency_ms"],
        http_status=result["http_status"] or 0,
        error_kind=result["error_kind"] or "",
        error_msg=result["error_msg"] or "",
    )
    try:
        new_id = await asyncio.to_thread(storage.insert_provider_outage_event, event)
    except Exception as exc:
        return {"probed": False, "error": f"insert failed: {str(exc)[:200]}",
                "probe_result": result}
    return {"probed": True, "inserted_id": new_id, "probe_result": result}


@app.post("/api/admin/providers/cleanup")
async def admin_provider_cleanup(body: dict, user: dict = Depends(require_user)):
    """Delete outage log rows older than retention_days (default 7)."""
    days = int(body.get("retention_days") or 7)
    if days < 1 or days > 90:
        return {"deleted": 0, "error": "retention_days must be between 1 and 90"}
    deleted = await asyncio.to_thread(storage.cleanup_provider_outage_log, days)
    return {"deleted": deleted, "retention_days": days}


# ═══════════════════════════════════════════════════════════════
# Internal Notes
# ═══════════════════════════════════════════════════════════════

_VALID_NOTE_ENTITY_TYPES = frozenset({"chat", "broker", "building"})


@app.get("/api/notes")
async def list_notes(
    entity_type: str,
    entity_id: str,
    member: dict = Depends(get_current_member),
):
    if entity_type not in _VALID_NOTE_ENTITY_TYPES:
        raise HTTPException(400, f"Invalid entity_type. Must be one of: {', '.join(sorted(_VALID_NOTE_ENTITY_TYPES))}")
    if not entity_id:
        raise HTTPException(400, "entity_id is required")
    rows = storage.db.execute(
        """SELECT n.id, n.entity_type, n.entity_id, n.body, n.mentioned_member_ids,
                  n.created_at, n.updated_at, n.author_id,
                  tm.name AS author_name
           FROM internal_notes n
           LEFT JOIN team_members tm ON tm.id = n.author_id
           WHERE n.entity_type = ? AND n.entity_id = ?
           ORDER BY n.created_at DESC""",
        (entity_type, entity_id),
    ).fetchall()
    return {"notes": [dict(r) for r in rows]}


@app.post("/api/notes")
async def create_note(
    body: dict,
    member: dict = Depends(get_current_member),
):
    entity_type = body.get("entity_type")
    entity_id = body.get("entity_id")
    note_body = body.get("body", "").strip()
    mentioned = body.get("mentioned_member_ids", [])

    if entity_type not in _VALID_NOTE_ENTITY_TYPES:
        raise HTTPException(400, f"Invalid entity_type. Must be one of: {', '.join(sorted(_VALID_NOTE_ENTITY_TYPES))}")
    if not entity_id:
        raise HTTPException(400, "entity_id is required")
    if not note_body:
        raise HTTPException(400, "body is required")

    if not isinstance(mentioned, list):
        mentioned = []

    storage.db.execute(
        """INSERT INTO internal_notes (entity_type, entity_id, author_id, body, mentioned_member_ids)
           VALUES (?, ?, ?, ?, ?::jsonb)""",
        (entity_type, entity_id, member["id"], note_body, json.dumps(mentioned)),
    )
    storage.db.commit()
    return {"ok": True}


@app.get("/api/usage")
async def get_usage(user: dict = Depends(require_user)):
    """System-wide usage stats for the sidebar page."""
    stats = storage.get_stats()
    groups = _count_table("source_sync_jobs")
    chat_sessions = _count_table("ai_chat_sessions")
    chat_messages = _count_table("ai_chat_messages")
    ai_today = _today_count("ai_usage_log")
    messages_today = _today_count("raw_messages", "timestamp")
    last_sync_row = storage.db.execute(
        "SELECT MAX(timestamp) AS ts FROM raw_messages"
    ).fetchone()
    last_sync = last_sync_row["ts"] if last_sync_row else None
    broker_phone = None
    try:
        row = storage.db.execute(
            "SELECT value FROM business_api_config WHERE key = 'whatsapp_business_number'"
        ).fetchone()
        if row and row["value"]:
            broker_phone = row["value"]
    except Exception:
        pass
    return {
        "total_messages": stats.get("total_messages", 0),
        "total_parsed": stats.get("total_parsed", 0),
        "total_listings": stats.get("total_listings", 0),
        "total_requirements": stats.get("total_requirements", 0),
        "total_brokers": stats.get("total_brokers", 0),
        "total_buildings": stats.get("total_buildings", 0),
        "total_groups": groups,
        "total_chat_sessions": chat_sessions,
        "total_chat_messages": chat_messages,
        "ai_requests_today": ai_today,
        "messages_today": messages_today,
        "last_sync": last_sync,
        "broker_phone": broker_phone,
    }


@app.delete("/api/notes/{note_id}")
async def delete_note(
    note_id: int,
    member: dict = Depends(get_current_member),
):
    row = storage.db.execute(
        "SELECT author_id FROM internal_notes WHERE id = ?", (note_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "Note not found")
    if row["author_id"] != member["id"]:
        raise HTTPException(403, "Only the original author can delete this note")
    storage.db.execute("DELETE FROM internal_notes WHERE id = ?", (note_id,))
    storage.db.commit()
    return {"ok": True}


# ── Automated WABA Alerts ─────────────────────────────────────────

async def _check_listing_alerts(listing_data: dict, raw_message_id: int = 0):
    """Check a newly parsed listing against all active client_requirements.
    For each match, send a WABA alert to the broker who owns the requirement.
    Runs as a fire-and-forget background task."""
    try:
        intent = (listing_data.get("intent") or "").upper()
        if not intent or intent not in ("SELL", "RENT", "RENTAL_SEEKER", "BUY", "BUYER"):
            return

        # Determine what type of requirement to match against
        if intent in ("SELL", "RENT"):
            listing_type = "SELL" if intent == "SELL" else "RENT"
            requirement_intents = ("BUY", "BUYER") if listing_type == "SELL" else ("RENTAL_SEEKER",)
        else:
            return  # This is a requirement, not a listing

        # Fetch all active requirements
        requirements = storage.db.execute(
            "SELECT * FROM client_requirements WHERE is_primary = true"
        ).fetchall()

        if not requirements:
            return

        matches_sent = 0
        for req in requirements:
            req_intent = (req.get("intent") or "").upper()
            if req_intent not in requirement_intents:
                continue

            # Check BHK match
            req_bhk = (req.get("bhk") or "").strip().upper()
            listing_bhk = (listing_data.get("bhk") or "").strip().upper()
            if req_bhk and listing_bhk and req_bhk != listing_bhk:
                continue

            # Check market/location match
            req_market = (req.get("micro_market") or "").strip().lower()
            listing_market = (listing_data.get("micro_market") or listing_data.get("area") or "").strip().lower()
            if req_market and listing_market and req_market not in listing_market and listing_market not in req_market:
                continue

            # Check building match
            req_building = (req.get("building_name") or "").strip().lower()
            listing_building = (listing_data.get("building_name") or "").strip().lower()
            if req_building and listing_building and req_building not in listing_building and listing_building not in req_building:
                continue

            # Check price range
            req_price_min = req.get("price_min")
            req_price_max = req.get("price_max")
            listing_price = listing_data.get("price")
            if listing_price and float(listing_price) > 0:
                if req_price_max and float(req_price_max) > 0 and float(listing_price) > float(req_price_max):
                    continue
                if req_price_min and float(req_price_min) > 0 and float(listing_price) < float(req_price_min):
                    continue

            # It's a match — get broker phone from the requirement's client_id
            client_id = req.get("client_id")
            if not client_id:
                continue

            # Get broker/team member phone for this client
            broker_phone = None
            try:
                # Check if client has a linked broker via chat_assignments or team_members
                assignment = storage.db.execute(
                    "SELECT tm.phone FROM chat_assignments ca JOIN team_members tm ON ca.team_member_id = tm.id WHERE ca.client_id = $1 AND tm.is_active = true LIMIT 1",
                    (client_id,),
                ).fetchone()
                if assignment:
                    broker_phone = assignment["phone"]
            except Exception:
                pass

            if not broker_phone:
                continue

            # Format the alert message
            price_str = ""
            if listing_price and float(listing_price) > 0:
                price_str = f"\n💰 Price: ₹{float(listing_price):,.0f}"

            bhk_str = f"🏠 {listing_bhk}" if listing_bhk else ""
            area_str = listing_data.get("area") or listing_data.get("micro_market") or ""
            building_str = listing_data.get("building_name") or ""

            location_parts = [p for p in [building_str, area_str] if p]
            location_str = " · ".join(location_parts) if location_parts else ""

            alert_text = f"""🔔 *New Listing Match!*

{bhk_str}{' · ' + location_str if location_str else ''}{price_str}

*{intent.title()}* — match for your requirement"""
            if req.get("notes"):
                alert_text += f"\n📝 {req['notes'][:100]}"

            # Send via WABA
            try:
                result = await _waba_send_message(broker_phone, alert_text)
                if result.get("success"):
                    matches_sent += 1
                    print(f"[waba-alert] sent match alert to {broker_phone} for requirement {req['id']}", flush=True)
                else:
                    print(f"[waba-alert] failed to send to {broker_phone}: {result.get('error', '')}", flush=True)
            except Exception as exc:
                print(f"[waba-alert] error sending to {broker_phone}: {exc}", flush=True)

        if matches_sent > 0:
            print(f"[waba-alert] sent {matches_sent} alerts for listing (raw_message_id={raw_message_id})", flush=True)

    except Exception as exc:
        print(f"[waba-alert] error in _check_listing_alerts: {exc}", flush=True)


@app.get("/api/alerts/config")
async def get_alerts_config(user: dict = Depends(require_user)):
    """Get alert configuration and recent alert history."""
    try:
        requirements = storage.db.execute(
            "SELECT * FROM client_requirements WHERE is_primary = true ORDER BY created_at DESC"
        ).fetchall()

        # Get recent WABA alerts from activity log
        recent_alerts = storage.db.execute(
            """SELECT * FROM activity_log
               WHERE action LIKE 'waba%' OR action LIKE 'alert%'
               ORDER BY created_at DESC LIMIT 20"""
        ).fetchall()

        return {
            "requirements": [dict(r) for r in requirements],
            "recent_alerts": [dict(a) for a in recent_alerts],
            "waba_configured": bool(_business_api_get_config_value("access_token", "WABA_ACCESS_TOKEN")),
        }
    except Exception as exc:
        return JSONResponse(status_code=500, content={"error": str(exc)})
