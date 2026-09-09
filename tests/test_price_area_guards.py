from ai_extraction import _normalize_extraction, generate_title
from extraction import _recover_explicit_source_fields


def test_psf_price_cannot_inherit_monthly_period_or_title_suffix():
    item = _normalize_extraction({
        "listing_type": "rent",
        "property_category": "commercial",
        "price": {
            "amount": 250,
            "unit": "per_sqft",
            "period": "per_month",
            "raw_price_text": "₹250 PSF",
        },
    })

    assert item["price"]["period"] is None
    assert "₹250 PSF" in generate_title(item)
    assert "/month" not in generate_title(item)


def test_commercial_area_range_is_preserved_as_range():
    item = _recover_explicit_source_fields(
        {}, "• Andheri East – 9,500 / 12,500 Carpet | Bare Shell | ₹250 PSF"
    )

    assert item["area_min_sqft"] == 9500
    assert item["area_max_sqft"] == 12500
    assert item["area_raw_text"] == "9,500 / 12,500 Carpet"


def test_loft_area_is_not_summed_into_primary_commercial_area():
    item = _recover_explicit_source_fields(
        {
            "carpet_area_sqft": 960,
            "chargeable_area_sqft": 960,
        },
        "• Parinee I – 600 + 360 Loft | Furnished | ₹2.25L Rent / ₹5 Cr Sale",
    )

    assert item["carpet_area_sqft"] is None
    assert item["chargeable_area_sqft"] is None
    assert item["mezzanine_area_sqft"] == 360
    assert item["area_raw_text"] == "600 + 360 Loft"
    assert "composite_area_components_preserved" in item["validation_flags"]
