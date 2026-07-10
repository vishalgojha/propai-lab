import { type SupabaseClient, type User, type Session } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

// During build (next build), credentials aren't available in Coolify
// Check if we have real credentials - if not, we're at build time
const isBuildTime = !supabaseUrl || !supabaseAnonKey;

// Create a minimal mock client for build time that doesn't make network requests
function createMockSupabaseClient(): SupabaseClient {
  const mockAuth = {
    getSession: async () => ({ data: { session: null }, error: null }),
    getUser: async () => ({ data: { user: null }, error: null }),
    signInWithPassword: async () => ({ data: null, error: { message: "Build-time mock" } }),
    signInWithOtp: async () => ({ data: null, error: { message: "Build-time mock" } }),
    signUp: async () => ({ data: null, error: { message: "Build-time mock" } }),
    signOut: async () => ({ error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    exchangeCodeForSession: async () => ({ data: null, error: { message: "Build-time mock" } }),
  };

  return {
    auth: mockAuth,
  } as unknown as SupabaseClient;
}

let supabase: SupabaseClient | null = null;

function getSupabaseOrThrow(): SupabaseClient {
  if (isBuildTime) {
    if (!supabase) {
      supabase = createMockSupabaseClient();
    }
    return supabase;
  }

  // Dynamic import to avoid issues at build time
  const { createClient } = require("@supabase/supabase-js");
  if (!supabase) {
    supabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  }
  return supabase;
}

export function getSupabase(): SupabaseClient {
  return getSupabaseOrThrow();
}

export async function signInWithEmail(email: string, password: string) {
  const { data, error } = await getSupabase().auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signInWithMagicLink(email: string, redirectTo?: string) {
  const { data, error } = await getSupabase().auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: redirectTo || `${window.location.origin}/auth/callback`,
    },
  });
  if (error) throw error;
  return data;
}

export async function signUp(email: string, password: string, redirectTo?: string, fullName?: string) {
  const { data, error } = await getSupabase().auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: redirectTo || `${window.location.origin}/auth/callback`,
      data: fullName ? { full_name: fullName } : undefined,
    },
  });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await getSupabase().auth.signOut();
  if (error) throw error;
}

export async function getSession(): Promise<Session | null> {
  const { data } = await getSupabase().auth.getSession();
  return data.session;
}

export async function getUser(): Promise<User | null> {
  const { data } = await getSupabase().auth.getUser();
  return data.user;
}

export function onAuthStateChange(callback: (event: string, session: Session | null) => void) {
  return getSupabase().auth.onAuthStateChange(callback);
}

export async function getAccessToken(): Promise<string | null> {
  const session = await getSession();
  return session?.access_token ?? null;
}