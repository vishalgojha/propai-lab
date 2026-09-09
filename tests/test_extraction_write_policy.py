from storage.supabase import _apply_review_write_policy


def test_reviewable_row_is_not_rejected_by_legacy_write_blocked_flag():
    result = _apply_review_write_policy(
        {
            "summary_title": "2 BHK apartment for sale in Bandra West",
            "broker_name": None,
            "write_blocked": True,
            "validation_flags": ["broker_name_not_in_source_slice"],
        }
    )

    assert result["summary_title"] == "2 BHK apartment for sale in Bandra West"
    assert result["broker_name"] is None
    assert "write_blocked" not in result
    assert result["needs_review"] is True
    assert result["validation_flags"] == [
        "broker_name_not_in_source_slice",
        "write_gate_removed_row_saved_with_quarantined_fields",
    ]


def test_clean_row_is_unchanged_by_review_write_policy():
    result = _apply_review_write_policy({"summary_title": "Office for rent in BKC"})

    assert result == {"summary_title": "Office for rent in BKC"}
