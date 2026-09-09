from extraction import _recover_explicit_source_fields
from extraction_quality import building_name_problem


def test_location_label_is_never_promoted_to_building_name():
    assert building_name_problem(
        "Location: New link road, Andheri (West)"
    ) == "building_name_is_location_context"


def test_commercial_source_fallback_preserves_use_deposit_and_parking():
    source = (
        "SHOWROOM AVAILABLE ON RENT\nLocation: New link road, Andheri (West)\n"
        "Area: 2192sqft carpet\n6 Car parkings\n"
        "Ideal for Automobile showroom/ Banks/ Boutique/ Departmental Store/ Cafeteria\n"
        "Deposit 6 months\nMonthly Compensation Rs. 8 Lakhs"
    )
    result = _recover_explicit_source_fields(
        {"property_category": "commercial", "parking_details": {"key": "explicit source-grounded value"}},
        source,
    )
    assert result["commercial_use_type"] == "showroom"
    assert result["deposit_months"] == 6.0
    assert result["car_parking_count"] == 6
    assert result["parking_details"]["source_text"] == "6 Car parkings"
    assert result["unstructured_facts"]["suitable_for"] == [
        "Automobile showroom", "Banks", "Boutique", "Departmental Store", "Cafeteria"
    ]
