from extraction import _ai_extraction_to_parsed
from routers.infra import generate_summary_title


def test_explicit_jodi_source_survives_typed_title_generation():
    source = "3 BHK + 3 BHK (JODI) in Anand 268 (8th Rd New Bldg): ₹14 Cr"
    parsed = _ai_extraction_to_parsed(
        {
            "listing_type": "sale",
            "property_category": "residential",
            "transaction_type": "sale",
            "bhk": 3,
            "building_name": "Anand 268",
            "locality": {"raw_mention": "Khar West", "resolved_locality": "Khar West"},
            "price": {"amount": 14, "unit": "cr", "raw_price_text": "₹14 Cr"},
        },
        source,
        "Broker",
        "",
        slice_text=source,
    )

    assert parsed["is_combination_unit"] is True
    assert parsed["configuration_details"] == "3 BHK + 3 BHK (JODI)"
    assert generate_summary_title(parsed, source) == (
        "3 BHK + 3 BHK (JODI) for sale at Anand 268 in Khar West"
    )
