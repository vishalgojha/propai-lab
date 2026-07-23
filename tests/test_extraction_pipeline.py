import json
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
    monkeypatch.setattr(app, "parse_message", lambda _text, profile_name=None: dict(parsed))
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
    assert storage.saved[0].broker_phone == "9999999999"
    assert storage.saved[0].broker_name == "+91 9999999999"
    assert storage.listing_ids == [41]
    assert storage.processed == [7]


def test_multi_listing_post_uses_one_ai_result_per_option(monkeypatch):
    """A multi-option post must persist each validated AI extraction."""
    import ai_extraction
    import lab.multi_listing as extraction_multi_listing

    storage = _Storage()
    ai_items = [
        {
            "listing_type": "rent", "property_category": "residential", "bhk": 2,
            "carpet_area_sqft": 700, "price": {"amount": 100000, "unit": "total", "period": "per_month"},
            "locality": {"raw_mention": "Turner Road", "resolved_locality": "Bandra West", "confidence": "high"},
            "furnishing_status": "fully_furnished", "title": "Option 1", "extraction_confidence": "high",
        },
        {
            "listing_type": "rent", "property_category": "residential", "bhk": 2,
            "carpet_area_sqft": 800, "price": {"amount": 160000, "unit": "total", "period": "per_month"},
            "locality": {"raw_mention": "Waterfield Road", "resolved_locality": "Bandra West", "confidence": "high"},
            "furnishing_status": "fully_furnished", "title": "Option 2", "extraction_confidence": "high",
        },
    ]

    monkeypatch.setattr(lab.config, "load_excluded_groups", lambda: set())
    monkeypatch.setattr(extraction_multi_listing, "classify_message", lambda _text: "multi")
    monkeypatch.setattr(extraction_multi_listing, "parse_multi_message", lambda *_args, **_kwargs: [
        {"raw_payload": {"full_text": "Option 1"}},
        {"raw_payload": {"full_text": "Option 2"}},
    ])
    monkeypatch.setattr(ai_extraction, "ai_extract", lambda *_args, **_kwargs: {
        "extraction_source": "ai",
        "extraction": ai_items[0],
        "extractions": ai_items,
        "provider_used": "fake",
    })
    monkeypatch.setattr(app, "classify_conversation", lambda *_args: "public")
    monkeypatch.setattr(app, "compute_embedding", lambda _parsed: None)
    monkeypatch.setattr(app, "resolve_parsed", lambda *_args: {})
    monkeypatch.setattr(app, "_parsed_source_text", lambda item, fallback: item["raw_payload"]["full_text"] or fallback)
    monkeypatch.setattr(app, "_demote_weak_property_parse", lambda item, _text: item)
    monkeypatch.setattr(app, "_parsed_has_market_anchor", lambda *_args: True)
    monkeypatch.setattr(app, "_attribution_suffix", lambda *_args: "")
    monkeypatch.setattr(app, "check_share_eligibility", lambda *_args: (True, "ok"))
    monkeypatch.setattr(app, "generate_summary_title", lambda parsed, *_args: parsed["raw_payload"]["full_text"])
    monkeypatch.setattr(app, "_process_observations", lambda *_args: None)
    monkeypatch.setattr(extraction, "get_bus", lambda: SimpleNamespace(publish=lambda *_args: None))

    extraction.process_raw_message(
        8,
        {
            "sender_name": "Broker", "push_name": "Broker", "sender_jid": "919999999999@s.whatsapp.net",
            "sender_phone": "919999999999", "group": "group@g.us", "group_name": "Bandra Brokers",
            "msg_text": "Option 1\nOption 2", "instance": "test", "is_dm": False,
            "message_uid": "test-8", "message_id": "8", "msg": {},
        },
        storage=storage,
    )

    assert [row.listing_index for row in storage.saved] == [0, 1]
    assert [row.price for row in storage.saved] == [100000.0, 160000.0]
    assert [row.summary_title for row in storage.saved] == ["Option 1", "Option 2"]
    assert [json.loads(row.raw_payload)["full_text"] for row in storage.saved] == [
        "Option 1",
        "Option 2",
    ]


