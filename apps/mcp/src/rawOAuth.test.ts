import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { createMcpServer } from "./index.ts";
import { createAuthMiddleware, type AccessDeps } from "./mcpAccess.ts";
import { createMcpHandler, type McpSession } from "./mcpHttp.ts";
import { deviceAuthorizeHandler, publicUrl, setMcpUnauthorizedHeaders } from "./oauth.ts";
import { ACCESS_TTL_MS, boundTenantResolver, configureRawOAuth, mountRawOAuth, rawProtectedResourceMetadata, resetRawOAuthForTests, verifyRawAccessToken } from "./rawOAuth.ts";
import { mountRawBrokerRoute } from "./rawRoute.ts";
import type { AuthenticatedUser } from "./types.ts";

// Real raw route, real legacy device-authorize handler and real raw OAuth module. Only the Supabase lookups are injected.
const SUPABASE_JWT = "supabase-session-jwt-for-user-a";
const SUPABASE_REFRESH = "supabase-refresh-token-for-user-a";
let clock = 1_000_000;
let memberships: Record<string, string | null> = { a: "t1" };
let gate: Promise<void> | null = null; // lets a test hold the membership lookup of an in-flight refresh
const noop = { create: async () => {}, touch: async () => {}, close: async () => {} };

async function withApp(run: (base: string) => Promise<void>) {
  resetRawOAuthForTests();
  clock = 1_000_000; memberships = { a: "t1" }; gate = null;
  configureRawOAuth({
    verifySession: async (t) => { if (t !== SUPABASE_JWT) throw new Error("bad"); return { id: "a" } as AuthenticatedUser; },
    resolveTenantId: async (u) => { if (gate) await gate; return memberships[u.id] ?? null; },
    publicUrl: (req) => publicUrl(req),
    now: () => clock,
  });
  const legacyAccess: AccessDeps = {
    verify: async (t) => { if (t !== SUPABASE_JWT) throw new Error("bad"); return { id: "a" } as AuthenticatedUser; },
    resolveBrokerId: async () => "a", resolveTenantId: async (u) => memberships[u.id] ?? null, challenge: (_r, res) => res.setHeader("WWW-Authenticate", "x"),
  };
  const rawAccess: AccessDeps = { verify: verifyRawAccessToken, resolveBrokerId: async (u) => u.id, resolveTenantId: boundTenantResolver(async (u) => memberships[u.id] ?? null), challenge: legacyAccess.challenge };
  const app = express();
  app.use(express.json()); app.use(express.urlencoded({ extended: false }));
  const legacy = new Map<string, McpSession>();
  app.all("/mcp", createAuthMiddleware("public-or-user", legacyAccess), createMcpHandler({ sessions: legacy, createServer: createMcpServer, challenge: legacyAccess.challenge as never, records: noop }));
  app.post("/device/authorize", deviceAuthorizeHandler);
  mountRawOAuth(app);
  const raw = mountRawBrokerRoute(app, { access: rawAccess, challenge: (req, res, p) => setMcpUnauthorizedHeaders(req, res, p), records: noop, metadata: (req, res) => rawProtectedResourceMetadata(req, res) });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { for (const s of [...legacy.values(), ...raw.values()]) await s.transport.close().catch(() => {}); server.closeAllConnections(); server.close(); }
}

const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
const verifierOf = () => crypto.randomBytes(32).toString("base64url");
const challengeOf = (v: string) => crypto.createHash("sha256").update(v).digest("base64url");
const REDIRECT = "https://client.example/cb";

async function register(base: string, uris = [REDIRECT]) {
  const r = await post(base, "/raw-oauth/register", { redirect_uris: uris });
  return { status: r.status, body: await r.json() as any };
}
async function authorize(base: string, clientId: string, challenge: string, extra = "") {
  const r = await fetch(`${base}/raw-oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256&state=orig-state${extra}`, { redirect: "manual", signal: AbortSignal.timeout(5000) });
  return { status: r.status, location: r.headers.get("location") || "", text: r.status === 302 ? "" : await r.text() };
}
/** What the PropAI app page does: posts the user's Supabase tokens plus the params it was given, to /device/authorize. */
async function appSignIn(base: string, appUrl: string, jwt = SUPABASE_JWT) {
  const p = new URL(appUrl).searchParams;
  const r = await post(base, "/device/authorize", { refresh_token: SUPABASE_REFRESH, client_id: p.get("client_id"), redirect_uri: p.get("redirect_uri"), state: p.get("state"), code_challenge: p.get("code_challenge"), code_challenge_method: p.get("code_challenge_method") }, jwt ? { authorization: `Bearer ${jwt}` } : {});
  return { status: r.status, body: await r.json() as any };
}
async function fullFlow(base: string) {
  const c = (await register(base)).body.client_id as string;
  const v = verifierOf();
  const a = await authorize(base, c, challengeOf(v));
  const s = await appSignIn(base, a.location);
  const code = new URL(s.body.redirect_url).searchParams.get("code")!;
  const t = await post(base, "/raw-oauth/token", { grant_type: "authorization_code", client_id: c, code, redirect_uri: REDIRECT, code_verifier: v });
  return { c, v, a, s, code, t, tok: await t.json() as any };
}
async function mcp(base: string, path: string, token: string, body: unknown, sid?: string) {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, ...(sid ? { "mcp-session-id": sid, "mcp-protocol-version": "2025-03-26" } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  return { status: r.status, sid: r.headers.get("mcp-session-id"), text: await r.text() };
}
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } };

