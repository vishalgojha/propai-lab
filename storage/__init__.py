"""Storage abstraction layer — swap implementations by changing one import."""

from lab.storage.base import (
    Storage,
    RawMessage, ParsedObservation, ResolverDecision,
    Evaluation, SyncJob, SyncCheckpoint, LLMProvider,
)
from lab.storage.supabase import SupabaseStorage

__all__ = [
    "Storage", "SupabaseStorage",
    "RawMessage", "ParsedObservation", "ResolverDecision",
    "Evaluation", "SyncJob", "SyncCheckpoint", "LLMProvider",
]
