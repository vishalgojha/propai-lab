// Card view-model tests for the public /search result cards.
// Run: npx tsx test/listing-card.test.ts
import assert from "node:assert/strict";
import {
  toListingCardViewModel,
  formatCardPrice,
  waLinkFor,
  buildListingSlug,
  isBrokerContactable,
  type ListingCardFields,
  type AdditionalCharge,
} from "../src/lib/listing-card";

function base(over: Partial<ListingCardFields>): ListingCardFields {
  return {
    id: 1,
    bhk: "3 BHK",
    price: 2.5,
    price_unit: "cr",
    area_sqft: 1450,
    furnishing: "Semi-furnished",
    intent: "sell",
    asset_type: null,
    property_type: null,
    micro_market: "Bandra East",
    building_name: null,
    landmark_name: null,
    location_label: null,
    floor_description: null,
    view: null,
    title: null,
    broker_name: "Acme Broker",
    broker_phone: "9123456789",
    last_seen: new Date().toISOString(),
    ...over,
  };
}

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

console.log("listing-card view model tests");

// Title never duplicates the bare locality in both title and subtitle.
check("building name is the title (locality only in pill)", () => {
  const vm = toListingCardViewModel(base({ building_name: "Kalpataru" }), true);
  assert.equal(vm.title, "Kalpataru");
  assert.equal(vm.locality, "Bandra East");
  assert.notEqual(vm.title, vm.locality);
});

check("no building name -> descriptive title from BHK + locality", () => {
  const vm = toListingCardViewModel(base({ building_name: null }), false);
  assert.equal(vm.title, "3 BHK — Bandra East");
  assert.equal(vm.locality, "Bandra East");
});

// Price always carries an explicit unit.
check("sale price with cr unit renders Cr", () => {
  const vm = toListingCardViewModel(base({ price: 2.5, price_unit: "cr", intent: "sell" }), false);
  assert.match(vm.priceLabel, /Cr$/);
});
check("rental price renders /month", () => {
  const vm = toListingCardViewModel(base({ price: 85000, price_unit: "abs", intent: "rent" }), false);
  assert.match(vm.priceLabel, /\/month$/);
});
check("lac unit renders Lakh", () => {
  const vm = toListingCardViewModel(base({ price: 1.4, price_unit: "Lac", intent: "sell" }), false);
  assert.match(vm.priceLabel, /Lakh$/);
});
check("null price -> Price on request (never bare number)", () => {
  const vm = toListingCardViewModel(base({ price: null, price_unit: null }), false);
  assert.equal(vm.priceLabel, "Price on request");
});
check("abs unit with no scale -> explicit ₹, not guessed lakh/cr", () => {
  const vm = toListingCardViewModel(base({ price: 37000, price_unit: "abs", intent: "commercial" }), false);
  assert.match(vm.priceLabel, /^₹[\d,]+$/);
  assert.equal(vm.priceLabel.match(/(Lakh|Cr|\/month)$/), null);
});

// Status badge is buyer-readable, not internal "Market pending".
check("micro_market present -> Available", () => {
  const vm = toListingCardViewModel(base({ micro_market: "Bandra East" }), false);
  assert.equal(vm.statusLabel, "Available");
  assert.equal(vm.statusTone, "available");
});
check("micro_market null -> Locality unconfirmed (not 'Market pending')", () => {
  const vm = toListingCardViewModel(base({ micro_market: null }), false);
  assert.equal(vm.statusLabel, "Locality unconfirmed");
  assert.equal(vm.statusTone, "unconfirmed");
});

// Recency label renamed to Updated (not Seen).
check("updatedLabel is a date string, not 'Seen'", () => {
  const vm = toListingCardViewModel(base({}), false);
  assert.ok(vm.updatedLabel.length > 0);
  assert.notEqual(vm.updatedLabel, "Unknown");
});

// Broker contact must not embed the phone in public HTML (DPDP Act 2023).
// waLinkFor now returns a server route that resolves the phone server-side.
check("waLinkFor returns the server redirect route (no phone in URL)", () => {
  assert.equal(waLinkFor(123), "/contact-broker/123");
});
check("waLinkFor(null) -> no link", () => {
  assert.equal(waLinkFor(null), null);
});
check("missing listing id -> no wa link (no dead CTA)", () => {
  const vm = toListingCardViewModel(base({ id: null as unknown as number }), false);
  assert.equal(vm.waLink, null);
});

