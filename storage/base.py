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
    message: str = ""
    message_type: str = "text"
    timestamp: str = ""
    source: str = "WHATSAPP"
    raw_payload: str = "{}"
    message_uid: Optional[str] = None
    pipeline_version: Optional[str] = None
    synced_at: Optional[str] = None
    created_at: str = ""


@dataclass
class ParsedObservation:
    id: int = 0
    raw_message_id: int = 0
    message_type: Optional[str] = None
    bhk: Optional[str] = None
    price: Optional[float] = None
    price_unit: Optional[str] = None
    area_sqft: Optional[float] = None
    furnishing: Optional[str] = None
    location_raw: Optional[str] = None
    building_name: Optional[str] = None
    landmark_name: Optional[str] = None
    street_name: Optional[str] = None
    area: Optional[str] = None
    micro_market: Optional[str] = None
    developer: Optional[str] = None
    broker_name: Optional[str] = None
    broker_phone: Optional[str] = None
    confidence: float = 0.0
    raw_payload: str = "{}"
    created_at: str = ""


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
    created_at: str = ""


@dataclass
class Evaluation:
    id: int = 0
    raw_message_id: int = 0
    expected_message_type: Optional[str] = None
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
    extracted_message_type: Optional[str] = None
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
                         source: str = "") -> list[RawMessage]: ...

    @abstractmethod
    def get_all_raw_for_replay(self) -> list[RawMessage]: ...

    # ── Parsed observations ────────────────────────────────────

    @abstractmethod
    def save_parsed(self, obs: ParsedObservation) -> int: ...

    @abstractmethod
    def get_parsed_by_raw(self, raw_id: int) -> Optional[ParsedObservation]: ...

    @abstractmethod
    def get_parsed(self, limit: int = 50, offset: int = 0) -> list[dict]: ...

    # ── Resolver decisions ─────────────────────────────────────

    @abstractmethod
    def save_resolver_decision(self, dec: ResolverDecision) -> int: ...

    @abstractmethod
    def get_resolver_by_parsed(self, parsed_id: int) -> Optional[ResolverDecision]: ...

    @abstractmethod
    def get_resolver_decisions(self, limit: int = 50, offset: int = 0,
                               method: str = "") -> list[dict]: ...

    @abstractmethod
    def get_failed(self, limit: int = 50) -> list[dict]: ...

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