def test_reviewed_reparse_preview_is_read_only_and_apply_reuses_exact_cards(monkeypatch):
    """Preview must not write or call AI; apply must save that exact generation."""
    import ai_extraction
    import lab.multi_listing as extraction_multi_listing

    storage = _Storage()
    reviewed = [
        {
            "intent": "RENT",
            "bhk": "3 BHK",
            "building_name": "Ten BKC",
            "floor": "24th",
            "area_sqft": 1360,
            "price": 300000,
            "price_unit": "total",
            "micro_market": "BKC",
            "raw_payload": {"full_text": "Ten BKC Tower 7, 24th floor"},
        },
        {
            "intent": "RENT",
            "bhk": "3 BHK",
            "building_name": "Ten BKC",
            "floor": "17th",
            "area_sqft": 1360,
            "price": 300000,
            "price_unit": "total",
            "micro_market": "BKC",
            "raw_payload": {"full_text": "Ten BKC Tower 7, 17th floor"},
        },
    ]

    def fail_if_ai_runs(*_args, **_kwargs):
        raise AssertionError("reviewed reparse must not call an AI provider again")

    monkeypatch.setattr(lab.config, "load_excluded_groups", lambda: set())
    monkeypatch.setattr(extraction_multi_listing, "classify_message", lambda _text: "multi")
    monkeypatch.setattr(
        extraction_multi_listing,
        "parse_multi_message",
        lambda *_args, **_kwargs: [dict(item) for item in reviewed],
    )
    monkeypatch.setattr(ai_extraction, "ai_extract", fail_if_ai_runs)
    monkeypatch.setattr(app, "classify_conversation", lambda *_args: "public")
    monkeypatch.setattr(app, "compute_embedding", lambda _parsed: None)
    monkeypatch.setattr(app, "resolve_parsed", lambda *_args: {})
    monkeypatch.setattr(app, "_parsed_source_text", lambda item, fallback: item["raw_payload"]["full_text"] or fallback)
    monkeypatch.setattr(app, "_demote_weak_property_parse", lambda item, _text: item)
    monkeypatch.setattr(app, "_parsed_has_market_anchor", lambda *_args: True)
    monkeypatch.setattr(app, "_attribution_suffix", lambda *_args: "")
    monkeypatch.setattr(app, "check_share_eligibility", lambda *_args: (True, "ok"))
    monkeypatch.setattr(app, "generate_summary_title", lambda parsed, *_args: parsed["raw_payload"]["full_text"])
    monkeypatch.setattr(app, "_process_observations", lambda *_args: None)
    monkeypatch.setattr(extraction, "get_bus", lambda: SimpleNamespace(publish=lambda *_args: None))

    base_context = {
        "sender_name": "Kapil Ojha",
        "push_name": "Kapil Ojha",
        "sender_jid": "919773757759@s.whatsapp.net",
        "sender_phone": "919773757759",
        "group": "group@g.us",
        "group_name": "Bandra Brokers",
        "msg_text": "Ten BKC Tower 7, 24th floor and 17th floor, 1360 carpet, 3 lakh",
        "instance": "test",
        "is_dm": False,
        "message_uid": "test-reviewed-reparse",
        "message_id": "reviewed-reparse",
        "msg": {},
        "skip_knowledge_record": True,
        "preparsed_listings": reviewed,
    }

    preview = extraction.process_raw_message(
        9,
        {**base_context, "preview_only": True},
        storage=storage,
    )

    assert preview["proposed_count"] == 2
    assert [item["floor"] for item in preview["parsed_listings"]] == ["24th", "17th"]
    assert storage.saved == []
    assert storage.listing_ids == []
    assert storage.processed == []

    result = extraction.process_raw_message(9, dict(base_context), storage=storage)

    assert len(result["parsed_ids"]) == 2
    assert [row.floor_range for row in storage.saved] == ["24th", "17th"]
    assert [json.loads(row.raw_payload)["full_text"] for row in storage.saved] == [
        "Ten BKC Tower 7, 24th floor",
        "Ten BKC Tower 7, 17th floor",
    ]


