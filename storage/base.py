"""Storage abstraction — all database access goes through here."""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional


# ── Domain models ─────────────────────────────────────────────────


@dataclass
class RawMessage:
    id: int = 0
    group_name: str = ""
    sender: str = ""
    sender_jid: Optional[str] = None
    sender_phone: Optional[str] = None
    message: str = ""
    message_type: str = "text"
    attachments: str = "[]"
    reply_context: str = "{}"
    timestamp: str = ""
    source: str = "WHATSAPP"
    raw_payload: str = "{}"
    message_uid: Optional[str] = None
    pipeline_version: Optional[str] = None
    synced_at: Optional[str] = None
    event_id: Optional[str] = None
    created_at: str = ""


@dataclass
class ParsedObservation:
    id: int = 0
    raw_message_id: int = 0
    message_type: Optional[str] = None
    intent: Optional[str] = None
    principal: Optional[str] = None
    bhk: Optional[str] = None
    price: Optional[float] = None
    price_unit: Optional[str] = None
    area_sqft: Optional[float] = None
    furnishing: Optional[str] = None
    location_raw: Optional[str] = None
    location: Optional[str] = None       # JSON: structured location from parse_location()
    building_name: Optional[str] = None
    landmark_name: Optional[str] = None
    street_name: Optional[str] = None
    area: Optional[str] = None
    micro_market: Optional[str] = None
    developer: Optional[str] = None
    broker_name: Optional[str] = None
    broker_phone: Optional[str] = None
    profile_name: Optional[str] = None
    listing_index: int = 0
    forwarded: int = 0
    confidence: float = 0.0
    raw_payload: str = "{}"
    event_id: Optional[str] = None
    created_at: str = ""
    embedding: Optional[bytes] = None  # float32 numpy array packed via pack_embedding


@dataclass
class Listing:
    id: int = 0
    fingerprint: str = ""
    intent: Optional[str] = None
    bhk: Optional[str] = None
    price: Optional[float] = None
    price_unit: Optional[str] = None
    area_sqft: Optional[float] = None
    furnishing: Optional[str] = None
    location_label: Optional[str] = None
    building_name: Optional[str] = None
    landmark_name: Optional[str] = None
    micro_market: Optional[str] = None
    broker_name: Optional[str] = None
    broker_phone: Optional[str] = None
    first_seen: str = ""
    last_seen: str = ""
    observation_count: int = 0
    group_count: int = 0
    latest_raw_message_id: Optional[int] = None
    representative_raw_message_id: Optional[int] = None
    created_at: str = ""
    updated_at: str = ""


@dataclass
class ResolverDecision:
    id: int = 0
    parsed_id: int = 0
    building_id: Optional[int] = None
    building_name: Optional[str] = None
    landmark_id: Optional[str] = None
    landmark_name: Optional[str] = None
    street_id: Optional[str] = None
    street_name: Optional[str] = None
    project_id: Optional[int] = None
    project_name: Optional[str] = None
    developer_name: Optional[str] = None
    parser_confidence: float = 0.0
    resolver_confidence: float = 0.0
    final_confidence: float = 0.0
    method: str = "unresolved"
    method_detail: Optional[str] = None
    candidates: str = "[]"
    failure_category: Optional[str] = None
    error: Optional[str] = None
    event_id: Optional[str] = None
    created_at: str = ""


@dataclass
class Evaluation:
    id: int = 0
    raw_message_id: int = 0
    expected_intent: Optional[str] = None
    expected_principal: Optional[str] = None
    expected_bhk: Optional[str] = None
    expected_price: Optional[float] = None
    expected_price_unit: Optional[str] = None
    expected_area_sqft: Optional[float] = None
    expected_furnishing: Optional[str] = None
    expected_building: Optional[str] = None
    expected_landmark: Optional[str] = None
    expected_street: Optional[str] = None
    expected_area: Optional[str] = None
    expected_micro_market: Optional[str] = None
    expected_developer: Optional[str] = None
    expected_broker: Optional[str] = None
    extracted_intent: Optional[str] = None
    extracted_principal: Optional[str] = None
    extracted_bhk: Optional[str] = None
    extracted_price: Optional[float] = None
    extracted_price_unit: Optional[str] = None
    extracted_area_sqft: Optional[float] = None
    extracted_furnishing: Optional[str] = None
    extracted_building: Optional[str] = None
    extracted_landmark: Optional[str] = None
    extracted_street: Optional[str] = None
    extracted_area: Optional[str] = None
    extracted_micro_market: Optional[str] = None
    extracted_developer: Optional[str] = None
    extracted_broker: Optional[str] = None
    accuracy_overall: Optional[float] = None
    correction_notes: Optional[str] = None
    evaluated_at: Optional[str] = None
    event_id: Optional[str] = None
    created_at: str = ""


@dataclass
class SyncJob:
    id: int = 0
    source: str = ""
    instance: str = ""
    group_id: str = ""
    group_name: str = ""
    meta: str = "{}"
    status: str = "pending"
    records_found: int = 0
    records_processed: int = 0
    records_failed: int = 0
    last_cursor: Optional[str] = None
    error: Optional[str] = None
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    created_at: str = ""
    updated_at: str = ""


