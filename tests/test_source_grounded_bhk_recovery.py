from extraction import _apply_source_grounded_bhk_fallback


def test_single_bhk_in_complete_message_recovers_missing_provider_bhk():
    result = _apply_source_grounded_bhk_fallback(
        {},
        "Available 2bhk On Lease\nPalm Crest Apt\nFully furnished",
        "Available 2bhk On Lease",
    )

    assert result["bhk"] == 2.0
    assert "source_bhk_context_fallback" in result["validation_flags"]
