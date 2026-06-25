"""Local Intelligence Lab — Configuration."""

import os
from pathlib import Path

# Paths
LAB_DIR = Path(__file__).parent
PROJECT_DIR = LAB_DIR.parent
DATA_DIR = PROJECT_DIR / "data"
DB_PATH = LAB_DIR / "lab.db"

# Server
HOST = os.getenv("LAB_HOST", "0.0.0.0")
PORT = int(os.getenv("LAB_PORT", "8000"))

# Evolution API webhook expects this
WEBHOOK_SECRET = os.getenv("LAB_WEBHOOK_SECRET", "dev-secret-do-not-use-in-prod")

# Evolution API — for historical sync and management
EVOLUTION_API_URL = os.getenv("EVOLUTION_API_URL", "http://localhost:8080")
EVOLUTION_API_KEY = os.getenv("EVOLUTION_API_KEY", "")
EVOLUTION_INSTANCE = os.getenv("EVOLUTION_INSTANCE", "propai")
EVOLUTION_SYNC_DELAY_MS = int(os.getenv("EVOLUTION_SYNC_DELAY_MS", "500"))

# Evidence Engine paths (reused)
EVIDENCE_DIR = PROJECT_DIR / "evidence"
REGISTRY_DIR = PROJECT_DIR / "registry"

# Message sources
SOURCE_WHATSAPP = "WHATSAPP"
SOURCE_WHATSAPP_HISTORY = "WHATSAPP_HISTORY"
SOURCE_MANUAL = "MANUAL"

# Observation types
OBS_TYPES = [
    "SELLER", "BUYER", "RENTAL", "RENTAL_SEEKER",
    "COMMERCIAL_SALE", "COMMERCIAL_RENTAL",
]