@dataclass
class AISuggestion:
    id: int = 0
    agent: str = ""
    suggestion_type: str = ""
    title: str = ""
    description: str = ""
    source_data: str = "{}"
    proposal_data: str = "{}"
    confidence: float = 0.0
    status: str = "pending"
    rejection_reason: Optional[str] = None
    created_at: str = ""
    updated_at: str = ""


@dataclass
class AIUsageLog:
    id: int = 0
    agent: str = ""
    model: str = "gpt-4o-mini"
    tokens_input: int = 0
    tokens_output: int = 0
    cost_usd: float = 0.0
    source: str = "enrichment"
    source_id: Optional[int] = None
    created_at: str = ""


@dataclass
class LocationAlias:
    id: int = 0
    alias: str = ""
    canonical: str = ""
    confidence: float = 0.0
    source: str = "ai"
    created_at: str = ""


@dataclass
class BuildingAlias:
    id: int = 0
    alias: str = ""
    canonical: str = ""
    confidence: float = 0.0
    source: str = "ai"
    created_at: str = ""


@dataclass
class EnrichmentJob:
    id: int = 0
    parsed_id: int = 0
    raw_message_id: int = 0
    status: str = "pending"
    scheduled_after: str = ""
    attempts: int = 0
    last_error: Optional[str] = None
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    created_at: str = ""


@dataclass
class SyncCheckpoint:
    id: int = 0
    instance_name: str = ""
    group_jid: str = ""
    group_name: str = ""
    group_owner: str = ""
    participants: int = 0
    last_message_id: Optional[str] = None
    last_message_ts: Optional[str] = None
    first_message_ts: Optional[str] = None
    last_synced_ts: Optional[str] = None
    total_available: int = 0
    synced_count: int = 0
    status: str = "pending"
    error: Optional[str] = None
    created_at: str = ""
    updated_at: str = ""


def dict_to_dataclass(cls, d):
    """Convert a dict or sqlite3.Row to a dataclass, skipping unknown fields."""
    if hasattr(d, 'keys'):
        d = dict(d)
    field_names = {f.name for f in cls.__dataclass_fields__.values()}
    filtered = {k: v for k, v in d.items() if k in field_names}
    return cls(**filtered)


# ── Abstract storage interface ────────────────────────────────────


