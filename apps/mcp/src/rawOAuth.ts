import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import type { AuthenticatedUser } from "./types.ts";
import { defaultMcpReaderGrantOnNewAuthorization } from "./brokerMarketData.ts";

/**
 * Separate, limited sign-in for the /raw-mcp route.
 *
 * What it does: after the user signs in on the PropAI app (the existing mcp-authorize page), the MCP client receives an
 * opaque token that PropAI issued for this route only (audience /raw-mcp, scope raw:read). The user's Supabase access
 * and refresh tokens are verified once, in memory, to learn the user id, and are never stored or returned.
 *
 * What it does not do: tokens live in process memory, so a restart or redeploy signs everyone out (clients must sign in
 * again). Single instance only. It does not change the legacy /mcp sign-in, which still returns the user's session token.
 */
export const RAW_OAUTH_BASE = "/raw-oauth";
export const RAW_MCP_RESOURCE_PATH = "/raw-mcp";
export const RAW_SCOPE = "raw:read";
export const RAW_STATE_PREFIX = "rawflow.";
export const RAW_TOKEN_PREFIX = "pmcp_";

const PENDING_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type RawOAuthDeps = {
  /** Verifies a PropAI session token once and returns the user. Must throw or return null when invalid. */
  verifySession: (token: string) => Promise<AuthenticatedUser | null | undefined>;
  /** Live organization membership lookup; must return nothing when the user has no active membership. */
  resolveTenantId: (user: AuthenticatedUser) => Promise<string | null | undefined>;
  publicUrl: (req: Request) => string;
  appAuthorizeUrl?: string;
  now?: () => number;
};

type Client = { clientId: string; redirectUris: string[]; expires: number };
type Pending = { clientId: string; redirectUri: string; challenge: string; state: string; expires: number };
type Code = { userId: string; tenantId: string; clientId: string; redirectUri: string; challenge: string; expires: number };
// Family state is shared by reference by every token of one sign-in, so a revoke is seen by in-flight requests and nothing is ever evicted.
type Fam = { revoked: boolean; lastUsed?: string };
type TokenRec = { userId: string; tenantId: string; clientId: string; pair: string; fam: Fam; expires: number };

const clients = new Map<string, Client>();
const pending = new Map<string, Pending>();
const codes = new Map<string, Code>();
const access = new Map<string, TokenRec>();
const refresh = new Map<string, TokenRec>();
// Only the most recently rotated refresh hash per family is kept (replay of it ends the family); older ones simply fail as invalid.
const usedRefresh = new Map<string, { fam: Fam; expires: number }>();
const CLIENT_IDLE_TTL_MS = 60 * 60 * 1000; // a registered client that never completes a sign-in is dropped after 1h
const CLIENT_ACTIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Public endpoints cannot grow these maps without bound. At the cap new entries are refused (no rate limiting beyond that).
const CAPS = { clients: 1000, pending: 2000, codes: 2000, tokens: 5000 };
let deps: RawOAuthDeps | null = null;

export function configureRawOAuth(d: RawOAuthDeps) { deps = d; }
export function resetRawOAuthForTests() { clients.clear(); pending.clear(); codes.clear(); access.clear(); refresh.clear(); usedRefresh.clear(); deps = null; }
/** True for client ids registered with the raw flow; the legacy device-authorize endpoint refuses them. */
export function isRawClientId(id: string) { return clients.has(id); }

const now = () => (deps?.now ? deps.now() : Date.now());
const hash = (v: string) => crypto.createHash("sha256").update(v).digest("hex");
const rand = () => crypto.randomBytes(32).toString("base64url");
const s256 = (v: string) => crypto.createHash("sha256").update(v).digest("base64url");

function sweep() {
  const t = now();
  for (const m of [clients, pending, codes, access, refresh, usedRefresh] as Array<Map<string, { expires: number }>>) for (const [k, v] of m) if (v.expires <= t) m.delete(k);
}

function validRedirect(uri: string) {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]");
  } catch { return false; }
}

const err = (res: Response, status: number, error: string, description: string) => res.status(status).json({ error, error_description: description });

export function rawIssuer(req: Request) { return `${deps!.publicUrl(req)}${RAW_OAUTH_BASE}`; }

