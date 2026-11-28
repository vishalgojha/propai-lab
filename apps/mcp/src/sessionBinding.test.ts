import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Real HTTP requests against the real server.ts routes. Only identity
// resolution and the tool surface are replaced, with two synthetic users.
process.env.MCP_PORT = "0";

const USERS: Record<string, { id: string; tenant: string }> = {
  "token-a": { id: "user-a", tenant: "tenant-a" },
  "token-b": { id: "user-b", tenant: "tenant-b" },
};

function makeServer(ctx: { user?: { id: string; tenant_id?: string } }) {
  const server = new McpServer({ name: "stub", version: "1" });
  server.tool("whoami", "returns the identity baked into this session", async () => ({
    content: [{ type: "text" as const, text: ctx.user ? `${ctx.user.id}/${ctx.user.tenant_id}` : "public" }],
  }));
  return server;
}

mock.module("./supabase.js", {
  namedExports: {
    verifyPropAIToken: async (token: string) => {
      const u = USERS[token];
      if (!u) throw new Error("bad token");
      return { id: u.id };
    },
    resolveBrokerIdForUser: async (user: { id: string }) => `broker-${user.id}`,
    resolveTenantIdForUser: async (user: { id: string }) => (user.id === "user-a" ? "tenant-a" : "tenant-b"),
  },
});
mock.module("./clientAccess.js", { namedExports: { isClientAccount: async () => false, signupClient: async () => ({ ok: true }) } });
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
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.sid) headers["mcp-session-id"] = opts.sid;
  const res = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, sid: res.headers.get("mcp-session-id"), text: await res.text() };
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } },
};
const WHOAMI = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "whoami", arguments: {} } };

async function open(path: string, token?: string) {
  const r = await rpc(path, INIT, { token });
  assert.equal(r.status, 200);
  assert.ok(r.sid);
  return r.sid!;
}

for (const path of ["/mcp", "/raw-mcp"]) {
  test(`${path}: owner keeps using own session and runs under own identity`, async () => {
    const sid = await open(path, "token-a");
    const r = await rpc(path, WHOAMI, { token: "token-a", sid });
    assert.equal(r.status, 200);
    assert.match(r.text, /user-a\/tenant-a/);
  });

  test(`${path}: a different authenticated user cannot use another user's session id`, async () => {
    const sid = await open(path, "token-a");
    const r = await rpc(path, WHOAMI, { token: "token-b", sid });
    assert.equal(r.status, 403);
    assert.doesNotMatch(r.text, /user-a|tenant-a/);
  });

  test(`${path}: anonymous request cannot use an authenticated user's session id`, async () => {
    const sid = await open(path, "token-a");
    const r = await rpc(path, WHOAMI, { sid });
    assert.notEqual(r.status, 200);
    assert.doesNotMatch(r.text, /user-a|tenant-a/);
  });
}

test("/mcp: authenticated user cannot take over an anonymous public session", async () => {
  const sid = await open("/mcp");
  const r = await rpc("/mcp", WHOAMI, { token: "token-a", sid });
  assert.equal(r.status, 403);
});

test("/mcp: public session still works for the anonymous caller that opened it", async () => {
  const sid = await open("/mcp");
  const r = await rpc("/mcp", WHOAMI, { sid });
  assert.equal(r.status, 200);
  assert.match(r.text, /public/);
});

test("/raw-mcp: session ids do not cross between /mcp and /raw-mcp", async () => {
  const sid = await open("/mcp", "token-a");
  const r = await rpc("/raw-mcp", WHOAMI, { token: "token-a", sid });
  assert.doesNotMatch(r.text, /user-a\/tenant-a/);
});
