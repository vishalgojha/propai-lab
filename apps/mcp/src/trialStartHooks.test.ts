import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Functional coverage for the assistant-trial success boundary: the 15-day
// clock starts only after a substantive search handler actually returns, and
// never on errored, schema-rejected, unknown, or non-search (admin/write)
// tool calls. Runs against the real MCP server over an in-memory transport;
// only the data layer, the search engine, and the trial recorder are mocked.

const recordCalls: string[] = [];

let executeMarketSearchImpl: (input: unknown) => Promise<unknown> = async () => ({ query: "", explanation: "", results: [] });
let getMarketSummaryImpl: () => Promise<unknown> = async () => ({ listing_count: 0 });
let matchRequirementToInventoryImpl: () => Promise<unknown> = async () => ({ items: [] });

const asyncStub = async () => ({});

const dataMock = mock.module("./data.js", {
  namedExports: {
    buildBroadcastDraft: asyncStub,
    buildListingAdPack: asyncStub,
    buildPricingNegotiationBrief: asyncStub,
    createRequirementRecord: asyncStub,
    describeSearch: () => "",
    estimatePrice: async () => ({ summary: "estimate" }),
    fetchListingById: asyncStub,
    findBrokers: async () => [],
    getBrokerActivity: asyncStub,
    getBuildingIntel: async () => ({ locality_supply: [], matched_localities: [], price_benchmarks: {}, sample_days: 90 }),
    getFreshStream: asyncStub,
    getHotLeadTriage: asyncStub,
    getMarketSummary: (input: unknown) => getMarketSummaryImpl(),
    getPendingFollowUps: async () => [],
    getRecentRequirements: async () => [],
    getSavedRequirements: async () => [],
    getRecentSavedListings: async () => [],
    getStaleInventory: async () => ({ results: [] }),
    getStaleLeadReactivation: asyncStub,
    getStoredThreadMessages: async () => [],
    getWorkspaceListingById: asyncStub,
    getWorkspaceListings: async () => [],
    logToolCall: async () => undefined,
    matchBuyerToInventory: async () => ({ items: [] }),
    matchRequirementToInventory: () => matchRequirementToInventoryImpl(),
    normalizeAvailabilityStatus: (v: unknown) => v,
    qualifyLead: asyncStub,
    saveListingRecord: asyncStub,
    scheduleFollowUp: async () => ({ id: "f1" }),
    searchPublicListings: async () => [],
    searchRawMessages: async () => ({ items: [], has_more: false }),
    searchRawMessagesSemantic: async () => ({ items: [], has_more: false }),
    getRawMessageById: asyncStub,
    getRawMessageContext: asyncStub,
    searchRequirements: async () => [],
    summarizeThread: async () => "",
    toMarketSearchRow: (row: unknown) => row,
    verifyListingAvailability: asyncStub,
  },
});

const supabaseMock = mock.module("./supabase.js", {
  namedExports: {
    recordAssistantSearchSuccess: (tenantId: string) => {
      recordCalls.push(tenantId);
    },
    supabase: {},
  },
});

const marketSearchMock = mock.module("./marketSearch.js", {
  namedExports: {
    executeMarketSearch: (input: unknown) => executeMarketSearchImpl(input),
  },
});

// The real anomaly reporters batch on a 5-minute timer; that timer would keep
// the test process alive, so the reporting side effect is mocked out here.
const anomaliesMock = mock.module("./anomalies.js", {
  namedExports: {
    reportMarketResultAnomalies: () => undefined,
    reportMcpParserError: () => undefined,
  },
});

const { createMcpServer } = await import("./index.ts");

test.after(() => {
  dataMock.restore();
  supabaseMock.restore();
  marketSearchMock.restore();
  anomaliesMock.restore();
  mock.restoreAll();
});

const TENANT_CONTEXT = { user: { id: "u1", broker_id: "u1", tenant_id: "t1" } as never };

async function callTool(name: string, args: Record<string, unknown>) {
  const server = createMcpServer(TENANT_CONTEXT);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "trial-test-client", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  let result: unknown = null;
  let threw: unknown = null;
  try {
    result = await client.callTool({ name, arguments: args });
  } catch (error) {
    threw = error;
  }
  await client.close();
  await server.close();
  return { result, threw };
}

