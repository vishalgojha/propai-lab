"""Durable semantic indexing for PropAI entities.

Embeddings are an asynchronous retrieval aid. They never create inventory,
change canonical identities, or auto-merge entities.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import time
from dataclasses import dataclass
from typing import Any, Iterable

import httpx

log = logging.getLogger(__name__)

DEFAULT_MODEL = "nvidia/nemotron-3-embed-1b:free"
DEFAULT_DIMENSIONS = 1024
_PHONE_RE = re.compile(r"(?<!\d)[6-9]\d{9}(?!\d)")
_SPACE_RE = re.compile(r"\s+")


def _clean(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple, set)):
        value = ", ".join(str(item) for item in value if item not in (None, ""))
    elif isinstance(value, dict):
        value = json.dumps(value, ensure_ascii=False, sort_keys=True)
    text = _PHONE_RE.sub("", str(value))
    return _SPACE_RE.sub(" ", text).strip(" ,|-")


def _parts(*pairs: tuple[str, Any]) -> str:
    return " | ".join(f"{label}: {text}" for label, value in pairs if (text := _clean(value)))


def build_semantic_document(entity_type: str, row: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """Return privacy-safe retrieval text and a small display metadata snapshot."""
    if entity_type in {"listing", "requirement"}:
        role = "property listing" if entity_type == "listing" else "property requirement"
        content = _parts(
            ("role", role),
            ("asset", row.get("asset_type")),
            ("transaction", row.get("transaction_type")),
            ("building", row.get("building_name")),
            ("locality", row.get("micro_market") or row.get("locality_resolved") or row.get("locality_raw")),
            ("landmark", row.get("landmark_name")),
            ("configuration", row.get("bhk") or row.get("bhk_options")),
            ("use", row.get("commercial_use_type")),
            ("area sqft", row.get("carpet_area_sqft") or row.get("area_min_sqft")),
            ("furnishing", row.get("furnishing_status") or row.get("fitout_status") or row.get("furnishing_preference")),
            ("title", row.get("summary_title")),
            ("evidence", row.get("normalized_message")),
        )
    elif entity_type in {"building", "building_alias"}:
        content = _parts(
            ("entity", "building"),
            ("name", row.get("alias") if entity_type == "building_alias" else row.get("canonical_name")),
            ("canonical", row.get("canonical_name")),
            ("locality", row.get("micro_market")),
            ("address", row.get("address")),
            ("developer", row.get("developer")),
            ("pincode", row.get("pincode")),
            ("landmarks", row.get("nearby_landmarks")),
            ("roads", row.get("nearby_roads")),
        )
    elif entity_type == "locality":
        content = _parts(
            ("entity", "locality"),
            ("sub locality", row.get("sub_locality")),
            ("parent locality", row.get("parent_locality")),
            ("city", row.get("city")),
            ("alternate names", row.get("alternate_names")),
            ("landmarks", row.get("landmarks")),
        )
    elif entity_type in {"broker", "broker_alias"}:
        content = _parts(
            ("entity", "real estate broker"),
            ("name", row.get("canonical_name") or row.get("alias")),
            ("listings", row.get("listing_count")),
            ("requirements", row.get("requirement_count")),
            ("rentals", row.get("rental_count")),
            ("commercial", row.get("commercial_count")),
            ("markets", row.get("market_count")),
            ("buildings", row.get("building_count")),
        )
    else:
        content = _parts(("entity", entity_type), ("text", row))

    metadata = {
        key: row.get(key)
        for key in (
            "id", "building_id", "broker_id", "raw_message_id", "canonical_name",
            "building_name", "micro_market", "locality_resolved", "summary_title",
            "asset_type", "transaction_type", "bhk", "commercial_use_type",
            "total_asking_price", "monthly_rent", "budget_min", "budget_max",
            "visibility", "source_scope", "created_at", "updated_at",
        )
        if row.get(key) is not None
    }
    return content[:12000], metadata


def content_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def normalize_vector(values: Iterable[float], dimensions: int = DEFAULT_DIMENSIONS) -> list[float]:
    vector = [float(value) for value in values]
    if len(vector) < dimensions:
        raise ValueError(f"embedding has {len(vector)} dimensions, expected at least {dimensions}")
    vector = vector[:dimensions]
    norm = math.sqrt(sum(value * value for value in vector))
    if not norm:
        raise ValueError("embedding vector has zero norm")
    return [value / norm for value in vector]


def vector_literal(values: Iterable[float]) -> str:
    return "[" + ",".join(f"{value:.9g}" for value in values) + "]"


def _rpc_data(client: Any, name: str, params: dict[str, Any]) -> Any:
    """Support both supabase-py builders and PropAI's direct REST client."""
    result = client.rpc(name, params)
    if hasattr(result, "execute"):
        result = result.execute()
    return getattr(result, "data", result)


