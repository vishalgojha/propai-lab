"""
Tests for ``backfill_localities.py`` apply path and the shared
:class:`registry.locality_resolver.LocalityResolver`.

The apply path is the part that mutates the database, so the bulk of
these tests are pure-Python unit tests with an in-memory fake Supabase
client (mirroring ``tests/test_supabase_storage_regression.py``'s
``FakeClient`` / ``FakeQuery`` patterns). No live DB calls; no calls
to ``SupabaseStorage.__init__``.
"""
from __future__ import annotations

import csv
import os
import sys
from types import SimpleNamespace

import pytest


sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


# ── fixtures: minimal reference data ──────────────────────────────────────


REFERENCE = {
    "locality_reference": [
        {"sub_locality": "Bandra West", "parent_locality": "Bandra West", "confidence": "high"},
        {"sub_locality": "Khar West", "parent_locality": "Khar West", "confidence": "high"},
        {"sub_locality": "Pali Hill", "parent_locality": "Bandra West", "confidence": "high"},
        {"sub_locality": "Lokhandwala", "parent_locality": "Andheri West", "confidence": "high"},
        {"sub_locality": "random suburb", "parent_locality": "Suburb X", "confidence": "low"},
    ],
    "buildings": [
        {"canonical_name": "Shree Towers", "micro_market": "Andheri West"},
        {"canonical_name": "Skyline Heights", "micro_market": "Bandra West"},
        {"canonical_name": "Kalpataru Vivante", "micro_market": "Bandra West"},
        {"canonical_name": "Greenview Apartments", "micro_market": "Santacruz West"},
    ],
    "building_name_aliases": [
        {"alias": "shree towers phase 2", "canonical_name": "Shree Towers"},
        {"alias": "kalpataru vivant", "canonical_name": "Kalpataru Vivante"},
        {"alias": "greenview", "canonical_name": "Greenview Apartments"},
    ],
}


@pytest.fixture
def resolver():
    from registry.locality_resolver import LocalityResolver
    # Pass reference directly so we don't fake db calls during construction.
    return LocalityResolver(db=None, reference=REFERENCE)


# ── registry.locality_resolver: known-good baseline ────────────────────────


def test_resolver_text_match_returns_resolved_locality_and_matched_sub(resolver):
    out = resolver.resolve_from_text(
        "Spacious 2 BHK available near Pali Hill, contact 98xxxxxx21."
    )
    assert out is not None
    assert out["resolved_locality"] == "Bandra West"
    assert out["confidence"] == "high"
    assert out["source"] == "text_reference_match"
    assert out["matched_sub"] == "Pali Hill"


def test_resolver_skips_ultra_short_messages(resolver):
    """A 12-character message must not match anything (per house rules)."""
    assert resolver.resolve_from_text("Bandra") is None
    assert resolver.resolve_from_text("https://youtu.be/x") is None  # also link-only


def test_resolver_skips_low_confidence_sub_locality(resolver):
    """`random suburb` is `low` confidence — applies must skip it
    when --min-confidence 'medium' (default).
    """
    from registry.locality_resolver import meets_minimum
    out = resolver.resolve_from_text("come visit random suburb today")
    assert out is not None  # resolver returns it
    assert out["confidence"] == "low"
    assert not meets_minimum(out["confidence"], "medium")
    assert meets_minimum(out["confidence"], "low")


def test_resolver_building_lookup_direct_returns_high_confidence(resolver):
    out = resolver.resolve_from_building("Skyline Heights")
    assert out == {
        "resolved_locality": "Bandra West",
        "confidence": "high",
        "source": "buildings_table",
        "matched_sub": None,
    }


def test_resolver_building_lookup_via_alias_returns_medium_confidence(resolver):
    """`greenview` is an alias, alias map → canonical → buildings → medium."""
    out = resolver.resolve_from_building("greenview")
    assert out == {
        "resolved_locality": "Santacruz West",
        "confidence": "medium",
        "source": "building_name_aliases",
        "matched_sub": None,
    }


