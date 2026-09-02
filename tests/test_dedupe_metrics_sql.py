"""Static guardrails for the service-role-only dedupe metrics function."""

from pathlib import Path


SQL = Path("supabase/migrations/20260901110000_dedupe_metrics.sql").read_text()
CLAIM_SQL = Path("supabase/migrations/20260903100000_shared_extraction_claims.sql").read_text()
TEAM_REBUILD_SQL = Path(
    "supabase/migrations/20260903110000_preserve_team_relationships_on_rebuild.sql"
).read_text()
COST_SQL = Path("supabase/migrations/20260903120000_dedupe_cost_metrics.sql").read_text()


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


def test_shared_claims_are_service_role_only():
    assert "enable row level security" in CLAIM_SQL
    assert "revoke all on table public.shared_extraction_claims from anon, authenticated" in CLAIM_SQL
    assert "grant all on table public.shared_extraction_claims to service_role" in CLAIM_SQL


def test_team_rebuild_preserves_reviewed_relationships():
    assert "fn_definition := replace" in TEAM_REBUILD_SQL
    assert "delete from public.broker_teams;'" in TEAM_REBUILD_SQL
    assert "Preserve existing teams, evidence" in TEAM_REBUILD_SQL
    assert "on conflict (tenant_id, normalized_name)" in TEAM_REBUILD_SQL


def test_cost_metrics_include_skips_and_observed_cost_rate():
    for term in (
        "get_dedupe_cost_metrics",
        "model_calls_avoided",
        "observed_mean_extraction_cost_usd",
        "estimated_cost_avoided_usd",
        "agent = 'extraction'",
        "grant execute on function public.get_dedupe_cost_metrics() to service_role",
    ):
        assert term in COST_SQL
