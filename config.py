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

# Region-sensitive extraction hints.  These are deliberately configuration,
# not product-wide assumptions: the model still owns semantic interpretation
# and these values only support deterministic validation/fallback paths.
REGION_CONFIG: dict[str, dict] = {
    "mumbai": {
        "locality_patterns": [
            "andheri", "bandra", "khar", "juhu", "santacruz", "bkc",
            "lokhandwala", "powai", "worli", "goregaon", "malad",
            "jogeshwari", "vile\\s+parle", "versova", "borivali", "thane",
            "mulund", "mahim", "pali\\s+hill", "pali\\s+naka", "waterfield",
            "turner\\s+road", "linking\\s+road", "carter\\s+road",
            "altamount\\s+road", "napean\\s+sea\\s+road", "kemps\\s+corner",
            "sv\\s+road", "road", "street", "lane", "nagar", "phase",
            "sector", "metro", "station", "exchange", "complex", "garden",
            "heights", "tower", "building", "apartment", "residency", "estate",
        ],
        "price_floors": {"rent_min": 1_000, "sale_min": 100_000, "commercial_sale_min": 1_000_000},
        "broker_glossary": "Mumbai broker shorthand and locality conventions apply where supported by the source.",
        "unlabeled_lakh_is_rental": True,
    },
    "delhi": {
        "locality_patterns": [
            "south\\s+delhi", "gurgaon", "gurugram", "noida", "greater\\s+noida",
            "dwarka", "vasant\\s+kunj", "saket", "defence\\s+colony", "rohini",
            "sector", "phase", "road", "street", "nagar", "extension", "heights",
            "tower", "building", "apartment", "residency", "estate",
        ],
        "price_floors": {"rent_min": 3_000, "sale_min": 200_000, "commercial_sale_min": 2_000_000},
        "broker_glossary": "Delhi-NCR broker shorthand: preserve explicit lakh/crore units and treat unqualified prices as ambiguous unless the source labels rent or sale.",
        "unlabeled_lakh_is_rental": False,
    },
}
DEFAULT_REGION = "mumbai"


def get_region_config(region: str | None = None) -> dict:
    """Return the active region's extraction configuration."""
    key = str(region or os.getenv("EXTRACTION_REGION", DEFAULT_REGION)).strip().casefold()
    return REGION_CONFIG.get(key, REGION_CONFIG[DEFAULT_REGION])

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
# Keys may be either a provider name (what llm.py / ai_extraction.py pass
# as `name`, e.g. "grid", "grid_1") or a model name.  Numbered provider
# variants ("grid_1") match their base key via prefix lookup.  Unknown
# models fall back to DEFAULT_MODEL_PRICING so logging never silently
# drops a row. Sarvam publishes rates in INR, so its USD proxy is derived from
# the configurable INR/USD rate below. Usage logs remain comparable because
# ai_usage_log.cost_usd is the canonical ledger currency.
SARVAM_INR_PER_USD = float(os.getenv("SARVAM_INR_PER_USD", "95.23"))
_SARVAM_INPUT_USD = 29.28 / SARVAM_INR_PER_USD
_SARVAM_CACHED_INPUT_USD = 10.98 / SARVAM_INR_PER_USD
_SARVAM_OUTPUT_USD = 73.20 / SARVAM_INR_PER_USD

MODEL_PRICING: dict[str, dict[str, float]] = {
    # NVIDIA NIM — llama-3.1-8b-instruct
    "nvidia-nim": {"input": 0.20, "output": 0.60},
    "nvidia": {"input": 0.20, "output": 0.60},
    # Merge Gateway — Claude Haiku 4.5
    "merge": {"input": 1.00, "output": 5.00},
    # Grid (code-max / text-max) — dynamic "as low as" pricing; blended proxy
    "grid": {"input": 1.40, "output": 1.40},
    # Groq — llama-3.1-8b-instant
    "groq": {"input": 0.05, "output": 0.08},
    # Cerebras — 8B family
    "cerebras": {"input": 0.10, "output": 0.30},
    # Google Gemini — flash-lite class
    "gemini": {"input": 0.10, "output": 0.40},
    # OpenRouter Z.ai GLM-5.3-Flash (model-specific public rates)
    "extraction-openrouter-secondary": {"input": 0.075, "output": 0.25},
    # Sarvam 105B — official rate ₹29.28 / ₹10.98 cached / ₹73.20 per 1M
    # tokens, converted to USD for the existing usage ledger.
    "extraction-sarvam": {"input": _SARVAM_INPUT_USD, "cached_input": _SARVAM_CACHED_INPUT_USD, "output": _SARVAM_OUTPUT_USD},
    "sarvam-105b": {"input": _SARVAM_INPUT_USD, "cached_input": _SARVAM_CACHED_INPUT_USD, "output": _SARVAM_OUTPUT_USD},
    "sarvam-105b-conversations": {"input": _SARVAM_INPUT_USD, "cached_input": _SARVAM_CACHED_INPUT_USD, "output": _SARVAM_OUTPUT_USD},
}
DEFAULT_MODEL_PRICING: dict[str, float] = {"input": 0.20, "output": 0.60}


def get_model_pricing(model_name: str = "", provider_name: str = "") -> dict[str, float]:
    """Return per-million-token pricing for a model/provider pair."""
    if provider_name:
        for key, price in MODEL_PRICING.items():
            if provider_name == key or provider_name.startswith((f"{key}_", f"{key}-")):
                return price
    if model_name and model_name in MODEL_PRICING:
        return MODEL_PRICING[model_name]
    return DEFAULT_MODEL_PRICING
