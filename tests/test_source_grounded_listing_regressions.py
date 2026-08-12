import sys
from pathlib import Path
from types import ModuleType


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.modules.setdefault("pandas", ModuleType("pandas"))


def test_bathroom_count_is_never_a_building_name():
    from building_quality import is_valid_building_candidate
    from extraction_quality import building_name_problem

    for value in ("2 Bathrooms", "1 bathroom", "3 Washrooms", "2 toilets"):
        assert building_name_problem(value) == "building_name_is_listing_text"
        assert not is_valid_building_candidate(value)


def test_exact_source_crore_price_overrides_shifted_model_amount():
    from extraction import _price_from_ai_and_raw

    source = """🏡 FOR SALE
📍 4 Bungalows, Andheri West
✨ 1 BHK | Fully Furnished with Electronics
💰 Asking: ₹1.85 Cr
"""
    amount, unit = _price_from_ai_and_raw(
        {"amount": 18.5, "unit": "lakh", "raw_price_text": None},
        source,
    )

    assert amount == 18_500_000
    assert unit == "abs"
