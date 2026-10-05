from market.retrieval import confidence_score, normalize_search_text, sort_retrieval_results


def test_normalize_search_text_handles_whatsapp_styled_localities():
    assert normalize_search_text("𝗕𝗮𝗻𝗱𝗿𝗮 𝗘𝗮𝘀𝘁") == "bandra east"


def test_confidence_score_accepts_labels_and_numbers():
    assert confidence_score("medium") == 65
    assert confidence_score("HIGH") == 85
    assert confidence_score(0.9) == 90
    assert confidence_score(90) == 90
    assert confidence_score("85%") == 85
    assert confidence_score(None) == 0
    assert confidence_score("unknown") == 0


def test_sort_retrieval_results_survives_label_confidence():
    rows = [
        {"raw_message_id": 1, "match_scope": "exact", "message": "a", "confidence": "low"},
        {"raw_message_id": 2, "match_scope": "exact", "message": "b", "confidence": "medium"},
        {"raw_message_id": 3, "match_scope": "exact", "message": "c", "extraction_confidence": 0.8},
    ]

    result = sort_retrieval_results(rows)

    assert [row["raw_message_id"] for row in result] == [3, 2, 1]


def test_sort_retrieval_results_prefers_exact_and_deduplicates():
    rows = [
        {"raw_message_id": 2, "match_scope": "nearby", "message": "nearby"},
        {"raw_message_id": 1, "match_scope": "exact", "message": "exact"},
        {"raw_message_id": 1, "match_scope": "exact", "message": "exact"},
    ]

    result = sort_retrieval_results(rows)

    assert [row["raw_message_id"] for row in result] == [1, 2]
