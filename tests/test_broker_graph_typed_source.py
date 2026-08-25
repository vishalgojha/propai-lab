from pathlib import Path


MIGRATION = Path(__file__).parents[1] / "supabase/migrations/20260825220000_rebuild_broker_graph_from_typed_tables.sql"


def test_broker_graph_rebuild_uses_all_typed_sources():
    sql = MIGRATION.read_text()
    function_body = sql.split("create or replace function public.rebuild_broker_graph()", 1)[1].split("$$;", 1)[0]
    for table in (
        "residential_sale_listings",
        "residential_rent_listings",
        "commercial_sale_listings",
        "commercial_rent_listings",
        "residential_sale_requirements",
        "residential_rent_requirements",
        "commercial_sale_requirements",
        "commercial_rent_requirements",
    ):
        assert f"from {table}" in function_body
    assert "from parsed_output" not in function_body


def test_broker_graph_rebuild_refreshes_directory_cache():
    sql = MIGRATION.read_text()
    assert "comment on function public.rebuild_broker_graph()" in sql
