from ai_extraction import _get_extraction_prompt, _normalize_extraction
from extraction import _safe_broker_notes


def test_broker_notes_are_normalized_and_bounded():
    result = _normalize_extraction({
        "listing_type": "rent",
        "property_category": "residential",
        "broker_notes": [
            {
                "category": "negotiation",
                "text": "Rent is negotiable",
                "source_text": "Rent: ₹1.5 Lakh negotiable",
            },
            {
                "category": "not-a-category",
                "text": "Video available on request",
                "source_text": "Video available on request",
            },
            {
                "category": "negotiation",
                "text": "Rent is negotiable",
                "source_text": "Rent: ₹1.5 Lakh negotiable",
            },
        ],
    })

    assert result["broker_notes"] == [
        {
            "category": "negotiation",
            "text": "Rent is negotiable",
            "source_text": "Rent: ₹1.5 Lakh negotiable",
        },
        {
            "category": "other",
            "text": "Video available on request",
            "source_text": "Video available on request",
        },
    ]


def test_broker_notes_survive_persistence_safety_boundary():
    assert _safe_broker_notes([
        {"category": "legal", "text": "All papers clear", "source_text": "All Papers Clear"},
        {"category": "charges", "text": "PM maintenance ₹1,700", "source_text": "PM Maintenance - 1700"},
    ]) == [
        {"category": "legal", "text": "All papers clear", "source_text": "All Papers Clear"},
        {"category": "charges", "text": "PM maintenance ₹1,700", "source_text": "PM Maintenance - 1700"},
    ]


def test_route_prompt_requires_broker_notes():
    prompt = _get_extraction_prompt("residential", "rent")
    assert "broker_notes" in prompt
    assert "maintenance" in prompt.lower()
    assert "source_text" in prompt
