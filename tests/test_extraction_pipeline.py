import json
import os
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import ai_extraction
import app
import extraction
import lab.config
from listing_validation import apply_validation, validate_listing


def test_broker_contact_does_not_leak_mobile_field_label():
    source = "Contact\nJitendra Pathak\nMumbai\nMobile: 70212 38093"

    assert extraction._clean_broker_name("Mobile") is None
    assert extraction._extract_broker_contact_from_text(source) == (
        "7021238093",
        "Jitendra Pathak",
    )


def test_single_property_brochure_is_not_split_into_fake_listings():
    source = """Property Overview
- Plot Area: Approx. 13,000 Sq. Ft.
- Building Carpet Area: Approx. 3,500 Sq. Ft.
Asking Price
₹15 Crore (Non-Negotiable)
"""

    assert ai_extraction._single_property_document(source)


def test_bare_plot_is_not_promoted_to_commercial_without_source_evidence():
    result = ai_extraction._source_ground_asset_category(
        {"property_category": "commercial"},
        "Plot Area: 13,000 sq ft, Vasai",
    )

    assert result["property_category"] == "residential"
    assert result["needs_review"] is True
    assert "asset_type_unresolved_for_plot" in result["validation_flags"]


def test_rental_income_cannot_be_saved_as_sale_price():
    parsed = {
        "price": 1_000_000,
        "price_unit": "abs",
        "price_raw_text": "Current Monthly Rental Income: ₹10,00,000",
        "area_sqft": 13_000,
        "intent": "SELL",
        "property_category": "PLOT",
        "total_asking_price": 1_000_000,
    }

    checked = apply_validation(parsed, validate_listing(parsed))

    assert checked["price"] is None
    assert checked["total_asking_price"] is None
    assert checked["needs_review"] is True
    assert "price_is_rental_income" in checked["validation_flags"]
    assert "price_per_sqft_implausibly_low" in checked["validation_flags"]


def test_price_normalization_uses_explicit_broker_unit_not_ai_scale():
    base = {
        "listing_type": "sale",
        "property_category": "residential",
        "bhk": 2,
        "locality": {"raw_mention": "Andheri West", "resolved_locality": "Andheri West"},
        "furnishing_status": None,
        "title": None,
        "extraction_confidence": "high",
    }

    for raw, ai_amount, expected, unit in [
        ("Asking: 1.15.Cr", 11500000, 11500000, "cr"),
        ("Price: 75.Lakh", 7500000, 7500000, "lac"),
        ("Quote: 2.80 Crore", 2800, 28000000, "cr"),
    ]:
        item = {**base, "price": {"amount": ai_amount, "unit": "total", "raw_price_text": raw}}
        parsed = extraction._ai_extraction_to_parsed(item, raw, "Broker", "Broker")
        assert parsed["price"] == expected
        # Typed storage keeps the price as absolute rupees; the native unit is
        # retained only as evidence in the raw price text.
        assert parsed["price_unit"] == "abs"


def test_pg_and_broadcast_headers_are_not_actionable_property_rows():
    assert not extraction._is_actionable_property_slice("_UPDATED 3BHK OUTRIGHT LIST_")
    assert not extraction._is_actionable_property_slice(
        "Girl PG\nLokhandwala\nSingle Rent 35k\nDouble Sharing"
    )


def test_single_k_rent_requirement_is_source_grounded_to_rent():
    item = {
        "listing_type": "requirement",
        "transaction_type": "sale",
        "property_category": "residential",
    }

    corrected = extraction._source_ground_requirement_item(
        item,
        "Urgent requirement furnished flat\nLocation Goregaon\nRent 35k",
    )

    assert corrected["transaction_type"] == "rent"
    assert corrected["budget_max"] == 35_000


def test_single_up_to_sale_budget_is_an_absolute_upper_bound():
    item = {
        "listing_type": "requirement",
        "transaction_type": "sale",
        "property_category": "residential",
        "budget_min": 6_000_000,
        "budget_max": 6_000_000_000,
    }

    corrected = extraction._source_ground_requirement_item(
        item,
        "Requirement: 2 / 2.5 / Compact 3 BHK for purchase in Bandra East\n"
        "Budget: Up to ₹6 Cr",
    )

    assert corrected["budget_min"] is None
    assert corrected["budget_max"] == 60_000_000


