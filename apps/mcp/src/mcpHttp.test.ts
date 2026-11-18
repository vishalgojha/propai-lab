import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { createMcpServer } from "./index.ts";
import { createAuthMiddleware, type AccessDeps } from "./mcpAccess.ts";
import { createMcpHandler, type McpSession } from "./mcpHttp.ts";
import type { AuthenticatedUser } from "./types.ts";

// Real StreamableHTTPServerTransport and the real createMcpServer; only the
// token verifier and membership lookups are injected (state is mutable so the
// tests can expire a token, move a tenant, or revoke membership mid-session).
type Member = { id: string; tenant: string | null; broker: string };
const state = {
  tokens: new Map<string, string>(), // token -> user id (absent = invalid/expired)
  members: new Map<string, Member>(),
};

function reset() {
  state.tokens = new Map([["tok-a", "a"], ["tok-a2", "a"], ["tok-b", "b"], ["tok-c", "c"]]);
  state.members = new Map([
    ["a", { id: "a", tenant: "t1", broker: "a" }],
    ["b", { id: "b", tenant: "t1", broker: "b" }], // different user, SAME tenant
    ["c", { id: "c", tenant: "t2", broker: "c" }],
  ]);
}

const deps: AccessDeps = {
  verify: async (token) => {
    const id = state.tokens.get(token);
    if (!id) throw new Error("invalid or expired");
    return { id } as AuthenticatedUser;
  },
  resolveBrokerId: async (u) => state.members.get(u.id)?.broker,
  resolveTenantId: async (u) => state.members.get(u.id)?.tenant,
  challenge: (_req, res) => res.setHeader("WWW-Authenticate", "Bearer resource_metadata=\"https://mcp.test/x\""),
};

async function withServer(run: (base: string) => Promise<void>) {
  reset();
  const sessions = new Map<string, McpSession>();
  const handler = createMcpHandler({
    sessions,
    createServer: createMcpServer,
    challenge: deps.challenge as never,
    records: { create: async () => {}, touch: async () => {}, close: async () => {} },
  });
  const app = express();
  app.use(express.json());
  app.all("/mcp", createAuthMiddleware("public-or-user", deps), handler);
  app.all("/mcp/workspace", createAuthMiddleware("workspace", deps), handler);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    for (const s of sessions.values()) await s.transport.close().catch(() => {});
    server.closeAllConnections();
    server.close();
  }
}

