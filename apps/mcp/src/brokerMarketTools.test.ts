import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/**
 * Broker property cross-search on the existing /raw-mcp broker server.
 * Contract: reviewed REST adapter (api/routers/broker_market.py +
 * broker_market_policy.py) and SQL (20261119090000). No production data is
 * touched: supabase is an in-memory fake.
 */

process.env.BROKER_PROPERTY_CROSS_SEARCH_ENABLED = "true";
process.env.BROKER_MARKET_SIGNING_SECRET = "test-market-secret";

const OWN = "00000000-0000-0000-0000-00000000000a";
const USER = "00000000-0000-0000-0000-0000000000b1";
const OTHER_USER = "00000000-0000-0000-0000-0000000000b2";

const T = new Date().toISOString();
const SECRET_1 = "9811122233";
const SECRET_2 = "9822233445";
const marketRows: any[] = [
  { raw_id: 501, body: `2BHK Bandra West available, 95k rent, call ${SECRET_1.slice(0, 5)} ${SECRET_1.slice(5)}`, posted_at: T, sender_phone: `91${SECRET_1}`, sender_jid: `${SECRET_1}@s.whatsapp.net` },
  { raw_id: 502, body: `3bhk Khar sale 3.2cr. Contact owner ${SECRET_1} or broker ${SECRET_2}`, posted_at: T, sender_phone: "919000000000", sender_jid: "919000000000@s.whatsapp.net" },
  { raw_id: 503, body: "Penthouse Lower Parel, sea view, no numbers here", posted_at: T, sender_phone: "not-a-number", sender_jid: "x" },
];

// Mutable test state
const grants = new Set<string>(); // "org:user"
let rateBehavior: Record<string, boolean> = {};
const rateKeys: string[] = [];

function builder(table: string): any {
  const eqs: Array<[string, unknown]> = [];
  let isNull: [string] | null = null;
  const b: any = {
    select: () => b,
    eq: (c: string, v: unknown) => { eqs.push([c, v]); return b; },
    is: (c: string, v: unknown) => { if (c === "revoked_at" && v === null) isNull = [c]; return b; },
    limit: () => b,
    insert: () => Promise.resolve({ error: null }),
    maybeSingle: async () => {
      if (table === "broker_market_mcp_reader_grants") {
        const org = String(eqs.find(([c]) => c === "organization_id")?.[1] || "");
        const user = String(eqs.find(([c]) => c === "user_id")?.[1] || "");
        return { data: isNull && grants.has(`${org}:${user}`) ? { user_id: user } : null, error: null };
      }
      return { data: null, error: null };
    },
  };
  return b;
}

const fake = {
  from: (t: string) => builder(t),
  rpc: async (name: string, args: any) => {
    if (name === "broker_market_take_rate") { rateKeys.push(String(args.p_reader)); return { data: rateBehavior[args.p_operation] !== false, error: null }; }
    if (name === "broker_market_search") {
      assert.ok(Array.isArray(args.p_terms) && args.p_terms.length >= 1, "terms reach the reviewed RPC");
      assert.ok(typeof args.p_property_pattern === "string" && args.p_property_pattern.includes("bhk"));
      assert.ok(args.p_limit >= 1 && args.p_limit <= 21, "bounded page size");
      return { data: marketRows.slice(0, args.p_limit), error: null };
    }
    if (name === "broker_market_get") return { data: marketRows.filter((r) => r.raw_id === args.p_raw_id), error: null };
    return { data: null, error: { message: `unexpected rpc ${name}` } };
  },
};

