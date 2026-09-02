from dedupe_evaluation import evaluate_reviewed_cases


def test_reviewed_dedupe_metrics_show_suppression_and_errors_separately():
    result = evaluate_reviewed_cases([
        {"expected_duplicate": True, "observed_reused": True},
        {"expected_duplicate": True, "observed_reused": False},
        {"expected_duplicate": False, "observed_reused": True},
        {"expected_duplicate": False, "observed_reused": False},
    ])

    assert result == {
        "reviewed_cases": 4,
        "expected_duplicates": 2,
        "suppressed_duplicates": 2,
        "model_calls_avoided": 2,
        "false_merges": 1,
        "missed_duplicates": 1,
        "suppression_rate": 0.5,
        "duplicate_recall": 0.5,
    }


def test_empty_reviewed_corpus_is_explicitly_unmeasured():
    result = evaluate_reviewed_cases([])

    assert result["reviewed_cases"] == 0
    assert result["false_merges"] == 0
    assert result["missed_duplicates"] == 0
    assert result["suppression_rate"] == 0.0
