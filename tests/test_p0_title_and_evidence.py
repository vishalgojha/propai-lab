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
