"""
Shared dependencies for all routers.

- storage reference (set by app.py lifespan before any request)
- Auth / tenant helpers (JWT verification, Depends chains)
- _run_workspace_agent (imported by ai_chat, self_chat, business_api)
- Other helpers used by 2+ routers
"""
import asyncio
import contextvars
import hmac
import logging
import os
import re
import uuid
from typing import Any

from fastapi import Depends, Header, HTTPException, Security
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from storage.base import Storage
from storage import set_tenant_id, get_tenant_id

import jwt as pyjwt

logger = logging.getLogger(__name__)

# ── Storage reference (set by app.py lifespan) ──────────────────────────
storage: Storage | None = None

# ── Auth / Tenant helpers ──────────────────────────────────────────────

SUPABASE_JWT_SECRET = os.getenv("SUPABASE_JWT_SECRET", "")
SUPABASE_URL_AUTH = os.getenv("SUPABASE_URL", "")

_jwks_client = None
if SUPABASE_URL_AUTH:
    try:
        _jwks_client = pyjwt.PyJWKClient(f"{SUPABASE_URL_AUTH}/auth/v1/.well-known/jwks.json")
        print(f"  [auth] JWKS client initialized from {SUPABASE_URL_AUTH}", flush=True)
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

    import re as _re
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
        slug = f"{slug}-{uuid.uuid4().hex[:6]}"
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
    if tenant_id:
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
    return tenant_id or ""


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


async def get_tenant_context(
    user: dict | None = Depends(get_current_user),
    x_tenant_id: str | None = Header(None),
) -> str | None:
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
    if not tid:
        tid = None
    set_tenant_id(tid)
    return tid


async def require_tenant(
    tenant_id: str | None = Depends(get_tenant_context),
) -> str:
    if tenant_id is None:
        raise HTTPException(403, "No organization membership found")
    return tenant_id


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


async def _select_reply_broker_id(member: dict, requested_broker_id: str = "") -> str:
    org_id = member.get("organization_id")
    if not org_id:
        return ""

    connections = await asyncio.to_thread(storage.list_org_whatsapp_connections, org_id)
    connections = [row for row in connections if row.get("is_active", True)]
    explicit_access = await asyncio.to_thread(storage.get_member_whatsapp_access, member["id"], org_id)
    if explicit_access:
        allowed_numbers = {
            str(row.get("whatsapp_number") or "")
            for row in explicit_access if row.get("can_send")
        }
        connections = [
            row for row in connections
            if str(row.get("phone_number") or "") in allowed_numbers
        ]

    requested_broker_id = requested_broker_id.strip()
    if requested_broker_id:
        connections = [
            row for row in connections
            if str(row.get("broker_id") or "") == requested_broker_id
        ]

    if not connections:
        raise HTTPException(403, "No WhatsApp phone is available for this team member")

    return str(connections[0].get("broker_id") or "").strip()


async def get_current_member(x_team_member_id: int = Header(None)) -> dict:
    if not x_team_member_id:
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


# ── Shared helpers (used by 2+ routers) ────────────────────────────────

def _group_jid_to_name(jid: str) -> str:
    if not jid:
        return ""
    try:
        row = storage.db.execute(
            "SELECT group_name FROM sync_jobs WHERE group_jid = ? LIMIT 1",
            (jid,),
        ).fetchone()
        if row and row.get("group_name"):
            return row["group_name"]
    except Exception:
        pass
    return jid.split("@")[0] if "@" in jid else jid


def _doubleword_error_response(exc: Exception) -> Any:
    from fastapi.responses import JSONResponse
    msg = str(exc)
    if "credits" in msg.lower() or "quota" in msg.lower():
        return JSONResponse(
            status_code=429,
            content={"error": "credits_exhausted", "message": "AI credits exhausted. Please try again later."},
        )
    return JSONResponse(
        status_code=502,
        content={"error": "llm_error", "message": msg[:500]},
    )


def _normalize_real_phone(value: object) -> str:
    digits = re.sub(r"\D+", "", str(value or ""))
    if len(digits) == 10:
        return digits
    if len(digits) == 12 and digits.startswith("91"):
        return digits[-10:]
    if len(digits) == 11 and digits.startswith("0"):
        return digits[-10:]
    return ""