def test_merged_multi_listing_ai_result_is_retried_per_property_block(monkeypatch):
    """A model's mixed one-item result must never become one mixed inbox card."""
    import ai_extraction
    import lab.multi_listing as extraction_multi_listing

    storage = _Storage()
    message = """A Fantastic 2BHK available for sale, 700 sqft, society has a direct beach access,
Location:-Greenfields, Juhu
Quote 4.40cr negotiable
WestBay 3BHK available for sale 950 usable 908 on the agreement,
Bandra West, Quote 4.75 cr Negotiable
Vibrant Properties
Aaron 8655245101"""

    blocks = [
        """A Fantastic 2BHK available for sale, 700 sqft, society has a direct beach access,
Location:-Greenfields, Juhu
Quote 4.40cr negotiable""",
        """WestBay 3BHK available for sale 950 usable 908 on the agreement,
Bandra West, Quote 4.75 cr Negotiable
Vibrant Properties
Aaron 8655245101""",
    ]
    boundary_rows = [
        {"raw_payload": {"full_text": blocks[0]}},
        {"raw_payload": {"full_text": blocks[1]}},
    ]
    mixed_item = {
        "listing_type": "sale", "property_category": "residential", "bhk": 3,
        "carpet_area_sqft": 700, "price": {"amount": 47500000, "unit": "total"},
        "locality": {"raw_mention": "Juhu / Bandra West", "resolved_locality": "Bandra West", "confidence": "low"},
        "title": "Mixed 2 BHK and 3 BHK sale options", "extraction_confidence": "low",
    }
    block_items = {
        blocks[0]: {
            "listing_type": "sale", "property_category": "residential", "bhk": 2,
            "carpet_area_sqft": 700, "price": {"amount": 44000000, "unit": "total"},
            "locality": {"raw_mention": "Greenfields, Juhu", "resolved_locality": "Juhu", "confidence": "high"},
            "building_name": "Greenfields", "title": "2 BHK for sale at Greenfields, Juhu",
            "extraction_confidence": "high",
        },
        blocks[1]: {
            "listing_type": "sale", "property_category": "residential", "bhk": 3,
            "carpet_area_sqft": 950, "price": {"amount": 47500000, "unit": "total"},
            "locality": {"raw_mention": "Bandra West", "resolved_locality": "Bandra West", "confidence": "high"},
            "building_name": "WestBay", "title": "3 BHK for sale at WestBay, Bandra West",
            "extraction_confidence": "high",
        },
    }

    def fake_ai_extract(text, *_args, **_kwargs):
        item = mixed_item if text == message else block_items[text]
        return {
            "extraction_source": "ai",
            "extraction": item,
            "extractions": [item],
            "provider_used": "fake",
        }

    monkeypatch.setattr(lab.config, "load_excluded_groups", lambda: set())
    monkeypatch.setattr(extraction_multi_listing, "classify_message", lambda _text: "multi")
    monkeypatch.setattr(extraction_multi_listing, "parse_multi_message", lambda *_args, **_kwargs: boundary_rows)
    monkeypatch.setattr(ai_extraction, "ai_extract", fake_ai_extract)
    monkeypatch.setattr(app, "classify_conversation", lambda *_args: "public")
    monkeypatch.setattr(app, "compute_embedding", lambda _parsed: None)
    monkeypatch.setattr(app, "resolve_parsed", lambda *_args: {})
    monkeypatch.setattr(app, "_parsed_source_text", lambda item, fallback: item["raw_payload"]["full_text"] or fallback)
    monkeypatch.setattr(app, "_attribution_suffix", lambda *_args: "")
    monkeypatch.setattr(app, "check_share_eligibility", lambda *_args: (True, "ok"))
    monkeypatch.setattr(app, "_process_observations", lambda *_args: None)
    monkeypatch.setattr(extraction, "get_bus", lambda: SimpleNamespace(publish=lambda *_args: None))

    extraction.process_raw_message(
        210374,
        {
            "sender_name": "Dev Properties Consultant", "push_name": "Dev Properties Consultant",
            "sender_jid": "918655245101@s.whatsapp.net", "sender_phone": "918655245101",
            "group": "group@g.us", "group_name": "Bandra Broker Group",
            "msg_text": message, "instance": "test", "is_dm": False,
            "message_uid": "test-210374", "message_id": "210374", "msg": {},
        },
        storage=storage,
    )

    assert len(storage.saved) == 2
    assert [row.listing_index for row in storage.saved] == [0, 1]
    assert [row.bhk for row in storage.saved] == ["2 BHK", "3 BHK"]
    assert [row.price for row in storage.saved] == [44000000.0, 47500000.0]
    assert [row.building_name for row in storage.saved] == ["Greenfields", "WestBay"]
    evidence = [json.loads(row.raw_payload)["full_text"] for row in storage.saved]
    assert "WestBay" not in evidence[0]
    assert "Greenfields" not in evidence[1]