// The reported repro: a 3BHK in a stated locality must yield cards that
// satisfy the public-format requirements.
check('"3 bhk in bandra east" card has non-duplicated title + unit price + status + CTA', () => {
  const vm = toListingCardViewModel(
    base({ bhk: "3 BHK", micro_market: "Bandra East", building_name: "Sky Heights", price: 3, price_unit: "cr", intent: "sell", broker_phone: "9988776655" }),
    true,
  );
  assert.equal(vm.title, "Sky Heights");
  assert.notEqual(vm.title, vm.locality);
  assert.match(vm.priceLabel, /Cr$/);
  assert.equal(vm.statusLabel, "Available");
  assert.equal(vm.waLink, "/contact-broker/1");
});

// Deal tags: whitelist enforced server-side too; here we verify the public
// card renders the right label + tone for each known tag and silently drops
// anything that isn't on the whitelist (defence-in-depth against bad DB rows).
check("deal_tags renders label + tone for whitelisted tags", () => {
  const vm = toListingCardViewModel(
    base({ deal_tags: ["distress_sale", "bank_auction", "negotiable"] }),
    false,
  );
  assert.equal(vm.dealTags.length, 3);
  assert.deepEqual(vm.dealTags.map((t) => t.tag), ["distress_sale", "bank_auction", "negotiable"]);
  assert.deepEqual(vm.dealTags.map((t) => t.label), ["Distress sale", "Bank auction", "Negotiable"]);
  // Tone classes are Tailwind class fragments; assert presence of the brand colour.
  assert.match(vm.dealTags[0].tone, /red/);
  assert.match(vm.dealTags[1].tone, /blue/);
  assert.match(vm.dealTags[2].tone, /emerald/);
});
check("deal_tags drops unknown values silently (no crash, no leak)", () => {
  const vm = toListingCardViewModel(
    base({ deal_tags: ["distress_sale", "liquidation", "URGENT_SALE", "  ", null as unknown as string] }),
    false,
  );
  // 'URGENT_SALE' is the same whitelist entry as 'urgent_sale' (case-insensitive).
  assert.equal(vm.dealTags.length, 2);
  assert.deepEqual(vm.dealTags.map((t) => t.tag), ["distress_sale", "urgent_sale"]);
});
check("deal_tags null/empty -> empty VM array", () => {
  const a = toListingCardViewModel(base({ deal_tags: null }), false);
  const b = toListingCardViewModel(base({ deal_tags: [] }), false);
  const c = toListingCardViewModel(base({}), false);
  assert.deepEqual(a.dealTags, []);
  assert.deepEqual(b.dealTags, []);
  assert.deepEqual(c.dealTags, []);
});

// Additional charges: fixed amounts render as '+ ₹XL' / '+ ₹XCr'; percent
// amounts render as 'N% of price'; malformed entries are dropped silently.
check("additional_charges renders fixed amounts with explicit unit", () => {
  const vm = toListingCardViewModel(
    base({
      additional_charges: [
        { label: "Society dues", amount: 1000000, amount_type: "fixed" },
        { label: "Professional fees", amount: 15000000, amount_type: "fixed" },
      ],
    }),
    false,
  );
  assert.equal(vm.additionalCharges.length, 2);
  assert.equal(vm.additionalCharges[0].label, "Society dues");
  assert.equal(vm.additionalCharges[0].amountLabel, "+ ₹10L");
  assert.equal(vm.additionalCharges[1].amountLabel, "+ ₹1.5Cr");
});
check("additional_charges renders percent_of_price as 'N% of price'", () => {
  const vm = toListingCardViewModel(
    base({
      additional_charges: [{ label: "Professional fees", amount: 3, amount_type: "percent_of_price" }],
    }),
    false,
  );
  assert.equal(vm.additionalCharges.length, 1);
  assert.equal(vm.additionalCharges[0].amountLabel, "3% of price");
});
check("additional_charges drops malformed entries silently", () => {
  const vm = toListingCardViewModel(
    base({
      additional_charges: [
        { label: "Society dues", amount: 1000000, amount_type: "fixed" },            // valid
        { label: "", amount: 100000, amount_type: "fixed" },                          // missing label
        { label: "Garbage" } as unknown as AdditionalCharge,                          // missing amount
        { label: "Bad", amount: 100000, amount_type: "weekly" } as unknown as AdditionalCharge, // bad amount_type
        { label: "NaN", amount: Number.NaN, amount_type: "fixed" },                   // non-finite amount
        null as unknown as AdditionalCharge,                                          // null entry
      ],
    }),
    false,
  );
  assert.equal(vm.additionalCharges.length, 1);
  assert.equal(vm.additionalCharges[0].label, "Society dues");
});
check("additional_charges null/empty -> empty VM array", () => {
  const a = toListingCardViewModel(base({ additional_charges: null }), false);
  const b = toListingCardViewModel(base({ additional_charges: [] }), false);
  const c = toListingCardViewModel(base({}), false);
  assert.deepEqual(a.additionalCharges, []);
  assert.deepEqual(b.additionalCharges, []);
  assert.deepEqual(c.additionalCharges, []);
});

