"""Standalone asynchronous semantic-index worker."""

from __future__ import annotations

import logging
import os
import time

from extraction import get_storage
from semantic_embeddings import EmbeddingClient, SemanticIndexWorker


def main() -> None:
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    client = EmbeddingClient()
    if not client.configured:
        raise RuntimeError("Semantic worker requires EMBEDDING_API_KEY or OPENROUTER_API_KEY")
    worker = SemanticIndexWorker(
        get_storage(),
        batch_size=int(os.getenv("SEMANTIC_WORKER_BATCH_SIZE", "16")),
        poll_seconds=float(os.getenv("SEMANTIC_WORKER_POLL_SECONDS", "5")),
        max_attempts=int(os.getenv("SEMANTIC_WORKER_MAX_ATTEMPTS", "5")),
    )
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
        time.sleep(worker.poll_seconds)


if __name__ == "__main__":
    main()
