"""
Ingestion source abstraction for the Source Sync Engine.

Every external data channel (WhatsApp, IGR, MahaRERA, etc.) subclasses
IngestionSource and registers itself via SourceRegistry. The scheduler uses
this registry to discover jobs, fetch records, and drive the pipeline.

    discover_jobs()    → list[SourceJob]
    fetch_records(job) → Iterator[SourceRecord]

Records flow through the pipeline: store_raw → parse → resolve → observe.

Naming:
    IngestionSource — abstract connector for one external data channel.
                      Subclasses know *how* to reach a source (auth, API, etc.).
    SourceJob       — lightweight descriptor for one unit of work produced by
                      discover_jobs() (e.g. one WhatsApp group, one IGR dataset).
                      meta is always a plain dict here.
    SyncJob         — persisted row in source_sync_jobs (lab.storage).
                      meta is stored as JSON string in the DB.
"""

from dataclasses import dataclass, field
from typing import Iterator, Optional
from datetime import datetime, timezone


# ── Data types ────────────────────────────────────────────────────

@dataclass
class SourceJob:
    """
    An in-memory job descriptor produced by a source plugin's discover_jobs().

    For WhatsApp: one group = one SourceJob.
    For IGR: one year/region = one SourceJob.

    Note: meta is always a plain dict here. When persisted to source_sync_jobs
    the meta column is stored as a JSON string.
    """
    source: str                # "whatsapp", "igr", "maharera", etc.
    instance: str              # e.g., "propai" for Evolution instance
    group_id: str              # e.g., WhatsApp JID, IGR dataset key
    group_name: str = ""       # human-readable label
    meta: dict = field(default_factory=dict)  # source-specific metadata (always dict)

    def to_dict(self) -> dict:
        return {
            "source": self.source,
            "instance": self.instance,
            "group_id": self.group_id,
            "group_name": self.group_name,
            "meta": self.meta,
        }


@dataclass
class SourceRecord:
    """
    One raw record from a source, before any parsing.

    Fields mirror the Evolution API message structure but are generic
    enough for any source.
    """
    source: str                # "whatsapp", "igr", etc.
    instance: str              # source instance identifier
    group_id: str              # source group / dataset
    record_id: str             # unique ID within the source
    text: str                  # main textual content
    sender: str = ""           # originator
    timestamp: Optional[float] = None  # UNIX timestamp
    raw: dict = field(default_factory=dict)  # full source payload
    meta: dict = field(default_factory=dict)  # additional metadata

    @property
    def message_uid(self) -> str:
        """Globally unique identifier for dedup."""
        return f"{self.source}::{self.instance}::{self.group_id}::{self.record_id}"

    @property
    def timestamp_iso(self) -> str:
        if self.timestamp and self.timestamp > 1000000000:
            return datetime.fromtimestamp(self.timestamp, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    def to_dict(self) -> dict:
        return {
            "source": self.source,
            "instance": self.instance,
            "group_id": self.group_id,
            "record_id": self.record_id,
            "text": self.text,
            "sender": self.sender,
            "timestamp": self.timestamp,
            "timestamp_iso": self.timestamp_iso,
            "message_uid": self.message_uid,
            "raw": self.raw,
            "meta": self.meta,
        }


# ── Ingestion Source ─────────────────────────────────────────────

class IngestionSource:
    """
    Abstract base class for all external data ingestion connectors.

    Each subclass represents one channel (WhatsApp, IGR, MahaRERA, …) and
    knows how to authenticate, discover work, and stream raw records. The
    scheduler treats every channel uniformly via this interface.

    Subclass responsibilities:
        - validate_connection(): can we reach the channel right now?
        - discover_jobs():       what units of work are available?
        - fetch_records(job):    stream raw records for one unit of work.
    """

    # Unique source identifier (used in DB and API routes)
    name: str = "unknown"

    # Source version — bump when parser/resolver logic changes for this source
    version: str = "1.0.0"

    def discover_jobs(self) -> list[SourceJob]:
        """
        Return SourceJob descriptors for all available units of work.

        For WhatsApp: one SourceJob per joined group.
        For IGR: one SourceJob per available dataset / year.
        """
        raise NotImplementedError

    def fetch_records(self, job: SourceJob) -> Iterator[SourceRecord]:
        """
        Yield SourceRecords for a given SourceJob, oldest-first.

        Called by the scheduler for each job returned by discover_jobs().
        Implementations should honour job.meta["last_cursor"] for resumability.
        """
        raise NotImplementedError

    def validate_connection(self) -> bool:
        """Return True if the channel is reachable and authenticated."""
        return True

    def __repr__(self) -> str:
        return f"<IngestionSource {self.name} v{self.version}>"


# Backward-compatible alias — remove once all callsites use IngestionSource.
BaseSource = IngestionSource
