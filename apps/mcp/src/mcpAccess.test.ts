import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { createAuthMiddleware, sessionAccessAllowed, sessionOwnerFor, type AccessDeps } from "./mcpAccess.ts";
import type { AuthenticatedUser } from "./types.ts";

const users: Record<string, { id: string; tenant: string | null }> = {
  "tok-a": { id: "user-a", tenant: "tenant-a" },
  "tok-b": { id: "user-b", tenant: "tenant-b" },
  "tok-orphan": { id: "user-c", tenant: null },
};

const deps: AccessDeps = {
  verify: async (token) => {
    const u = users[token];
    if (!u) throw new Error("bad token");
    return { id: u.id } as AuthenticatedUser;
  },
  resolveBrokerId: async (user) => user.id,
  resolveTenantId: async (user) => Object.values(users).find((u) => u.id === user.id)?.tenant ?? null,
  challenge: (_req, res, mode) =>
    res.setHeader(
      "WWW-Authenticate",
      `Bearer resource_metadata="https://mcp.test/.well-known/oauth-protected-resource${mode === "workspace" ? "/mcp/workspace" : ""}"`,
    ),
};

async function withApp(run: (base: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  const sessions = new Map<string, ReturnType<typeof sessionOwnerFor>>();
  const handler = (req: express.Request, res: express.Response) => {
    const sid = String(req.headers["mcp-session-id"] || "");
    if (sid && sessions.has(sid)) {
      if (!sessionAccessAllowed(sessions.get(sid), req)) return res.status(401).json({ error: "session" });
      return res.json({ reused: true, publicOnly: req.publicOnly === true, tenant: req.user?.tenant_id ?? null });
    }
    const id = `s-${sessions.size + 1}`;
    sessions.set(id, sessionOwnerFor(req));
    res.setHeader("mcp-session-id", id);
    res.json({ created: id, publicOnly: req.publicOnly === true, tenant: req.user?.tenant_id ?? null });
  };
  app.all("/mcp", createAuthMiddleware("public-or-user", deps), handler);
  app.all("/mcp/workspace", createAuthMiddleware("workspace", deps), handler);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

const call = (base: string, path: string, token?: string, sid?: string) =>
  fetch(base + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(sid ? { "mcp-session-id": sid } : {}),
    },
    body: "{}",
  });

test("/mcp without a token stays public, never 401", () =>
  withApp(async (base) => {
    const res = await call(base, "/mcp");
    assert.equal(res.status, 200);
    assert.equal((await res.json() as any).publicOnly, true);
  }));

test("/mcp/workspace without a token is 401 with a path-specific OAuth challenge", () =>
  withApp(async (base) => {
    const res = await call(base, "/mcp/workspace");
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") || "", /oauth-protected-resource\/mcp\/workspace/);
  }));

test("workspace: invalid token fails closed, valid token gets its own tenant", () =>
  withApp(async (base) => {
    assert.equal((await call(base, "/mcp/workspace", "nope")).status, 401);
    const ok = await call(base, "/mcp/workspace", "tok-a");
    assert.equal(ok.status, 200);
    assert.equal((await ok.json() as any).tenant, "tenant-a");
  }));

test("a signed-in user without tenant membership is refused (403) on both routes", () =>
  withApp(async (base) => {
    assert.equal((await call(base, "/mcp/workspace", "tok-orphan")).status, 403);
    assert.equal((await call(base, "/mcp", "tok-orphan")).status, 403);
  }));

test("/mcp with an invalid token still fails 401 and never downgrades to public", () =>
  withApp(async (base) => {
    assert.equal((await call(base, "/mcp", "nope")).status, 401);
  }));

test("another tenant's token or no token cannot use a signed-in user's session id", () =>
  withApp(async (base) => {
    const first = await call(base, "/mcp/workspace", "tok-a");
    const sid = first.headers.get("mcp-session-id")!;
    assert.equal((await call(base, "/mcp/workspace", "tok-a", sid)).status, 200);
    assert.equal((await call(base, "/mcp/workspace", "tok-b", sid)).status, 401);
    assert.equal((await call(base, "/mcp/workspace", undefined, sid)).status, 401);
    assert.equal((await call(base, "/mcp", undefined, sid)).status, 401);
    assert.equal((await call(base, "/mcp", "tok-b", sid)).status, 401);
    assert.equal((await call(base, "/mcp", "tok-a", sid)).status, 200);
  }));

test("a public session is not tied to anyone and cannot be upgraded to private data", () =>
  withApp(async (base) => {
    const first = await call(base, "/mcp");
    const sid = first.headers.get("mcp-session-id")!;
    const again = await call(base, "/mcp", undefined, sid);
    assert.equal(again.status, 200);
    assert.equal((await again.json() as any).publicOnly, true);
  }));
