"""Small tenant-scoped REST surface for external agents such as Instinct."""
import asyncio
import base64
import hashlib
import hmac
import json
import logging
import math
import os
import re
import secrets
from dataclasses import asdict, is_dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field

from domain_glossary import build_ai_domain_context
from registry.search_locality import resolve_search_locality, AmbiguousLocality
from registry.locality_resolver import _fetch_all
from routers.common import _require_org_permission, require_tenant, require_user, storage
from storage import set_tenant_id

router = APIRouter(prefix="/api/external/v1", tags=["external_agent"])
KEY_PREFIX = "ppai_"
logger = logging.getLogger(__name__)
RAW_MESSAGE_COLUMNS = "id,group_name,sender,sender_jid,sender_phone,message,message_type,timestamp,source,is_group,processed"
EXTERNAL_AGENT_DOCS = Path(__file__).resolve().parents[1] / "docs" / "EXTERNAL_AGENT_API.md"
BROKER_AGENT_KNOWLEDGE = Path(__file__).resolve().parents[1] / "docs" / "BROKER_AGENT_KNOWLEDGE.md"
WRITE_SCOPES = {"inventory:write", "requirements:write"}
TOOL_READ_SCOPES = {
    "standing_searches:read", "automatch:read", "workspace:attention", "followups:read",
}
EXTRACTION_SCOPE = "raw_messages:extract"
TOOL_WRITE_SCOPES = {"standing_searches:write", "followups:write"}
DEFAULT_READ_SCOPES = {
    "inventory:read", "requirements:read", "matches:read", "raw_messages:read",
    *TOOL_READ_SCOPES,
}
SENSITIVE_INVENTORY_FIELDS = {"contact_number", "owner_name", "contact_name", "quote"}
SENSITIVE_REQUIREMENT_FIELDS = {"phone", "budget_min", "budget_max"}

# --- Private DM identifier privacy -------------------------------------------
# DM rows cross the external boundary without peer identifiers: no phone, no
# JID, and the broker's saved contact name instead of the public pushname.
# Group rows are unchanged; owner-facing broker attribution keeps its numbers.
UNNAMED_DM_CONTACT = "Unnamed contact"

# A phone-like run: 10-13 digits with common separators. Indian-style grouped
# prices use commas, which break the run on purpose; dates (2026-11-21) and
# measurements are too short. This is best-effort content masking, not proof
# that no number can appear (words, media, vcards or odd formats can leak).
# A maximal run of phone-like characters. The run is unbounded on purpose:
# adjacent numbers separated by spaces merge into one run and must still be
# masked, so length bounds belong to the digit count check, not the pattern.
_DM_PHONE_RUN = re.compile(r"\+?\d[\d\s().\-]*\d")
_DM_DATE_PREFIX = re.compile(r"^\+?\d{4}-\d{1,2}-\d{1,2}")
_DM_DATEISH = re.compile(r"^\+?\d{1,2}[-.]\d{1,2}[-.]\d{2,4}$")


def _mask_phone_like_text(text: str) -> str:
    def _hide(match: re.Match) -> str:
        run = match.group(0)
        if ":" in run or _DM_DATE_PREFIX.match(run) or _DM_DATEISH.match(run):
            return run
        digits = re.sub(r"\D", "", run)
        if len(digits) < 7:
            return run
        return "[number hidden]"
    return _DM_PHONE_RUN.sub(_hide, text)


def _tenant_device_jids(tenant_id: str, cache: dict) -> list:
    """JIDs of the WhatsApp devices that belong to this workspace.

    Contact-name lookups are always bound to one of these devices, so one
    workspace can never read another workspace's saved contact names."""
    if tenant_id in cache:
        return cache[tenant_id]
    jids = []
    try:
        rows = storage.client.table("org_whatsapp_connections").select(
            "phone_number"
        ).eq("organization_id", tenant_id).execute().data or []
    except Exception:
        rows = []
    for row in rows:
        digits = re.sub(r"\D", "", str(row.get("phone_number") or ""))
        if digits:
            jids.append(f"{digits}@s.whatsapp.net")
    cache[tenant_id] = jids
    return jids


def _device_jid_or_filter(device_jids: list) -> str:
    """PostgREST or-filter binding a row to one of the workspace's own devices.

    Real whatsmeow sessions store our_jid with a device suffix
    ("9198...:14@s.whatsapp.net"), so an exact match on "{digits}@s.whatsapp.net"
    silently misses every row. Accept both the plain JID and the suffixed form.
    The like pattern is anchored at the string start and requires the colon right
    after the device digits, so a longer number containing those digits cannot
    match."""
    parts = []
    for jid in device_jids:
        digits = re.sub(r"\D", "", str(jid).split("@")[0])
        if not digits:
            continue
        parts.append(f"our_jid.eq.{digits}@s.whatsapp.net")
        parts.append(f"our_jid.like.{digits}:%@s.whatsapp.net")
    return ",".join(parts)


def _saved_dm_contact_name(tenant_id: str, sender_jid: str, sender_phone: str, cache: dict, device_cache: dict) -> str:
    """The workspace owner's saved contact name for a DM peer.

    Reads the device contact store (full_name/first_name/business_name) only,
    and only from rows owned by this workspace's own devices (our_jid bound
    to the tenant's connected numbers). The public pushname is not a saved
    name and is never used. A saved name that is itself phone-like yields no
    name. Falls back to a fixed label, never to the number."""
    key = (tenant_id, sender_jid or "", sender_phone or "")
    if key in cache:
        return cache[key]
    device_jids = _tenant_device_jids(tenant_id, device_cache)
    name = ""
    if device_jids:
        jid_phone_match = re.match(r"\+?(\d+)@s\.whatsapp\.net$", sender_jid or "", re.I)
        phone_digits = re.sub(r"\D", "", sender_phone or "")
        jid_digits = jid_phone_match.group(1) if jid_phone_match else ""
        queries = []
        for value in (sender_jid, jid_digits):
            if value:
                queries.append(("their_jid", value))
        if phone_digits and phone_digits != jid_digits:
            # WhatsApp now reports many DM senders as "<lid>@lid" while the
            # device contact store keys the saved name under the phone-number
            # JID. Without these forms an @lid sender never reaches its saved
            # name row (observed in production after the device-suffix fix).
            queries.append(("their_jid", f"{phone_digits}@s.whatsapp.net"))
            queries.append(("their_jid", phone_digits))
        for value in (phone_digits, jid_digits):
            if value:
                queries.append(("redacted_phone", value))
        device_filter = _device_jid_or_filter(device_jids)
        for column, value in queries:
            try:
                result = storage.client.table("whatsmeow_contacts").select(
                    "full_name,first_name,business_name"
                ).eq(column, value).or_(device_filter).limit(1).execute()
            except Exception:
                continue
            row = (result.data or [None])[0] if result else None
            if not row:
                continue
            for field in ("full_name", "first_name", "business_name"):
                candidate = str(row.get(field) or "").strip()
                if not candidate:
                    continue
                if not re.search(r"[A-Za-z\u0900-\u097F]", candidate):
                    continue
                masked = _mask_phone_like_text(candidate).strip()
                name = masked
                break
            if name:
                break
    cache[key] = name or UNNAMED_DM_CONTACT
    return cache[key]


def _mask_dm_response_row(row: dict, tenant_id: str, name_cache: dict, device_cache: dict) -> dict:
    """Strip DM peer identifiers from one external response row.

    Group rows pass through unchanged. Stored evidence is untouched; this is
    a response-boundary transform only."""
    if row.get("is_group"):
        return row
    masked = dict(row)
    masked["sender"] = _saved_dm_contact_name(
        tenant_id, str(row.get("sender_jid") or ""), str(row.get("sender_phone") or ""), name_cache, device_cache
    )
    masked["sender_jid"] = None
    masked["sender_phone"] = None
    group_name = str(row.get("group_name") or "")
    if group_name and not group_name.endswith("@g.us"):
        masked["group_name"] = None
    message = masked.get("message")
    if isinstance(message, str) and message:
        masked["message"] = _mask_phone_like_text(message)
    return masked


class ApiKeyCreate(BaseModel):
    label: str = "Instinct"
    write_access: bool = False


class ApiKeyWriteAccessUpdate(BaseModel):
    enabled: bool = True


class ApprovalDecision(BaseModel):
    approved: bool
    note: str = ""


class DmConsentUpdate(BaseModel):
    enabled: bool = Field(description="Allow external agents to read this workspace's private WhatsApp DMs")


class StandingSearchCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    query_text: str = Field(min_length=1, max_length=500)
    filters: dict = Field(default_factory=dict)
    confirmed: bool = False


class FollowupCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    due_date: date
    due_time: str | None = Field(default=None, max_length=20)
    follow_up_type: str = Field(default="agent_review", max_length=80)
    notes: str = Field(default="", max_length=2000)
    client_id: int | None = Field(default=None, ge=1)
    message_id: int | None = Field(default=None, ge=1)
    building_name: str | None = Field(default=None, max_length=200)
    broker_phone: str | None = Field(default=None, max_length=40)


