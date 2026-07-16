// Dump untagged listings (micro_market IS NULL) to /tmp/untagged.json for the
// Python deterministic dry-run. Read-only.
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";

const URL = "https://jsoiuzfwohtfkctlkozw.supabase.co";
const KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impzb2l1emZ3b2h0ZmtjdGxrb3p3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MzI2MTgzMywiZXhwIjoyMDk4ODM3ODMzfQ.LZEE8bXPjsONehNVqNJGM_iufIz9FUdV3z_S4GUmuEM";

async function main() {
  const db = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const all: any[] = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await db
      .from("listings")
      .select("id, location_label, landmark_name")
      .is("micro_market", null)
      .range(offset, offset + PAGE - 1);
    if (error) { console.error(error); process.exit(1); }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
  }
  writeFileSync("/tmp/untagged.json", JSON.stringify(all));
  console.log(`Dumped ${all.length} untagged rows to /tmp/untagged.json`);
}
main().catch((e) => { console.error(e); process.exit(1); });