def test_resolver_unknown_building_returns_none(resolver):
    assert resolver.resolve_from_building("Some Random Tower 12345") is None


def test_resolver_uses_canonical_locality_and_bkc_alias(resolver):
    resolver.loc_ref_by_sub["bkc"] = {
        "sub_locality": "Bandra Kurla Complex",
        "parent_locality": "BKC",
        "canonical_locality": "Bandra Kurla Complex",
        "confidence": "high",
    }
    out = resolver.resolve_from_text("Office available in BKC today")
    assert out is not None
    assert out["resolved_locality"] == "Bandra Kurla Complex"


def test_structured_locality_resolver_returns_canonical_id_without_regex():
    from registry.locality_resolver import LocalityResolver

    resolver = LocalityResolver(db=None, reference={
        "locality_reference": [
            {
                "id": 41,
                "sub_locality": "Pali Hill",
                "parent_locality": "Bandra West",
                "canonical_locality": "Bandra West",
                "alternate_names": ["Pali-Hill"],
                "confidence": "high",
            },
        ],
        "buildings": [],
        "building_name_aliases": [],
    })

    out = resolver.resolve_extracted_locality({
        "raw_mention": "Pali-Hill",
        "resolved_locality": "Bandra West",
    })

    assert out["status"] == "matched"
    assert out["locality_id"] == 41
    assert out["resolved_locality"] == "Bandra West"


def test_structured_locality_resolver_does_not_guess_collisions():
    from registry.locality_resolver import LocalityResolver

    resolver = LocalityResolver(db=None, reference={
        "locality_reference": [
            {"id": 1, "sub_locality": "Central Park", "parent_locality": "A", "confidence": "high"},
            {"id": 2, "sub_locality": "Central Park", "parent_locality": "B", "confidence": "high"},
        ],
        "buildings": [],
        "building_name_aliases": [],
    })

    out = resolver.resolve_extracted_locality({"raw_mention": "Central Park"})

    assert out["status"] == "ambiguous"
    assert out["locality_id"] is None


# ── apply path: fake Supabase client ─────────────────────────────────────


class _FakeRow:
    """Stand-in for PostgREST's request-builder chains."""

    def __init__(self, rows):
        self.rows = rows

    def __getattr__(self, _name):
        # Any chained filter (.eq, .neq, .order, .is_, .or_, .not_) returns self.
        return lambda *args, **kwargs: self

    def execute(self):
        return SimpleNamespace(data=self.rows)


class _FakeClient:
    """Stores rows per table; no real networking semantics are faked here
    because the apply path is fully exercised via a manual walker in each
    test. This base class only supports ``.select`` (returns rows
    passthrough) and records updates via :pyattr:`updates`.
    """
    def __init__(self, rows_by_table):
        self.rows_by_table = rows_by_table
        self.updates = []

    def table(self, name):
        return _FakeUpdateCollector(name, self)


class _FakeUpdateCollector:
    """Each ``.update(payload).eq(...).execute()`` records the call."""

    def __init__(self, table, client):
        self._table = table
        self._client = client
        self._pending_payload = None
        self._pending_eq = None

    def select(self, *args, **kwargs):
        rows = self._client.rows_by_table.get(self._table, [])
        return _FakeRow(rows)

    def or_(self, *_args, **_kwargs):
        return self

    def eq(self, column, value):
        self._pending_eq = (column, value)

        class _Next:
            def __init__(self, outer):
                self._outer = outer

            def execute(self):
                self._outer._client.updates.append({
                    "table": self._outer._table,
                    "payload": self._outer._pending_payload,
                    "where": self._outer._pending_eq,
                })
                return SimpleNamespace(data=[{"id": self._outer._pending_eq[1]}])

        return _Next(self)

    def update(self, payload):
        self._pending_payload = payload
        return self


