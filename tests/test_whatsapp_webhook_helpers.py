from app import (
    _classify_webhook_event,
    _process_single_raw,
    _schedule_raw_extraction,
    _whatsapp_attachment_metadata,
    _whatsapp_message_text,
    _whatsapp_message_type,
)


def test_full_extraction_queue_defers_without_starting_work(monkeypatch):
    class FullQueue:
        def acquire(self, blocking=False):
            assert blocking is False
            return False

    monkeypatch.setattr("app._EXTRACTION_SLOTS", FullQueue())
    assert _schedule_raw_extraction(42, {"tenant_id": "workspace"}) is False


def test_extraction_worker_uses_an_isolated_storage_client(monkeypatch):
    calls = []

    def process(raw_id, ctx, storage=None):
        calls.append((raw_id, ctx, storage))

    monkeypatch.setattr("extraction.process_raw_message", process)
    _process_single_raw(42, {"tenant_id": "workspace"})
    assert calls == [(42, {"tenant_id": "workspace"}, None)]


def test_captionless_media_remains_a_message_event():
    payload = {
        "event": "MESSAGES_UPSERT",
        "data": {"message": {"imageMessage": {"mimetype": "image/jpeg"}}},
    }
    assert _classify_webhook_event("MESSAGES_UPSERT", payload) == "message"
    assert _whatsapp_message_text(payload["data"]["message"]) == "[Image]"
    assert _whatsapp_message_type(payload["data"]["message"]) == "image"


def test_media_storage_metadata_is_preserved():
    metadata = _whatsapp_attachment_metadata(
        {"documentMessage": {"mimetype": "application/pdf", "fileName": "brochure.pdf"}},
        {"storage_path": "broker/chat/message.pdf", "file_length": 1024},
    )
    assert metadata["document"] is True
    assert metadata["mime_type"] == "application/pdf"
    assert metadata["file_name"] == "brochure.pdf"
    assert metadata["storage_path"] == "broker/chat/message.pdf"
    assert metadata["file_length"] == 1024