def test_explicit_requirement_heading_overrides_sale_like_description():
    item = {
        "listing_type": "sale",
        "property_category": "commercial",
        "title": "50+ room hotel on sale",
        "extraction_confidence": "high",
    }
    source = """VERY URGENT REQUIREMENT
50 + ROOM HOTEL ON SALE IN MUMBAI, NAVI MUMBAI AND GOA
BUDGET 100CR TO 200CR"""

    corrected = extraction._apply_requirement_source_guard([item], source, [source])

    assert corrected[0]["listing_type"] == "requirement"


@pytest.mark.parametrize(
    "source",
    [
        "URGENT REQUIRED 2 BHK IN BANDRA. PLEASE SHARE DIRECT LISTINGS",
        "Any 3 BHK available in Khar? Client ready to close",
        "koi 1 BHK hai kya Bandra mein, budget 1.5L",
        "Wanted 1 office on lease near BKC",
    ],
)
def test_requirement_guard_covers_request_shorthand_without_marketing_keywords(source):
    item = {
        "listing_type": "sale",
        "property_category": "residential",
        "title": None,
        "extraction_confidence": "high",
    }

    corrected = extraction._apply_requirement_source_guard([item], source, [source])

    assert corrected[0]["listing_type"] == "requirement"


@pytest.mark.parametrize(
    "source",
    [
        "Looking for the perfect office? Premium office available at ₹2L/month",
        "Join our channel for latest properties & requirements",
        "Client profile required before confirming viewing",
    ],
)
def test_requirement_guard_does_not_treat_listing_marketing_copy_as_demand(source):
    assert not extraction._has_explicit_requirement_heading(source)


def test_segment_document_reconstructs_blocks_and_classifies_multi_listing():
    message = """1. RUSTOMJEE PARAMOUNT
3 BHK
1350 carpet
10.5 Cr

2. RUSTOMJEE PARAMOUNT
4 BHK
1800 carpet
13 Cr"""

    document = ai_extraction._segment_document(message)

    assert document["document_type"] == "Multi Listing"
    assert document["block_count"] == 2
    assert document["blocks"][0]["text"].startswith("1. RUSTOMJEE PARAMOUNT")
    assert document["blocks"][1]["text"].startswith("2. RUSTOMJEE PARAMOUNT")


def test_segment_document_recognizes_inline_bold_listing_boundaries():
    message = """*Available Bandra West Brand new building*
*Crescent* 3bhk 1342 sqft pali hill price 12.12cr
*Parishram* 4bhk - 2046 sqft carpet hiegher floor sea view pali hill price 31.32cr
bandra west *New brand building* *Penthouse* 5188sqft carpet price 76.8cr bandra west
*Available for sale 2Bhk* Building Name: *Pioneer Heights* (khar West) Price 3.70cr"""

    document = ai_extraction._segment_document(message)

    assert document["document_type"] == "Multi Listing"
    assert document["block_count"] == 4
    assert [block["text"].splitlines()[0] for block in document["blocks"]] == [
        "*Crescent* 3bhk 1342 sqft pali hill price 12.12cr",
        "*Parishram* 4bhk - 2046 sqft carpet hiegher floor sea view pali hill price 31.32cr",
        "*Penthouse* 5188sqft carpet price 76.8cr bandra west",
        "*Available for sale 2Bhk* Building Name: *Pioneer Heights* (khar West) Price 3.70cr",
    ]


def test_price_formatter_does_not_render_crore_sale_as_monthly_rent():
    formatted = ai_extraction._format_price_amount(12_12_00_000, is_rent=True)

    assert "/month" not in formatted
    assert formatted == "₹12.1 Cr"


def test_search_price_formatter_does_not_emit_bare_month_suffix():
    from routers.common import _format_listing_price

    assert _format_listing_price({"price": 0, "price_unit": "abs", "intent": "RENT"}) == ""
    assert _format_listing_price({"price": 350, "price_unit": "per_sqft", "intent": "RENT"}) == "₹350/sqft"