def _run_broker_attribution(monkeypatch, sender_phone: str) -> dict:
    """Helper: process a message and return broker_name/broker_phone on the saved row."""
    storage = _Storage()
    parsed = {
        "intent": "RENT",
        "bhk": "2 BHK",
        "price": 1.5,
        "price_unit": "Lac",
        "location_raw": "Bandra West",
        "micro_market": "Bandra West",
        "confidence": 0.85,
        "raw_payload": {"full_text": "2 BHK for rent in Bandra West"},
    }
    monkeypatch.setattr(lab.config, "load_excluded_groups", lambda: set())
    monkeypatch.setattr(multi_listing, "classify_message", lambda _text: "single")
    monkeypatch.setattr(app, "parse_message", lambda _text, profile_name=None: dict(parsed))
    monkeypatch.setattr(app, "classify_conversation", lambda *_args: "public")
    monkeypatch.setattr(app, "compute_embedding", lambda _parsed: None)
    monkeypatch.setattr(app, "resolve_parsed", lambda *_args: {})
    monkeypatch.setattr(app, "_parsed_source_text", lambda item, fallback: item["raw_payload"]["full_text"])
    monkeypatch.setattr(app, "_demote_weak_property_parse", lambda item, _text: item)
    monkeypatch.setattr(app, "_parsed_has_market_anchor", lambda *_args: True)
    monkeypatch.setattr(app, "_attribution_suffix", lambda *_args: "")
    monkeypatch.setattr(app, "check_share_eligibility", lambda *_args: (True, "ok"))
    monkeypatch.setattr(app, "generate_summary_title", lambda *_args: "2 BHK in Bandra West")
    monkeypatch.setattr(app, "_process_observations", lambda *_args: None)
    monkeypatch.setattr(extraction, "get_bus", lambda: SimpleNamespace(publish=lambda *_args: None))

    extraction.process_raw_message(
        100,
        {
            "sender_name": "Broker",
            "push_name": "Broker",
            "sender_jid": f"{sender_phone}@s.whatsapp.net" if sender_phone else "unknown@lid",
            "sender_phone": sender_phone,
            "group": "group@g.us",
            "group_name": "Test Group",
            "msg_text": "2 BHK for rent in Bandra West",
            "instance": "test",
            "is_dm": False,
            "message_uid": f"test-{sender_phone or 'empty'}",
            "message_id": "100",
            "msg": {},
        },
        storage=storage,
    )
    if storage.saved:
        return {"broker_name": storage.saved[0].broker_name, "broker_phone": storage.saved[0].broker_phone}
    return {"broker_name": None, "broker_phone": None}


def test_broker_attribution_phone_10_digits(monkeypatch):
    """sender_phone >= 10 digits → both name and phone backfilled."""
    result = _run_broker_attribution(monkeypatch, "919999999999")
    assert result["broker_name"] == "+91 9999999999", f"got {result['broker_name']!r}"
    assert result["broker_phone"] == "9999999999", f"got {result['broker_phone']!r}"


def test_broker_attribution_phone_short(monkeypatch):
    """sender_phone < 10 digits → name backfilled, phone stays None (not a dialable mobile)."""
    result = _run_broker_attribution(monkeypatch, "12345")
    assert result["broker_name"] == "+12345", f"got {result['broker_name']!r}"
    assert result["broker_phone"] is None, f"got {result['broker_phone']!r}"


def test_broker_attribution_lid(monkeypatch):
    """sender_phone is a 15-digit LID → name backfilled as label, phone stays None (not a real mobile)."""
    result = _run_broker_attribution(monkeypatch, "127723838156807")
    assert result["broker_name"] == "+127723838156807", f"got {result['broker_name']!r}"
    assert result["broker_phone"] is None, f"got {result['broker_phone']!r}"


def test_broker_attribution_phone_empty(monkeypatch):
    """sender_phone empty string → both remain None (no fallback data)."""
    result = _run_broker_attribution(monkeypatch, "")
    assert result["broker_name"] is None, f"got {result['broker_name']!r}"
    assert result["broker_phone"] is None, f"got {result['broker_phone']!r}"


# ── Deal tags + additional charges ────────────────────────────────────

import ai_extraction


