// Card view-model tests for the public /search result cards.
// Run: npx tsx test/listing-card.test.ts
import assert from "node:assert/strict";
import {
  toListingCardViewModel,
  formatCardPrice,
  waLinkFor,
  type ListingCardFields,
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

console.log(`\n${passed} checks passed`);
