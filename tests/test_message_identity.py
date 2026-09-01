"""Tests for pre-extraction WhatsApp event filtering and copy identity."""

from message_identity import author_content_fingerprint, is_protocol_event


def test_blank_sender_key_payload_is_a_protocol_event():
    assert is_protocol_event(
        message="",
        message_type="unknown",
        raw_payload={"data": {"message": {"senderKeyDistributionMessage": {}}}},
    )


def test_blank_protocol_payload_is_a_protocol_event():
    assert is_protocol_event(
        message="",
        raw_payload={"data": {"message": {"protocolMessage": {"type": 0}}}},
    )


def test_context_info_does_not_filter_real_text():
    assert not is_protocol_event(
        message="2 BHK for rent in Bandra West, carpet 900 sqft",
        raw_payload={"data": {"message": {"messageContextInfo": {}}}},
    )


def test_same_author_line_wrap_is_the_same_copy():
    first = author_content_fingerprint(
        sender_phone="919900001234",
        message="3 BHK for rent in Bandra West, carpet 900 sqft, rent ₹85,000",
    )
    second = author_content_fingerprint(
        sender_phone="919900001234",
        message="Forwarded:\n3 BHK  for rent in Bandra West,\ncarpet 900 sqft, rent ₹85,000",
    )
    assert first == second


def test_same_author_material_edit_is_not_the_same_copy():
    first = author_content_fingerprint(
        sender_phone="919900001234",
        message="3 BHK for rent in Bandra West, carpet 900 sqft, rent ₹85,000",
    )
    second = author_content_fingerprint(
        sender_phone="919900001234",
        message="3 BHK for rent in Bandra West, carpet 900 sqft, rent ₹90,000",
    )
    assert first != second
