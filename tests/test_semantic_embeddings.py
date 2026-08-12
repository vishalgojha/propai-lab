from __future__ import annotations

import math

import pytest

from semantic_embeddings import (
    DEFAULT_DIMENSIONS,
    EmbeddingClient,
    EmbeddingConfig,
    build_semantic_document,
    normalize_vector,
    vector_literal,
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


def test_vector_is_sliced_and_l2_normalized():
    vector = normalize_vector([2.0] * (DEFAULT_DIMENSIONS + 20))
    assert len(vector) == DEFAULT_DIMENSIONS
    assert math.sqrt(sum(value * value for value in vector)) == pytest.approx(1.0)
    assert vector_literal(vector).startswith("[")


def test_short_vector_is_rejected():
    with pytest.raises(ValueError, match="expected at least"):
        normalize_vector([1.0, 2.0])


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
