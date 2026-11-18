import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// In-memory PostgREST-like fake: applies eq filters so a DM row is only
// returned when the query did not exclude it. DM_TEXT must never appear in a
// response unless every gate passes.
const OWN = "00000000-0000-0000-0000-00000000000a";
const FOREIGN = "00000000-0000-0000-0000-00000000000f";
const GROUP_TEXT = "GROUPMSG 2bhk bandra";
const DM_TEXT = "SECRETDM client private chat";

const T = new Date().toISOString();
const mk = (id: number, tenant: string, text: string, group: string | null) => ({ id, tenant_id: tenant, is_group: true, group_name: group, sender: "S" + id, sender_phone: null, message: text, message_type: "text", timestamp: T, created_at: T, sender_jid: "x", source: "x" });
const rows: any[] = [
  { id: 1, tenant_id: OWN, is_group: true, group_name: "Bandra Brokers", sender: "A", message: GROUP_TEXT, message_type: "text", timestamp: new Date().toISOString(), created_at: new Date().toISOString(), sender_jid: "g1@g.us", source: "x" },
  { id: 2, tenant_id: OWN, is_group: false, group_name: null, sender: "B", message: DM_TEXT, message_type: "text", timestamp: new Date().toISOString(), created_at: new Date().toISOString(), sender_jid: "919@s.whatsapp.net", source: "x" },
  { id: 5, tenant_id: OWN, is_group: true, group_name: "Raw Only Group", sender: "Ravi Sender", sender_phone: "919811122233", message: "RAWONLY 3bhk Juhu urgent sale, call my partner on 98765 43210", message_type: "text", timestamp: new Date().toISOString(), created_at: new Date().toISOString(), sender_jid: "g5@g.us", source: "x" },
  { id: 6, tenant_id: OWN, is_group: true, group_name: "Forwards", sender: "Fwd Poster", sender_phone: null, message: "RAWMULTI two flats: A call 98111 00001 and B call 98111 00002", message_type: "text", timestamp: new Date().toISOString(), created_at: new Date().toISOString(), sender_jid: "g6@g.us", source: "x" },
  { id: 4, tenant_id: OWN, is_group: null, group_name: null, sender: "D", message: "LEAK_NULLGROUP", message_type: "text", timestamp: new Date().toISOString(), created_at: new Date().toISOString(), sender_jid: "x", source: "x" },
  { id: 7, tenant_id: OWN, is_group: true, group_name: "Mixed", sender: "Lon +44 7911 123456", sender_phone: null, message: "MIXEDCTRY contact London +44 7911 123456 or 020 7946 0958; flat A call 98111 00003 and flat B call 98111 00004", message_type: "text", timestamp: new Date().toISOString(), created_at: new Date().toISOString(), sender_jid: "g7@g.us", source: "x" },
  { id: 3, tenant_id: FOREIGN, is_group: true, group_name: "Other", sender: "C", message: "FOREIGNMSG", message_type: "text", timestamp: new Date().toISOString(), created_at: new Date().toISOString(), sender_jid: "g9@g.us", source: "x" },
  mk(8, OWN, "UNSEL_INACTIVE 2bhk call 98111 00008", "Inactive Group"),
  mk(9, OWN, "UNSEL_OPTEDOUT 2bhk call 98111 00009", "Opted Out Group"),
  mk(10, OWN, "UNSEL_NOROW 2bhk call 98111 00010", "No Row Group"),
  mk(12, OWN, "UNSEL_OTHERTENANTROW 2bhk call 98111 00012", "Other Tenant Selected"),
];
const jidOf: Record<number, string> = { 1: "g1@g.us", 5: "g5@g.us", 6: "g6@g.us", 7: "g7@g.us", 8: "g8@g.us", 9: "g9@g.us", 10: "g10@g.us", 12: "g12@g.us" };
for (const r of rows) (r as any).jid_a = jidOf[r.id] ?? null;
const conns = [
  ...[1, 5, 6, 7].map((n) => ({ organization_id: OWN, group_jid: `g${n}@g.us`, is_active: true, opted_out: false })),
  { organization_id: OWN, group_jid: "g8@g.us", is_active: false, opted_out: false },
  { organization_id: OWN, group_jid: "g9@g.us", is_active: true, opted_out: true },
  { organization_id: FOREIGN, group_jid: "g12@g.us", is_active: true, opted_out: false },
];

