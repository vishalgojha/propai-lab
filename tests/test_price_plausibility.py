import extraction

from price_plausibility import numeric_value_is_grounded, price_total_from_psf


def test_bare_number_price_is_preserved_when_grounded():
    item = {
        "listing_type": "rent",
        "price": {"amount": 85000, "unit": "total", "raw_price_text": "85000"},
        "extraction_confidence": "high",
        "extraction_confidence_score": 0.9,
    }

    out = extraction._apply_source_evidence_gates(
        item,
        "Office, 900 sqft, 85000, Andheri",
    )

    assert out["price"]["amount"] == 85000
    assert out.get("needs_review") is not True
    assert "price_source_missing" not in out["validation_flags"]


def test_grounded_psf_arithmetic_is_preserved():
    item = {
        "listing_type": "sale",
        "property_category": "commercial",
        "price": {"amount": 275000, "unit": "total", "raw_price_text": "275000"},
        "price_per_sqft": 275,
        "carpet_area_sqft": 1000,
        "extraction_confidence": "high",
        "extraction_confidence_score": 0.9,
    }

    out = extraction._apply_source_evidence_gates(
        item,
        "Office 275 psf, 1000 sqft, total 275000",
    )

    assert out["price"]["amount"] == 275000
    assert out["price_per_sqft"] == 275
    assert out.get("needs_review") is not True


def test_hallucinated_price_is_preserved_and_flagged():
    item = {
        "price": {"amount": 85000000, "unit": "total", "raw_price_text": "8.5 Cr"},
        "extraction_confidence": "high",
        "extraction_confidence_score": 0.9,
    }

    out = extraction._apply_source_evidence_gates(item, "Ready office, details on request")

    assert out["price"]["amount"] == 85000000
    assert out["needs_review"] is True
    assert out["extraction_confidence"] == "low"
    assert "price_value_not_traceable_to_source" in out["validation_flags"]


def test_derived_total_is_allowed_when_rate_and_area_are_grounded():
    item = {
        "property_category": "commercial",
        "listing_type": "rent",
        "price": {"amount": 275000, "unit": "total"},
        "price_per_sqft": 275,
        "carpet_area_sqft": 1000,
        "extraction_confidence": "high",
    }

    out = extraction._apply_source_evidence_gates(item, "Office rent 275 psf, 1000 sqft")

    assert out["price"]["amount"] == 275000
    assert out.get("needs_review") is not True


def test_shared_psf_plausibility_rule_is_deterministic():
    derived, implausible = price_total_from_psf(275000, 275, 1000)
    assert derived == 275000
    assert implausible is False
    assert numeric_value_is_grounded(150000, "Rent 1.5 lakh")
