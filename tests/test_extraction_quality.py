from extraction_quality import building_name_problem, repair_building_assignment


def test_price_only_value_can_never_be_a_building_name():
    assert building_name_problem("3lacs") == "building_name_is_price"
    assert building_name_problem("₹8 lakh/month") == "building_name_is_price"


def test_listing_text_is_not_promoted_to_building_name():
    assert building_name_problem("Fully Furnished") == "building_name_is_listing_text"
    assert building_name_problem("Santacruz East") == "building_name_is_locality"
    assert building_name_problem(
        "Kindly allow 24 Hrs to set up visits - Client Business profile needed"
    ) == "building_name_is_listing_text"
    assert building_name_problem(
        "Cuffe Parade - Premium Tower"
    ) == "building_name_is_generic_descriptor"


def test_bad_building_value_is_repaired_from_its_own_slice_only():
    item = {
        "building_name": "3lacs",
        "micro_market": "Bandra West",
        "bhk": "3 BHK",
    }
    repair_building_assignment(
        item,
        "3 BHK\nDeepak Silverline\nBandra West\nRent - ₹3 lacs",
    )
    assert item["building_name"] == "Deepak Silverline"
    assert item["needs_review"] is True
    assert "building_name_is_price" in item["validation_flags"]


def test_locality_only_slice_stays_null_when_no_building_is_named():
    item = {
        "building_name": "Fully Furnished",
        "micro_market": "Santacruz East",
        "bhk": "4 BHK",
    }
    repair_building_assignment(
        item,
        "4 BHK\nSANTACRUZ EAST\n2,000 sqft\nFully Furnished\nRent - ₹2.50 Lacs",
    )
    assert item["building_name"] is None
    assert "building_name_unresolved" in item["validation_flags"]


def test_sibling_building_is_not_allowed_to_cross_block_boundary():
    item = {
        "building_name": "First Tower",
        "micro_market": "Bandra West",
        "bhk": "2 BHK",
    }
    repair_building_assignment(
        item,
        "2 BHK\nSecond Tower\nBandra West\nRent - ₹1.2 lakh",
    )
    assert item["building_name"] == "Second Tower"
    assert "building_name_not_in_source_slice" in item["validation_flags"]
