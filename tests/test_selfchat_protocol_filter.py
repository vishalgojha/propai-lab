"""Chat reads (get_chats / get_chat_messages) must hide protocol-resend artifacts.

WhatsApp peer-data placeholder resends are stored with the *requesting*
device's own JID and an empty message body; the platform already quarantines
them from extraction. They must not surface as self-chat "messages" either:
they are not the account's messages, and rendering them as
"[Media or unsupported message]" makes real history look broken.
"""

import json
from types import SimpleNamespace

from storage.supabase import SupabaseStorage


class _Chain:
    def __init__(self, rows):
        self._rows = rows

    def select(self, *_args, **_kwargs):
        return self

    def order(self, *_args, **_kwargs):
        return self

    def limit(self, *_args, **_kwargs):
        return self

    def eq(self, *_args, **_kwargs):
        return self

    def like(self, *_args, **_kwargs):
        return self

    def neq(self, *_args, **_kwargs):
        return self

    def execute(self):
        return SimpleNamespace(data=self._rows)


class _FakeClient:
    def __init__(self, rows):
        self.rows = rows

    def table(self, name):
        return _Chain(self.rows if name == "raw_messages" else [])


def _stored_payload(message: dict) -> str:
    # raw_payload mirrors the stored whatsapp webhook body (JSON string).
    return json.dumps({"event": "MESSAGES_UPSERT", "data": {"message": message}})


def _build_rows():
    return [
        # Protocol-resend artifact misattributed to the device's own JID.
        {
            "id": 701,
            "group_name": "",
            "sender": "User",
            "sender_jid": "919820056180@s.whatsapp.net",
            "sender_phone": "919820056180",
            "timestamp": "2026-08-22T01:52:00Z",
            "created_at": "2026-08-22T01:52:00Z",
            "message_uid": "phone-1:919820056180@s.whatsapp.net:ABC",
            "message": "",
            "message_type": "unknown",
            "raw_payload": _stored_payload({"protocolMessage": {"type": 17}}),
        },
        # Genuine self-chat text.
        {
            "id": 702,
            "group_name": "",
            "sender": "User",
            "sender_jid": "919820056180@s.whatsapp.net",
            "sender_phone": "919820056180",
            "timestamp": "2026-08-25T10:00:00Z",
            "created_at": "2026-08-25T10:00:00Z",
            "message_uid": "phone-1:919820056180@s.whatsapp.net:DEF",
            "message": "Reminder: call the Andheri broker",
            "message_type": "text",
            "raw_payload": _stored_payload({"conversation": "Reminder: call the Andheri broker"}),
        },
        # Empty non-protocol row (older media capture) must stay visible.
        {
            "id": 703,
            "group_name": "",
            "sender": "User",
            "sender_jid": "919820056180@s.whatsapp.net",
            "sender_phone": "919820056180",
            "timestamp": "2026-08-24T09:30:00Z",
            "created_at": "2026-08-24T09:30:00Z",
            "message_uid": "phone-1:919820056180@s.whatsapp.net:GHI",
            "message": "",
            "message_type": "image",
            "raw_payload": _stored_payload({"imageMessage": {"mimetype": "image/jpeg"}}),
        },
    ]


def _storage_with(rows, monkeypatch):
    import storage.supabase as module

    monkeypatch.setattr(module, "create_client", lambda url, key: _FakeClient(rows))
    return SupabaseStorage(url="https://example.supabase.co", key="service-key")


def test_get_chat_messages_hides_protocol_rows(monkeypatch):
    storage = _storage_with(_build_rows(), monkeypatch)

    messages = storage.get_chat_messages("919820056180", limit=500, offset=0)

    ids = [m.id for m in messages]
    assert 701 not in ids
    assert 702 in ids
    assert 703 in ids
    bodies = {m.id: m.message for m in messages}
    assert bodies[702] == "Reminder: call the Andheri broker"


def test_get_chats_excludes_protocol_rows_from_counts(monkeypatch):
    storage = _storage_with(_build_rows(), monkeypatch)

    chats = storage.get_chats(limit=500, offset=0, tenant_id="tenant-1")

    assert len(chats) == 1
    # Protocol artifact must not inflate the thread's message count.
    assert chats[0]["message_count"] == 2
    # Latest real message drives the preview.
    assert chats[0]["message"] == "Reminder: call the Andheri broker"


def test_text_row_with_protocol_payload_key_is_kept(monkeypatch):
    # Real listing text is always eligible even if transport metadata is present.
    rows = [
        {
            "id": 801,
            "group_name": "",
            "sender": "Broker",
            "sender_jid": "919820056180@s.whatsapp.net",
            "sender_phone": "919820056180",
            "timestamp": "2026-08-26T10:00:00Z",
            "created_at": "2026-08-26T10:00:00Z",
            "message_uid": "phone-1:919820056180@s.whatsapp.net:JKL",
            "message": "2 BHK for rent in Bandra West, carpet 900 sqft",
            "message_type": "unknown",
            "raw_payload": _stored_payload({"messageContextInfo": {}, "protocolMessage": {"type": 17}}),
        },
    ]
    storage = _storage_with(rows, monkeypatch)

    messages = storage.get_chat_messages("919820056180", limit=500, offset=0)
    assert [m.id for m in messages] == [801]