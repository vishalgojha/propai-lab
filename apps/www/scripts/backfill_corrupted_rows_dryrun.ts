#!/usr/bin/env tsx
// Dry-run backfill: detect corrupted rows from the broker-name / parse-0 bugs.
// - broker_name is actually a known locality (should be cleared)
// - price === 0 with a non-null unit (parse failure, should be nulled)
// Run with APPLY=1 env to actually write. Default: dry-run (no writes).

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://jsoiuzfwohtfkctlkozw.supabase.co";
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impzb2l1emZ3b2h0ZmtjdGxrb3p3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MzI2MTgzMywiZXhwIjoyMDk4ODM3ODMzfQ.LZEE8bXPjsONehNVqNJGM_iufIz9FUdV3z_S4GUmuEM";

const KNOWN_LOCALITIES = [
  "Andheri East", "Andheri West", "Bandra East", "Bandra West", "Juhu", "Worli",
  "Khar", "Powai", "Goregaon", "Goregaon East", "Goregaon West", "Malad",
  "Borivali", "Kandivali", "Kandivali East", "Kandivali West", "Santacruz West",
  "Santacruz East", "Chembur", "Ghatkopar", "Thane", "Vashi", "Dadar",
  "Prabhadevi", "Lower Parel", "Wadala", "Kurla", "BKC", "Versova", "Lokhandwala",
  "Andheri", "Santacruz", "Bandra", "Malabar Hill", "Colaba", "Peddar Road",
  "Worli Sea Face", "Nepean Sea Road", "Breach Candy", "Tardeo", "Mazgaon",
  "Byculla", "Mahim", "Matunga", "Sion", "Mulund", "Bhayandar", "Mira Road",
  "Virar", "Vasai", "Panvel", "Kharghar", "Belapur", "Nerul", "Airoli",
  "Ghansoli", "Rabale", "Koparkhairane", "Ulwe", "Kamothe", "New Panvel",
  "Vile Parle", "Vile Parle East", "Vile Parle West", "Jogeshwari", "Oshiwara",
  "Jogeshwari East", "Jogeshwari West", "Goregaon", "Kandivali", "Borivali",
];

const APPLY = process.env.APPLY === "1";
const db = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  // 1. broker_name is a known locality
  const { data: brokerRows, error: e1 } = await db
    .from("listings")
    .select("id, broker_name, building_name")
    .in("broker_name", KNOWN_LOCALITIES);
  if (e1) throw e1;
  const brokerIds = (brokerRows ?? []).map((r) => r.id);
  console.log(`[broker] ${brokerIds.length} rows where broker_name is a locality`);
  if (APPLY && brokerIds.length) {
    const { error } = await db.from("listings").update({ broker_name: null }).in("id", brokerIds);
    if (error) throw error;
    console.log(`[broker] APPLIED: cleared broker_name on ${brokerIds.length} rows`);
  }

  // 2. price === 0 with a unit set (parse failure: e.g. "3:00 cr" -> 0)
  const { data: priceRows, error: e2 } = await db
    .from("listings")
    .select("id, price, price_unit, building_name")
    .eq("price", 0)
    .not("price_unit", "is", null);
  if (e2) throw e2;
  const priceIds = (priceRows ?? []).map((r) => r.id);
  console.log(`[price] ${priceIds.length} rows where price=0 with a unit`);
  if (APPLY && priceIds.length) {
    const { error } = await db
      .from("listings")
      .update({ price: null, price_unit: null })
      .in("id", priceIds);
    if (error) throw error;
    console.log(`[price] APPLIED: nulled price on ${priceIds.length} rows`);
  }

  if (!APPLY) {
    console.log("\nDRY-RUN only. Re-run with APPLY=1 to write changes.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