@dataclass(frozen=True)
class EmbeddingConfig:
    api_key: str
    base_url: str
    model: str
    dimensions: int
    timeout_seconds: float

    @classmethod
    def from_env(cls) -> "EmbeddingConfig":
        return cls(
            api_key=(
                os.getenv("EMBEDDING_API_KEY")
                or os.getenv("OPENROUTER_API_KEY")
                or os.getenv("DOUBLEWORD_EMBEDDING_API_KEY")
                or os.getenv("DOUBLEWORD_API_KEY")
                or ""
            ).strip(),
            base_url=(os.getenv("EMBEDDING_BASE_URL") or "https://openrouter.ai/api/v1").rstrip("/"),
            model=(os.getenv("EMBEDDING_MODEL") or DEFAULT_MODEL).strip(),
            dimensions=int(os.getenv("EMBEDDING_DIMENSIONS") or DEFAULT_DIMENSIONS),
            timeout_seconds=float(os.getenv("EMBEDDING_TIMEOUT_SECONDS") or 30),
        )


class EmbeddingClient:
    def __init__(self, config: EmbeddingConfig | None = None):
        self.config = config or EmbeddingConfig.from_env()
        if self.config.dimensions != DEFAULT_DIMENSIONS:
            raise ValueError(f"EMBEDDING_DIMENSIONS must be {DEFAULT_DIMENSIONS}")

    @property
    def configured(self) -> bool:
        return bool(self.config.api_key and self.config.model)

    def embed(self, texts: list[str], *, input_type: str) -> list[list[float]]:
        if not self.configured:
            raise RuntimeError("EMBEDDING_API_KEY/OPENROUTER_API_KEY is not configured")
        payload: dict[str, Any] = {
            "model": self.config.model,
            "input": texts,
            "encoding_format": "float",
            "input_type": input_type,
        }
        # Nemotron supports Matryoshka slicing. If a provider ignores this,
        # normalize_vector performs the documented prefix slice locally.
        payload["dimensions"] = self.config.dimensions
        response = httpx.post(
            f"{self.config.base_url}/embeddings",
            headers={"Authorization": f"Bearer {self.config.api_key}", "Content-Type": "application/json"},
            json=payload,
            timeout=self.config.timeout_seconds,
        )
        response.raise_for_status()
        body = response.json()
        items = sorted(body.get("data") or [], key=lambda item: int(item.get("index", 0)))
        if len(items) != len(texts):
            raise RuntimeError(f"embedding provider returned {len(items)} vectors for {len(texts)} texts")
        return [normalize_vector(item.get("embedding") or [], self.config.dimensions) for item in items]


