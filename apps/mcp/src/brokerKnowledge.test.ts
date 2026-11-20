import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRawBrokerMcpServer, RAW_BROKER_TOOL_NAMES } from "./rawBrokerServer.ts";
import { BROKER_KNOWLEDGE } from "./brokerKnowledge.ts";

test("default raw session delivers generic background, unchanged tools and privacy rule", async () => {
  const server = createRawBrokerMcpServer({user:{id:"u",tenant_id:"t"}} as any);
  const client = new Client({name:"knowledge-test",version:"1"});
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st),client.connect(ct)]);
    const instructions = client.getInstructions() || "";
    assert.ok(instructions.includes(BROKER_KNOWLEDGE));
    assert.ok(instructions.includes("Only after the broker says a specific message/option"));
    assert.ok(instructions.includes("not direct"));
    assert.ok(instructions.includes("grants no access"));
    for (const text of ["Never search another broker's DMs through cross-search", "Would you like to review", "A yes to reviewing is not approval", "Do not claim all existing connected assistants were notified", "other group members", "members' expectations", "not a guarantee", "no new groups selected", "never count as consent", "reader access is separate"]) assert.ok(instructions.includes(text), text);
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map(t=>t.name).sort(), [...RAW_BROKER_TOOL_NAMES].sort());
    const search = tools.find(t=>t.name==="raw_message_search")!;
    assert.ok(search.description?.includes("(+1) means not direct"));
    assert.ok(!tools.some(t=>t.name.startsWith("property_")));
  } finally { await client.close();await server.close(); }
});

test("compiled default background is byte-identical to reviewed generic markdown", () => {
  assert.equal(BROKER_KNOWLEDGE, readFileSync(new URL("../../../docs/BROKER_AGENT_KNOWLEDGE.md", import.meta.url), "utf8"));
});
