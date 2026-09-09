import { unstable_cache } from "next/cache";
import { getServerSupabase } from "./supabase";
import { summarizeLocalityInventory, type InventoryResponse } from "./locality-inventory";

export const getLocalityInventory = unstable_cache(async () => {
  const db = getServerSupabase();
  if (!db) throw new Error("Locality inventory database is not configured");
  const { data, error } = await db.rpc("get_public_locality_inventory");
  if (error) throw new Error(`Locality inventory aggregate unavailable: ${error.code}`);
  return summarizeLocalityInventory(data as InventoryResponse);
}, ["public-locality-inventory-v1"], { revalidate: 300 });
