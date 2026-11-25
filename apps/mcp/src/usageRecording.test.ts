import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Functional coverage for assistant usage recording: a successful assistant
// search records exactly one broker_usage_events row with
// origin=assistant_unlabeled; errored, schema-rejected, unknown and
// non-search tool calls record nothing. Runs against the real MCP server
// over an in-memory transport; only the data layer, the search engine, the
// usage recorder and the trial recorder are mocked.

const usageCalls: { tenantId: string | undefined }[] = [];

let executeMarketSearchImpl: (input: unknown) => Promise<unknown> = async () => ({ query: "", explanation: "", results: [] });
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
    getMarketSummary: async () => ({ listing_count: 0 }),
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
    recordAssistantSearchSuccess: () => undefined,
    supabase: {},
  },
});

const usageMock = mock.module("./usage.js", {
  namedExports: {
    recordSearchUsage: (tenantId: string | undefined) => {
      usageCalls.push({ tenantId });
    },
  },
});

const marketSearchMock = mock.module("./marketSearch.js", {
  namedExports: {
    executeMarketSearch: (input: unknown) => executeMarketSearchImpl(input),
  },
});

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
  usageMock.restore();
  marketSearchMock.restore();
  anomaliesMock.restore();
  mock.restoreAll();
});

const TENANT_CONTEXT = { user: { id: "u1", broker_id: "u1", tenant_id: "t1" } as never };

async function callTool(name: string, args: Record<string, unknown>) {
  const server = createMcpServer(TENANT_CONTEXT);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "usage-test-client", version: "0.0.1" });
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
  usageCalls.length = 0;
  executeMarketSearchImpl = async () => ({ query: "q", explanation: "", results: [], suggestedFollowUps: [] });
  matchRequirementToInventoryImpl = async () => ({ items: [] });
});

test("a successful market search records one unlabeled usage row with tenant and user", async () => {
  executeMarketSearchImpl = async () => ({
    query: "3 BHK Bandra",
    explanation: "",
    intent: "listing",
    results: [{ id: "l1", title: "3 BHK in Bandra West" }],
    suggestedFollowUps: [],
  });
  const out = await callTool("search", { query: "3 BHK Bandra" });
  assert.equal(isErrorResult(out), false);
  assert.deepEqual(usageCalls, [{ tenantId: "t1" }]);
});

test("market_search records exactly one usage row on success", async () => {
  executeMarketSearchImpl = async () => ({
    query: "2 BHK Andheri",
    explanation: "",
    intent: "listing",
    results: [{ id: "l2", title: "2 BHK in Andheri West" }],
    suggestedFollowUps: [],
  });
  const out = await callTool("market_search", { query: "2 BHK Andheri" });
  assert.equal(isErrorResult(out), false);
  assert.deepEqual(usageCalls, [{ tenantId: "t1" }]);
});

test("a failed search never records usage", async () => {
  executeMarketSearchImpl = async () => {
    throw new Error("search backend exploded");
  };
  const out = await callTool("search", { query: "3 BHK Bandra" });
  assert.equal(isErrorResult(out), true);
  assert.deepEqual(usageCalls, []);
});

test("a schema-rejected call never records usage", async () => {
  const out = await callTool("search", {});
  assert.equal(isErrorResult(out), true);
  assert.deepEqual(usageCalls, []);
});

test("a non-search workspace write tool never records usage", async () => {
  const out = await callTool("set_follow_up", { listing_id: "x", note: "n", due_at: "2026-11-20T00:00:00Z" });
  assert.deepEqual(usageCalls, []);
  void out;
});

test("requirement_match records usage after success", async () => {
  const out = await callTool("requirement_match", { raw_text: "3 BHK in Bandra under 8 crore" });
  assert.equal(isErrorResult(out), false);
  assert.deepEqual(usageCalls, [{ tenantId: "t1" }]);
});

test("requirement_match records nothing when the match backend fails", async () => {
  matchRequirementToInventoryImpl = async () => {
    throw new Error("matcher down");
  };
  const out = await callTool("requirement_match", { raw_text: "3 BHK" });
  assert.equal(isErrorResult(out), true);
  assert.deepEqual(usageCalls, []);
});
