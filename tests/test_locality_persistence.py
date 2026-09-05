from registry.locality_resolver import LocalityResolver
from storage.supabase import _apply_structured_locality_decision


def _resolver():
    return LocalityResolver(db=None, reference={
        "locality_reference": [
            {
                "id": 101,
                "sub_locality": "Pali Hill",
                "parent_locality": "Bandra West",
                "canonical_locality": "Bandra West",
                "alternate_names": ["Pali-Hill"],
                "confidence": "high",
            },
            {
                "id": 102,
                "sub_locality": "Central Park",
                "parent_locality": "North",
                "confidence": "high",
            },
            {
                "id": 103,
                "sub_locality": "Central Park",
                "parent_locality": "South",
                "confidence": "high",
            },
        ],
        "buildings": [],
        "building_name_aliases": [],
    })


def test_persistence_helper_promotes_unique_structured_locality():
    row = {"validation_flags": []}

    out = _apply_structured_locality_decision(
        row,
        {"locality": {"raw_mention": "Pali-Hill", "resolved_locality": "Bandra West"}},
        _resolver(),
    )

    assert out["locality_id"] == 101
    assert out["locality_match_status"] == "matched"
    assert out["locality_confidence"] == "high"
    assert out["locality_resolved"] == "Bandra West"
    assert out["micro_market"] == "Bandra West"


def test_persistence_helper_flags_ambiguous_without_assigning_id():
    row = {"validation_flags": []}

    out = _apply_structured_locality_decision(
        row,
        {"locality": {"raw_mention": "Central Park"}},
        _resolver(),
    )

    assert out.get("locality_id") is None
    assert out["locality_match_status"] == "ambiguous"
    assert "locality_resolution_ambiguous" in out["validation_flags"]


def test_persistence_helper_marks_missing_structured_locality():
    row = {"validation_flags": []}

    out = _apply_structured_locality_decision(row, {"locality": {}}, _resolver())

    assert out.get("locality_id") is None
    assert out["locality_match_status"] == "missing"
    assert out["locality_confidence"] == "low"