// ── SEO slug (buildListingSlug) ────────────────────────────────────
//
// The public route /listings/[slug]/[id] uses this slug. Format is
// "{bhk-or-property-type}-{locality-or-empty}-{id}" — the id is always
// appended so the URL stays unique even when the prefix is empty.
check("buildListingSlug formats bhk + locality + id", () => {
  assert.equal(
    buildListingSlug({ id: 12345, bhk: "3 BHK", micro_market: "Bandra West" }),
    "3-bhk-bandra-west-12345",
  );
});
check("buildListingSlug falls back to building when locality missing", () => {
  assert.equal(
    buildListingSlug({ id: 319236, bhk: "3 BHK", micro_market: null, building_name: "Rajgriha CHS" }),
    "3-bhk-rajgriha-chs-319236",
  );
});
check("buildListingSlug returns just the id when no fields available", () => {
  assert.equal(buildListingSlug({ id: 999 }), "999");
  assert.equal(buildListingSlug({ id: 999, bhk: "", micro_market: "", building_name: "" }), "999");
});
check("buildListingSlug handles fractional bhk", () => {
  assert.equal(
    buildListingSlug({ id: 999, bhk: "2.5 BHK", micro_market: "Powai" }),
    "2-5-bhk-powai-999",
  );
});
check("buildListingSlug returns null for non-finite id", () => {
  assert.equal(buildListingSlug({ id: NaN as unknown as number, bhk: "3 BHK" }), null);
});
check("href uses slug not bare id", () => {
  const vm = toListingCardViewModel(
    base({ id: 319236, bhk: "3 BHK", micro_market: "Andheri West", building_name: "Rajgriha CHS" }),
    false,
  );
  assert.equal(vm.href, "/listings/3-bhk-andheri-west-319236");
  assert.equal(vm.slug, "3-bhk-andheri-west-319236");
});
check("href falls back to bare id when slug cannot be computed", () => {
  // NaN id produces a null slug and a null href.
  const vm = toListingCardViewModel(base({ id: NaN as unknown as number }), false);
  assert.equal(vm.href, null);
  assert.equal(vm.slug, null);
});

// ── waAvailable (broker contactability) ────────────────────────────
//
// Mirrors the server-side check in /api/contact-broker/[id] so the public
// card never shows a button that would just 302 back to the listing.
check("waAvailable true when broker_phone is 10 digits", () => {
  const vm = toListingCardViewModel(base({ broker_phone: "9123456789" }), false);
  assert.equal(vm.waAvailable, true);
});
check("waAvailable true when broker_phone has +91 prefix", () => {
  const vm = toListingCardViewModel(base({ broker_phone: "+91 9123456789" }), false);
  assert.equal(vm.waAvailable, true);
});
check("waAvailable false when broker_phone null", () => {
  const vm = toListingCardViewModel(base({ broker_phone: null }), false);
  assert.equal(vm.waAvailable, false);
});
check("waAvailable false when broker_phone too short", () => {
  const vm = toListingCardViewModel(base({ broker_phone: "12345" }), false);
  assert.equal(vm.waAvailable, false);
});
check("isBrokerContactable handles raw digits", () => {
  assert.equal(isBrokerContactable("9123456789"), true);
  assert.equal(isBrokerContactable("919123456789"), true);
  assert.equal(isBrokerContactable("+91 9123456789"), true);
  assert.equal(isBrokerContactable(null), false);
  assert.equal(isBrokerContactable(undefined), false);
  assert.equal(isBrokerContactable(""), false);
  assert.equal(isBrokerContactable("12345"), false);
});

console.log(`\n${passed} checks passed`);
