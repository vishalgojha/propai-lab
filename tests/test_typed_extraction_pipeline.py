"""Regression coverage for the typed extraction bridge.

These tests deliberately stop before Supabase.  They protect the deterministic
classification, source-grounded price conversion, and typed-table routing
which must be correct before a worker is allowed to persist a row.
"""

from ai_extraction import _get_extraction_prompt, classify_message_type
from extraction import _ai_extraction_to_typed, _parse_deposit
from price_normalization import canonical_commercial_rental_price_rupees, canonical_price_rupees, canonical_rental_price_rupees, source_transaction_type


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

    residential_rent_prompt = _get_extraction_prompt("residential", "rent", False)
    assert "balcony_area_sqft" in residential_rent_prompt
    assert "fee_sharing_required" in residential_rent_prompt
    assert "PG" in residential_rent_prompt
    assert "1.30k" in residential_rent_prompt


def test_commercial_rent_prompt_covers_package_and_operational_schema():
    prompt = _get_extraction_prompt("commercial", "rent", False)
    assert "broker_rera_number" in prompt
    assert "chargeable_area_sqft" in prompt
    assert "PKG" in prompt
    assert "automatic shutters" in prompt
    assert "room_count" in prompt


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


def test_residential_sale_preserves_rich_broker_fields():
    table, row = _item(
        "Available in+1 2Bhk 20th Road, Khar West Area:815carpet+66carpet balcony "
        "furnished house with 1 stilt car parking @3.80cr very slightly negotiable. "
        "For inspection Ctct Shobhna Enterprises 9821053128 9820094585",
        bhk=2,
        building_name=None,
        price={"amount": 3.8, "unit": "cr", "raw_price_text": "3.80cr"},
        carpet_area_sqft=815,
        balcony_area_sqft=66,
        balcony_area_raw_text="66carpet balcony",
        area_raw_text="815carpet+66carpet balcony",
        locality={"raw_mention": "20th Road, Khar West", "resolved_locality": "Khar West"},
        availability_status="available",
        co_brokered=True,
        brokerage_context="+1",
        parking_type="stilt",
        car_parking_count=1,
        showing_instructions="For inspection contact",
        broker_company="Shobhna Enterprises",
        contacts=[
            {"phone": "9821053128", "role": "primary"},
            {"phone": "9820094585", "role": "team"},
        ],
    )

    assert table == "residential_sale_listings"
    assert row["total_asking_price"] == 38_000_000
    assert row["carpet_area_sqft"] == 815
    assert row["balcony_area_sqft"] == 66
    assert row["availability_status"] == "available"
    assert row["co_brokered"] is True
    assert row["brokerage_context"] == "+1"
    assert row["parking_type"] == "stilt"
    assert row["showing_instructions"] == "For inspection contact"
    assert row["broker_company"] == "Shobhna Enterprises"
    assert len(row["contacts"]) == 2


def test_price_conversion_is_source_grounded_for_crore_and_lac_variants():
    assert canonical_price_rupees(6, "cr", "6 cr") == 60_000_000
    assert canonical_price_rupees(6, None, "6 cr") == 60_000_000
    assert canonical_price_rupees(58, None, "₹58 LAC NEG.") == 5_800_000
    assert canonical_price_rupees(58, "lakh", "₹58 LAC NEG.") == 5_800_000
    assert source_transaction_type("3 BHK, ₹5.50 Crore", "rent") == "sale"
    assert source_transaction_type("3 BHK for rent, ₹2.5 lakh", "sale") == "rent"
    assert source_transaction_type("3 BHK for sale, ₹5.50 Crore", "rent") == "sale"


def test_mumbai_residential_rental_decimal_k_means_lakh():
    assert canonical_rental_price_rupees(1.30, "k", "1.30k") == 130_000
    assert canonical_rental_price_rupees(2.50, "k", "Rent 2.50k") == 250_000
    assert canonical_rental_price_rupees(130, "k", "130k") == 130_000

    table, row = _item(
        "2 BHK rent 1.30k",
        listing_type="rent",
        price={"amount": 1.30, "unit": "k", "raw_price_text": "1.30k"},
    )
    assert table == "residential_rent_listings"
    assert row["monthly_rent"] == 130_000


def test_residential_rent_preserves_rental_broker_facts():
    table, row = _item(
        "Available luxury 3 BHK on lease, Chitra, 2000 sqft + 500 sqft terrace, "
        "6 lakh negotiable, MNCs/consulates, client profile mandatory, mandate plus one",
        listing_type="rent",
        bhk=3,
        price={"amount": 6, "unit": "lakh", "raw_price_text": "6 lakh"},
        carpet_area_sqft=2000,
        terrace_area_sqft=500,
        terrace_area_raw_text="2000 sqft + 500 sqft terrace",
        furnishing_status="semi_furnished",
        lease_term_min_months=36,
        lease_term_max_months=60,
        company_lease_criteria={"tenant_types": ["MNC", "consulate"]},
        client_profile_required=True,
        plus_one_deal=True,
        fee_sharing_required=True,
        brokerage_terms_raw="mandate plus one",
        contacts=[{"name": "Yogesh Bajaj", "phone": "9870008644"}],
    )
    assert table == "residential_rent_listings"
    assert row["monthly_rent"] == 600_000
    assert row["terrace_area_sqft"] == 500
    assert row["lease_term_min_months"] == 36
    assert row["lease_term_max_months"] == 60
    assert row["client_profile_required"] is True
    assert row["plus_one_deal"] is True
    assert row["fee_sharing_required"] is True
    assert row["brokerage_terms_raw"] == "mandate plus one"
    assert len(row["contacts"]) == 1


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


def test_commercial_rent_uses_chargeable_area_for_psf_math_and_keeps_sale_fields_out():
    table, row = _item(
        "Fully furnished office, carpet 11350, chargeable 18900, rent 175 PSF chargeable",
        property_category="commercial",
        listing_type="rent",
        carpet_area_sqft=11_350,
        chargeable_area_sqft=18_900,
        price_basis="chargeable_per_sqft",
        broker_rera_number="A51900002370",
        price={"amount": 175, "unit": "per_sqft", "raw_price_text": "Rs 175 per sqft of chargeable area"},
        workstation_count=180,
        director_cabin_count=14,
    )
    assert table == "commercial_rent_listings"
    assert row["rent_per_sqft"] == 175
    assert row["monthly_rent"] == 3_307_500
    assert row["price_math"]["basis"] == "chargeable_area_sqft"
    assert row["broker_rera_number"] == "A51900002370"
    assert "total_asking_price" not in row
    assert "price_per_sqft" not in row


def test_commercial_package_is_monthly_rent_not_deposit_or_cam():
    assert canonical_commercial_rental_price_rupees(1, "lakh", "1 lac pkg") == 100_000
    table, row = _item(
        "Commercial office, 460 carpet, Asking 1 lac pkg neg, no parking",
        property_category="commercial",
        listing_type="rent",
        carpet_area_sqft=460,
        price={"amount": 1, "unit": "lakh", "raw_price_text": "1 lac pkg"},
        price_basis="monthly",
        deposit_amount=None,
        cam_amount=None,
    )
    assert table == "commercial_rent_listings"
    assert row["monthly_rent"] == 100_000
    assert "deposit_amount" not in row
    assert "cam_amount" not in row


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
