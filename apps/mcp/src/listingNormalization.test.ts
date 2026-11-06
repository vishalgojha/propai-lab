import assert from "node:assert/strict";
import test from "node:test";
import { clusterNormalizedListings, filterNormalizedListings, normalizeIndianRent, parseRawMessageListing } from "./listingNormalization.ts";

const fixtureMessages = [
  ["felicia", "Felicia - Bandra West - 3 BHK for rent - ₹4.0L - lower floor - fully furnished - 2 car parks"],
  ["terrace", "21st Road - Bandra West - 3 BHK for rent - 1100 sqft + 600 sqft terrace - ₹4.0L - pets allowed"],
  ["continental", "Continental Tower - Bandra West - 3 BHK for rent - 1565 sqft - ₹3.5L - fully furnished - 1 car park"],
  ["vaikunth", "Vaikunth - Mount Mary, Bandra West - 3 BHK for rent - ₹3.5L negotiable - furnished - 2 car parks"],
  ["beau", "Beau Pride - Hill Road, Bandra West - 3 BHK for rent - 1275 sqft - ₹3.5L - unfurnished - open to all communities"],
  ["martin", "St Martin's Road - Bandra West - 3 BHK for rent - 1253 sqft - ₹2.75L - furnished - 2 car parks"],
  ["konark", "Konark Classic - Bandra West - 3 BHK for rent - 1361 sqft - ₹2.75L - fully furnished - 1 car park"],
  ["almeida", "Almeida Park - Bandra West - 3 BHK for rent - 1200 sqft - ₹2.4L negotiable - semi furnished - 1 car park"],
  ["deepak", "Deepak Silvering - Bandra West - 3 BHK for rent - 1300 sqft - ₹2.3L - fully furnished - 1 car park"],
  ["reminess", "Reminess, Almeida Park - Bandra West - 3 BHK for rent - 1500 sqft - ₹2.0L (₹2.2L with parking) - pets allowed"],
  ["neelam", "Neelam Apartments - Bandra West - 3 BHK for rent - 1350 sqft - ₹2.1L - semi furnished"],
];

test("normalizes Indian rental amounts, including the common 3.60K typo", () => {
  assert.equal(normalizeIndianRent("3.50 lac"), 350000);
  assert.equal(normalizeIndianRent("350k"), 350000);
  assert.equal(normalizeIndianRent("3.5L"), 350000);
  assert.equal(normalizeIndianRent("₹2,00,000"), 200000);
  assert.equal(normalizeIndianRent("3.60K"), 360000);
});

test("splits a WhatsApp broadcast into atomic source-backed listings", () => {
  const rows = parseRawMessageListing({
    rawId: 900,
    group: "Bandra Brokers",
    timestamp: "2026-11-06T10:00:00.000Z",
    sender: "Broker A",
    text: "PREMIUM 3 BHK RENTAL INVENTORIES\n1. Felicia - Bandra West - 3 BHK - ₹4L\n2. Beau Pride - Hill Road, Bandra West - 3 BHK - ₹3.5L",
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.source_message_ids), [["900"], ["900"]]);
  assert.equal(rows[1].building, "Beau Pride");
  assert.equal(rows[1].rent_monthly_inr, 350000);
});

test("dedupes reposts into one listing with all brokers and a rent range", () => {
  const rows = ["₹3.25L", "₹3.5L", "₹3.5L"].flatMap((price, index) => parseRawMessageListing({
    rawId: `beau-${index + 1}`,
    group: `Group ${index + 1}`,
    timestamp: `2026-11-0${index + 1}T10:00:00.000Z`,
    sender: `Broker ${index + 1}`,
    phone: `900000000${index + 1}`,
    text: `Beau Pride - Hill Road, Bandra West - 3 BHK for rent - 1275 sqft - ${price} - unfurnished`,
  }));
  const clustered = clusterNormalizedListings(rows);
  assert.equal(clustered.length, 1);
  assert.equal(clustered[0].repost_count, 3);
  assert.deepEqual(clustered[0].rent_range_monthly_inr, { min: 325000, max: 350000 });
  assert.equal(clustered[0].brokers.length, 3);
  assert.equal(clustered[0].source_message_ids.length, 3);
});

test("Bandra/Khar ambiguous roads are flagged rather than guessed", () => {
  const [row] = parseRawMessageListing({ rawId: 901, text: "Rustomjee Paramount - 3 BHK - 14th Road, Bandra West / Khar West - ₹3.5L" });
  assert.equal(row.location_confidence, "ambiguous");
});

test("a revised quote supersedes the earlier price", () => {
  const rows = [
    parseRawMessageListing({ rawId: 910, timestamp: "2026-11-01T10:00:00Z", text: "Beau Pride - Bandra West - 3 BHK for rent - 1275 sqft - ₹3.25L" })[0],
    parseRawMessageListing({ rawId: 911, timestamp: "2026-11-02T10:00:00Z", text: "PRICE REVISED Beau Pride - Bandra West - 3 BHK for rent - 1275 sqft - ₹3.5L" })[0],
  ];
  const [row] = clusterNormalizedListings(rows);
  assert.equal(row.rent_monthly_inr, 350000);
  assert.equal(row.rent_range_monthly_inr, null);
  assert.equal(row.revised_quote, true);
});

test("fixture query yields at least ten distinct recent Bandra West rentals", () => {
  const rows = fixtureMessages.flatMap(([id, text], index) => parseRawMessageListing({
    rawId: id,
    group: "Bandra Brokers",
    timestamp: `2026-11-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`,
    sender: `Broker ${index + 1}`,
    text,
  }));
  const result = filterNormalizedListings(clusterNormalizedListings(rows), {
    locality: "Bandra West",
    transaction_type: "rent",
    bhk: 3,
    budget_max_inr: 400000,
  });
  assert.ok(result.length >= 10);
  assert.ok(result.every((row) => row.last_seen && row.brokers.length));
  assert.equal(result.some((row) => row.transaction_type === "sale"), false);
});
