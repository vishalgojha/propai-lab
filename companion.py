"""
Webhook tools for PropAI Companion (ElevenLabs WhatsApp agent).

Why this exists (not MCP):
ElevenLabs' MCP integration binds one OAuth session to one fixed broker_id
for the life of the connection. Since this WABA number serves MANY brokers,
an MCP session would silently attribute every broker's data to whichever
single identity authorized the MCP connection. These webhook tools are
stateless instead — every call carries the sender's WhatsApp phone number
fresh, so identity is resolved per-request, not per-session.

Wire-up on ElevenLabs' side:
  Tools tab -> Add tool -> Webhook
  URL: https://<your-api-host>/webhooks/companion/save-listing
  URL: https://<your-api-host>/webhooks/companion/create-requirement
  URL: https://<your-api-host>/webhooks/companion/onboard-broker
  Header: X-Companion-Webhook-Secret: <COMPANION_WEBHOOK_SECRET>
  Body params should map to the Pydantic fields below. Pass the broker's
  WhatsApp number via the {{system__caller_id}} dynamic variable into the
  `phone` field.

Onboarding flow (explicit consent, not silent):
  save-listing / create-requirement is called for an unknown phone
  -> returns HTTP 404 with needs_onboarding=true and an onboarding_prompt
  -> The agent relays that prompt to the broker and asks for their name
     + explicit consent to create a PropAI account.
  -> On "yes" + name, the agent calls POST /onboard-broker.
  -> The agent retries the original save-listing / create-requirement call,
     which now succeeds since the broker exists.

  System prompt guidance to add to the agent:
    "If a save tool call fails with needs_onboarding=true, do not claim the
    data was saved. Tell the broker in one line that they're not registered
    yet, ask for their name, and ask 'Should I set up your PropAI account so
    I can save this?' Only call onboard-broker after they say yes."
"""

import os
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from storage import SupabaseStorage
from storage.base import Listing

router = APIRouter(prefix="/webhooks/companion", tags=["companion"])

# Set this in your environment and mirror it in ElevenLabs' webhook tool config.
COMPANION_WEBHOOK_SECRET = os.environ.get("COMPANION_WEBHOOK_SECRET", "")

storage = SupabaseStorage()

ONBOARDING_PROMPT = (
    "This number isn't registered with PropAI yet. Ask for the broker's name "
    "and explicit consent, then call /onboard-broker before retrying this save."
)


def _check_secret(x_companion_webhook_secret: str | None):
    if not COMPANION_WEBHOOK_SECRET:
        # Fail closed: refuse to run wide open in production.
        raise HTTPException(500, "COMPANION_WEBHOOK_SECRET is not configured on the server")
    if x_companion_webhook_secret != COMPANION_WEBHOOK_SECRET:
        raise HTTPException(401, "Invalid webhook secret")


def _phone_identity_key(phone: str) -> str | None:
    digits = re.sub(r"\D+", "", phone or "")
    if len(digits) >= 10:
        return f"phone:{digits[-10:]}"
    return None


def _normalize_phone(phone: str) -> str:
    """Normalize phone to 10-digit Indian format.

    Strips all non-digits, handles +91 / 0 prefix, and validates the
    Indian mobile prefix (6-9). Returns empty string for invalid numbers.
    """
    raw = (phone or "").strip()
    if not raw or re.search(r"[xX*•]", raw):
        return ""
    digits = re.sub(r"\D", "", raw)
    if len(digits) == 12 and digits.startswith("91"):
        digits = digits[-10:]
    elif len(digits) == 11 and digits.startswith("0"):
        digits = digits[-10:]
    if len(digits) == 10 and re.match(r"^[6-9]\d{9}$", digits):
        return digits
    return ""


def resolve_broker(phone: str) -> str:
    """Resolve an already-onboarded broker (= tenant) by WhatsApp phone number.

    Does NOT create anything. Raises HTTPException(404) with
    needs_onboarding=True in the detail if the phone number is unknown —
    the agent must run the explicit onboarding flow before retrying.
    """
    norm_phone = _normalize_phone(phone)
    if not norm_phone:
        raise HTTPException(400, "A valid phone number is required to resolve broker identity")

    existing = storage.find_broker(phone=norm_phone)
    if existing:
        return str(existing["id"])

    raise HTTPException(
        404,
        {"needs_onboarding": True, "message": ONBOARDING_PROMPT},
    )


class OnboardBrokerRequest(BaseModel):
    phone: str
    name: str
    consent: bool    # must be explicitly true — the broker said yes


