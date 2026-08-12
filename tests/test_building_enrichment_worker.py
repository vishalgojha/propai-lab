from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import building_enrichment_worker


def test_worker_heartbeat_payload_is_safe_and_identifies_runtime(monkeypatch):
    monkeypatch.setenv("COOLIFY_RESOURCE_UUID", "worker-resource")
    monkeypatch.setenv("COOLIFY_BRANCH", "main")
    monkeypatch.setenv("COOLIFY_COMMIT_SHA", "abc123")

    payload = building_enrichment_worker.heartbeat_payload(
        status="running",
        config={"batch_size": 10, "concurrency": 10},
    )

    assert payload["worker_name"] == "building-enrichment-worker"
    assert payload["service_name"] == "building-enrichment-worker"
    assert payload["status"] == "running"
    assert payload["runtime_version"] == "abc123"
    assert payload["config"] == {"batch_size": 10, "concurrency": 10}
    assert "API_KEY" not in str(payload)
