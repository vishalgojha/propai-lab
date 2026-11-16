import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, MCP_TOOL_NAMES } from "./index.ts";
import { createPublicMcpServer, isActive, searchEligible } from "./publicTools.ts";

const BROKER_ONLY_TOOLS = [
  "save_listing",
  "create_requirement",
  "qualify_lead",
  "draft_broadcast",
  "set_follow_up",
  "match_requirement_to_broker",
  "summarise_thread",
  "triage_hot_leads",
];

async function listToolNames(server: ReturnType<typeof createMcpServer>): Promise<string[]> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools.map((tool) => tool.name).sort();
}

test("public (account-free) server exposes only search and fetch", async () => {
  const names = await listToolNames(createPublicMcpServer());
  assert.deepEqual(names, ["fetch", "search"]);
});

test("public context via createMcpServer is isolated to public tools", async () => {
  const names = await listToolNames(createMcpServer({ publicOnly: true }));
  assert.deepEqual(names, ["fetch", "search"]);
  for (const brokerTool of BROKER_ONLY_TOOLS) {
    assert.ok(!names.includes(brokerTool), `${brokerTool} must never be public`);
  }
});

test("broker (tenant) context keeps the full toolset", async () => {
  const names = await listToolNames(createMcpServer({ user: { id: "u1", broker_id: "u1", tenant_id: "t1" } as never }));
  assert.ok(names.length > 10, "broker server should expose the full toolset");
  assert.ok(names.includes("search") && names.includes("fetch"));
  for (const brokerTool of BROKER_ONLY_TOOLS) {
    assert.ok(names.includes(brokerTool), `broker server keeps ${brokerTool}`);
  }
});

test("MCP_TOOL_NAMES metadata still reflects the broker toolset", () => {
  assert.ok(MCP_TOOL_NAMES.length > 10);
});

const DAY_MS = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();

const FRESH_ROW = { summary_title: "2 BHK in Bandra West", last_seen: daysAgo(1) };

test("public search gate excludes placeholder titles and stale or untimed rows", () => {
  const cutoff = new Date(Date.now() - 30 * DAY_MS);
  assert.equal(searchEligible(FRESH_ROW, cutoff), true);
  // placeholder / missing titles (the website's effective eligibility gate)
  assert.equal(searchEligible({ ...FRESH_ROW, summary_title: "[unstructured] 2 bhk" }, cutoff), false);
  assert.equal(searchEligible({ ...FRESH_ROW, summary_title: "[Listing]" }, cutoff), false);
  assert.equal(searchEligible({ ...FRESH_ROW, summary_title: "" }, cutoff), false);
  // expired rows: older than the 30-day window, or never observed
  assert.equal(searchEligible({ ...FRESH_ROW, last_seen: daysAgo(45) }, cutoff), false);
  assert.equal(searchEligible({ ...FRESH_ROW, last_seen: null }, cutoff), false);
});

test("public fetch marks listings inactive after 90 quiet days", () => {
  assert.equal(isActive(FRESH_ROW), true);
  assert.equal(isActive({ ...FRESH_ROW, last_seen: daysAgo(45) }), true);
  assert.equal(isActive({ ...FRESH_ROW, last_seen: daysAgo(120) }), false);
  assert.equal(isActive({ ...FRESH_ROW, last_seen: null }), true);
});
