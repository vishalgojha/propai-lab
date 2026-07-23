"""
LLM provider chain — configured providers are tried in order.

Usage:
    from llm import get_client, get_model
    client = get_client()
    model = get_model()
    resp = client.chat.completions.create(model=model, messages=[...])
"""

import logging
import os
import time
from openai import OpenAI

_logger = logging.getLogger(__name__)

# ── Provider chain ─────────────────────────────────────────────────
# A model is deployment configuration, not product code. A provider with a
# key but no model is deliberately skipped: silently inventing a model makes
# requests succeed or fail against an accidental provider/model combination.

_PROVIDERS = []

# Merge Gateway — OpenAI-compatible, first in chain (highest priority)
_merge_key = os.getenv("MERGE_API_KEY", "").strip()
_merge_model = os.getenv("MERGE_MODEL", "").strip()
_merge_base = os.getenv("MERGE_BASE_URL", "https://api-gateway.merge.dev/v1/openai").strip()
if _merge_key and _merge_model:
    _PROVIDERS.append({
        "name": "merge",
        "api_key": _merge_key,
        "base_url": _merge_base,
        "model": _merge_model,
    })
elif _merge_key:
    _logger.warning("Skipping merge: set MERGE_MODEL to enable this provider")

_nvidia_model = os.getenv("NVIDIA_MODEL", "").strip()
_nvidia_base = "https://integrate.api.nvidia.com/v1"
for i, key_env in enumerate(["NVIDIA_API_KEY", "NVIDIA_API_KEY_2", "NVIDIA_API_KEY_3", "NVIDIA_API_KEY_4"], 1):
    if os.getenv(key_env) and _nvidia_model:
        _PROVIDERS.append({
            "name": f"nvidia-nim-{i}",
            "api_key": os.environ[key_env],
            "base_url": _nvidia_base,
            "model": _nvidia_model,
        })
    elif os.getenv(key_env):
        _logger.warning("Skipping %s: set NVIDIA_MODEL to enable this provider", key_env)

if os.getenv("GROQ_API_KEY") and os.getenv("GROQ_MODEL", "").strip():
    _PROVIDERS.append({
        "name": "groq",
        "api_key": os.environ["GROQ_API_KEY"],
        "base_url": "https://api.groq.com/openai/v1",
        "model": os.environ["GROQ_MODEL"].strip(),
    })

if os.getenv("GEMINI_API_KEY") and os.getenv("GEMINI_MODEL", "").strip():
    _PROVIDERS.append({
        "name": "gemini",
        "api_key": os.environ["GEMINI_API_KEY"],
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "model": os.environ["GEMINI_MODEL"].strip(),
    })

if os.getenv("CEREBRAS_API_KEY") and os.getenv("CEREBRAS_MODEL", "").strip():
    _PROVIDERS.append({
        "name": "cerebras",
        "api_key": os.environ["CEREBRAS_API_KEY"],
        "base_url": "https://api.cerebras.ai/v1",
        "model": os.environ["CEREBRAS_MODEL"].strip(),
    })

# Doubleword — paid, always last
_dw_key = os.getenv("DOUBLEWORD_API_KEY", "")
_dw_model = os.getenv("DOUBLEWORD_MODEL", "").strip()
if _dw_key and _dw_model:
    _PROVIDERS.append({
        "name": "doubleword",
        "api_key": _dw_key,
        "base_url": os.getenv("DOUBLEWORD_API_URL", "https://api.doubleword.ai/v1"),
        "model": _dw_model,
    })
elif _dw_key:
    _logger.warning("Skipping doubleword: set DOUBLEWORD_MODEL to enable this provider")


class ProviderConfigurationError(RuntimeError):
    """Raised when no complete LLM provider configuration is available."""

# ── Health cache ────────────────────────────────────────────────────

_cached_index: int | None = None
_cached_ts: float = 0
_CACHE_TTL = 5 * 60  # 5 minutes


def _ping_provider(p: dict) -> bool:
    """Quick health check — 1-token completion (only 2xx considered healthy)."""
    try:
        import httpx
        r = httpx.post(
            f"{p['base_url']}/chat/completions",
            headers={"Authorization": f"Bearer {p['api_key']}", "Content-Type": "application/json"},
            json={"model": p["model"], "messages": [{"role": "user", "content": "hi"}], "max_tokens": 1},
            timeout=8.0,
        )
        return r.status_code >= 200 and r.status_code < 300
    except Exception:
        return False