class SemanticIndexWorker:
    def __init__(self, storage: Any, *, batch_size: int = 16, poll_seconds: float = 5, max_attempts: int = 5):
        self.storage = storage
        self.client = EmbeddingClient()
        self.batch_size = max(1, min(batch_size, 64))
        self.poll_seconds = max(1.0, poll_seconds)
        self.max_attempts = max_attempts

    def _fetch_jobs(self) -> list[dict[str, Any]]:
        result = (
            self.storage.client.table("semantic_embedding_jobs")
            .select("*")
            .in_("status", ["pending", "failed"])
            .lte("scheduled_after", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
            .lt("attempts", self.max_attempts)
            .order("id")
            .limit(self.batch_size)
            .execute()
        )
        return result.data or []

    def _fetch_source(self, job: dict[str, Any]) -> dict[str, Any] | None:
        result = (
            self.storage.client.table(job["source_table"])
            .select("*")
            .eq("id", job["source_id"])
            .limit(1)
            .execute()
        )
        return (result.data or [None])[0]

    def _mark(self, job_id: int, **values: Any) -> None:
        values["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self.storage.client.table("semantic_embedding_jobs").update(values).eq("id", job_id).execute()

    def run_once(self) -> int:
        jobs = self._fetch_jobs()
        if not jobs:
            # Fresh-first bounded backfill. The RPC queues at most a small
            # page per source table and never scans historical stale inventory.
            _rpc_data(self.storage.client, "enqueue_semantic_backfill", {
                "p_limit": max(5, self.batch_size // 2),
            })
            jobs = self._fetch_jobs()
            if not jobs:
                return 0
        prepared: list[tuple[dict[str, Any], dict[str, Any], str, dict[str, Any], str]] = []
        for job in jobs:
            self._mark(job["id"], status="running", attempts=int(job.get("attempts") or 0) + 1,
                       started_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
            try:
                row = self._fetch_source(job)
                if not row:
                    self.storage.client.table("semantic_embeddings").delete().eq("source_table", job["source_table"]).eq("source_id", job["source_id"]).execute()
                    self._mark(job["id"], status="completed", completed_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
                    continue
                content, metadata = build_semantic_document(job["entity_type"], row)
                if not content:
                    raise ValueError("entity produced empty semantic content")
                prepared.append((job, row, content, metadata, content_hash(content)))
            except Exception as exc:
                self._fail(job, exc)
        if not prepared:
            return 0
        try:
            vectors = self.client.embed([item[2] for item in prepared], input_type="search_document")
        except Exception as exc:
            for job, *_ in prepared:
                self._fail(job, exc)
            return 0
        stored = 0
        for (job, _row, content, metadata, digest), vector in zip(prepared, vectors):
            try:
                self.storage.client.table("semantic_embeddings").upsert({
                    "tenant_id": job.get("tenant_id"),
                    "entity_type": job["entity_type"],
                    "source_table": job["source_table"],
                    "source_id": job["source_id"],
                    "model": self.client.config.model,
                    "dimensions": self.client.config.dimensions,
                    "content": content,
                    "content_hash": digest,
                    "metadata": metadata,
                    "embedding": vector_literal(vector),
                    "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                }, on_conflict="source_table,source_id,model").execute()
                self._mark(job["id"], status="completed", last_error=None,
                           completed_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
                stored += 1
            except Exception as exc:
                self._fail(job, exc)
        return stored

    def _fail(self, job: dict[str, Any], exc: Exception) -> None:
        attempts = int(job.get("attempts") or 0) + 1
        delay = min(3600, 15 * (2 ** min(attempts, 8)))
        scheduled = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + delay))
        self._mark(job["id"], status="failed", last_error=str(exc)[:1000], scheduled_after=scheduled)


def semantic_search(storage: Any, query: str, *, entity_types: list[str] | None = None,
                    tenant_id: str | None = None, limit: int = 20,
                    min_similarity: float = 0.25) -> list[dict[str, Any]]:
    client = EmbeddingClient()
    vector = client.embed([query], input_type="search_query")[0]
    result = _rpc_data(storage.client, "match_semantic_embeddings", {
        "p_query_embedding": vector_literal(vector),
        "p_entity_types": entity_types,
        "p_tenant_id": tenant_id,
        "p_limit": limit,
        "p_min_similarity": min_similarity,
        "p_model": client.config.model,
    })
    return result or []
