from extraction import _ai_extraction_to_parsed, _expand_source_explicit_variants
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


def test_individually_saleable_jodi_expands_to_three_listings():
    source = "3 BHK + 3 BHK (JODI), available for sale individually"
    parsed = {
        "asset_type": "residential",
        "transaction_type": "sale",
        "intent": "SELL",
        "bhk": 3,
        "building_name": "Anand 268",
        "micro_market": "Khar West",
        "is_combination_unit": True,
        "configuration_details": "3 BHK + 3 BHK (JODI)",
    }
    rows, ai_rows, slices = _expand_source_explicit_variants(
        [parsed], [{"configuration_details": parsed["configuration_details"]}], [source]
    )

    assert len(rows) == len(ai_rows) == len(slices) == 3
    assert rows[0]["is_combination_unit"] is True
    assert rows[0]["can_sell_separately"] is True
    assert all(row["is_combination_unit"] is False for row in rows[1:])
    assert all(row["can_sell_separately"] is True for row in rows[1:])
    assert all("also available as JODI" in row["configuration_details"] for row in rows[1:])
    assert all(row.get("total_asking_price") is None for row in rows[1:])
    assert all("individual_unit_price_not_explicit" in row["validation_flags"] for row in rows[1:])


def test_explicit_sale_and_rent_creates_separate_transaction_cards():
    source = "3 BHK at Anand 268 available for sale and rent"
    parsed = {
        "asset_type": "residential",
        "transaction_type": "sale",
        "intent": "SELL",
        "bhk": 3,
        "building_name": "Anand 268",
        "micro_market": "Khar West",
    }

    rows, _, _ = _expand_source_explicit_variants([parsed], [{}], [source])

    assert [row["transaction_type"] for row in rows] == ["sale", "rent"]
    assert [row["intent"] for row in rows] == ["SELL", "RENT"]