def test_dash_separated_inventory_broadcast_stays_supply_and_drops_footer():
    message = """💢 GURUKIRPA REALTORS MUMBAI
DIRECT INVENTORIES
━━━━━━━━━━━━━━━━━━
COMMERCIAL SPACE
Area – 1200 Sq. Ft.
Rent – ₹5 Lakhs
Linking Road, Bandra West
━━━━━━━━━━━━━━━━━━
COMMERCIAL SPACE
Area – 2000 Sq. Ft.
Rent – ₹7 Lakhs
Santacruz West
━━━━━━━━━━━━━━━━━━
COMMERCIAL SPACE
Area – 3000 Sq. Ft.
Rent – ₹10 Lakhs
Worli
━━━━━━━━━━━━━━━━━━
CLIENT PROFILE REQUIRED PRIOR TO CONFIRMING VIEWINGS
GURUKIRPA REALTORS MUMBAI"""

    document = ai_extraction._segment_document(message)
    assert document["document_type"] == "Multi Listing"
    assert document["block_count"] == 3
    assert all("client profile required" not in block["text"].lower() for block in document["blocks"])
    assert ai_extraction.classify_message_type(message) == ("commercial", "rent")


def test_all_trailing_broker_names_are_not_building_candidates():
    from extraction import (
        _extract_broker_signature_names,
        _quarantine_broker_signature_building,
    )

    message = """2 BHK ON LEASE
MOHAN MAHAL | Off Linking Road, Khar
Rent: 75K

Wasim 9000000001
GURUKIRPA REALTORS MUMBAI
HARKIRAT SINGH
9000000002 | 9000000003"""

    signature_names = _extract_broker_signature_names(message)
    assert signature_names == {"wasim", "gurukirpa realtors mumbai", "harkirat singh"}

    parsed = {"building_name": "HARKIRAT SINGH", "validation_flags": []}
    ai_item = {"building_name": "HARKIRAT SINGH"}
    assert _quarantine_broker_signature_building(parsed, ai_item, signature_names)
    assert parsed["building_name"] is None
    assert parsed["needs_review"] is True
    assert "building_name_is_broker_signature" in parsed["validation_flags"]
    assert ai_item["building_name"] is None


def test_katara_bulk_broadcast_uses_one_line_per_listing_and_drops_footer_items():
    from extraction import (
        _extract_broker_signature_names,
        _is_actionable_property_slice,
        _slice_blocks_for_ai_items,
    )

    message = """Dear Associates

*Residential Outright*
*Cuffe Parade / Nariman Point / Colaba / Churchgate*- *New Listings added*

*NCPA* - Nariman Point 3 BHK - *2880 sq ft* - Fully Furnished - *40 Cr*
*Cuffe Parade - Premium Tower* - 4 BHK - *2600 sq ft* - *24.50 Cr*
*Waterfront towers* Near Colaba PO - 3000 sq ft - 31.50 Cr
*Ravindra Mansion* - Churchgate 3 BHK 1500 sq ft - Partly furnished

*Kindly allow 24 Hrs to set up visits - Client Business profile needed*
Katara Elite Estates
Prem Katara
MAHARERA Regd.
9867077740 / 8169085673"""
    items = [
        {"building_name": "NCPA", "bhk": 3, "carpet_area_sqft": 2880},
        {"building_name": "Cuffe Parade - Premium Tower", "bhk": 4, "carpet_area_sqft": 2600},
        {"building_name": "Waterfront towers", "carpet_area_sqft": 3000},
        {"building_name": "Ravindra Mansion", "bhk": 3, "carpet_area_sqft": 1500},
        {"building_name": "Katara Elite Estates"},
    ]

    slices = _slice_blocks_for_ai_items(message, items)

    assert slices[0].startswith("*NCPA*") and "Premium Tower" not in slices[0]
    assert slices[1].startswith("*Cuffe Parade - Premium Tower*") and "NCPA" not in slices[1]
    assert slices[2].startswith("*Waterfront towers*") and "Ravindra Mansion" not in slices[2]
    assert slices[3].startswith("*Ravindra Mansion*") and "Katara Elite" not in slices[3]
    assert not _is_actionable_property_slice(slices[4])
    assert _extract_broker_signature_names(message) == {"katara elite estates", "prem katara"}


def test_same_locality_requirements_use_distinct_configuration_evidence():
    from extraction import _slice_blocks_for_ai_items

    message = """1. Rent: 3 BHK, Fully Furnished | Bandra West | Budget: Up to ₹2.50L
2. Rent: 4 BHK, Fully Furnished | Bandra West | Budget: Up to ₹8L"""
    items = [
        {"bhk": 4, "locality_raw": "Bandra West", "listing_type": "requirement"},
        {"bhk": 3, "locality_raw": "Bandra West", "listing_type": "requirement"},
    ]

    slices = _slice_blocks_for_ai_items(message, items)

    assert "4 BHK" in slices[0] and "3 BHK" not in slices[0]
    assert "3 BHK" in slices[1] and "4 BHK" not in slices[1]


