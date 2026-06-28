"""Local Intelligence Lab — Configuration."""

import os
from pathlib import Path

# Paths
LAB_DIR = Path(__file__).parent
PROJECT_DIR = LAB_DIR
DATA_DIR = PROJECT_DIR / "data"
DB_PATH = LAB_DIR / "lab.db"
BAILEYS_AUTH_DIR = PROJECT_DIR / "services" / "baileys-ingestor" / "auth"
BAILEYS_STATUS_FILE = Path(os.getenv("BAILEYS_STATUS_FILE", str(BAILEYS_AUTH_DIR / "status.json")))

# Server
HOST = os.getenv("LAB_HOST", "0.0.0.0")
PORT = int(os.getenv("LAB_PORT", "8000"))

# Evolution API webhook expects this
WEBHOOK_SECRET = os.getenv("LAB_WEBHOOK_SECRET", "dev-secret-do-not-use-in-prod")

# Evolution API — for historical sync and management
EVOLUTION_API_URL = os.getenv("EVOLUTION_API_URL", "http://localhost:8080")
_EVOLUTION_API_KEY_ENV = os.getenv("EVOLUTION_API_KEY", "")
EVOLUTION_API_KEY = _EVOLUTION_API_KEY_ENV or (LAB_DIR / ".api_key").read_text().strip() if (LAB_DIR / ".api_key").exists() else ""
EVOLUTION_INSTANCE = os.getenv("EVOLUTION_INSTANCE", "propai-scraper")
EVOLUTION_SYNC_DELAY_MS = int(os.getenv("EVOLUTION_SYNC_DELAY_MS", "500"))

# PropAI webhook URL that Evolution API sends events to
# Set this if the auto-detected URL (host.docker.internal:PORT) is wrong
PROPAI_WEBHOOK_URL = os.getenv("PROPAI_WEBHOOK_URL", "")

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

# Group allowlist — only track these WhatsApp groups
# File: config.py's directory /group_allowlist.json — array of group JIDs or name substrings
# If empty or missing, ALL groups are tracked.
GROUP_ALLOWLIST_PATH = LAB_DIR / "group_allowlist.json"

def load_group_allowlist() -> list[str]:
    if not GROUP_ALLOWLIST_PATH.exists():
        return []
    import json
    try:
        raw = json.loads(GROUP_ALLOWLIST_PATH.read_text())
        if isinstance(raw, list):
            return [str(x).strip() for x in raw if x]
        return []
    except (json.JSONDecodeError, OSError):
        return []

def save_group_allowlist(entries: list[str]):
    import json
    GROUP_ALLOWLIST_PATH.write_text(json.dumps(entries, indent=2))

# Feature flags
ENABLE_AI_PROMO = os.getenv("ENABLE_AI_PROMO", "false").lower() == "true"
ENABLE_META_PUBLISHING = os.getenv("ENABLE_META_PUBLISHING", "false").lower() == "true"

# Observation types
OBS_TYPES = [
    "SELLER", "BUYER", "REQUIREMENT", "RENTAL", "RENTAL_SEEKER",
    "COMMERCIAL_SALE", "COMMERCIAL_RENTAL", "PRE_LAUNCH",
]
