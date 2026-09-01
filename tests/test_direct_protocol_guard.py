"""Direct extraction calls must share the worker's protocol boundary."""

from extraction import process_raw_message


class _Storage:
    def __init__(self):
        self.protocol_rows = []

    def mark_raw_protocol_event(self, raw_id):
        self.protocol_rows.append(raw_id)


def _context(payload):
    return {
        "tenant_id": "tenant-1",
        "msg_text": "",
        "message_type": "unknown",
        "raw_payload": payload,
        "sender_name": "",
        "push_name": "",
        "sender_jid": "",
        "sender_phone": "",
        "group": "",
        "group_name": "",
        "instance": "",
        "is_dm": False,
        "message_uid": "uid-1",
        "message_id": "id-1",
        "msg": {},
    }


def test_direct_protocol_call_is_quarantined_before_pipeline(monkeypatch):
    storage = _Storage()
    monkeypatch.setattr("extraction.get_storage", lambda: storage)

    result = process_raw_message(
        801,
        _context({"data": {"message": {"protocolMessage": {}}}}),
        storage=storage,
    )

    assert storage.protocol_rows == [801]
    assert result["storage_status"] == "skipped"
    assert result["extraction_source"] == "protocol_event"
