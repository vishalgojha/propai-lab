import extraction
from extraction_quality import building_name_problem


def test_named_villa_headings_are_buildings_not_property_type_labels():
    assert extraction._infer_building_name_from_source(
        "*Villa Capri @1.60 Lakhs*\nVallabhai Patel Road\nSantacruz west | Partly Furnished | 1 Cp."
    ) == "Villa Capri"
    assert extraction._infer_building_name_from_source(
        "*DEVANSH VILLA @1.60 Lakhs*\nSt. Martin Road, Bandra West\nSemi-furnished | 1 cp"
    ) == "DEVANSH VILLA"


def test_standalone_villa_is_not_a_building_name():
    assert building_name_problem("Villa") == "building_name_is_listing_text"