export function rawAuthorizationServerMetadata(req: Request, res: Response) {
  const base = deps!.publicUrl(req);
  const issuer = rawIssuer(req);
  res.json({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    revocation_endpoint: `${issuer}/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [RAW_SCOPE],
    resource: `${base}${RAW_MCP_RESOURCE_PATH}`,
  });
}

export function rawProtectedResourceMetadata(req: Request, res: Response) {
  res.json({
    resource: `${deps!.publicUrl(req)}${RAW_MCP_RESOURCE_PATH}`,
    authorization_servers: [rawIssuer(req)],
    bearer_methods_supported: ["header"],
    scopes_supported: [RAW_SCOPE],
  });
}

export function rawRegister(req: Request, res: Response) {
  sweep();
  const uris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris.map((u: unknown) => String(u)) : [];
  if (!uris.length || !uris.every(validRedirect)) return err(res, 400, "invalid_redirect_uri", "redirect_uris must be https (or localhost http) URLs without fragments");
  if (clients.size >= CAPS.clients) return err(res, 503, "temporarily_unavailable", "Too many registered clients; try again later");
  const clientId = crypto.randomUUID();
  clients.set(clientId, { clientId, redirectUris: uris, expires: now() + CLIENT_IDLE_TTL_MS });
  return res.status(201).json({ client_id: clientId, redirect_uris: uris, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: RAW_SCOPE });
}

export function rawAuthorize(req: Request, res: Response) {
  sweep();
  const q = req.query;
  const clientId = String(q.client_id || "");
  const redirectUri = String(q.redirect_uri || "");
  const challenge = String(q.code_challenge || "");
  const client = clients.get(clientId);
  if (String(q.response_type || "code") !== "code" || !client) return err(res, 400, "invalid_request", "Unknown client or invalid request");
  if (!client.redirectUris.includes(redirectUri)) return err(res, 400, "invalid_request", "redirect_uri is not registered for this client");
  if (!challenge || String(q.code_challenge_method || "") !== "S256") return err(res, 400, "invalid_request", "PKCE with S256 is required");
  const scope = String(q.scope || "").trim();
  if (scope && scope.split(/\s+/).some((s) => s !== RAW_SCOPE)) return err(res, 400, "invalid_scope", `Only ${RAW_SCOPE} is available`);
  const resource = String(q.resource || "");
  if (resource && resource !== `${deps!.publicUrl(req)}${RAW_MCP_RESOURCE_PATH}`) return err(res, 400, "invalid_target", "resource must be this server's /raw-mcp");
  if (pending.size >= CAPS.pending) return err(res, 503, "temporarily_unavailable", "Too many pending sign-ins; try again later");
  const id = rand();
  pending.set(id, { clientId, redirectUri, challenge, state: String(q.state || ""), expires: now() + PENDING_TTL_MS });
  const url = new URL(deps!.appAuthorizeUrl || "https://app.propai.live/mcp-authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", `${RAW_STATE_PREFIX}${id}`);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return res.redirect(302, url.toString());
}

/**
 * Called from the legacy device-authorize endpoint (the PropAI app posts there) ONLY when state carries the raw-flow
 * marker. The request fields from the page are ignored except the marker; client, redirect and challenge come from the
 * server-side pending record. Fails closed: an unknown or expired marker is rejected, never handled as a legacy flow.
 */
/** Trusted details of a pending sign-in for the consent page. Looked up by the unguessable marker; only non-secret fields. */
export function rawPendingInfo(req: Request, res: Response) {
  sweep();
  res.setHeader("Access-Control-Allow-Origin", "https://app.propai.live");
  res.setHeader("Cache-Control", "no-store");
  const m = String(req.query.state || "");
  const rec = m.startsWith(RAW_STATE_PREFIX) ? pending.get(m.slice(RAW_STATE_PREFIX.length)) : undefined;
  if (!rec) return res.status(404).json({ error: "unknown_or_expired" });
  return res.json({ redirect_host: new URL(rec.redirectUri).host, scope: RAW_SCOPE, client_verified: false });
}

export async function handleRawDeviceAuthorize(req: Request, res: Response) {
  if (!deps) return err(res, 503, "temporarily_unavailable", "Raw sign-in is not configured");
  sweep();
  const marker = String(req.body?.state || "");
  const id = marker.startsWith(RAW_STATE_PREFIX) ? marker.slice(RAW_STATE_PREFIX.length) : "";
  const rec = id ? pending.get(id) : undefined;
  if (!rec) return err(res, 400, "invalid_request", "Sign-in request is unknown or expired. Start again from your client.");
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return err(res, 401, "invalid_token", "Sign in to PropAI first");
  // Reserve the pending record synchronously, before any await, so two concurrent posts cannot both use it.
  // A failed attempt puts it back (until it expires) so the user can retry; a successful one consumes it.
  if (codes.size >= CAPS.codes) return err(res, 503, "temporarily_unavailable", "Too many pending sign-ins; try again later");
  pending.delete(id);
  const restore = () => { if (rec.expires > now() && !pending.has(id)) pending.set(id, rec); };
  let user: AuthenticatedUser | null | undefined;
  try { user = await deps.verifySession(token); } catch { user = null; }
  if (!user?.id) { restore(); return err(res, 401, "invalid_token", "Invalid or expired PropAI session"); }
  const tenantId = await deps.resolveTenantId(user).catch(() => null);
  if (!tenantId) { restore(); return err(res, 403, "access_denied", "An active organization membership is required"); }
  // New-authorization default: this completed sign-in grants cross-search
  // read ONLY when the owner has no recorded choice yet (the approval screen
  // says so). A recorded enable or explicit disable is never rewritten, and
  // the sign-in itself never depends on this grant.
  try {
    await defaultMcpReaderGrantOnNewAuthorization(tenantId, user.id);
  } catch (grantError) {
    console.error("[OAuth] default market reader grant failed:", grantError instanceof Error ? grantError.message : grantError);
  }
  if (codes.size >= CAPS.codes) { restore(); return err(res, 503, "temporarily_unavailable", "Too many pending sign-ins; try again later"); }
  const client = clients.get(rec.clientId);
  if (client) client.expires = now() + CLIENT_ACTIVE_TTL_MS;
  const code = rand();
  codes.set(hash(code), { userId: user.id, tenantId, clientId: rec.clientId, redirectUri: rec.redirectUri, challenge: rec.challenge, expires: now() + CODE_TTL_MS });
  const target = new URL(rec.redirectUri);
  target.searchParams.set("code", code);
  if (rec.state) target.searchParams.set("state", rec.state);
  return res.json({ success: true, redirect_url: target.toString() });
}

function revokeFamily(fam: Fam) {
  fam.revoked = true;
  for (const m of [access, refresh]) for (const [k, v] of m) if (v.fam === fam) m.delete(k);
}

function issue(rec: Omit<TokenRec, "expires" | "pair" | "fam">, fam: Fam = { revoked: false }) {
  if (access.size >= CAPS.tokens) throw new Error("token store full");
  const pair = rand();
  const a = RAW_TOKEN_PREFIX + rand();
  const r = RAW_TOKEN_PREFIX + rand();
  access.set(hash(a), { ...rec, pair, fam, expires: now() + ACCESS_TTL_MS });
  refresh.set(hash(r), { ...rec, pair, fam, expires: now() + REFRESH_TTL_MS });
  return { access_token: a, token_type: "Bearer", expires_in: Math.floor(ACCESS_TTL_MS / 1000), refresh_token: r, scope: RAW_SCOPE };
}

export async function rawToken(req: Request, res: Response) {
  try { return await rawTokenInner(req, res); } catch { return err(res, 503, "temporarily_unavailable", "Token service is busy; try again later"); }
}

async function rawTokenInner(req: Request, res: Response) {
  sweep();
  res.setHeader("Cache-Control", "no-store");
  const grant = String(req.body?.grant_type || "");
  const clientId = String(req.body?.client_id || "");
  if (!clients.has(clientId)) return err(res, 400, "invalid_client", "Unknown client");
  if (grant === "authorization_code") {
    const key = hash(String(req.body?.code || ""));
    const rec = codes.get(key);
    codes.delete(key); // single use, even when the checks below fail
    if (!rec || rec.clientId !== clientId || rec.redirectUri !== String(req.body?.redirect_uri || "")) return err(res, 400, "invalid_grant", "Authorization code is invalid, expired or does not match");
    const verifier = String(req.body?.code_verifier || "");
    if (!verifier || s256(verifier) !== rec.challenge) return err(res, 400, "invalid_grant", "PKCE verification failed");
    const cur0 = await deps!.resolveTenantId({ id: rec.userId } as AuthenticatedUser).catch(() => null);
    if (!cur0 || cur0 !== rec.tenantId) return err(res, 400, "invalid_grant", "Membership changed. Sign in again.");
    return res.json(issue({ userId: rec.userId, tenantId: rec.tenantId, clientId }));
  }
  if (grant === "refresh_token") {
    const key = hash(String(req.body?.refresh_token || ""));
    const rec = refresh.get(key);
    const replay = usedRefresh.get(key);
    if (!rec && replay) { revokeFamily(replay.fam); return err(res, 400, "invalid_grant", "Refresh token was already used; the session was ended. Sign in again."); }
    if (!rec || rec.clientId !== clientId) return err(res, 400, "invalid_grant", "Refresh token is invalid or expired");
    refresh.delete(key); // single use: a concurrent second refresh with the same token fails
    if (rec.fam.lastUsed) usedRefresh.delete(rec.fam.lastUsed);
    usedRefresh.set(key, { fam: rec.fam, expires: rec.expires });
    rec.fam.lastUsed = key;
    const cur = await deps!.resolveTenantId({ id: rec.userId } as AuthenticatedUser).catch(() => null);
    if (!cur || cur !== rec.tenantId) return err(res, 400, "invalid_grant", "Membership changed. Sign in again.");
    // Re-check after the await: a replay or revoke that happened meanwhile must win.
    if (rec.fam.revoked) return err(res, 400, "invalid_grant", "Session was ended. Sign in again.");
    for (const [k, v] of access) if (v.pair === rec.pair) access.delete(k); // rotation retires the old access token (after the checks, so a revoke by it during the await still finds the family)
    return res.json(issue({ userId: rec.userId, tenantId: rec.tenantId, clientId }, rec.fam));
  }
  return err(res, 400, "unsupported_grant_type", "Use authorization_code or refresh_token");
}

export function rawRevoke(req: Request, res: Response) {
  const key = hash(String(req.body?.token || ""));
  const rec = access.get(key) || refresh.get(key);
  const fam = rec?.fam ?? usedRefresh.get(key)?.fam; // an already rotated token still names its family
  if (fam) revokeFamily(fam);
  return res.status(200).json({});
}

/** Verifier for the /raw-mcp route. Accepts only unexpired opaque tokens issued by this module; a Supabase JWT never passes. */
export async function verifyRawAccessToken(token: string): Promise<AuthenticatedUser> {
  sweep();
  const rec = token.startsWith(RAW_TOKEN_PREFIX) ? access.get(hash(token)) : undefined;
  if (!rec || rec.fam.revoked) throw new Error("invalid raw token");
  return { id: rec.userId, tenant_id: rec.tenantId, aud: "pmcp-raw", role: "authenticated", app_metadata: { provider: "propai-raw" }, user_metadata: {}, created_at: "" } as AuthenticatedUser;
}

/**
 * Tenant resolver for the raw route: the CURRENT membership must still be the organization the user signed in for.
 * A user who moved to another organization, or lost membership, gets nothing from the old grant and must sign in again.
 */
export function boundTenantResolver(current: (user: AuthenticatedUser) => Promise<string | null | undefined>) {
  return async (user: AuthenticatedUser) => {
    const now = await current(user);
    return now && now === user.tenant_id ? now : null;
  };
}

export function mountRawOAuth(app: Express) {
  app.get(`/.well-known/oauth-authorization-server${RAW_OAUTH_BASE}`, rawAuthorizationServerMetadata);
  app.get(`${RAW_OAUTH_BASE}/authorize`, rawAuthorize);
  app.post(`${RAW_OAUTH_BASE}/register`, rawRegister);
  app.post(`${RAW_OAUTH_BASE}/token`, rawToken);
  app.post(`${RAW_OAUTH_BASE}/revoke`, rawRevoke);
  app.get(`${RAW_OAUTH_BASE}/pending`, rawPendingInfo);
}
