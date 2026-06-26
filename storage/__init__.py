"""Storage abstraction layer — swap implementations by changing one import."""

from lab.storage.base import (
    Storage,
    RawMessage, ParsedObservation, ResolverDecision,
    Evaluation, SyncJob, SyncCheckpoint,
)
from lab.storage.sqlite import SqliteStorage

__all__ = [
    "Storage", "SqliteStorage",
    "RawMessage", "ParsedObservation", "ResolverDecision",
    "Evaluation", "SyncJob", "SyncCheckpoint",
]
