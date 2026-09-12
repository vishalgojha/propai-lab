import config
from extraction_quality import price_total_needs_quarantine


def test_mumbai_price_floor_remains_backward_compatible():
    assert price_total_needs_quarantine("rent", 999, "residential", "mumbai") is True
    assert price_total_needs_quarantine("rent", 1000, "residential", "mumbai") is False


def test_region_price_floors_are_configurable():
    assert price_total_needs_quarantine("rent", 2500, "residential", "delhi") is True
    assert price_total_needs_quarantine("rent", 3000, "residential", "delhi") is False


def test_unknown_region_falls_back_safely():
    assert config.get_region_config("unknown-city") is config.REGION_CONFIG[config.DEFAULT_REGION]