function isErrorResult(out: { result: unknown; threw: unknown }) {
  if (out.threw) return true;
  const r = out.result as { isError?: boolean } | null;
  return Boolean(r && typeof r === "object" && r.isError);
}

test.beforeEach(() => {
  recordCalls.length = 0;
  executeMarketSearchImpl = async () => ({ query: "q", explanation: "", results: [] });
  getMarketSummaryImpl = async () => ({ listing_count: 0 });
  matchRequirementToInventoryImpl = async () => ({ items: [] });
});

test("a successful market search starts the trial clock exactly once", async () => {
  executeMarketSearchImpl = async () => ({
    query: "3 BHK Bandra",
    explanation: "",
    intent: "listing",
    results: [{ id: "l1", title: "3 BHK in Bandra West" }],
    suggestedFollowUps: [],
  });
  const out = await callTool("search", { query: "3 BHK Bandra" });
  assert.equal(isErrorResult(out), false);
  assert.deepEqual(recordCalls, ["t1"]);
});

test("a successful search with empty results still starts the clock", async () => {
  executeMarketSearchImpl = async () => ({ query: "q", explanation: "", results: [], suggestedFollowUps: [] });
  const out = await callTool("search", { query: "nothing matches this" });
  assert.equal(isErrorResult(out), false);
  assert.deepEqual(recordCalls, ["t1"]);
});

test("a failed search never starts the clock", async () => {
  executeMarketSearchImpl = async () => {
    throw new Error("search backend exploded");
  };
  const out = await callTool("search", { query: "3 BHK Bandra" });
  assert.equal(isErrorResult(out), true);
  assert.deepEqual(recordCalls, []);
});

test("a schema-rejected call never reaches the handler and never starts the clock", async () => {
  const out = await callTool("search", {}); // missing required query
  assert.equal(isErrorResult(out), true);
  assert.deepEqual(recordCalls, []);
});

test("an unknown tool never starts the clock", async () => {
  const out = await callTool("no_such_tool", {});
  assert.equal(isErrorResult(out), true);
  assert.deepEqual(recordCalls, []);
});

test("a non-search workspace write tool does not start the clock", async () => {
  const out = await callTool("set_follow_up", { listing_id: "x", note: "n", due_at: "2026-11-20T00:00:00Z" });
  assert.deepEqual(recordCalls, []);
  void out;
});

test("requirement_match searches inventory and starts the clock after success, including empty matches", async () => {
  matchRequirementToInventoryImpl = async () => ({ items: [] });
  const out = await callTool("requirement_match", { raw_text: "3 BHK in Bandra under 8 crore" });
  assert.equal(isErrorResult(out), false);
  assert.deepEqual(recordCalls, ["t1"]);
});

test("requirement_match does not start the clock when the match backend fails", async () => {
  matchRequirementToInventoryImpl = async () => {
    throw new Error("matcher down");
  };
  const out = await callTool("requirement_match", { raw_text: "3 BHK" });
  assert.equal(isErrorResult(out), true);
  assert.deepEqual(recordCalls, []);
});

test("intel_ask starts the clock only when a real market search ran", async () => {
  getMarketSummaryImpl = async () => ({ listing_count: 3, avg_price_cr: 4.2 });
  const withLocation = await callTool("intel_ask", { question: "What is happening in Bandra West?" });
  assert.equal(isErrorResult(withLocation), false);
  assert.deepEqual(recordCalls, ["t1"]);

  recordCalls.length = 0;
  const noLocation = await callTool("intel_ask", { question: "market?" });
  assert.equal(isErrorResult(noLocation), false);
  assert.deepEqual(recordCalls, []); // no locality extracted, no search ran
});

test("market_summary starts the clock after a successful aggregation", async () => {
  const out = await callTool("market_summary", { location: "Bandra West" });
  assert.equal(isErrorResult(out), false);
  assert.deepEqual(recordCalls, ["t1"]);
});
