from __future__ import annotations

import math
from types import SimpleNamespace

import pytest

from semantic_embeddings import (
    DEFAULT_DIMENSIONS,
    EmbeddingClient,
    EmbeddingConfig,
    build_semantic_document,
    normalize_vector,
    vector_literal,
    run_semantic_retrieval_evals,
)


def test_listing_document_preserves_property_evidence_but_strips_phone():
    content, metadata = build_semantic_document("listing", {
        "id": 42,
        "asset_type": "residential",
        "transaction_type": "rent",
        "building_name": "Piramal Aranya",
        "micro_market": "Byculla",
        "bhk": 4.5,
        "summary_title": "4.5 BHK at Piramal Aranya",
        "normalized_message": "Call 9820404399 for a sea-view family apartment",
        "visibility": "shared_market",
    })

    assert "Piramal Aranya" in content
    assert "Byculla" in content
    assert "sea-view family apartment" in content
    assert "9820404399" not in content
    assert metadata["visibility"] == "shared_market"


def test_entity_documents_cover_broker_locality_and_aliases():
    broker, _ = build_semantic_document("broker", {
        "canonical_name": "Housen Realtors", "listing_count": 20, "commercial_count": 4,
    })
    locality, _ = build_semantic_document("locality", {
        "sub_locality": "BKC", "parent_locality": "Bandra East",
        "alternate_names": ["Bandra Kurla Complex"],
    })
    alias, _ = build_semantic_document("building_alias", {
        "alias": "Aranya Piramal", "canonical_name": "Piramal Aranya",
    })

    assert "Housen Realtors" in broker
    assert "Bandra Kurla Complex" in locality
    assert "Aranya Piramal" in alias and "Piramal Aranya" in alias


def test_canonical_documents_include_known_aliases():
    building, _ = build_semantic_document("building", {
        "canonical_name": "Piramal Aranya",
        "aliases": ["Aranya Piramal", "Piramal Tower"],
    })
    broker, _ = build_semantic_document("broker", {
        "canonical_name": "Housen Realtors",
        "aliases": ["Housen Realty"],
    })

    assert "Aranya Piramal" in building
    assert "Piramal Tower" in building
    assert "Housen Realty" in broker


def test_broker_alias_document_contains_canonical_link():
    alias, metadata = build_semantic_document("broker_alias", {
        "id": 9,
        "broker_id": 42,
        "alias": "VP Realty",
        "canonical_name": "Vishal Properties",
        "primary_phone": "919876543210",
    })

    assert "VP Realty" in alias
    assert "Vishal Properties" in alias
    assert "alias of Vishal Properties" in alias
    assert metadata["alias"] == "VP Realty"
    assert metadata["primary_phone"] == "919876543210"


def test_broker_alias_document_drops_masked_phone_noise():
    content, _ = build_semantic_document("broker_alias", {
        "id": 10,
        "broker_id": 43,
        "alias": "+23509 80XXXXXX90",
        "canonical_name": "Venus Grishma",
    })
    assert "80XXXXXX90" not in content
    assert "Venus Grishma" in content


def test_semantic_documents_strip_icons_but_keep_raw_alias_metadata():
    content, metadata = build_semantic_document("building_alias", {
        "id": 11,
        "alias": "📍 RNA Mirage Worli",
        "raw_alias": "📍 RNA Mirage Worli",
        "building_id": 16783,
        "canonical_name": "RNA Mirage",
        "micro_market": "Worli",
        "developer": "RNA Builders",
    })
    assert "📍" not in content
    assert "RNA Mirage Worli" in content
    assert "canonical: RNA Mirage" in content
    assert "locality: Worli" in content
    assert metadata["alias"] == "📍 RNA Mirage Worli"
    assert metadata["raw_alias"] == "📍 RNA Mirage Worli"
    assert metadata["building_id"] == 16783


def test_building_alias_document_contains_deterministic_context():
    content, _ = build_semantic_document("building_alias", {
        "alias": "Sarkar avenue Apt.",
        "canonical_name": "Sarkar Aveniew Apt",
        "micro_market": "Santacruz West",
        "developer": "Sarkar Group",
        "building_id": 17281,
    })
    assert "Sarkar avenue Apt" in content
    assert "Sarkar Aveniew Apt" in content
    assert "Santacruz West" in content
    assert "Sarkar Group" in content


