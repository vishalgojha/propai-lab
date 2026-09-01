"""Static guardrails for the service-role-only dedupe metrics function."""

from pathlib import Path


SQL = Path("supabase/migrations/20260901110000_dedupe_metrics.sql").read_text()


def test_metrics_are_service_role_only_and_search_path_hardened():
    assert "security definer" in SQL.lower()
    assert "set search_path = public" in SQL
    assert "revoke all on function public.get_dedupe_metrics() from public, anon, authenticated" in SQL
    assert "grant execute on function public.get_dedupe_metrics() to service_role" in SQL


def test_metrics_include_observable_dedupe_outcomes():
    for term in (
        "shared_extraction_results",
        "shared_extraction_observations",
        "protocol_event",
        "pre_llm:%",
        "model_calls_avoided",
    ):
        assert term in SQL
