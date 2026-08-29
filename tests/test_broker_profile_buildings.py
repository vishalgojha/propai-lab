from routers.brokers import _clean_market_building_name


def test_broker_profile_buildings_exclude_locality_preference_labels():
    for value in (
        "Bandra Preferred",
        "Bandra / Khar Preferred",
        "Bandra to Santacruz",
        "Santacruz East",
    ):
        assert _clean_market_building_name({"building_name": value}) == ""


def test_broker_profile_buildings_keep_grounded_building_names():
    assert _clean_market_building_name({"building_name": "Sea View Towers"}) == "Sea View Towers"
