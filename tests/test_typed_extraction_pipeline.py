"""Regression coverage for the typed extraction bridge.

These tests deliberately stop before Supabase.  They protect the deterministic
classification, source-grounded price conversion, and typed-table routing
which must be correct before a worker is allowed to persist a row.
"""

from ai_extraction import _get_extraction_prompt, classify_message_type
from extraction import _ai_extraction_to_typed, _parse_deposit
from price_normalization import canonical_price_rupees, source_transaction_type


def _item(text, **fields):
    item = {
        "listing_type": "sale",
        "property_category": "residential",
        "price": {"amount": None, "unit": "total", "raw_price_text": None},
    }
    item.update(fields)
    return _ai_extraction_to_typed(item, text, sender_name="Broker")


def test_type_classifier_covers_listing_and_requirement_routes():
    assert classify_message_type("3 BHK for sale in Bandra, 5 Cr") == ("residential", "sale")
    assert classify_message_type("Commercial office for rent, 2000 sqft, ₹150 PSF") == ("commercial", "rent")
    assert classify_message_type("Looking for 2 BHK for rent in Khar, budget 1-1.5 lakh") == (
        "residential", "requirement"
    )
    assert classify_message_type("Shop for sale, 500 sqft, 2 Cr") == ("commercial", "sale")


def test_focused_prompt_contains_route_specific_fields_and_price_guardrails():
    prompt = _get_extraction_prompt("residential", "sale", False)
    assert "price" in prompt
    assert "monthly_rent" not in prompt
    assert "8.5 Cr" in prompt
    assert "85000000" in prompt

    rent_prompt = _get_extraction_prompt("commercial", "rent", False)
    assert "commercial_use_type" in rent_prompt
    assert "cam_amount" in rent_prompt
    assert "escalation_pct" in rent_prompt


def test_sale_price_is_absolute_rupees_even_when_model_returns_native_unit():
    table, row = _item(
        "3 BHK for sale, 8.5 Cr",
        bhk=3,
        carpet_area_sqft=1200,
        price={"amount": 8.5, "unit": "cr", "raw_price_text": "8.5 Cr"},
    )
    assert table == "residential_sale_listings"
    assert row["total_asking_price"] == 85_000_000
    assert row["price_raw_text"] == "8.5 Cr"


def test_unqualified_crore_listing_cannot_be_routed_to_rent_by_ai():
    table, row = _item(
        "3 BHK in Bandra West, 6 cr",
        listing_type="rent",
        price={"amount": 6, "unit": "cr", "raw_price_text": "6 cr"},
    )
    assert table == "residential_sale_listings"
    assert row["transaction_type"] == "sale"
    assert row["total_asking_price"] == 60_000_000
    assert "monthly_rent" not in row


def test_price_conversion_is_source_grounded_for_crore_and_lac_variants():
    assert canonical_price_rupees(6, "cr", "6 cr") == 60_000_000
    assert canonical_price_rupees(6, None, "6 cr") == 60_000_000
    assert canonical_price_rupees(58, None, "₹58 LAC NEG.") == 5_800_000
    assert canonical_price_rupees(58, "lakh", "₹58 LAC NEG.") == 5_800_000
    assert source_transaction_type("3 BHK, ₹5.50 Crore", "rent") == "sale"
    assert source_transaction_type("3 BHK for rent, ₹2.5 lakh", "sale") == "rent"
    assert source_transaction_type("3 BHK for sale, ₹5.50 Crore", "rent") == "sale"


def test_implausible_rent_is_marked_for_review_and_not_high_confidence():
    table, row = _item(
        "3 BHK monthly rental quote",
        listing_type="rent",
        extraction_confidence="high",
        price={"amount": 2_500_000_000, "unit": "total", "raw_price_text": None},
    )
    assert table == "residential_rent_listings"
    assert row["monthly_rent"] == 2_500_000_000
    assert row["needs_review"] is True
    assert row["extraction_confidence"] == "low"


def test_price_and_psf_routing_for_rent():
    table, row = _item(
        "2 BHK rent, 2.50 Lakhs",
        listing_type="rent",
        price={"amount": 2.5, "unit": "lakh", "raw_price_text": "2.50 Lakhs"},
    )
    assert table == "residential_rent_listings"
    assert row["monthly_rent"] == 250_000

    table, row = _item(
        "Commercial shop for rent, ₹350 PSF, 681 sqft",
        property_category="commercial",
        listing_type="rent",
        carpet_area_sqft=681,
        price={"amount": 350, "unit": "per_sqft", "raw_price_text": "₹350 PSF"},
    )
    assert table == "commercial_rent_listings"
    assert row["rent_per_sqft"] == 350
    assert row["monthly_rent"] == 238_350


def test_colon_price_and_deposit_shorthand_are_source_grounded():
    table, row = _item(
        "1 BHK sale, 2:25 Cr",
        bhk=1,
        price={"amount": 2.25, "unit": "cr", "raw_price_text": "2:25 Cr"},
    )
    assert table == "residential_sale_listings"
    assert row["total_asking_price"] == 22_500_000

    deposit = _parse_deposit("3 BHK rent, 90+2", monthly_rent=90_000)
    assert deposit["deposit_months"] == 2
    assert deposit["deposit_amount"] == 180_000


def test_requirement_routes_to_requirement_table_not_listing_table():
    table, row = _item(
        "Looking for 2 BHK for rent in Khar, budget 1-1.5 lakh",
        listing_type="requirement",
        classified_is_requirement=True,
        classified_transaction_type="rent",
        bhk=2,
        budget_min=100_000,
        budget_max=150_000,
    )
    assert table == "residential_rent_requirements"
    assert row["bhk_options"] == [2.0]
    assert row["budget_max"] == 150_000
    assert "monthly_rent" not in row
