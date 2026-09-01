"""Direct extraction calls must skip empty input before parser/model work."""

from extraction import process_raw_message


class _Storage:
    def __init__(self):
        self.skips = []

    def mark_raw_pre_llm_skip(self, raw_id, reason):
        self.skips.append((raw_id, reason))


def test_direct_empty_call_is_skipped_before_pipeline():
    storage = _Storage()
    context = {
        "tenant_id": "tenant-1",
        "msg_text": "\n  ",
        "message_type": "text",
        "raw_payload": {},
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

    result = process_raw_message(804, context, storage=storage)

    assert storage.skips == [(804, "empty")]
    assert result["storage_status"] == "skipped"
    assert result["extraction_source"] == "pre_llm:empty"