class Storage(ABC):
    """Every database operation goes through this interface."""

    @abstractmethod
    def init_schema(self): ...

    # ── Raw messages ───────────────────────────────────────────

    @abstractmethod
    def get_raw_by_uid(self, message_uid: str) -> Optional[RawMessage]: ...

    @abstractmethod
    def save_raw_message(self, msg: RawMessage) -> int: ...

    @abstractmethod
    def get_raw_message(self, id: int) -> Optional[RawMessage]: ...

    @abstractmethod
    def get_raw_messages(self, limit: int = 50, offset: int = 0,
                         source: str = "", group_name: str = "",
                         sender: str = "", sender_phone: str = "",
                         sender_jid: str = "") -> list[RawMessage]: ...

    @abstractmethod
    def get_all_raw_for_replay(self) -> list[RawMessage]: ...

    # ── Parsed observations ────────────────────────────────────

    @abstractmethod
    def save_parsed(self, obs: ParsedObservation) -> int: ...

    @abstractmethod
    def get_parsed_by_raw(self, raw_id: int) -> Optional[ParsedObservation]: ...

    @abstractmethod
    def get_parsed(self, limit: int = 50, offset: int = 0, intent: str = "") -> list[dict]: ...

    @abstractmethod
    def get_listings(self, limit: int = 50, offset: int = 0) -> list[dict]: ...

    @abstractmethod
    def rebuild_listings(self): ...

    # ── Resolver decisions ─────────────────────────────────────

    @abstractmethod
    def save_resolver_decision(self, dec: ResolverDecision) -> int: ...

    @abstractmethod
    def get_resolver_by_parsed(self, parsed_id: int) -> Optional[ResolverDecision]: ...

    @abstractmethod
    def get_resolver_decisions(self, limit: int = 50, offset: int = 0,
                               method: str = "") -> list[dict]: ...

    @abstractmethod
    def get_failed(self, limit: int = 50, offset: int = 0) -> list[dict]: ...

    # ── Evaluations ────────────────────────────────────────────

    @abstractmethod
    def save_evaluation(self, ev: Evaluation) -> int: ...

    @abstractmethod
    def get_evaluation_by_raw(self, raw_id: int) -> Optional[Evaluation]: ...

    @abstractmethod
    def get_evaluations(self, limit: int = 50, offset: int = 0) -> list[dict]: ...

    # ── Sync jobs ──────────────────────────────────────────────

    @abstractmethod
    def create_sync_job(self, job: SyncJob) -> int: ...

    @abstractmethod
    def update_sync_job(self, job_id: int, **updates): ...

    @abstractmethod
    def get_sync_job(self, job_id: int) -> Optional[SyncJob]: ...

    @abstractmethod
    def upsert_sync_job(self, source: str, instance: str = "",
                        group_id: str = "", group_name: str = "",
                        participants: int = 0,
                        status: str = "pending") -> int: ...

    @abstractmethod
    def prune_sync_jobs(self, source: str, instance: str,
                        keep_jids: set) -> int: ...

    @abstractmethod
    def get_sync_jobs(self, limit: int = 200, offset: int = 0,
                      source: str = "", status: str = "") -> list[SyncJob]: ...

    # ── Sync checkpoints ───────────────────────────────────────

    @abstractmethod
    def get_checkpoints(self, instance_name: str) -> list[SyncCheckpoint]: ...

    @abstractmethod
    def save_checkpoint(self, cp: SyncCheckpoint): ...

    @abstractmethod
    def get_checkpoint(self, instance_name: str,
                       group_jid: str) -> Optional[SyncCheckpoint]: ...

    # ── Stats ──────────────────────────────────────────────────

    @abstractmethod
    def get_stats(self) -> dict: ...

    # ── Observation detail (Evidence Inspector) ────────────────

    @abstractmethod
    def get_observation_detail(self, obs_id: int) -> dict: ...

    # ── Source summary ─────────────────────────────────────────

    @abstractmethod
    def source_summary(self) -> dict: ...

    # ── AI layer (read-only) ───────────────────────────────────

    @abstractmethod
    def get_all_parsed_with_embeddings(self) -> list[dict]: ...

    @abstractmethod
    def knn_search(self, query_embedding: bytes, k: int = 10) -> list[dict]: ...

    @abstractmethod
    def get_observations_by_broker(self, broker_name: str) -> list[dict]: ...

    @abstractmethod
    def get_observations_by_building(self, building_name: str) -> list[dict]: ...

    @abstractmethod
    def get_top_brokers_today(self, today_prefix: str, limit: int = 10) -> list[dict]: ...

    # ── Dashboard ──────────────────────────────────────────────

    @abstractmethod
    def dashboard_activity(self, today_prefix: str) -> dict: ...

    @abstractmethod
    def dashboard_feed(self, limit: int = 20) -> list[dict]: ...

    @abstractmethod
    def dashboard_heatmap(self) -> list[dict]: ...

    @abstractmethod
    def dashboard_listings(self, limit: int = 20) -> list[dict]: ...

    @abstractmethod
    def dashboard_requirements(self, limit: int = 20) -> list[dict]: ...

    @abstractmethod
    def dashboard_signals(self) -> list[dict]: ...

    @abstractmethod
    def dashboard_message_types_today(self, today_prefix: str) -> list[dict]: ...

    @abstractmethod
    def dashboard_obs_types_today(self, today_prefix: str) -> list[dict]: ...

    @abstractmethod
    def dashboard_growth(self, today_prefix: str) -> dict: ...

    # ── Enrichment jobs ────────────────────────────────────────

    @abstractmethod
    def create_enrichment_job(self, parsed_id: int, raw_message_id: int,
                              scheduled_after: str) -> int: ...

    @abstractmethod
    def get_pending_enrichment_jobs(self, limit: int = 50) -> list[dict]: ...

    @abstractmethod
    def claim_enrichment_job(self, job_id: int) -> bool: ...

    @abstractmethod
    def complete_enrichment_job(self, job_id: int, error: str = ""): ...

    @abstractmethod
    def get_enrichment_job_by_parsed(self, parsed_id: int) -> Optional[dict]: ...

    # ── Knowledge graph aliases ─────────────────────────────────

    @abstractmethod
    def create_location_alias(self, alias: str, canonical: str,
                              confidence: float = 0.0, source: str = "ai") -> bool: ...

    @abstractmethod
    def create_building_alias(self, alias: str, canonical: str,
                              confidence: float = 0.0, source: str = "ai") -> bool: ...

    @abstractmethod
    def resolve_location(self, text: str) -> Optional[str]: ...

    @abstractmethod
    def resolve_building(self, text: str) -> Optional[str]: ...

    # ── Price stats ────────────────────────────────────────────

    @abstractmethod
    def recompute_price_stats(self): ...

    @abstractmethod
    def get_price_stats(self, micro_market: str, bhk: str,
                        intent: str = "listing") -> Optional[dict]: ...

    # ── Suggestion lifecycle ───────────────────────────────────

    @abstractmethod
    def create_suggestion(self, sug: AISuggestion) -> int: ...

    @abstractmethod
    def apply_suggestion(self, sug_id: int) -> bool: ...

    @abstractmethod
    def update_suggestion_status(self, sug_id: int, status: str, rejection_reason: str = ""): ...

    @abstractmethod
    def batch_update_suggestions(self, ids: list[int], status: str, rejection_reason: str = ""): ...

    @abstractmethod
    def get_ai_memory_stats(self) -> dict: ...

    @abstractmethod
    def get_ai_usage_stats(self, days: int = 1) -> dict: ...
