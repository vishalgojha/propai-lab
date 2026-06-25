"""
Source Sync Engine — generic abstraction for external data sources.

Each source (WhatsApp, IGR, MahaRERA, Housing.com, etc.) implements BaseSource
and registers itself via SourceRegistry. The scheduler uses this registry to
discover jobs, fetch records, and run them through the pipeline.

Usage:
    from lab.sources import SourceRegistry
    registry = SourceRegistry()
    whatsapp = registry.get("whatsapp")
    jobs = whatsapp.discover_jobs()
    for record in whatsapp.fetch_records(jobs[0]):
        ...
"""

from lab.sources.base import BaseSource, SourceRecord, SyncJob
from lab.sources.registry import SourceRegistry

from lab.sources.whatsapp import WhatsAppSource

__all__ = ["BaseSource", "SourceRecord", "SyncJob", "SourceRegistry", "WhatsAppSource"]
