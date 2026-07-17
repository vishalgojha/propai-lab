from types import SimpleNamespace

import app
import extraction
import lab.config
import multi_listing


class _Storage:
    def __init__(self):
        self.tenant_id = None
        self._tenant_id = None
        self.saved = []
        self.resolver = []
        self.listing_ids = []
        self.processed = []

    def get_organization(self, _org_id):
        return None

    def create_knowledge_record(self, _payload):
        return None

    def save_parsed(self, observation):
        self.saved.append(observation)
        return 41

    def save_resolver_decision(self, decision):
        self.resolver.append(decision)

    def upsert_listing_from_parsed(self, parsed_id):
        self.listing_ids.append(parsed_id)

    def mark_raw_processed(self, raw_id):
        self.processed.append(raw_id)


def test_single_message_worker_uses_property_parser(monkeypatch):
    storage = _Storage()
    parsed = {
        "intent": "SELL",
        "bhk": "3 BHK",
        "price": 5.0,
        "price_unit": "Cr",
        "location_raw": "Bandra West",
        "micro_market": "Bandra West",
        "confidence": 0.9,
        "raw_payload": {"full_text": "3 BHK for sale in Bandra West at 5 Cr"},
    }

    monkeypatch.setattr(lab.config, "load_excluded_groups", lambda: set())
    monkeypatch.setattr(multi_listing, "classify_message", lambda _text: "single")
    monkeypatch.setattr(app, "parse_message", lambda _text: dict(parsed))
    monkeypatch.setattr(app, "classify_conversation", lambda *_args: "public")
    monkeypatch.setattr(app, "compute_embedding", lambda _parsed: None)
    monkeypatch.setattr(app, "resolve_parsed", lambda *_args: {})
    monkeypatch.setattr(app, "_parsed_source_text", lambda item, fallback: item["raw_payload"]["full_text"])
    monkeypatch.setattr(app, "_demote_weak_property_parse", lambda item, _text: item)
    monkeypatch.setattr(app, "_parsed_has_market_anchor", lambda *_args: True)
    monkeypatch.setattr(app, "_attribution_suffix", lambda *_args: "")
    monkeypatch.setattr(app, "check_share_eligibility", lambda *_args: (True, "ok"))
    monkeypatch.setattr(app, "generate_summary_title", lambda *_args: "3 BHK in Bandra West")
    monkeypatch.setattr(app, "_process_observations", lambda *_args: None)
    monkeypatch.setattr(extraction, "get_bus", lambda: SimpleNamespace(publish=lambda *_args: None))

    extraction.process_raw_message(
        7,
        {
            "sender_name": "Broker",
            "push_name": "Broker",
            "sender_jid": "919999999999@s.whatsapp.net",
            "sender_phone": "919999999999",
            "group": "group@g.us",
            "group_name": "Bandra Brokers",
            "msg_text": "3 BHK for sale in Bandra West at 5 Cr",
            "instance": "test",
            "is_dm": False,
            "message_uid": "test-7",
            "message_id": "7",
            "msg": {},
        },
        storage=storage,
    )

    assert len(storage.saved) == 1
    assert storage.saved[0].intent == "SELL"
    assert storage.saved[0].micro_market == "Bandra West"
    assert storage.listing_ids == [41]
    assert storage.processed == [7]
