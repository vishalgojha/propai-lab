"""Query-time broker market policy. No extraction, replication, or source-name fallback."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import time
import unicodedata
from datetime import datetime, timedelta, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

CONSENT_VERSION = "broker-property-cross-search-v2"
CONSENT_TEXT = (
    "Allow other authenticated PropAI brokers' AI agents to cross-search the message text "
    "in these selected groups for property-related requests. Data stays in your account. "
    "A matching message may include discussion as well as property details. DMs and unchecked "
    "groups stay private. Remove a group here to stop future cross-search access. Contact numbers are "
    "hidden until a broker chooses a specific option."
)
CONTACT_CONSENT_VERSION = "broker-property-contact-results-v1"
CONTACT_CONSENT_TEXT = (
    "Include contact numbers written in future property posts from these selected groups "
    "with matching results for authenticated PropAI brokers and their assistants. "
    "A result is a whole original post and may contain several flats and unrelated numbers. "
    "All supported in-post numbers appear as source-post contacts with nearby labels, not "
    "verified brokers for a matched flat. Flat association and ownership are unverified. Private property "
    "shortlists, including requested Excel files, are allowed. Do not publish numbers, "
    "build contact directories or use them for bulk outreach. Turn this off at any time "
    "for future requests. Existing group privacy controls still apply."
)
CONTACT_NOTICE = (
    "Numbers are hidden to avoid bulk exposure and unwanted calls. This is not a paywall. "
    "Choose one specific option to request its contact."
)
# Matching-purpose restriction, not a semantic privacy filter. The original text can be mixed.
PROPERTY_PATTERN = r"\m(bhk|bedroom|bedrooms|flat|flats|apartment|apartments|penthouse|villa|bungalow|office|offices|shop|shops|warehouse|plot|carpet|sqft|sq[ .]?ft|sq[ .]?m|lease|rent|rental|sale|resale|possession|furnished|unfurnished|crore|cr|lakh|lac)\M"


class PropertySearch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    building: str = Field("", max_length=100)
    locality: str = Field("", max_length=100)
    property_type: Literal["apartment", "penthouse", "villa", "bungalow", "office", "shop", "warehouse", "plot"] | None = None
    transaction: Literal["sale", "rent", "lease", "requirement"] | None = None
    bedrooms: int | None = Field(None, ge=1, le=20)
    # Bounds limit the source history searched, not property price. Price in raw text
    # has varying units and must be interpreted by the requesting agent, not invented here.
    days: int = Field(30, ge=1, le=90)
    limit: int = Field(10, ge=1, le=20)
    cursor: str = Field("", max_length=1800)

    @model_validator(mode="after")
    def meaningful_property_request(self):
        for field in ("building", "locality"):
            value = unicodedata.normalize("NFKC", getattr(self, field)).strip()
            # Do not accept SQL/ILIKE operators, contacts, URLs or arbitrary paragraphs.
            if value and (len(value) < 2 or not re.fullmatch(r"[\w .,'()&/-]+", value, re.UNICODE)
                          or re.search(r"\d(?:[ .()-]?\d){6,}", value)
                          or any(c in value for c in ("%", "_", "@", ":", "\n"))):
                raise ValueError(f"{field} must be a building or locality name, not a contact or general query")
            setattr(self, field, value)
        if not (self.building or self.locality or
                sum(v is not None for v in (self.property_type, self.transaction, self.bedrooms)) >= 2):
            raise ValueError("Provide a building/locality or at least two property criteria; general browsing is not supported")
        return self

    def fingerprint(self) -> str:
        data = self.model_dump(exclude={"cursor", "limit"})
        return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()

    def terms(self) -> list[list[str]]:
        groups = []
        for value in (self.building, self.locality):
            if value:
                groups.append([value.lower()])
        aliases = {
            "apartment": ["apartment", "flat", "bhk", "bedroom"],
            "sale": ["sale", "resale", "sell", "selling"],
            "rent": ["rent", "rental", "lease"],
            "requirement": ["required", "requirement", "looking for", "wanted", "need"],
        }
        for value in (self.property_type, self.transaction):
            if value:
                groups.append(aliases.get(value, [value]))
        if self.bedrooms is not None:
            n = self.bedrooms
            groups.append([f"{n}bhk", f"{n} bhk", f"{n} bedroom", f"{n} bed"])
        return groups


def redact_contacts(text: str) -> str:
    """Conservative output boundary; labels, payloads and sender identity are not returned."""
    text = unicodedata.normalize("NFKC", str(text))
    text = re.sub(r"(?:https?://|www\.)\S+|\b(?:wa\.me|t\.me)/\S+", "[link hidden]", text, flags=re.I)
    text = re.sub(r"\b[\w.+-]+@[\w.-]+(?:\.[a-z]{2,}|\.net|\.us)\b", "[contact hidden]", text, flags=re.I)
    # Covers separated international/national numbers and digit-bearing WhatsApp JIDs.
    text = re.sub(r"(?<!\w)\+?\d(?:[\s().-]*\d){6,}(?!\d)(?:@[\w.]+)?", "[number hidden]", text)
    return text


def seal(payload: dict, secret: str) -> str:
    if not secret:
        raise ValueError("Market signing secret is not configured")
    body = base64.urlsafe_b64encode(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).decode().rstrip("=")
    signature = hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()
    return body + "." + signature


def unseal(token: str, secret: str, *, kind: str, reader: str) -> dict:
    if not secret:
        raise ValueError("Market signing secret is not configured")
    try:
        body, supplied = token.split(".")
        expected = hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(supplied, expected):
            raise ValueError("signature")
        value = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
        if value.get("kind") != kind or value.get("reader") != reader or value.get("exp", 0) < time.time():
            raise ValueError("scope or expiry")
        return value
    except (ValueError, TypeError, KeyError, json.JSONDecodeError) as exc:
        raise ValueError("Invalid or expired market reference") from exc


def search_bounds(body: PropertySearch, cursor: dict | None) -> tuple[str, str, int | None, str | None]:
    if cursor:
        if cursor.get("query") != body.fingerprint():
            raise ValueError("Cursor belongs to another property query")
        return cursor["since"], cursor["until"], cursor["last_id"], cursor["last_at"]
    until = datetime.now(timezone.utc)
    return (until - timedelta(days=body.days)).isoformat(), until.isoformat(), None, None

# Group-topic classification for raw group sharing. Mirrors the connections UI
# hints, but enforced server-side: non-property group content is never shared
# for another tenant, and unclear names stay out until the broker explicitly
# includes that exact group. Patterns must stay in sync with
# frontend/src/app/connections/page.tsx.
REAL_ESTATE_GROUP_NAME_PATTERN = re.compile(
    # Grounded in the live broker directory: realtors/estates/acres/bhk/lease/
    # rentals resolve real property groups. Deliberately NOT matched: bare
    # "home" (home chefs/bakers false positives), "proptech" (industry event
    # and founder groups are not listing groups), brand/product names.
    r"\b(real\s*estate|realty|realtors?|estates?|acres?|properties|property|builders?|broker(?:s|age)?|flats?|"
    r"apartments?|housing|rera|rent(als?)?|lease|sale|commercial|residential|industrial|shops?|"
    r"offices?|warehouses?|land|plots?|inventory|construction|development|bhk|homes)\b",
    re.IGNORECASE,
)
NON_PROPERTY_GROUP_NAME_HINTS = (
    (re.compile(r"\b(family|families|relatives|cousins?|friends?|personal)\b", re.IGNORECASE), "personal or family"),
    (re.compile(r"\b(hare\s*krishna|bhajan|bhakti|kirtan|satsang|temple|mandir|church|mosque|prayer|katha)\b", re.IGNORECASE), "religious or devotional"),
    (re.compile(r"\b(school|college|classmates?|students?|tuition|alumni|batchmates?)\b", re.IGNORECASE), "school or college"),
    (re.compile(r"\b(cricket|football|badminton|sports?|gaming|gamers?)\b", re.IGNORECASE), "sports or gaming"),
    (re.compile(r"\b(good\s*morning|gm\s*(?:wishes|messages)|daily\s*wishes|festival\s*wishes)\b", re.IGNORECASE), "greetings or wishes"),
    (re.compile(r"\b(singles|socialise|socialising|socialize|socializing)\b", re.IGNORECASE), "social or dating"),
    (re.compile(r"\b(jamming|music)\b", re.IGNORECASE), "music"),
    (re.compile(r"\b(catering|tiffin)\b", re.IGNORECASE), "food or catering"),
    (re.compile(r"\b(healing|yoga|meditation)\b", re.IGNORECASE), "health or wellness"),
)


def classify_group_share_topic(name: str | None):
    """Return (share_class, topic): 'property', 'non_property' (+topic), or 'unclear'."""
    text = (name or "").strip()
    if not text:
        return "unclear", None
    if REAL_ESTATE_GROUP_NAME_PATTERN.search(text):
        return "property", None
    for pattern, topic in NON_PROPERTY_GROUP_NAME_HINTS:
        if pattern.search(text):
            return "non_property", topic
    return "unclear", None


def validate_group_share_eligibility(group_jids, allow_unclear, names_by_jid):
    """Enforce the non-property sharing rule before any consent write.

    Returns (blocked, held): non-property groups that can never be shared, and
    unclear groups that need an exact per-group opt-in via allow_unclear.
    Jids absent from names_by_jid are left to the directory-existence check.
    """
    blocked, held = [], []
    allowed = set(allow_unclear or [])
    for jid in group_jids:
        if jid not in names_by_jid:
            continue
        name = names_by_jid.get(jid) or ""
        share_class, topic = classify_group_share_topic(name)
        if share_class == "non_property":
            blocked.append("%s (%s group)" % (name or jid, topic))
        elif share_class == "unclear" and jid not in allowed:
            held.append(name or jid)
    return blocked, held


DM_CAPTURE_VERSION = "broker-dm-capture-v1"
DM_CAPTURE_TEXT = (
    "Save property-listing messages that arrive as direct messages from the broker senders "
    "I select below. Only messages that look like property listings are saved; the filter can "
    "make mistakes, and all other personal chats stay private and are never saved. Saved "
    "messages are searchable only in my own account and are never shared with other brokers "
    "or their assistants. Remove a sender here at any time to stop future captures."
)


def normalize_dm_sender_phone(value):
    """Bare 10-15 digit phone identity for a direct-message sender, or ''.

    Accepts JIDs ("9198...@s.whatsapp.net"), international punctuation and
    spaces. Country/trunk digits are not guessed; anything that cannot be a
    phone identity is rejected rather than repaired.
    """
    # Device/agent-suffixed user JIDs ("9198...:12", "9198....0:12"): the
    # suffix is not part of the phone identity.
    base = str(value or "").split("@")[0].split(":")[0].split(".")[0]
    digits = re.sub(r"[^0-9]", "", base)
    return digits if 10 <= len(digits) <= 15 else ""