def test_mixed_inventory_prompt_allows_item_level_transaction_types():
    prompt = ai_extraction._get_extraction_prompt(
        "commercial", "rent", mixed_transaction=True
    )
    assert 'exactly "sale" or "rent" based on the individual block' in prompt


def test_ai_extract_sends_reconstructed_document_to_provider(monkeypatch):
    message = """1. RUSTOMJEE PARAMOUNT
3 BHK
1350 carpet
10.5 Cr

2. RUSTOMJEE PARAMOUNT
4 BHK
1800 carpet
13 Cr"""
    captured = {}

    def fake_call_provider(_provider, messages, **_kwargs):
        captured["messages"] = messages
        return [
            {
                "listing_type": "sale",
                "property_category": "residential",
                "bhk": 3,
                "price": {"amount": 105000000, "unit": "total", "period": "one_time", "raw_price_text": "10.5 Cr"},
                "locality": {"raw_mention": "Bandra West", "resolved_locality": "Bandra West", "confidence": "high"},
                "building_name": "RUSTOMJEE PARAMOUNT",
                "title": "3 BHK for Sale in Bandra West — RUSTOMJEE PARAMOUNT",
                "extraction_confidence": "high",
            }
        ]

    monkeypatch.setattr(ai_extraction, "_call_provider", fake_call_provider)
    monkeypatch.setattr(ai_extraction, "_PROVIDERS", [{"name": "fake", "api_key": "x", "base_url": "http://x", "model": "y"}])
    monkeypatch.setattr(ai_extraction, "_rr_index", 0)

    result = ai_extraction.ai_extract(message, ctx={})

    assert result["extraction_source"] == "ai"
    assert result["document"]["document_type"] == "Multi Listing"
    assert result["document"]["block_count"] == 2
    content = captured["messages"][1]["content"]
    payload = json.loads(content[content.index("{"):])
    assert payload["document_type"] == "Multi Listing"
    assert len(payload["blocks"]) == 2
    assert result["extraction"]["building_name"] == "RUSTOMJEE PARAMOUNT"


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

    def save_parsed(self, observation):
        self.saved.append(observation)
        return 41

    def save_resolver_decision(self, decision):
        self.resolver.append(decision)

    def upsert_listing_from_parsed(self, parsed_id):
        self.listing_ids.append(parsed_id)

    def mark_raw_processed(self, raw_id):
        self.processed.append(raw_id)

    def resolve_broker(self, *args, **kwargs):
        return None


def test_single_message_worker_uses_property_parser(monkeypatch):
    storage = _Storage()
    ai_item = {
        "listing_type": "sale", "property_category": "residential", "bhk": 3,
        "price": {"amount": 5.0, "unit": "cr", "period": "total"},
        "locality": {"raw_mention": "Bandra West", "resolved_locality": "Bandra West", "confidence": "high"},
        "furnishing_status": None, "title": None, "extraction_confidence": "high",
    }

    monkeypatch.setattr(lab.config, "load_excluded_groups", lambda: set())
    monkeypatch.setattr(ai_extraction, "ai_extract", lambda *_args, **_kwargs: {
        "extraction_source": "ai", "extraction": ai_item, "extractions": [ai_item], "provider_used": "fake",
    })
    monkeypatch.setattr(app, "compute_embedding", lambda _parsed: None)
    monkeypatch.setattr(app, "resolve_parsed", lambda *_args: {})
    monkeypatch.setattr(app, "generate_summary_title", lambda *_args: "3 BHK in Bandra West")
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
    """AI owns boundaries and every item retains the untouched source."""
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
    monkeypatch.setattr(ai_extraction, "ai_extract", lambda *_args, **_kwargs: {
        "extraction_source": "ai",
        "extraction": ai_items[0],
        "extractions": ai_items,
        "provider_used": "fake",
    })
    monkeypatch.setattr(app, "compute_embedding", lambda _parsed: None)
    monkeypatch.setattr(app, "resolve_parsed", lambda *_args: {})
    monkeypatch.setattr(app, "_parsed_source_text", lambda item, fallback: item["raw_payload"]["full_text"] or fallback)
    monkeypatch.setattr(app, "_demote_weak_property_parse", lambda item, _text: item)
    monkeypatch.setattr(app, "_parsed_has_market_anchor", lambda *_args: True)
    monkeypatch.setattr(app, "generate_summary_title", lambda parsed, *_args: parsed["raw_payload"]["full_text"])
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
        "Option 1\nOption 2",
        "Option 1\nOption 2",
    ]


