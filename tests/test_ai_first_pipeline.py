"""Regression tests for the AI-first extraction contract."""

from listing_validation import validate_listing, apply_validation
from extraction_dedup import content_hash


def test_impossible_price_is_flagged_and_quarantined():
    parsed = {
        "intent": "SELL", "asset_type": "residential", "property_type": "APARTMENT",
        "price": 0, "price_unit": "abs", "building_name": "Example Tower",
    }
    result = validate_listing(parsed)
    output = apply_validation(parsed, result)
    assert "price_negative_or_zero" in output["validation_flags"]
    assert output["needs_review"] is True
    assert output["price"] is None


def test_floor_number_misread_as_bhk_is_flagged():
    result = validate_listing({
        "intent": "RENT", "asset_type": "residential", "property_type": "APARTMENT",
        "price": 50000, "price_unit": "abs", "bhk": "15 BHK",
        "building_name": "Example Tower",
    })
    assert any(flag.startswith("bhk_too_high") for flag in result.flags)


def test_area_bounds_are_flagged():
    result = validate_listing({
        "intent": "SELL", "asset_type": "residential", "property_type": "APARTMENT",
        "price": 10000000, "price_unit": "abs", "area_sqft": 50,
        "building_name": "Example Tower",
    })
    assert any(flag.startswith("area_out_of_range") for flag in result.flags)


def test_content_hash_is_stable_for_cache_lookup():
    assert content_hash("2 BHK in Bandra") == content_hash("2 BHK in Bandra")
    assert content_hash("2 BHK in Bandra") != content_hash("3 BHK in Bandra")


def test_ai_review_state_gets_a_durable_validation_reason():
    output = apply_validation({"needs_review": True}, validate_listing({}))

    assert output["needs_review"] is True
    assert output["validation_flags"] == ["ai_needs_review"]
