from app import (
    _classify_webhook_event,
    _whatsapp_attachment_metadata,
    _whatsapp_message_text,
    _whatsapp_message_type,
)


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