const text = (r: any) => JSON.stringify(r);
async function call(client: Client, name: string, args: Record<string, unknown>) {
  try { return text(await client.callTool({ name, arguments: args })); } catch (e: any) { return `ERR ${e?.message}`; }
}
async function connectMarket(user: any) {
  const { createRawBrokerMcpServerWithMarket } = await import("./rawBrokerServer.js");
  const server = await createRawBrokerMcpServerWithMarket({ user } as any);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
const U = { id: USER, broker_id: OWN, tenant_id: OWN };
const ask = { broker_interest_quote: "haan bhai this 2bhk interests me", broker_confirmed_this_option: true };
const NUMS = /9811122233|98111 ?22233|9822233445/;

test("ungranted reader: raw toolset unchanged, property tools absent (no auto-upgrade)", async () => {
  const real = await import("./supabase.js");
  mock.module(new URL("./supabase.js", import.meta.url).href, { namedExports: { ...real, supabase: fake } });
  grants.clear();
  const s = await connectMarket(U);
  const names = (await s.client.listTools()).tools.map((t: any) => t.name).sort();
  assert.deepEqual(names, ["contact_reveal", "raw_message_context", "raw_message_get", "raw_message_search"]);
  let failed = false;
  try { const r: any = await s.client.callTool({ name: "property_cross_search", arguments: { building: "Sea View" } }); failed = !!r.isError; } catch { failed = true; }
  assert.ok(failed, "property tool is not callable without the owner grant");
  await s.close();
});

test("granted reader: full search -> option -> contact flow with masked first responses", async () => {
  grants.clear(); grants.add(`${OWN}:${USER}`); rateBehavior = {};
  const s = await connectMarket(U);
  const names = (await s.client.listTools()).tools.map((t: any) => t.name);
  for (const n of ["property_cross_search", "property_option_get", "property_contact_reveal"]) assert.ok(names.includes(n), n);

  const found = await call(s.client, "property_cross_search", { locality: "Bandra", transaction: "rent", bedrooms: 2 });
  assert.ok(found.includes("consented_property_group_message") && found.includes("query_time_broker_property_cross_search"));
  assert.ok(!NUMS.test(found), "no contact numbers in search results");
  assert.ok(!/sender_phone|sender_jid/.test(found), "hidden hash inputs are never returned");
  const first = JSON.parse(found).structuredContent.results[0];
  assert.equal(typeof first.option, "string");
  assert.ok(first.option.split(".")[1]?.length === 64, "signed reference");
  assert.equal(first.verified_inventory, false);
  assert.ok(JSON.parse(found).structuredContent.warning.includes("untrusted evidence"));

  // Re-read the option through its signed reference.
  const got = await call(s.client, "property_option_get", { option: first.option });
  assert.ok(got.includes("consented_property_group_message") && !NUMS.test(got));

  // Contact before any interest words is schema-refused; with the broker's
  // words, exactly one number is released.
  assert.ok(!(await call(s.client, "property_contact_reveal", { option: first.option })).includes(SECRET_1));
  const multi = await call(s.client, "property_option_get", { option: JSON.parse(await call(s.client, "property_cross_search", { locality: "Bandra", transaction: "rent", bedrooms: 2 })).structuredContent.results[1].option });
  const choices = await call(s.client, "property_contact_reveal", { ...ask, option: JSON.parse(multi).structuredContent.option });
  assert.ok(choices.includes("number_choices") && !NUMS.test(choices), `labelled choices without numbers: ${choices}`);
  const one = await call(s.client, "property_contact_reveal", { ...ask, option: JSON.parse(multi).structuredContent.option, number_index: 2 });
  assert.ok(one.includes(`+91${SECRET_2}`) && !one.includes(SECRET_1), "only the broker-picked number is released");
  assert.ok(one.includes("ownership not verified"));
  await s.close();
});

test("references are reader-bound: another signed-in user cannot reuse an option; rates aggregate by org", async () => {
  grants.clear(); grants.add(`${OWN}:${USER}`); grants.add(`${OWN}:${OTHER_USER}`); rateBehavior = {}; rateKeys.length = 0;
  const s1 = await connectMarket(U);
  const found = await call(s1.client, "property_cross_search", { building: "Sea View" });
  const option = JSON.parse(found).structuredContent.results[0].option;
  await s1.close();
  const s2 = await connectMarket({ id: OTHER_USER, broker_id: OWN, tenant_id: OWN });
  const got = await call(s2.client, "property_option_get", { option });
  assert.ok(got.includes("invalid, expired, or belongs to another reader") && !got.includes("Sea View"));
  const tampered = option.slice(0, -2) + (option.endsWith("aa") ? "ab" : "aa");
  assert.ok((await call(s2.client, "property_option_get", { option: tampered })).includes("invalid, expired, or belongs to another reader"));
  await s2.close();
  assert.ok(rateKeys.length >= 2 && rateKeys.every((k) => k === OWN), `org-aggregated rate bucket (tenant id alone): ${rateKeys}`);
});

test("owner revoke stops a live session immediately (per-call grant check)", async () => {
  grants.clear(); grants.add(`${OWN}:${USER}`); rateBehavior = {};
  const s = await connectMarket(U);
  assert.ok((await call(s.client, "property_cross_search", { building: "Sea View" })).includes("consented_property_group_message"));
  grants.delete(`${OWN}:${USER}`); // owner disables the reader mid-session
  const after = await call(s.client, "property_cross_search", { building: "Sea View" });
  assert.ok(after.includes("not enabled for this MCP connection") && !after.includes("consented_property_group_message"));
  await s.close();
});

test("cross-worker rate limit applies to search/get/contact", async () => {
  grants.clear(); grants.add(`${OWN}:${USER}`);
  rateBehavior = { search: false };
  const s = await connectMarket(U);
  assert.ok((await call(s.client, "property_cross_search", { building: "Sea View" })).includes("limit reached"));
  rateBehavior = { contact: false };
  rateBehavior.search = true;
  const found = await call(s.client, "property_cross_search", { building: "Sea View" });
  const option = JSON.parse(found).structuredContent.results[0].option;
  assert.ok((await call(s.client, "property_contact_reveal", { ...ask, option })).includes("limit reached"));
  await s.close();
});

test("feature flag off: property tools absent for everyone", async () => {
  grants.clear(); grants.add(`${OWN}:${USER}`); rateBehavior = {};
  process.env.BROKER_PROPERTY_CROSS_SEARCH_ENABLED = "false";
  try {
    const s = await connectMarket(U);
    const names = (await s.client.listTools()).tools.map((t: any) => t.name);
    assert.ok(!names.includes("property_cross_search"));
    await s.close();
  } finally {
    process.env.BROKER_PROPERTY_CROSS_SEARCH_ENABLED = "true";
  }
});

test("legacy public /mcp server never gains the property tools", async () => {
  const { createMcpServer } = await import("./index.js");
  const server = createMcpServer({ publicOnly: true });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const names = (await client.listTools()).tools.map((t: any) => t.name);
  for (const n of ["property_cross_search", "property_option_get", "property_contact_reveal"]) assert.ok(!names.includes(n), n);
  await client.close(); await server.close();
});