function builder(table: string): any {
  const eqs: Array<[string, unknown]> = [];
  const ins: Array<[string, unknown[]]> = [];
  let rng: [number, number] | null = null; let ord = false; let term = "";
  const b: any = {
    select: () => b, order: (c: string) => { if (c === "timestamp") ord = true; return b; }, limit: () => b, range: (a: number, z: number) => { rng = [a, z]; return b; }, not: () => b, or: () => b, in: (c: string, vs: unknown[]) => { ins.push([c, vs]); return b; },
    gte: () => b, lte: () => b, lt: () => b, gt: () => b, ilike: () => b, textSearch: (_c: string, q: string) => { term = String(q).toLowerCase(); return b; }, is: () => b, neq: () => b,
    eq: (c: string, v: unknown) => { eqs.push([c, v]); return b; },
    insert: () => b, upsert: () => b, update: () => b, delete: () => b,
    then: (res: any) => res(run()),
    maybeSingle: async () => { const r = run(); return { data: (r.data as any[])?.[0] ?? null, error: r.error }; },
    single: async () => { const r = run(); return { data: (r.data as any[])?.[0] ?? null, error: r.error }; },
  };
  function run(): { data: any[] | null; error: any } {
    if (table === "raw_messages") {
      let out = rows.filter((r) => eqs.every(([c, v]) => (r as any)[c] === v) && ins.every(([c, vs]) => vs.includes((r as any)[c])) && (!term || String(r.message).toLowerCase().includes(term)));
      if (ord) out = [...out].sort((x: any, y: any) => Date.parse(y.timestamp) - Date.parse(x.timestamp) || y.id - x.id);
      if (rng) out = out.slice(rng[0], rng[1] + 1);
      return { data: out, error: null };
    }
    if (table === "organization_group_connections") return { data: conns.filter((r) => eqs.every(([c, v]) => (r as any)[c] === v)), error: null };
    return { data: [], error: null };
  }
  return b;
}
const fake = {
  from: (t: string) => builder(t),
  rpc: async (name: string, args: any) => {
    
    if (name === "get_raw_message_context") {
      return { data: rows.filter((r) => r.tenant_id === args.p_tenant_id).map((r) => ({ ...r, chat_jid: (r as any).jid_a ?? "c", is_anchor: r.id === args.p_raw_message_id })), error: null };
    }
    return { data: [], error: null };
  },
};


