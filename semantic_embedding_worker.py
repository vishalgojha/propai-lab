"""Standalone asynchronous semantic-index worker."""

from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timezone

from extraction import get_storage
from semantic_embeddings import EmbeddingClient, SemanticIndexWorker


def _worker_enabled() -> bool:
    value = os.getenv("SEMANTIC_WORKER_ENABLED", "true").strip().lower()
    return value in {"1", "true", "yes", "on"}


def _write_heartbeat(storage, *, status: str, config: dict, last_error: str | None = None) -> None:
    """Publish non-secret semantic worker state for platform operations."""
    try:
        storage.client.table("worker_heartbeats").upsert({
            "worker_name": "semantic-embedding-worker",
            "service_name": os.getenv("COOLIFY_RESOURCE_NAME", "semantic-embedding-worker"),
            "status": status,
            "heartbeat_at": datetime.now(timezone.utc).isoformat(),
            "runtime_version": (
                os.getenv("COOLIFY_COMMIT_SHA")
                or os.getenv("GIT_COMMIT_SHA")
                or os.getenv("COOLIFY_BRANCH")
                or "unknown"
            ),
            "last_error": last_error,
            "config": config,
        }, on_conflict="worker_name").execute()
    except Exception:
        logging.getLogger(__name__).exception("Unable to write semantic worker heartbeat")


def main() -> None:
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    storage = get_storage()
    config = {
        "enabled": _worker_enabled(),
        "batch_size": int(os.getenv("SEMANTIC_WORKER_BATCH_SIZE", "16")),
        "poll_seconds": float(os.getenv("SEMANTIC_WORKER_POLL_SECONDS", "5")),
        "max_attempts": int(os.getenv("SEMANTIC_WORKER_MAX_ATTEMPTS", "5")),
        "model": os.getenv("EMBEDDING_MODEL", "voyageai/voyage-4-lite"),
    }
    if not config["enabled"]:
        _write_heartbeat(storage, status="disabled", config=config)
        print("Semantic embedding worker disabled by SEMANTIC_WORKER_ENABLED", flush=True)
        return
    client = EmbeddingClient()
    if not client.configured:
        _write_heartbeat(storage, status="error", config=config, last_error="Embedding provider is not configured")
        raise RuntimeError("Semantic worker requires EMBEDDING_API_KEY or OPENROUTER_API_KEY")
    worker = SemanticIndexWorker(
        storage,
        batch_size=config["batch_size"],
        poll_seconds=config["poll_seconds"],
        max_attempts=config["max_attempts"],
    )
    _write_heartbeat(storage, status="running", config={**config, "dimensions": client.config.dimensions})
    print(
        f"Semantic embedding worker started (model={client.config.model}, "
        f"dimensions={client.config.dimensions}, batch={worker.batch_size})",
        flush=True,
    )
    while True:
        try:
            stored = worker.run_once()
            if stored:
                print(f"[semantic-worker] stored={stored}", flush=True)
        except Exception:
            logging.exception("Semantic embedding cycle failed")
            _write_heartbeat(storage, status="error", config=config, last_error="Semantic embedding cycle failed")
        else:
            _write_heartbeat(storage, status="running", config={**config, "dimensions": client.config.dimensions})
        time.sleep(worker.poll_seconds)


if __name__ == "__main__":
    main()