test("raw sign-in: issued token is opaque, route-scoped, never contains or returns the Supabase tokens", async () => {
  await withApp(async (base) => {
    const f = await fullFlow(base);
    assert.equal(f.a.status, 302);
    assert.ok(f.a.location.startsWith("https://app.propai.live/mcp-authorize") && /state=rawflow\./.test(f.a.location));
    assert.equal(f.t.status, 200);
    assert.equal(f.tok.scope, "raw:read");
    assert.ok(f.tok.access_token.startsWith("pmcp_") && f.tok.refresh_token.startsWith("pmcp_"));
    const dump = JSON.stringify(f.tok) + JSON.stringify(f.s.body);
    assert.ok(!dump.includes(SUPABASE_JWT) && !dump.includes(SUPABASE_REFRESH), "no Supabase token in any response");
    assert.equal(new URL(f.s.body.redirect_url).searchParams.get("state"), "orig-state", "client's own state is returned, not the marker");
    // metadata points the client at the raw authorization server only
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/raw-mcp`)).json() as any;
    assert.ok(prm.resource.endsWith("/raw-mcp") && prm.authorization_servers[0].endsWith("/raw-oauth"));
  });
});

test("the raw token works on /raw-mcp only: rejected by legacy /mcp; a Supabase JWT is rejected on /raw-mcp", async () => {
  await withApp(async (base) => {
    const f = await fullFlow(base);
    const ok = await mcp(base, "/raw-mcp", f.tok.access_token, INIT);
    assert.equal(ok.status, 200, ok.text);
    assert.equal((await mcp(base, "/mcp", f.tok.access_token, INIT)).status, 401, "raw token cannot open a legacy session");
    assert.equal((await mcp(base, "/raw-mcp", SUPABASE_JWT, INIT)).status, 401, "full session token no longer works on the raw route");
    assert.equal((await mcp(base, "/raw-mcp", "pmcp_" + "x".repeat(40), INIT)).status, 401, "guessed token");
  });
});

test("authorize and token checks: unknown client, unregistered redirect, missing or plain PKCE, wrong scope or resource, bad verifier", async () => {
  await withApp(async (base) => {
    const c = (await register(base)).body.client_id as string;
    const ch = challengeOf(verifierOf());
    assert.equal((await authorize(base, "nope", ch)).status, 400);
    const bad = await fetch(`${base}/raw-oauth/authorize?response_type=code&client_id=${c}&redirect_uri=${encodeURIComponent("https://evil.example/cb")}&code_challenge=${ch}&code_challenge_method=S256`, { redirect: "manual" });
    assert.equal(bad.status, 400, "redirect must be registered (legacy accepts unknown clients; this does not)");
    const plain = await fetch(`${base}/raw-oauth/authorize?response_type=code&client_id=${c}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${ch}&code_challenge_method=plain`, { redirect: "manual" });
    assert.equal(plain.status, 400);
    assert.equal((await authorize(base, c, ch, "&scope=mcp")).status, 400, "scope other than raw:read");
    assert.equal((await authorize(base, c, ch, `&resource=${encodeURIComponent(base + "/mcp")}`)).status, 400, "resource other than /raw-mcp");
    assert.equal((await register(base, ["http://evil.example/cb"])).status, 400, "plain http only allowed for localhost");
    const f = await fullFlow(base);
    const wrongVerifier = await (async () => {
      const a = await authorize(base, f.c, challengeOf(verifierOf()));
      const s = await appSignIn(base, a.location);
      const code = new URL(s.body.redirect_url).searchParams.get("code")!;
      return post(base, "/raw-oauth/token", { grant_type: "authorization_code", client_id: f.c, code, redirect_uri: REDIRECT, code_verifier: verifierOf() });
    })();
    assert.equal((await wrongVerifier).status, 400);
  });
});

test("codes and sign-in markers are single use; the page cannot change the client, redirect or challenge; unknown markers never fall through to the legacy flow", async () => {
  await withApp(async (base) => {
    const f = await fullFlow(base);
    const again = await post(base, "/raw-oauth/token", { grant_type: "authorization_code", client_id: f.c, code: f.code, redirect_uri: REDIRECT, code_verifier: f.v });
    assert.equal(again.status, 400, "code reuse");
    const replay = await appSignIn(base, f.a.location);
    assert.equal(replay.status, 400, "marker reuse");
    const forged = await post(base, "/device/authorize", { state: "rawflow.not-a-real-id", client_id: "x", redirect_uri: "https://evil.example/cb", code_challenge: "y", code_challenge_method: "S256" }, { authorization: `Bearer ${SUPABASE_JWT}` });
    assert.equal(forged.status, 400, "forged marker rejected, not handled as legacy");
    // tampered page params: redirect comes from the server record
    const c = (await register(base)).body.client_id as string;
    const a = await authorize(base, c, challengeOf(verifierOf()));
    const marker = new URL(a.location).searchParams.get("state");
    const t = await post(base, "/device/authorize", { state: marker, client_id: c, redirect_uri: "https://evil.example/cb", code_challenge: "attacker" }, { authorization: `Bearer ${SUPABASE_JWT}` });
    assert.ok(new URL((await t.json() as any).redirect_url).origin === "https://client.example");
  });
});

test("sign-in needs a valid PropAI session and an active membership", async () => {
  await withApp(async (base) => {
    const c = (await register(base)).body.client_id as string;
    const a = await authorize(base, c, challengeOf(verifierOf()));
    assert.equal((await appSignIn(base, a.location, "")).status, 401, "no session");
    assert.equal((await appSignIn(base, a.location, "garbage")).status, 401, "bad session");
    memberships.a = null;
    assert.equal((await appSignIn(base, a.location)).status, 403, "no membership");
  });
});

test("membership removal blocks the token immediately; expiry, refresh rotation and revoke", async () => {
  await withApp(async (base) => {
    const f = await fullFlow(base);
    const sid = (await mcp(base, "/raw-mcp", f.tok.access_token, INIT)).sid!;
    memberships.a = null;
    assert.equal((await mcp(base, "/raw-mcp", f.tok.access_token, INIT)).status, 403, "membership removed");
    assert.notEqual((await mcp(base, "/raw-mcp", f.tok.access_token, { jsonrpc: "2.0", id: 2, method: "tools/list" }, sid)).status, 200, "existing session also blocked");
    memberships.a = "t1";
    // refresh rotates: old refresh and old access die
    const r1 = await post(base, "/raw-oauth/token", { grant_type: "refresh_token", client_id: f.c, refresh_token: f.tok.refresh_token });
    assert.equal(r1.status, 200);
    const n = await r1.json() as any;
    assert.notEqual(n.access_token, f.tok.access_token);
    assert.equal((await mcp(base, "/raw-mcp", f.tok.access_token, INIT)).status, 401, "old access token is dead");
    assert.equal((await mcp(base, "/raw-mcp", n.access_token, INIT)).status, 200);
    clock += 1000;
    const n2 = await (await post(base, "/raw-oauth/token", { grant_type: "refresh_token", client_id: f.c, refresh_token: n.refresh_token })).json() as any; // legit second rotation
    assert.equal((await mcp(base, "/raw-mcp", n2.access_token, INIT)).status, 200);
    clock -= 1000;
    assert.equal((await post(base, "/raw-oauth/token", { grant_type: "refresh_token", client_id: f.c, refresh_token: f.tok.refresh_token })).status, 400, "older used refresh token is dead (invalid; only the latest rotated one is tracked for family revoke)");
    assert.equal((await mcp(base, "/raw-mcp", n2.access_token, INIT)).status, 200, "an older invalid token does not end the family");
    assert.equal((await post(base, "/raw-oauth/token", { grant_type: "refresh_token", client_id: f.c, refresh_token: n.refresh_token })).status, 400, "replay of the latest used refresh token");
    assert.equal((await mcp(base, "/raw-mcp", n2.access_token, INIT)).status, 401, "replay of the latest used refresh token ends the family");
    n.access_token = (await fullFlow(base)).tok.access_token; n.refresh_token = "x";
    // expiry
    clock += ACCESS_TTL_MS + 1;
    assert.equal((await mcp(base, "/raw-mcp", n.access_token, INIT)).status, 401, "expired access token");
    // revoke kills the pair
    clock = 1_000_000;
    const g = await fullFlow(base);
    await post(base, "/raw-oauth/revoke", { token: g.tok.refresh_token });
    assert.equal((await mcp(base, "/raw-mcp", g.tok.access_token, INIT)).status, 401);
    assert.equal((await post(base, "/raw-oauth/token", { grant_type: "refresh_token", client_id: g.c, refresh_token: g.tok.refresh_token })).status, 400);
    // another client cannot use this client's refresh token
    const h = await fullFlow(base);
    const other = (await register(base)).body.client_id as string;
    assert.equal((await post(base, "/raw-oauth/token", { grant_type: "refresh_token", client_id: other, refresh_token: h.tok.refresh_token })).status, 400);
  });
});

test("tenant move: a grant for org t1 cannot open a session on org t2, refresh or new code exchange fails, re-sign-in binds the new org", async () => {
  await withApp(async (base) => {
    const f = await fullFlow(base);
    assert.equal((await mcp(base, "/raw-mcp", f.tok.access_token, INIT)).status, 200);
    memberships.a = "t2"; // user moved to another organization
    assert.equal((await mcp(base, "/raw-mcp", f.tok.access_token, INIT)).status, 403, "old org grant must not open a new session on the new org");
    const rf = await post(base, "/raw-oauth/token", { grant_type: "refresh_token", client_id: f.c, refresh_token: f.tok.refresh_token });
    assert.equal(rf.status, 400, "refresh does not carry the grant to another org");
    // code issued for t1, org changes before exchange
    memberships.a = "t1";
    const v = verifierOf();
    const a = await authorize(base, f.c, challengeOf(v));
    const s = await appSignIn(base, a.location);
    const code = new URL(s.body.redirect_url).searchParams.get("code")!;
    memberships.a = "t2";
    assert.equal((await post(base, "/raw-oauth/token", { grant_type: "authorization_code", client_id: f.c, code, redirect_uri: REDIRECT, code_verifier: v })).status, 400);
    // signing in again binds to the new org
    const g = await fullFlow(base);
    assert.equal((await mcp(base, "/raw-mcp", g.tok.access_token, INIT)).status, 200);
  });
});

test("concurrent sign-in posts for one marker mint exactly one code; a failed attempt does not burn the marker", async () => {
  await withApp(async (base) => {
    const c = (await register(base)).body.client_id as string;
    const a = await authorize(base, c, challengeOf(verifierOf()));
    const results = await Promise.all([1, 2, 3, 4].map(() => appSignIn(base, a.location)));
    assert.equal(results.filter((r) => r.status === 200).length, 1, `exactly one success, got ${results.map((r) => r.status)}`);
    // bad session first, then a good retry on the same marker
    const b = await authorize(base, c, challengeOf(verifierOf()));
    assert.equal((await appSignIn(base, b.location, "garbage")).status, 401);
    assert.equal((await appSignIn(base, b.location)).status, 200, "marker survives a failed attempt");
    // concurrent refresh with the same token: one wins
    const f = await fullFlow(base);
    const rr = await Promise.all([1, 2, 3].map(() => post(base, "/raw-oauth/token", { grant_type: "refresh_token", client_id: f.c, refresh_token: f.tok.refresh_token })));
    assert.equal(rr.filter((r) => r.status === 200).length, 1, "one refresh wins");
    // replaying an already used refresh token ends the whole session family, including the successor
    const winner = await (await post(base, "/raw-oauth/token", { grant_type: "refresh_token", client_id: f.c, refresh_token: f.tok.refresh_token })).status;
    assert.equal(winner, 400);
    const h = await fullFlow(base);
    const ok = await (await post(base, "/raw-oauth/token", { grant_type: "refresh_token", client_id: h.c, refresh_token: h.tok.refresh_token })).json() as any;
    assert.equal((await mcp(base, "/raw-mcp", ok.access_token, INIT)).status, 200);
    assert.equal((await post(base, "/raw-oauth/token", { grant_type: "refresh_token", client_id: h.c, refresh_token: h.tok.refresh_token })).status, 400, "replay");
    assert.equal((await mcp(base, "/raw-mcp", ok.access_token, INIT)).status, 401, "successor access token revoked by replay");
  });
});

test("downgrade boundary: a raw client cannot complete the legacy flow even with the marker stripped; store sizes are capped", async () => {
  await withApp(async (base) => {
    const c = (await register(base)).body.client_id as string;
    const a = await authorize(base, c, challengeOf(verifierOf()));
    const p = new URL(a.location).searchParams;
    const stripped = await post(base, "/device/authorize", { client_id: c, redirect_uri: p.get("redirect_uri"), state: "orig-state", code_challenge: p.get("code_challenge"), code_challenge_method: "S256" }, { authorization: `Bearer ${SUPABASE_JWT}` });
    assert.equal(stripped.status, 400, "legacy completion refused for a raw client id");
    assert.ok(!JSON.stringify(await stripped.json()).includes("redirect_url"));
    for (let i = 0; i < 1000; i++) await register(base).catch(() => {});
    assert.equal((await register(base)).status, 503, "registration capped");
  });
});

test("in-flight refresh cannot issue a live successor after a replay or an explicit revoke (membership lookup held open)", async () => {
  await withApp(async (base) => {
    for (const how of ["replay", "revoke-old-token", "revoke-new-family-by-access"] as const) {
      const f = await fullFlow(base);
      let release!: () => void;
      gate = new Promise<void>((r) => { release = r; });
      const inflight = post(base, "/raw-oauth/token", { grant_type: "refresh_token", client_id: f.c, refresh_token: f.tok.refresh_token });
      await new Promise((r) => setTimeout(r, 100)); // first request is now parked on the membership lookup
      if (how === "replay") assert.equal((await post(base, "/raw-oauth/token", { grant_type: "refresh_token", client_id: f.c, refresh_token: f.tok.refresh_token })).status, 400);
      else if (how === "revoke-old-token") await post(base, "/raw-oauth/revoke", { token: f.tok.refresh_token });
      else await post(base, "/raw-oauth/revoke", { token: f.tok.access_token });
      release(); gate = null;
      const r = await inflight;
      const body = await r.json() as any;
      if (r.status === 200) assert.equal((await mcp(base, "/raw-mcp", body.access_token, INIT)).status, 401, `${how}: successor must not be live`);
      else assert.equal(r.status, 400);
      if (how !== "revoke-new-family-by-access") assert.equal(r.status, 400, `${how}: in-flight refresh refused`);
    }
  });
});

test("idle client registrations expire", async () => {
  await withApp(async (base) => {
    for (let i = 0; i < 1000; i++) await register(base);
    assert.equal((await register(base)).status, 503);
    clock += 61 * 60 * 1000;
    assert.equal((await register(base)).status, 201, "unused registrations expire after an hour, freeing the cap");
    const f = await fullFlow(base);
    clock += 2 * 60 * 60 * 1000;
    assert.equal((await post(base, "/raw-oauth/token", { grant_type: "refresh_token", client_id: f.c, refresh_token: f.tok.refresh_token })).status, 200, "a client that completed a sign-in stays registered");
  });
});

test("consent details come from the server record, not from the page query; unknown markers get nothing", async () => {
  await withApp(async (base) => {
    const c = (await register(base)).body.client_id as string;
    const a = await authorize(base, c, challengeOf(verifierOf()));
    const marker = new URL(a.location).searchParams.get("state")!;
    const info = await (await fetch(`${base}/raw-oauth/pending?state=${encodeURIComponent(marker)}&redirect_uri=${encodeURIComponent("https://trusted.example/cb")}`)).json() as any;
    assert.equal(info.redirect_host, "client.example", "host is the registered redirect, whatever the query says");
    assert.equal(info.client_verified, false);
    assert.ok(!JSON.stringify(info).includes("code_challenge") && !JSON.stringify(info).includes(c));
    assert.equal((await fetch(`${base}/raw-oauth/pending?state=rawflow.nope`)).status, 404);
    assert.equal((await fetch(`${base}/raw-oauth/pending?state=other`)).status, 404);
  });
});

test("revocation is not evictable: churning many other revocations while a refresh is held cannot resurrect it", async () => {
  await withApp(async (base) => {
    const f = await fullFlow(base);
    let release!: () => void;
    gate = new Promise<void>((r) => { release = r; });
    const inflight = post(base, "/raw-oauth/token", { grant_type: "refresh_token", client_id: f.c, refresh_token: f.tok.refresh_token });
    await new Promise((r) => setTimeout(r, 100));
    await post(base, "/raw-oauth/revoke", { token: f.tok.refresh_token });
    const g = gate; gate = null; // other sign-ins and revocations proceed while the first stays parked
    for (let i = 0; i < 60; i++) { const o = await fullFlow(base); await post(base, "/raw-oauth/revoke", { token: o.tok.refresh_token }); }
    gate = g; release(); gate = null;
    const r = await inflight;
    assert.equal(r.status, 400, "held refresh stays refused after unrelated revocation churn");
  });
});