def _build_apply_inputs():
    """Build a realistic-ish fixture used by the apply-path tests."""
    listings_rows = [
        # Empty micro_market → empty → apply allowed.
        {"id": 1, "building_name": "Skyline Heights",
         "micro_market": "", "representative_raw_message_id": 100,
         "tenant_id": "tenant-a"},
        # Empty micro_market → empty → apply allowed (alias path).
        {"id": 2, "building_name": "greenview",
         "micro_market": "", "representative_raw_message_id": 101,
         "tenant_id": "tenant-a"},
        # Has micro_market → default must NOT overwrite.
        {"id": 3, "building_name": "Shree Towers",
         "micro_market": "Wrong Market", "representative_raw_message_id": 102,
         "tenant_id": "tenant-a"},
        # Has micro_market but applies match what resolver says → "same".
        {"id": 4, "building_name": "Skyline Heights",
         "micro_market": "Bandra West", "representative_raw_message_id": 103,
         "tenant_id": "tenant-a"},
        # Empty micro_market, ultra-short link-only message → building-only lookup.
        {"id": 5, "building_name": "Shree Towers",
         "micro_market": "", "representative_raw_message_id": 104,
         "tenant_id": "tenant-a"},
    ]
    raw_messages = {
        100: {"id": 100, "message": "2 BHK available near Pali Hill", "tenant_id": "tenant-a"},
        101: {"id": 101, "message": "Need info", "tenant_id": "tenant-a"},
        102: {"id": 102, "message": "Anything in Bandra works", "tenant_id": "tenant-a"},
        103: {"id": 103, "message": "Skyline Heights is on Carter Road", "tenant_id": "tenant-a"},
        104: {"id": 104, "message": "https://youtu.be/x", "tenant_id": "tenant-a"},
    }
    parsed_rows = [
        # Both empty → eligible, micro_market + location_raw both filled.
        {"id": 11, "raw_message_id": 200, "location_raw": "", "building_name": "",
         "micro_market": "", "tenant_id": "tenant-a"},
        # Only location_raw missing → apply fills location_raw but NOT micro_market
        # (because micro_market already exists).
        {"id": 12, "raw_message_id": 201, "location_raw": "", "building_name": "Skyline Heights",
         "micro_market": "Bandra West", "tenant_id": "tenant-a"},
        # Only micro_market missing → apply should fill micro_market from text match
        # but leave location_raw at its existing value.
        {"id": 13, "raw_message_id": 202, "location_raw": "Pali Hill",
         "building_name": "", "micro_market": "", "tenant_id": "tenant-a"},
        # Both empty, building-name lookup via alias path → micro_market filled,
        # location_raw filled from clipped raw snippet.
        {"id": 14, "raw_message_id": 203, "location_raw": "", "building_name": "greenview",
         "micro_market": "", "tenant_id": "tenant-a"},
        # Both empty but resolver returns nothing → skipped.
        {"id": 15, "raw_message_id": 204, "location_raw": "", "building_name": "",
         "micro_market": "", "tenant_id": "tenant-a"},
    ]
    raw_messages.update({
        200: {"id": 200, "message": "Spacious 3 BHK flat near Pali Hill, fully furnished, contact 98xxxxxx21",
              "tenant_id": "tenant-a"},
        201: {"id": 201, "message": "Skyline Heights available now, please contact", "tenant_id": "tenant-a"},
        202: {"id": 202, "message": "Looking for 2 BHK near Pali Hill area, please share details", "tenant_id": "tenant-a"},
        203: {"id": 203, "message": "Greenview Apartments - 2 BHK apartment available from this weekend",
              "tenant_id": "tenant-a"},
        204: {"id": 204, "message": "ping me, brokers only", "tenant_id": "tenant-a"},
    })
    return listings_rows, raw_messages, parsed_rows


# ── apply listings: invariants ────────────────────────────────────────────


