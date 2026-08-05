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
