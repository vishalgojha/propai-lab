from extraction_scope import configured_market_localities, market_scope_skip_reason


def test_selected_locality_allows_typed_extraction():
    preferences = {"primary_localities": ["Bandra East", "BKC"], "nearby_localities": ["Bandra West"]}
    assert market_scope_skip_reason("2 BHK available in Bandra East", preferences) is None
    assert market_scope_skip_reason("Office near BKC connector", preferences) is None
    assert market_scope_skip_reason("Office in Bandra Kurla Complex", preferences) is None


def test_unselected_locality_remains_raw_only():
    preferences = {"primary_localities": ["Bandra East"], "nearby_localities": []}
    assert market_scope_skip_reason("Flat available in Andheri West", preferences) == "outside_market_scope"


def test_missing_selection_fails_closed():
    assert configured_market_localities(None) == []
    assert market_scope_skip_reason("Flat available in Bandra East", None) == "market_scope_unconfigured"
