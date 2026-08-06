from pathlib import Path


MIGRATION = Path(__file__).parents[1] / "supabase/migrations/20260806120000_restore_listings_unified_legacy_contract.sql"


def test_listings_unified_restores_legacy_consumer_columns():
    sql = MIGRATION.read_text()
    for column in (
        "fingerprint",
        "developer",
        "orientation",
        "pic_token",
        "listing_source",
        "location_raw",
    ):
        assert f" as {column}" in sql.lower()


def test_supabase_storage_db_is_live_postgres_adapter():
    source = (Path(__file__).parents[1] / "storage/supabase.py").read_text()
    assert '"propai_query_sql"' in source
    assert "class _SupabaseDatabaseAdapter" in source