def _run_with_ai_extraction(monkeypatch, ai_extraction_payload: dict) -> _Storage:
    """Helper: process a single message whose `ai_extract()` returns the given
    payload. Mocks the AI extraction entrypoint so `ai_extraction_raw` is
    populated (the regex-fallback path leaves it None and would short-circuit
    deal_tags + additional_charges)."""
    storage = _Storage()
    ai_result = {
        "extraction_source": "ai",
        "extraction": dict(ai_extraction_payload),
        "provider_used": "fake",
    }
    # `_ai_extraction_to_parsed` reads `ai_result["extraction"]` and maps it to
    # the legacy `parsed` dict shape. That mapped `parsed` is what ends up in
    # the ParsedObservation fields that the existing tests assert against.
    monkeypatch.setattr(ai_extraction, "ai_extract", lambda *_args, **_kwargs: ai_result)
    monkeypatch.setattr(lab.config, "load_excluded_groups", lambda: set())
    monkeypatch.setattr(multi_listing, "classify_message", lambda _text: "single")
    monkeypatch.setattr(app, "classify_conversation", lambda *_args: "public")
    monkeypatch.setattr(app, "compute_embedding", lambda _parsed: None)
    monkeypatch.setattr(app, "resolve_parsed", lambda *_args: {})
    monkeypatch.setattr(app, "_parsed_source_text", lambda item, fallback: item.get("raw_payload", {}).get("full_text") or fallback)
    monkeypatch.setattr(app, "_demote_weak_property_parse", lambda item, _text: item)
    monkeypatch.setattr(app, "_parsed_has_market_anchor", lambda *_args: True)
    monkeypatch.setattr(app, "_attribution_suffix", lambda *_args: "")
    monkeypatch.setattr(app, "check_share_eligibility", lambda *_args: (True, "ok"))
    monkeypatch.setattr(app, "generate_summary_title", lambda *_args: "Elite Auction — Rajgriha CHS")
    monkeypatch.setattr(app, "_process_observations", lambda *_args: None)
    monkeypatch.setattr(extraction, "get_bus", lambda: SimpleNamespace(publish=lambda *_args: None))

    extraction.process_raw_message(
        200,
        {
            "sender_name": "Elite Auction House",
            "push_name": "Elite Auction House",
            "sender_jid": "919999999999@s.whatsapp.net",
            "sender_phone": "919999999999",
            "group": "group@g.us",
            "group_name": "Mumbai Auctions",
            "msg_text": "Bank auction 3 BHK Rajgriha CHS Andheri West 1.55 Cr plus society dues 10L and 3% professional fees",
            "instance": "test",
            "is_dm": False,
            "message_uid": "test-200",
            "message_id": "200",
            "msg": {},
        },
        storage=storage,
    )
    return storage


def test_elite_auction_distress_with_charges(monkeypatch):
    """Elite Auction case: bank-auction tag captured, charges broken out as
    separate fields, headline price stays at the broker's quoted 1.55Cr
    (NOT inflated by society dues). This is the regression that motivated
    adding deal_tags + additional_charges to the extraction schema."""
    ai_payload = {
        "listing_type": "sale",
        "property_category": "residential",
        "bhk": 3,
        "carpet_area_sqft": 1200,
        "price": {
            "amount": 15500000,
            "unit": "total",
            "period": "one_time",
            "raw_price_text": "1.55 Cr",
        },
        "locality": {
            "raw_mention": "Andheri West",
            "resolved_locality": "Andheri West",
            "confidence": "high",
        },
        "building_name": "Rajgriha CHS",
        "furnishing_status": "semi_furnished",
        "possession_status": "ready",
        "title": "3 BHK Rajgriha CHS Andheri West",
        "extraction_confidence": "high",
        "deal_tags": ["bank_auction", "distress_sale"],
        "additional_charges": [
            {"label": "Society dues", "amount": 1000000, "amount_type": "fixed"},
            {"label": "Professional fees", "amount": 3, "amount_type": "percent_of_price"},
        ],
    }
    storage = _run_with_ai_extraction(monkeypatch, ai_payload)

    assert len(storage.saved) == 1
    obs = storage.saved[0]
    # Headline price is what the broker quoted (1.55Cr → 15500000 rupees)
    # — NOT inflated by the additional charges. The listing materializer
    # later converts to lakhs/crores for display.
    assert obs.price == 15500000.0, f"price.amount got inflated by charges: {obs.price}"
    assert obs.price_unit == "cr"
    assert obs.micro_market == "Andheri West"
    assert obs.building_name == "Rajgriha CHS"
    # Tags captured.
    assert "bank_auction" in obs.deal_tags
    assert "distress_sale" in obs.deal_tags
    # Charges captured, both entries preserved with their shapes intact.
    assert len(obs.additional_charges) == 2
    by_label = {c["label"]: c for c in obs.additional_charges}
    assert by_label["Society dues"]["amount"] == 1000000.0
    assert by_label["Society dues"]["amount_type"] == "fixed"
    assert by_label["Professional fees"]["amount"] == 3.0
    assert by_label["Professional fees"]["amount_type"] == "percent_of_price"


