import assert from "node:assert/strict";
import { mock, test } from "node:test";

// Stateful in-memory supabase fake covering the save/recall paths:
// saveListingRecord, createRequirementRecord/upsertLeadRecord, getSavedRequirements.

type Row = Record<string, any>;

function createStore() {
  const tables: Record<string, Row[]> = {
    organizations: [{ id: "tenant-a", privacy_mode: "private", share_listings: false }],
    clients: [],
    client_requirements: [],
    raw_messages: [],
    residential_rent_listings: [],
    residential_sale_listings: [],
    commercial_rent_listings: [],
    commercial_sale_listings: [],
    mcp_save_requests: [],
  };
  const insertCounts: Record<string, number> = {};

  function applyFilters(rows: Row[], filters: Array<{ op: string; col: string; val: any }>) {
    return rows.filter((row) =>
      filters.every((f) => {
        if (f.op === "eq") return row[f.col] === f.val;
        if (f.op === "ilike") return String(row[f.col] ?? "").toLowerCase() === String(f.val).toLowerCase();
        if (f.op === "in") return (f.val as any[]).includes(row[f.col]);
        return true;
      }),
    );
  }

  function from(table: string) {
    const filters: Array<{ op: string; col: string; val: any }> = [];
    let mode: "select" | "insert" | "upsert" = "select";
    let insertRows: Row[] = [];
    let limitN: number | null = null;

    const builder: any = {
      select: () => builder,
      eq: (col: string, val: any) => {
        filters.push({ op: "eq", col, val });
        return builder;
      },
      ilike: (col: string, val: any) => {
        filters.push({ op: "ilike", col, val });
        return builder;
      },
      in: (col: string, val: any[]) => {
        filters.push({ op: "in", col, val });
        return builder;
      },
      gte: () => builder,
      order: () => builder,
      limit: (n: number) => {
        limitN = n;
        return builder;
      },
      insert: (payload: Row | Row[]) => {
        mode = "insert";
        insertRows = Array.isArray(payload) ? payload : [payload];
        return builder;
      },
      upsert: (payload: Row | Row[]) => {
        mode = "upsert";
        insertRows = Array.isArray(payload) ? payload : [payload];
        return builder;
      },
      maybeSingle: async () => {
        const rows = applyFilters(tables[table] || [], filters);
        return { data: rows[0] ?? null, error: null };
      },
      single: async () => {
        if (mode === "insert" || mode === "upsert") {
          const row = doInsert();
          return { data: row, error: null };
        }
        const rows = applyFilters(tables[table] || [], filters);
        return { data: rows[0] ?? null, error: null };
      },
      then: (resolve: any, reject: any) => {
        // Awaiting the builder directly resolves a select (or pending insert).
        try {
          if (mode === "insert" || mode === "upsert") {
            const row = doInsert();
            return resolve({ data: [row], error: null });
          }
          let rows = applyFilters(tables[table] || [], filters);
          if (limitN != null) rows = rows.slice(0, limitN);
          return resolve({ data: rows, error: null });
        } catch (err) {
          return reject(err);
        }
      },
    };

    function doInsert() {
      insertCounts[table] = (insertCounts[table] || 0) + 1;
      const payload = insertRows[0];
      const row = {
        id: (tables[table] || []).length + 1,
        created_at: "2026-11-26T03:00:00.000Z",
        ...payload,
      };
      tables[table] = tables[table] || [];
      tables[table].push(row);
      return row;
    }

    return builder;
  }

  function normalizePhoneSql(value: any) {
    const digits = String(value || "").replace(/[^0-9]/g, "");
    if (!digits) return null;
    if (digits.length === 10) return `+91${digits}`;
    if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
    const trimmed = String(value || "").trim();
    return trimmed || null;
  }

  // Mirrors public.mcp_save_requirement: the whole claim+save runs as one
  // atomic unit here, the way the SQL function runs in one transaction.
  async function rpc(name: string, args: any) {
    if (name !== "mcp_save_requirement") return { data: null, error: { message: `unknown rpc ${name}` } };
    const crypto = await import("node:crypto");
    const phone = normalizePhoneSql(args.p_phone);
    const fingerprint = crypto.createHash("md5")
      .update([args.p_name || "", phone || "", args.p_raw_text || ""].join("\x1f"))
      .digest("hex");
    const gate = (tables.mcp_save_requests || []).find(
      (row) => row.tenant_id === args.p_tenant_id && row.save_request_key === args.p_save_request_key,
    );
    if (gate) {
      if (gate.requirement_id == null) {
        return { data: null, error: { message: `requirement save for key "${args.p_save_request_key}" is in progress; retry the same request` } };
      }
      if (gate.request_fingerprint !== fingerprint) {
        return { data: null, error: { message: `idempotency key "${args.p_save_request_key}" was already used for a different requirement; use a new key for a new save` } };
      }
      return { data: { replayed: true, client_id: gate.client_id, requirement_id: gate.requirement_id }, error: null };
    }
    let clientId: number | null = null;
    if (phone) {
      const found = (tables.clients || []).filter((row) => row.tenant_id === args.p_tenant_id && row.phone === phone);
      clientId = found.length ? found[found.length - 1].id : null;
    }
    if (clientId == null) {
      const row = {
        id: (tables.clients || []).length + 1,
        tenant_id: args.p_tenant_id,
        name: String(args.p_name || "").trim() || null,
        phone,
        notes: args.p_raw_text,
        status: "active",
        created_at: "2026-11-26T03:00:00.000Z",
        updated_at: "2026-11-26T03:00:00.000Z",
      };
      tables.clients.push(row);
      clientId = row.id;
    }
    const requirement = {
      id: (tables.client_requirements || []).length + 1,
      tenant_id: args.p_tenant_id,
      client_id: clientId,
      intent: "requirement",
      bhk: args.p_bhk,
      price_max: args.p_budget,
      micro_market: args.p_location,
      notes: args.p_raw_text,
      created_at: "2026-11-26T03:00:00.000Z",
      updated_at: "2026-11-26T03:00:00.000Z",
    };
    tables.client_requirements.push(requirement);
    tables.mcp_save_requests.push({
      id: tables.mcp_save_requests.length + 1,
      tenant_id: args.p_tenant_id,
      save_request_key: args.p_save_request_key,
      record_type: "buyer_requirement",
      request_fingerprint: fingerprint,
      client_id: clientId,
      requirement_id: requirement.id,
      created_at: "2026-11-26T03:00:00.000Z",
      completed_at: "2026-11-26T03:00:00.000Z",
    });
    return { data: { replayed: false, client_id: clientId, requirement_id: requirement.id }, error: null };
  }

  return { supabase: { from, rpc }, tables, insertCounts };
}