def test_numbered_rental_inventory_is_handled_deterministically(monkeypatch):
    """Regression for raw 579267: numbered templates should bypass AI and keep six items."""
    message = """Available for Rent
1. Bandra West, 3 BHK, Rent 2 L
2. Vijaydeep, Khar West, 3 BHK, Rent 2.25 L
3. Ekam, Santacruz West, 3 BHK, Rent 2.5 L
4. Juhu Tara Road, 5 BHK, Rent 15 L, Deposit 1 Cr
5. Trinity Khar, 5 BHK, 14th Floor 12.5 L, 8th Floor 12 L
6. Simran Plaza, office, Rent 1.35 L"""
    calls = []

    def fake_ai_extract(text, *_args, **_kwargs):
        calls.append(text)
        raise AssertionError("AI should not run for numbered templates")

    storage = _Storage()
    monkeypatch.setattr(lab.config, "load_excluded_groups", lambda: set())
    monkeypatch.setattr(ai_extraction, "ai_extract", fake_ai_extract)
    monkeypatch.setattr(app, "compute_embedding", lambda _parsed: None)
    monkeypatch.setattr(app, "resolve_parsed", lambda *_args: {})
    monkeypatch.setattr(extraction, "get_bus", lambda: SimpleNamespace(publish=lambda *_args: None))

    result = extraction.process_raw_message(
        579267,
        {
            "sender_name": "Broker",
            "push_name": "Broker",
            "sender_jid": "919999999999@s.whatsapp.net",
            "sender_phone": "919999999999",
            "group": "group@g.us",
            "group_name": "Broker Group",
            "msg_text": message,
            "instance": "test",
            "is_dm": False,
            "message_uid": "raw-579267",
            "message_id": "579267",
            "msg": {},
        },
        storage=storage,
    )

    assert calls == []
    assert result["extraction_source"] == "deterministic:numbered"
    assert len(storage.saved) == 6
    assert [row.intent for row in storage.saved] == ["RENT", "RENT", "RENT", "RENT", None, "RENT"]
    assert [row.bhk for row in storage.saved] == ["3 BHK", "3 BHK", "3 BHK", "5 BHK", "5 BHK", None]
    assert [row.price_unit for row in storage.saved] == ["lac", "lac", "lac", "lac", "lac", "lac"]
    assert [row.price for row in storage.saved] == [2.0, 2.25, 2.5, 15.0, 12.5, 1.35]


def test_reviewed_reparse_preview_is_read_only_and_apply_reuses_exact_cards(monkeypatch):
    """Preview must not write or call AI; apply must save that exact generation."""
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
    monkeypatch.setattr(ai_extraction, "ai_extract", fail_if_ai_runs)
    monkeypatch.setattr(app, "compute_embedding", lambda _parsed: None)
    monkeypatch.setattr(app, "resolve_parsed", lambda *_args: {})
    monkeypatch.setattr(app, "_parsed_source_text", lambda item, fallback: item["raw_payload"]["full_text"] or fallback)
    monkeypatch.setattr(app, "_demote_weak_property_parse", lambda item, _text: item)
    monkeypatch.setattr(app, "_parsed_has_market_anchor", lambda *_args: True)
    monkeypatch.setattr(app, "generate_summary_title", lambda parsed, *_args: parsed["raw_payload"]["full_text"])
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


