"""LiteLLM custom logging hooks for PropAI.

Writes one row per request into public.llm_routing_log (Supabase) with the
exact columns the ops dashboard needs: task_type, provider_used, model_used,
success, latency_ms, error_message, tokens_used, created_at.

Registered in config.yaml under litellm_settings.callbacks as
"deploy.coolify.litellm.hooks.CustomLogger".
"""
from __future__ import annotations

import os
from datetime import datetime, timezone

try:
    from litellm.integrations.custom_logger import CustomLogger
except Exception:  # pragma: no cover - import shape differs across versions
    class CustomLogger:  # type: ignore
        pass

try:
    from supabase import create_client, Client
except Exception:  # pragma: no cover
    create_client = None
    Client = None


def _client() -> "Client | None":
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key or create_client is None:
        return None
    return create_client(url, key)


def _task_type(kwargs: dict) -> str:
    # Callers pass model=<task_type>; metadata also carries it for clarity.
    model = kwargs.get("model") or ""
    meta = kwargs.get("litellm_params", {}).get("metadata") or {}
    return str(meta.get("task_type") or model or "unknown")


def _provider(model: str) -> str:
    # model comes back as "provider/model" from LiteLLM.
    return model.split("/", 1)[0] if "/" in model else model


class CustomLogger(CustomLogger):
    def _insert(self, row: dict) -> None:
        try:
            c = _client()
            if c is None:
                return
            c.table("llm_routing_log").insert(row).execute()
        except Exception:
            # Never let logging break inference.
            pass

    async def success_handler(self, kwargs, response_obj, start_time, end_time):
        model = kwargs.get("model", "")
        usage = (response_obj or {}).get("usage") or {}
        tokens = (usage.get("total_tokens") if isinstance(usage, dict) else None)
        row = {
            "task_type": _task_type(kwargs),
            "provider_used": _provider(model),
            "model_used": model,
            "success": True,
            "latency_ms": int((end_time - start_time) * 1000),
            "error_message": None,
            "tokens_used": int(tokens) if tokens is not None else None,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        self._insert(row)

    async def failure_handler(self, kwargs, response_obj, start_time, end_time):
        model = kwargs.get("model", "")
        err = response_obj
        msg = str(getattr(err, "message", err)) if err is not None else "unknown error"
        row = {
            "task_type": _task_type(kwargs),
            "provider_used": _provider(model),
            "model_used": model or None,
            "success": False,
            "latency_ms": int((end_time - start_time) * 1000),
            "error_message": msg[:2000],
            "tokens_used": None,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        self._insert(row)
