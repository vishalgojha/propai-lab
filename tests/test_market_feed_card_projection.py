from storage.supabase import SupabaseStorage, _ALL_TYPED_TABLES, _market_card_columns


def _columns(table: str) -> set[str]:
    return set(_market_card_columns(table).split(","))


def test_market_card_projection_is_table_specific():
    commercial = _columns("commercial_sale_listings")
    requirement = _columns("residential_sale_requirements")

    assert "commercial_use_type" in commercial
    assert "fitout_status" in commercial
    assert "bhk" not in commercial

    assert "bhk_options" in requirement
    assert "budget_max" in requirement
    assert "price_raw_text" not in requirement
    assert "total_asking_price" not in requirement


def test_every_typed_table_has_the_initial_card_identity_fields():
    required = {
        "id", "raw_message_id", "source_fingerprint", "asset_type",
        "transaction_type", "broker_name", "broker_phone", "summary_title",
        "created_at",
    }

    for table in _ALL_TYPED_TABLES:
        assert required <= _columns(table), table


def test_commercial_fitout_is_used_for_initial_card_furnishing():
    row = SupabaseStorage._typed_row_to_legacy(
        {
            "_typed_table": "commercial_rent_listings",
            "transaction_type": "rent",
            "asset_type": "commercial",
            "fitout_status": "warm shell",
        },
    )

    assert row["furnishing"] == "warm shell"
