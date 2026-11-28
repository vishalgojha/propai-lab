from fastapi import HTTPException
"""Functional regression tests for the 15-day assistant trial.

Covers the user-approved semantics and review findings:
- The clock starts on the first SUCCESSFUL assistant search, exactly once;
  errored searches and scope failures never start it.
- Bookkeeping performs at most one read plus one guarded write per tenant per
  process (in-process cache), never blocks the event-loop path in endpoints.
- The window is 15 days; failures never break search responses.
- /api/market/access route output: access semantics preserved exactly
  (unlocked == paid_active or sync_ready, independent of trial state), and
  trial display state is truthful: not_started / active / expired / unknown,
  with read failures and malformed timestamps reporting "unknown", never a
  false "not_started".
- Naive timestamps are read as UTC.
- Connect copy never claims the trial starts on WhatsApp connect.

Run from the repo root:
    python3 -m pytest tests/test_assistant_trial_start.py -q
"""

import asyncio
from datetime import datetime, timedelta, timezone
from unittest import mock

import pytest

import routers.external_agent as external_agent
import routers.workspace as workspace


# ── Fake supabase client ─────────────────────────────────────────


class _FakeQuery:
    def __init__(self, table_name, db):
        self.table_name = table_name
        self.db = db
        self._op = None
        self._payload = None

    def update(self, payload):
        self._op = "update"
        self._payload = payload
        return self

    def select(self, columns):
        self._op = "select"
        return self

    def eq(self, column, value):
        return self

    def is_(self, column, value):
        self.db.setdefault("null_guards", []).append((column, value))
        return self

    def limit(self, n):
        return self

    def execute(self):
        self.db["calls"] = self.db.get("calls", 0) + 1
        if self._op == "update":
            self.db.setdefault("updates", []).append(self._payload)
            return mock.Mock(data=[])
        rows = self.db["tables"].get(self.table_name, [])
        return mock.Mock(data=list(rows))


class _FakeClient:
    def __init__(self, db):
        self.db = db

    def table(self, name):
        return _FakeQuery(name, self.db)


class _FakeStorage:
    def __init__(self, db):
        self.client = _FakeClient(db)


def _db(org_row=None, group_rows=None):
    return {
        "tables": {
            "organizations": [org_row] if org_row else [],
            "organization_group_connections": group_rows or [],
        }
    }


@pytest.fixture(autouse=True)
def clear_trial_cache():
    external_agent._trial_started_cache.clear()
    yield
    external_agent._trial_started_cache.clear()


# ── Trial bookkeeping helper ─────────────────────────────────────


def test_trial_start_writes_fifteen_day_window_with_null_guard():
    db = _db(org_row={"mcp_trial_started_at": None})
    with mock.patch.object(external_agent, "storage", _FakeStorage(db)):
        external_agent._record_assistant_trial_start("org-1")
    update = db["updates"][0]
    started = datetime.fromisoformat(update["mcp_trial_started_at"])
    ends = datetime.fromisoformat(update["mcp_trial_ends_at"])
    assert abs((ends - started) - timedelta(days=15)) < timedelta(seconds=1)
    assert ("mcp_trial_started_at", "null") in db["null_guards"]
    assert ("mcp_trial_ends_at", "null") in db["null_guards"]
    assert update["mcp_trial_started_via"] == "first_assistant_search"


def test_trial_start_skipped_when_already_started():
    db = _db(org_row={"mcp_trial_started_at": "2026-01-01T00:00:00+00:00"})
    with mock.patch.object(external_agent, "storage", _FakeStorage(db)):
        external_agent._record_assistant_trial_start("org-2")
    assert "updates" not in db  # existing cohort row untouched


def test_bookkeeping_cached_after_first_success():
    db = _db(org_row={"mcp_trial_started_at": None})
    with mock.patch.object(external_agent, "storage", _FakeStorage(db)):
        external_agent._record_assistant_trial_start("org-3")
        calls_after_first = db["calls"]
        external_agent._record_assistant_trial_start("org-3")
        external_agent._record_assistant_trial_start("org-3")
    assert db["calls"] == calls_after_first  # no repeat DB traffic per search


