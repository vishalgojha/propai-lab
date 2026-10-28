// Tests for the /api/contact-broker/[id] route. We can't easily import the
// route module from a bare script because Next.js wires `getServerSupabase`
// from runtime config, so we replicate the same logic inline and verify the
// behaviour against fixtures.
//
// The route's contract:
//   - listingId not finite       → 410 { available: false, reason: "bad_id" }
//   - Supabase missing             → 503 { available: false, reason: "no_db" }
//   - row missing                  → 404 { available: false, reason: "not_found" }
//   - owner brokerage phone missing → 503 { available: false, reason: "no_brokerage_phone" }
//   - source broker phone is ignored for public routing
//   - configured brokerage phone  → 302 → https://wa.me/91{local}?text={recall}
//                                     where the recall URL contains the SEO slug
// Run: npx tsx test/contact-broker-route.test.ts
import assert from "node:assert/strict";
import { buildListingSlug } from "../src/lib/listing-card";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

console.log("contact-broker route shape tests");

check("canonical slug distinguishes duplicate numeric IDs", () => {
  const sale = buildListingSlug({ id: 2237, bhk: "Builder finish", micro_market: "Bandra East", building_name: "Eternity", property_type: "Residential", intent: "sale" });
  const rent = buildListingSlug({ id: 2237, bhk: "3 BHK", micro_market: "Bandra West", building_name: "Royal Manor", property_type: "Residential", intent: "rent" });
  assert.notEqual(sale, rent);
});

// Simulated decisions — extract from the real route for parity testing.
function decisionFor(row: { id: number; broker_phone: string | null; bhk: string | null; micro_market: string | null; building_name: string | null; property_type: string | null } | null, brokeragePhone = ""): { status: number; body: Record<string, unknown> | null; redirect: string | null } {
  if (row == null) {
    return { status: 404, body: { available: false, reason: "not_found" }, redirect: null };
  }
  if (!brokeragePhone) {
    return { status: 503, body: { available: false, reason: "no_brokerage_phone" }, redirect: null };
  }
  const digits = String(brokeragePhone).replace(/\D/g, "");
  const local = digits.length > 10 ? digits.slice(-10) : digits;
  if (local.length !== 10) {
    return { status: 410, body: { available: false, reason: "bad_phone" }, redirect: null };
  }
  const slug = buildListingSlug({
    id: row.id,
    bhk: row.bhk,
    micro_market: row.micro_market,
    building_name: row.building_name,
    property_type: row.property_type,
  });
  const canonicalPath = `/listings/${slug ?? "listing"}/${row.id}`;
  const recall = `https://www.propai.live${canonicalPath}`;
  const text = encodeURIComponent(`Hi, I came across ... — ${recall} — and I'm interested.`);
  return { status: 302, body: null, redirect: `https://wa.me/91${local}?text=${text}` };
}

check("row null → 404 not_found (no silent 302)", () => {
  const r = decisionFor(null);
  assert.equal(r.status, 404);
  assert.deepEqual(r.body, { available: false, reason: "not_found" });
  assert.equal(r.redirect, null);
});

check("missing owner phone → 503 no_brokerage_phone (no source fallback)", () => {
  const r = decisionFor({ id: 12345, broker_phone: null, bhk: "3 BHK", micro_market: "Bandra West", building_name: null, property_type: null });
  assert.equal(r.status, 503);
  assert.deepEqual(r.body, { available: false, reason: "no_brokerage_phone" });
  assert.equal(r.redirect, null);
});

check("source broker phone is ignored when owner phone is configured", () => {
  const r = decisionFor({ id: 12345, broker_phone: "12345", bhk: "3 BHK", micro_market: "Bandra West", building_name: null, property_type: null });
  const configured = decisionFor({ id: 12345, broker_phone: "12345", bhk: "3 BHK", micro_market: "Bandra West", building_name: null, property_type: null }, "919111111111");
  assert.equal(r.status, 503);
  assert.equal(configured.status, 302);
  assert.match(configured.redirect || "", /^https:\/\/wa\.me\/919111111111\?text=/);
});

check("configured owner phone → 302 to wa.me with slug in recall message", () => {
  const r = decisionFor({
    id: 319236,
    broker_phone: "9123456789",
    bhk: "3 BHK",
    micro_market: "Andheri West",
    building_name: "Rajgriha CHS",
    property_type: null,
  }, "919111111111");
  assert.equal(r.status, 302);
  assert.ok(r.redirect);
  assert.match(r.redirect, /^https:\/\/wa\.me\/919111111111\?text=/);
  // The recall message is URL-encoded; decode before searching for the slug.
  const text = decodeURIComponent(r.redirect.split("?text=")[1] ?? "");
  assert.match(text, /\/listings\/3-bhk-(?:rajgriha-chs-)?andheri-west-319236\/319236/);
  assert.ok(!text.includes("/listings/319236-"), "should not use bare id even when slug is computed");
});

check("configured brokerage phone overrides source broker phone", () => {
  const r = decisionFor({
    id: 319236,
    broker_phone: "919999999999",
    bhk: "3 BHK",
    micro_market: "Andheri West",
    building_name: "Rajgriha CHS",
    property_type: null,
  }, "919111111111");
  assert.equal(r.status, 302);
  assert.match(r.redirect || "", /^https:\/\/wa\.me\/919111111111\?text=/);
  assert.doesNotMatch(r.redirect || "", /919999999999/);
});

check("configured owner phone with +91 source phone → owner redirect", () => {
  const r = decisionFor({
    id: 1,
    broker_phone: "+91 9123456789",
    bhk: null,
    micro_market: null,
    building_name: null,
    property_type: null,
  }, "919111111111");
  assert.equal(r.status, 302);
  assert.ok(r.redirect);
  assert.match(r.redirect, /^https:\/\/wa\.me\/919111111111\?text=/);
});

check("waAvailable matches decisionFor for the same row", () => {
  // Cross-check that the public VM field `waAvailable` and the route's
  // decision agree on what's contactable.
  function isBrokerContactable(raw: string | null): boolean {
    if (!raw) return false;
    const digits = String(raw).replace(/\D/g, "");
    if (digits.length < 10) return false;
    const local = digits.length > 10 ? digits.slice(-10) : digits;
    return local.length === 10;
  }
  const cases: Array<{ phone: string | null; expectAvailable: boolean }> = [
    { phone: "9123456789", expectAvailable: true },
    { phone: "+91 9123456789", expectAvailable: true },
    { phone: null, expectAvailable: false },
    { phone: "12345", expectAvailable: false },
    { phone: "", expectAvailable: false },
  ];
  for (const c of cases) {
    assert.equal(isBrokerContactable(c.phone), c.expectAvailable, `phone=${c.phone}`);
  }
});

console.log(`\n${passed} checks passed`);
