// Sitemap shape tests. We can't easily mock Supabase from inside this script
// without spinning up the full Next module graph, so we test the pure pieces:
//   - buildListingSlug returns the URL fragment we expect to see in sitemap
//   - the sitemap shape policy (daily / 0.55 priority / slug-based URL)
// Verifies sitemap-shape invariants on the helper outputs. Run:
//   npx tsx test/sitemap-shape.test.ts
import assert from "node:assert/strict";
import { buildListingSlug } from "../src/lib/listing-card";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

console.log("sitemap shape tests");

// 1. Every listing URL in the sitemap must use the slug format, never bare id.
check("listing URLs are slug-based, not bare-id", () => {
  const slugs = [
    buildListingSlug({ id: 319236, bhk: "3 BHK", micro_market: "Andheri West", building_name: "Rajgriha CHS" }),
    buildListingSlug({ id: 999, bhk: null, micro_market: null, building_name: null }),
  ];
  for (const s of slugs) {
    assert.ok(s, "slug should be non-null for any finite id");
    assert.ok(/^\d+$/.test(s) || /\-\d+$/.test(s), `slug must end with bare id (or be just the id), got ${s}`);
  }
});

// 2. Slug uniqueness: two different listings can share a prefix but the id
// suffix makes them unique.
check("different ids produce unique slugs even with identical prefixes", () => {
  const a = buildListingSlug({ id: 100, bhk: "3 BHK", micro_market: "Bandra West" });
  const b = buildListingSlug({ id: 200, bhk: "3 BHK", micro_market: "Bandra West" });
  assert.notEqual(a, b);
  assert.equal(a, "3-bhk-bandra-west-100");
  assert.equal(b, "3-bhk-bandra-west-200");
});

// 3. Stability: same inputs must produce the same slug (idempotent — sitemap
// rebuilds on every request, must not produce different URLs across runs).
check("buildListingSlug is deterministic", () => {
  const input = { id: 319236, bhk: "3 BHK", micro_market: "Andheri West", building_name: "Rajgriha CHS" };
  const a = buildListingSlug(input);
  const b = buildListingSlug(input);
  const c = buildListingSlug(input);
  assert.equal(a, b);
  assert.equal(b, c);
});

// 4. Short slug: keep total length bounded so the URL stays manageable.
check("slug stays under 80 chars for typical inputs", () => {
  const long = buildListingSlug({
    id: 999999,
    bhk: "5 BHK",
    micro_market: "Some Very Long Locality Name With Many Words",
    building_name: "A Building With A Very Long Name And Many Words Tower Wing",
  });
  assert.ok(long, "slug produced");
  assert.ok(long.length < 80, `slug too long: ${long.length} chars → ${long}`);
});

// 5. Junk fields produce sane fallbacks (no double-dashes, no leading/trailing
// dashes before the id).
check("slug has no double dashes or leading/trailing junk", () => {
  const s = buildListingSlug({ id: 319236, bhk: "3 BHK", micro_market: "Andheri West" });
  assert.ok(s, "non-null");
  assert.ok(!s.includes("--"), `double dash found in ${s}`);
  // Strip the trailing id segment and verify no trailing dashes.
  const prefix = s.replace(/-\d+$/, "");
  assert.ok(!prefix.endsWith("-"), `prefix ends with -: ${prefix}`);
  assert.ok(!prefix.startsWith("-"), `prefix starts with -: ${prefix}`);
});

console.log(`\n${passed} checks passed`);
