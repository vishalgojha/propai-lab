import assert from "node:assert/strict";
import { listingDescription } from "../src/lib/seo-copy";

const description = listingDescription({
  dealType: "For sale",
  title: "3 BHK for Sale at Kalpataru Magnus",
  locality: "Bandra East",
  specRow: "Residential · 3 BHK · 1,350 sqft · Not specified",
  building: "Kalpataru Magnus",
  propertyType: "residential",
  areaSqft: 1350,
  priceLabel: "₹8.75 Cr",
});

assert.equal(
  description,
  "3 BHK for Sale at Kalpataru Magnus in Bandra East. 1,350 sqft carpet area.",
);
assert.doesNotMatch(description, /For sale at ₹8\.75 Cr/i);
assert.equal((description.match(/₹8\.75 Cr/g) ?? []).length, 0);
console.log("seo-copy regression passed");
