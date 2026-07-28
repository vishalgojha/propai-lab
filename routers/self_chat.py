"""Self-chat routes — internal (service-token) and authenticated user self-chat."""
import asyncio
import contextvars
import hmac
import json
import logging
import os
import re

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from routers.common import (
    storage, require_user, set_tenant_id, get_tenant_id,
    _run_workspace_agent, _workspace_response_to_whatsapp, _doubleword_error_response,
)

_logger = logging.getLogger(__name__)

router = APIRouter(tags=["self_chat"])


# ── Models ────────────────────────────────────────────────────────

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


# ── Self-chat constants ───────────────────────────────────────────

_SELF_CHAT_BULLET = "\u2022 "
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


# ── Self-chat helpers ─────────────────────────────────────────────

def _is_casual_self_chat(text: str) -> bool:
    stripped = (text or "").strip()
    if len(stripped) > 60:
        return False
    if _DATA_QUERY_SIGNAL.search(stripped):
        return False
    return bool(_CASUAL_CHAT_SIGNAL.match(stripped))


def _build_self_chat_system_prompt(sources: dict) -> str:
    from lab import ai_chat_engine as chat_engine
    from datetime import datetime
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
    if not text:
        return ""

    cleaned = text.strip()

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
            cleaned = (cleaned[: fence_match.start()] + cleaned[fence_match.end() :]).strip()
    else:
        cleaned = re.sub(r"```(?!json)[^`]*```", "", cleaned, flags=re.DOTALL).strip()

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

    cleaned = re.sub(r"^[\s>]*[-*•·]+\s*", "", cleaned, flags=re.MULTILINE)

    raw_lines: list[str] = []
    for line in cleaned.splitlines():
        line = line.strip()
        if not line:
            continue
        sentence_parts = re.split(r"(?<=[.!?])\s+(?=[A-Z•])|\s*,\s+(?=[a-z])", line)
        for part in sentence_parts:
            part = part.strip().rstrip(",.;:")
            if part:
                raw_lines.append(part[:140])

    if not raw_lines:
        return ""

    seen: set[str] = set()
    deduped: list[str] = []
    for line in raw_lines:
        key = re.sub(r"\W+", "", line.lower())[:80]
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append(line)

    bulleted = [_SELF_CHAT_BULLET + line for line in deduped[:_SELF_CHAT_MAX_BULLETS]]

    text_out = "\n".join(bulleted)
    if len(text_out) > _SELF_CHAT_MAX_CHARS:
        text_out = text_out[: _SELF_CHAT_MAX_CHARS - 1].rstrip() + "\u2026"
    return text_out


async def _run_self_chat_agent(
    messages: list[dict],
    model: str = "",
    session_id: str = "whatsapp",
    casual: bool = False,
    tenant_id: str | None = None,
) -> dict:
    # WhatsApp self-chat must use the same workspace provider routing as the
    # portal. This includes active providers saved in the workspace, rather
    # than only deployment-level environment variables.
    return await _run_workspace_agent(
        messages,
        model=model,
        session_id=session_id,
        tenant_id=tenant_id,
    )

    # Kept below temporarily while preserving the old implementation during
    # rollout; it is unreachable and can be removed after deployment parity is
    # verified.
    import llm as _llm
    from lab import ai_chat_engine as chat_engine
    from ai_chat_engine import get_memory

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
    try:
        configured_model = configured_model or _llm.get_model()
        provider_name = _llm.get_provider_name()
    except Exception:
        pass
    if not provider_name or provider_name == "none":
        return {
            "error": "api_key_required",
            "message": "No LLM provider is available for self-chat.",
        }

    _logger.info(
        "Self-chat agent resolved provider: %s | model=%s | casual=%s",
        provider_name, configured_model, casual,
    )

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
            model=configured_model or None,
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

    request_context = contextvars.copy_context()
    try:
        return await asyncio.wait_for(
            loop.run_in_executor(None, request_context.run, _call),
            timeout=30,
        )
    except asyncio.TimeoutError:
        return {"error": "agent_timeout", "message": "Self-chat agent timed out."}


async def _stream_self_chat_reply(text: str) -> dict | None:
    import llm as _llm
    from lab import ai_chat_engine as chat_engine

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


def _stream_self_chat_enabled() -> bool:
    val = (os.getenv("PROPAI_SELF_CHAT_STREAM") or "").strip().lower()
    return val in {"1", "true", "yes", "on"}


async def _self_chat_ndjson(text: str, broker_id: str, casual: bool):
    try:
        # Do not use the legacy env-only fast stream here. The workspace agent
        # resolves the saved provider/key and is authoritative for self-chat.
        response = await _run_self_chat_agent(
            [{"role": "user", "content": text[:1800]}],
            session_id=f"whatsmeow:{broker_id}",
            casual=casual,
            tenant_id=get_tenant_id(),
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


# ── Routes ────────────────────────────────────────────────────────

@router.post("/api/internal/self-chat")
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

    org_id = connection.get("organization_id")
    if not org_id:
        raise HTTPException(500, "WhatsApp connection has no organization_id")
    set_tenant_id(org_id)
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
            tenant_id=connection.get("organization_id"),
        )
        if isinstance(response, dict) and response.get("error"):
            return JSONResponse(status_code=503, content=response)
        raw_reply = _workspace_response_to_whatsapp(response) if response.get("content") or response.get("blocks") else ""
        if not raw_reply:
            raw_reply = response.get("content") or ""
        reply = _format_self_chat_response(raw_reply) if raw_reply else ""
        if reply:
            reply = "PropAI- " + reply
        return {"reply": reply}
    except asyncio.TimeoutError:
        return JSONResponse(status_code=504, content={"error": "agent_timeout"})


@router.post("/api/self-chat")
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
