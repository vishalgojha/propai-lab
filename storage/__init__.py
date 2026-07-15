"""Storage abstraction layer — swap implementations by changing one import."""

from lab.storage.base import (
    Storage,
    RawMessage, ParsedObservation, ResolverDecision,
    Evaluation, SyncJob, SyncCheckpoint, LLMProvider,
)
from storage.supabase import SupabaseStorage, set_tenant_id, get_tenant_id

__all__ = [
    "Storage", "SupabaseStorage",
    "RawMessage", "ParsedObservation", "ResolverDecision",
    "Evaluation", "SyncJob", "SyncCheckpoint", "LLMProvider",
    "set_tenant_id", "get_tenant_id",
]
