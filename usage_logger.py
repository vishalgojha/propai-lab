"""Centralised AI usage logging — inserts into ai_usage_log after every LLM call.

Usage from any call site:

    from usage_logger import log_ai_usage
    log_ai_usage(
        agent="extraction",
        model="Qwen/Qwen3.6-35B-A3B-FP8",
        tokens_input=resp.usage.prompt_tokens,
        tokens_output=resp.usage.completion_tokens,
        source="raw_message",
        source_id=raw_message_id,
        provider_name="nvidia-nim-1",
    )

Fire-and-forget: logs failures to the Python logger so the caller is never
blocked.  The function resolves the Supabase client lazily so it works before
storage init completes.
"""

import logging
import threading
from typing import Any

from config import get_model_pricing

_logger = logging.getLogger(__name__)

_storage: Any = None
_storage_lock = threading.Lock()


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
            _logger.debug("usage_logger: SupabaseStorage unavailable, skipping log")
            return None
        return _storage


def log_ai_usage(
    *,
    agent: str,
    model: str = "",
    tokens_input: int = 0,
    tokens_output: int = 0,
    cost_usd: float | None = None,
    source: str = "",
    source_id: int | None = None,
    tenant_id: str | None = None,
    provider_name: str = "",
    truncated: bool = False,
) -> None:
    """Insert a row into ai_usage_log.  Fire-and-forget — never raises."""
    storage = _get_storage()
    if storage is None:
        return

    # Auto-calculate cost if not provided
    if cost_usd is None:
        pricing = get_model_pricing(model, provider_name)
        cost_usd = (tokens_input * pricing["input"] + tokens_output * pricing["output"]) / 1_000_000

    row = {
        "agent": agent,
        "model": model[:120] if model else "",
        "tokens_input": max(0, int(tokens_input)),
        "tokens_output": max(0, int(tokens_output)),
        "cost_usd": round(cost_usd, 8),
        "source": source[:80] if source else "",
        "source_id": source_id,
    }
    if tenant_id:
        row["tenant_id"] = tenant_id

    try:
        storage.client.table("ai_usage_log").insert(row).execute()
    except Exception:
        _logger.debug("usage_logger: failed to insert ai_usage_log row for agent=%s model=%s", agent, model)
