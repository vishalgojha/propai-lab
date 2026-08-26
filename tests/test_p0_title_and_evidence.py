"""P0 regressions for source-grounded titles and evidence display priority."""

from pathlib import Path

from extraction import _ai_extraction_to_parsed, _ai_extraction_to_typed, _title_evidence_mismatch
from storage.supabase import _preferred_market_source_text


def _item(title: str, building: str | None = None) -> dict:
    return {
        "listing_type": "rent",
        "transaction_type": "rent",
        "property_category": "commercial",
        "title": title,
        "building_name": building,
        "locality": {"raw_mention": "Andheri West", "resolved_locality": "Andheri West"},
        "price": {"amount": 180000, "unit": "total", "raw_price_text": "1.80 lac"},
        "commercial_use_type": "office",
    }


def test_prompt_contains_no_real_building_example_name():
    source = Path(__file__).parents[1] / "ai_extraction.py"
    forbidden = "Naman" + " Midtown"
    assert forbidden not in source.read_text()


def test_unrelated_title_is_flagged_without_silent_rewrite():
    source = "Office for rent in Andheri West\nBuilding - Morya Blue Moon\nRent - 1.80 lac"
    contaminated = "Naman" + " Midtown — Commercial Office for Rent"
    item = _item(contaminated)

    parsed = _ai_extraction_to_parsed(item, source, "", "", slice_text=source)

    assert parsed["building_name"] == "Morya Blue Moon"
    assert "title_evidence_mismatch" in parsed["validation_flags"]
    assert parsed["needs_review"] is True
    assert item["title"] == contaminated


def test_source_supported_title_is_not_flagged():
    building = "Naman" + " Midtown"
    source = f"{building}, Lower Parel\nCommercial office for rent\nRent - 6 lac"
    assert not _title_evidence_mismatch(
        f"{building} — Commercial Office for Rent", source, building
    )


def test_evidence_prefers_full_raw_message_over_short_slice():
    raw = "Office for rent in Andheri West\nBuilding - Morya Blue Moon\nRent - 1.80 lac"
    assert _preferred_market_source_text(raw, "normalized fallback", "Office for rent in Andheri West") == raw


def test_evidence_falls_back_to_normalized_then_slice():
    assert _preferred_market_source_text("", "normalized message", "header") == "normalized message"
    assert _preferred_market_source_text("", "", "header") == "header"


def test_generic_ai_title_is_replaced_with_source_grounded_title():
    source = "3 BHK for sale in Bandra West, 1,200 sqft, 2 Cr"
    table, row = _ai_extraction_to_typed(
        {
            "listing_type": "sale",
            "property_category": "residential",
            "title": "Property for sale",
            "bhk": 3,
            "carpet_area_sqft": 1200,
            "locality": {"raw_mention": "Bandra West", "resolved_locality": "Bandra West"},
            "price": {"amount": 2, "unit": "cr", "raw_price_text": "2 Cr"},
        },
        source,
    )

    assert table == "residential_sale_listings"
    assert row["summary_title"] != "Property for sale"
    assert "3 BHK" in row["summary_title"]
    assert "Bandra West" in row["summary_title"]


def test_shop_is_not_relabelled_as_studio_from_suitability_copy():
    source = (
        "Shop 320 sqft carpet\n14 ft ceiling height\nAttached Washroom\n"
        "Prime Location\nBandra West\nRent: 1.80 Lakhs\n"
        "Good For Jewellers / Designers / Salon / Spa / Nail Art Studio"
    )
    parsed = _ai_extraction_to_parsed(
        {
            "listing_type": "rent",
            "transaction_type": "rent",
            "property_category": "commercial",
            "title": "Studio with 320 sqft for rent at Bandra West",
            "commercial_use_type": "studio",
            "carpet_area_sqft": 320,
            "locality": {"raw_mention": "Bandra West", "resolved_locality": "Bandra West"},
            "price": {"amount": 1.8, "unit": "lakh", "raw_price_text": "1.80 Lakhs"},
        },
        source,
        "",
        "",
        slice_text=source,
    )

    assert parsed["summary_title"].startswith("320 sqft Shop") or "Shop" in parsed["summary_title"]
    assert "Studio with" not in parsed["summary_title"]


def test_business_name_does_not_relabel_bhk_inventory():
    source = (
        "*6 ORVA – BANDRA WEST*\n* 2 BHK + 2 BHK JODI = 4 BHK*\n"
        "Near Tawa Restaurant\nExclusive Fully Furnished\n"
        "Rent: ₹4,00,000/- Slightly Negotiable"
    )
    parsed = _ai_extraction_to_parsed(
        {
            "listing_type": "rent",
            "transaction_type": "rent",
            "property_category": "residential",
            "title": "Restaurant for rent at ORVA, Bandra West",
            "property_type": "restaurant",
            "bhk": 4,
            "locality": {"raw_mention": "Bandra West", "resolved_locality": "Bandra West"},
            "building_name": "ORVA",
            "price": {"amount": 400000, "unit": "total", "raw_price_text": "₹4,00,000"},
        },
        source,
        "",
        "",
        slice_text=source,
    )

    assert "BHK" in parsed["summary_title"]
    assert "Restaurant for rent" not in parsed["summary_title"]