@router.post("/onboard-broker")
async def onboard_broker_webhook(
    body: OnboardBrokerRequest,
    x_companion_webhook_secret: str | None = Header(default=None),
):
    _check_secret(x_companion_webhook_secret)
    if not body.consent:
        raise HTTPException(400, "Cannot onboard a broker without explicit consent=true")

    norm_phone = _normalize_phone(body.phone)
    if not norm_phone:
        raise HTTPException(400, "A valid phone number is required")

    existing = storage.find_broker(phone=norm_phone)
    if existing:
        return {"status": "already_onboarded", "broker_id": str(existing["id"])}

    key = _phone_identity_key(norm_phone)
    created = storage.save_broker({
        "identity_key": key,
        "primary_phone": norm_phone,
        "canonical_name": body.name,
        "observation_count": 0,
    })
    return {"status": "onboarded", "broker_id": str(created["id"])}


class SaveListingRequest(BaseModel):
    phone: str          # broker's WhatsApp number -> {{system__caller_id}}
    raw_text: str
    name: str | None = None
    bhk: str | None = None
    location: str | None = None
    price: str | None = None
    carpet_area: str | None = None
    furnishing: str | None = None
    contact_number: str | None = None


class CreateRequirementRequest(BaseModel):
    phone: str          # broker's WhatsApp number -> {{system__caller_id}}
    raw_text: str
    lead_name: str | None = None
    lead_phone: str | None = None    # the buyer/tenant's phone, distinct from the broker's
    budget: str | None = None
    location_pref: str | None = None
    timeline: str | None = None
    bhk_preference: str | None = None
    property_type: str | None = None


def _to_price_cr(price: str | None) -> float | None:
    """Convert a human-readable price string to crores.

    "1.5 cr" -> 1.5, "85 lac" -> 0.85, "₹90L" -> 0.9, "2500000" -> 2.5.
    Returns None if unparseable or if the text looks like a non-price query.
    """
    if not price:
        return None
    text = price.strip().lower()
    # Extract the numeric part
    digits = re.sub(r"[^\d.]", "", text)
    if not digits:
        return None
    try:
        val = float(digits)
    except ValueError:
        return None
    # Guard: if the text contains words that clearly indicate this isn't a
    # price (e.g. "3 BHK in Bandra"), bail out early.
    if re.search(r"\b(bhk|bed|room|floor|flat|apt|sq\s?ft|sqft)\b", text):
        return None
    # Unit-aware normalization — check the original text for unit keywords.
    # Use [^a-z] boundaries instead of \b for single-letter units like "L"
    # because \b doesn't trigger between a digit and a letter (both are \w).
    if re.search(r"(?:^|[^a-z])(?:crore|crores|cr)(?:[^a-z]|$)", text):
        return val          # already in crore
    if re.search(r"(?:^|[^a-z])(?:lac|lakh|lakhs|lacs|l)(?:[^a-z]|$)", text):
        return val / 100    # lakh -> crore
    if re.search(r"(?:^|[^a-z])(?:k|thousand)(?:[^a-z]|$)", text):
        return val / 10000  # thousand -> crore
    # No unit found — assume the value is already in crore (most common
    # case from ElevenLabs structured extraction which normalizes to cr).
    return val


@router.post("/save-listing")
async def save_listing_webhook(
    body: SaveListingRequest,
    x_companion_webhook_secret: str | None = Header(default=None),
):
    _check_secret(x_companion_webhook_secret)
    broker_id = resolve_broker(body.phone)

    now = datetime.now(timezone.utc).isoformat()
    listing = Listing(
        intent="listing",
        bhk=body.bhk,
        price=_to_price_cr(body.price),
        price_unit="cr" if body.price else None,
        area_sqft=float(re.sub(r"\D+", "", body.carpet_area)) if body.carpet_area and re.sub(r"\D+", "", body.carpet_area) else None,
        furnishing=body.furnishing,
        location_label=body.location,
        micro_market=body.location,
        broker_name=body.name,
        broker_phone=_normalize_phone(body.contact_number or body.phone),
        first_seen=now,
        last_seen=now,
        tenant_id=broker_id,
    )
    listing_id = storage.save_listing(listing)

    return {
        "status": "saved",
        "listing_id": listing_id,
        "broker_id": broker_id,
        "source": "waba_companion",
    }


@router.post("/create-requirement")
async def create_requirement_webhook(
    body: CreateRequirementRequest,
    x_companion_webhook_secret: str | None = Header(default=None),
):
    _check_secret(x_companion_webhook_secret)
    broker_id = resolve_broker(body.phone)

    client_data = {
        "tenant_id": broker_id,
        "name": body.lead_name or "WABA Requirement",
        "phone": _normalize_phone(body.lead_phone) if body.lead_phone else None,
        "notes": (
            f"[source: waba_companion]\n{body.raw_text}\n"
            f"budget={body.budget or '-'} location={body.location_pref or '-'} "
            f"timeline={body.timeline or '-'} bhk={body.bhk_preference or '-'} "
            f"type={body.property_type or '-'}"
        ),
    }
    saved = storage.save_client(client_data)

    return {
        "status": "saved",
        "client_id": saved.get("id"),
        "broker_id": broker_id,
        "source": "waba_companion",
    }
