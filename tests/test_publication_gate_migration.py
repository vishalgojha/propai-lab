"""Pins the SQL publication gate that makes listings_unified_public safe to expose.

The account-free public surfaces (website, /api/public/v1, public MCP) all read
listings_unified_public. These tests assert the deployed migration definitions
keep the private/hidden-row exclusion intact: only visibility='shared_market'
rows whose raw source is a publication-allowlisted, active, opted-in group can
appear, and the internal view chain stays revoked from anon.

They parse migration SQL rather than executing it (no Postgres in CI), so they
guard the contract text; live per-row exclusion is verified against the
deployment.
"""
import re
from pathlib import Path

MIGRATIONS = Path(__file__).resolve().parent.parent / "supabase" / "migrations"
GATE = MIGRATIONS / "20261113110000_instinct_connection_publication_gate.sql"
CHAIN = MIGRATIONS / "20260912073000_fix_public_projection_view_chain.sql"
PROJECTION = MIGRATIONS / "20260906120000_public_safe_listing_projection.sql"

CARD_TYPES = [
    "residential_sale",
    "residential_rent",
    "commercial_sale",
    "commercial_rent",
]


def _latest_view_definition(view: str) -> str:
    """Return the most recent migration text that (re)defines the view."""
    pattern = re.compile(rf"create\s+or\s+replace\s+view\s+public\.{view}\b", re.IGNORECASE)
    latest = None
    for path in sorted(MIGRATIONS.glob("*.sql")):
        text = path.read_text()
        if pattern.search(text):
            latest = text
    assert latest is not None, f"no migration defines {view}"
    return latest


def test_every_card_type_requires_shared_market_and_allowlisted_group_source():
    view_sql = _latest_view_definition("listings_unified_public").lower()
    for card_type in CARD_TYPES:
        guard = re.search(
            rf"exists \(select 1 from public\.{card_type}_listings .*?\)",
            view_sql,
            re.DOTALL,
        )
        assert guard, f"{card_type} has no per-table guard in listings_unified_public"
        clause = guard.group(0)
        assert "visibility='shared_market'" in clause.replace(" ", ""), (
            f"{card_type} guard does not require visibility='shared_market'"
        )
        assert "raw_message_has_public_group_source" in clause, (
            f"{card_type} guard does not require an allowlisted public group source"
        )


def test_group_source_function_requires_active_opted_in_allowlisted_publication():
    fn = GATE.read_text().lower()
    body = re.search(
        r"function public\.raw_message_has_public_group_source.*?\$fn\$;",
        fn,
        re.DOTALL,
    )
    assert body, "raw_message_has_public_group_source not found in gate migration"
    sql = body.group(0)
    for predicate in (
        "raw.is_group = true",
        "group_source.is_active = true",
        "group_source.opted_out = false",
        "group_source.public_market_source = true",
        "publication.enabled = true",
        "public_market_publication_allowlist",
    ):
        assert predicate in " ".join(sql.split()), f"group-source function lost: {predicate}"


def test_internal_view_chain_not_readable_by_anon():
    chain = CHAIN.read_text().lower()
    for internal in (
        "listings_unified_typed_projection",
        "listings_unified",
        "listings_unified_public_legacy",
    ):
        assert re.search(rf"revoke all on public\.{internal} from anon", chain), (
            f"{internal} must stay revoked from anon"
        )
    assert "grant select on public.listings_unified_public to anon" in chain


def test_public_projection_exposes_no_contact_fields():
    view_sql = _latest_view_definition("listings_unified_public").lower()
    view_start = re.search(r"create\s+or\s+replace\s+view", view_sql)
    select_list = view_sql[view_start.start():].split("from public.listings_unified_public_legacy", 1)[0]
    for forbidden in ("phone", "whatsapp", "raw_payload", "raw_message_id", "sender"):
        assert forbidden not in select_list, (
            f"listings_unified_public must not expose '{forbidden}'"
        )
    projection = PROJECTION.read_text().lower()
    assert "grant select on public.listings_unified_public to anon" in projection