def test_bhk_does_not_override_commercial_asset_type():
    source = "Shop 320 sqft carpet\nGood for a 2 BHK office conversion\nRent: ₹1.8 Lakhs"
    parsed = _ai_extraction_to_parsed(
        {
            "listing_type": "rent",
            "transaction_type": "rent",
            "property_category": "commercial",
            "title": "Shop with 320 sqft for rent",
            "property_type": "shop",
            "locality": {"raw_mention": "Bandra West", "resolved_locality": "Bandra West"},
            "price": {"amount": 180000, "unit": "total", "raw_price_text": "₹1.8 Lakhs"},
        },
        source,
        "",
        "",
        slice_text=source,
    )

    assert "Shop" in parsed["summary_title"]
    assert "BHK" not in parsed["summary_title"]


def test_provider_absence_markers_become_nulls_before_typed_persistence():
    parsed = _ai_extraction_to_parsed(
        {
            **_item("3 BHK for rent in Bandra West"),
            "has_lift": "Unknown",
            "parking_type": "Not identified",
            "furnishing_status": "Not specified",
        },
        "3 BHK for rent in Bandra West",
        "",
        "",
    )

    assert parsed["has_lift"] is None
    assert parsed["parking_type"] is None
    assert parsed["furnishing"] is None


def test_multi_unit_bhk_keeps_count_and_source_bhk():
    source = "4 2BHK Fully Furnished Flat Available on Rent for 10 Lakh"
    table, row = _ai_extraction_to_typed(
        {
            "listing_type": "rent",
            "transaction_type": "rent",
            "property_category": "residential",
            "title": "4 BHK Fully Furnished Flat Available on Rent",
            "bhk": 4,
            "furnishing_status": "Fully Furnished",
            "price": {"amount": 10, "unit": "lakh", "raw_price_text": "10 Lakh"},
        },
        source,
    )

    assert table == "residential_rent_listings"
    assert row["listing_count"] == 4
    assert row["bhk"] == 2
    assert "4" in row["summary_title"] and "2 BHK" in row["summary_title"]


def test_single_bhk_does_not_inherit_model_unit_count():
    source = "Single occupancy in 5 BHK at Kalpataru Magnus for 4.3 Lakh"
    table, row = _ai_extraction_to_typed(
        {
            "listing_type": "rent",
            "transaction_type": "rent",
            "property_category": "residential",
            "title": "5 BHK at Kalpataru Magnus",
            "bhk": 5,
            "listing_count": 5,
            "price": {"amount": 4.3, "unit": "lakh", "raw_price_text": "4.3 Lakh"},
        },
        source,
    )

    assert table == "residential_rent_listings"
    assert row["bhk"] == 5
    assert row.get("listing_count") is None
    assert "5 ×" not in row["summary_title"]


def test_missing_price_and_bhk_are_not_invented():
    source = "3+3 jodi in Seasons"
    parsed = _ai_extraction_to_parsed(
        {
            "listing_type": "sale",
            "transaction_type": "sale",
            "property_category": "residential",
            "title": "3+3 jodi in Seasons",
            "bhk": 3,
            "price": {"amount": 25000000, "unit": "abs"},
        },
        source,
        "",
        "",
        slice_text=source,
    )

    assert parsed["bhk"] is None
    # The plausibility guard preserves the model output for reviewer visibility
    # while flagging it; it must not silently erase the extracted value.
    assert parsed["price"] == 25000000.0
    assert parsed["needs_review"] is True
    assert "price_source_missing" not in parsed["validation_flags"]


def test_commercial_rent_psf_calculates_from_carpet_area():
    source = "Space for Rent in Corporate Avenue, Andheri East. Carpet area: 6207sqft. Rate Per Sqft. on Carpet: 300/-"
    table, row = _ai_extraction_to_typed(
        {
            "listing_type": "rent",
            "transaction_type": "rent",
            "property_category": "commercial",
            "title": "Space for Rent in Corporate Avenue",
            "carpet_area_sqft": 6207,
            "price": {"amount": 300, "unit": "per_sqft", "raw_price_text": "300 per sqft"},
            "commercial_use_type": "office",
        },
        source,
    )

    assert table == "commercial_rent_listings"
    assert row["rent_per_sqft"] == 300
    assert row["monthly_rent"] == 1862100
    assert row["price_math"]["area_sqft"] == 6207


def test_commercial_sale_psf_calculates_from_carpet_area():
    source = "Commercial unit for sale. Carpet area: 6207 sqft. Rate per sqft: 300"
    table, row = _ai_extraction_to_typed(
        {
            "listing_type": "sale",
            "transaction_type": "sale",
            "property_category": "commercial",
            "title": "Commercial unit for sale",
            "carpet_area_sqft": 6207,
            "price": {"amount": 300, "unit": "per_sqft", "raw_price_text": "300 per sqft"},
            "commercial_use_type": "office",
        },
        source,
    )

    assert table == "commercial_sale_listings"
    assert row["price_per_sqft"] == 300
    assert row["total_asking_price"] == 1862100
