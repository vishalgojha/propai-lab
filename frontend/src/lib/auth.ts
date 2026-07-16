import { createClient, type SupabaseClient, type User, type Session } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required");
}

let supabase: SupabaseClient | null = null;
let cachedSession: Session | null = null;
let sessionLoaded = false;
let sessionRequest: Promise<Session | null> | null = null;

function getSupabaseOrThrow(): SupabaseClient {
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
  cachedSession = data.session;
  sessionLoaded = true;
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

export async function signUp(
  email: string,
  password: string,
  redirectTo?: string,
  fullName?: string,
  workspaceName?: string,
) {
  const { data, error } = await getSupabase().auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: redirectTo || `${window.location.origin}/auth/callback`,
      data: {
        ...(fullName ? { full_name: fullName } : {}),
        ...(workspaceName ? { workspace_name: workspaceName } : {}),
      },
    },
  });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await getSupabase().auth.signOut();
  if (error) throw error;
  cachedSession = null;
  sessionLoaded = true;
}

export async function getSession(): Promise<Session | null> {
  if (sessionLoaded) return cachedSession;
  if (!sessionRequest) {
    sessionRequest = getSupabase().auth.getSession().then(({ data, error }) => {
      if (error) throw error;
      cachedSession = data.session;
      sessionLoaded = true;
      return cachedSession;
    }).finally(() => {
      sessionRequest = null;
    });
  }
  return sessionRequest;
}

export async function getUser(): Promise<User | null> {
  const { data } = await getSupabase().auth.getUser();
  return data.user;
}

export function onAuthStateChange(callback: (event: string, session: Session | null) => void) {
  return getSupabase().auth.onAuthStateChange((event, session) => {
    cachedSession = session;
    sessionLoaded = true;
    callback(event, session);
  });
}

export async function getAccessToken(): Promise<string | null> {
  const session = await getSession();
  return session?.access_token ?? null;
}