const text = (r: any) => JSON.stringify(r);
async function call(client: Client, name: string, args: Record<string, unknown>) {
  try { return text(await client.callTool({ name, arguments: args })); } catch (e: any) { return `ERR ${e?.message}`; }
}
async function connectRaw(user: any) {
  const { createRawBrokerMcpServer } = await import("./rawBrokerServer.js");
  const server = createRawBrokerMcpServer({ user } as any);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
const U = { id: "u", broker_id: OWN, tenant_id: OWN };
const NUMS = /9811122233|9876543210|98765 ?43210|9811100001|9811100002|98111 ?0000[12]/;
const ask = { broker_interest_quote: "yes this one looks interesting", broker_confirmed_this_listing: true };

test("raw-only flow on /raw-mcp: search -> pick raw message -> reveal, no extracted row, groups only", async () => {
  const real = await import("./supabase.js");
  mock.module(new URL("./supabase.js", import.meta.url).href, { namedExports: { ...real, supabase: fake } });
  const s = await connectRaw(U);
  assert.ok(!NUMS.test(await call(s.client, "contact_reveal", { ...ask, raw_message_id: 5 })), "reveal before any search is refused");
  const found = await call(s.client, "raw_message_search", { query: "RAWONLY", limit: 10 });
  assert.ok(found.includes("RAWONLY") && found.includes("raw message 5"), "evidence and source id kept");
  assert.ok(!NUMS.test(found) && found.includes("not a paywall"), "no number in first response, notice shown");
  assert.ok(!NUMS.test(await call(s.client, "contact_reveal", { raw_message_id: 5 })), "missing intent refused");
  const rev = await call(s.client, "contact_reveal", { ...ask, raw_message_id: 5 });
  assert.ok(rev.includes("+919811122233") && /Sender of this message/.test(rev) && /not necessarily the broker/.test(rev));
  assert.ok(!rev.includes("9876543210"), "text numbers are not released with the sender");
  // Everything else stays closed: DM, null-classified, cross-tenant, missing, unseen.
  for (const id of [2, 4, 3, 999, 6]) assert.ok(!NUMS.test(await call(s.client, "contact_reveal", { ...ask, raw_message_id: id })), `unseen/closed id ${id}`);
  const all = await call(s.client, "raw_message_search", { limit: 100 });
  assert.ok(!/SECRETDM|FOREIGNMSG|LEAK_NULLGROUP/.test(all), "DM, foreign tenant and null-classified messages never appear");
  assert.ok(!/SECRETDM/.test(await call(s.client, "raw_message_get", { raw_message_id: 2 })));
  assert.ok(!/SECRETDM|FOREIGNMSG/.test(await call(s.client, "raw_message_context", { raw_message_id: 2 })));
  assert.ok(!/SECRETDM/.test(await call(s.client, "raw_message_search", { query: "private", scope: "all" })), "no way to request DMs on this interface");
  await s.close();
});

test("keyword-only surface: no semantic search tool is advertised or callable on /raw-mcp", async () => {
  const s = await connectRaw(U);
  const names = (await s.client.listTools()).tools.map((t: any) => t.name).sort();
  assert.deepEqual(names, ["contact_reveal", "raw_message_context", "raw_message_get", "raw_message_search"]);
  let failed = false;
  try { const r: any = await s.client.callTool({ name: "raw_message_semantic_search", arguments: { query: "2bhk" } }); failed = !!r.isError; } catch { failed = true; }
  assert.ok(failed, "semantic tool is not callable");
  await s.close();
});

test("several numbers: masked contextual labels, one chosen number, nothing else", async () => {
  const s = await connectRaw(U);
  await call(s.client, "raw_message_get", { raw_message_id: 6 });
  const amb = await call(s.client, "contact_reveal", { ...ask, raw_message_id: 6 });
  assert.ok(/A call \(this number\)/.test(amb) && /B call \(this number\)/.test(amb) && !NUMS.test(amb), "labels name each option and contain no number");
  const one = await call(s.client, "contact_reveal", { ...ask, raw_message_id: 6, number_index: 2 });
  assert.ok(one.includes("+919811100002") && !one.includes("9811100001") && one.includes("message text"));
  await s.close();
});

test("a legacy listing id, an unseen id and an out-of-range index cannot unlock anything", async () => {
  const s = await connectRaw(U);
  await call(s.client, "raw_message_search", { query: "RAWMULTI" });
  assert.ok(!NUMS.test(await call(s.client, "contact_reveal", { ...ask, listing_id: "6:0", raw_message_id: 6, number_index: 9 })));
  assert.ok(!NUMS.test(await call(s.client, "contact_reveal", { ...ask, raw_message_id: 6, number_index: 9 })));
  await s.close();
});

test("mixed-country message: no unselected number of any country appears in reveal labels, name or text; only the chosen number is released", async () => {
  const s = await connectRaw(U);
  await call(s.client, "raw_message_get", { raw_message_id: 7 });
  const LON = /7911|123456|7946|0958|\+44/;
  const amb = await call(s.client, "contact_reveal", { ...ask, raw_message_id: 7 });
  assert.ok(!LON.test(amb) && !NUMS.test(amb) && !/9811100003|9811100004|98111 ?0000[34]/.test(amb), "labels and sender name carry no digits of any country");
  assert.ok(/flat A call \(this number\)/.test(amb) && /flat B call \(this number\)/.test(amb), "labels still distinguish the options");
  const one = await call(s.client, "contact_reveal", { ...ask, raw_message_id: 7, number_index: 2 });
  assert.ok(one.includes("+919811100004") && !one.includes("9811100003") && !LON.test(one), "only the selected number, London number still hidden");
  await s.close();
});

test("group selection control: unselected, inactive, opted-out, no-row and other-tenant-row groups are closed on every raw tool", async () => {
  const s = await connectRaw(U);
  const UNSEL = /UNSEL_/;
  const all = await call(s.client, "raw_message_search", { limit: 100 });
  assert.ok(all.includes("RAWONLY") && !UNSEL.test(all), "selected groups served, none of the unselected ones");
  for (const id of [8, 9, 10, 12]) {
    assert.ok(!UNSEL.test(await call(s.client, "raw_message_get", { raw_message_id: id })), `get ${id}`);
    assert.ok(!UNSEL.test(await call(s.client, "raw_message_context", { raw_message_id: id })), `context ${id}`);
    assert.ok(!/98111 ?0000(8|9)|9811100010|9811100012/.test(await call(s.client, "contact_reveal", { ...ask, raw_message_id: id })), `reveal ${id}`);
  }
  const ctx = await call(s.client, "raw_message_context", { raw_message_id: 1 });
  assert.ok(ctx.includes("GROUPMSG") && !UNSEL.test(ctx), "selected group context still works");
  await s.close();
});

function addBulk(unselected: number, selectedIds: number[]) {
  const base = Date.now();
  const added: any[] = [];
  selectedIds.forEach((id, i) => added.push({ ...mk(id, OWN, `PAGETEST selected ${id}`, "Page Group"), jid_a: "g1@g.us", timestamp: new Date(base - 10_000_000 - i * 1000).toISOString() }));
  for (let i = 0; i < unselected; i++) added.push({ ...mk(5000 + i, OWN, `PAGETEST unselected ${i}`, "Gone Group"), jid_a: "g8@g.us", timestamp: new Date(base - 1000 - i).toISOString() });
  rows.push(...added);
  return () => { for (const r of added) rows.splice(rows.indexOf(r), 1); };
}
const cursorOf = (t: string) => { const m = t.match(/"next_cursor":"(\d+)"/); return m ? m[1] : null; };
const idsOf = (t: string) => [...new Set([...t.matchAll(/PAGETEST selected (\d+)/g)].map((m) => Number(m[1])))];

for (const tool of ["raw_message_search"]) {
  test(`${tool}: >100 unselected hits before the selected ones, cursor alone advances, every selected row is reachable once`, async () => {
    const undo = addBulk(150, [9001, 9002, 9003]);
    try {
      const s = await connectRaw(U);
      const seen: number[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 6; guard++) {
        const t = await call(s.client, tool, cursor ? { query: "PAGETEST", limit: 1, cursor } : { query: "PAGETEST", limit: 1 });
        assert.ok(!/PAGETEST unselected/.test(t), "unselected group never returned");
        seen.push(...idsOf(t));
        cursor = cursorOf(t);
        if (!cursor) break;
      }
      assert.deepEqual([...seen].sort(), [9001, 9002, 9003], `all selected rows reached exactly once, got ${seen}`);
      await s.close();
    } finally { undo(); }
  });

  test(`${tool}: scan budget exhausted by unselected hits is reported as scan_limited with an advancing cursor, never as no match`, async () => {
    const undo = addBulk(900, [9101]);
    try {
      const s = await connectRaw(U);
      const first = await call(s.client, tool, { query: "PAGETEST", limit: 5 });
      assert.ok(!idsOf(first).length, "selected row is beyond the scan budget");
      assert.ok(/"scan_limited":true/.test(first) && /scanned so far/.test(first) && !/No (raw group|stored group) messages matched/.test(first), "reported as incomplete scan, not as no match");
      const c = cursorOf(first);
      assert.ok(c && Number(c) >= 800, `cursor resumes after the scanned part: ${c}`);
      const second = await call(s.client, tool, { query: "PAGETEST", limit: 5, cursor: c });
      assert.deepEqual(idsOf(second), [9101], "following the cursor finds the selected row");
      await s.close();
    } finally { undo(); }
  });
}
