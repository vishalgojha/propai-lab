import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  "";
const supabaseServiceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
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
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY && !process.env.SUPABASE_SERVICE_KEY) {
    console.warn(
      "Public www is using NEXT_PUBLIC_SUPABASE_ANON_KEY for server-side read queries; configure SUPABASE_SERVICE_KEY in production when available.",
    );
  }
  // Wrap fetch with a 45s timeout per request so stale connections don't hang.
  const fetchWithTimeout: typeof fetch = (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    return fetch(input, { ...init, signal: controller.signal }).finally(() =>
      clearTimeout(timer),
    );
  };

  client = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchWithTimeout },
  });
  return client;
}

export function slugify(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
