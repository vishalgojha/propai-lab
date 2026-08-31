from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import building_enrichment_worker
from storage.supabase import SupabaseStorage, _BUILDING_EVIDENCE_SELECTS
from agents.building_enrichment.identity import rank_identity_candidates


def test_identity_candidates_use_bounded_context_without_auto_merging():
    ranked = rank_identity_candidates(
        "X Bkc", "Bandra East", [
            {"id": 4012, "observed_id": 912, "canonical_name": "Bkc-X",
             "micro_market": "Bandra East", "evidence": [{"kind": "raw_context", "value": "BKC"}]},
            {"id": 14136, "observed_id": 912, "canonical_name": "Xbkc",
             "micro_market": "BKC", "evidence": [{"kind": "raw_context", "value": "BKC"}]},
        ],
        max_evidence=5,
    )

    assert [item["building_id"] for item in ranked] == [4012, 14136]
    assert all(len(item["evidence"]) <= 5 for item in ranked)
    assert ranked[0]["score"] > 0.5


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


def test_building_resolution_evidence_uses_schema_valid_projections():
    class Query:
        def __init__(self, table, selected):
            self.table = table
            self.selected = selected

        def select(self, columns):
            self.selected[self.table] = columns
            return self

        def eq(self, *_args, **_kwargs):
            return self

        def order(self, *_args, **_kwargs):
            return self

        def limit(self, *_args, **_kwargs):
            return self

        def execute(self):
            return SimpleNamespace(data=[])

    class Client:
        def __init__(self):
            self.selected = {}

        def table(self, table):
            return Query(table, self.selected)

    client = Client()
    storage = SupabaseStorage.__new__(SupabaseStorage)
    storage._client = client

    assert storage.get_building_resolution_evidence(42) == {
        "source_localities": {},
        "broker_markets": {},
        "source_contexts": [],
        "price": None,
        "price_bands": {},
    }
    assert set(_BUILDING_EVIDENCE_SELECTS).issubset(client.selected)


def test_commercial_rent_evidence_uses_monthly_rent_column():
    projection = _BUILDING_EVIDENCE_SELECTS["commercial_rent_listings"]

    assert "monthly_rent" in projection.split(",")
    assert "total_asking_price" not in projection.split(",")