def test_deal_tags_whitelist_drops_unknown(monkeypatch):
    """Unknown deal_tag values are dropped silently — no crash, no leak.
    Note: `_normalize_extraction` runs before this list lands on the row, so
    we feed it raw LLM output that includes junk values and verify only the
    whitelisted ones survive."""
    ai_payload = {
        "listing_type": "sale",
        "property_category": "residential",
        "bhk": 2,
        "price": {"amount": 10000000, "unit": "total", "period": "one_time", "raw_price_text": "1 Cr"},
        "locality": {"raw_mention": "Bandra East", "resolved_locality": "Bandra East", "confidence": "high"},
        "building_name": "Sky Heights",
        "furnishing_status": "unfurnished",
        "deal_tags": [
            "negotiable",        # valid (whitelisted)
            "liquidation",       # NOT in whitelist
            "  ",                # empty string
            "URGENT_SALE",       # case-insensitive — valid after lowercase
            "distress sale",     # contains space — not in whitelist
        ],
        "additional_charges": [],
        "extraction_confidence": "high",
    }
    storage = _run_with_ai_extraction(monkeypatch, ai_payload)
    obs = storage.saved[0]
    assert sorted(obs.deal_tags) == ["negotiable", "urgent_sale"], (
        f"whitelist filter failed: {obs.deal_tags!r}"
    )


def test_additional_charges_drops_malformed(monkeypatch):
    """Malformed charge entries are dropped silently — a single bad row
    can't poison the rest of the charge list."""
    ai_payload = {
        "listing_type": "sale",
        "property_category": "residential",
        "bhk": 2,
        "price": {"amount": 12000000, "unit": "total", "period": "one_time", "raw_price_text": "1.2 Cr"},
        "locality": {"raw_mention": "Powai", "resolved_locality": "Powai", "confidence": "high"},
        "building_name": "Lake View",
        "furnishing_status": "unfurnished",
        "deal_tags": [],
        "additional_charges": [
            {"label": "Maintenance", "amount": 5000, "amount_type": "fixed"},  # valid
            {"label": "", "amount": 100, "amount_type": "fixed"},              # missing label
            {"label": "NoAmount", "amount_type": "fixed"},                     # missing amount
            {"label": "WeeklyFee", "amount": 1000, "amount_type": "weekly"},   # bad amount_type
            {"label": "NaNAmount", "amount": "not-a-number", "amount_type": "fixed"},  # non-numeric
            "not-a-dict",                                                       # non-dict entry (will be filtered by isinstance)
            None,                                                               # null entry
            {"label": "StampDuty", "amount": 5, "amount_type": "percent_of_price"},  # valid percent
        ],
        "extraction_confidence": "high",
    }
    storage = _run_with_ai_extraction(monkeypatch, ai_payload)
    obs = storage.saved[0]
    labels = [c["label"] for c in obs.additional_charges]
    assert labels == ["Maintenance", "StampDuty"], (
        f"malformed-charge filter failed: {labels!r}"
    )
    assert obs.additional_charges[0]["amount"] == 5000.0
    assert obs.additional_charges[1]["amount_type"] == "percent_of_price"


def test_normalize_extraction_junk_safe():
    """Direct unit test of the normalizer — feed it garbage and verify it
    returns a clean dict without raising."""
    raw = {
        "listing_type": "residential",
        "deal_tags": ["negotiable", "fake_tag", 42, None, "  "],
        "additional_charges": [
            {"label": "OK", "amount": 1000, "amount_type": "fixed"},
            {"label": "Bad", "amount": None, "amount_type": "fixed"},
            {"label": "Bad2", "amount": "abc", "amount_type": "fixed"},
            {"label": "Bad3", "amount": 100, "amount_type": "weekly"},
        ],
    }
    out = ai_extraction._normalize_extraction(raw)
    assert out["deal_tags"] == ["negotiable"], out["deal_tags"]
    assert len(out["additional_charges"]) == 1
    assert out["additional_charges"][0]["label"] == "OK"
    assert out["additional_charges"][0]["amount"] == 1000.0
