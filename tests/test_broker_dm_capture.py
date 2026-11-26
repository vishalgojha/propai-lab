"""Boundaries for opt-in broker direct-message capture.

Approved scope: property messages from broker contacts each user explicitly
selects, searchable only in their own account, never shared with other
brokers, fail-closed, consent wording versioned. These tests pin the
invariants across the Python policy module, the SQL migration and the Go
ingestor gate so a future change cannot silently widen the scope.
"""
import re
from pathlib import Path

import pytest

from broker_market_policy import DM_CAPTURE_TEXT, DM_CAPTURE_VERSION, normalize_dm_sender_phone

REPO = Path(__file__).resolve().parent.parent
MIGRATION = REPO / "supabase" / "migrations" / "20261126220000_broker_dm_capture_senders.sql"
GO_GATE = REPO / "services" / "whatsmeow-ingestor" / "dm_capture.go"
GO_INGEST = REPO / "services" / "whatsmeow-ingestor" / "raw_ingest.go"
SHARE_VIEW = next((REPO / "supabase" / "migrations").glob("20261120100000*.sql"))


@pytest.mark.parametrize("raw,expected", [
    ("+91 98123 45678", "919812345678"),
    ("919812345678@s.whatsapp.net", "919812345678"),
    ("919812345678:12@s.whatsapp.net", "919812345678"),
    ("919812345678.0:12@s.whatsapp.net", "919812345678"),
    ("9820056180", "9820056180"),
    ("(022) 4890-1234", "02248901234"),
    ("", ""),
    ("12345", ""),
    ("1234567890123456", ""),
    ("not-a-phone", ""),
])
def test_normalize_dm_sender_phone(raw, expected):
    assert normalize_dm_sender_phone(raw) == expected


def test_consent_wording_states_the_approved_scope():
    text = DM_CAPTURE_TEXT.lower()
    assert "direct messages" in text
    assert "select" in text
    assert "never shared" in text
    assert "only in my own account" in text
    # The filter-can-make-mistakes disclosure the user approved must stay.
    assert "filter can make mistakes" in text or "can make mistakes" in text
    # Removing a sender must be offered.
    assert "remove a sender" in text


def test_migration_exists_and_pins_consent_version():
    sql = MIGRATION.read_text()
    assert "create table public.broker_dm_capture_senders" in sql
    assert DM_CAPTURE_VERSION in sql
    assert f"version = '{DM_CAPTURE_VERSION}'" in sql
    # Phone storage is digits-only, 10-15.
    assert "sender_phone ~ '^[0-9]{10,15}$'" in sql


def test_migration_fails_closed():
    sql = MIGRATION.read_text()
    # Version is enforced before any write, enable requires the current wording.
    assert "if p_version is distinct from 'broker-dm-capture-v1'" in sql
    # Only active connections of the same tenant can designate senders.
    assert "c.is_active is not true" in sql
    # Reconnect / phone change / deactivation revokes designations (fail-closed).
    assert "create trigger broker_dm_capture_revoke_connection" in sql
    assert "new.is_active is not true" in sql
    # Nothing readable outside the service role.
    assert "revoke all on public.broker_dm_capture_senders from public,anon,authenticated" in sql


def test_go_gate_uses_same_consent_version():
    go = GO_GATE.read_text()
    match = re.search(r'defaultDMCaptureConsentVersion = "([^"]+)"', go)
    assert match, "Go ingestor must pin a default DM consent version"
    assert match.group(1) == DM_CAPTURE_VERSION


def test_go_gate_is_double_gated_and_fail_closed():
    go = GO_GATE.read_text()
    # Sender designation row must be active, current version, unrevoked.
    assert "s.revoked_at IS NULL" in go
    assert "owc.is_active" in go
    # Content gate requires at least two independent listing signals.
    assert "signals >= 2" in go
    # Deny is the default: lookup errors log and fail closed.
    assert "failing closed" in go


def test_ingest_drops_own_outgoing_and_non_listings_before_storage():
    ingest = GO_INGEST.read_text()
    # The owner's own replies in a DM are never captured.
    assert 'key["fromMe"]' in ingest
    # The content gate runs before the insert for DM rows.
    gate = ingest.index("looksLikePropertyListing(msgText)")
    insert = ingest.index("INSERT INTO public.raw_messages")
    assert gate < insert
    # Captured DMs never enter the extraction pipeline.
    dm_block = ingest[ingest.index("if !isGroup {", ingest.index("extractionSuppressed := isHistorySync")):]
    assert "processed = true" in dm_block and "extractionSuppressed = true" in dm_block


def test_cross_broker_surfaces_cannot_include_dm_rows():
    sql = SHARE_VIEW.read_text()
    view = sql[sql.index("create or replace view public.broker_market_eligible_source_rows"):]
    # The cross-broker view hard-filters to group rows joined on a group
    # consent row; DM rows (is_group=false, no consent row) are structurally
    # excluded.
    assert "r.is_group is true" in view
    assert "broker_market_raw_source_consents consent" in view
