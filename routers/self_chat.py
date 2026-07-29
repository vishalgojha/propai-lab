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
    _run_workspace_agent, _workspace_provider_candidates,
    _workspace_response_to_whatsapp, _doubleword_error_response,
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
    # WhatsApp transport processes restart independently of the API. Keep the
    # thread in the same durable tables used by web chat, under a channel-
    # specific owner, and hydrate the agent from that history on every turn.
    durable_session = None
    durable_messages = messages
    if tenant_id:
        durable_session = await asyncio.to_thread(
            storage.get_or_create_chat_session,
            session_id,
            "WhatsApp self chat",
            tenant_id,
        )
        if durable_session:
            for message in messages:
                role = str(message.get("role") or "")
                content = str(message.get("content") or "").strip()
                if role in {"user", "assistant"} and content:
                    await asyncio.to_thread(
                        storage.add_chat_message_if_new,
                        durable_session["id"],
                        role,
                        content,
                        tenant_id,
                    )
            rows = await asyncio.to_thread(
                storage.get_ai_chat_messages,
                durable_session["id"],
                20,
                tenant_id,
            )
            durable_messages = [
                {"role": row.get("role"), "content": str(row.get("content") or "")}
                for row in rows
                if row.get("role") in {"user", "assistant"} and str(row.get("content") or "").strip()
            ]

    # Rebuild memory from the durable transcript for this turn. A fresh key
    # prevents process-local memory from appending the same restored history
    # again after each WhatsApp event.
    memory_turn_key = str((durable_session or {}).get("id") or session_id)
    if durable_session and rows:
        memory_turn_key = f"{memory_turn_key}:{rows[-1].get('id') or len(rows)}"
    response = await _run_workspace_agent(
        durable_messages,
        model=model,
        session_id=memory_turn_key,
        tenant_id=tenant_id,
    )
    if durable_session and not response.get("error"):
        assistant_content = str(response.get("content") or "").strip()
        if assistant_content:
            await asyncio.to_thread(
                storage.add_chat_message_if_new,
                durable_session["id"],
                "assistant",
                assistant_content,
                tenant_id,
            )
            await asyncio.to_thread(storage.touch_chat_session, durable_session["id"], tenant_id)
    return response


async def _quick_self_chat_reply(text: str, tenant_id: str | None) -> dict:
    """Use the owner's saved provider for short conversational WhatsApp turns.

    This deliberately avoids loading listings, observations, tools, and the
    full agent prompt.  It is still an LLM response, but should return within
    seconds for greetings and simple conversational messages.
    """
    providers = await asyncio.to_thread(_workspace_provider_candidates, tenant_id)
    if not providers:
        return {"error": "workspace_provider_required"}

    system_prompt = """You are PropAI, a concise Mumbai real-estate assistant in a WhatsApp self-chat.
Reply naturally to the user. Use one to three short bullet points starting with •.
You can help find properties, capture listing details, and answer real-estate questions.
Do not claim that you searched, saved, or updated anything unless the user asked a specific task and a tool confirmed it.
Never return JSON, markdown tables, or a canned template."""
    user_text = (text or "").strip()[:1800] or "Hello."

    def complete(provider: dict) -> tuple[str, object]:
        from openai import OpenAI

        client = OpenAI(
            api_key=provider["api_key"],
            base_url=provider["base_url"],
            timeout=12.0,
        )
        result = client.chat.completions.create(
            model=provider["model"],
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_text},
            ],
            max_tokens=160,
            temperature=0.45,
        )
        return str(result.choices[0].message.content or "").strip(), getattr(result, "usage", None)

    for provider in providers:
        try:
            raw, usage = await asyncio.wait_for(asyncio.to_thread(complete, provider), timeout=15)
            reply = _format_self_chat_response(raw)
            if reply:
                try:
                    from usage_logger import log_ai_usage
                    log_ai_usage(
                        agent="self_chat",
                        model=provider["model"],
                        tokens_input=getattr(usage, "prompt_tokens", 0) or 0,
                        tokens_output=getattr(usage, "completion_tokens", 0) or 0,
                    )
                except Exception:
                    pass
                return {"reply": "PropAI- " + reply}
            raise RuntimeError("provider returned an empty response")
        except Exception as exc:
            _logger.warning("Quick self-chat provider failed (%s): %s", provider.get("provider", "workspace"), exc)

    return {"error": "provider_unavailable"}


def _self_chat_error_reply(error: str) -> str:
    if error == "workspace_provider_required":
        return "PropAI- • Add an active AI provider in Workspace → AI Providers to use self-chat."
    return "PropAI- • I couldn't answer that just now. Please try again in a moment."


async def _persist_quick_self_chat_turn(
    text: str,
    reply: str,
    broker_id: str,
    tenant_id: str | None,
) -> None:
    """Keep quick conversational turns in the same durable WhatsApp thread."""
    if not tenant_id or not reply:
        return
    try:
        session = await asyncio.to_thread(
            storage.get_or_create_chat_session,
            f"whatsmeow:{broker_id}",
            "WhatsApp self chat",
            tenant_id,
        )
        if not session:
            return
        await asyncio.to_thread(
            storage.add_chat_message_if_new,
            session["id"],
            "user",
            text[:1800],
            tenant_id,
        )
        await asyncio.to_thread(
            storage.add_chat_message_if_new,
            session["id"],
            "assistant",
            reply,
            tenant_id,
        )
        await asyncio.to_thread(storage.touch_chat_session, session["id"], tenant_id)
    except Exception as exc:
        _logger.warning("Could not persist quick self-chat turn: %s", exc)


def _stream_self_chat_enabled() -> bool:
    val = (os.getenv("PROPAI_SELF_CHAT_STREAM") or "").strip().lower()
    return val in {"1", "true", "yes", "on"}


async def _self_chat_ndjson(
    text: str,
    broker_id: str,
    casual: bool,
    tenant_id: str | None = None,
):
    try:
        if casual:
            quick = await _quick_self_chat_reply(text, tenant_id)
            if quick.get("reply"):
                await _persist_quick_self_chat_turn(text, quick["reply"], broker_id, tenant_id)
                yield _ndjson_line({"event": "chunk", "delta": quick["reply"]})
                yield _ndjson_line({"event": "done", "reply": quick["reply"]})
                return
            error = str(quick.get("error") or "provider_unavailable")
            reply = _self_chat_error_reply(error)
            yield _ndjson_line({"event": "chunk", "delta": reply})
            yield _ndjson_line({"event": "done", "reply": reply})
            return

        response = await _run_self_chat_agent(
            [{"role": "user", "content": text[:1800]}],
            session_id=f"whatsmeow:{broker_id}",
            casual=casual,
            tenant_id=tenant_id,
        )
        if isinstance(response, dict) and response.get("error"):
            reply = _self_chat_error_reply(str(response.get("error") or "agent_error"))
            yield _ndjson_line({"event": "chunk", "delta": reply})
            yield _ndjson_line({"event": "done", "reply": reply})
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
            _self_chat_ndjson(text, req.broker_id, casual=casual, tenant_id=org_id),
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
            return {"reply": _self_chat_error_reply(str(response.get("error") or "agent_error"))}
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
