import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

// Lazily create the admin client so importing this module never throws at
// build time (Next.js evaluates route handlers during `next build`, where the
// service-role key may not be present). At runtime the env vars are injected.
export function getSupabaseAdmin(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and a Supabase service-role key are required");
  }
  client = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  return client;
}

// Backward-compatible accessor: `supabaseAdmin.from(...)` etc. still work, but
// the underlying client is only created on first use (avoids build-time throws).
export const supabaseAdmin: SupabaseClient = new Proxy(
  {} as SupabaseClient,
  { get: (_t, prop) => getSupabaseAdmin()[prop as keyof SupabaseClient] },
);
