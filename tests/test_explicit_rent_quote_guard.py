from extraction import _ai_extraction_to_parsed
from price_normalization import source_attached_price


def test_single_explicit_lakh_quote_is_recovered_when_rent_marker_precedes_it():
    source = "*4 BHK FOR RENT*\nRaheja Bay, Bandra West\n4 lac / F"

    assert source_attached_price(source, "rent") == (400000.0, "4 lac", "abs")


def test_model_40k_cannot_override_source_4_lakh_quote():
    source = "*4 BHK FOR RENT*\nRaheja Bay, Bandra West\n4 lac / F"
    parsed = _ai_extraction_to_parsed(
        {
            "listing_type": "rent",
            "property_category": "residential",
            "bhk": 4,
            "price": {"amount": 40, "unit": "k", "raw_price_text": "40k"},
            "locality": {"resolved_locality": "Bandra West", "raw_mention": "Bandra West"},
        },
        source,
        "Broker",
        "Broker",
        slice_text=source,
    )

    assert parsed["price"] == 400000.0
    assert parsed["monthly_rent"] == 400000.0
