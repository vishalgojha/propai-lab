"""Worker integration checks for WhatsApp transport-event quarantine."""

import extraction_worker


class _Storage:
    def __init__(self):
        self.protocol_rows = []
        self.skip_rows = []

    def mark_raw_protocol_event(self, raw_id):
        self.protocol_rows.append(raw_id)

    def mark_raw_pre_llm_skip(self, raw_id, reason):
        self.skip_rows.append((raw_id, reason))


def test_protocol_row_never_reaches_process_raw_message(monkeypatch):
    storage = _Storage()
    called = []

    monkeypatch.setattr(
        extraction_worker,
        "process_raw_message",
        lambda *args, **kwargs: called.append((args, kwargs)),
    )

    result = extraction_worker._process_lane(
        storage,
        [
            {
                "id": 701,
                "message": "",
                "message_type": "unknown",
                "raw_payload": {
                    "data": {
                        "message": {"senderKeyDistributionMessage": {}}
                    }
                },
            }
        ],
        lane="recent",
        slots=1,
        retry_counts={},
    )

    assert called == []
    assert storage.protocol_rows == [701]
    assert result["attempted"] == 0
    assert result["skipped"] == 1
    assert result["skip_reasons"] == {"protocol_event": 1}


def test_real_text_with_context_info_reaches_process_raw_message(monkeypatch):
    storage = _Storage()
    called = []

    monkeypatch.setattr(
        extraction_worker,
        "process_raw_message",
        lambda raw_id, _ctx, storage=None: called.append(raw_id),
    )

    extraction_worker._process_lane(
        storage,
        [
            {
                "id": 702,
                "message": "2 BHK for rent in Bandra West, carpet 900 sqft",
                "message_type": "unknown",
                "raw_payload": {"data": {"message": {"messageContextInfo": {}}}},
            }
        ],
        lane="recent",
        slots=1,
        retry_counts={},
    )

    assert called == [702]
    assert storage.protocol_rows == []


def test_blank_row_is_skipped_before_process_raw_message(monkeypatch):
    storage = _Storage()
    called = []

    monkeypatch.setattr(
        extraction_worker,
        "process_raw_message",
        lambda *args, **kwargs: called.append((args, kwargs)),
    )

    result = extraction_worker._process_lane(
        storage,
        [{"id": 703, "message": "   ", "message_type": "text", "raw_payload": {}}],
        lane="recent",
        slots=1,
        retry_counts={},
    )

    assert called == []
    assert storage.skip_rows == [(703, "empty")]
    assert result["attempted"] == 0
    assert result["skip_reasons"] == {"empty": 1}
