import assert from "node:assert/strict";
import test from "node:test";
import { classifyMarketIntent, extractMarketParams } from "./marketSearch.ts";

test("market parser keeps the full locality before a budget range", () => {
  const params = extractMarketParams("3 BHK for rent in Bandra West between 2-3 lakh");
  assert.equal(params.bhk, 3);
  assert.equal(params.locality, "Bandra West");
  assert.equal(params.propertyType, "rent");
  assert.equal(params.minPriceCr, 0.02);
  assert.equal(params.maxPriceCr, 0.03);
  assert.equal(classifyMarketIntent("3 BHK for rent in Bandra West"), "listing_search");
});
