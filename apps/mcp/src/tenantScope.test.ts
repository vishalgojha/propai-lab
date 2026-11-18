import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Adversarial fixture: the authenticated user's broker_id points at ANOTHER
// workspace (as a forged owner claim would), while membership says OWN org.
// Every legacy data query must be scoped to the membership org, never to
// broker_id. A recording fake stands in for the service-role client.
const OWN = "00000000-0000-0000-0000-00000000000a";
const FOREIGN = "00000000-0000-0000-0000-00000000000f";
const calls: Array<{ table: string; col: string; val: unknown }> = [];

function builder(table: string): any {
  const b: any = {
    select: () => b, order: () => b, limit: () => b, not: () => b, or: () => b, in: () => b,
    gte: () => b, lte: () => b, ilike: () => b, is: () => b, neq: () => b, range: () => b,
    eq: (col: string, val: unknown) => { calls.push({ table, col, val }); return b; },
    insert: (row: any) => { for (const [col, val] of Object.entries(row || {})) if (col === "tenant_id") calls.push({ table, col: "insert.tenant_id", val }); return b; },
    upsert: (row: any) => { for (const [col, val] of Object.entries(row || {})) if (col === "tenant_id") calls.push({ table, col: "upsert.tenant_id", val }); return b; },
    update: () => b, delete: () => b,
    maybeSingle: async () => ({ data: null, error: null }),
    single: async () => ({ data: null, error: null }),
    then: (res: any) => res({ data: [], error: null }),
  };
  return b;
}
const fake = { from: (t: string) => builder(t), rpc: async () => ({ data: [], error: null }) };

test("legacy broker tools and resources scope every tenant_id filter/insert to membership org, not broker_id", async () => {
  const real = await import("./supabase.js");
  mock.module(new URL("./supabase.js", import.meta.url).href, { namedExports: { ...real, supabase: fake } });
  const { createMcpServer } = await import("./index.js");
  const server = createMcpServer({ user: { id: "actor-user", broker_id: FOREIGN, tenant_id: OWN } as any });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(st), client.connect(ct)]);

  const run = async (name: string, args: Record<string, unknown>) => { try { await client.callTool({ name, arguments: args }); } catch { /* tool errors are fine; we inspect queries */ } };
  await run("triage_hot_leads", { days: 7, limit: 5 });
  await run("stale_lead_reactivation", { days_stale: 21, limit: 5 });
  await run("summarise_thread", { remote_jid: "x@g.us", limit: 5 });
  await run("set_follow_up", { lead_name: "A", lead_phone: "9999999999" });
  await run("qualify_lead", { raw_text: "needs 2bhk", name: "A", phone: "9999999999" });
  await run("create_requirement", { raw_text: "needs 2bhk", name: "A", phone: "9999999999", location_pref: "Bandra" });
  for (const uri of ["propai://broker/activity", "propai://broker/hot-leads", "propai://broker/followups"]) {
    try { await client.readResource({ uri }); } catch { /* inspect queries */ }
  }
  await client.close();
  await server.close();

  const tenantCalls = calls.filter((c) => c.col === "tenant_id" || c.col.endsWith(".tenant_id"));
  assert.ok(tenantCalls.length > 5, `expected tenant-scoped queries, saw ${tenantCalls.length}`);
  const foreign = tenantCalls.filter((c) => c.val === FOREIGN);
  assert.deepEqual(foreign, [], `queries scoped to broker_id: ${JSON.stringify(foreign)}`);
  assert.ok(tenantCalls.every((c) => c.val === OWN), "every tenant filter/insert uses the membership org");
});

test("first-class inbox and broker tools scope each handler to membership org, not broker_id", async () => {
  const { createMcpServer } = await import("./index.js");
  const server = createMcpServer({ user: { id: "actor-user", broker_id: FOREIGN, tenant_id: OWN } as any });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const cases: Array<[string, Record<string, unknown>]> = [
    ["conversation_search", { limit: 5 }],
    ["conversation_timeline", { remote_jid: "x@s.whatsapp.net", limit: 5 }],
    ["conversation_summarize", { remote_jid: "x@s.whatsapp.net", limit: 5 }],
    ["broker_activity", { days: 7 }],
    ["broker_inventory", { limit: 5 }],
  ];
  for (const [name, args] of cases) {
    calls.length = 0;
    try { await client.callTool({ name, arguments: args }); } catch { /* inspect queries */ }
    const tc = calls.filter((c) => c.col === "tenant_id" || c.col.endsWith(".tenant_id"));
    assert.ok(tc.length > 0, `${name}: expected tenant-scoped queries`);
    assert.deepEqual(tc.filter((c) => c.val !== OWN), [], `${name}: query not scoped to membership org`);
  }
  await client.close();
  await server.close();
});
