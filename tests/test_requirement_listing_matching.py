from matching.requirement_listing_matcher import cap_matches, normalize_bhk, score_candidate


def req(**overrides):
    value = {
        "id": 1, "req_type": "commercial_rent", "tenant_id": "t1",
        "micro_market": "Bandra West", "bhk_options": [],
        "budget_min": 100000, "budget_max": 120000,
    }
    value.update(overrides)
    return value


def listing(**overrides):
    value = {
        "id": 2, "tenant_id": "t1", "asset_type": "commercial",
        "transaction_type": "rent", "canonical_micro_market_slug": "bandra-west",
        "price": 110000, "price_model": "per_month", "needs_review": False,
        "extraction_confidence": "high", "building_name": "A Tower", "broker_id": 4,
    }
    value.update(overrides)
    return value


def test_normalizes_float_bhk_text():
    assert normalize_bhk("2.0 BHK") == 2


def test_rejects_wrong_transaction_type():
    assert score_candidate(req(), listing(transaction_type="sale")) is None


def test_missing_tenant_never_matches_even_another_missing_tenant():
    assert score_candidate(req(tenant_id=None), listing(tenant_id=None)) is None
    assert score_candidate(req(tenant_id=None), listing(tenant_id="t2")) is None


def test_psf_uses_derived_price_and_flags_corrupt_raw_price():
    result = score_candidate(req(), listing(
        price=110_000_000_000, price_model="psf", price_per_sqft=110,
        carpet_area_sqft=1000,
    ))
    assert result is not None
    assert result["price_implausible"] is True
    assert result["price_match"] is None


def test_caps_same_broker_and_building():
    rows = [{"match_score": 90 - i, "listing": listing(id=i, broker_id=4, building_name="A Tower")} for i in range(3)]
    rows += [{"match_score": 60, "listing": listing(id=10, broker_id=5, building_name="A Tower")}]
    selected = cap_matches(rows, cap=5)
    assert [row["listing"]["id"] for row in selected] == [0, 10]
