import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ai_extraction import (
    _apply_deterministic_field_fallbacks,
    _canonical_locality_from_mention,
    _normalize_extraction,
    _source_grounded_price,
    generate_title,
)
from extraction import _ai_extraction_to_parsed, _price_from_ai_and_raw
from extraction_models import validate_source_semantics


def test_commercial_message_recovers_obvious_schema_facts():
    text = """Available Commercial Office On Sale At Dadar West
Area 2000 Carpet
Condition Bareshell
Car Park 2
New Building
Higher Floor"""

    out = _apply_deterministic_field_fallbacks(
        {"carpet_area_sqft": None, "fitout_status": None, "car_parking_count": None},
        text,
    )

    assert out["carpet_area_sqft"] == 2000.0
    assert out["fitout_status"] == "bare_shell"
    assert out["car_parking_count"] == 2
    assert "brand_new_building" in out["deal_tags"]


def test_commercial_requirement_recovers_range_budget_use_and_localities():
    text = """Commercial Space Required For A Tailoring Unit On Outright Basis
700-1000 sq.ft.
Anywhere in Santacruz Khar Bandra
Budget: 3.15 Cr"""

    out = _apply_deterministic_field_fallbacks({}, text)

    assert out["area_min_sqft"] == 700.0
    assert out["area_max_sqft"] == 1000.0
    assert out["budget_max"] == 31_500_000.0
    assert out["locality_options"] == ["Santacruz", "Khar", "Bandra"]
    assert out["commercial_use_type"] == "tailoring unit"


def test_explicit_available_sale_overrides_wrong_llm_rent():
    text = """*Available Sale*
2 BHK Galaxy Height furnished
Goregaon Metro station
Price,1.90 Cr Negotiable
Rakesh Mishra"""

    out = _apply_deterministic_field_fallbacks(
        {"listing_type": "rent"},
        text,
    )

    assert out["listing_type"] == "sale"


def test_unqualified_crore_price_overrides_wrong_llm_rent():
    out = _apply_deterministic_field_fallbacks(
        {"listing_type": "rent"},
        "3 BHK Bandra West, 6 cr",
    )

    assert out["listing_type"] == "sale"


def test_rental_requirement_recovers_bhk_locations_tenant_and_amenities():
    text = """URGENT REQUIREMENT – 1 BHK ON RENT
Preferred Locations: Ram Maruti Road, Naupada, Teen Petrol Pump & Panch Pakhadi, Thane West
Budget: Up to ₹32,000/-
Tenant: Small Family (2 Members Only)
Open Car Parking Required
Modular Kitchen/Kitchen Trolley Required
Gas Pipeline Preferred"""

    out = _apply_deterministic_field_fallbacks({"listing_type": "requirement"}, text)

    assert out["bhk"] == 1.0
    assert out["budget_max"] == 32000.0
    assert out["locality_options"] == [
        "Ram Maruti Road", "Naupada", "Teen Petrol Pump", "Panch Pakhadi", "Thane West"
    ]
    assert out["tenant_type"] == "Small Family (2 Members Only)"
    assert out["car_parking_min"] == 1
    assert out["amenity_requirements"] == ["modular_kitchen", "gas_pipeline"]


def test_rent_rs_decimal_is_treated_as_lakh_shorthand():
    out = _apply_deterministic_field_fallbacks(
        {"listing_type": "rent", "price": {"amount": 1500000, "unit": "total"}},
        "Mandate 3 bhk flat furnished with White good Grace Classic, Ahimsa marg Khar.\n"
        "Rent Rs.1.50 neqt",
    )

    assert out["price"] == {
        "amount": 150000.0,
        "unit": "total",
        "period": "per_month",
        "raw_price_text": "Rent Rs.1.50",
    }
    assert out["locality"]["raw_mention"] == "Ahimsa marg Khar"


def test_explicit_rent_amount_overrides_wrong_provider_psf_unit():
    assert _price_from_ai_and_raw({
        "amount": 200000,
        "unit": "per_sqft",
        "period": "one_time",
        "raw_price_text": "₹ 2.00 Lakhs.",
    }) == (200000.0, "abs")


def test_explicit_psf_quote_keeps_psf_unit():
    assert _price_from_ai_and_raw({
        "amount": 200,
        "unit": "per_sqft",
        "period": "per_month",
        "raw_price_text": "₹200 per sq.ft.",
    }) == (200.0, "per_sqft")


def test_source_semantics_rejects_psf_without_source_psf_marker():
    out = validate_source_semantics({
        "listing_type": "rent",
        "property_category": "residential",
        "price": {
            "amount": 200000,
            "unit": "per_sqft",
            "period": "one_time",
            "raw_price_text": "₹ 2.00 Lakhs",
        },
        "extraction_confidence": "high",
    }, "3 BHK available on lease. Rent: ₹ 2.00 Lakhs per month.")

    assert out["listing_type"] == "rent"
    assert out["price"]["unit"] == "total"
    assert out["price"]["period"] == "per_month"
    assert out["needs_review"] is True


def test_source_semantics_preserves_explicit_rent_psf_rate():
    out = validate_source_semantics({
        "listing_type": "rent",
        "property_category": "residential",
        "price": {
            "amount": 143,
            "unit": "per_sqft",
            "period": "one_time",
            "raw_price_text": "₹143 per sq.ft.",
        },
        "extraction_confidence": "high",
    }, "3 BHK available on lease. Rent rate ₹143 per sq.ft. per month.")

    assert out["price"]["unit"] == "per_sqft"
    assert out["price"]["period"] == "per_month"