def _find_working() -> int:
    """Return index of first healthy provider (with caching)."""
    global _cached_index, _cached_ts

    now = time.time()
    if _cached_index is not None and now - _cached_ts < _CACHE_TTL:
        return _cached_index

    for i, p in enumerate(_PROVIDERS):
        if _ping_provider(p):
            _cached_index = i
            _cached_ts = now
            if i >= 1:
                _logger.warning(
                    "LLM provider fallback: selected %s (index %d) — NVIDIA (%s) was unhealthy",
                    p["name"], i, _PROVIDERS[0].get("name", "?")
                )
            else:
                _logger.info("LLM provider: selected %s", p["name"])
            return i

    _logger.error("LLM provider chain exhausted — all %d providers unhealthy", len(_PROVIDERS))
    return -1


# ── Public API ──────────────────────────────────────────────────────

def get_configured_providers() -> tuple[dict, ...]:
    """Return safe copies of the deployment-configured provider chain.

    Background jobs need to rotate across the same keys/models as chat.  They
    must not carry a second, stale list of hard-coded models.
    """
    return tuple(dict(provider) for provider in _PROVIDERS)

def get_client() -> OpenAI:
    """Return an OpenAI client pointing at the first healthy provider."""
    idx = _find_working()
    if idx >= 0:
        p = _PROVIDERS[idx]
        return OpenAI(api_key=p["api_key"], base_url=p["base_url"])
    # Preserve a useful configuration error instead of constructing a fake client.
    if _PROVIDERS:
        p = _PROVIDERS[-1]
        return OpenAI(api_key=p["api_key"], base_url=p["base_url"])
    raise ProviderConfigurationError(
        "No complete LLM provider is configured. Set an API key and its model "
        "(for example DOUBLEWORD_API_KEY + DOUBLEWORD_MODEL)."
    )


def get_model() -> str:
    """Return the model name for the current working provider."""
    idx = _find_working()
    if idx >= 0:
        return _PROVIDERS[idx]["model"]
    if _PROVIDERS:
        return _PROVIDERS[-1]["model"]
    raise ProviderConfigurationError(
        "No complete LLM provider is configured. Set an API key and its model."
    )


def get_provider_name() -> str:
    """Return the name of the current working provider."""
    idx = _find_working()
    if idx >= 0:
        return _PROVIDERS[idx]["name"]
    return "none"


# ── Fast-provider selection (for latency-sensitive paths like WhatsApp self-chat) ──

# Order: speed-optimized providers first. Falls back to the chain default if none are healthy.
_FAST_PROVIDER_PREFERENCE = ["cerebras", "gemini", "groq"]


def _find_fast_working() -> int:
    """Pick the fastest healthy provider, preferring Cerebras > Gemini > Groq."""
    for name in _FAST_PROVIDER_PREFERENCE:
        for i, p in enumerate(_PROVIDERS):
            if p["name"] == name and _ping_provider(p):
                _logger.info("Fast provider selected: %s (index %d)", name, i)
                return i
    # Fallback: use the regular chain.
    return _find_working()


def get_fast_client() -> OpenAI:
    """Return an OpenAI client pointing at the fastest healthy provider."""
    idx = _find_fast_working()
    if idx >= 0:
        p = _PROVIDERS[idx]
        return OpenAI(api_key=p["api_key"], base_url=p["base_url"])
    if _PROVIDERS:
        p = _PROVIDERS[-1]
        return OpenAI(api_key=p["api_key"], base_url=p["base_url"])
    raise ProviderConfigurationError(
        "No complete LLM provider is configured. Set an API key and its model."
    )


def get_fast_model() -> str:
    """Return the model name for the fastest healthy provider."""
    idx = _find_fast_working()
    if idx >= 0:
        return _PROVIDERS[idx]["model"]
    if _PROVIDERS:
        return _PROVIDERS[-1]["model"]
    raise ProviderConfigurationError(
        "No complete LLM provider is configured. Set an API key and its model."
    )


def get_fast_provider_name() -> str:
    """Return the name of the fastest healthy provider."""
    idx = _find_fast_working()
    if idx >= 0:
        return _PROVIDERS[idx]["name"]
    return "none"


def get_provider_info() -> dict:
    """Return full info of the working provider (or fallback)."""
    idx = _find_working()
    if idx >= 0:
        p = dict(_PROVIDERS[idx])
    elif _PROVIDERS:
        p = dict(_PROVIDERS[-1])
    else:
        return {"provider_name": "none", "base_url": "", "model_name": "", "error": "no providers configured"}
    return {
        "provider_name": p["name"],
        "base_url": p["base_url"],
        "model_name": p["model"],
    }
