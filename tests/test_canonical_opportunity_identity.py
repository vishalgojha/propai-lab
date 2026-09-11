from storage.supabase import (
    _effective_broker_name,
    _market_name_key,
    _merge_observation_rows,
    _observation_fingerprint,
)


def _listing(**overrides):
    row = {
        "broker_id": 42,
        "broker_phone": "919876543210",
        "transaction_type": "rent",
        "asset_type": "residential",
        "building_name": "Lodha Sea View",
        "micro_market": "Bandra West",
        "bhk": "3 BHK",
        "area_sqft": 1200,
        "price": 150000,
        "floor_range": "12",
        "wing": "A",
    }
    row.update(overrides)
    return row


def test_repost_identity_ignores_source_message_and_alias_name():
    first = _listing(broker_name="Kapil Gopal Ojha", source_message="first post")
    repost = _listing(broker_name="Kapsy", source_message="forwarded repost")

    assert _observation_fingerprint(first) == _observation_fingerprint(repost)


def test_repost_identity_ignores_raw_message_hash():
    first = _listing(raw_message_hash="message-a", listing_index=0)
    repost = _listing(raw_message_hash="message-b", listing_index=0)

    assert _observation_fingerprint(first) == _observation_fingerprint(repost)


def test_broadcast_item_index_remains_part_of_identity():
    first = _listing(raw_message_hash="message-a", listing_index=0)
    second = _listing(raw_message_hash="message-a", listing_index=1)

    assert _observation_fingerprint(first) != _observation_fingerprint(second)


def test_different_unit_attributes_remain_distinct():
    assert _observation_fingerprint(_listing(floor_range="12")) != _observation_fingerprint(
        _listing(floor_range="13")
    )
    assert _observation_fingerprint(_listing(wing="A")) != _observation_fingerprint(
        _listing(wing="B")
    )


def test_broker_identity_is_stable_when_id_is_present():
    assert _observation_fingerprint(_listing(broker_name="Kapil Gopal Ojha")) == _observation_fingerprint(
        _listing(broker_name="Kapsy", broker_phone="919000000000")
    )


def test_cta_text_cannot_become_broker_identity():
    assert _effective_broker_name(source_name="Please share suitable options") == ""


def test_numeric_whatsapp_suffix_is_not_a_distinct_name_identity():
    assert _market_name_key("Gurukirpa Realtors Mumbai") == _market_name_key("Gurukirpa Realtors Mumbai-50")


def test_numeric_extraction_variants_have_one_repost_identity():
    first = _listing(area_sqft=2300, price=12650000)
    repost = _listing(area_sqft=2300.0, price="12650000.0")

    assert _observation_fingerprint(first) == _observation_fingerprint(repost)


def test_reindexed_repost_merges_but_same_broadcast_siblings_stay_split():
    base = {
        "observation_type": "LISTING",
        "transaction_type": "rent",
        "asset_type": "commercial",
        "building_name": "Singage Borde",
        "micro_market": "Bandra West",
        "area_sqft": 1000,
        "price": 5250000,
        "broker_phone": "919876543210",
    }
    repost = {
        **base,
        "raw_message_id": 2,
        "source_fingerprint": "message-2",
        "listing_index": 1,
    }
    sibling = {
        **base,
        "raw_message_id": 1,
        "source_fingerprint": "message-1",
        "listing_index": 1,
    }

    assert len(_merge_observation_rows([base | {
        "raw_message_id": 1,
        "source_fingerprint": "message-1",
        "listing_index": 0,
    }, repost])) == 1
    assert len(_merge_observation_rows([base | {
        "raw_message_id": 1,
        "source_fingerprint": "message-1",
        "listing_index": 0,
    }, sibling])) == 2


def test_exact_listing_slice_repost_merges_when_optional_area_is_recovered():
    base = {
        "observation_type": "LISTING",
        "transaction_type": "rent",
        "asset_type": "commercial",
        "building_name": "Lavelsh Court",
        "micro_market": "Bandra West",
        "commercial_use_type": "mixed_use",
        "monthly_rent": 250000,
        "broker_phone": "919702874338",
        "source_message": "*LAVELSH COURT – BANDRA*",
        "listing_index": 0,
    }
    rows = [
        {**base, "id": 1, "raw_message_id": 101, "carpet_area_sqft": None},
        {**base, "id": 2, "raw_message_id": 102, "carpet_area_sqft": 1050},
    ]

    merged = _merge_observation_rows(rows)

    assert len(merged) == 1
    assert merged[0]["times_seen"] == 2
    assert merged[0]["carpet_area_sqft"] == 1050


def test_exact_listing_slice_requires_same_raw_sender_when_available():
    base = {
        "observation_type": "LISTING",
        "transaction_type": "rent",
        "asset_type": "commercial",
        "building_name": "Lavelsh Court",
        "micro_market": "Bandra West",
        "monthly_rent": 250000,
        "broker_phone": "919702874338",
        "source_message": "*LAVELSH COURT – BANDRA*",
        "listing_index": 0,
    }

    assert len(_merge_observation_rows([
        {**base, "raw_message_id": 1, "source_sender_jid": "919702874338@s.whatsapp.net"},
        {**base, "raw_message_id": 2, "source_sender_jid": "919000000000@s.whatsapp.net"},
    ])) == 2


def test_richer_observation_wins_even_when_it_arrives_earlier():
    base = {
        "observation_type": "LISTING",
        "transaction_type": "rent",
        "asset_type": "commercial",
        "building_name": "Lavelsh Court",
        "micro_market": "Bandra West",
        "monthly_rent": 250000,
        "broker_phone": "919702874338",
        "source_sender_jid": "919702874338@s.whatsapp.net",
        "source_message": "*LAVELSH COURT – BANDRA*",
        "listing_index": 0,
    }
    merged = _merge_observation_rows([
        {**base, "raw_message_id": 1, "carpet_area_sqft": 1050, "last_seen": "2026-09-10T10:00:00Z"},
        {**base, "raw_message_id": 2, "carpet_area_sqft": None, "last_seen": "2026-09-10T11:00:00Z"},
    ])

    assert len(merged) == 1
    assert merged[0]["carpet_area_sqft"] == 1050
    assert merged[0]["last_seen"] == "2026-09-10T11:00:00Z"