def test_listing_recovers_possession_and_no_parking():
    out = _apply_deterministic_field_fallbacks(
        {"listing_type": "rent", "possession_date": None, "car_parking_count": None},
        "Possession 1st September 2026.\nNo car parking",
    )

    assert out["possession_date"] == "2026-09-01"
    assert out["possession_status"] == "available"
    assert out["car_parking_count"] == 0
    assert out["parking_type"] == "none"


def test_embedded_khar_mention_uses_implied_khar_west_rule():
    assert _canonical_locality_from_mention("Ahimsa Marg Khar") == "Khar West"
    assert _canonical_locality_from_mention("Khar") == "Khar West"


def test_provider_price_without_source_quote_is_discarded():
    out = _source_grounded_price(
        {"price": {"amount": 85000000, "unit": "total", "raw_price_text": "8.5 Cr"}},
        "Ready Fully Furnished Office for Sale in Kapurbawdi, Thane West. Very reasonably priced.",
    )
    assert out["price"]["amount"] is None
    assert out["needs_review"] is True


def test_provider_price_with_source_quote_is_kept():
    out = _source_grounded_price(
        {"price": {"amount": 85000000, "unit": "total", "raw_price_text": "8.5 Cr"}},
        "Ready office for sale. Price 8.5 Cr in Thane West.",
    )
    assert out["price"]["amount"] == 85000000


def test_mixed_rent_and_sale_quotes_are_attached_to_the_matching_mode():
    source = """Available Premium Spacious 2 BHK For Rent & Sale
Price:
For Rent 2.25 L
For Sale 5.25 CR
"""
    sale = _source_grounded_price({
        "listing_type": "sale",
        "price": {"amount": 225000, "unit": "total", "raw_price_text": "For Rent 2.25 L"},
    }, source)
    rent = _source_grounded_price({
        "listing_type": "rent",
        "price": {"amount": 52500000, "unit": "total", "raw_price_text": "For Sale 5.25 CR"},
    }, source)

    assert sale["price"]["amount"] == 52500000
    assert sale["price"]["raw_price_text"] == "For Sale 5.25 CR"
    assert rent["price"]["amount"] == 225000
    assert rent["price"]["raw_price_text"] == "For Rent 2.25 L"


def test_preleased_is_preserved_as_occupancy_status():
    out = _apply_deterministic_field_fallbacks(
        {"listing_type": "sale", "occupancy_status": None},
        "Pre-Leased Investment Opportunity in Thane West",
    )
    assert out["occupancy_status"] == "pre_leased"


def test_requirement_preserves_ordered_bandra_khar_preferences_and_dialect():
    out = _apply_deterministic_field_fallbacks(
        {"listing_type": "requirement", "locality_options": [], "furnishing_preference": "fully_loaded"},
        "Require\n1 Bhk Fully Loaded for Expat - Company Lease\nBandra or max Khar\nBudget 1 Lac",
    )
    assert out["locality_options"] == ["Bandra West", "Khar West"]
    assert out["furnishing_preference"] == "fully_furnished"
    assert out["tenant_type"] == "expat"
    assert out["lease_term_preference"] == "company_lease"
    assert out["company_lease_criteria"] is True


def test_requirement_recovers_bhk_from_source_when_provider_omits_it():
    out = _apply_deterministic_field_fallbacks(
        {"listing_type": "requirement", "bhk": None, "bhk_options": []},
        "Require\n1 Bhk Fully Loaded for Expat - Company Lease\nBudget 1 Lac",
    )
    assert out["bhk"] == 1.0


def test_normalizer_tolerates_object_and_punctuation_numeric_fields():
    out = _normalize_extraction({
        "listing_type": "rent",
        "property_category": "residential",
        "bhk": {"value": 3},
        "carpet_area_sqft": {"amount": "1,250"},
        "price": {"amount": {"value": "."}, "unit": "total", "raw_price_text": "Rent on request"},
        "car_parking_count": "Steel parking",
    })

    assert out["bhk"] == 3.0
    assert out["carpet_area_sqft"] == 1250.0
    assert out["price"]["amount"] is None
    assert "car_parking_count" not in out


def test_title_generation_ignores_non_numeric_provider_amount():
    title = generate_title({
        "listing_type": "rent",
        "property_category": "residential",
        "bhk": {"value": 2},
        "price": {"amount": {"value": "."}, "raw_price_text": "Rent on request"},
        "locality": {"resolved_locality": "Bandra West"},
    })

    assert "2 BHK" in title
    assert "Rent on request" in title


def test_parsed_conversion_tolerates_dirty_numeric_fields():
    parsed = _ai_extraction_to_parsed({
        "listing_type": "rent",
        "property_category": "residential",
        "price": {"amount": 125000, "unit": "total", "raw_price_text": "Rent 1.25 Lac"},
        "bhk": 2,
        "deposit_amount": {"value": "."},
        "bathroom_count": "Steel parking",
        "car_parking_count": "Steel parking",
        "interior_value": {"value": "."},
    }, "Rent 1.25 Lac", "Broker", "Broker")

    assert parsed["monthly_rent"] == 125000
    assert parsed["deposit_amount"] is None
    assert parsed["bathroom_count"] is None
    assert parsed["car_parking_count"] is None
    assert parsed["interior_value"] is None


def test_deposit_parser_tolerates_punctuation_only_amounts():
    parsed = _ai_extraction_to_parsed({
        "listing_type": "rent",
        "property_category": "residential",
        "price": {"amount": 125000, "unit": "total", "raw_price_text": "Rent 1.25 Lac"},
        "bhk": 2,
        "deposit_raw_text": "deposit ..2",
    }, "Rent 1.25 Lac deposit ..2", "Broker", "Broker")

    assert parsed["monthly_rent"] == 125000
    assert parsed["deposit_amount"] is None
    assert parsed["deposit_months"] is None
