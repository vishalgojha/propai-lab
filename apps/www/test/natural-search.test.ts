// Hermetic unit test for the NL-search locality filter.
// Run: npx tsx apps/www/test/natural-search.test.ts
// Verifies the reported bug fix: a stated locality is extracted and ENFORCED
// (never silently dropped into a broad BHK-only search), and a stated-but-
// unknown locality yields a "no matches" state instead of mixed results.

import assert from "node:assert/strict";
import {
  parseSearchQuery,
  matchesHardFilters,
  type ParsedNaturalSearch,
  type NaturalSearchRow,
} from "../src/lib/natural-search";
import type { LocalitySummary } from "../src/lib/localities";

const gazetteer: LocalitySummary[] = [
  { locality: "Bandra East", slug: "bandra-east", listingCount: 120 },
  { locality: "Bandra West", slug: "bandra-west", listingCount: 156 },
  { locality: "Andheri East", slug: "andheri-east", listingCount: 189 },
  { locality: "Andheri West", slug: "andheri-west", listingCount: 1000 },
  { locality: "Goregaon East", slug: "goregaon-east", listingCount: 90 },
  { locality: "Goregaon West", slug: "goregaon-west", listingCount: 98 },
];

function makeRow(over: Partial<NaturalSearchRow>): NaturalSearchRow {
  return {
    id: 1,
    intent: "rent",
    bhk: "3 BHK",
    price: 250000,
    price_unit: "l",
    area_sqft: 1200,
    furnishing: "furnished",
    floor_description: null,
    view: null,
    asset_type: null,
    property_type: null,
    location_label: null,
    building_name: null,
    landmark_name: null,
    micro_market: "Bandra East",
    broker_name: "Test",
    broker_phone: "0000000000",
    first_seen: null,
    last_seen: new Date().toISOString(),
    observation_count: 2,
    latitude: null,
    longitude: null,
    ...over,
  };
}

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

console.log("natural-search locality filter tests");

// 1. Compound locality "Bandra East" is extracted distinctly from "Bandra West".
check('parses "3 bhk in bandra east" -> locality === "Bandra East"', () => {
  const parsed = parseSearchQuery("3 bhk in bandra east", gazetteer);
  assert.equal(parsed.locality, "Bandra East");
  assert.equal(parsed.bhk, 3);
  assert.equal(parsed.localityStated, true);
});

// 1b. Display-layer extraction: statedLocalityText captures the locality
// phrase, NOT a mangled substring from the BHK/budget portion.
check('statedLocalityText for "3 bhk in bandra east" === "Bandra East"', () => {
  const parsed = parseSearchQuery("3 bhk in bandra east", gazetteer);
  assert.equal(parsed.statedLocalityText, "Bandra East");
  assert.notEqual(parsed.statedLocalityText, "3");
});

check('statedLocalityText for "2 bhk in goregaon west budget 2 lakh" === "Goregaon West"', () => {
  const parsed = parseSearchQuery("2 bhk in goregaon west budget 2 lakh", gazetteer);
  assert.equal(parsed.statedLocalityText, "Goregaon West");
});

check('statedLocalityText for "andheri east 1bhk" === "Andheri East" (no preposition)', () => {
  const parsed = parseSearchQuery("andheri east 1bhk", gazetteer);
  assert.equal(parsed.statedLocalityText, "Andheri East");
});

// 2. The hard filter actually enforces locality: a Bandra West row is rejected.
check("matchesHardFilters rejects non-matching locality even when BHK matches", () => {
  const parsed = parseSearchQuery("3 bhk in bandra east", gazetteer);
  const bandraWestRow = makeRow({ micro_market: "Bandra West" });
  const bandraEastRow = makeRow({ micro_market: "Bandra East" });
  assert.equal(matchesHardFilters(bandraWestRow, parsed), false);
  assert.equal(matchesHardFilters(bandraEastRow, parsed), true);
});

// 3. Bug repro: ALL returned cards must share the stated locality (no mixing).
check('"3 bhk in bandra east" never returns Bandra West / other localities', () => {
  const parsed = parseSearchQuery("3 bhk in bandra east", gazetteer);
  const rows = [
    makeRow({ id: 1, micro_market: "Bandra East" }),
    makeRow({ id: 2, micro_market: "Bandra West" }),
    makeRow({ id: 3, micro_market: "Andheri West" }),
    makeRow({ id: 4, micro_market: "Goregaon East" }),
  ];
  const kept = rows.filter((r) => matchesHardFilters(r, parsed));
  assert.ok(kept.length >= 1, "expected at least one in-locality match");
  for (const r of kept) {
    assert.equal(r.micro_market, "Bandra East");
  }
});

// 4. Stated-but-unknown locality -> localityStated true, locality null (no silent drop).
check('"3 bhk in bandra east" against gazetteer WITHOUT Bandra East -> unmatched, not broad', () => {
  const noBandraEast = gazetteer.filter((l) => l.locality !== "Bandra East");
  const parsed = parseSearchQuery("3 bhk in bandra east", noBandraEast);
  assert.equal(parsed.localityStated, true);
  assert.equal(parsed.locality, null);
});

// 5. Other compounds parse distinctly.
check('parses "2 bhk in goregaon west" -> "Goregaon West"', () => {
  const parsed = parseSearchQuery("2 bhk in goregaon west", gazetteer);
  assert.equal(parsed.locality, "Goregaon West");
  assert.equal(parsed.bhk, 2);
});

console.log(`\n${passed} checks passed`);
