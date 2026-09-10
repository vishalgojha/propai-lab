from datetime import datetime, timezone

from public_collections_worker import _candidate_buckets


def test_candidate_bucket_is_deterministic_and_keeps_typed_listing_references():
    now = datetime(2026, 9, 10, tzinfo=timezone.utc)
    rows = [
        {
            "card_type": "residential_rent", "id": index, "summary_title": f"{index} BHK in Bandra West",
            "building_name": f"Building {index}", "micro_market": "Bandra West",
            "canonical_micro_market_slug": "bandra-west", "bhk": "2 BHK", "price": 150000,
            "area_sqft": 900, "last_seen": "2026-09-10T00:00:00+00:00",
        }
        for index in range(1, 5)
    ]

    first = _candidate_buckets(rows, now)
    second = _candidate_buckets(list(reversed(rows)), now)

    assert set(first) == {"fresh-2-bhk-rent-bandra-west"}
    assert first.keys() == second.keys()
    assert [item[3]["id"] for item in first["fresh-2-bhk-rent-bandra-west"]["items"]] == [1, 2, 3, 4]
    assert first["fresh-2-bhk-rent-bandra-west"]["rule_version"] == "market-slice-v1"


def test_candidate_buckets_do_not_publish_underfilled_groups():
    now = datetime(2026, 9, 10, tzinfo=timezone.utc)
    rows = [{"card_type": "residential_sale", "id": 1, "summary_title": "1 BHK", "micro_market": "Bandra West", "bhk": "1 BHK"}]
    assert _candidate_buckets(rows, now) == {}
