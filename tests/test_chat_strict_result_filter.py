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


def test_extract_workspace_ai_constraints_captures_concrete_filters():
    prefs = ai_chat_engine._extract_workspace_ai_constraints(
        "looking for a 200 to 400 sqft shop for rent in bandra west, max 3 lakh"
    )
    assert prefs["markets"] == ["Bandra West"]
    assert prefs["area_min"] == 200.0
    assert prefs["area_max"] == 400.0
    assert prefs["intent"] == "COMMERCIAL"
    assert prefs["property_type"] == "commercial"
    assert prefs["price_max"] == 300000.0


def test_merge_workspace_ai_constraints_is_bounded_and_recency_wins():
    first = ai_chat_engine._merge_workspace_ai_constraints(
        {},
        {"markets": ["Bandra West"], "bhk": "2", "area_min": 200.0, "area_max": 400.0, "intent": "RENT"},
    )
    merged = ai_chat_engine._merge_workspace_ai_constraints(
        first,
        {"markets": ["Andheri West"], "bhk": "3", "price_max": 200000.0},
    )
    assert merged["markets"] == ["Andheri West", "Bandra West"]
    assert merged["bhk"] == "3"
    assert merged["area_max"] == 400.0
    assert merged["price_max"] == 200000.0
    assert len(merged["recent"]) == 2


def test_render_workspace_ai_preferences_skips_empty():
    assert ai_chat_engine.render_workspace_ai_preferences({}) == ""
    assert ai_chat_engine.render_workspace_ai_preferences(None) == ""
    rendered = ai_chat_engine.render_workspace_ai_preferences(
        {"markets": ["Bandra West"], "bhk": "3", "area_min": 200.0, "area_max": 400.0, "intent": "RENT"}
    )
    assert "Bandra West" in rendered
    assert "200-400 sqft" in rendered
    assert "3 BHK" in rendered


def test_ceiling_budget_keeps_stated_value_but_searches_a_relevance_band():
    parsed = parse_market_search_request(
        "looking for a 3 or 4 bhk for rent in Bandra West budget upto 6 lakh",
        allow_llm=False,
    )
    # The stated ceiling is preserved for preference memory...
    assert parsed["price_max"] == 600000.0
    assert parsed["budget_ceiling"] == 600000.0
    # ...while the search window widens +/-15% around it.
    assert ai_chat_engine._market_budget_band(parsed["budget_ceiling"]) == (510000.0, 690000.0)


def test_explicit_budget_range_is_not_banded():
    parsed = parse_market_search_request(
        "Find 3 BHK rentals in Kandivali West between 80,000 and 1.2 lakh per month.",
        allow_llm=False,
    )
    assert parsed["price_min"] == 80000.0
    assert parsed["price_max"] == 120000.0
    assert "budget_ceiling" not in parsed


def test_link_co_broker_inventory_collapses_same_property_to_one_card():
    rows = [
        {"listing_id": 1, "building_name": "Kukreja Sea Garden", "bhk": 3, "price": 325000,
         "area_sqft": 1000, "micro_market": "Bandra West", "broker_name": "A", "broker_phone": "9833326763"},
        {"listing_id": 2, "building_name": "Kukreja Sea Garden", "bhk": 3, "price": 325000,
         "area_sqft": 1000, "micro_market": "Bandra West", "broker_name": "B", "broker_phone": "8828473896"},
        {"listing_id": 3, "building_name": "Kukreja Sea Garden", "bhk": 3, "price": 325000,
         "area_sqft": 1000, "micro_market": "Bandra West", "broker_name": "A", "broker_phone": "9833326763"},
    ]
    linked = ai_chat_engine.link_co_broker_inventory(rows)
    assert len(linked) == 1
    primary = linked[0]
    assert primary["listing_id"] == 1
    assert primary["broker_count"] == 2
    assert [b["broker_name"] for b in primary["co_brokers"]] == ["B"]


def test_link_co_broker_inventory_leaves_generic_and_singletons_untouched():
    rows = [
        {"listing_id": 4, "building_name": "On Request", "bhk": 4, "price": 550000,
         "area_sqft": None, "micro_market": "Bandra West", "broker_name": "C", "broker_phone": "999"},
        {"listing_id": 5, "building_name": "On Request", "bhk": 4, "price": 550000,
         "area_sqft": None, "micro_market": "Bandra West", "broker_name": "D", "broker_phone": "888"},
        {"listing_id": 6, "building_name": "Solitaire Tower", "bhk": 2, "price": 100000,
         "area_sqft": 600, "micro_market": "Khar", "broker_name": "E", "broker_phone": "777"},
    ]
    linked = ai_chat_engine.link_co_broker_inventory(rows)
    assert [row["listing_id"] for row in linked] == [4, 5, 6]
    assert all("co_brokers" not in row for row in linked)


def test_workspace_response_renders_also_with_co_brokers():
    from routers.common import _workspace_response_to_whatsapp

    response = {
        "blocks": [
            {
                "type": "listing_cards",
                "total": 1,
                "items": [
                    {
                        "building_name": "Kukreja Sea Garden",
                        "price_formatted": "₹3.25L",
                        "bhk": "3",
                        "micro_market": "Bandra West",
                        "broker_name": "Broker A",
                        "broker_phone": "9833326763",
                        "co_brokers": [
                            {"broker_name": "Broker B", "broker_phone": "8828473896"},
                        ],
                    }
                ],
            }
        ]
    }
    rendered = _workspace_response_to_whatsapp(response)
    assert "Broker: Broker A" in rendered
    assert "Also with: Broker B" in rendered
