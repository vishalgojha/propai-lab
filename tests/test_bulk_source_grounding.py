from extraction import (
    _extract_broker_signature_names,
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
