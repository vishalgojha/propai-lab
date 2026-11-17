import assert from "node:assert/strict";
import test from "node:test";
import { computeExistingMcpTrialState } from "./supabase.ts";

const NOW = new Date("2026-11-17T10:00:00.000Z").getTime();

test("no row or no recorded start means no existing trial", () => {
  assert.equal(computeExistingMcpTrialState(null, NOW), null);
  assert.equal(
    computeExistingMcpTrialState({ mcp_trial_started_at: null, mcp_trial_ends_at: null }, NOW),
    null,
  );
});

test("a recorded start without a recorded end is never reported active", () => {
  // Legacy rows predate the 15-day window; the end date is indeterminate.
  const state = computeExistingMcpTrialState(
    { mcp_trial_started_at: "2026-10-01T00:00:00.000Z", mcp_trial_ends_at: null },
    NOW,
  );
  assert.equal(state?.active, false);
  assert.equal(state?.started_at, "2026-10-01T00:00:00.000Z");
  assert.equal(state?.ends_at, null);
});

test("a malformed start timestamp is never reported active, even with a future end", () => {
  // Parity with the Python trial state: both fields must parse before
  // anything counts as active. The record itself is preserved untouched.
  const state = computeExistingMcpTrialState(
    { mcp_trial_started_at: "not-a-date", mcp_trial_ends_at: "2026-11-25T00:00:00.000Z" },
    NOW,
  );
  assert.equal(state?.active, false);
  assert.equal(state?.started_at, "not-a-date");
  assert.equal(state?.ends_at, "2026-11-25T00:00:00.000Z");
});

test("a malformed end timestamp is never reported active", () => {
  const state = computeExistingMcpTrialState(
    { mcp_trial_started_at: "2026-11-01T00:00:00.000Z", mcp_trial_ends_at: "not-a-date" },
    NOW,
  );
  assert.equal(state?.active, false);
});

test("start provenance is passed through and never inferred", () => {
  const marked = computeExistingMcpTrialState(
    {
      mcp_trial_started_at: "2026-11-16T00:00:00.000Z",
      mcp_trial_ends_at: "2026-12-01T00:00:00.000Z",
      mcp_trial_started_via: "first_assistant_search",
    },
    NOW,
  );
  assert.equal(marked?.started_via, "first_assistant_search");
  // A pre-existing row with an identical 15-day window but no marker is NOT
  // a recorded first search: provenance stays unknown, never guessed.
  const unmarked = computeExistingMcpTrialState(
    { mcp_trial_started_at: "2026-11-16T00:00:00.000Z", mcp_trial_ends_at: "2026-12-01T00:00:00.000Z" },
    NOW,
  );
  assert.equal(unmarked?.started_via, null);
});

test("a future recorded end is active, a past one is not", () => {
  const future = computeExistingMcpTrialState(
    { mcp_trial_started_at: "2026-11-10T00:00:00.000Z", mcp_trial_ends_at: "2026-11-25T00:00:00.000Z" },
    NOW,
  );
  assert.equal(future?.active, true);
  const past = computeExistingMcpTrialState(
    { mcp_trial_started_at: "2026-10-20T00:00:00.000Z", mcp_trial_ends_at: "2026-11-04T00:00:00.000Z" },
    NOW,
  );
  assert.equal(past?.active, false);
});
