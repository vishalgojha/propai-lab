// Sanity check for the shared connection-health model (frontend/src/lib/connectionHealth.ts).
// Covers every branch of probeReading, phoneConnectionView and the connectionHealth
// aggregation that drives the connections-page header, including the anti-regression
// rule: a persisted/stored connection must NEVER show as freshly healthy when the
// live probe has failed, is unknown, or definitively reports offline.
// Usage: node --experimental-strip-types header-health-verify.mjs

import { probeReading, phoneConnectionView, connectionHealth } from "./src/lib/connectionHealth.ts";

let failures = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}\n      expected ${e}\n      actual   ${a}`);
  }
}

const LIVE_OK = { connected: true, status_available: true, state: "connected", phone: "+919820056180" };
const LIVE_OFF = { connected: false, status_available: true, state: "stopped", phone: null };
const PROBE_FAILED = { connected: false, status_available: false, state: null, phone: null };
const BASE = { phonesLoading: false, liveStatusChecked: true, phonesError: false, liveStatusError: false };

// --- probeReading ---
check("probe: unchecked before any probe settles", probeReading(null, false, false), "unchecked");
check("probe: failed probe with no reading", probeReading(null, true, false), "failed");
check("probe: failed probe with error flag", probeReading(null, true, true), "failed");
check("probe: definitive offline beats stored freshness", probeReading(LIVE_OFF, true, false), "offline");
check("probe: fresh live state is live", probeReading(LIVE_OK, true, false), "live");
check("probe: error flag with a payload still degrades to failed (never fresh)", probeReading(LIVE_OK, true, true), "failed");
check("probe: live but stale is stale", probeReading({ ...LIVE_OK, status_stale: true }, true, false), "stale");
check("probe: connecting state is pairing", probeReading({ ...LIVE_OK, connected: false, state: "connecting" }, true, false), "pairing");
check("probe: stale connecting is stale, not pairing", probeReading({ ...LIVE_OK, connected: false, state: "connecting", status_stale: true }, true, false), "stale");
check("probe: unknown shape is unknown", probeReading({ connected: false, status_available: true, state: null }, true, false), "unknown");

// --- phoneConnectionView ---
check("view: unchecked probe is checking", phoneConnectionView({ storedConnected: true, placeholder: false, matchesProbe: false, status: null, checked: false, error: false }), "checking");
check("view: live probe + match is connected", phoneConnectionView({ storedConnected: false, placeholder: false, matchesProbe: true, status: LIVE_OK, checked: true, error: false }), "connected");
check("view: connecting state is pairing", phoneConnectionView({ storedConnected: false, placeholder: false, matchesProbe: false, status: { ...LIVE_OK, connected: false, state: "connecting" }, checked: true, error: false }), "pairing");
check("view: REGRESSION stored row + failed probe is last-known, never healthy",
  phoneConnectionView({ storedConnected: true, placeholder: false, matchesProbe: false, status: PROBE_FAILED, checked: true, error: true }), "last-known");
check("view: REGRESSION stored row + failed probe + no status payload is last-known",
  phoneConnectionView({ storedConnected: true, placeholder: false, matchesProbe: false, status: null, checked: true, error: true }), "last-known");
check("view: definitive offline supersedes stored row",
  phoneConnectionView({ storedConnected: true, placeholder: false, matchesProbe: false, status: LIVE_OFF, checked: true, error: false }), "disconnected");
check("view: live probe for another phone does not confirm this stored row",
  phoneConnectionView({ storedConnected: true, placeholder: false, matchesProbe: false, status: LIVE_OK, checked: true, error: false }), "last-known");
check("view: unknown probe shape degrades to last-known, not healthy",
  phoneConnectionView({ storedConnected: true, placeholder: false, matchesProbe: false, status: { connected: false, status_available: true, state: null }, checked: true, error: false }), "last-known");
check("view: stale live probe + no stored row is unavailable",
  phoneConnectionView({ storedConnected: false, placeholder: false, matchesProbe: false, status: { ...LIVE_OK, status_stale: true }, checked: true, error: false }), "unavailable");
check("view: stale cached session matching the phone is last-known, never healthy",
  phoneConnectionView({ storedConnected: false, placeholder: false, matchesProbe: true, status: { ...LIVE_OK, status_stale: true }, checked: true, error: false }), "last-known");
check("view: no stored row + failed probe is unavailable",
  phoneConnectionView({ storedConnected: false, placeholder: false, matchesProbe: false, status: null, checked: true, error: true }), "unavailable");
check("view: placeholder with no stored row is unpaired",
  phoneConnectionView({ storedConnected: false, placeholder: true, matchesProbe: false, status: LIVE_OFF, checked: true, error: false }), "unpaired");
check("view: placeholder supersedes a stale stored row",
  phoneConnectionView({ storedConnected: true, placeholder: true, matchesProbe: false, status: LIVE_OFF, checked: true, error: false }), "unpaired");
check("view: live probe + placeholder (stale placeholder row) still confirms",
  phoneConnectionView({ storedConnected: false, placeholder: true, matchesProbe: true, status: LIVE_OK, checked: true, error: false }), "connected");

// --- connectionHealth aggregation ---
check("header: first load is checking", connectionHealth({ ...BASE, phonesLoading: true, views: [] }).status, "checking");
check("header: probe not settled yet is checking", connectionHealth({ ...BASE, liveStatusChecked: false, views: ["checking"] }).status, "checking");
check("header: one live-confirmed phone is healthy with count",
  connectionHealth({ ...BASE, views: ["connected", "unpaired"] }).detail, "1 connected");
check("header: phones fetch failure with no confirmation is a warning, not healthy", (() => {
  const h = connectionHealth({ ...BASE, phonesError: true, views: [] });
  return `${h.status}|${h.detail}|${h.unknown}`;
})(), "warning|Connection status unavailable|true");
check("header: stored row + failed probe is a warning, never healthy", (() => {
  const h = connectionHealth({ ...BASE, liveStatusError: true, views: ["last-known"] });
  return `${h.status}|${h.detail}|${h.unknown}`;
})(), "warning|Last known connected · live status unavailable|true");
check("header: unknown probe shape + stored row is the same warning", (() => {
  const h = connectionHealth({ ...BASE, views: ["last-known"] });
  return `${h.status}|${h.detail}|${h.unknown}`;
})(), "warning|Last known connected · live status unavailable|true");
check("header: live confirmed for one phone + stored-only for another is healthy with honest count",
  connectionHealth({ ...BASE, views: ["connected", "last-known"] }).detail, "1 connected");
check("header: total status failure is a warning, not a healthy flip", (() => {
  const h = connectionHealth({ ...BASE, liveStatusError: true, views: ["unavailable"] });
  return `${h.status}|${h.detail}|${h.unknown}`;
})(), "warning|Connection status unavailable|true");
check("header: pairing state surfaces as reconnecting warning", (() => {
  const h = connectionHealth({ ...BASE, views: ["pairing"] });
  return `${h.status}|${h.detail}`;
})(), "warning|Reconnecting…");
check("header: definitive offline is an error with 0 connected", (() => {
  const h = connectionHealth({ ...BASE, views: ["disconnected"] });
  return `${h.status}|${h.detail}`;
})(), "error|0 connected");
check("header: unpaired-only fleet is an error with 0 connected",
  connectionHealth({ ...BASE, views: ["unpaired"] }).detail, "0 connected");

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