def test_apply_listings_only_fills_empty_micro_market(tmp_path):
    from registry.locality_resolver import LocalityResolver
    from backfill_localities import _apply_listings, _open_audit_csv

    listings_rows, raw_messages, _ = _build_apply_inputs()
    client = _FakeClient({
        "listings_unified": listings_rows,
        "raw_messages": list(raw_messages.values()),
    })
    resolver = LocalityResolver(db=None, reference=REFERENCE)
    audit_path = str(tmp_path / "audit.csv")
    audit, audit_fh = _open_audit_csv(audit_path)

    counters = _apply_listings(
        client, resolver,
        overwrite_existing=False,
        min_confidence="medium",
        dry_run=False,
        audit=audit,
        tenant_id="tenant-a",
    )
    audit_fh.close()

    # IDs 1, 2, 5 are eligible (empty micro_market).
    # ID 3 has a wrong-but-existing market and must NOT be touched.
    # ID 4 has the correct market already — must NOT be touched.
    assert counters["eligible"] == 3
    assert counters["updated"] == 3
    assert counters["skipped_existing"] == 2  # 3 and 4
    assert counters["errors"] == 0

    # Confirm update calls landed only on the eligible IDs in the correct order.
    update_calls = [
        (u["where"][1], u["payload"]) for u in client.updates
    ]
    assert {uid for uid, _ in update_calls} == {1, 2, 5}
    assert {(uid, payload["micro_market"]) for uid, payload in update_calls} == {
        (1, "Bandra West"),     # text match via Pali Hill
        (2, "Santacruz West"),  # alias greenview → canonical → buildings
        (5, "Andheri West"),    # ultra-short → building lookup only
    }


def test_apply_listings_with_overwrite_existing_touches_existing_rows(tmp_path):
    from registry.locality_resolver import LocalityResolver
    from backfill_localities import _apply_listings, _open_audit_csv

    listings_rows, raw_messages, _ = _build_apply_inputs()
    client = _FakeClient({"listings_unified": listings_rows, "raw_messages": list(raw_messages.values())})
    resolver = LocalityResolver(db=None, reference=REFERENCE)
    audit_path = str(tmp_path / "audit.csv")
    audit, audit_fh = _open_audit_csv(audit_path)

    counters = _apply_listings(
        client, resolver,
        overwrite_existing=True,
        min_confidence="medium",
        dry_run=False,
        audit=audit,
        tenant_id="tenant-a",
    )
    audit_fh.close()

    # With --overwrite-existing, IDs 1, 2, 3, 4, 5 are all eligible.
    # ID 1: long → text-match → Bandra West.
    # ID 2: ultra-short + alias path → Santacruz West.
    # ID 3: ultra-short + "Shree Towers" → Andheri West.
    # ID 4: long → text-fail → building lookup → "Skyline Heights" → Bandra West.
    # ID 5: ultra-short link-only → "Shree Towers" → Andheri West.
    assert counters["eligible"] == 5
    assert counters["updated"] == 5
    update_payloads = {
        u["where"][1]: u["payload"]["micro_market"]
            for u in client.updates
    }
    assert update_payloads == {
        1: "Bandra West",
        2: "Santacruz West",   # alias greenview → canonical → buildings
        3: "Andheri West",     # Shree Towers
        4: "Bandra West",      # Skyline Heights
        5: "Andheri West",     # Shree Towers (link-only building lookup)
    }


