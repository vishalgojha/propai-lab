import assert from "node:assert/strict";
import test, { mock } from "node:test";

// Unit coverage for recordSearchUsage itself: the inserted row carries only
// workspace/surface/action/origin - never query text, filters, message
// content or results - the origin is always assistant_unlabeled, a missing
// tenant is a no-op, and insert failures are swallowed.

const inserts: { table: string; row: Record<string, unknown> }[] = [];
let insertBehavior: "ok" | "error" | "reject" = "ok";

const supabaseMock = mock.module("./supabase.js", {
  namedExports: {
    supabase: {
      from(table: string) {
        return {
          insert(row: Record<string, unknown>) {
            inserts.push({ table, row });
            if (insertBehavior === "error") return Promise.resolve({ error: { message: "insert failed" } });
            if (insertBehavior === "reject") return Promise.reject(new Error("connection down"));
            return Promise.resolve({ error: null });
          },
        };
      },
    },
  },
});

const { recordSearchUsage } = await import("./usage.ts");

test.after(() => {
  supabaseMock.restore();
  mock.restoreAll();
});

test.beforeEach(() => {
  inserts.length = 0;
  insertBehavior = "ok";
});

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("inserts exactly one allowed-fields row into broker_usage_events", async () => {
  recordSearchUsage("t1");
  await flush();
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].table, "broker_usage_events");
  assert.deepEqual(inserts[0].row, {
    tenant_id: "t1",
    surface: "assistant",
    action: "search",
    origin: "assistant_unlabeled",
  });
  // No parameter and no row field can carry query text, filters, message
  // content or results.
  assert.equal(recordSearchUsage.length, 1); // workspace only
  for (const key of Object.keys(inserts[0].row)) {
    assert.doesNotMatch(key, /query|text|message|filter|result/i);
  }
});

test("no optional identity is collected and missing tenant is a no-op", async () => {
  recordSearchUsage("t1");
  recordSearchUsage(undefined);
  recordSearchUsage("");
  await flush();
  assert.equal(inserts.length, 1);
  assert.ok(!("user_id" in inserts[0].row) && !("api_key_id" in inserts[0].row));
});

test("an insert error is logged and swallowed", async () => {
  insertBehavior = "error";
  recordSearchUsage("t1");
  await flush();
});

test("a rejected insert is logged and swallowed", async () => {
  insertBehavior = "reject";
  recordSearchUsage("t1");
  await flush();
});
