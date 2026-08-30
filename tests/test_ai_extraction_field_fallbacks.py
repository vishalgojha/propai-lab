import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ai_extraction import (
    _normalize_extraction,
    _source_grounded_furnishing,
    _source_grounded_price,
    generate_title,
)
from extraction import _ai_extraction_to_parsed, _price_from_ai_and_raw
from extraction_models import validate_source_semantics


def test_ai_price_unit_is_not_rewritten_from_source_regex():
    assert _price_from_ai_and_raw({
        "amount": 200000,
        "unit": "per_sqft",
        "period": "one_time",
        "raw_price_text": "₹ 2.00 Lakhs.",
    }) == (200000.0, "per_sqft")


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
    assert out["price"]["unit"] == "per_sqft"
    assert out["price"]["period"] == "one_time"
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
    assert out["price"]["period"] == "one_time"


def test_provider_price_without_source_quote_is_retained_for_review():
    out = _source_grounded_price(
        {"price": {"amount": 85000000, "unit": "total", "raw_price_text": "8.5 Cr"}},
        "Ready Fully Furnished Office for Sale in Kapurbawdi, Thane West. Very reasonably priced.",
    )
    assert out["price"]["amount"] == 85000000
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

    assert sale["price"]["amount"] == 225000
    assert rent["price"]["amount"] == 52500000


def test_mixed_psf_quotes_choose_the_quote_for_the_current_route():
    source = """Commercial office for lease
Quote - 500 psf
Price Sale - 85k Per sqft
"""
    rent = _source_grounded_price({
        "listing_type": "rent",
        "price": {"amount": 85000, "unit": "per_sqft", "raw_price_text": "Price Sale - 85k Per sqft"},
    }, source)
    sale = _source_grounded_price({
        "listing_type": "sale",
        "price": {"amount": 500, "unit": "per_sqft", "raw_price_text": "Quote - 500 psf"},
    }, source)

    assert rent["price"]["amount"] == 85000
    assert rent["price"]["unit"] == "per_sqft"
    assert sale["price"]["amount"] == 500


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


def test_furnishing_is_dropped_when_source_does_not_support_it():
    out = _source_grounded_furnishing(
        {"furnishing_status": "unfurnished"},
        "3bhk large\nMagnus\n3+3 jodi\nSeasons",
    )

    assert out["furnishing_status"] is None
    assert out["needs_review"] is True
    assert "furnishing_without_source_evidence" in out["validation_flags"]


def test_explicit_furnishing_evidence_is_preserved():
    out = _source_grounded_furnishing(
        {"furnishing_status": "fully_furnished"},
        "Fully furnished 3 BHK in Magnus",
    )

    assert out["furnishing_status"] == "fully_furnished"


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