def test_apply_listings_low_confidence_filter_drops_resolved_suburb_x(tmp_path):
    from registry.locality_resolver import LocalityResolver
    from backfill_localities import _apply_listings, _open_audit_csv

    listings_rows = [
        {"id": 9, "building_name": "Mystery House", "micro_market": "",
         "representative_raw_message_id": 900, "tenant_id": "tenant-a"},
    ]
    raw_messages = [{
        "id": 900, "message": "come visit random suburb today", "tenant_id": "tenant-a"
    }]
    client = _FakeClient({"listings_unified": listings_rows, "raw_messages": raw_messages})
    resolver = LocalityResolver(db=None, reference=REFERENCE)
    audit_path = str(tmp_path / "audit.csv")
    audit, audit_fh = _open_audit_csv(audit_path)

    counters = _apply_listings(
        client, resolver,
        overwrite_existing=False,
        min_confidence="medium",
        dry_run=False,
        audit=audit,
        tenant_id="tenant-a",
    )
    audit_fh.close()

    assert counters["eligible"] == 0
    assert counters["updated"] == 0
    assert counters["skipped_low_confidence"] == 1
    assert client.updates == []  # nothing written


def test_apply_listings_dry_run_logs_air_no_db_writes(tmp_path):
    from registry.locality_resolver import LocalityResolver
    from backfill_localities import _apply_listings, _open_audit_csv

    listings_rows, raw_messages, _ = _build_apply_inputs()
    client = _FakeClient({"listings_unified": listings_rows, "raw_messages": list(raw_messages.values())})
    resolver = LocalityResolver(db=None, reference=REFERENCE)
    audit_path = str(tmp_path / "audit.csv")
    audit, audit_fh = _open_audit_csv(audit_path)

    counters = _apply_listings(
        client, resolver,
        overwrite_existing=False,
        min_confidence="medium",
        dry_run=True,
        audit=audit,
        tenant_id="tenant-a",
    )
    audit_fh.close()

    assert counters["eligible"] == 3
    assert counters["updated"] == 3
    assert client.updates == []  # dry-run never calls .update()

    # Audit log must mention each eligible row + before/after values.
    with open(audit_path, newline="") as f:
        rows = list(csv.DictReader(f))
    by_id = {int(r["row_id"]): r for r in rows}
    assert set(by_id.keys()) == {1, 2, 5}
    assert by_id[1]["old_micro_market"] == ""
    assert by_id[1]["new_micro_market"] == "Bandra West"
    assert by_id[1]["source"] == "text_reference_match"
    assert by_id[1]["matched_sub"] == "Pali Hill"
    assert by_id[2]["new_micro_market"] == "Santacruz West"
    assert by_id[2]["source"] == "building_name_aliases"


# ── apply parsed_output: span writes & invariant ─────────────────────────


def test_apply_parsed_output_writes_micro_market_and_matched_span_to_location_raw(tmp_path):
    from registry.locality_resolver import LocalityResolver
    from backfill_localities import _apply_parsed_output, _open_audit_csv

    _, raw_msgs_by_id, parsed_rows = _build_apply_inputs()
    client = _FakeClient({"parsed_output_unified": parsed_rows, "raw_messages": list(raw_msgs_by_id.values())})
    resolver = LocalityResolver(db=None, reference=REFERENCE)
    audit_path = str(tmp_path / "audit.csv")
    audit, audit_fh = _open_audit_csv(audit_path)

    counters = _apply_parsed_output(
        client, resolver,
        overwrite_existing=False,
        min_confidence="medium",
        dry_run=False,
        audit=audit,
        tenant_id="tenant-a",
    )
    audit_fh.close()

    # IDs 11 and 14 have empty micro_market AND empty location_raw → eligible.
    # ID 12 has micro_market already → skipped_existing.
    # ID 13 has location_raw already; micro_market empty AND overwrite_existing=False
    # checks current_market — empty → eligible, location_raw left untouched.
    # ID 14: alias path → micro_market filled.
    # ID 15 returns nothing → skipped_existing (resolver returned None).
    eligible_ids = {11, 13, 14}
    assert counters["eligible"] == len(eligible_ids)
    assert counters["updated"] == len(eligible_ids)
    assert counters["skipped_existing"] == 2  # ID 12 (market exists) + ID 15 (no decision)
    update_payloads = {u["where"][1]: u["payload"] for u in client.updates}
    assert set(update_payloads.keys()) == eligible_ids

    # ID 11: text-match path → location_raw filled with matched span "Pali Hill".
    assert update_payloads[11]["micro_market"] == "Bandra West"
    assert update_payloads[11]["location_raw"] == "Pali Hill"

    # ID 13: text-match path but location_raw already populated → DO NOT touch
    # location_raw (overwrite_existing=False was not on location_raw either,
    # but we explicitly only fill when _is_empty).
    assert update_payloads[13]["micro_market"] == "Bandra West"
    assert "location_raw" not in update_payloads[13]

    # ID 14: alias path → no matched span → location_raw filled with raw snippet.
    assert update_payloads[14]["micro_market"] == "Santacruz West"
    assert "Greenview" in update_payloads[14]["location_raw"]


