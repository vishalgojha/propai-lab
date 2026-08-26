from scripts.backfill_source_evidence_gate import _changes, _source_text


def test_backfill_detects_historical_missing_bhk_without_reimplementing_gate():
    row = {
        "id": 328,
        "raw_message_id": 10,
        "raw_payload": {},
        "ai_extraction": {},
        "validation_flags": [],
        "needs_review": False,
        "extraction_confidence": "high",
        "bhk": 1.0,
        "configuration_type": None,
        "asset_type": "residential",
        "summary_title": "1 BHK in Bandra",
    }

    change = _changes("residential_sale_listings", row, "Available in Bandra at 1.5 Cr")

    assert change["fields"]["bhk"] == {"old": 1.0, "new": None}
    assert change["fields"]["summary_title"] == {"old": "1 BHK in Bandra", "new": None}
    assert change["flags_added"] == ["bhk_source_missing"]
    assert "needs_review" not in change["fields"]


def test_source_prefers_normalized_message_then_payload_then_raw_message():
    assert _source_text(
        {"normalized_message": "normalized", "raw_payload": {"full_text": "payload"}},
        {1: "raw"},
    ) == "normalized"
    assert _source_text(
        {"normalized_message": None, "raw_payload": {"full_text": "payload"}, "raw_message_id": 1},
        {1: "raw"},
    ) == "payload"
    assert _source_text(
        {"normalized_message": None, "raw_payload": {}, "raw_message_id": 1},
        {1: "raw"},
    ) == "raw"
