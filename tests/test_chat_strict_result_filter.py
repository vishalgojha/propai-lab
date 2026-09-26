import json

import ai_chat_engine
from ai_chat_engine import parse_market_search_request


def test_strict_market_response_drops_wrong_type_bhk_location_and_budget_rows():
    query = {
        "bhk": "3",
        "intent": "RENT",
        "property_type": "residential",
        "micro_markets": ["Bandra West"],
        "price_max": 300000,
    }
    payload = json.dumps({
        "type": "listing_results",
        "total": 3,
        "results": [
            {"building_name": "One BKC", "property_type": "commercial", "bhk": None,
             "intent": "RENT", "micro_market": "Bandra East", "price": 325000},
            {"building_name": "Wrong BHK", "property_type": "residential", "bhk": 2,
             "intent": "RENT", "micro_market": "Bandra West", "price": 150000},
            {"building_name": "Correct Flat", "property_type": "residential", "bhk": 3,
             "intent": "RENT", "micro_market": "Bandra West", "price": 275000},
        ],
    })

    response = ai_chat_engine.deterministic_market_response(query, payload)

    assert response["blocks"][0]["items"] == [{
        "building_name": "Correct Flat", "property_type": "residential", "bhk": 3,
        "intent": "RENT", "micro_market": "Bandra West", "price": 275000,
    }]
    assert "Found 1 active match" in response["content"]


def test_strict_market_response_applies_area_bounds():
    query = {
        "property_type": "commercial",
        "intent": "COMMERCIAL",
        "micro_markets": ["Bandra West"],
        "area_min": 200,
        "area_max": 400,
    }
    payload = json.dumps({
        "type": "listing_results",
        "total": 2,
        "results": [
            {"building_name": "Too Big", "property_type": "commercial", "intent": "RENT",
             "micro_market": "Bandra West", "price": 100000, "area_sqft": 2530},
            {"building_name": "In Range", "property_type": "commercial", "intent": "RENT",
             "micro_market": "Bandra West", "price": 100000, "area_sqft": 300},
        ],
    })

    response = ai_chat_engine.deterministic_market_response(query, payload)

    assert [item["building_name"] for item in response["blocks"][0]["items"]] == ["In Range"]
    assert response["blocks"][0]["items"][0]["area_sqft"] == 300


def test_market_area_bounds_variants():
    assert ai_chat_engine._market_area_bounds("200 to 400 sqft shop") == (200.0, 400.0)
    assert ai_chat_engine._market_area_bounds("500-800 sq.ft. office") == (500.0, 800.0)
    assert ai_chat_engine._market_area_bounds("under 400 sqft") == (None, 400.0)
    assert ai_chat_engine._market_area_bounds("above 300 square feet") == (300.0, None)
    assert ai_chat_engine._market_area_bounds("1,200 sqft flat") == (1200.0, 1200.0)
    assert ai_chat_engine._market_area_bounds("a lovely big shop") == (None, None)


def test_parse_market_area_for_commercial_shop_rent():
    parsed = parse_market_search_request(
        "looking for a 200 to 400 sqft shop for rent in bandra west", allow_llm=False
    )
    assert parsed is not None
    assert parsed["property_type"] == "commercial"
    assert parsed["intent"] == "COMMERCIAL"
    assert parsed["micro_markets"] == ["Bandra West"]
    assert parsed["area_min"] == 200.0
    assert parsed["area_max"] == 400.0
