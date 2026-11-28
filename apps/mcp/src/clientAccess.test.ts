import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

process.env.MCP_PORT = "0";

// token -> identity. tenant null = no organization.
const USERS: Record<string, { id: string; tenant: string | null; client: boolean; clientLookupFails?: boolean }> = {
  broker: { id: "u-broker", tenant: "t1", client: false },
  client: { id: "u-client", tenant: null, client: true },
  both: { id: "u-both", tenant: "t2", client: true },
  stranger: { id: "u-stranger", tenant: null, client: false },
  broken: { id: "u-broken", tenant: null, client: true, clientLookupFails: true },
};
const byId = (id: string) => Object.values(USERS).find((u) => u.id === id)!;

function makeServer(ctx: { user?: { id: string }; clientOnly?: boolean; publicOnly?: boolean }) {
  const server = new McpServer({ name: "stub", version: "1" });
  const kind = ctx.publicOnly ? "public" : ctx.clientOnly ? "client" : "broker";
  server.tool("whoami", "kind", async () => ({ content: [{ type: "text" as const, text: kind }] }));
  return server;
}

mock.module("./supabase.js", {
  namedExports: {
    verifyPropAIToken: async (token: string) => {
      const u = USERS[token];
      if (!u) throw new Error("bad token");
      return { id: u.id, user_metadata: { client: true, account_type: "client" }, app_metadata: {} };
    },
    resolveBrokerIdForUser: async (user: { id: string }) => `b-${user.id}`,
    resolveTenantIdForUser: async (user: { id: string }) => byId(user.id).tenant,
  },
});
mock.module("./clientAccess.js", {
  namedExports: {
    isClientAccount: async (id: string) => {
      const u = byId(id);
      if (u.clientLookupFails) throw new Error("db down");
      return u.client;
    },
    signupClient: async () => ({ ok: true }),
  },
});
mock.module("./oauth.js", {
  namedExports: {
    deviceAuthorizeHandler: (_q: unknown, r: any) => r.end(),
    oauthAuthorizationServerMetadata: (_q: unknown, r: any) => r.end(),
    oauthAuthorizeGetHandler: (_q: unknown, r: any) => r.end(),
    oauthAuthorizePostHandler: (_q: unknown, r: any) => r.end(),
    oauthProtectedResourceMetadata: (_q: unknown, r: any) => r.end(),
    oauthRegisterHandler: (_q: unknown, r: any) => r.end(),
    oauthTokenHandler: (_q: unknown, r: any) => r.end(),
    setMcpUnauthorizedHeaders: () => {},
  },
});
mock.module("./sessionStore.js", {
  namedExports: {
    createSessionRecord: async () => {},
    touchSessionRecord: async () => {},
    closeSessionRecord: async () => {},
  },
});
mock.module("./index.js", { namedExports: { createMcpServer: makeServer, MCP_TOOL_NAMES: [] } });
mock.module("./rawServer.js", { namedExports: { createRawMcpServer: makeServer } });

let base = "";
let httpServer: import("node:http").Server;
before(async () => {
  const mod = await import("./server.js");
  httpServer = mod.httpServer;
  if (!httpServer.listening) await new Promise((r) => httpServer.once("listening", r));
  base = `http://127.0.0.1:${(httpServer.address() as import("node:net").AddressInfo).port}`;
});
after(() => {
  httpServer.closeAllConnections?.();
  httpServer.close();
});

async function rpc(path: string, body: unknown, opts: { token?: string; sid?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.sid) headers["mcp-session-id"] = opts.sid;
  const res = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, sid: res.headers.get("mcp-session-id"), text: await res.text() };
}
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
const WHOAMI = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "whoami", arguments: {} } };

test("/mcp: explicit client account with no organization gets the client surface only", async () => {
  const init = await rpc("/mcp", INIT, { token: "client" });
  assert.equal(init.status, 200);
  const r = await rpc("/mcp", WHOAMI, { token: "client", sid: init.sid! });
  assert.match(r.text, /client/);
});

test("/mcp: broker with organization stays broker", async () => {
  const init = await rpc("/mcp", INIT, { token: "broker" });
  const r = await rpc("/mcp", WHOAMI, { token: "broker", sid: init.sid! });
  assert.match(r.text, /broker/);
});

test("/mcp: account with a client row is client-only even if a workspace was auto-created", async () => {
  const init = await rpc("/mcp", INIT, { token: "both" });
  const r = await rpc("/mcp", WHOAMI, { token: "both", sid: init.sid! });
  assert.match(r.text, /client/);
  assert.doesNotMatch(r.text, /broker/);
});

test("/mcp: no organization and no client row is refused; metadata client flags are ignored", async () => {
  const r = await rpc("/mcp", INIT, { token: "stranger" });
  assert.equal(r.status, 403);
});

test("/mcp: client lookup failure fails closed", async () => {
  const r = await rpc("/mcp", INIT, { token: "broken" });
  assert.equal(r.status, 503);
});

test("/raw-mcp: client accounts are refused", async () => {
  const r = await rpc("/raw-mcp", INIT, { token: "client" });
  assert.equal(r.status, 401);
});

test("/mcp: client session id cannot be used anonymously or by a broker", async () => {
  const init = await rpc("/mcp", INIT, { token: "client" });
  const anon = await rpc("/mcp", WHOAMI, { sid: init.sid! });
  assert.notEqual(anon.status, 200);
  const other = await rpc("/mcp", WHOAMI, { token: "broker", sid: init.sid! });
  assert.equal(other.status, 403);
});

test("/client/signup route responds", async () => {
  const res = await fetch(base + "/client/signup", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(res.status, 200);
});
