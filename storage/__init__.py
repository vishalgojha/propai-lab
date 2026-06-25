"""Storage abstraction layer — swap implementations by changing one import."""

from storage.base import (
    Storage,
    RawMessage, ParsedObservation, ResolverDecision,
    Evaluation, SyncJob, SyncCheckpoint,
)
from storage.sqlite import SqliteStorage

__all__ = [
    "Storage", "SqliteStorage",
    "RawMessage", "ParsedObservation", "ResolverDecision",
    "Evaluation", "SyncJob", "SyncCheckpoint",
]
