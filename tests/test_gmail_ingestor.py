import importlib.util
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "services" / "gmail-ingestor" / "main.py"
SPEC = importlib.util.spec_from_file_location("gmail_ingestor", MODULE_PATH)
gmail_ingestor = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(gmail_ingestor)


def test_email_payload_extracts_plain_text_and_headers():
    import base64

    encoded = base64.urlsafe_b64encode(b"2 BHK for rent in Bandra West").decode()
    payload = {
        "id": "gmail-123",
        "threadId": "thread-1",
        "payload": {
            "mimeType": "text/plain",
            "body": {"data": encoded},
            "headers": [
                {"name": "Subject", "value": "New property"},
                {"name": "From", "value": "broker@example.com"},
                {"name": "To", "value": "inbox@example.com"},
            ],
        },
    }

    result = gmail_ingestor._email_payload(payload, "PropAI/Incoming")

    assert result["message_id"] == "gmail-123"
    assert result["subject"] == "New property"
    assert result["body"] == "2 BHK for rent in Bandra West"
    assert result["label"] == "PropAI/Incoming"


def test_email_payload_falls_back_to_html_text():
    import base64

    encoded = base64.urlsafe_b64encode(b"<p>Office near <b>BKC</b></p>").decode()
    result = gmail_ingestor._email_payload(
        {"id": "gmail-456", "payload": {"mimeType": "text/html", "body": {"data": encoded}}},
        "PropAI/Incoming",
    )

    assert result["body"] == "Office near BKC"
