"""Production-shaped fixtures for the grounded-AI source boundary.

These cases deliberately assert that a source check can flag a conflict without
silently replacing or deleting the model's value.
"""

from ai_extraction import _source_grounded_price
from extraction import _apply_source_evidence_gates
from source_boundary import apply_source_boundary
import extraction


def test_category_conflict_does_not_get_invented_by_source_keywords():
    result = _apply_source_evidence_gates(
        {"property_category": "residential", "listing_type": "rent"},
        "Investor unit available for lease in a commercial premises",
    )
    assert result["property_category"] == "residential"
    assert "source_asset_category_conflict_review" not in result.get("validation_flags", [])


def test_number_before_price_keyword_is_not_a_source_gate_failure():
    result = _source_grounded_price(
        {"price": {"amount": 115000, "unit": "total", "raw_price_text": "115000"}},
        "Office, 900 sqft, 115000 rent negotiations slightly, Andheri",
    )
    assert result["price"]["amount"] == 115000
    assert "source_price_evidence_missing" not in result.get("validation_flags", [])


def test_psf_arithmetic_failure_retains_value_and_marks_review():
    result = _source_grounded_price(
        {
            "price": {"amount": 275, "unit": "per_sqft", "raw_price_text": "₹275 psf"},
            "carpet_area_sqft": 40000,
            "monthly_rent": 2750000,
        },
        "Independent building, 40,000 sqft, Rent ₹275 psf, near BKC",
    )
    assert result["price"]["amount"] == 275
    assert result["needs_review"] is True


def test_reposted_requirement_optional_area_does_not_change_source_boundary():
    base = {
        "listing_type": "requirement",
        "routing_listing_type": "requirement",
        "message_class": "requirement",
        "building_name": "Bandra to Santacruz",
    }
    with_area = apply_source_boundary({**base, "area_sqft": 2000}, "Looking to buy 4 BHK in Bandra to Santacruz")
    without_area = apply_source_boundary({**base, "area_sqft": None}, "Looking to buy 4 BHK in Bandra to Santacruz")
    assert with_area["listing_type"] == without_area["listing_type"] == "requirement"


def test_building_alias_is_not_rewritten_by_route_boundary():
    result = apply_source_boundary(
        {"listing_type": "rent", "building_name": "Silver Cascade"},
        "3 BHK for rent at Silver Casc., Bandra West",
    )
    assert result["building_name"] == "Silver Cascade"
    assert result["listing_type"] == "rent"


def test_direct_rent_offer_cannot_be_routed_as_requirement():
    source = (
        "*KIND ATTENTION*\n\n"
        "*LUXURIOUS EXPAT QUALITY ON RENT*\n"
        ": *GULSHAN*\n"
        ": *3BHK , 1500 CARPET ON RENT*\n"
        ": *2.95 LAKHS FINAL*"
    )
    corrected = extraction._source_ground_requirement_item(
        {
            "listing_type": "requirement",
            "message_class": "listing",
            "classified_is_requirement": False,
            "transaction_type": "rent",
            "property_category": "residential",
        },
        source,
    )

    assert corrected["listing_type"] == "rent"
    assert corrected["message_class"] == "listing"
    assert corrected["is_requirement"] is False
