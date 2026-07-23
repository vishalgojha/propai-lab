from multi_listing import classify_message, parse_multi_message


def _evidence(item: dict) -> str:
    return str((item.get("raw_payload") or {}).get("full_text") or "")


def test_same_project_separate_floors_become_two_isolated_listings():
    message = """Ten BKC Tower 7
3 BHK semi furnished
1360 carpet
24th floor - 3.00 lacs
17th floor - 3.00 lacs
Kapil Ojha 9773757759"""

    assert classify_message(message) == "multi"
    items = parse_multi_message(message)

    assert len(items) == 2
    assert [item["floor_description"] for item in items] == ["24th Floor", "17th Floor"]
    for item in items:
        assert item["building_name"] == "Ten BKC"
        assert item["project_name"] == "Ten BKC"
        assert item["tower_name"] == "Tower 7"
        assert item["micro_market"] == "BKC"
        assert item["bhk"] == "3 BHK"
        assert item["area_sqft"] == 1360.0
        assert item["furnishing"] == "Semi Furnished"
        assert item["price"] == 3.0
        assert item["price_unit"] == "Lac"
        assert item["broker_name"] == "Kapil Ojha"
        assert item["broker_phone"] == "9773757759"
        assert item["intent"] is None

    assert "24th floor" in _evidence(items[0])
    assert "17th floor" not in _evidence(items[0])
    assert "17th floor" in _evidence(items[1])
    assert "24th floor" not in _evidence(items[1])


def test_same_project_rows_inherit_identity_but_not_option_attributes():
    message = """Ten BKC
3 BHK 1360 carpet semi furnished rent 3 lakh
3 BHK 1450 carpet fully furnished rent 3.5 lakh
Kapil Ojha 9773757759"""

    items = parse_multi_message(message)

    assert len(items) == 2
    assert [item["building_name"] for item in items] == ["Ten BKC", "Ten BKC"]
    assert [item["area_sqft"] for item in items] == [1360.0, 1450.0]
    assert [item["furnishing"] for item in items] == ["Semi Furnished", "Fully Furnished"]
    assert [item["price"] for item in items] == [3.0, 3.5]
    assert [item["broker_phone"] for item in items] == ["9773757759", "9773757759"]

    assert "1450" not in _evidence(items[0])
    assert "3.5 lakh" not in _evidence(items[0])
    assert "1360" not in _evidence(items[1])
    assert "3 lakh" not in _evidence(items[1])
    assert "Ten BKC" in _evidence(items[0])
    assert "Ten BKC" in _evidence(items[1])


def test_explicit_sibling_projects_are_never_overwritten_by_first_heading():
    message = """Greenfields
2 BHK 700 carpet sale 4.4 cr
WestBay
3 BHK 950 carpet sale 4.75 cr
Aaron 8655245101"""

    items = parse_multi_message(message)

    assert len(items) == 2
    assert [item["building_name"] for item in items] == ["Greenfields", "WestBay"]
    assert [item["bhk"] for item in items] == ["2 BHK", "3 BHK"]
    assert [item["area_sqft"] for item in items] == [700.0, 950.0]
    assert [item["price"] for item in items] == [4.4, 4.75]
    assert "WestBay" not in _evidence(items[0])
    assert "Greenfields" not in _evidence(items[1])


def test_inline_sibling_projects_keep_building_location_area_and_price_isolated():
    message = """A Fantastic 2BHK available for sale, 700 sqft, society has a direct beach access,
Location:-Greenfields, Juhu Quote 4.40cr negotiable
WestBay 3BHK available for sale 950 usable 908 on the agreement,
Bandra West, Quote 4.75 cr Negotiable
Vibrant Properties
Aaron 8655245101"""

    assert classify_message(message) == "multi"
    items = parse_multi_message(message)

    assert len(items) == 2
    assert [item["building_name"] for item in items] == ["Greenfields", "WestBay"]
    assert [item["micro_market"] for item in items] == ["Juhu", "Bandra West"]
    assert [item["bhk"] for item in items] == ["2 BHK", "3 BHK"]
    assert [item["area_sqft"] for item in items] == [700.0, 950.0]
    assert [item["price"] for item in items] == [4.4, 4.75]
    assert [item["broker_name"] for item in items] == ["Vibrant Properties", "Vibrant Properties"]
    assert [item["broker_phone"] for item in items] == ["8655245101", "8655245101"]

    assert "WestBay" not in _evidence(items[0])
    assert "4.75 cr" not in _evidence(items[0])
    assert "Greenfields" not in _evidence(items[1])
    assert "4.40cr" not in _evidence(items[1])


def test_or_localities_and_budget_range_remain_one_requirement():
    message = """Sale 3 bhk Bandra East or BKC
budget between 6 to 8 cr
furnished unfurnished not important"""

    assert classify_message(message) == "single"
    assert parse_multi_message(message) == []
