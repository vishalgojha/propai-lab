/**
 * Client role. A client is a signed-in account with a row in client_accounts,
 * a table only the service role can write. The role is never read from
 * user/app metadata and never inferred from the absence of an organization.
 */
// Namespace import: resolved at call time so modules that only need the
// public surface do not require these exports at load.
import * as sb from "./supabase.js";

/** True only when an explicit client_accounts row exists. Throws on lookup errors so callers fail closed. */
export async function isClientAccount(userId: string): Promise<boolean> {
  const id = String(userId || "").trim();
  if (!id) return false;
  const { data, error } = await sb.supabase
    .from("client_accounts")
    .select("auth_user_id")
    .eq("auth_user_id", id)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data?.auth_user_id);
}

export function normalizeClientPhone(value: string): string | null {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return null;
  return digits;
}

export type ClientSignupInput = { email: string; password: string; fullName: string; phone: string };

/**
 * Create a client account. The response never reveals whether the email was
 * already registered: an existing account (which Supabase returns with no
 * identities) is left untouched and never gets a client row.
 */
export async function signupClient(input: ClientSignupInput): Promise<{ ok: true } | { ok: false; error: string }> {
  const email = String(input.email || "").trim().toLowerCase();
  const fullName = String(input.fullName || "").trim();
  const phone = normalizeClientPhone(input.phone);
  const password = String(input.password || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "Enter a valid email address." };
  if (!fullName || fullName.length > 120) return { ok: false, error: "Enter your name." };
  if (!phone) return { ok: false, error: "Enter a valid WhatsApp/mobile number with country code." };
  if (password.length < 8 || password.length > 200) return { ok: false, error: "Password must be at least 8 characters." };

  const { data, error } = await sb.newSignupAuthClient().auth.signUp({ email, password });
  if (error) {
    console.error("[client-signup] auth signUp failed:", error.status, error.code || "", error.message);
  }
  if (error) return { ok: false, error: "Could not create the account. Try again or use a different email." };
  const user = data.user;
  if (user && Array.isArray(user.identities) && user.identities.length > 0) {
    const a = await sb.supabase.from("client_accounts").upsert({ auth_user_id: user.id }, { onConflict: "auth_user_id" });
    if (a.error) throw new Error(a.error.message);
    const c = await sb.supabase.from("client_contacts").upsert(
      { auth_user_id: user.id, email, full_name: fullName, phone, updated_at: new Date().toISOString() },
      { onConflict: "auth_user_id" },
    );
    if (c.error) throw new Error(c.error.message);
  }
  return { ok: true };
}

/** Save/update the contact for an existing client. Caller must already be a verified client. */
export async function saveClientContact(user: { id: string; email?: string | null }, fullName: string, phone: string) {
  const { error } = await sb.supabase.from("client_contacts").upsert(
    { auth_user_id: user.id, email: user.email ?? null, full_name: fullName, phone, updated_at: new Date().toISOString() },
    { onConflict: "auth_user_id" },
  );
  if (error) throw new Error(error.message);
}
