"""Local Intelligence Lab — Configuration."""

import os
from pathlib import Path

# Paths
LAB_DIR = Path(__file__).parent
PROJECT_DIR = LAB_DIR
DATA_DIR = PROJECT_DIR / "data"
STATUS_FILE = Path(os.getenv("STATUS_FILE", "status.json"))

# Supabase (required for runtime)
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

# Server
HOST = os.getenv("LAB_HOST", "0.0.0.0")
PORT = int(os.getenv("LAB_PORT", "8000"))

# Frontend URL (used for production redirects — not a local-dev default)
FRONTEND_URL = os.getenv("FRONTEND_URL", "https://app.propai.live")

# Evidence Engine paths (reused)
EVIDENCE_DIR = PROJECT_DIR / "evidence"
REGISTRY_DIR = PROJECT_DIR / "registry"

# Message sources
SOURCE_WHATSAPP = "WHATSAPP"
SOURCE_WHATSAPP_HISTORY = "WHATSAPP_HISTORY"
SOURCE_MANUAL = "MANUAL"

# Doubleword AI (optional chat layer over scraped data)
_DW_KEY_ENV = os.getenv("DOUBLEWORD_API_KEY", "")
_DW_KEY_FILE = Path.home() / ".propai" / "config.json"
DOUBLEWORD_API_KEY = _DW_KEY_ENV
if not DOUBLEWORD_API_KEY and _DW_KEY_FILE.exists():
    import json
    try:
        cfg = json.loads(_DW_KEY_FILE.read_text())
        DOUBLEWORD_API_KEY = cfg.get("doubleword_api_key", "")
    except (json.JSONDecodeError, OSError):
        pass

# Group opt-out list — these WhatsApp groups are not parsed
# File: config.py's directory /group_exclude.json — array of group JIDs or name substrings
# If empty or missing, ALL groups are tracked.
GROUP_EXCLUDE_PATH = LAB_DIR / "group_exclude.json"

def load_excluded_groups() -> list[str]:
    if not GROUP_EXCLUDE_PATH.exists():
        return []
    import json
    try:
        raw = json.loads(GROUP_EXCLUDE_PATH.read_text())
        if isinstance(raw, list):
            return [str(x).strip() for x in raw if x]
        return []
    except (json.JSONDecodeError, OSError):
        return []

def save_excluded_groups(entries: list[str]):
    import json
    GROUP_EXCLUDE_PATH.write_text(json.dumps(entries, indent=2))


# Backward-compatible aliases for older callers.
def load_group_allowlist() -> list[str]:
    return load_excluded_groups()


def save_group_allowlist(entries: list[str]):
    save_excluded_groups(entries)

# Feature flags
ENABLE_AI_PROMO = os.getenv("ENABLE_AI_PROMO", "false").lower() == "true"
ENABLE_META_PUBLISHING = os.getenv("ENABLE_META_PUBLISHING", "false").lower() == "true"

# Observation types
OBS_TYPES = [
    "SELLER", "BUYER", "REQUIREMENT", "RENTAL", "RENTAL_SEEKER",
    "COMMERCIAL_SALE", "COMMERCIAL_RENTAL", "PRE_LAUNCH",
]

# ── Per-model LLM pricing (USD per million tokens) ─────────────────
# Keys must match the model name returned by the provider (what appears in
# the `model` field of OpenAI-compatible responses).  Unknown models fall
# back to DEFAULT_MODEL_PRICING so logging never silently drops a row.
MODEL_PRICING: dict[str, dict[str, float]] = {
    # NVIDIA NIM — Qwen 3.6
    "nvidia-nim": {"input": 0.20, "output": 0.60},
    # Merge Gateway — Claude Haiku 4.5
    "merge": {"input": 1.00, "output": 5.00},
}
DEFAULT_MODEL_PRICING: dict[str, float] = {"input": 0.20, "output": 0.60}


def get_model_pricing(model_name: str = "", provider_name: str = "") -> dict[str, float]:
    """Return per-million-token pricing for a model/provider pair."""
    if provider_name and provider_name in MODEL_PRICING:
        return MODEL_PRICING[provider_name]
    if model_name and model_name in MODEL_PRICING:
        return MODEL_PRICING[model_name]
    return DEFAULT_MODEL_PRICING
