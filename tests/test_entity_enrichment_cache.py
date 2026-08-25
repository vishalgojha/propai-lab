import pytest

from agents.entity_enrichment_cache import entity_cache_key, evidence_fingerprint


def test_building_id_key_is_stable_and_locality_scoped():
    assert entity_cache_key("building", entity_id=42, name="MS Gateway", locality="Santacruz West") == (
        "building:id:42|locality:santacruz west"
    )
    assert entity_cache_key("building", entity_id=42, name="other", locality=" Santacruz   West ") == (
        "building:id:42|locality:santacruz west"
    )


def test_unresolved_entity_name_does_not_cross_localities():
    assert entity_cache_key("landmark", name="Hill Road", locality="Bandra West") != entity_cache_key(
        "landmark", name="Hill Road", locality="Bandra East"
    )


def test_evidence_fingerprint_is_order_independent_but_changes_with_evidence():
    left = {"source_localities": {"Bandra West": 2}, "source_contexts": [{"source_slice": "A"}]}
    right = {"source_contexts": [{"source_slice": "A"}], "source_localities": {"Bandra West": 2}}
    assert evidence_fingerprint(left) == evidence_fingerprint(right)
    assert evidence_fingerprint({**left, "source_localities": {"Bandra West": 3}}) != evidence_fingerprint(left)


def test_entity_key_requires_identity():
    with pytest.raises(ValueError):
        entity_cache_key("building", locality="Bandra West")
