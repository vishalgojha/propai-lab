import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import dotenv from "dotenv";
import ws from "ws";
import type { AuthenticatedUser } from "./types.js";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || "";
const anonKey = process.env.SUPABASE_ANON_KEY || "";
const MCP_CONNECTOR_PROVIDER = "propai_mcp";
const MCP_TOKEN_SECRET_SOURCE =
  process.env.MCP_TOKEN_ENCRYPTION_SECRET ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.JWT_SECRET ||
  "";

function missingClient(name: string) {
  return new Proxy({}, {
    get() {
      throw new Error(`${name} is not configured. Set SUPABASE_URL and a Supabase API key.`);
    },
  }) as ReturnType<typeof createClient>;
}

function buildClient(key: string, name: string) {
  if (!supabaseUrl || !key) {
    console.warn(`${name} is not configured. Set SUPABASE_URL and a Supabase API key.`);
    return missingClient(name);
  }

  return createClient(supabaseUrl, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    realtime: {
      transport: ws as any,
    } as any,
  });
}

export const supabase = buildClient(serviceKey || anonKey, "PropAI MCP Supabase service client");

export const supabaseAuth = buildClient(anonKey || serviceKey, "PropAI MCP Supabase auth client");

function normalizeEmail(value?: string | null) {
  return String(value || "").trim().toLowerCase();
}

function isMissingWorkspaceMembershipSchemaError(error: unknown) {
  const candidate = error as { code?: string; message?: string; details?: string; hint?: string } | null;
  const haystack = [
    candidate?.message,
    candidate?.details,
    candidate?.hint,
  ]
    .map((value) => String(value || "").toLowerCase())
    .join(" ");

  return candidate?.code === "42P01"
    || candidate?.code === "42703"
    || haystack.includes("workspace_members")
    || haystack.includes("schema cache")
    || haystack.includes("does not exist")
    || haystack.includes("updated_at")
    || haystack.includes("joined_at")
    || haystack.includes("last_active_at")
    || haystack.includes("assigned_session_labels")
    || haystack.includes("preferred_session_label");
}

/**
 * Actor/attribution id only. It is never a data scope: every tenant filter
 * uses the membership organization from resolveTenantIdForUser.
 *
 * Nothing the user can edit and nothing stale is trusted: user_metadata and
 * app_metadata claims are ignored, and email-only or merely invited
 * memberships are not honored. A workspace owner is used only when an active
 * workspace_members row names this immutable user id; otherwise the user's own
 * id is the actor.
 */
export async function resolveBrokerIdForUser(user?: AuthenticatedUser | null) {
  const currentUserId = String(user?.id || "").trim();
  if (!currentUserId) return null;

  try {
    const byUserId = await supabase
      .from("workspace_members")
      .select("workspace_owner_id, status")
      .eq("member_user_id", currentUserId)
      .eq("status", "active")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (byUserId.error) {
      if (!isMissingWorkspaceMembershipSchemaError(byUserId.error)) {
        console.warn("Failed to resolve MCP broker id by user id:", byUserId.error.message);
      }
    } else if (byUserId.data?.workspace_owner_id && byUserId.data.status === "active") {
      return String(byUserId.data.workspace_owner_id);
    }
  } catch (error) {
    console.warn("Unexpected error resolving MCP broker id:", error instanceof Error ? error.message : error);
  }

  return currentUserId;
}

/** Resolve the organization that owns writes for this authenticated MCP user.
 * The auth user id/broker id is not an organizations.id and must never be
 * passed as tenant_id. Membership is the authoritative scope relationship.
 */
export async function resolveTenantIdForUser(user?: AuthenticatedUser | null) {
  const currentUserId = String(user?.id || "").trim();
  if (!currentUserId) return null;

  try {
    const { data, error } = await supabase
      .from("organization_members")
      .select("organization_id, created_at")
      .eq("user_id", currentUserId)
      .eq("is_active", true)
      .order("created_at", { ascending: true })
      .limit(2);
    if (error) throw new Error(error.message);
    if (!data?.length) return null;
    if (data.length > 1) {
      console.warn("MCP user belongs to multiple organizations; refusing to guess a write tenant");
      return null;
    }
    return data[0]?.organization_id ? String(data[0].organization_id) : null;
  } catch (error) {
    console.warn("Failed to resolve MCP tenant id:", error instanceof Error ? error.message : error);
    return null;
  }
}

/** Start the 15-day assistant trial exactly once for this organization, on its first substantive search. */
export function computeExistingMcpTrialState(
  row: {
    mcp_trial_started_at: string | null;
    mcp_trial_ends_at: string | null;
    mcp_trial_started_via?: string | null;
  } | null,
  now: number = Date.now(),
) {
  // Null only means "no trial recorded at all" (no row or both dates
  // absent) - the sole case where a new trial may be written. A partial
  // record (one date without the other) is indeterminate: both stored
  // fields are returned preserved and the row is never overwritten.
  if (!row || (!row.mcp_trial_started_at && !row.mcp_trial_ends_at)) return null;
  const endsAt = row.mcp_trial_ends_at;
  const endsMs = endsAt ? new Date(endsAt).getTime() : NaN;
  const startMs = row.mcp_trial_started_at ? new Date(row.mcp_trial_started_at).getTime() : NaN;
  // A recorded start without a parseable recorded end is a legacy row from
  // before the 15-day window: its end date is indeterminate, so never
  // report it as an active 15-day trial. A partial record without a start
  // is never active either.
  const active = Number.isFinite(startMs) && Number.isFinite(endsMs) && endsMs > now;
  // Provenance passthrough: only "first_assistant_search" rows are recorded
  // first searches; anything else is unknown, never inferred from dates.
  return { started_at: row.mcp_trial_started_at, ends_at: endsAt, active, started_via: row.mcp_trial_started_via ?? null };
}

