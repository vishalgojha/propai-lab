from storage.supabase import SupabaseStorage


def test_market_feed_page_respects_requested_page_and_marks_sampled_total():
    storage = object.__new__(SupabaseStorage)
    calls = {}

    def fake_feed(**kwargs):
        calls.update(kwargs)
        return [{"id": index} for index in range(kwargs["limit"])]

    storage.get_market_items_feed = fake_feed
    result = storage.get_market_items_feed_page(limit=2, offset=3)

    assert [item["id"] for item in result["items"]] == [3, 4]
    assert result["total"] == 5
    assert result["total_scope"] == "bounded_recent_market_sample"
    assert calls["limit"] == 5
    assert calls["offset"] == 0


def test_locality_feed_uses_wide_candidate_window_before_exact_filtering():
    storage = object.__new__(SupabaseStorage)
    captured = {}

    def fake_fetch(**kwargs):
        captured.update(kwargs)
        return (
            [{
                "_typed_table": "residential_rent_listings",
                "micro_market": "Bandra West",
                "created_at": "2026-08-27T10:00:00+00:00",
                "last_seen_at": "2026-08-27T10:00:00+00:00",
                "raw_message_id": 1,
                "id": 1,
            }],
            {},
        )

    storage._fetch_recent_market_typed_rows = fake_fetch
    storage._typed_row_to_legacy = lambda row: {"id": row["id"], "created_at": row["created_at"]}
    result = storage._get_recent_market_observations(
        limit=1,
        offset=0,
        market_localities=["Bandra West"],
    )

    assert result[0]["id"] == 1
    assert captured["limit"] >= 250