def _digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _key_row(token: str) -> dict:
    if not token.startswith(KEY_PREFIX) or len(token) < 40:
        raise HTTPException(401, "Invalid external API token")
    result = storage.client.table("external_agent_api_keys").select(
        "id,tenant_id,created_by,label,scopes,expires_at,revoked_at"
    ).eq("key_hash", _digest(token)).is_("revoked_at", "null").limit(1).execute()
    row = (result.data or [None])[0] if result else None
    if not row:
        raise HTTPException(401, "Invalid or revoked external API token")
    expires_at = row.get("expires_at")
    if expires_at:
        try:
            if datetime.fromisoformat(str(expires_at).replace("Z", "+00:00")) <= datetime.now(timezone.utc):
                raise HTTPException(401, "External API token has expired")
        except ValueError:
            raise HTTPException(401, "External API token has invalid expiry")
    storage.client.table("external_agent_api_keys").update(
        {"last_used_at": datetime.now(timezone.utc).isoformat()}
    ).eq("id", row["id"]).execute()
    consent = storage.client.table("organizations").select(
        "external_agent_dms_enabled"
    ).eq("id", str(row["tenant_id"])).limit(1).execute()
    row["external_agent_dms_enabled"] = bool(
        ((consent.data or [{}])[0] or {}).get("external_agent_dms_enabled")
    )
    # Persisted scopes are authoritative. Workspace DM consent is a separate
    # owner-controlled gate and is synchronized to keys by the consent route.
    row["scopes"] = sorted(set(row.get("scopes") or []))
    set_tenant_id(str(row["tenant_id"]))
    return row


async def external_auth(
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
) -> dict:
    bearer_scheme, _, bearer_token = str(authorization or "").partition(" ")
    bearer_token = bearer_token.strip() if bearer_scheme.lower() == "bearer" else ""
    header_token = str(x_api_key or "").strip()
    if bearer_token and header_token and not secrets.compare_digest(bearer_token, header_token):
        raise HTTPException(401, "Conflicting external API credentials")
    token = bearer_token or header_token
    if not token:
        raise HTTPException(401, "Bearer token required")
    return _key_row(token)


@router.get("/health")
async def external_health(key: dict = Depends(external_auth)):
    return {"ok": True, "tenant_scoped": True, "scopes": key.get("scopes") or []}


@router.get("/docs", response_class=PlainTextResponse)
async def external_agent_docs():
    """Public bootstrap guide; contains API instructions, never tenant data or credentials."""
    try:
        content = EXTERNAL_AGENT_DOCS.read_text(encoding="utf-8")
    except OSError as exc:
        logger.exception("External agent API guide is unavailable")
        raise HTTPException(503, "External agent API guide is temporarily unavailable") from exc
    return PlainTextResponse(content, headers={"Cache-Control": "public, max-age=300"})



@router.get("/knowledge", response_class=PlainTextResponse)
async def external_agent_knowledge():
    """Product vocabulary only. No workspace records, credentials or prompt."""
    try:
        background = BROKER_AGENT_KNOWLEDGE.read_text(encoding="utf-8")
    except OSError as exc:
        raise HTTPException(503, "Broker background knowledge is temporarily unavailable") from exc
    return PlainTextResponse(build_ai_domain_context() + "\n\n" + background,
                             headers={"Cache-Control": "public, max-age=300"})


def _require_scope(key: dict, scope: str):
    if scope not in (key.get("scopes") or []):
        raise HTTPException(403, f"Token does not have {scope} scope")


def _require_dm_consent(key: dict):
    if not key.get("external_agent_dms_enabled"):
        raise HTTPException(
            403,
            "Private DM access is disabled. The workspace owner must explicitly enable it in Account → MCP.",
        )
    _require_scope(key, "raw_messages:dms")


ASSISTANT_TRIAL_DAYS = 15
# Written only when the clock is started by the first-successful-search path.
# Rows without this marker predate it; their start is NOT a recorded search.
TRIAL_START_FIRST_SEARCH = "first_assistant_search"

# Tenants whose trial start is already persisted. Avoids a bookkeeping round
# trip on every search: at most one read plus one guarded write per tenant
# per process. Callers must run this via asyncio.to_thread.
_trial_started_cache: set[str] = set()


def _record_assistant_trial_start(tenant_id: str) -> None:
    """Start the 15-day assistant trial exactly once, on the first successful
    assistant search. Health checks, docs, key management and consent reads
    never start the clock, and neither do errored searches (callers record
    only after a search returns). This bookkeeping is lazy: a failed write
    must never block the search itself. Blocking DB client - always call via
    asyncio.to_thread."""
    if tenant_id in _trial_started_cache:
        return
    try:
        existing = storage.client.table("organizations").select(
            "mcp_trial_started_at, mcp_trial_ends_at"
        ).eq("id", tenant_id).limit(1).execute()
        row = (existing.data or [None])[0] if existing else None
        if row and (row.get("mcp_trial_started_at") or row.get("mcp_trial_ends_at")):
            # Trial already recorded, or a partial record (one date without
            # the other): both stored fields are preserved, never overwritten.
            _trial_started_cache.add(tenant_id)
            return
        now = datetime.now(timezone.utc)
        storage.client.table("organizations").update({
            "mcp_trial_started_at": now.isoformat(),
            "mcp_trial_ends_at": (now + timedelta(days=ASSISTANT_TRIAL_DAYS)).isoformat(),
            "mcp_trial_started_via": TRIAL_START_FIRST_SEARCH,
        }).eq("id", tenant_id).is_("mcp_trial_started_at", "null").is_("mcp_trial_ends_at", "null").execute()
        # Only a brand-new cohort (both dates absent) ever reaches the write.
        _trial_started_cache.add(tenant_id)
    except Exception:
        logger.warning("Unable to record assistant trial start for tenant %s", tenant_id, exc_info=True)


def _redact_payload(payload: dict) -> dict:
    sensitive = {"phone", "contact_number", "owner_name", "contact_name", "quote", "budget_min", "budget_max"}
    return {
        str(field): "[REDACTED]" if str(field) in sensitive else value
        for field, value in payload.items()
        if str(field) not in {"token", "api_key", "authorization"}
    }


def _write_audit_start(key: dict, operation: str, entity_type: str, payload: dict, sensitive_fields: list[str], *, status: str = "started", request_id: str = "") -> str:
    result = storage.client.table("external_agent_write_audit_log").insert({
        "tenant_id": str(key["tenant_id"]),
        "api_key_id": key.get("id"),
        "operation": operation,
        "entity_type": entity_type,
        "status": status,
        "request_id": request_id[:160],
        "idempotency_key": str(payload.get("_idempotency_key") or "")[:160],
        "sensitive_fields": sensitive_fields,
        "payload": _redact_payload(payload),
    }).execute()
    audit_id = ((result.data or [None])[0] or {}).get("id") if result else None
    if not audit_id:
        raise HTTPException(503, "Write audit is unavailable; no CRM mutation was performed")
    return str(audit_id)


