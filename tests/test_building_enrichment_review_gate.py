from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_automatic_building_candidates_are_review_gated():
    storage = (ROOT / "storage/supabase.py").read_text()
    discovery = (ROOT / "agents/building_enrichment/discovery.py").read_text()
    assert '"status": "needs_review"' in storage
    assert "review_required=True" in discovery


def test_context_requeues_wait_for_review_and_only_pending_is_runnable():
    migration = (ROOT / "supabase/migrations/20260909140000_building_enrichment_review_gate.sql").read_text()
    assert "status = 'needs_review'" in migration
    assert "status in ('pending', 'running', 'needs_review')" in migration
    assert ".eq(\"status\", \"pending\")" in (ROOT / "storage/supabase.py").read_text()