def test_apply_parsed_output_audit_csv_includes_before_after_values(tmp_path):
    from registry.locality_resolver import LocalityResolver
    from backfill_localities import _apply_parsed_output, _open_audit_csv

    _, raw_msgs_by_id, parsed_rows = _build_apply_inputs()
    client = _FakeClient({"parsed_output_unified": parsed_rows, "raw_messages": list(raw_msgs_by_id.values())})
    resolver = LocalityResolver(db=None, reference=REFERENCE)
    audit_path = str(tmp_path / "audit.csv")
    audit, audit_fh = _open_audit_csv(audit_path)
    _apply_parsed_output(
        client, resolver,
        overwrite_existing=False, min_confidence="medium",
        dry_run=False, audit=audit, tenant_id="tenant-a",
    )
    audit_fh.close()

    with open(audit_path, newline="") as f:
        rows = list(csv.DictReader(f))
    by_id = {int(r["row_id"]): r for r in rows}
    assert by_id[11]["target_table"] == "parsed_output_unified"
    assert by_id[11]["old_micro_market"] == ""
    assert by_id[11]["new_micro_market"] == "Bandra West"
    assert by_id[11]["old_location_raw"] == ""
    assert by_id[11]["new_location_raw"] == "Pali Hill"
    assert by_id[11]["matched_sub"] == "Pali Hill"
    # audit log records the tenant intent — both the parsed_output row's
    # tenant_id and the --tenant-id CLI value agree.
    assert by_id[11]["tenant_id"] == "tenant-a"


# ── architectural safety: --apply requires --tenant-id ────────────────────


def test_run_apply_without_tenant_id_exits():
    """Cross-tenant apply is forbidden — see task constraint.

    ``run_apply`` must ``sys.exit`` BEFORE constructing ``SupabaseStorage``
    so a misconfigured CLI command never accidentally crosses tenants.
    """
    import backfill_localities
    with pytest.raises(SystemExit) as exc:
        backfill_localities.run_apply(
            target="both",
            tenant_id=None,
            overwrite_existing=False,
            min_confidence="medium",
            dry_run_apply=False,
            audit_csv="/tmp/never-written.csv",
        )
    assert "tenant-id" in str(exc.value).lower()


def test_run_apply_rejects_unknown_target():
    """``--target`` only accepts typed projection names or ``both``."""
    import backfill_localities
    with pytest.raises(SystemExit) as exc:
        backfill_localities.run_apply(
            target="bogus",
            tenant_id="tenant-a",
            overwrite_existing=False,
            min_confidence="medium",
            dry_run_apply=True,
            audit_csv="/tmp/never-written.csv",
        )
    assert "target" in str(exc.value).lower()


# ── provenance guarantee: alias → canonical → buildings is documented ────


def test_alias_path_records_medium_confidence_for_audit_review(resolver):
    """The audit log shows ``confidence=medium`` for alias-resolved rows so
    review can spot them. This is what makes `docs/DATA_QUALITY.md`'s
    'never guess' rule auditable after apply."""
    out = resolver.resolve_from_building("shree towers phase 2")
    assert out["resolved_locality"] == "Andheri West"
    assert out["confidence"] == "medium"
    assert out["source"] == "building_name_aliases"
