from extraction import _source_grounded_title


def test_non_generic_public_model_title_is_preserved():
    title = _source_grounded_title(
        {
            "public_seo_title": "Fully Furnished 1 BHK Flat for Rent in Khar West",
            "price": {"amount": 50000, "period": "per_month"},
        },
        {
            "asset_type": "residential",
            "transaction_type": "rent",
            "furnishing": "fully furnished",
            "building_name": None,
            "micro_market": "Khar West",
        },
        "1 BHK flat for rent in Khar West, fully furnished, 50k",
    )
    assert title == "Fully Furnished 1 BHK Flat for Rent in Khar West"


def test_contradictory_monthly_title_is_regenerated_from_structured_period():
    title = _source_grounded_title(
        {
            "public_seo_title": "Apartment for Rent in Khar West — ₹50,000/month",
            "price": {"amount": 50000, "period": "one_time"},
        },
        {
            "asset_type": "residential",
            "transaction_type": "rent",
            "building_name": None,
            "micro_market": "Khar West",
            "monthly_rent": None,
        },
        "Apartment for rent in Khar West, deposit 50k",
    )
    assert title != "Apartment for Rent in Khar West — ₹50,000/month"
