from ai_extraction import _normalize_extraction, _reconcile_model_semantics


def test_generic_flat_sharing_phrase_is_not_saved_as_building_and_rent_is_monthly():
    source = "6:- *Flat sheering apt* for girl's 50k fully furnished khar West"
    normalized = _normalize_extraction({
        "listing_type": "rent",
        "transaction_type": "rent",
        "property_category": "residential",
        "building_name": "Flat sheering apt",
        "building_resolution_confidence": 0.85,
        "price": {"amount": 50000, "unit": "total", "period": "one_time", "raw_price_text": "50k"},
        "locality": {"raw_mention": "Khar West", "resolved_locality": "Khar West"},
        "furnishing_status": "fully furnished",
    })

    result = _reconcile_model_semantics(normalized, source)

    assert result["building_name"] is None
    assert result["building_name_raw_candidate"] == "Flat sheering apt"
    assert result["arrangement"] == "flat_sharing"
    assert result["price"]["period"] == "per_month"
    assert result["evidence_tiers"]["price.period"] == "inferred"
    assert "generic_descriptor_not_building" in result["validation_flags"]


def test_named_building_is_not_downgraded_by_semantic_guard():
    normalized = _normalize_extraction({
        "listing_type": "rent",
        "transaction_type": "rent",
        "property_category": "residential",
        "building_name": "Evershine Jewel",
        "price": {"amount": 450000, "unit": "total", "period": "per_month"},
        "locality": {"resolved_locality": "Khar West"},
    })

    result = _reconcile_model_semantics(normalized, "3 BHK in Evershine Jewel, Khar West, 4.5 lakh/month")

    assert result["building_name"] == "Evershine Jewel"
    assert result["price"]["period"] == "per_month"
    assert result["evidence_tiers"]["price.period"] == "explicit"


def test_explicit_deposit_is_not_reclassified_as_monthly_rent():
    normalized = _normalize_extraction({
        "listing_type": "rent",
        "transaction_type": "rent",
        "property_category": "residential",
        "price": {"amount": 150000, "unit": "total", "period": "one_time"},
    })

    result = _reconcile_model_semantics(normalized, "Deposit 1.5 lakh for the rental")

    assert result["price"]["period"] == "one_time"
    assert result["evidence_tiers"]["price.period"] == "explicit"
