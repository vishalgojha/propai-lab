from extraction_quality import price_total_needs_quarantine


def test_property_scale_quarantine_is_transaction_aware():
    assert price_total_needs_quarantine("sale", 3, "residential") is True
    assert price_total_needs_quarantine("sale", 35_00_000, "residential") is False
    assert price_total_needs_quarantine("sale", 1_148, "commercial") is True
    assert price_total_needs_quarantine("rent", 850, "residential") is True
    assert price_total_needs_quarantine("rent", 85_000, "residential") is False
