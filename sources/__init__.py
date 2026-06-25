"""
Source Sync Engine — pluggable ingestion connectors for external data channels.

Each channel (WhatsApp, IGR, MahaRERA, Housing.com, etc.) subclasses
IngestionSource and registers itself via SourceRegistry. The scheduler
discovers jobs, streams records, and drives the pipeline.

Conceptual hierarchy:
    IngestionSource.discover_jobs() → [SourceJob]
            ↓
        Scheduler → SyncJob (DB row in source_sync_jobs)
            ↓
        Pipeline → Observations

Usage:
    from lab.sources import SourceRegistry, IngestionSource
    registry = SourceRegistry()
    whatsapp = registry.get("whatsapp")
    jobs = whatsapp.discover_jobs()          # list[SourceJob]
    for record in whatsapp.fetch_records(jobs[0]):
        ...
"""

from lab.sources.base import IngestionSource, SourceRecord, SourceJob
from lab.sources.registry import SourceRegistry

from lab.sources.whatsapp import WhatsAppSource

# Backward-compatible aliases — prefer the names above in new code.
BaseSource = IngestionSource   # BaseSource → IngestionSource
SyncJob = SourceJob            # SyncJob (sources) → SourceJob

__all__ = [
    # Canonical names
    "IngestionSource",
    "SourceRecord",
    "SourceJob",
    "SourceRegistry",
    "WhatsAppSource",
    # Deprecated aliases (kept for backward compat)
    "BaseSource",
    "SyncJob",
]
