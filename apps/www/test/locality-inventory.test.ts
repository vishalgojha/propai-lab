import assert from "node:assert/strict";
import { summarizeLocalityInventory, type InventoryResponse } from "../src/lib/locality-inventory";

const base: InventoryResponse = {
  as_of: "2026-09-10T00:00:00.000Z", window_days: 30,
  registry: [{ sub_locality: "Pali Hill", parent_locality: "Bandra West", canonical_locality: "Bandra West", city: "Mumbai", alternate_names: ["Pali Hill"] }],
  groups: [],
};
const group = (over: Partial<InventoryResponse["groups"][number]>) => ({
  micro_market: "Pali Hill", locality_resolved: null, locality_raw: null,
  card_type: "residential_rent", configuration: "2 BHK", listing_count: 1201,
  active_24h: 4, last_seen: "2026-09-09T23:00:00.000Z", priced_count: 2,
  min_price: 100000, max_price: 150000, ...over,
});
const result = summarizeLocalityInventory({ ...base, groups: [group({}), group({ card_type: "residential_sale", configuration: "3 BHK", listing_count: 2, priced_count: 0, min_price: null, max_price: null })] });
assert.equal(result.totalRecords, 1203);
assert.equal(result.localities[0].locality, "Bandra West");
assert.equal(result.localities[0].listingCount, 1203);
assert.equal(result.localities[0].rentCount, 1201);
assert.equal(result.localities[0].saleCount, 2);
assert.equal(result.localities[0].segments[0].count, 1201);
const unknown = summarizeLocalityInventory({ ...base, groups: [group({ micro_market: "Unreviewed text", listing_count: 3 })] });
assert.equal(unknown.totalRecords, 3);
assert.equal(unknown.unmappedRecords, 3);
assert.equal(unknown.localities.length, 0);
console.log("locality inventory tests passed");
