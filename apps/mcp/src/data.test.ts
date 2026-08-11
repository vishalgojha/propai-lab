import assert from "node:assert/strict";
import test from "node:test";
import { buildMcpTypedListing, mcpVisibilityFromOrganization, toMarketSearchRow } from "./data.ts";

const base = {
  brokerId: "broker-user",
  tenantId: "00000000-0000-0000-0000-000000000001",
  raw_text: "3 BHK for rent in Bandra East at 85000",
  title: "Bandra East 3BHK",
  bhk: 3,
  location: "Bandra East",
  price: 85000,
  carpet_area: 1200,
  furnishing: "semi furnished",
  possession_date: "2026-09-01",
  name: "Owner",
  phone: "9876543210",
  contact_number: "9876543210",
} as const;

test("MCP residential rent mapping targets the rent table", () => {
  const result = buildMcpTypedListing(
    { ...base, deposit_amount: "255000", asset_type: "residential", transaction_type: "rent" },
    { source: "mcp" },
    "fingerprint",
    42,
  );

  assert.equal(result.table, "residential_rent_listings");
  assert.equal(result.row.summary_title, "Bandra East 3BHK");
  assert.equal(result.row.tenant_id, base.tenantId);
  assert.equal(result.row.visibility, "shared_market");
  assert.equal(result.row.source_scope, "mcp");
  assert.equal(result.row.raw_message_id, 42);
  assert.equal(result.row.monthly_rent, 85000);
  assert.equal(result.row.deposit_amount, 255000);
  assert.equal(result.row.available_from, "2026-09-01");
  assert.equal("possession_date" in result.row, false);
});

test("MCP typed mapping can preserve a private workspace visibility", () => {
  const result = buildMcpTypedListing(
    { ...base, asset_type: "commercial", transaction_type: "rent" },
    { source: "mcp" },
    "private-fingerprint",
    48,
    { visibility: "workspace_private", source_scope: "mcp" },
  );
  assert.equal(result.row.visibility, "workspace_private");
  assert.equal(result.row.source_scope, "mcp");
});

test("MCP visibility follows the organization sharing decision", () => {
  assert.equal(mcpVisibilityFromOrganization({ privacy_mode: "shared_market", share_listings: true }).visibility, "shared_market");
  assert.equal(mcpVisibilityFromOrganization({ privacy_mode: "private", share_listings: true }).visibility, "workspace_private");
  assert.equal(mcpVisibilityFromOrganization({ privacy_mode: "shared_market", share_listings: false }).visibility, "workspace_private");
});

test("MCP residential sale mapping uses sale price and possession fields", () => {
  const result = buildMcpTypedListing(
    { ...base, price: "2 Cr", asset_type: "residential", transaction_type: "sale" },
    { source: "mcp" },
    "fingerprint",
    43,
  );

  assert.equal(result.table, "residential_sale_listings");
  assert.equal(result.row.total_asking_price, 20_000_000);
  assert.equal(result.row.possession_date, "2026-09-01");
  assert.equal("monthly_rent" in result.row, false);
});

test("MCP commercial sale mapping never writes residential or rent fields", () => {
  const result = buildMcpTypedListing(
    { ...base, price: "₹100 per sqft", asset_type: "commercial", transaction_type: "sale" },
    { source: "mcp" },
    "commercial-sale-fingerprint",
    44,
  );

  assert.equal(result.table, "commercial_sale_listings");
  assert.equal(result.row.total_asking_price, 120000);
  assert.equal(result.row.price_per_sqft, 100);
  assert.equal("monthly_rent" in result.row, false);
  assert.equal("rent_per_sqft" in result.row, false);
  assert.equal("deposit_amount" in result.row, false);
  assert.equal("bhk" in result.row, false);
  assert.equal("configuration_type" in result.row, false);
  assert.equal(result.row.commercial_use_type, "mixed_use");
  assert.equal("available_from" in result.row, false);
});

test("MCP commercial rent mapping never writes residential or sale fields", () => {
  const result = buildMcpTypedListing(
    { ...base, price: "₹100 per sqft", deposit_amount: 360000, asset_type: "commercial", transaction_type: "rent" },
    { source: "mcp" },
    "commercial-rent-fingerprint",
    45,
  );

  assert.equal(result.table, "commercial_rent_listings");
  assert.equal(result.row.monthly_rent, 120000);
  assert.equal(result.row.rent_per_sqft, 100);
  assert.equal(result.row.deposit_amount, 360000);
  assert.equal("total_asking_price" in result.row, false);
  assert.equal("price_per_sqft" in result.row, false);
  assert.equal("bhk" in result.row, false);
  assert.equal("configuration_type" in result.row, false);
  assert.equal(result.row.commercial_use_type, "mixed_use");
  assert.equal("available_from" in result.row, false);
});

test("MCP sale mappings ignore deposit_amount because sale tables lack that column", () => {
  const residential = buildMcpTypedListing(
    { ...base, deposit_amount: "255000", asset_type: "residential", transaction_type: "sale" },
    { source: "mcp" },
    "residential-sale-deposit-fingerprint",
    46,
  );
  const commercial = buildMcpTypedListing(
    { ...base, deposit_amount: 360000, asset_type: "commercial", transaction_type: "sale" },
    { source: "mcp" },
    "commercial-sale-deposit-fingerprint",
    47,
  );

  assert.equal("deposit_amount" in residential.row, false);
  assert.equal("deposit_amount" in commercial.row, false);
});

test("market search keeps BHK numeric in structured results", () => {
  const result = toMarketSearchRow({
    source_message_id: "123:0",
    source_group_name: null,
    listing_type: "listing_rent",
    area: "Bandra East",
    sub_area: "Bandra East",
    location: "Bandra East",
    price: 85000,
    price_type: "month",
    size_sqft: 1200,
    furnishing: null,
    bhk: 3,
    property_type: "rent",
    title: "Example Building",
    description: null,
    raw_message: null,
    cleaned_message: null,
    primary_contact_name: null,
    primary_contact_number: null,
    primary_contact_wa: null,
    message_timestamp: null,
    created_at: null,
  });

  assert.equal(result.bhk, 3);
  assert.equal(typeof result.bhk, "number");
});
