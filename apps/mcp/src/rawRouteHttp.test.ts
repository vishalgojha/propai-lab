import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { createMcpServer } from "./index.ts";
import { createAuthMiddleware, type AccessDeps } from "./mcpAccess.ts";
import { createMcpHandler, type McpSession } from "./mcpHttp.ts";
import { mountRawBrokerRoute, RAW_MCP_METADATA_PATH } from "./rawRoute.ts";
import { oauthProtectedResourceMetadata, setMcpUnauthorizedHeaders } from "./oauth.ts";
import type { AuthenticatedUser } from "./types.ts";

// Real transports and real servers on both routes; only token verification is injected.
const access: AccessDeps = {
  verify: async (t) => { if (t !== "tok-a") throw new Error("bad"); return { id: "a" } as AuthenticatedUser; },
  resolveBrokerId: async () => "a",
  resolveTenantId: async () => "t1",
  challenge: (_r, res) => res.setHeader("WWW-Authenticate", "x"),
};

async function withApp(run: (base: string, legacy: Map<string, McpSession>, raw: Map<string, McpSession>) => Promise<void>) {
  const legacy = new Map<string, McpSession>();
  const app = express();
  app.use(express.json());
  app.all("/mcp", createAuthMiddleware("public-or-user", access), createMcpHandler({
    sessions: legacy, createServer: createMcpServer, challenge: access.challenge as never,
    records: { create: async () => {}, touch: async () => {}, close: async () => {} },
  }));
  const raw = mountRawBrokerRoute(app, {
    access, challenge: (req, res, p) => setMcpUnauthorizedHeaders(req, res, p),
    records: { create: async () => {}, touch: async () => {}, close: async () => {} },
    metadata: (req, res, p) => oauthProtectedResourceMetadata(req, res, p),
  });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, legacy, raw); }
  finally {
    for (const s of [...legacy.values(), ...raw.values()]) await s.transport.close().catch(() => {});
    server.closeAllConnections(); server.close();
  }
}

async function mcp(base: string, path: string, o: { token?: string; sid?: string; body?: unknown } = {}) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.sid ? { "mcp-session-id": o.sid, "mcp-protocol-version": "2025-03-26" } : {}) },
    body: JSON.stringify(o.body ?? {}), signal: AbortSignal.timeout(5000),
  });
  return { status: res.status, sid: res.headers.get("mcp-session-id"), text: await res.text(), www: res.headers.get("www-authenticate") };
}
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
const LIST = { jsonrpc: "2.0", id: 2, method: "tools/list" };
const CALL = (name: string) => ({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: {} } });
const names = (t: string) => [...t.matchAll(/"name":"([a-z_]+)"/g)].map((m) => m[1]);
async function open(base: string, path: string, token: string) {
  const r = await mcp(base, path, { token, body: INIT });
  assert.equal(r.status, 200, r.text);
  await mcp(base, path, { token, sid: r.sid!, body: { jsonrpc: "2.0", method: "notifications/initialized" } });
  return r.sid!;
}

test("real HTTP: /raw-mcp lists only its five tools, needs sign-in, and its challenge points at its own metadata", () =>
  withApp(async (base) => {
    const anon = await mcp(base, "/raw-mcp", { body: INIT });
    assert.equal(anon.status, 401);
    assert.ok(anon.www?.includes(RAW_MCP_METADATA_PATH), "challenge uses the raw route's metadata path");
    const sid = await open(base, "/raw-mcp", "tok-a");
    const l = await mcp(base, "/raw-mcp", { token: "tok-a", sid, body: LIST });
    assert.deepEqual(names(l.text).sort(), ["contact_reveal", "raw_message_context", "raw_message_get", "raw_message_search"]);
    const meta = await (await fetch(base + RAW_MCP_METADATA_PATH)).json() as { resource: string };
    assert.ok(meta.resource.endsWith("/raw-mcp"));
  }));

test("real HTTP: a session id from the legacy /mcp endpoint cannot be used on /raw-mcp, and the reverse", () =>
  withApp(async (base, legacy, raw) => {
    const legacySid = await open(base, "/mcp", "tok-a");
    const rawSid = await open(base, "/raw-mcp", "tok-a");
    assert.ok(legacy.has(legacySid) && !raw.has(legacySid) && raw.has(rawSid) && !legacy.has(rawSid), "separate session maps");
    const cross1 = await mcp(base, "/raw-mcp", { token: "tok-a", sid: legacySid, body: LIST });
    assert.ok(!names(cross1.text).includes("market_search"), `legacy session reached the raw route: ${cross1.status} ${cross1.text.slice(0, 120)}`);
    assert.notEqual(cross1.status, 200, "legacy session id must not be accepted on /raw-mcp");
    const cross2 = await mcp(base, "/raw-mcp", { token: "tok-a", sid: legacySid, body: CALL("market_search") });
    assert.ok(!/results|explanation/.test(cross2.text) && cross2.status !== 200);
    const cross3 = await mcp(base, "/mcp", { token: "tok-a", sid: rawSid, body: LIST });
    assert.ok(!names(cross3.text).includes("contact_reveal") && cross3.status !== 200, "raw session id must not work on /mcp");
  }));

test("legacy /mcp is preserved: same tool list, public mode, and legacy contact tools keep their original inputs", () =>
  withApp(async (base) => {
    const pub = await mcp(base, "/mcp", { body: INIT });
    assert.equal(pub.status, 200, "unauthenticated /mcp still opens the public toolset");
    const sid = await open(base, "/mcp", "tok-a");
    const l = await mcp(base, "/mcp", { token: "tok-a", sid, body: LIST });
    const n = names(l.text);
    for (const t of ["market_search", "listing_get", "raw_message_search", "contact_search", "contact_call", "contact_whatsapp", "broker_inventory"]) assert.ok(n.includes(t), `legacy tool kept: ${t}`);
    assert.ok(!n.includes("contact_reveal"), "no raw-route tool leaks into legacy");
    assert.match(l.text, /Get the phone number for a broker contact/, "legacy contact_call description unchanged");
    assert.match(l.text, /"phone"/, "legacy contact_call still accepts a phone/name lookup");
  }));


test("broker background reaches real raw HTTP initialize only, never legacy initialization or public metadata", () =>
  withApp(async (base) => {
    const raw = await mcp(base, "/raw-mcp", { token: "tok-a", body: INIT });
    assert.equal(raw.status, 200);
    assert.ok(raw.text.includes("How broker Instincts read Mumbai listings"));
    assert.ok(raw.text.includes("grants no access"));
    assert.ok(raw.text.includes("Only after the broker says a specific message/option"));
    const legacy = await mcp(base, "/mcp", { token: "tok-a", body: INIT });
    assert.equal(legacy.status, 200);
    assert.ok(!legacy.text.includes("How broker Instincts read Mumbai listings"));
    const publicLegacy = await mcp(base, "/mcp", { body: INIT });
    assert.equal(publicLegacy.status, 200);
    assert.ok(!publicLegacy.text.includes("How broker Instincts read Mumbai listings"));
    const denied = await mcp(base, "/raw-mcp", { body: INIT });
    assert.equal(denied.status, 401);
    assert.ok(!denied.text.includes("How broker Instincts read Mumbai listings"));
    const metadata = await (await fetch(base + RAW_MCP_METADATA_PATH)).text();
    assert.ok(!metadata.includes("How broker Instincts read Mumbai listings"));
  }));
