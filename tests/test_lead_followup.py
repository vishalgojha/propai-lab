from services.lead_followup import build_followup_draft, priority_for_lead


def test_priority_uses_explainable_match_score():
    assert priority_for_lead({"status": "matched"}, [{"match_score": 82}]) == "high"
    assert priority_for_lead({"status": "matched"}, [{"match_score": 70}]) == "normal"
    assert priority_for_lead({"status": "contacted"}, [{"match_score": 99}]) == "done"


def test_draft_contains_only_lead_and_listing_facts():
    draft = build_followup_draft(
        {"contact_name": "Asha", "parsed_requirement": {"transaction_type": "sale", "micro_market": "Bandra West"}},
        {"title": "2 BHK · Sea View", "building_name": "Sea View"},
    )
    assert draft == (
        "Hi Asha, thanks for your enquiry. I found a potential match: 2 BHK · Sea View "
        "(sale, Bandra West). Would you like me to share the details and arrange a viewing?"
    )
