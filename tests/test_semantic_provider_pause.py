from __future__ import annotations

from types import SimpleNamespace

from semantic_embeddings import SemanticIndexWorker


def test_billing_failure_pauses_provider_and_exhausts_jobs(monkeypatch):
    worker = object.__new__(SemanticIndexWorker)
    worker.max_attempts = 5
    worker.provider_pause_hours = 24.0
    worker._provider_paused_until = 0.0
    marked = []
    worker._mark = lambda job_id, **values: marked.append((job_id, values))

    response = SimpleNamespace(status_code=402)
    error = RuntimeError("402 Payment Required")
    error.response = response
    worker._pause_provider([{"id": 7, "attempts": 1}], error)

    assert worker._provider_paused_until > 0
    assert marked[0][0] == 7
    assert marked[0][1]["status"] == "failed"
    assert marked[0][1]["attempts"] == 5
    assert marked[0][1]["scheduled_after"]
    assert "provider_paused" in marked[0][1]["last_error"]
