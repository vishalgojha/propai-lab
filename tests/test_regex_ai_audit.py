"""Regression tests for observable deterministic corrections."""

from source_boundary import apply_source_boundary


def test_source_transaction_conflict_is_recorded_without_rewriting_ai():
    result = apply_source_boundary(
        {"listing_type": "rent", "needs_review": True},
        "Available Sale\n3 BHK Bandra West\nPrice: 6 Cr",
    )

    assert result["listing_type"] == "rent"
    assert "source_route_conflict_review" in result["validation_flags"]
    assert result["needs_review"] is True
    assert result["source_boundary_conflict"]["source_value"] == "sale"
    assert "deterministic_overrides" not in result


def test_matching_ai_transaction_is_not_marked_as_override():
    result = apply_source_boundary(
        {"listing_type": "rent"},
        "Available for rent\n3 BHK Bandra West\nRent: 1.5 Lakh",
    )

    assert result["listing_type"] == "rent"
    assert "source_transaction_override_ai" not in result.get("validation_flags", [])
    assert "deterministic_overrides" not in result
