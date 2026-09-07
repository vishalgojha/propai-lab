import asyncio
from types import SimpleNamespace


def test_chat_keeps_resolved_locality_when_micro_market_is_empty(monkeypatch):
    import routers.ai_chat as ai_chat
    import agent_tools

    monkeypatch.setattr(ai_chat, "storage", SimpleNamespace(client=object()))

    def execute_tool(*args, **kwargs):
        return {
            "status": "ok",
            "results": [{
                "id": 9950,
                "building_name": "BC Corp",
                "micro_market": None,
                "locality_raw": None,
                "locality_resolved": "Bandra East",
                "bhk": "2.0",
                "monthly_rent": 120000,
                "created_at": "2026-09-05T13:14:28+00:00",
            }],
        }

    monkeypatch.setattr(agent_tools, "execute_tool", execute_tool)

    response = asyncio.run(ai_chat._current_listing_search({
        "intent": "RENT",
        "bhk": "2",
        "micro_markets": ["Bandra East"],
    }, "org-1", "user-1"))

    assert response["content"] == "Found 1 active match."
    item = response["blocks"][0]["items"][0]
    assert item["locality_resolved"] == "Bandra East"
    assert item["location_label"] == "Bandra East"


def test_short_locality_followup_is_contextual():
    import routers.ai_chat as ai_chat

    assert ai_chat._is_contextual_locality_followup("and BKC?") is True
    assert ai_chat._is_contextual_locality_followup("where is Rustomjee Paramount?") is False


def test_building_location_question_is_not_inventory_search():
    import routers.ai_chat as ai_chat

    assert ai_chat._extract_building_location_question("where is Rustomjee Paramount?") == "Rustomjee Paramount"
    assert ai_chat._extract_building_location_question("show 3 bhk for rent in Bandra") is None
