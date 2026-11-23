"""Broker usage events: record real (interactive) use separately from assistant
calls and automation.

Fire-and-forget like usage_logger: a logging failure must never break a
search response. Records tenant, surface, origin and timestamp only -- never
query text, filters, message content or results.

Origin rules: authenticated product search requests are "app". This
identifies the endpoint/principal, not proof that a human initiated the call. Standing-search runs and calls carrying the explicit
X-PropAI-Initiator: automation header are "automation". Every other
assistant/API call is "assistant_unlabeled": unknown provenance is never
labeled human usage.
"""

import logging
import functools
import inspect
import contextvars
import queue
import threading
from typing import Any

_logger = logging.getLogger(__name__)

_pending = queue.Queue(maxsize=1000)
_worker = None
_worker_lock = threading.Lock()

_storage: Any = None
_storage_lock = threading.Lock()

ALLOWED_ORIGINS = ("app", "automation", "assistant_unlabeled")
ALLOWED_FIELDS = {"tenant_id", "surface", "action", "origin"}


def _get_storage():
    global _storage
    if _storage is not None:
        return _storage
    with _storage_lock:
        if _storage is not None:
            return _storage
        try:
            from storage import SupabaseStorage
            _storage = SupabaseStorage()
        except Exception:
            _logger.debug("usage_events: SupabaseStorage unavailable, skipping")
            return None
        return _storage


def record_search_usage(*, tenant_id, surface, origin):
    """Insert workspace-only usage. No persistent user or API-key identity.

    Existing request auth and the chat collector may use identity transiently,
    but this function does not accept it and the usage table cannot store it.
    Failures are logged and swallowed.
    """
    if not tenant_id or origin not in ALLOWED_ORIGINS:
        return
    row = {
        "tenant_id": str(tenant_id),
        "surface": surface,
        "action": "search",
        "origin": origin,
    }
    assert set(row) <= ALLOWED_FIELDS, row  # content fields can never sneak in
    _enqueue(row)


def _insert_row(row):
    try:
        storage = _get_storage()
        if storage is None:
            return
        storage.client.table("broker_usage_events").insert(row).execute()
    except Exception:
        _logger.debug("usage event insert failed", exc_info=True)


def _drain():
    while True:
        row = _pending.get()
        try:
            _insert_row(row)
        finally:
            _pending.task_done()


def _enqueue(row):
    global _worker
    try:
        with _worker_lock:
            if _worker is None or not _worker.is_alive():
                _worker = threading.Thread(target=_drain, daemon=True, name="usage-events")
                _worker.start()
        _pending.put_nowait(row)
    except queue.Full:
        _logger.warning("usage event queue full; dropped count")


_chat_turn = contextvars.ContextVar("usage_chat_turn", default=None)


def mark_chat_search(tenant_id, user_id):
    """Mark a successful search inside an authenticated app chat request only.

    Reusable helpers also run in self-chat. Their arguments alone are not
    evidence of an authenticated app request. No context means no app event.
    """
    turn = _chat_turn.get()
    if turn is not None and tenant_id and user_id and str(user_id) == turn["user_id"]:
        turn["tenant_id"] = str(tenant_id)
        turn["searched"] = True


def tracked_chat_turn(func):
    """At most one event for a completed authenticated chat request.

    Child helper/tool calls mark the request, never enqueue individually.
    An exception never records a completed request. ContextVar separates
    concurrent async requests and is always reset, including on cancellation.
    """
    signature = inspect.signature(func, eval_str=True)
    @functools.wraps(func)
    async def wrapped(*args, **kwargs):
        values = signature.bind(*args, **kwargs)
        values.apply_defaults()
        user = values.arguments.get("user") or {}
        uid = str(user.get("id") or "") if isinstance(user, dict) else ""
        if not uid:
            return await func(*args, **kwargs)
        active = _chat_turn.get()
        if active is not None and active["user_id"] == uid:
            return await func(*args, **kwargs)
        turn = {"user_id": uid, "tenant_id": None, "searched": False}
        token = _chat_turn.set(turn)
        try:
            result = await func(*args, **kwargs)
            if turn["searched"]:
                record_search_usage(tenant_id=turn["tenant_id"], surface="app",
                                    origin="app")
            return result
        finally:
            _chat_turn.reset(token)
    wrapped.__signature__ = signature
    return wrapped


def tracked_search(surface, fixed_automation=False, chat_helper=False):
    """Count completed searches only, after validation and permission checks.

    Preserve the endpoint signature so FastAPI still owns auth/dependencies.
    """
    def decorate(func):
        signature = inspect.signature(func, eval_str=True)
        @functools.wraps(func)
        async def wrapped(*args, **kwargs):
            values = signature.bind(*args, **kwargs)
            values.apply_defaults()
            result = await func(*args, **kwargs)
            if result is None or (isinstance(result, dict) and result.get("fallback")):
                return result
            v = values.arguments
            if surface == "app":
                if "q" in v and func.__name__ != "market_search" and len(str(v["q"] or "").strip()) < 2:
                    return result
                user = v.get("user") or {}
                uid = v.get("user_id") or user.get("id")
                if chat_helper:
                    mark_chat_search(v.get("tenant_id"), uid)
                elif uid:
                    record_search_usage(tenant_id=v.get("tenant_id"), surface="app", origin="app")
            else:
                key = v.get("key") or {}
                automation = fixed_automation or str(v.get("x_propai_initiator") or "").strip().lower() == "automation"
                record_search_usage(tenant_id=key.get("tenant_id"), surface="assistant",
                                    origin="automation" if automation else "assistant_unlabeled")
            return result
        wrapped.__signature__ = signature
        return wrapped
    return decorate


CHAT_SEARCH_TOOLS = frozenset({"market_search", "search_listings", "search_requirements", "find_opportunities", "search_group_messages", "search_whatsapp_messages", "query_extract_raw_messages", "match_client_to_listings"})


def record_chat_search_activity(activities, tenant_id, user_id):
    """One usage event per completed chat turn with a successful data search.

    Examine tool name/status only. No activity text is stored.
    """
    if has_chat_search_activity(activities):
        mark_chat_search(tenant_id, user_id)


def has_chat_search_activity(activities):
    return any(a.get("tool") in CHAT_SEARCH_TOOLS and a.get("status") == "ok" for a in activities)
