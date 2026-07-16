import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  "";
const supabaseServiceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  "";

let client: SupabaseClient | null = null;

export function getServerSupabase(): SupabaseClient | null {
  if (client) return client;
  if (!supabaseUrl || !supabaseServiceKey) {
    console.warn(
      "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set — www data queries will be skipped.",
    );
    return null;
  }
  client = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