def test_trial_start_failure_never_raises_and_not_cached():
    class _BoomClient:
        def table(self, name):
            raise RuntimeError("db down")

    with mock.patch.object(external_agent, "storage", mock.Mock(client=_BoomClient())):
        external_agent._record_assistant_trial_start("org-4")  # must not raise
    assert "org-4" not in external_agent._trial_started_cache  # retried next time


# ── REST endpoint behavior (functional) ──────────────────────────


def _key(scopes):
    return {"tenant_id": "org-10", "scopes": scopes, "external_agent_dms_enabled": False}


def test_successful_listing_search_records_trial_start():
    db = _db(org_row={"mcp_trial_started_at": None})
    with mock.patch.object(external_agent, "storage", _FakeStorage(db)), mock.patch.object(
        external_agent, "_tenant_parsed", mock.AsyncMock(return_value=[])
    ):
        result = asyncio.run(external_agent.external_listing_search(limit=20, offset=0, key=_key(["inventory:read"])))
    assert {k: result[k] for k in ("results", "count", "offset")} == {"results": [], "count": 0, "offset": 0}  # empty success still counts
    assert result["search_scope"]["exhaustive"] is False
    assert len(db.get("updates", [])) == 1


def test_scope_failure_does_not_record_trial_start():
    db = _db(org_row={"mcp_trial_started_at": None})
    with mock.patch.object(external_agent, "storage", _FakeStorage(db)):
        with pytest.raises(Exception):
            asyncio.run(external_agent.external_listing_search(limit=20, offset=0, key=_key([])))
    assert "updates" not in db
    assert "org-10" not in external_agent._trial_started_cache


def test_errored_search_does_not_record_trial_start():
    db = _db(org_row={"mcp_trial_started_at": None})
    with mock.patch.object(external_agent, "storage", _FakeStorage(db)), mock.patch.object(
        external_agent, "_tenant_parsed", mock.AsyncMock(side_effect=RuntimeError("backend exploded"))
    ):
        with pytest.raises(HTTPException) as error:
            asyncio.run(external_agent.external_listing_search(limit=20, offset=0, key=_key(["inventory:read"])))
        assert error.value.status_code == 503
    assert "updates" not in db


def test_trial_status_endpoint_reads_without_writing():
    started = datetime.now(timezone.utc) - timedelta(days=5)
    ends = started + timedelta(days=15)
    db = _db(org_row={"mcp_trial_started_at": started.isoformat(), "mcp_trial_ends_at": ends.isoformat()})
    with mock.patch.object(workspace, "storage", _FakeStorage(db)):
        result = asyncio.run(external_agent.external_trial_status(key=_key([])))
    assert result["trial_state"] == "active"
    assert result["trial_days_total"] == 15
    assert 9 <= result["trial_days_left"] <= 10
    assert result["reminder_days_before_end"] == [3, 1]
    assert "updates" not in db  # read-only


# ── Trial display state ──────────────────────────────────────────


def test_trial_state_not_started():
    with mock.patch.object(workspace, "storage", _FakeStorage(_db())):
        state = workspace.assistant_trial_state("org-20")
    assert state["trial_state"] == "not_started"
    assert state["trial_active"] is False
    assert state["trial_first_search"] is False


def test_trial_state_active_and_expired():
    started = datetime.now(timezone.utc) - timedelta(days=3)
    ends = started + timedelta(days=15)
    with mock.patch.object(workspace, "storage", _FakeStorage(_db({"mcp_trial_started_at": started.isoformat(), "mcp_trial_ends_at": ends.isoformat()}))):
        assert workspace.assistant_trial_state("org-21")["trial_state"] == "active"

    old_start = datetime.now(timezone.utc) - timedelta(days=20)
    old_ends = old_start + timedelta(days=15)
    with mock.patch.object(workspace, "storage", _FakeStorage(_db({"mcp_trial_started_at": old_start.isoformat(), "mcp_trial_ends_at": old_ends.isoformat()}))):
        state = workspace.assistant_trial_state("org-22")
    assert state["trial_state"] == "expired"
    assert state["trial_active"] is False
    assert state["trial_ends_at"] == old_ends.isoformat()  # truthful dates kept


