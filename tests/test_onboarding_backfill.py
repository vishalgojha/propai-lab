import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from routers import onboarding


def test_backfill_connected_group_processes_only_unparsed_matching_rows(monkeypatch):
    rows = [
        SimpleNamespace(
            id=1,
            group_name="Bandra Broker Group",
            raw_payload={"data": {"key": {"remoteJid": "12345@g.us"}}},
        ),
        SimpleNamespace(
            id=2,
            group_name="Bandra Broker Group",
            raw_payload={"data": {"key": {"remoteJid": "other@g.us"}}},
        ),
        SimpleNamespace(
            id=3,
            group_name="Bandra Broker Group",
            raw_payload={"data": {"key": {"remoteJid": "12345@g.us"}}},
        ),
    ]
    processed = []

    class FakeStorage:
        def __init__(self):
            self.tenant_id = None

        def get_raw_messages(self, limit=0, offset=0, group_name=""):
            if offset > 0:
                return []
            assert group_name == "Bandra Broker Group"
            return rows

        def get_parsed_by_raw(self, raw_id):
            return {"id": raw_id} if raw_id == 3 else None

    monkeypatch.setattr(onboarding, "storage", FakeStorage())
    monkeypatch.setattr(
        "extraction_worker.context_from_raw",
        lambda row: {
            "sender_name": "Broker",
            "push_name": "Broker",
            "sender_jid": "broker@s.whatsapp.net",
            "sender_phone": "9999999999",
            "group": "12345@g.us",
            "group_name": row.group_name,
            "instance": "test-instance",
            "is_dm": False,
            "message_uid": f"uid-{row.id}",
            "message_id": f"msg-{row.id}",
            "msg_text": "3 bhk lease inventory",
            "msg": {},
            "tenant_id": "org-1",
        },
    )
    monkeypatch.setattr(
        "extraction.process_raw_message",
        lambda raw_id, ctx, storage=None: processed.append((raw_id, ctx, storage)),
    )

    result = onboarding._backfill_connected_group("org-1", "12345@g.us", "Bandra Broker Group", 7)

    assert result["requested"] == 3
    assert result["matched"] == 2
    assert result["processed"] == 1
    assert result["skipped"] == 1
    assert result["failed"] == 0
    assert len(processed) == 1
    assert processed[0][0] == 1
    assert processed[0][1]["tenant_id"] == "org-1"
    assert processed[0][2] is onboarding.storage