def test_multi_listing_message_is_sent_to_ai_once_without_preprocessing(monkeypatch):
    """Production must never classify, split, or rewrite source text before AI."""
    storage = _Storage()
    message = """A Fantastic 2BHK available for sale, 700 sqft, society has a direct beach access,
Location:-Greenfields, Juhu
Quote 4.40cr negotiable
WestBay 3BHK available for sale 950 usable 908 on the agreement,
Bandra West, Quote 4.75 cr Negotiable
Vibrant Properties
Aaron 8655245101"""

    ai_items = [
        {
            "listing_type": "sale", "property_category": "residential", "bhk": 2,
            "carpet_area_sqft": 700, "price": {"amount": 44000000, "unit": "total"},
            "locality": {"raw_mention": "Greenfields, Juhu", "resolved_locality": "Juhu", "confidence": "high"},
            "building_name": "Greenfields", "title": "2 BHK for sale at Greenfields, Juhu",
            "extraction_confidence": "high",
        },
        {
            "listing_type": "sale", "property_category": "residential", "bhk": 3,
            "carpet_area_sqft": 950, "price": {"amount": 47500000, "unit": "total"},
            "locality": {"raw_mention": "Bandra West", "resolved_locality": "Bandra West", "confidence": "high"},
            "building_name": "WestBay", "title": "3 BHK for sale at WestBay, Bandra West",
            "extraction_confidence": "high",
        },
    ]
    ai_calls = []

    def fake_ai_extract(text, *_args, **_kwargs):
        ai_calls.append(text)
        return {
            "extraction_source": "ai",
            "extraction": ai_items[0],
            "extractions": ai_items,
            "provider_used": "fake",
        }

    monkeypatch.setattr(lab.config, "load_excluded_groups", lambda: set())
    monkeypatch.setattr(ai_extraction, "ai_extract", fake_ai_extract)
    monkeypatch.setattr(app, "compute_embedding", lambda _parsed: None)
    monkeypatch.setattr(app, "resolve_parsed", lambda *_args: {})
    monkeypatch.setattr(app, "_parsed_source_text", lambda item, fallback: item["raw_payload"]["full_text"] or fallback)
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
    assert ai_calls == [message]
    evidence = [json.loads(row.raw_payload)["full_text"] for row in storage.saved]
    assert evidence == [message, message]


def test_numbered_template_path_skips_ai_and_saves_multiple_cards(monkeypatch):
    class _TemplateStorage(_Storage):
        def __init__(self):
            super().__init__()
            self.hashes = []
            self.splitter_cache = []

        def set_raw_message_hash(self, raw_id, message_hash):
            self.hashes.append((raw_id, message_hash))

        def get_raw_message_by_hash(self, *_args, **_kwargs):
            return None

        def get_sender_splitter_cache(self, *_args, **_kwargs):
            return None

        def upsert_sender_splitter_cache(self, **kwargs):
            self.splitter_cache.append(kwargs)
            return kwargs

        def resolve_broker(self, *args, **kwargs):
            return 99

    storage = _TemplateStorage()
    message = """1. For sale A Wing
3 BHK
1500 carpet
5.25 Cr

2. For sale B Wing
4 BHK
1800 carpet
6.25 Cr"""

    monkeypatch.setattr(lab.config, "load_excluded_groups", lambda: set())
    monkeypatch.setattr(app, "compute_embedding", lambda _parsed: None)
    monkeypatch.setattr(app, "resolve_parsed", lambda *_args: {})
    monkeypatch.setattr(app, "generate_summary_title", lambda *_args: "template")
    monkeypatch.setattr(ai_extraction, "ai_extract", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("AI should not run for numbered templates")))
    monkeypatch.setattr(extraction, "get_bus", lambda: SimpleNamespace(publish=lambda *_args: None))

    result = extraction.process_raw_message(
        1234,
        {
            "sender_name": "Broker",
            "push_name": "Broker",
            "sender_jid": "919999999999@s.whatsapp.net",
            "sender_phone": "919999999999",
            "group": "group@g.us",
            "group_name": "Bandra Brokers",
            "msg_text": message,
            "instance": "test",
            "is_dm": False,
            "message_uid": "test-1234",
            "message_id": "1234",
            "msg": {},
            "tenant_id": "11111111-1111-1111-1111-111111111111",
        },
        storage=storage,
    )

    assert result["extraction_source"] == "deterministic:numbered"
    assert len(storage.saved) == 2
    assert [row.listing_index for row in storage.saved] == [0, 1]
    assert [row.price_unit for row in storage.saved] == ["cr", "cr"]
    assert [row.bhk for row in storage.saved] == ["3 BHK", "4 BHK"]
    assert storage.hashes and storage.hashes[0][1]
    assert storage.listing_ids == [41, 41]