def _write_audit_finish(audit_id: str, status: str, *, entity_id: str = "", result: dict | None = None, error_code: str = ""):
    storage.client.table("external_agent_write_audit_log").update({
        "status": status,
        "entity_id": str(entity_id or ""),
        "result": result or {},
        "error_code": error_code[:120],
        "completed_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", audit_id).execute()


def _sensitive_fields(payload: dict, fields: set[str]) -> list[str]:
    return sorted(field for field in fields if payload.get(field) not in (None, "", [], {}))


@router.get("/trial-status")
async def external_trial_status(key: dict = Depends(external_auth)):
    """Read-only trial display state for the key's own tenant.

    Lets the broker's own assistant answer "how many free days are left" so it
    can offer reminders. Never starts or changes the trial clock."""
    from routers.workspace import _parse_trial_timestamp, assistant_trial_state

    tenant_id = str(key["tenant_id"])
    state = await asyncio.to_thread(assistant_trial_state, tenant_id)
    days_left = None
    ends = _parse_trial_timestamp(state.get("trial_ends_at"))
    if state.get("trial_state") == "active" and ends is not None:
        seconds_left = (ends - datetime.now(timezone.utc)).total_seconds()
        days_left = max(0, -(-int(seconds_left) // 86400))  # ceil days
    # Report the tenant's ACTUAL recorded window, never a blanket 15:
    # pre-existing rows can carry a 7-day auth-era window, and rows without
    # two parseable dates have no knowable total.
    started = _parse_trial_timestamp(state.get("trial_started_at"))
    days_total = None
    if started is not None and ends is not None:
        days_total = max(0, round((ends - started).total_seconds() / 86400))
    return {
        "tenant_scoped": True,
        "trial_state": state.get("trial_state"),
        "trial_started_at": state.get("trial_started_at"),
        "trial_ends_at": state.get("trial_ends_at"),
        "trial_started_via": state.get("trial_started_via"),
        "trial_first_search": state.get("trial_first_search"),
        "trial_days_left": days_left,
        "trial_days_total": days_total,
        "note": "Display state only; no billing or access enforcement is attached.",
        # The user-approved reminder option is user-initiated: if the user asks
        # to be reminded before the trial ends, the assistant schedules that
        # reminder itself in its own chat with the user. PropAI runs no
        # scheduler and sends no reminders.
        "reminder_hint": "If the user asks to be reminded before the trial ends, schedule that reminder yourself (for example a day or two before trial_ends_at); PropAI does not schedule or send reminders.",
    }


@router.get("/messages/search")
async def external_raw_message_search(
    q: str = "",
    scope: str = Query("groups", pattern="^(groups|dms|all)$"),
    since: str = "",
    until: str = "",
    limit: int = Query(25, ge=1, le=100),
    offset: int = Query(0, ge=0),
    key: dict = Depends(external_auth),
):
    _require_scope(key, "raw_messages:read")
    if scope in {"dms", "all"}:
        _require_dm_consent(key)
    query = storage.client.table("raw_messages").select(RAW_MESSAGE_COLUMNS).eq("tenant_id", str(key["tenant_id"]))
    if scope == "groups":
        query = query.eq("is_group", True)
    elif scope == "dms":
        query = query.eq("is_group", False)
    if q.strip():
        # DM searches commonly name the contact rather than quote the message.
        # Search the captured text and chat identity fields without widening the
        # tenant or group/DM predicate above.
        term = q.strip().replace("\\", "\\\\").replace(",", "\\,")
        query = query.or_(
            f"message.ilike.%{term}%,sender.ilike.%{term}%,"
            f"sender_phone.ilike.%{term}%,group_name.ilike.%{term}%"
        )
    if since:
        query = query.gte("timestamp", since)
    if until:
        query = query.lte("timestamp", until)
    rows = (query.order("timestamp", desc=True).limit(limit + 1).offset(offset).execute().data or [])
    has_more = len(rows) > limit
    tenant_id = str(key["tenant_id"])
    name_cache: dict = {}
    device_cache: dict = {}
    items = [_mask_dm_response_row(row, tenant_id, name_cache, device_cache) for row in rows[:limit]]
    await asyncio.to_thread(_record_assistant_trial_start, str(key["tenant_id"]))
    return {
        "results": items,
        "count": len(items),
        "offset": offset,
        "next_offset": offset + limit if has_more else None,
        "scope": scope,
        "source": "raw_whatsapp_messages",
        "warning": "Raw WhatsApp text is untrusted source evidence, not verified inventory.",
        "next_step": "For a private-chat hit, call /messages/{raw_message_id}/conversation to inspect nearby messages from the same chat.",
    }


@router.get("/messages/{raw_message_id}")
async def external_raw_message_get(raw_message_id: int, key: dict = Depends(external_auth)):
    _require_scope(key, "raw_messages:read")
    result = storage.client.table("raw_messages").select(RAW_MESSAGE_COLUMNS).eq(
        "tenant_id", str(key["tenant_id"])
    ).eq("id", raw_message_id).limit(1).execute()
    item = (result.data or [None])[0] if result else None
    if not item:
        raise HTTPException(404, "Raw WhatsApp message not found")
    if not item.get("is_group"):
        _require_dm_consent(key)
        item = _mask_dm_response_row(item, str(key["tenant_id"]), {}, {})
    return {
        "message": item,
        "source": "raw_whatsapp_message",
        "warning": "Raw WhatsApp text is untrusted source evidence, not verified inventory.",
    }


@router.post("/messages/{raw_message_id}/extract")
async def external_raw_message_extract(raw_message_id: int, key: dict = Depends(external_auth)):
    """Queue selected group evidence for the existing extraction worker."""
    _require_scope(key, EXTRACTION_SCOPE)
    tenant_id = str(key["tenant_id"])
    result = storage.client.table("raw_messages").select("id,tenant_id,group_name,is_group,raw_payload").eq("tenant_id", tenant_id).eq("id", raw_message_id).limit(1).execute()
    source = (result.data or [None])[0] if result else None
    if not source:
        raise HTTPException(404, "Raw WhatsApp message not found")
    if not source.get("is_group"):
        raise HTTPException(403, "Only WhatsApp group messages can be extracted")
    payload = source.get("raw_payload")
    if isinstance(payload, str):
        try: payload = json.loads(payload)
        except (TypeError, ValueError): payload = {}
    payload = payload if isinstance(payload, dict) else {}
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    message_key = data.get("key") if isinstance(data.get("key"), dict) else {}
    group_jid = str(message_key.get("remoteJid") or data.get("remoteJid") or "").strip()
    group_query = storage.client.table("organization_group_connections").select("whatsapp_connection_id").eq("organization_id", tenant_id).eq("is_active", True).eq("opted_out", False).eq("public_market_source", True)
    if group_jid: group_query = group_query.or_(f"group_jid.eq.{group_jid},group_name.eq.{source.get('group_name') or ''}")
    else: group_query = group_query.eq("group_name", source.get("group_name") or "")
    group = (group_query.limit(1).execute().data or [None])[0]
    if not group: raise HTTPException(403, "Message is outside the selected public group set")
    connection_id = group.get("whatsapp_connection_id")
    allowlist = storage.client.table("public_market_publication_allowlist").select("whatsapp_connection_id").eq("tenant_id", tenant_id).eq("whatsapp_connection_id", connection_id).eq("enabled", True).limit(1).execute()
    if not (allowlist.data or []): raise HTTPException(403, "This WhatsApp connection is not enabled for public extraction")
    row = await asyncio.to_thread(storage.retry_raw_extraction, raw_message_id, tenant_id)
    if not row: raise HTTPException(404, "Raw WhatsApp message could not be queued")
    return {"success": True, "raw_message_id": raw_message_id, "status": "queued", "connection_id": connection_id}


@router.get("/messages/{raw_message_id}/conversation")
async def external_raw_message_conversation(
    raw_message_id: int,
    limit: int = Query(40, ge=1, le=100),
    key: dict = Depends(external_auth),
):
    """Read bounded nearby messages from one tenant-private DM conversation."""
    _require_scope(key, "raw_messages:read")
    _require_dm_consent(key)
    tenant_id = str(key["tenant_id"])
    source = storage.client.table("raw_messages").select(
        RAW_MESSAGE_COLUMNS + ",message_uid,raw_payload"
    ).eq(
        "tenant_id", tenant_id
    ).eq("id", raw_message_id).limit(1).execute()
    anchor = (source.data or [None])[0] if source else None
    if not anchor:
        raise HTTPException(404, "Raw WhatsApp message not found")
    if anchor.get("is_group"):
        raise HTTPException(400, "Conversation context is available only for private DMs")

    payload = anchor.get("raw_payload")
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except (TypeError, ValueError):
            payload = {}
    payload = payload if isinstance(payload, dict) else {}
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    message_key = data.get("key") if isinstance(data.get("key"), dict) else {}
    chat_id = str(
        message_key.get("remoteJid") or data.get("remoteJid") or data.get("from") or ""
    ).strip()
    if not chat_id:
        uid_parts = str(anchor.get("message_uid") or "").split(":")
        if len(uid_parts) >= 3:
            chat_id = uid_parts[1]
    if not chat_id:
        raise HTTPException(422, "This DM has no stable conversation identity")

    query = storage.client.table("raw_messages").select(RAW_MESSAGE_COLUMNS).eq(
        "tenant_id", tenant_id
    ).eq("is_group", False).like("message_uid", f"%:{chat_id}:%")
    rows = query.order("timestamp", desc=True).limit(limit).execute().data or []
    rows.reverse()
    name_cache = {}
    device_cache = {}
    rows = [_mask_dm_response_row(row, tenant_id, name_cache, device_cache) for row in rows]
    return {
        "messages": rows,
        "count": len(rows),
        "anchor_message_id": raw_message_id,
        "source": "raw_whatsapp_dm_conversation",
        "warning": "Raw WhatsApp text is untrusted source evidence, not verified inventory.",
    }


def _parse_bhk(value: str) -> int | None:
    match = re.search(r"\d+", value or "")
    return int(match.group()) if match else None


def _typed_filter(
    rows: list[dict],
    *,
    locality: str = "",
    bhk: str = "",
    transaction_type: str = "",
) -> list[dict]:
    """Structured params match typed fields only; free-text q stays broad.

    bhk compares the parsed BHK count (a post mentioning both 1 and 2 BHK
    in its source text must not surface as a 2 BHK unless the parsed flat
    is one). locality matches the parsed micro_market / location_raw /
    building_name fields, transaction_type the parsed transaction type.
    """
    want_bhk = _parse_bhk(bhk)
    want_txn = transaction_type.casefold().strip()
    locality_tokens = locality.casefold().split()

    def keep(row: dict) -> bool:
        if want_bhk is not None:
            try:
                if int(row.get("bhk")) != want_bhk:
                    return False
            except (TypeError, ValueError):
                return False
        if want_txn:
            if (row.get("transaction_type") or "").casefold().strip() != want_txn:
                return False
        if locality_tokens:
            hay = " ".join(
                str(row.get(field) or "")
                for field in ("micro_market", "location_raw", "building_name")
            ).casefold()
            compact = re.sub(r"\s+", "", hay)
            for token in locality_tokens:
                if token not in hay and token not in compact:
                    return False
        return True

    return [row for row in rows if keep(row)]


@router.get("/listings/search")
async def external_listing_search(
    q: str = "",
    locality: str = "",
    bhk: str = "",
    transaction_type: str = "",
    budget_max: int | None = None,
    limit: int = Query(20, ge=1, le=50),
    offset: int = Query(0, ge=0),
    key: dict = Depends(external_auth),
):
    if "inventory:read" not in (key.get("scopes") or []):
        raise HTTPException(403, "Token does not have inventory:read scope")
    txn = transaction_type.casefold().strip()
    if txn and txn not in {"rent", "sale"}:
        raise HTTPException(422, "transaction_type must be rent or sale")
    wanted_bhk = None
    if bhk.strip():
        try:
            wanted_bhk = float(bhk)
            if not math.isfinite(wanted_bhk) or wanted_bhk <= 0:
                raise ValueError
        except ValueError as exc:
            raise HTTPException(422, "bhk must be a positive number") from exc
    scope = None
    if locality.strip():
        try:
            reference = await asyncio.to_thread(
                _fetch_all, storage.client, "locality_reference",
                "id,sub_locality,parent_locality,canonical_locality,alternate_names,confidence",
            )
            scope = resolve_search_locality(locality, reference)
        except (AmbiguousLocality, ValueError) as exc:
            raise HTTPException(422, str(exc)) from exc
        except Exception as exc:
            raise HTTPException(503, "Locality reference is temporarily unavailable") from exc
    try:
        rows = await _tenant_parsed(
            limit=limit, offset=offset, kind="listing", search=q,
            assistant_search={"tenant_id": str(key["tenant_id"]), "locality_scope": scope, "bhk": wanted_bhk,
                              "transaction_type": txn, "budget_max": budget_max},
        )
    except Exception as exc:
        logger.warning("External listing search unavailable: %s", type(exc).__name__)
        raise HTTPException(503, "Listing search is temporarily unavailable") from exc
    rows = [_parsed_to_dict(row) for row in rows]
    await asyncio.to_thread(_record_assistant_trial_start, str(key["tenant_id"]))
    return {
        "results": [_public_listing(row) for row in rows], "count": len(rows), "offset": offset,
        "search_scope": {
            "locality": scope.as_dict() if scope else None,
            "candidate_scope": "bounded_recent_typed_rows_per_table",
            "max_candidates_per_table": 250,
            "exhaustive": False,
            "note": "Locality and BHK apply before the candidate bound; text and normalized budget filter before final pagination. Count is this page, not all matching inventory.",
        },
    }


@router.get("/requirements")
async def external_requirements(limit: int = Query(20, ge=1, le=50), offset: int = Query(0, ge=0), key: dict = Depends(external_auth)):
    if "requirements:read" not in (key.get("scopes") or []):
        raise HTTPException(403, "Token does not have requirements:read scope")
    rows = await _tenant_parsed(limit=limit, offset=offset, kind="requirement")
    await asyncio.to_thread(_record_assistant_trial_start, str(key["tenant_id"]))
    return {"results": [_public_requirement(row) for row in rows], "count": len(rows), "offset": offset}


@router.get("/matches")
async def external_matches(q: str = "", limit: int = Query(20, ge=1, le=50), key: dict = Depends(external_auth)):
    if "matches:read" not in (key.get("scopes") or []):
        raise HTTPException(403, "Token does not have matches:read scope")
    rows = await _tenant_parsed(limit=limit, offset=0, kind="listing", search=q)
    await asyncio.to_thread(_record_assistant_trial_start, str(key["tenant_id"]))
    return {"matches": [_public_listing(row) for row in rows], "count": len(rows), "query": q}


def _create_external_key(tenant_id: str, user_id: str, label: str, write_access: bool) -> tuple[dict, str]:
    """Mint one tenant-scoped external API key; returns (row, one-time token).

    Shared by the owner-driven Account → MCP route and the broker-approved
    connect-session flow so both produce identical key material and scopes.
    """
    token = KEY_PREFIX + secrets.token_urlsafe(32)
    scopes = sorted(DEFAULT_READ_SCOPES)
    if write_access:
        scopes.extend(sorted(WRITE_SCOPES | TOOL_WRITE_SCOPES))
    payload = {
        "tenant_id": tenant_id,
        "created_by": user_id,
        "label": label.strip()[:80] or "Instinct",
        "key_prefix": token[:13],
        "key_hash": _digest(token),
        "scopes": scopes,
    }
    try:
        # PropAI's lightweight Supabase adapter switches an insert builder
        # back to a SELECT when `.select(...)` is chained. Execute the insert
        # directly, then use a separate bounded read below.
        result = storage.client.table("external_agent_api_keys").insert(payload).execute()
        created = (result.data or [None])[0] if result else None
        # Some PostgREST/client combinations successfully insert but return
        # an empty representation. Read back by the unique hash so the UI
        # does not report a false failure after a committed insert.
        if not created:
            lookup = storage.client.table("external_agent_api_keys").select(
                "id,label,key_prefix,scopes,created_at"
            ).eq("key_hash", payload["key_hash"]).limit(1).execute()
            created = (lookup.data or [None])[0] if lookup else None
    except Exception as exc:
        logger.exception(
            "External API key creation failed; tenant=%s user_present=%s error_type=%s",
            bool(tenant_id), bool(user_id), type(exc).__name__,
        )
        raise HTTPException(500, "Could not create external API key") from exc
    if not created:
        logger.error(
            "External API key insert returned no row; tenant=%s user_present=%s",
            bool(tenant_id), bool(user_id),
        )
        raise HTTPException(500, "Could not create external API key")
    return created, token


@router.post("/keys")
async def create_external_key(body: ApiKeyCreate, user: dict = Depends(require_user), tenant_id: str = Depends(require_tenant)):
    created, token = _create_external_key(tenant_id, user["id"], body.label, body.write_access)
    return {"key": created, "token": token, "warning": "Save this token now. It will not be shown again."}


@router.get("/inventory")
async def external_inventory_search(q: str = "", limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0), key: dict = Depends(external_auth)):
    _require_scope(key, "inventory:read")
    query = storage.client.table("crm_inventory").select("*").eq("tenant_id", str(key["tenant_id"]))
    if q.strip():
        # Parameter-safe filter token; do not permit PostgREST filter syntax.
        needle = re.sub(r"[^\w +.-]", " ", q.strip())[:120]
        query = query.or_(f"building_name.ilike.%{needle}%,location.ilike.%{needle}%,contact_number.ilike.%{needle}%")
    rows = query.order("id").offset(offset).limit(limit).execute().data or []
    return {"private": True, "records": rows, "next_offset": offset + limit if len(rows) == limit else None}


@router.get("/inventory/{inventory_id}/photos")
async def external_inventory_photos(inventory_id: int, key: dict = Depends(external_auth)):
    _require_scope(key, "inventory:read")
    from private_crm_photos import photo_rows
    return {"private": True, "photos": photo_rows(storage.client, str(key["tenant_id"]), inventory_id)}


@router.get("/inventory/{inventory_id}/photos/{photo_id}")
async def external_inventory_photo(inventory_id: int, photo_id: int, key: dict = Depends(external_auth)):
    _require_scope(key, "inventory:read")
    from private_crm_photos import read_photo
    return read_photo(storage.client, str(key["tenant_id"]), inventory_id, photo_id)


@router.post("/inventory/{inventory_id}/photos")
async def external_attach_photo(inventory_id: int, request: Request, key: dict = Depends(external_auth)):
    from private_crm_photos import PHOTO_SCOPE, MAX_BYTES, inventory_target, save_photo, photo_audit_start, photo_audit_finish
    _require_scope(key, PHOTO_SCOPE)
    inventory_target(storage.client, str(key["tenant_id"]), inventory_id)
    if request.headers.get("content-type", "").split(";")[0] not in {"image/jpeg", "image/png", "image/webp"}:
        raise HTTPException(415, "Send one JPEG, PNG or WebP photo as the request body")
    content = bytearray()
    async for chunk in request.stream():
        content.extend(chunk)
        if len(content) > MAX_BYTES:
            raise HTTPException(413, "Photo must be at most 10 MB")
    audit = photo_audit_start(storage.client, str(key["tenant_id"]), key["id"], "attach_photo", {"inventory_id": inventory_id, "bytes": len(content)})
    try:
        result = await asyncio.to_thread(save_photo, storage.client, str(key["tenant_id"]), inventory_id, key["created_by"], bytes(content))
        photo_audit_finish(storage.client, str(key["tenant_id"]), audit, "succeeded", result)
        return {**result, "inventory_id": inventory_id}
    except Exception:
        photo_audit_finish(storage.client, str(key["tenant_id"]), audit, "failed")
        raise


@router.put("/keys/{key_id}/photo-access")
async def update_external_photo_access(key_id: str, body: ApiKeyWriteAccessUpdate, user: dict = Depends(require_user), tenant_id: str = Depends(require_tenant)):
    from private_crm_photos import PHOTO_SCOPE, photo_audit_start, photo_audit_finish
    await _require_org_permission(user, tenant_id, "manage_whatsapp")
    rows = storage.client.table("external_agent_api_keys").select("id,scopes").eq("id", key_id).eq("tenant_id", tenant_id).is_("revoked_at", "null").limit(1).execute().data or []
    if not rows:
        raise HTTPException(404, "Active external API key not found")
    scopes = sorted((set(rows[0].get("scopes") or []) - {PHOTO_SCOPE}) | ({PHOTO_SCOPE} if body.enabled else set()))
    audit = photo_audit_start(storage.client, tenant_id, key_id, "photo_permission_change", {"photo_access": body.enabled})
    result = storage.client.table("external_agent_api_keys").update({"scopes": scopes}).eq("id", key_id).eq("tenant_id", tenant_id).is_("revoked_at", "null").execute()
    if not result.data:
        photo_audit_finish(storage.client, tenant_id, audit, "failed")
        raise HTTPException(409, "Key changed; refresh and retry")
    photo_audit_finish(storage.client, tenant_id, audit, "succeeded", {"photo_access": body.enabled})
    return {"id": key_id, "scopes": scopes}


@router.post("/inventory")
async def external_create_inventory(
    body: dict,
    key: dict = Depends(external_auth),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
):
    """Create private CRM inventory for the token's tenant only.

    This is deliberately private CRM data, not market inventory. Publishing or
    turning it into source-backed market evidence remains a separate action.
    """
    _require_scope(key, "inventory:write")
    if idempotency_key and len(idempotency_key.strip()) > 160:
        raise HTTPException(422, "Idempotency-Key is too long")
    try:
        from routers.crm import _normalize_inventory_payload
        payload = _normalize_inventory_payload(body)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    normalized_idempotency_key = idempotency_key.strip() if idempotency_key else ""
    if normalized_idempotency_key:
        payload["_idempotency_key"] = normalized_idempotency_key
    sensitive_fields = _sensitive_fields(payload, SENSITIVE_INVENTORY_FIELDS)
    audit_id = str(key.get("_audit_id") or "") if key.get("_approval_granted") else _write_audit_start(key, "create", "crm_inventory", payload, sensitive_fields)
    if sensitive_fields and not key.get("_approval_granted"):
        approval = storage.client.table("external_agent_write_approvals").insert({
            "tenant_id": str(key["tenant_id"]),
            "audit_id": audit_id,
            "api_key_id": key.get("id"),
            "operation": "create",
            "entity_type": "crm_inventory",
            "payload": payload,
            "sensitive_fields": sensitive_fields,
        }).execute()
        approval_id = ((approval.data or [None])[0] or {}).get("id") if approval else None
        if not approval_id:
            _write_audit_finish(audit_id, "failed", error_code="approval_unavailable")
            raise HTTPException(503, "Approval request could not be created")
        _write_audit_finish(audit_id, "pending_approval")
        return JSONResponse(status_code=202, content={
            "ok": False, "private": True, "approval_required": True,
            "approval_id": str(approval_id), "audit_id": audit_id,
            "sensitive_fields": sensitive_fields,
        })
    custom_fields = dict(payload.get("custom_fields") or {})
    custom_fields["_external_agent"] = str(key.get("label") or "external_agent")[:80]
    if normalized_idempotency_key:
        existing = storage.client.table("crm_inventory").select("*").eq(
            "tenant_id", str(key["tenant_id"])
        ).contains("custom_fields", {"_idempotency_key": normalized_idempotency_key}).limit(1).execute()
        existing_row = (existing.data or [None])[0] if existing else None
        if existing_row:
            _write_audit_finish(audit_id, "succeeded", entity_id=str(existing_row.get("id") or ""), result={"idempotent_replay": True})
            return {"ok": True, "private": True, "entity": "crm_inventory", "record": existing_row, "idempotent_replay": True}
        custom_fields["_idempotency_key"] = normalized_idempotency_key
    payload.update({
        "tenant_id": str(key["tenant_id"]),
        "created_by": key.get("created_by"),
        "source": "external_agent",
        "custom_fields": custom_fields,
    })
    result = storage.client.table("crm_inventory").insert(payload).execute()
    row = (result.data or [None])[0] if result else None
    if not row:
        _write_audit_finish(audit_id, "failed", error_code="inventory_insert_empty")
        raise HTTPException(503, "Private inventory could not be saved")
    _write_audit_finish(audit_id, "succeeded", entity_id=str(row.get("id") or ""), result={"private": True})
    return {"ok": True, "private": True, "entity": "crm_inventory", "record": row}


@router.post("/requirements")
async def external_create_requirement(
    body: dict,
    key: dict = Depends(external_auth),
):
    """Create a tenant-scoped CRM requirement and client record."""
    _require_scope(key, "requirements:write")
    tenant_id = str(key["tenant_id"])
    raw_text = str(body.get("raw_text") or body.get("notes") or "").strip()
    name = str(body.get("name") or "External agent requirement").strip()[:200]
    phone = "".join(ch for ch in str(body.get("phone") or "") if ch.isdigit())[-15:] or None
    if len(raw_text) < 3 and not body.get("location_pref"):
        raise HTTPException(400, "raw_text or location_pref is required")
    sensitive_fields = _sensitive_fields(body, SENSITIVE_REQUIREMENT_FIELDS)
    audit_id = str(key.get("_audit_id") or "") if key.get("_approval_granted") else _write_audit_start(key, "create", "client_requirements", body, sensitive_fields)
    if sensitive_fields and not key.get("_approval_granted"):
        approval = storage.client.table("external_agent_write_approvals").insert({
            "tenant_id": tenant_id,
            "audit_id": audit_id,
            "api_key_id": key.get("id"),
            "operation": "create",
            "entity_type": "client_requirements",
            "payload": body,
            "sensitive_fields": sensitive_fields,
        }).execute()
        approval_id = ((approval.data or [None])[0] or {}).get("id") if approval else None
        if not approval_id:
            _write_audit_finish(audit_id, "failed", error_code="approval_unavailable")
            raise HTTPException(503, "Approval request could not be created")
        _write_audit_finish(audit_id, "pending_approval")
        return JSONResponse(status_code=202, content={
            "ok": False, "private": True, "approval_required": True,
            "approval_id": str(approval_id), "audit_id": audit_id,
            "sensitive_fields": sensitive_fields,
        })
    clients = storage.client.table("clients").select("id").eq("tenant_id", tenant_id)
    if phone:
        clients = clients.eq("phone", phone)
    client_rows = clients.limit(1).execute().data or []
    client_id = client_rows[0]["id"] if client_rows else None
    if client_id is None:
        client = storage.client.table("clients").insert({
            "tenant_id": tenant_id,
            "name": name,
            "phone": phone,
            "notes": raw_text,
            "status": "active",
        }).execute()
        client_id = ((client.data or [None])[0] or {}).get("id")
    if client_id is None:
        _write_audit_finish(audit_id, "failed", error_code="client_insert_empty")
        raise HTTPException(503, "Client record could not be saved")
    requirement = storage.client.table("client_requirements").insert({
        "tenant_id": tenant_id,
        "client_id": client_id,
        "intent": "requirement",
        "bhk": ", ".join(str(item) for item in (body.get("bhk_preference") or [])[:20]) or None,
        "price_min": body.get("budget_min"),
        "price_max": body.get("budget_max"),
        "micro_market": body.get("location_pref"),
        "area_sqft_min": body.get("area_min_sqft"),
        "area_sqft_max": body.get("area_max_sqft"),
        "notes": raw_text,
        "is_primary": True,
    }).execute()
    row = (requirement.data or [None])[0] if requirement else None
    if not row:
        _write_audit_finish(audit_id, "failed", error_code="requirement_insert_empty")
        raise HTTPException(503, "Requirement could not be saved")
    _write_audit_finish(audit_id, "succeeded", entity_id=str(row.get("id") or ""), result={"client_id": client_id, "private": True})
    return {"ok": True, "private": True, "entity": "client_requirements", "client_id": client_id, "record": row}


@router.get("/standing-searches")
async def external_list_standing_searches(key: dict = Depends(external_auth)):
    _require_scope(key, "standing_searches:read")
    rows = await asyncio.to_thread(storage.list_saved_market_searches, str(key["tenant_id"]))
    return {"searches": rows, "count": len(rows), "tenant_scoped": True}


@router.post("/standing-searches")
async def external_create_standing_search(
    body: StandingSearchCreate, key: dict = Depends(external_auth),
):
    _require_scope(key, "standing_searches:write")
    if not body.confirmed:
        raise HTTPException(409, "Standing-search creation requires explicit confirmation")
    try:
        row = await asyncio.to_thread(
            storage.create_saved_market_search,
            str(key["tenant_id"]), body.name, body.query_text, body.filters,
            created_by=str(key.get("created_by") or "") or None,
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"ok": True, "private": True, "search": row}


@router.get("/standing-searches/{search_id}/run")
async def external_run_standing_search(
    search_id: int, limit: int = Query(20, ge=1, le=100), key: dict = Depends(external_auth),
):
    _require_scope(key, "standing_searches:read")
    tenant_id = str(key["tenant_id"])
    result = storage.client.table("saved_market_searches").select(
        "id,tenant_id,name,query_text,filters,saved_at,last_viewed_at,last_seen_record_at"
    ).eq("tenant_id", tenant_id).eq("id", search_id).limit(1).execute()
    search = (result.data or [None])[0] if result else None
    if not search:
        raise HTTPException(404, "Standing search not found")
    rows = await _tenant_parsed(limit=limit, offset=0, kind="listing", search=search["query_text"])
    await asyncio.to_thread(_record_assistant_trial_start, tenant_id)
    storage.client.table("saved_market_searches").update({
        "last_viewed_at": datetime.now(timezone.utc).isoformat(),
    }).eq("tenant_id", tenant_id).eq("id", search_id).execute()
    return {"search": search, "results": [_public_listing(row) for row in rows], "count": len(rows)}


@router.get("/automatch/{requirement_id}")
async def external_automatch_requirement(
    requirement_id: int, limit: int = Query(20, ge=1, le=50), key: dict = Depends(external_auth),
):
    """Return existing tenant-local suggestions; never creates matches or contacts anyone."""
    _require_scope(key, "automatch:read")
    tenant_id = str(key["tenant_id"])
    requirement = storage.client.table("requirements_unified_matching").select(
        "id,matching_id,req_type,building_name,micro_market,bhk_options,budget_min,budget_max,status,created_at"
    ).eq("tenant_id", tenant_id).eq("id", requirement_id).limit(1).execute()
    req = (requirement.data or [None])[0] if requirement else None
    if not req:
        raise HTTPException(404, "Requirement not found")
    matches = storage.client.table("requirement_matches").select(
        "id,requirement_type,requirement_typed_id,listing_type,listing_typed_id,match_score,bhk_match,market_match,price_match,building_match"
    ).eq("tenant_id", tenant_id).eq("requirement_typed_id", requirement_id).order(
        "match_score", desc=True
    ).limit(limit).execute()
    rows = matches.data or []
    return {
        "requirement": req,
        "suggestions": rows,
        "count": len(rows),
        "mode": "existing_matches_only",
        "explanation": "Suggestions are tenant-local matcher rows. No CRM, messaging, publishing, or matching mutation was performed.",
    }


@router.get("/workspace/attention")
async def external_workspace_attention(key: dict = Depends(external_auth)):
    _require_scope(key, "workspace:attention")
    tenant_id = str(key["tenant_id"])
    followups = storage.client.table("follow_ups").select(
        "id,title,due_date,due_time,follow_up_type,status,notes,client_id,building_name,created_at"
    ).eq("tenant_id", tenant_id).in_("status", ["pending", "open", "drafted"]).order(
        "due_date", desc=False
    ).limit(50).execute()
    searches = await asyncio.to_thread(storage.list_saved_market_searches, tenant_id)
    return {
        "attention": {
            "open_followups": followups.data or [],
            "standing_searches": searches,
            "counts": {"open_followups": len(followups.data or []), "standing_searches": len(searches)},
        },
        "tenant_scoped": True,
        "outbound_actions": "not performed",
    }


@router.get("/followups")
async def external_list_followups(key: dict = Depends(external_auth)):
    _require_scope(key, "followups:read")
    result = storage.client.table("follow_ups").select(
        "id,title,due_date,due_time,follow_up_type,status,notes,client_id,message_id,building_name,created_at"
    ).eq("tenant_id", str(key["tenant_id"])).order("due_date", desc=False).limit(100).execute()
    return {"followups": result.data or [], "count": len(result.data or []), "private": True}


@router.post("/followups")
async def external_create_followup(body: FollowupCreate, key: dict = Depends(external_auth)):
    _require_scope(key, "followups:write")
    payload = body.model_dump(mode="json")
    payload.update({"tenant_id": str(key["tenant_id"]), "status": "pending"})
    result = storage.client.table("follow_ups").insert(payload).execute()
    row = (result.data or [None])[0] if result else None
    if not row:
        raise HTTPException(503, "Private follow-up could not be saved")
    return {"ok": True, "private": True, "outbound_sent": False, "followup": row}


@router.get("/approvals")
async def list_external_write_approvals(
    user: dict = Depends(require_user), tenant_id: str = Depends(require_tenant),
):
    await _require_org_permission(user, tenant_id, "manage_whatsapp")
    result = storage.client.table("external_agent_write_approvals").select(
        "id,audit_id,operation,entity_type,payload,sensitive_fields,status,requested_at,decided_at,decision_note"
    ).eq("tenant_id", tenant_id).eq("status", "pending").order("requested_at", desc=True).limit(100).execute()
    return {"approvals": result.data or []}


@router.post("/approvals/{approval_id}/decision")
async def decide_external_write_approval(
    approval_id: str,
    body: ApprovalDecision,
    user: dict = Depends(require_user), tenant_id: str = Depends(require_tenant),
):
    await _require_org_permission(user, tenant_id, "manage_whatsapp")
    result = storage.client.table("external_agent_write_approvals").select(
        "*"
    ).eq("id", approval_id).eq("tenant_id", tenant_id).eq("status", "pending").limit(1).execute()
    approval = (result.data or [None])[0] if result else None
    if not approval:
        raise HTTPException(404, "Pending approval not found")
    now = datetime.now(timezone.utc).isoformat()
    update = storage.client.table("external_agent_write_approvals").update({
        "status": "approved" if body.approved else "rejected",
        "decided_at": now,
        "decided_by": user["id"],
        "decision_note": body.note.strip()[:500],
    }).eq("id", approval_id).eq("tenant_id", tenant_id).eq("status", "pending").execute()
    if not update.data:
        raise HTTPException(409, "Approval was already decided")
    if not body.approved:
        _write_audit_finish(str(approval["audit_id"]), "rejected", error_code="owner_rejected")
        return {"ok": True, "approved": False, "approval_id": approval_id}

    key_result = storage.client.table("external_agent_api_keys").select(
        "id,tenant_id,created_by,label,scopes,expires_at,revoked_at"
    ).eq("id", approval.get("api_key_id")).eq("tenant_id", tenant_id).is_("revoked_at", "null").limit(1).execute()
    key = (key_result.data or [None])[0] if key_result else None
    if not key:
        _write_audit_finish(str(approval["audit_id"]), "failed", error_code="key_revoked")
        raise HTTPException(409, "The external key was revoked before approval was applied")
    key["_approval_granted"] = True
    key["_audit_id"] = str(approval["audit_id"])
    payload = approval.get("payload") or {}
    if approval.get("entity_type") == "crm_inventory":
        record = await external_create_inventory(payload, key, payload.get("_idempotency_key"))
    elif approval.get("entity_type") == "client_requirements":
        record = await external_create_requirement(payload, key)
    else:
        _write_audit_finish(str(approval["audit_id"]), "failed", error_code="unsupported_entity")
        raise HTTPException(400, "Unsupported approval entity")
    return {"ok": True, "approved": True, "approval_id": approval_id, "result": record}


@router.get("/dm-consent")
async def get_external_dm_consent(
    user: dict = Depends(require_user), tenant_id: str = Depends(require_tenant)
):
    await _require_org_permission(user, tenant_id, "manage_whatsapp")
    result = storage.client.table("organizations").select(
        "external_agent_dms_enabled,external_agent_dms_consented_at,external_agent_dms_consented_by"
    ).eq("id", tenant_id).limit(1).execute()
    row = (result.data or [None])[0] if result else None
    if not row:
        raise HTTPException(404, "Workspace not found")
    return {
        "enabled": bool(row.get("external_agent_dms_enabled")),
        "consented_at": row.get("external_agent_dms_consented_at"),
        "consented_by": bool(row.get("external_agent_dms_consented_by")),
    }


@router.put("/dm-consent")
async def update_external_dm_consent(
    body: DmConsentUpdate,
    user: dict = Depends(require_user), tenant_id: str = Depends(require_tenant),
):
    await _require_org_permission(user, tenant_id, "manage_whatsapp")
    now = datetime.now(timezone.utc).isoformat()
    payload = {
        "external_agent_dms_enabled": body.enabled,
        "external_agent_dms_consented_at": now if body.enabled else None,
        "external_agent_dms_consented_by": user["id"] if body.enabled else None,
    }
    updated = storage.client.table("organizations").update(payload).eq("id", tenant_id).execute()
    if not updated.data:
        raise HTTPException(404, "Workspace not found")

    keys = storage.client.table("external_agent_api_keys").select("id,scopes").eq(
        "tenant_id", tenant_id
    ).is_("revoked_at", "null").execute().data or []
    for key in keys:
        scopes = [scope for scope in (key.get("scopes") or []) if scope != "raw_messages:dms"]
        if body.enabled:
            scopes.append("raw_messages:dms")
        storage.client.table("external_agent_api_keys").update(
            {"scopes": scopes}
        ).eq("id", key["id"]).eq("tenant_id", tenant_id).execute()
    return {"enabled": body.enabled, "updated_keys": len(keys)}


@router.get("/keys")
async def list_external_keys(user: dict = Depends(require_user), tenant_id: str = Depends(require_tenant)):
    result = storage.client.table("external_agent_api_keys").select(
        "id,label,key_prefix,scopes,expires_at,last_used_at,revoked_at,created_at"
    ).eq("tenant_id", tenant_id).order("created_at", desc=True).execute()
    return {"keys": result.data or []}


@router.get("/connection-status")
async def external_connection_status(user: dict = Depends(require_user), tenant_id: str = Depends(require_tenant)):
    """Truthful assistant-connection status for owner-facing UI.

    Binds to the latest decided connect session's key rather than merging
    every key on the workspace, so a tenant with several manual keys does not
    show an optimistic aggregate. Manually created keys have no session
    binding and are counted, not claimed as the assistant connection."""
    org_result = storage.client.table("organizations").select(
        "external_agent_dms_enabled,external_agent_dms_consented_at"
    ).eq("id", tenant_id).limit(1).execute()
    org = (org_result.data or [None])[0] if org_result else None
    dm_consent = bool(org and org.get("external_agent_dms_enabled"))

    session_result = storage.client.table("external_agent_connect_sessions").select(
        "id,status,label,api_key_id,decided_at"
    ).eq("tenant_id", tenant_id).in_("status", ["approved", "consumed"]).order("decided_at", desc=True).limit(1).execute()
    session = (session_result.data or [None])[0] if session_result else None

    connection = None
    bound_key_id = session.get("api_key_id") if session else None
    if session and bound_key_id:
        key_result = storage.client.table("external_agent_api_keys").select(
            "id,label,key_prefix,scopes,last_used_at,revoked_at,created_at"
        ).eq("id", bound_key_id).eq("tenant_id", tenant_id).limit(1).execute()
        bound = (key_result.data or [None])[0] if key_result else None
        scopes = list(bound.get("scopes") or []) if bound else []
        # A revoked key has no effective capabilities, whatever its stored
        # scopes say: owner-facing status must never show green for it.
        revoked = bool(bound and bound.get("revoked_at"))
        connection = {
            "label": session.get("label") or "Instinct",
            "key_id": str(bound_key_id),
            "key_prefix": (bound or {}).get("key_prefix"),
            "key_revoked": revoked,
            "scopes": scopes,
            "can_read_groups": not revoked and "raw_messages:read" in scopes,
            "can_read_dms": not revoked and dm_consent and "raw_messages:dms" in scopes,
            "can_write_private_crm": not revoked and bool(WRITE_SCOPES & set(scopes)),
            "last_used_at": (bound or {}).get("last_used_at"),
        }

    active_keys = storage.client.table("external_agent_api_keys").select(
        "id"
    ).eq("tenant_id", tenant_id).is_("revoked_at", "null").execute().data or []
    unbound = len([row for row in active_keys if str(row.get("id")) != str(bound_key_id or "")])
    return {
        "dm_consent_enabled": dm_consent,
        "dm_consented_at": (org or {}).get("external_agent_dms_consented_at"),
        "connection": connection,
        "unbound_active_keys": unbound,
    }


@router.put("/keys/{key_id}/write-access")
async def update_external_key_write_access(
    key_id: str,
    body: ApiKeyWriteAccessUpdate,
    user: dict = Depends(require_user),
    tenant_id: str = Depends(require_tenant),
):
    """Grant or remove private CRM write scopes on one existing key."""
    await _require_org_permission(user, tenant_id, "manage_whatsapp")
    result = storage.client.table("external_agent_api_keys").select(
        "id,scopes"
    ).eq("id", key_id).eq("tenant_id", tenant_id).is_("revoked_at", "null").limit(1).execute()
    key = (result.data or [None])[0] if result else None
    if not key:
        raise HTTPException(404, "Active external API key not found")

    scopes = list(key.get("scopes") or [])
    scopes = [scope for scope in scopes if scope not in (WRITE_SCOPES | TOOL_WRITE_SCOPES)]
    if body.enabled:
        scopes.extend(sorted(WRITE_SCOPES | TOOL_WRITE_SCOPES))
    audit_id = _write_audit_start({"tenant_id": tenant_id, "id": key_id}, "permission_change", "external_agent_api_key", {"key_id": key_id, "enabled": body.enabled}, [])
    updated = storage.client.table("external_agent_api_keys").update(
        {"scopes": scopes}
    ).eq("id", key_id).eq("tenant_id", tenant_id).is_("revoked_at", "null").execute()
    if not updated.data:
        _write_audit_finish(audit_id, "failed", error_code="key_update_empty")
        raise HTTPException(409, "External API key changed; refresh the key list and retry")
    _write_audit_finish(audit_id, "succeeded", entity_id=key_id, result={"enabled": body.enabled})
    return {"id": key_id, "scopes": scopes}


class ApiKeyDmAccessUpdate(BaseModel):
    enabled: bool = True


@router.put("/keys/{key_id}/dm-access")
async def update_external_key_dm_access(
    key_id: str,
    body: ApiKeyDmAccessUpdate,
    user: dict = Depends(require_user),
    tenant_id: str = Depends(require_tenant),
):
    """Grant or remove the private-DM read scope on one existing key.

    Deliberate per-key opt-in: workspace consent alone never adds DM read to
    a key, and this control never touches any other key. Enabling requires
    the workspace consent switch to be on; disabling it there removes the
    scope from every key as before."""
    await _require_org_permission(user, tenant_id, "manage_whatsapp")
    if body.enabled:
        consent = storage.client.table("organizations").select(
            "external_agent_dms_enabled"
        ).eq("id", tenant_id).limit(1).execute()
        org = (consent.data or [None])[0] if consent else None
        if not org or not org.get("external_agent_dms_enabled"):
            raise HTTPException(409, "Workspace private DM consent is off. Enable it before granting DM read to a key.")
    result = storage.client.table("external_agent_api_keys").select(
        "id,scopes"
    ).eq("id", key_id).eq("tenant_id", tenant_id).is_("revoked_at", "null").limit(1).execute()
    key = (result.data or [None])[0] if result else None
    if not key:
        raise HTTPException(404, "Active external API key not found")
    scopes = [scope for scope in (key.get("scopes") or []) if scope != "raw_messages:dms"]
    if body.enabled:
        scopes.append("raw_messages:dms")
    audit_id = _write_audit_start({"tenant_id": tenant_id, "id": key_id}, "permission_change", "external_agent_api_key", {"key_id": key_id, "dm_access": body.enabled}, [])
    updated = storage.client.table("external_agent_api_keys").update(
        {"scopes": scopes}
    ).eq("id", key_id).eq("tenant_id", tenant_id).is_("revoked_at", "null").execute()
    if not updated.data:
        _write_audit_finish(audit_id, "failed", error_code="key_update_empty")
        raise HTTPException(409, "External API key changed; refresh the key list and retry")
    _write_audit_finish(audit_id, "succeeded", entity_id=key_id, result={"dm_access": body.enabled})
    return {"id": key_id, "scopes": scopes}


@router.delete("/keys/{key_id}")
async def revoke_external_key(key_id: str, user: dict = Depends(require_user), tenant_id: str = Depends(require_tenant)):
    await _require_org_permission(user, tenant_id, "manage_whatsapp")
    audit_id = _write_audit_start({"tenant_id": tenant_id, "id": key_id}, "revoke", "external_agent_api_key", {"key_id": key_id}, [])
    result = storage.client.table("external_agent_api_keys").update(
        {"revoked_at": datetime.now(timezone.utc).isoformat()}
    ).eq("id", key_id).eq("tenant_id", tenant_id).execute()
    if not result.data:
        _write_audit_finish(audit_id, "failed", error_code="key_revoke_empty")
        raise HTTPException(404, "External API key not found")
    _write_audit_finish(audit_id, "succeeded", entity_id=key_id, result={"revoked": True})
    return {"ok": True, "revoked": True}


@router.post("/keys/{key_id}/rotate")
async def rotate_external_key(
    key_id: str,
    user: dict = Depends(require_user),
    tenant_id: str = Depends(require_tenant),
):
    """Issue a replacement secret and revoke the old secret immediately."""
    await _require_org_permission(user, tenant_id, "manage_whatsapp")
    old_result = storage.client.table("external_agent_api_keys").select(
        "id,label,scopes"
    ).eq("id", key_id).eq("tenant_id", tenant_id).is_("revoked_at", "null").limit(1).execute()
    old_key = (old_result.data or [None])[0] if old_result else None
    if not old_key:
        raise HTTPException(404, "Active external API key not found")
    audit_key = {"tenant_id": tenant_id, "id": key_id}
    audit_id = _write_audit_start(audit_key, "rotate", "external_agent_api_key", {"key_id": key_id}, [])
    token = KEY_PREFIX + secrets.token_urlsafe(32)
    created = storage.client.table("external_agent_api_keys").insert({
        "tenant_id": tenant_id,
        "created_by": user["id"],
        "label": old_key.get("label") or "Instinct",
        "key_prefix": token[:13],
        "key_hash": _digest(token),
        "scopes": old_key.get("scopes") or [],
    }).execute()
    replacement = (created.data or [None])[0] if created else None
    if not replacement:
        _write_audit_finish(audit_id, "failed", error_code="replacement_insert_empty")
        raise HTTPException(503, "Replacement external API key could not be created")
    revoked = storage.client.table("external_agent_api_keys").update({
        "revoked_at": datetime.now(timezone.utc).isoformat(),
        "replaced_by": replacement.get("id"),
    }).eq("id", key_id).eq("tenant_id", tenant_id).is_("revoked_at", "null").execute()
    if not revoked.data:
        _write_audit_finish(audit_id, "failed", error_code="old_key_revoke_empty")
        raise HTTPException(409, "Could not revoke the old key; rotate again after refreshing")
    _write_audit_finish(audit_id, "succeeded", entity_id=str(replacement.get("id") or ""), result={"old_key_revoked": True})
    return {"ok": True, "key": replacement, "token": token, "warning": "The old token is revoked. Save this replacement now; it will not be shown again."}


# --- Broker-approved connect sessions --------------------------------------
# Device-style flow so a broker can grant an external agent access without
# copying an API key by hand. The agent creates a session and shows the broker
# a short link; the broker signs in and approves on the app's connect page;
# the agent polls with its device code and receives the minted token exactly
# once. Session rows expire quickly and never bypass the owner controls above.

CONNECT_SESSION_TTL_SECONDS = 900
CONNECT_POLL_INTERVAL_SECONDS = 5
CONNECT_USER_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
FRONTEND_APP_URL = os.getenv("FRONTEND_URL", "https://app.propai.live").rstrip("/")


def _connect_seal_key() -> bytes:
    """Server-side key sealing uncollected connect tokens at rest.

    Set CONNECT_SESSION_SECRET in the API environment; falls back to the
    already-deployed Supabase service key so a database snapshot alone does
    not expose an uncollected token.
    """
    secret = os.getenv("CONNECT_SESSION_SECRET") or os.getenv("SUPABASE_SERVICE_KEY")
    if not secret:
        raise HTTPException(503, "Connect token sealing is not configured")
    return hashlib.sha256(f"connect-session-seal:{secret}".encode("utf-8")).digest()


def _seal_token(token: str) -> str:
    key = _connect_seal_key()
    data = token.encode("utf-8")
    stream = b""
    counter = 0
    while len(stream) < len(data):
        stream += hmac.new(key, str(counter).encode("utf-8"), hashlib.sha256).digest()
        counter += 1
    return base64.urlsafe_b64encode(bytes(a ^ b for a, b in zip(data, stream))).decode("ascii")


def _unseal_token(sealed: str) -> str:
    key = _connect_seal_key()
    data = base64.urlsafe_b64decode(sealed.encode("ascii"))
    stream = b""
    counter = 0
    while len(stream) < len(data):
        stream += hmac.new(key, str(counter).encode("utf-8"), hashlib.sha256).digest()
        counter += 1
    return bytes(a ^ b for a, b in zip(data, stream)).decode("utf-8")


def _prune_connect_sessions() -> None:
    """Best-effort removal of expired sessions so uncollected secrets do not
    linger. Expired rows are also rejected at read time; this just bounds the
    residue."""
    try:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        storage.client.table("external_agent_connect_sessions").delete().lt("expires_at", cutoff).execute()
    except Exception:
        logger.warning("Connect session prune failed", exc_info=True)


class ConnectSessionCreate(BaseModel):
    label: str = "Instinct"
    write_access: bool = False


def _generate_user_code() -> str:
    body = "".join(secrets.choice(CONNECT_USER_CODE_CHARS) for _ in range(8))
    return f"{body[:4]}-{body[4:]}"


def _connect_session_by_user_code(user_code: str, *, allow_expired: bool = False) -> dict:
    code = (user_code or "").strip().upper()
    result = storage.client.table("external_agent_connect_sessions").select(
        "id,status,label,write_access,expires_at,tenant_id,approved_by,api_key_id"
    ).eq("user_code", code).limit(1).execute()
    row = (result.data or [None])[0] if result else None
    if not row:
        raise HTTPException(404, "Connect session not found")
    try:
        expired = datetime.fromisoformat(str(row.get("expires_at")).replace("Z", "+00:00")) <= datetime.now(timezone.utc)
    except ValueError:
        expired = True
    if expired and not allow_expired:
        raise HTTPException(410, "Connect session expired; start a new connection from the agent")
    return row


@router.post("/connect/sessions", status_code=201)
async def create_connect_session(body: ConnectSessionCreate):
    """Agent-facing: start a broker-approved connection.

    Unauthenticated on purpose: the agent has no key yet. The device code is
    stored only as a hash, and the short user code is shown to the broker on
    the connect URL; approving always requires a signed-in owner session, so a
    guessed code cannot grant access to the guesser.
    """
    _prune_connect_sessions()
    device_code = secrets.token_urlsafe(32)
    user_code = _generate_user_code()
    try:
        storage.client.table("external_agent_connect_sessions").insert({
            "device_code_hash": _digest(device_code),
            "user_code": user_code,
            "label": body.label.strip()[:80] or "Instinct",
            "write_access": bool(body.write_access),
            "expires_at": (datetime.now(timezone.utc) + timedelta(seconds=CONNECT_SESSION_TTL_SECONDS)).isoformat(),
        }).execute()
    except Exception as exc:
        logger.exception("Connect session creation failed; error_type=%s", type(exc).__name__)
        raise HTTPException(503, "Could not allocate a connect session") from exc
    return {
        "device_code": device_code,
        "user_code": user_code,
        "connect_url": f"{FRONTEND_APP_URL}/connect?code={user_code}",
        "expires_in": CONNECT_SESSION_TTL_SECONDS,
        "interval": CONNECT_POLL_INTERVAL_SECONDS,
    }


@router.get("/connect/sessions/{device_code}")
async def poll_connect_session(device_code: str):
    """Agent-facing poll. Returns the minted token exactly once."""
    result = storage.client.table("external_agent_connect_sessions").select(
        "id,status,token,expires_at"
    ).eq("device_code_hash", _digest(device_code.strip())).limit(1).execute()
    row = (result.data or [None])[0] if result else None
    if not row:
        raise HTTPException(404, "Connect session not found")
    try:
        expired = datetime.fromisoformat(str(row.get("expires_at")).replace("Z", "+00:00")) <= datetime.now(timezone.utc)
    except ValueError:
        expired = True
    if row.get("status") == "approved" and expired:
        # The minted key was never collected; the session is dead. The owner
        # can revoke the orphaned key in Account → MCP; a new session mints a
        # fresh one.
        storage.client.table("external_agent_connect_sessions").update({
            "status": "expired", "token": None,
        }).eq("id", row["id"]).eq("status", "approved").execute()
        raise HTTPException(410, "Connect session expired before the token was collected; start a new connection")
    if expired and row.get("status") == "pending":
        raise HTTPException(410, "Connect session expired; start a new connection")
    if row.get("status") == "pending":
        return JSONResponse(status_code=202, content={"status": "pending", "interval": CONNECT_POLL_INTERVAL_SECONDS})
    if row.get("status") == "denied":
        raise HTTPException(403, "The broker declined this connection")
    if row.get("status") == "approved":
        sealed = row.get("token")
        if not sealed:
            raise HTTPException(409, "Connect session token already collected")
        consumed = storage.client.table("external_agent_connect_sessions").update({
            "status": "consumed", "token": None,
        }).eq("id", row["id"]).eq("status", "approved").execute()
        if not consumed.data:
            raise HTTPException(409, "Connect session token already collected")
        return {"status": "approved", "token": _unseal_token(sealed), "warning": "Save this token now. It will not be shown again."}
    raise HTTPException(410, "Connect session expired; start a new connection")


@router.get("/connect/sessions/by-code/{user_code}")
async def preview_connect_session(user_code: str, user: dict = Depends(require_user), tenant_id: str = Depends(require_tenant)):
    """Broker-facing: what the signed-in connect page renders before deciding."""
    row = _connect_session_by_user_code(user_code, allow_expired=True)
    state = row.get("status")
    # Terminal state belongs only to the person/workspace that decided it.
    if state != "pending" and (row.get("tenant_id") != tenant_id or row.get("approved_by") != user.get("id")):
        raise HTTPException(404, "Connect session not found")
    result = {"label": row.get("label") or "Instinct", "write_access": bool(row.get("write_access")), "scopes": []}
    # Fixed known destination, never a caller-controlled redirect or a secret-bearing URL.
    if result["label"].strip().casefold() == "instinct":
        result["return_url"] = "https://wa.me/16508702892"
    if state in {"approved", "consumed"}:
        key = storage.client.table("external_agent_api_keys").select("id,revoked_at,expires_at").eq("id", row.get("api_key_id")).eq("tenant_id", tenant_id).limit(1).execute()
        key_row = (key.data or [None])[0] if key else None
        if not key_row or key_row.get("revoked_at"):
            return {**result, "status": "revoked"}
        key_expiry = key_row.get("expires_at")
        if key_expiry and datetime.fromisoformat(str(key_expiry).replace("Z", "+00:00")) <= datetime.now(timezone.utc):
            return {**result, "status": "expired"}
        # A collected key remains valid after its short approval link expires.
        if state == "consumed":
            return {**result, "status": "connected"}
    if datetime.fromisoformat(str(row["expires_at"]).replace("Z", "+00:00")) <= datetime.now(timezone.utc):
        return {**result, "status": "expired"}
    if state in {"approved", "denied", "approving", "expired"}:
        return {**result, "status": state}
    if state != "pending":
        raise HTTPException(409, "Connect session is not available")
    scopes = sorted(DEFAULT_READ_SCOPES)
    if row.get("write_access"):
        scopes.extend(sorted(WRITE_SCOPES | TOOL_WRITE_SCOPES))
    return {**result, "status": "pending", "scopes": scopes}


@router.post("/connect/sessions/by-code/{user_code}/approve")
async def approve_connect_session(user_code: str, user: dict = Depends(require_user), tenant_id: str = Depends(require_tenant)):
    """Broker-facing: mint a key for the waiting agent.

    Uses the same org permission gate as key rotation, since approving grants
    a credential against the workspace. The minted token is stored on the
    session row and returned to the agent exactly once via the device poll.
    """
    await _require_org_permission(user, tenant_id, "manage_whatsapp")
    row = _connect_session_by_user_code(user_code)
    if row.get("status") != "pending":
        raise HTTPException(409, "Connect session already decided")
    claimed = storage.client.table("external_agent_connect_sessions").update({
        "status": "approving",
    }).eq("id", row["id"]).eq("status", "pending").execute()
    if not claimed.data:
        raise HTTPException(409, "Connect session already decided")
    created, token = _create_external_key(tenant_id, user["id"], row.get("label") or "Instinct", bool(row.get("write_access")))
    updated = storage.client.table("external_agent_connect_sessions").update({
        "status": "approved",
        "tenant_id": tenant_id,
        "approved_by": user["id"],
        "api_key_id": created.get("id"),
        "token": _seal_token(token),
        "decided_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", row["id"]).execute()
    if not updated.data:
        raise HTTPException(503, "Could not record the approval; the agent can start a new session")
    return {"ok": True, "approved": True, "key": created}


@router.post("/connect/sessions/by-code/{user_code}/deny")
async def deny_connect_session(user_code: str, user: dict = Depends(require_user), tenant_id: str = Depends(require_tenant)):
    row = _connect_session_by_user_code(user_code)
    if row.get("status") != "pending":
        raise HTTPException(409, "Connect session already decided")
    storage.client.table("external_agent_connect_sessions").update({
        "status": "denied",
        "tenant_id": tenant_id,
        "approved_by": user["id"],
        "decided_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", row["id"]).execute()
    return {"ok": True, "approved": False}


def _parsed_to_dict(row: object) -> dict:
    """get_parsed returns ParsedObservation dataclasses despite its dict
    annotation; this REST surface speaks plain dicts."""
    if isinstance(row, dict):
        return row
    if is_dataclass(row) and not isinstance(row, type):
        return asdict(row)
    return dict(row)


async def _tenant_parsed(*, limit: int, offset: int, kind: str, search: str = "", assistant_search: dict | None = None) -> list[dict]:
    options = {"assistant_search": assistant_search} if assistant_search is not None else {}
    rows = await asyncio.to_thread(
        storage.get_parsed, limit=limit, offset=offset, kind=kind, search=search, **options
    )
    return [_parsed_to_dict(row) for row in rows]


def _numeric_price(row: dict) -> float | None:
    for key in ("price", "monthly_rent", "total_asking_price"):
        try:
            value = float(row.get(key))
            if value > 0:
                return value
        except (TypeError, ValueError):
            continue
    return None


def _public_listing(row: dict) -> dict:
    return {key: row.get(key) for key in (
        "id", "raw_message_id", "building_name", "micro_market", "location_raw",
        "bhk", "area_sqft", "price", "price_unit", "monthly_rent", "transaction_type",
        "locality_id", "locality_sub_locality", "locality_parent_locality",
        "furnishing", "broker_name", "broker_phone", "last_seen", "created_at",
    )}


def _public_requirement(row: dict) -> dict:
    return {key: row.get(key) for key in (
        "id", "raw_message_id", "building_name", "micro_market", "bhk",
        "budget_min", "budget_max", "area_min_sqft", "area_max_sqft", "created_at",
    )}