def test_end_without_start_is_indeterminate_and_preserved_on_read():
    # Partial record (an end with no start): never report not_started or
    # active, and never null out the stored end.
    row = {"mcp_trial_started_at": None, "mcp_trial_ends_at": "2027-01-01T00:00:00+00:00"}
    with mock.patch.object(workspace, "storage", _FakeStorage(_db(row))):
        state = workspace.assistant_trial_state("org-28")
    assert state["trial_state"] == "unknown"
    assert state["trial_active"] is False
    assert state["trial_started_at"] is None
    assert state["trial_ends_at"] == "2027-01-01T00:00:00+00:00"
    assert state["trial_first_search"] is None


def test_partial_record_never_overwritten_on_search():
    # The first successful search must not start a new clock over a partial
    # record: both stored fields are preserved.
    row = {"mcp_trial_started_at": None, "mcp_trial_ends_at": "2027-01-01T00:00:00+00:00"}
    db = _db(org_row=row)
    with mock.patch.object(external_agent, "storage", _FakeStorage(db)):
        external_agent._record_assistant_trial_start("org-29")
    assert "updates" not in db
    assert "org-29" in external_agent._trial_started_cache


def test_started_without_expiry_is_legacy_not_active():
    # Legacy rows from before the 15-day window have a start but no recorded
    # end: the end date is indeterminate. Never claim an active 15-day trial.
    row = {"mcp_trial_started_at": "2026-01-01T00:00:00+00:00", "mcp_trial_ends_at": None}
    with mock.patch.object(workspace, "storage", _FakeStorage(_db(row))):
        state = workspace.assistant_trial_state("org-27")
    assert state["trial_state"] == "legacy"
    assert state["trial_active"] is False
    assert state["trial_started_at"] == row["mcp_trial_started_at"]
    assert state["trial_ends_at"] is None
    assert state["trial_first_search"] is None


def test_naive_timestamps_read_as_utc():
    started = datetime.now(timezone.utc) - timedelta(days=1)
    ends = started + timedelta(days=15)
    naive_row = {
        "mcp_trial_started_at": started.replace(tzinfo=None).isoformat(),
        "mcp_trial_ends_at": ends.replace(tzinfo=None).isoformat(),
    }
    with mock.patch.object(workspace, "storage", _FakeStorage(_db(naive_row))):
        assert workspace.assistant_trial_state("org-23")["trial_state"] == "active"


def test_malformed_timestamps_report_unknown_not_false_states():
    bad_row = {"mcp_trial_started_at": "not-a-date", "mcp_trial_ends_at": "also-not-a-date"}
    with mock.patch.object(workspace, "storage", _FakeStorage(_db(bad_row))):
        state = workspace.assistant_trial_state("org-24")
    assert state["trial_state"] == "unknown"
    assert state["trial_active"] is False
    assert state["trial_started_at"] is None

    bad_end = {"mcp_trial_started_at": datetime.now(timezone.utc).isoformat(), "mcp_trial_ends_at": "garbage"}
    with mock.patch.object(workspace, "storage", _FakeStorage(_db(bad_end))):
        state = workspace.assistant_trial_state("org-25")
    assert state["trial_state"] == "unknown"
    assert state["trial_active"] is False


def test_read_failure_reports_unknown():
    class _BoomClient:
        def table(self, name):
            raise RuntimeError("db down")

    with mock.patch.object(workspace, "storage", mock.Mock(client=_BoomClient())):
        state = workspace.assistant_trial_state("org-26")
    assert state["trial_state"] == "unknown"
    assert state["trial_started_at"] is None


