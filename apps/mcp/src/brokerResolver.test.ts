import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import type { AuthenticatedUser } from "./types.ts";

// Deterministic PostgREST stub: the real supabase-js client talks HTTP to it,
// so the test sees the exact queries the real resolver issues and can answer
// them with adversarial membership rows. Own process per test file, so the
// env override below cannot leak into other tests.
type Row = { member_user_id?: string; member_email?: string; workspace_owner_id: string; status: string };
let rows: Row[] = [];
let requests: string[] = [];
let server: http.Server;
let resolveBrokerIdForUser: (u: AuthenticatedUser) => Promise<string | null>;

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://stub");
    requests.push(decodeURIComponent(url.search));
    const q = url.searchParams;
    const matches = rows.filter((r) => {
      for (const [k, v] of q.entries()) {
        if (["select", "order", "limit"].includes(k)) continue;
        const m = /^(eq|in)\.(.*)$/.exec(v);
        if (!m) continue;
        const cell = (r as any)[k];
        if (m[1] === "eq" && String(cell) !== m[2]) return false;
        if (m[1] === "in" && !m[2].replace(/[()]/g, "").split(",").includes(String(cell))) return false;
      }
      return true;
    });
    const wantsObject = String(req.headers.accept || "").includes("vnd.pgrst.object");
    res.setHeader("content-type", "application/json");
    if (wantsObject) {
      if (!matches.length) { res.statusCode = 406; return res.end(JSON.stringify({ code: "PGRST116", message: "no rows", details: "", hint: "" })); }
      return res.end(JSON.stringify(matches[0]));
    }
    res.end(JSON.stringify(matches));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.SUPABASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub";
  process.env.SUPABASE_ANON_KEY = "stub";
  ({ resolveBrokerIdForUser } = (await import("./supabase.js")) as any);
});
after(() => { server.closeAllConnections(); server.close(); });

const user = (extra: Record<string, unknown> = {}) =>
  ({ id: "user-own", email: "invitee@example.test", email_confirmed_at: null, ...extra }) as unknown as AuthenticatedUser;
const reset = (r: Row[]) => { rows = r; requests = []; };

test("forged user_metadata.workspace_owner_id never selects another workspace", async () => {
  reset([]);
  assert.equal(await resolveBrokerIdForUser(user({ user_metadata: { workspace_owner_id: "victim" } })), "user-own");
});

test("stale or forged app_metadata does not override current membership", async () => {
  reset([{ member_user_id: "user-own", workspace_owner_id: "real-owner", status: "active" }]);
  assert.equal(await resolveBrokerIdForUser(user({ app_metadata: { workspace_owner_id: "stale-owner" } })), "real-owner");
  reset([]);
  assert.equal(await resolveBrokerIdForUser(user({ app_metadata: { workspace_owner_id: "stale-owner" } })), "user-own");
});

test("an email-only invitation (unconfirmed email) grants nothing and email is never queried", async () => {
  reset([{ member_email: "invitee@example.test", workspace_owner_id: "victim", status: "invited" }]);
  assert.equal(await resolveBrokerIdForUser(user()), "user-own");
  assert.ok(requests.every((r) => !r.includes("member_email")), `email lookup issued: ${requests.join(" | ")}`);
});

test("an invited (not accepted) membership by user id is not honored", async () => {
  reset([{ member_user_id: "user-own", workspace_owner_id: "victim", status: "invited" }]);
  assert.equal(await resolveBrokerIdForUser(user()), "user-own");
});

test("an active membership by immutable user id is honored; other users' rows are not", async () => {
  reset([
    { member_user_id: "someone-else", workspace_owner_id: "victim", status: "active" },
    { member_user_id: "user-own", workspace_owner_id: "owner-1", status: "active" },
  ]);
  assert.equal(await resolveBrokerIdForUser(user()), "owner-1");
});