def _compact_whatsapp_line(value: object, limit: int = 200) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    text = re.sub(r"\s+", " ", text)
    if len(text) > limit:
        text = text[: limit - 1].rstrip() + "…"
    return text


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
            title = block.get("title") or ""
            if title:
                lines.append(_compact_whatsapp_line(title, 120))
            for row in rows[:6]:
                if isinstance(row, dict):
                    label = row.get("label") or row.get("name") or ""
                    metric = row.get("value") or row.get("count") or ""
                    detail = row.get("detail") or ""
                    lines.append(_compact_whatsapp_line(f"- {label}: {metric} records. {detail}", 220))
                elif isinstance(row, str):
                    lines.append(_compact_whatsapp_line(f"- {row}", 200))
            continue

        if block_type == "contacts":
            items = block.get("items") or block.get("results") or []
            title = block.get("title") or ""
            if title:
                lines.append(_compact_whatsapp_line(title, 120))
            for idx, item in enumerate(items[:5], 1):
                if not isinstance(item, dict):
                    continue
                phone = _normalize_real_phone(item.get("phone") or item.get("broker_phone"))
                name = item.get("broker_name") or item.get("name") or phone
                need = item.get("need") or ""
                metric = item.get("match_score") or ""
                contact = f"{name} ({phone})" if phone else str(name)
                lines.append(_compact_whatsapp_line(f"{idx}. {contact}: {need or metric}", 220))
            continue

        if block_type == "summary":
            body = block.get("content") or block.get("text") or ""
            title = block.get("title") or ""
            clean_body = _compact_whatsapp_line(body, 400)
            if title:
                lines.append(_compact_whatsapp_line(title, 120))
            if clean_body:
                lines.append(clean_body)
            continue

        if block_type == "text":
            text = block.get("content") or block.get("text") or ""
            clean = _compact_whatsapp_line(text, 400)
            if clean:
                lines.append(clean)

    if not lines:
        text = response.get("content") or ""
        return _compact_whatsapp_line(text, 1800) or "I could not process that."

    return "\n".join(lines[:8])


# ── _run_workspace_agent (imported by ai_chat, self_chat, business_api) ──

_ENTITY_ADJECTIVE_BLACKLIST = frozenset({
    "new", "old", "good", "best", "top", "major", "local", "main",
    "first", "last", "high", "low", "big", "small", "nice", "great",
})


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


def _extract_entity_mentions(text: str) -> list[str]:
    """Extract potential entity names (buildings, localities) from conversation text."""
    if not text:
        return []
    candidates = set()
    for m in re.finditer(r'\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+)\b', text):
        phrase = m.group(1)
        lower = phrase.lower()
        words = lower.split()
        if re.search(r'(?i)\b(the|this|that|from|with|have|been|would|could|should|please|thanks|regards|sent|forward)\b', lower):
            continue
        if len(phrase) < 6:
            continue
        if words and all(w in _ENTITY_ADJECTIVE_BLACKLIST for w in words):
            continue
        candidates.add(phrase)
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


def _assert_model_url_match(model: str, base_url: str) -> None:
    """Log a warning if the model string doesn't match the provider's base URL."""
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
            logger.error(
                "MODEL-URL MISMATCH: model '%s' suggests %s but base_url is '%s' — "
                "request will be silently misrouted!",
                model, models, base_url,
            )


async def _run_workspace_agent(
    messages: list[dict],
    model: str = "",
    session_id: str = "whatsapp",
    tenant_id: str | None = None,
) -> dict:
    from ai_chat_engine import get_memory, load_data as _load_data, load_live_data as _load_live_data
    from ai_chat_engine import build_system_prompt, get_model_reply, normalize_workspace_response
    import llm as _llm

    memory = get_memory(session_id)
    for msg in messages:
        role = msg.get("role", "")
        content = str(msg.get("content", "")).strip()
        if content:
            if not memory.working or memory.working[-1].get("content") != content:
                memory.add(role, content)

    last_user = ""
    for msg in reversed(messages):
        if msg.get("role") == "user":
            last_user = str(msg.get("content", "")).strip()
            break
    if last_user and memory.detect_topic_change(last_user) and len(memory.working) > 2:
        memory.compact_topic()
    memory.prune()

    configured_model = model.strip()
    api_key = ""
    base_url = ""
    provider_name = ""
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
    logger.info(
        "Workspace agent resolved provider: %s | model=%s | base_url=%s",
        provider_name, configured_model, base_url,
    )

    if configured_model and base_url:
        _assert_model_url_match(configured_model, base_url)

    sources = _load_data()
    live = _load_live_data(getattr(storage, "db", None))
    sources.update(live)
    if not sources:
        return {"error": "no_data", "message": "No PropAI data is available yet."}

    conv_text = " ".join(m.get("content", "") for m in messages if m.get("content"))
    entity_candidates = _extract_entity_mentions(conv_text)
    relevant_obs = _get_relevant_observations(entity_candidates, limit=8)

    loop = asyncio.get_running_loop()

    def _call():
        system_prompt = build_system_prompt(sources)
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
        reply = get_model_reply(
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
        last_user_inner = next((m.get("content", "") for m in reversed(messages) if m.get("role") == "user"), "")
        assistant_reply = reply.content or ""
        if _looks_like_echo_misfire(last_user_inner, assistant_reply):
            logging.warning(
                "possible_echo_misfire",
                extra={"user_msg": last_user_inner[:200], "assistant_msg": assistant_reply[:200]}
            )
        return normalize_workspace_response(reply.content or "", sources)

    request_context = contextvars.copy_context()
    return await asyncio.wait_for(
        loop.run_in_executor(None, request_context.run, _call),
        timeout=90,
    )


# ── Group name parsing (used by groups_market + audit) ──────────────────

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
