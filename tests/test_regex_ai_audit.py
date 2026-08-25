"""Regression tests for observable deterministic corrections."""

from ai_extraction import _apply_deterministic_field_fallbacks


def test_source_transaction_override_is_recorded_when_ai_disagrees():
    result = _apply_deterministic_field_fallbacks(
        {"listing_type": "rent", "needs_review": True},
        "Available Sale\n3 BHK Bandra West\nPrice: 6 Cr",
    )

    assert result["listing_type"] == "sale"
    assert "source_transaction_override_ai" in result["validation_flags"]
    assert result["needs_review"] is True
    assert result["deterministic_overrides"] == [{
        "field": "listing_type",
        "from": "rent",
        "to": "sale",
        "reason": "exclusive_explicit_sale_marker",
    }]


def test_matching_ai_transaction_is_not_marked_as_override():
    result = _apply_deterministic_field_fallbacks(
        {"listing_type": "rent"},
        "Available for rent\n3 BHK Bandra West\nRent: 1.5 Lakh",
    )

    assert result["listing_type"] == "rent"
    assert "source_transaction_override_ai" not in result.get("validation_flags", [])
    assert "deterministic_overrides" not in result