export async function ensureMcpTrial(tenantId: string) {
  const { data, error } = await supabase
    .from("organizations")
    .select("mcp_trial_started_at, mcp_trial_ends_at, mcp_trial_started_via")
    .eq("id", tenantId)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const existing = computeExistingMcpTrialState(data);
  if (existing) {
    return existing;
  }

  const startedAt = new Date();
  const endsAt = new Date(startedAt.getTime() + 15 * 24 * 60 * 60 * 1000);
  const { error: updateError } = await supabase
    .from("organizations")
    .update({
      mcp_trial_started_at: startedAt.toISOString(),
      mcp_trial_ends_at: endsAt.toISOString(),
      mcp_trial_started_via: "first_assistant_search",
    })
    .eq("id", tenantId)
    .is("mcp_trial_started_at", null)
    .is("mcp_trial_ends_at", null);
  if (updateError) throw new Error(updateError.message);
  return { started_at: startedAt.toISOString(), ends_at: endsAt.toISOString(), active: true };
}

/**
 * Fire-and-forget trial start after a successful assistant search. Call this
 * only after the search has actually returned; errored attempts must not
 * start the clock. Bookkeeping failures never affect the search response.
 */
export function recordAssistantSearchSuccess(tenantId: string) {
  void ensureMcpTrial(tenantId).catch((error) => {
    console.warn("Unable to initialize MCP trial metadata:", error instanceof Error ? error.message : error);
  });
}

function hashMcpConnectorToken(token: string) {
  return `sha256:${crypto.createHash("sha256").update(token).digest("hex")}`;
}

function getMcpTokenSecret() {
  if (!MCP_TOKEN_SECRET_SOURCE) {
    throw new Error("MCP token encryption secret is not configured");
  }

  return crypto.createHash("sha256").update(MCP_TOKEN_SECRET_SOURCE).digest();
}

function decryptMcpConnectorToken(value: string) {
  if (!value.startsWith("enc:")) {
    return null;
  }

  const payload = value.slice(4);
  const [ivPart, tagPart, encryptedPart] = payload.split(".");
  if (!ivPart || !tagPart || !encryptedPart) {
    throw new Error("Stored MCP token is malformed");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getMcpTokenSecret(),
    Buffer.from(ivPart, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedPart, "base64url")),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

async function verifyStaticConnectorToken(token: string) {
  const { data: storedKeys, error: keyError } = await supabase
    .from("api_keys")
    .select("tenant_id, key")
    .eq("provider", MCP_CONNECTOR_PROVIDER)
    .limit(1000);

  if (keyError || !storedKeys?.length) {
    throw new Error(keyError?.message || "Invalid token");
  }

  const tokenDigest = hashMcpConnectorToken(token);
  const storedKey = storedKeys.find((candidate) => {
    if (candidate.key === tokenDigest) {
      return true;
    }

    if (typeof candidate.key !== "string" || !candidate.key.startsWith("enc:")) {
      return false;
    }

    try {
      const decryptedToken = decryptMcpConnectorToken(candidate.key);
      return decryptedToken === token;
    } catch {
      return false;
    }
  });

  if (!storedKey?.tenant_id) {
    throw new Error("Invalid token");
  }

  const { data, error } = await supabase.auth.admin.getUserById(storedKey.tenant_id);
  if (error || !data.user) {
    throw new Error(error?.message || "Invalid token");
  }

  return {
    ...data.user,
    broker_id: data.user.id,
  };
}

export async function verifyPropAIToken(token: string) {
  const { data, error } = await supabase.auth.getUser(token);
  if (!error && data.user) {
    return {
      ...data.user,
      broker_id: data.user.id,
    };
  }

  const appSession = verifyAppSessionToken(token);
  if (appSession) {
    return {
      id: appSession.sub,
      broker_id: appSession.sub,
      email: appSession.email,
      aud: "authenticated",
      role: "authenticated",
      app_metadata: { provider: "propai" },
      user_metadata: {
        full_name: appSession.full_name,
        phone: appSession.phone,
        app_role: appSession.app_role,
      },
      created_at: new Date().toISOString(),
    } as AuthenticatedUser;
  }

  return verifyStaticConnectorToken(token);
}

type AppSessionPayload = {
  typ: "propai-app-session";
  sub: string;
  email: string;
  phone?: string | null;
  full_name?: string | null;
  app_role?: string | null;
  iat: number;
  exp: number;
};

function base64UrlDecode(input: string) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function getJwtSecret() {
  return process.env.JWT_SECRET || process.env.SUPABASE_JWT_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
}

function verifyAppSessionToken(token: string): AppSessionPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, signature] = parts;
  const secret = getJwtSecret();
  if (!secret) return null;

  const data = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(data)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

  if (signature.length !== expectedSignature.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) return null;

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload)) as AppSessionPayload;
    if (!payload || payload.typ !== "propai-app-session") return null;

    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(payload.exp) || payload.exp <= now) return null;

    return payload;
  } catch {
    return null;
  }
}