def test_duplicate_hash_reuses_existing_parsed_rows(monkeypatch):
    class _DuplicateStorage(_Storage):
        def __init__(self):
            super().__init__()
            self.hashes = []

        def set_raw_message_hash(self, raw_id, message_hash):
            self.hashes.append((raw_id, message_hash))

        def get_raw_message_by_hash(self, *_args, **_kwargs):
            return {"raw": {"id": 9001}, "parsed": [{"id": 88}]}

        def get_sender_splitter_cache(self, *_args, **_kwargs):
            return None

        def upsert_sender_splitter_cache(self, **kwargs):
            return kwargs

    storage = _DuplicateStorage()

    monkeypatch.setattr(lab.config, "load_excluded_groups", lambda: set())
    monkeypatch.setattr(extraction, "_clone_parsed_rows", lambda *_args, **_kwargs: ([77, 78], [177, 178]))
    monkeypatch.setattr(ai_extraction, "ai_extract", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("AI should not run for duplicate hashes")))
    monkeypatch.setattr(extraction, "get_bus", lambda: SimpleNamespace(publish=lambda *_args: None))

    result = extraction.process_raw_message(
        1235,
        {
            "sender_name": "Broker",
            "push_name": "Broker",
            "sender_jid": "919999999999@s.whatsapp.net",
            "sender_phone": "919999999999",
            "group": "group@g.us",
            "group_name": "Bandra Brokers",
            "msg_text": "duplicate body",
            "instance": "test",
            "is_dm": False,
            "message_uid": "test-1235",
            "message_id": "1235",
            "msg": {},
            "tenant_id": "11111111-1111-1111-1111-111111111111",
            "message_hash": "abc123",
        },
        storage=storage,
    )

    assert result["extraction_source"] == "hash_duplicate"
    assert result["parsed_ids"] == [77, 78]
    assert result["listing_ids"] == [177, 178]


def _run_broker_attribution(monkeypatch, sender_phone: str) -> dict:
    """Helper: process a message and return broker_name/broker_phone on the saved row."""
    storage = _Storage()
    ai_item = {
        "listing_type": "rent", "property_category": "residential", "bhk": 2,
        "carpet_area_sqft": None,
        "price": {"amount": 150000, "unit": "total", "period": "per_month"},
        "locality": {"raw_mention": "Bandra West", "resolved_locality": "Bandra West", "confidence": "high"},
        "furnishing_status": None, "title": None, "extraction_confidence": "high",
    }
    monkeypatch.setattr(lab.config, "load_excluded_groups", lambda: set())
    monkeypatch.setattr(ai_extraction, "ai_extract", lambda *_args, **_kwargs: {
        "extraction_source": "ai", "extraction": ai_item, "extractions": [ai_item], "provider_used": "fake",
    })
    monkeypatch.setattr(app, "compute_embedding", lambda _parsed: None)
    monkeypatch.setattr(app, "resolve_parsed", lambda *_args: {})
    monkeypatch.setattr(app, "generate_summary_title", lambda *_args: "2 BHK in Bandra West")
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
    monkeypatch.setattr(app, "compute_embedding", lambda _parsed: None)
    monkeypatch.setattr(app, "resolve_parsed", lambda *_args: {})
    monkeypatch.setattr(app, "_parsed_source_text", lambda item, fallback: item["raw_payload"]["full_text"] or fallback)
    monkeypatch.setattr(app, "_demote_weak_property_parse", lambda item, _text: item)
    monkeypatch.setattr(app, "_parsed_has_market_anchor", lambda *_args: True)
    monkeypatch.setattr(app, "generate_summary_title", lambda parsed, *_args: parsed["raw_payload"]["full_text"])
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
    # Headline price is what the broker quoted, normalized to absolute rupees
    # (1.55Cr → 15,500,000). It is not inflated by additional charges.
    assert obs.price == 15500000, f"price should be 15500000 rupees, got {obs.price}"
    assert obs.price_unit == "abs"
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


def test_redact_indian_mobiles_preserves_prices_redacts_phones():
    src_in = "Available Sagar Resham 2BHK Rs8.5L area 850 sqft contact +91 9876543210"
    out = extraction._redact_indian_mobiles(src_in)
    assert out == "Available Sagar Resham 2BHK Rs8.5L area 850 sqft contact [Contact redacted — see agent]"


def test_redact_indian_mobiles_handles_obfuscated_formats():
    assert extraction._redact_indian_mobiles("Call 98765-43210 now") == "Call [Contact redacted — see agent] now"
    assert extraction._redact_indian_mobiles("Call +91 98765 43210 now") == "Call [Contact redacted — see agent] now"
    assert extraction._redact_indian_mobiles("Phone 9876543210 / 9123456789") == "Phone [Contact redacted — see agent] / [Contact redacted — see agent]"