def test_old_seven_day_both_dates_row_is_not_a_recorded_first_search():
    # Pre-existing cohort: auth-era start with a 7-day window. Dates are
    # honored for display, but nothing may call this a recorded first search,
    # and the reported window must be the actual recorded 7 days, not 15.
    started = datetime.now(timezone.utc) - timedelta(days=3)
    row = {
        "mcp_trial_started_at": started.isoformat(),
        "mcp_trial_ends_at": (started + timedelta(days=7)).isoformat(),
        "mcp_trial_started_via": None,
    }
    with mock.patch.object(workspace, "storage", _FakeStorage(_db(row))):
        state = workspace.assistant_trial_state("org-31")
        assert state["trial_state"] == "active"
        assert state["trial_first_search"] is None
        assert state["trial_started_via"] is None
        result = asyncio.run(external_agent.external_trial_status(key=_key([])))
    assert result["trial_days_total"] == 7  # actual recorded window, never the new-cohort 15
    assert result["trial_first_search"] is None


def test_old_seven_day_expired_row_is_not_a_recorded_first_search():
    started = datetime.now(timezone.utc) - timedelta(days=20)
    row = {
        "mcp_trial_started_at": started.isoformat(),
        "mcp_trial_ends_at": (started + timedelta(days=7)).isoformat(),
        "mcp_trial_started_via": None,
    }
    with mock.patch.object(workspace, "storage", _FakeStorage(_db(row))):
        state = workspace.assistant_trial_state("org-32")
    assert state["trial_state"] == "expired"
    assert state["trial_first_search"] is None


def test_first_search_marker_proves_search_started_clock():
    started = datetime.now(timezone.utc) - timedelta(days=2)
    row = {
        "mcp_trial_started_at": started.isoformat(),
        "mcp_trial_ends_at": (started + timedelta(days=15)).isoformat(),
        "mcp_trial_started_via": "first_assistant_search",
    }
    with mock.patch.object(workspace, "storage", _FakeStorage(_db(row))):
        state = workspace.assistant_trial_state("org-33")
        assert state["trial_state"] == "active"
        assert state["trial_first_search"] is True
        result = asyncio.run(external_agent.external_trial_status(key=_key([])))
    assert result["trial_days_total"] == 15
    assert result["trial_first_search"] is True


# ── /api/market/access route output ──────────────────────────────


def _run_market_access(connected, sync_ready, org_row, group_rows):
    db = _db(org_row=org_row, group_rows=group_rows)
    details = {"connected": connected, "connected_since": "2026-01-01T00:00:00+00:00"}
    with mock.patch.object(workspace, "storage", _FakeStorage(db)), mock.patch.object(
        workspace, "_connection_details", lambda: details
    ), mock.patch.object(workspace, "_market_sync_ready", lambda d: sync_ready), mock.patch.object(
        workspace, "_business_api_get_config_value", lambda *a, **k: None
    ):
        return asyncio.run(workspace.market_access_status(user={"id": "u1"}, tenant_id="org-30"))


def test_access_unlocked_semantics_preserved_disconnected_with_active_trial():
    started = datetime.now(timezone.utc) - timedelta(days=1)
    row = {"mcp_trial_started_at": started.isoformat(), "mcp_trial_ends_at": (started + timedelta(days=15)).isoformat()}
    result = _run_market_access(connected=False, sync_ready=False, org_row=row, group_rows=[])
    # An active trial alone must NOT unlock the market: only synced data does.
    assert result["market_unlocked"] is False
    assert result["trial_state"] == "active"
    assert result["reason"] == "connect_whatsapp"
    assert "start your trial" not in result["message"]


def test_access_unlocked_with_synced_data_regardless_of_trial():
    result = _run_market_access(connected=True, sync_ready=True, org_row=None, group_rows=[])
    assert result["market_unlocked"] is True
    assert result["trial_state"] == "not_started"


def test_access_reports_group_confirmation_separately_from_sync():
    confirmed = _run_market_access(
        connected=True, sync_ready=True, org_row=None, group_rows=[{"group_jid": "g1@g.us"}]
    )
    assert confirmed["market_groups_confirmed"] is True
    unconfirmed = _run_market_access(connected=True, sync_ready=True, org_row=None, group_rows=[])
    assert unconfirmed["market_groups_confirmed"] is False
