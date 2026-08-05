import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ai_extraction import _apply_deterministic_field_fallbacks


def test_commercial_message_recovers_obvious_schema_facts():
    text = """Available Commercial Office On Sale At Dadar West
Area 2000 Carpet
Condition Bareshell
Car Park 2
New Building
Higher Floor"""

    out = _apply_deterministic_field_fallbacks(
        {"carpet_area_sqft": None, "fitout_status": None, "car_parking_count": None},
        text,
    )

    assert out["carpet_area_sqft"] == 2000.0
    assert out["fitout_status"] == "bare_shell"
    assert out["car_parking_count"] == 2
    assert "brand_new_building" in out["deal_tags"]


def test_commercial_requirement_recovers_range_budget_use_and_localities():
    text = """Commercial Space Required For A Tailoring Unit On Outright Basis
700-1000 sq.ft.
Anywhere in Santacruz Khar Bandra
Budget: 3.15 Cr"""

    out = _apply_deterministic_field_fallbacks({}, text)

    assert out["area_min_sqft"] == 700.0
    assert out["area_max_sqft"] == 1000.0
    assert out["budget_max"] == 31_500_000.0
    assert out["locality_options"] == ["Santacruz", "Khar", "Bandra"]
    assert out["commercial_use_type"] == "tailoring unit"


def test_explicit_available_sale_overrides_wrong_llm_rent():
    text = """*Available Sale*
2 BHK Galaxy Height furnished
Goregaon Metro station
Price,1.90 Cr Negotiable
Rakesh Mishra"""

    out = _apply_deterministic_field_fallbacks(
        {"listing_type": "rent"},
        text,
    )

    assert out["listing_type"] == "sale"
