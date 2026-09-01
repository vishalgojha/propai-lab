from extraction import (
    _ai_extraction_to_parsed,
    _ai_extraction_to_typed,
    _extract_broker_signature_names,
    _infer_building_name_from_source,
    _is_actionable_property_slice,
    _quarantine_broker_signature_building,
    _slice_blocks_for_ai_items,
)
from extraction_quality import repair_building_assignment


KATARA_BROADCAST = """Dear Associates

*Residential Outright*
*Cuffe Parade / Nariman Point / Colaba / Churchgate*- *New Listings added*

*NCPA* - Nariman Point 3 BHK - *2880 sq ft* - Fully Furnished - *40 Cr*
*Cuffe Parade - Premium Tower* - 4 BHK - *2600 sq ft* - *24.50 Cr*
*Waterfront towers* Near Colaba PO - 3000 sq ft - 31.50 Cr
*Ravindra Mansion* - Churchgate 3 BHK 1500 sq ft - Partly furnished

*Kindly allow 24 Hrs to set up visits - Client Business profile needed*
Katara Elite Estates
Prem Katara
MAHARERA Regd.
9867077740 / 8169085673"""


def test_dense_bulk_rows_receive_distinct_source_slices():
    items = [
        {"building_name": "NCPA", "bhk": 3, "carpet_area_sqft": 2880},
        {"building_name": "Cuffe Parade - Premium Tower", "bhk": 4, "carpet_area_sqft": 2600},
        {"building_name": "Waterfront towers", "carpet_area_sqft": 3000},
        {"building_name": "Ravindra Mansion", "bhk": 3, "carpet_area_sqft": 1500},
        {"building_name": "Katara Elite Estates"},
    ]

    slices = _slice_blocks_for_ai_items(KATARA_BROADCAST, items)

    assert slices[0].startswith("*NCPA*") and "Premium Tower" not in slices[0]
    assert slices[1].startswith("*Cuffe Parade - Premium Tower*") and "NCPA" not in slices[1]
    assert slices[2].startswith("*Waterfront towers*") and "Ravindra Mansion" not in slices[2]
    assert slices[3].startswith("*Ravindra Mansion*") and "Katara Elite" not in slices[3]
    assert not _is_actionable_property_slice(slices[4])


def test_footer_company_and_person_are_quarantined_as_buildings():
    signatures = _extract_broker_signature_names(KATARA_BROADCAST)
    assert signatures == {"katara elite estates", "prem katara"}

    for value in signatures:
        parsed = {"building_name": value, "validation_flags": []}
        ai_item = {"building_name": value}
        assert _quarantine_broker_signature_building(parsed, ai_item, signatures)
        assert parsed["building_name"] is None


def test_generic_tower_and_broker_note_are_never_repaired_as_buildings():
    generic = {"building_name": "Cuffe Parade - Premium Tower", "micro_market": "Cuffe Parade"}
    repair_building_assignment(
        generic,
        "*Cuffe Parade - Premium Tower* - 4 BHK - 2600 sq ft - 24.50 Cr",
    )
    assert generic["building_name"] is None
    assert "building_name_is_generic_descriptor" in generic["validation_flags"]

    note = {
        "building_name": "Kindly allow 24 Hrs to set up visits - Client Business profile needed",
        "micro_market": "Colaba",
    }
    repair_building_assignment(
        note,
        "*Kindly allow 24 Hrs to set up visits - Client Business profile needed*",
    )
    assert note["building_name"] is None
    assert "building_name_is_listing_text" in note["validation_flags"]


def test_broker_name_next_to_phone_is_never_a_building_or_title_token():
    source = """2bhk Rumo 750 sq ft carpet Bandra Rs.1.25 lakh. Only Catholic.
Radhakishan Nagpal
9987654321"""
    ai_item = {
        "listing_type": "rent",
        "transaction_type": "rent",
        "property_category": "residential",
        "building_name": "Radhakishan Nagpal",
        "title": "2 BHK for Rent — Radhakishan Nagpal — ₹1.25 Lakh/month",
        "bhk": 2,
        "carpet_area_sqft": 750,
        "price": {"amount": 1.25, "unit": "lakh", "period": "month"},
        "locality": {"raw_mention": "Bandra", "resolved_locality": "Bandra"},
    }

    parsed = _ai_extraction_to_parsed(ai_item, source, "", "", slice_text=source)

    assert parsed["building_name"] is None
    assert "building_name_is_broker_signature" in parsed["validation_flags"]
    assert "Radhakishan Nagpal" not in (parsed["summary_title"] or "")


def test_commercial_broker_signature_is_never_a_building_or_title_token():
    source = """Office 1200 sq ft for rent in Lower Parel, fully furnished, Rs.2.5 lakh.
Cedric Fernandes
9000000000"""
    table, row = _ai_extraction_to_typed(
        {
            "listing_type": "rent",
            "transaction_type": "rent",
            "property_category": "commercial",
            "building_name": "Cedric Fernandes",
            "title": "Office for Rent — Cedric Fernandes — ₹2.5 Lakh/month",
            "carpet_area_sqft": 1200,
            "furnishing_status": "Fully Furnished",
            "price": {"amount": 2.5, "unit": "lakh", "period": "month"},
            "locality": {"raw_mention": "Lower Parel", "resolved_locality": "Lower Parel"},
        },
        source,
    )

    assert table == "commercial_rent_listings"
    assert row.get("building_name") is None
    assert "building_name_is_broker_signature" in row["validation_flags"]
    assert "Cedric Fernandes" not in (row["summary_title"] or "")
    assert "Fully furnished" in (row["summary_title"] or "")


def test_bold_building_boundary_does_not_absorb_adjacent_locality():
    assert _infer_building_name_from_source(
        "*Rustomjee Crown* prabhadevi - 3BHK - 1335 Sq ft - 9.25 Cr"
    ) == "Rustomjee Crown"
    assert _infer_building_name_from_source(
        "*Ansal Heights* - Worli - 3.5 BHK - 1450 sq ft - 7.50 Cr"
    ) == "Ansal Heights"
    assert _infer_building_name_from_source(
        "*Cuffe Parade - Premium Tower* - 4 BHK - 2600 sq ft - 24.50 Cr"
    ) is None


def test_ai_glued_building_and_locality_are_separated_from_source_evidence():
    ai_item = {
        "listing_type": "sale",
        "transaction_type": "sale",
        "property_category": "residential",
        "building_name": "Rustomjee Crown prabhadevi",
        "bhk": 3,
        "carpet_area_sqft": 1335,
        "price": {"amount": 9.25, "unit": "cr", "raw_price_text": "9.25 Cr"},
        "locality": {"raw_mention": None, "resolved_locality": None},
        "extraction_confidence_score": 0.9,
    }
    source = "*Rustomjee Crown* prabhadevi - 3BHK - 1335 Sq ft - 9.25 Cr"

    parsed = _ai_extraction_to_parsed(ai_item, source, "", "", slice_text=source)

    assert parsed["building_name"] == "Rustomjee Crown"
    assert parsed["location_raw"] == "prabhadevi"
    assert parsed["micro_market"] == "prabhadevi"
    assert ai_item["building_name"] == "Rustomjee Crown"
    assert ai_item["title"] is None
    assert "building_name_repaired_from_explicit_source_boundary" in ai_item["validation_flags"]
