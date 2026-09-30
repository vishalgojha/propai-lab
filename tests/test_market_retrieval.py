from market.retrieval import normalize_search_text, sort_retrieval_results


def test_normalize_search_text_handles_whatsapp_styled_localities():
    assert normalize_search_text("𝗕𝗮𝗻𝗱𝗿𝗮 𝗘𝗮𝘀𝘁") == "bandra east"


def test_sort_retrieval_results_prefers_exact_and_deduplicates():
    rows = [
        {"raw_message_id": 2, "match_scope": "nearby", "message": "nearby"},
        {"raw_message_id": 1, "match_scope": "exact", "message": "exact"},
        {"raw_message_id": 1, "match_scope": "exact", "message": "exact"},
    ]

    result = sort_retrieval_results(rows)

    assert [row["raw_message_id"] for row in result] == [1, 2]
