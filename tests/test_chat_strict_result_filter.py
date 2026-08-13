import json

import ai_chat_engine


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
