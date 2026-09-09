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


def test_furnishing_after_building_dash_is_not_locality(monkeypatch):
    import extraction as extraction_module

    monkeypatch.setattr(
        extraction_module,
        "_BUILDING_DICT",
        {"metropolis": "Metropolis"},
    )
    from extraction import _ai_extraction_to_parsed

    parsed = _ai_extraction_to_parsed(
        {
            "listing_type": "rent",
            "transaction_type": "rent",
            "property_category": "residential",
            "bhk": 3,
            "building_name": "Metro Police",
            "locality": {"confidence": "low"},
            "price": {"amount": 145000, "unit": "total", "period": "per_month"},
            "furnishing_status": "fully_furnished",
        },
        "3BHK Metro Police - Furnished\nRent: ₹1.45L",
        "",
        "",
        slice_text="3BHK Metro Police - Furnished\nRent: ₹1.45L",
    )

    assert parsed["building_name"] == "Metropolis"
    assert parsed["location_raw"] is None
    assert parsed["micro_market"] is None


def test_tenant_rule_cannot_become_building_when_shared_header_exists():
    from extraction import _ai_extraction_to_parsed

    raw = """*🚨 MARINA BAY 🚨*
*📍 WORLI 📍*
*✨ PREMIUM BARE-SHELL RESIDENCES ✨*
*▦ 3 BHK*
📐 Carpet Area: 1,847 Sq. Ft.
💰 Price: On Call
🏗️ Bare Shell
*▦ 4 BHK*
📐 Carpet Area: 3,692 Sq. Ft.
💰 Rent : 19Lac
possession 1 Feb 2027
Only vegetarian Client"""
    source_slice = """* 4 BHK*
Carpet Area: 3,692 Sq. Ft.
Rent : 19Lac
possession 1 Feb 2027
Only vegetarian Client"""
    parsed = _ai_extraction_to_parsed(
        {
            "listing_type": "rent",
            "transaction_type": "rent",
            "property_category": "residential",
            "bhk": 4,
            "building_name": "Only vegetarian Client",
            "locality": {"raw_mention": "Worli", "resolved_locality": "Worli", "confidence": 1},
            "price": {"amount": 1900000, "unit": "total", "period": "per_month"},
            "furnishing_status": "bare_shell",
        },
        raw,
        "",
        "",
        slice_text=source_slice,
    )

    assert parsed["building_name"] == "MARINA BAY"
    assert parsed["micro_market"] == "Worli"


def test_explicit_slice_location_overrides_broadcast_market_context():
    from extraction import _ground_locality_to_source

    ai = {
        "locality": {
            "raw_mention": "Bandra West",
            "resolved_locality": "Bandra West",
            "confidence": 0.9,
        },
        "micro_market": "Bandra West",
    }
    source = "AVAILABLE FOR RENT\nCARPET 1100 SQFT\nRENT 2.10K\nLOCATION SANPADA"

    repaired = _ground_locality_to_source(ai, source)

    assert repaired["locality"]["raw_mention"] == "SANPADA"
    assert repaired["locality"]["resolved_locality"] == "SANPADA"
    assert repaired["micro_market"] == "SANPADA"
    assert "locality_repaired_from_explicit_source_boundary" in repaired["validation_flags"]
