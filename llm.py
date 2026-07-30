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


def _numbered_keys(prefix: str) -> list[tuple[str, str]]:
    """Return a provider's base key plus every numbered Coolify key."""
    values: list[tuple[str, str]] = []
    base = os.getenv(prefix, "").strip()
    if base:
        values.append((prefix.removesuffix("_API_KEY").lower(), base))
    numbered = []
    for env_name, value in os.environ.items():
        if env_name.startswith(prefix + "_") and env_name[len(prefix) + 1:].isdigit() and value.strip():
            numbered.append((int(env_name[len(prefix) + 1:]), value.strip()))
    for number, value in sorted(numbered):
        values.append((f"{prefix.removesuffix('_API_KEY').lower()}_{number}", value))
    return values

# NVIDIA — up to 4 keys for round-robin, all use the same model
_nvidia_model = os.getenv("NVIDIA_MODEL", "").strip()
if _nvidia_model:
    for name, key in _numbered_keys("NVIDIA_API_KEY"):
        _PROVIDERS.append({
                "name": name,
                "api_key": key,
                "base_url": "https://integrate.api.nvidia.com/v1",
                "model": _nvidia_model,
            })

# Groq — up to 4 pooled-account keys for round-robin
_groq_model = os.getenv("GROQ_MODEL", "").strip()
if _groq_model:
    for name, key in _numbered_keys("GROQ_API_KEY"):
        _PROVIDERS.append({
                "name": name,
                "api_key": key,
                "base_url": "https://api.groq.com/openai/v1",
                "model": _groq_model,
            })

# Merge Gateway — OpenAI-compatible, tried last as fallback
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

# Cerebras — OpenAI-compatible, fast inference. Configure via
# CEREBRAS_API_KEY + CEREBRAS_MODEL; optional CEREBRAS_BASE_URL override.
# Skipped when CEREBRAS_MODEL is empty so a missing model name doesn't
# 404 every request.
_cerebras_model = os.getenv("CEREBRAS_MODEL", "").strip()
_cerebras_base = os.getenv("CEREBRAS_BASE_URL", "https://api.cerebras.ai/v1").strip()
if _cerebras_model:
    for name, key in _numbered_keys("CEREBRAS_API_KEY"):
        _PROVIDERS.append({
            "name": name,
            "api_key": key,
            "base_url": _cerebras_base,
            "model": _cerebras_model,
        })
else:
    _logger.info("CEREBRAS_API_KEY present but CEREBRAS_MODEL unset — skipping cerebras")

_logger.info("LLM providers configured: %d", len(_PROVIDERS))
for p in _PROVIDERS:
    _logger.info("  - %s: %s @ %s", p["name"], p["model"], p["base_url"])


class ProviderConfigurationError(RuntimeError):
    """Raised when no complete LLM provider configuration is available."""

# ── Health cache ────────────────────────────────────────────────────

_cached_index: int | None = None
_cached_ts: float = 0
_CACHE_TTL = 5 * 60  # 5 minutes
_workspace_health: dict[tuple[str, str], tuple[bool, float]] = {}


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
        if r.status_code >= 200 and r.status_code < 300:
            return True
        _logger.warning("Provider %s health check failed: HTTP %d", p["name"], r.status_code)
        return False
    except Exception as e:
        _logger.warning("Provider %s health check failed: %s", p["name"], str(e)[:100])
        return False


def is_provider_healthy(api_key: str, base_url: str, model: str, ttl: float = 60.0) -> bool:
    """Check a workspace-saved provider without probing it on every request."""
    cache_key = (str(base_url or "").rstrip("/"), str(model or ""))
    now = time.time()
    cached = _workspace_health.get(cache_key)
    if cached and now - cached[1] < ttl:
        return cached[0]
    healthy = _ping_provider({"api_key": api_key, "base_url": cache_key[0], "model": model})
    _workspace_health[cache_key] = (healthy, now)
    return healthy


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
            _logger.info("LLM provider: selected %s", p["name"])
            return i

    _logger.error("LLM provider unavailable — %s is unhealthy", _PROVIDERS[0]["name"] if _PROVIDERS else "none")
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
    raise ProviderConfigurationError(
        "No configured LLM provider is healthy. Check provider balances, keys, and models."
    )


def get_model() -> str:
    """Return the model name for the current working provider."""
    idx = _find_working()
    if idx >= 0:
        return _PROVIDERS[idx]["model"]
    raise ProviderConfigurationError(
        "No configured LLM provider is healthy. Check provider balances, keys, and models."
    )


def get_provider_name() -> str:
    """Return the name of the current working provider."""
    idx = _find_working()
    if idx >= 0:
        return _PROVIDERS[idx]["name"]
    return "none"


# ── Fast-provider selection (for latency-sensitive paths like WhatsApp self-chat) ──

# Fast path picks the fastest healthy provider from the chain.
def _find_fast_working() -> int:
    """Pick the fastest healthy provider from the configured chain."""
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
        "No complete LLM provider is configured. Set MERGE_API_KEY and MERGE_MODEL."
    )


def get_fast_model() -> str:
    """Return the model name for the fastest healthy provider."""
    idx = _find_fast_working()
    if idx >= 0:
        return _PROVIDERS[idx]["model"]
    raise ProviderConfigurationError(
        "No configured LLM provider is healthy. Check provider balances, keys, and models."
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