def test_vector_is_sliced_and_l2_normalized():
    vector = normalize_vector([2.0] * (DEFAULT_DIMENSIONS + 20))
    assert len(vector) == DEFAULT_DIMENSIONS
    assert math.sqrt(sum(value * value for value in vector)) == pytest.approx(1.0)
    assert vector_literal(vector).startswith("[")


def test_short_vector_is_rejected():
    with pytest.raises(ValueError, match="expected at least"):
        normalize_vector([1.0, 2.0])


def test_embedding_config_defaults_to_openrouter_voyage(monkeypatch):
    for key in (
        "EMBEDDING_API_KEY", "OPENROUTER_API_KEY", "DOUBLEWORD_EMBEDDING_API_KEY",
        "DOUBLEWORD_API_KEY", "EMBEDDING_BASE_URL", "EMBEDDING_MODEL",
        "EMBEDDING_DIMENSIONS",
    ):
        monkeypatch.delenv(key, raising=False)
    config = EmbeddingConfig.from_env()
    assert config.base_url == "https://openrouter.ai/api/v1"
    assert config.model == "voyageai/voyage-4-lite"
    assert config.dimensions == DEFAULT_DIMENSIONS


def test_embedding_client_uses_query_document_input_type(monkeypatch):
    captured = {}

    class Response:
        def raise_for_status(self):
            return None

        def json(self):
            return {"data": [{"index": 0, "embedding": [1.0] * 2048}]}

    def fake_post(url, **kwargs):
        captured["url"] = url
        captured["json"] = kwargs["json"]
        return Response()

    monkeypatch.setattr("semantic_embeddings.httpx.post", fake_post)
    client = EmbeddingClient(EmbeddingConfig(
        api_key="test", base_url="https://example.invalid/v1",
        model="nvidia/nemotron-3-embed-1b:free",
        dimensions=DEFAULT_DIMENSIONS, timeout_seconds=1,
    ))
    vectors = client.embed(["Piramal Aranya"], input_type="search_document")

    assert captured["url"].endswith("/embeddings")
    assert captured["json"]["input_type"] == "search_document"
    assert captured["json"]["dimensions"] == DEFAULT_DIMENSIONS
    assert len(vectors[0]) == DEFAULT_DIMENSIONS


def test_retrieval_evals_record_pass_and_fail(monkeypatch):
    cases = [
        {"id": 1, "query": "Piramal Aranya", "entity_type": "building", "source_table": "buildings", "source_id": 7, "top_k": 5, "tenant_id": None},
        {"id": 2, "query": "Bandra West rent", "entity_type": "listing", "source_table": "residential_rent_listings", "source_id": 8, "top_k": 1, "tenant_id": None},
    ]
    updates = {}

    class Result:
        def __init__(self, data):
            self.data = data

    class Table:
        def __init__(self, name):
            self.name = name
            self.values = None

        def select(self, *_args): return self
        def eq(self, *_args): return self
        def order(self, *_args, **_kwargs): return self
        def limit(self, *_args): return self
        def update(self, values):
            self.values = values
            return self
        def execute(self):
            if self.values is not None:
                updates[self.name, self.values.get("id", len(updates))] = self.values
            return Result(cases if self.name == "semantic_retrieval_eval_cases" and self.values is None else [])

    class Client:
        def table(self, name): return Table(name)
        def rpc(self, name, _params):
            assert name == "match_semantic_embeddings"
            expected = 7 if len(_params["p_entity_types"]) and _params["p_entity_types"][0] == "building" else 9
            return Result([{"source_table": "buildings" if expected == 7 else "residential_rent_listings", "source_id": expected, "similarity": 0.91}])

    class FakeEmbeddingClient:
        def __init__(self):
            self.config = SimpleNamespace(model="test-model")
            self.configured = True

        def embed(self, texts, *, input_type):
            assert input_type == "search_query"
            return [[1.0] * DEFAULT_DIMENSIONS for _ in texts]

    monkeypatch.setattr("semantic_embeddings.EmbeddingClient", FakeEmbeddingClient)
    result = run_semantic_retrieval_evals(SimpleNamespace(client=Client()))

    assert result["total"] == 2
    assert result["passed"] == 1
    assert result["failed"] == 1
    assert result["recall_at_5"] == pytest.approx(0.5)
    assert result["recall_at_10"] == pytest.approx(0.5)
    assert result["mrr"] == pytest.approx(0.5)
    assert result["gate_passed"] is False
    assert result["by_entity"]["building"]["gate_passed"] is True
    assert result["by_entity"]["listing"]["gate_passed"] is False