function makeMock(store: ReturnType<typeof createStore>) {
  return {
    supabase: store.supabase,
    recordAssistantSearchSuccess: () => {},
  };
}

// node:test allows mocking a module specifier only once per file, so one
// shared store is mocked here and each test resets it.
const store = createStore();
mock.module("./supabase.js", { namedExports: makeMock(store) });

function resetStore() {
  store.tables.organizations = [{ id: "tenant-a", privacy_mode: "private", share_listings: false }];
  for (const key of Object.keys(store.tables)) {
    if (key !== "organizations") store.tables[key] = [];
  }
  for (const key of Object.keys(store.insertCounts)) delete store.insertCounts[key];
}

const baseInput = {
  brokerId: "tenant-a",
  name: "TEST Client",
  raw_text: "TEST requirement: 2 BHK rent in Bandra West",
  location_pref: "Bandra West",
};

test("createRequirementRecord creates then replays durably without duplicates", async () => {
  resetStore();
  const { createRequirementRecord } = await import("./data.ts");

  const first = await createRequirementRecord(baseInput as any);
  assert.equal(first.idempotent_replay, false);
  const firstLeadId = first.lead.lead_id;
  assert.equal(store.tables.clients.length, 1);
  assert.equal(store.tables.client_requirements.length, 1);

  // Exact retry - even long after the original save - returns the existing
  // record and creates nothing new.
  const replay = await createRequirementRecord(baseInput as any);
  assert.equal(replay.idempotent_replay, true);
  assert.equal(replay.lead.lead_id, firstLeadId);
  assert.equal(store.tables.clients.length, 1);
  assert.equal(store.tables.client_requirements.length, 1);
  assert.equal(store.insertCounts.client_requirements, 1);

  // A changed text is an intentional separate requirement and must be kept.
  // A name alone never merges people: without a phone, the same-named save
  // gets its own client row.
  const changed = await createRequirementRecord({
    ...baseInput,
    raw_text: "TEST requirement: 2 BHK rent in Bandra West, budget now 1.2L",
  } as any);
  assert.equal(changed.idempotent_replay, false);
  assert.equal(store.tables.client_requirements.length, 2);
  assert.equal(store.tables.clients.length, 2);
  assert.notEqual(changed.lead.client_id, first.lead.client_id);

  // The retry of THAT save still replays against its own record.
  const changedReplay = await createRequirementRecord({
    ...baseInput,
    raw_text: "TEST requirement: 2 BHK rent in Bandra West, budget now 1.2L",
  } as any);
  assert.equal(changedReplay.idempotent_replay, true);
  assert.equal(changedReplay.lead.lead_id, changed.lead.lead_id);
  assert.equal(store.tables.client_requirements.length, 2);
  assert.equal(store.tables.clients.length, 2);
});