type Opts = { token?: string; sid?: string; method?: string; body?: unknown; path?: string };
async function mcp(base: string, o: Opts = {}) {
  const res = await fetch(base + (o.path || "/mcp"), {
    method: o.method || "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
      ...(o.sid ? { "mcp-session-id": o.sid } : {}),
      ...(o.sid ? { "mcp-protocol-version": "2025-03-26" } : {}),
    },
    body: (o.method || "POST") === "POST" ? JSON.stringify(o.body ?? {}) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  const text = (o.method || "POST") === "GET" && res.status === 200 ? "" : await res.text();
  if ((o.method || "POST") === "GET" && res.status === 200) await res.body?.cancel();
  return { status: res.status, sid: res.headers.get("mcp-session-id"), text, www: res.headers.get("www-authenticate") };
}

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
const LIST = { jsonrpc: "2.0", id: 2, method: "tools/list" };

async function open(base: string, token?: string, path?: string) {
  const r = await mcp(base, { token, body: INIT, path });
  assert.equal(r.status, 200, r.text);
  await mcp(base, { token, sid: r.sid!, body: { jsonrpc: "2.0", method: "notifications/initialized" }, path });
  return r.sid!;
}
const toolNames = (text: string) => [...text.matchAll(/"name":"([a-z_]+)"/g)].map((m) => m[1]);

test("real transport: public session lists only search/fetch; signed-in session lists tenant tools", () =>
  withServer(async (base) => {
    const pub = await open(base);
    const l = await mcp(base, { sid: pub, body: LIST });
    assert.deepEqual(toolNames(l.text).sort(), ["fetch", "search"]);
    const priv = await open(base, "tok-a");
    const l2 = await mcp(base, { token: "tok-a", sid: priv, body: LIST });
    assert.ok(toolNames(l2.text).includes("market_search"));
  }));

test("real transport: private session refuses absent, invalid, expired, other-user (same tenant) and other-tenant tokens on POST, GET and DELETE", () =>
  withServer(async (base) => {
    const sid = await open(base, "tok-a");
    for (const method of ["POST", "GET", "DELETE"]) {
      for (const [label, token] of [["absent", undefined], ["invalid", "nope"], ["same-tenant other user", "tok-b"], ["other tenant", "tok-c"]] as const) {
        const r = await mcp(base, { token, sid, method, body: LIST });
        assert.equal(r.status, 401, `${method} ${label} -> ${r.status}`);
      }
    }
    // The owner still works afterwards (the refusals did not kill the session).
    assert.equal((await mcp(base, { token: "tok-a", sid, body: LIST })).status, 200);
    // A second token for the same user is still the same owner.
    assert.equal((await mcp(base, { token: "tok-a2", sid, body: LIST })).status, 200);
    // Expiry / revoked token mid-session fails closed on the next request.
    state.tokens.delete("tok-a");
    assert.equal((await mcp(base, { token: "tok-a", sid, body: LIST })).status, 401);
  }));

test("real transport: tenant change, revoked membership and changed broker mapping end the session's access", () =>
  withServer(async (base) => {
    const sid = await open(base, "tok-a");
    state.members.get("a")!.broker = "someone-else";
    assert.equal((await mcp(base, { token: "tok-a", sid, body: LIST })).status, 401);
    state.members.get("a")!.broker = "a";
    assert.equal((await mcp(base, { token: "tok-a", sid, body: LIST })).status, 200);
    state.members.get("a")!.tenant = "t9";
    assert.equal((await mcp(base, { token: "tok-a", sid, body: LIST })).status, 401);
    state.members.get("a")!.tenant = null; // membership revoked
    assert.equal((await mcp(base, { token: "tok-a", sid, body: LIST })).status, 403);
  }));

test("real transport: DELETE by the owner closes the session; unknown session ids follow the SDK (recorded, not assumed)", () =>
  withServer(async (base) => {
    const sid = await open(base, "tok-a");
    const del = await mcp(base, { token: "tok-a", sid, method: "DELETE" });
    assert.equal(del.status, 200);
    const afterPost = await mcp(base, { token: "tok-a", sid, body: LIST });
    const afterGet = await mcp(base, { token: "tok-a", sid, method: "GET" });
    const afterDel = await mcp(base, { token: "tok-a", sid, method: "DELETE" });
    console.log(`unknown-session SDK statuses: POST ${afterPost.status} GET ${afterGet.status} DELETE ${afterDel.status}`);
    for (const r of [afterPost, afterGet, afterDel]) assert.ok(r.status >= 400 && r.status < 500, `status ${r.status}`);
    // And an unknown id from a stranger never reaches private tools.
    const stranger = await mcp(base, { sid: "00000000-0000-4000-8000-000000000000", body: LIST });
    assert.ok(stranger.status >= 400 && stranger.status < 500);
    assert.ok(!toolNames(stranger.text).includes("market_search"));
  }));

test("real transport: /mcp/workspace has no token fallback to public", () =>
  withServer(async (base) => {
    const r = await mcp(base, { body: INIT, path: "/mcp/workspace" });
    assert.equal(r.status, 401);
    assert.ok(r.www);
    const sid = await open(base, "tok-a", "/mcp/workspace");
    assert.equal((await mcp(base, { sid, body: LIST, path: "/mcp/workspace" })).status, 401);
    assert.equal((await mcp(base, { token: "tok-a", sid, body: LIST, path: "/mcp/workspace" })).status, 200);
  }));