def test_redact_indian_mobiles_handles_11digit_bare_phones():
    r"""Real brokers paste 11-digit bare phones (90048427759, 84335469487)
    that lack separators and the strict 10-digit pattern misses because
    the trailing digit still satisfies "(?!\d)"."""
    assert extraction._redact_indian_mobiles("Agent - 90048427759*") == "Agent - [Contact redacted — see agent]*"
    assert extraction._redact_indian_mobiles("Maya Deshmukh - 84335469487") == "Maya Deshmukh - [Contact redacted — see agent]"
    # STD-style 0-prefix should also go
    assert extraction._redact_indian_mobiles("Phone 09004842775 desk") == "Phone [Contact redacted — see agent] desk"
    # Pricing & area must remain intact
    assert extraction._redact_indian_mobiles("Rs 8.5L 900 sqft 98201-12345") == "Rs 8.5L 900 sqft [Contact redacted — see agent]"


def test_redact_indian_mobiles_leaves_landlines_and_prices_alone():
    assert extraction._redact_indian_mobiles("Office 01234567890 desk 5") == "Office 01234567890 desk 5"
    assert extraction._redact_indian_mobiles("Rent 75000 deposit 50000") == "Rent 75000 deposit 50000"


def test_ai_extraction_to_parsed_writes_redacted_normalized_message():
    """The per-listing normalized_message must redact broker phones while
    raw_payload.full_text still preserves the digits for audit and
    broker-resolution paths."""
    raw = (
        "2BHK Available Sagar Resham Rent 75000 "
        "Contact +91 9876543210"
    )
    parsed = extraction._ai_extraction_to_parsed(
        {
            "listing_type": "rent",
            "bhk": 2,
            "price": {"amount": 75000, "unit": "abs"},
            "locality": {"resolved_locality": "Bandra West"},
        },
        raw,
        "Broker",
        "Broker",
        slice_text=raw,
    )

    assert parsed["normalized_message"], "normalized_message must be populated"
    assert "9876543210" not in parsed["normalized_message"], (
        "broker digits must NOT appear in normalized_message (display path)"
    )
    assert "[Contact redacted" in parsed["normalized_message"]
    # Audit fidelity: raw_payload.full_text still has the original digits
    assert "9876543210" in parsed["raw_payload"]["full_text"], (
        "raw_payload.full_text must preserve broker digits for audit"
    )
    assert parsed["raw_payload"]["slice_text"] == raw


def test_provider_outage_never_consumes_message(monkeypatch):
    """When every provider is down, process_raw_message must raise and leave
    the raw message unprocessed — a NO_ANCHOR stub would mark a real listing
    as consumed and lose it forever."""
    storage = _Storage()

    monkeypatch.setattr(lab.config, "load_excluded_groups", lambda: set())
    monkeypatch.setattr(ai_extraction, "ai_extract", lambda *_args, **_kwargs: {
        "extraction_source": "ai_unavailable",
        "needs_review": True,
        "error": "All 3 providers failed after 6 attempts",
    })
    monkeypatch.setattr(app, "compute_embedding", lambda _parsed: None)
    monkeypatch.setattr(app, "resolve_parsed", lambda *_args: {})
    monkeypatch.setattr(app, "generate_summary_title", lambda *_args: "3 BHK in Bandra West")
    monkeypatch.setattr(extraction, "get_bus", lambda: SimpleNamespace(publish=lambda *_args: None))

    with pytest.raises(RuntimeError, match="extraction unavailable"):
        extraction.process_raw_message(
            55,
            {
                "sender_name": "Broker",
                "push_name": "Broker",
                "sender_jid": "919999999999@s.whatsapp.net",
                "sender_phone": "919999999999",
                "group": "group@g.us",
                "group_name": "Bandra Brokers",
                "msg_text": "2 BHK for rent in Bandra West at 75k",
                "instance": "test",
                "is_dm": False,
                "message_uid": "test-55",
                "message_id": "55",
                "msg": {},
            },
            storage=storage,
        )

    assert storage.processed == [], "message must NOT be marked processed on provider outage"
    assert storage.saved == [], "no NO_ANCHOR stub may be written on provider outage"
