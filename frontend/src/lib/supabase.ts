import { type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const isBuildTime = !supabaseUrl || !supabaseAnonKey;

function createMockSupabaseClient(): SupabaseClient {
  return {
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      getUser: async () => ({ data: { user: null }, error: null }),
      signInWithPassword: async () => ({ data: null, error: { message: "Build-time mock" } }),
      signInWithOtp: async () => ({ data: null, error: { message: "Build-time mock" } }),
      signUp: async () => ({ data: null, error: { message: "Build-time mock" } }),
      signOut: async () => ({ error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      exchangeCodeForSession: async () => ({ data: null, error: { message: "Build-time mock" } }),
    },
    from: () => ({
      select: () => ({ data: null, error: null }),
      insert: () => ({ data: null, error: null }),
      update: () => ({ data: null, error: null }),
      delete: () => ({ data: null, error: null }),
      eq: () => ({ data: null, error: null }),
      single: () => ({ data: null, error: null }),
    }),
  } as unknown as SupabaseClient;
}

export const supabase: SupabaseClient = isBuildTime
  ? createMockSupabaseClient()
  : require("@supabase/supabase-js").createClient(supabaseUrl, supabaseAnonKey);