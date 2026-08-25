import extraction

from price_plausibility import numeric_value_is_grounded, price_total_from_psf


def test_ambiguous_bare_number_price_is_quarantined():
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

    assert out["price"] == {}
    assert out["extraction_confidence"] == "low"
    assert out["needs_review"] is True
    assert "price_source_missing" in out["validation_flags"]


def test_grounded_psf_arithmetic_is_preserved():
    item = {
        "listing_type": "sale",
        "property_category": "commercial",
        "price": {"amount": 2750000, "unit": "total", "raw_price_text": "2750000"},
        "price_per_sqft": 275,
        "carpet_area_sqft": 1000,
        "extraction_confidence": "high",
        "extraction_confidence_score": 0.9,
    }

    out = extraction._apply_source_evidence_gates(
        item,
        "Office 275 psf, 1000 sqft, total 2750000",
    )

    assert out["price"]["amount"] == 2750000
    assert out["price_per_sqft"] == 275
    assert out.get("needs_review") is not True


def test_hallucinated_price_is_removed_and_flagged():
    item = {
        "price": {"amount": 85000000, "unit": "total", "raw_price_text": "8.5 Cr"},
        "extraction_confidence": "high",
        "extraction_confidence_score": 0.9,
    }

    out = extraction._apply_source_evidence_gates(item, "Ready office, details on request")

    assert out["price"] == {}
    assert out["needs_review"] is True
    assert out["extraction_confidence"] == "low"
    assert "price_source_missing" in out["validation_flags"]


def test_shared_psf_plausibility_rule_is_deterministic():
    derived, implausible = price_total_from_psf(275000, 275, 1000)
    assert derived == 275000
    assert implausible is False
    assert numeric_value_is_grounded(150000, "Rent 1.5 lakh")
