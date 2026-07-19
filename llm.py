"""
LLM provider fallback — NVIDIA first, then free providers, Doubleword (paid) last.

Usage:
    from llm import get_client, get_model
    client = get_client()
    model = get_model()
    resp = client.chat.completions.create(model=model, messages=[...])
"""

import os
import time
from openai import OpenAI

# ── Provider chain: NVIDIA first, Doubleword last ─────────────────

_PROVIDERS = []

if os.getenv("NVIDIA_API_KEY"):
    _PROVIDERS.append({
        "name": "nvidia-nim",
        "api_key": os.environ["NVIDIA_API_KEY"],
        "base_url": "https://integrate.api.nvidia.com/v1",
        "model": "nvidia/nemotron-3-ultra-550b-a55b",
    })

if os.getenv("GROQ_API_KEY"):
    _PROVIDERS.append({
        "name": "groq",
        "api_key": os.environ["GROQ_API_KEY"],
        "base_url": "https://api.groq.com/openai/v1",
        "model": "llama-3.3-70b-versatile",
    })

if os.getenv("GEMINI_API_KEY"):
    _PROVIDERS.append({
        "name": "gemini",
        "api_key": os.environ["GEMINI_API_KEY"],
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "model": "gemini-2.0-flash",
    })

if os.getenv("CEREBRAS_API_KEY"):
    _PROVIDERS.append({
        "name": "cerebras",
        "api_key": os.environ["CEREBRAS_API_KEY"],
        "base_url": "https://api.cerebras.ai/v1",
        "model": "llama-3.3-70b",
    })

# Doubleword — paid, always last
_dw_key = os.getenv("DOUBLEWORD_API_KEY", "")
if _dw_key:
    _PROVIDERS.append({
        "name": "doubleword",
        "api_key": _dw_key,
        "base_url": os.getenv("DOUBLEWORD_API_URL", "https://api.doubleword.ai/v1"),
        "model": os.getenv("DOUBLEWORD_MODEL", "Qwen/Qwen3.6-35B-A3B-FP8"),
    })

# ── Health cache ────────────────────────────────────────────────────

_cached_index: int | None = None
_cached_ts: float = 0
_CACHE_TTL = 5 * 60  # 5 minutes


def _ping_provider(p: dict) -> bool:
    """Quick health check — 1-token completion."""
    try:
        import httpx
        r = httpx.post(
            f"{p['base_url']}/chat/completions",
            headers={"Authorization": f"Bearer {p['api_key']}", "Content-Type": "application/json"},
            json={"model": p["model"], "messages": [{"role": "user", "content": "hi"}], "max_tokens": 1},
            timeout=8.0,
        )
        return r.status_code < 500
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
            return i

    return -1


# ── Public API ──────────────────────────────────────────────────────

def get_client() -> OpenAI:
    """Return an OpenAI client pointing at the first healthy provider."""
    idx = _find_working()
    if idx >= 0:
        p = _PROVIDERS[idx]
        return OpenAI(api_key=p["api_key"], base_url=p["base_url"])
    # Fallback: return Doubleword client (will fail if no key)
    if _PROVIDERS:
        p = _PROVIDERS[-1]
        return OpenAI(api_key=p["api_key"], base_url=p["base_url"])
    return OpenAI(api_key="none", base_url="https://api.doubleword.ai/v1")


def get_model() -> str:
    """Return the model name for the current working provider."""
    idx = _find_working()
    if idx >= 0:
        return _PROVIDERS[idx]["model"]
    if _PROVIDERS:
        return _PROVIDERS[-1]["model"]
    return "Qwen/Qwen3.6-35B-A3B-FP8"


def get_provider_name() -> str:
    """Return the name of the current working provider."""
    idx = _find_working()
    if idx >= 0:
        return _PROVIDERS[idx]["name"]
    return "none"