test("saveListingRecord replay returns existing listing without mutation or new lead", async () => {
  resetStore();
  const { saveListingRecord } = await import("./data.ts");

  const input = {
    brokerId: "tenant-a",
    tenantId: "tenant-a",
    asset_type: "residential",
    transaction_type: "rent",
    raw_text: "TEST listing: 2 BHK Bandra West 85k",
    name: "TEST Broker",
  } as any;

  const first = await saveListingRecord(input);
  assert.equal(first.idempotent_replay, false);
  const listingId = first.listing_id;
  const leadsAfterFirst = store.tables.client_requirements.length;

  const replay = await saveListingRecord(input);
  assert.equal(replay.idempotent_replay, true);
  assert.equal(replay.listing_id, listingId);
  // No second insert into the typed table, no duplicate lead rows.
  assert.equal(store.insertCounts.residential_rent_listings, 1);
  assert.equal(store.tables.residential_rent_listings.length, 1);
  assert.equal(store.tables.client_requirements.length, leadsAfterFirst);
  assert.equal(replay.lead, null);
});

test("getSavedRequirements returns name and requirement details, never a phone", async () => {
  resetStore();
  store.tables.clients.push({ id: 9, tenant_id: "tenant-a", name: "Asha", phone: "9820012345" });
  store.tables.client_requirements.push({
    id: 21,
    tenant_id: "tenant-a",
    client_id: 9,
    notes: "needs 2 BHK in Bandra",
    micro_market: "Bandra West",
    bhk: "2",
    created_at: "2026-11-26T02:00:00Z",
    clients: { name: "Asha" },
  });
  const { getSavedRequirements } = await import("./data.ts");

  const rows = await getSavedRequirements({ brokerId: "tenant-a", limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Asha");
  assert.equal(rows[0].location_hint, "Bandra West");
  assert.equal(rows[0].raw_text, "needs 2 BHK in Bandra");
  assert.ok(!("phone" in rows[0]));
  assert.ok(JSON.stringify(rows[0]).indexOf("9820012345") === -1);

  // Other tenants see nothing.
  const other = await getSavedRequirements({ brokerId: "tenant-b", limit: 10 });
  assert.equal(other.length, 0);
});

test("saved_requirements tool is registered and returns saved rows for the broker", async () => {
  resetStore();
  store.tables.client_requirements.push({
    id: 31,
    tenant_id: "tenant-a",
    client_id: null,
    notes: "3 BHK in Juhu",
    created_at: "2026-11-26T02:30:00Z",
    clients: null,
  });
  const { registerRequirementTools } = await import("./tools/requirement.ts");

  const registered: Record<string, (input: any) => Promise<any>> = {};
  const fakeServer = {
    registerTool: (name: string, _meta: any, handler: any) => {
      registered[name] = handler;
    },
  };
  registerRequirementTools(fakeServer as any, { user: { broker_id: "tenant-a", tenant_id: "tenant-a" } } as any);

  assert.ok(registered.saved_requirements, "saved_requirements tool must be registered");
  const res = await registered.saved_requirements({ limit: 5 });
  assert.equal(res.structuredContent.requirements.length, 1);
  assert.equal(res.structuredContent.requirements[0].raw_text, "3 BHK in Juhu");

  // Unauthenticated calls are rejected.
  const fakeServer2 = { registerTool: (name: string, _m: any, h: any) => { registered[name] = h; } };
  registerRequirementTools(fakeServer2 as any, { user: null } as any);
  await assert.rejects(() => registered.saved_requirements({ limit: 5 }), /broker id/i);
});

test("keyed save replays exactly-once and never writes twice", async () => {
  resetStore();
  const { createRequirementRecord } = await import("./data.ts");
  const keyed = { ...baseInput, saveRequestKey: "chat-msg-1" } as any;

  const first = await createRequirementRecord(keyed);
  assert.equal(first.idempotent_replay, false);
  assert.equal(store.tables.clients.length, 1);
  assert.equal(store.tables.client_requirements.length, 1);

  // Same key, same content, any time later: replay, zero new rows.
  const replay = await createRequirementRecord(keyed);
  assert.equal(replay.idempotent_replay, true);
  assert.equal(replay.lead.lead_id, first.lead.lead_id);
  assert.equal(replay.lead.client_id, first.lead.client_id);
  assert.equal(store.tables.clients.length, 1);
  assert.equal(store.tables.client_requirements.length, 1);
  assert.equal(store.tables.mcp_save_requests.length, 1);
});

test("same key with different requirement content is rejected, never collapsed", async () => {
  resetStore();
  const { createRequirementRecord } = await import("./data.ts");
  await createRequirementRecord({ ...baseInput, saveRequestKey: "k-1" } as any);

  await assert.rejects(
    () => createRequirementRecord({ ...baseInput, raw_text: "TEST: completely different 3 BHK ask", saveRequestKey: "k-1" } as any),
    /already used for a different requirement/,
  );
  // Nothing written by the rejected attempt.
  assert.equal(store.tables.client_requirements.length, 1);
});

test("distinct keys with identical name and text are deliberately separate saves", async () => {
  resetStore();
  const { createRequirementRecord } = await import("./data.ts");

  const first = await createRequirementRecord({ ...baseInput, saveRequestKey: "msg-1" } as any);
  const second = await createRequirementRecord({ ...baseInput, saveRequestKey: "msg-2" } as any);

  assert.equal(first.idempotent_replay, false);
  assert.equal(second.idempotent_replay, false);
  // A new key is never collapsed by content or name: two clients, two requirements.
  assert.equal(store.tables.clients.length, 2);
  assert.notEqual(first.lead.client_id, second.lead.client_id);
  assert.equal(store.tables.client_requirements.length, 2);
  assert.notEqual(first.lead.lead_id, second.lead.lead_id);
});

test("distinct keys with the same phone share the client but not the requirement", async () => {
  resetStore();
  const { createRequirementRecord } = await import("./data.ts");

  const first = await createRequirementRecord({ ...baseInput, phone: "9820012345", saveRequestKey: "msg-1" } as any);
  const second = await createRequirementRecord({ ...baseInput, phone: "9820012345", saveRequestKey: "msg-2" } as any);

  // Phone is identity: one client. A new key is a new request: two requirements.
  assert.equal(store.tables.clients.length, 1);
  assert.equal(first.lead.client_id, second.lead.client_id);
  assert.equal(store.tables.client_requirements.length, 2);
  assert.notEqual(first.lead.lead_id, second.lead.lead_id);
  assert.equal(second.idempotent_replay, false);
});

test("concurrent same-key saves produce exactly one client and one requirement", async () => {
  resetStore();
  const { createRequirementRecord } = await import("./data.ts");
  const keyed = { ...baseInput, saveRequestKey: "race-key" } as any;

  const results = await Promise.all([
    createRequirementRecord(keyed),
    createRequirementRecord(keyed),
    createRequirementRecord(keyed),
    createRequirementRecord(keyed),
  ]);
  const leadIds = new Set(results.map((r) => r.lead.lead_id));
  assert.equal(leadIds.size, 1);
  assert.equal(results.filter((r) => !r.idempotent_replay).length, 1);
  assert.equal(store.tables.clients.length, 1);
  assert.equal(store.tables.client_requirements.length, 1);
  assert.equal(store.tables.mcp_save_requests.length, 1);
});
