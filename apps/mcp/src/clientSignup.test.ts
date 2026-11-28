import assert from "node:assert/strict";
import { mock, test } from "node:test";

const calls: { table: string; row: any }[] = [];
let signUpResult: any = { data: { user: { id: "new-user", identities: [{ id: "i" }] } }, error: null };

mock.module("./supabase.js", {
  namedExports: {
    supabase: { from: (table: string) => ({ upsert: async (row: any) => { calls.push({ table, row }); return { error: null }; } }) },
    supabaseAuth: { auth: { signUp: async () => signUpResult } },
  },
});

const { signupClient, normalizeClientPhone } = await import("./clientAccess.js");
const good = { email: "A@B.com", password: "longenough1", fullName: "Asha", phone: "+91 98200 56180" };

test("phone normalization", () => {
  assert.equal(normalizeClientPhone("+91 98200 56180"), "919820056180");
  assert.equal(normalizeClientPhone("123"), null);
});

test("new client gets a client row and a contact row keyed to the new auth user", async () => {
  calls.length = 0;
  const r = await signupClient(good);
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map((c) => c.table), ["client_accounts", "client_contacts"]);
  assert.equal(calls[1].row.auth_user_id, "new-user");
  assert.equal(calls[1].row.phone, "919820056180");
  assert.equal(calls[1].row.email, "a@b.com");
});

test("existing email (no identities) is left untouched: no rows written, same response", async () => {
  calls.length = 0;
  signUpResult = { data: { user: { id: "existing", identities: [] } }, error: null };
  const r = await signupClient(good);
  assert.equal(r.ok, true);
  assert.equal(calls.length, 0);
});

test("invalid input is rejected before any account is created", async () => {
  calls.length = 0;
  for (const bad of [{ ...good, email: "x" }, { ...good, phone: "1" }, { ...good, password: "short" }, { ...good, fullName: "" }]) {
    const r = await signupClient(bad);
    assert.equal(r.ok, false);
  }
  assert.equal(calls.length, 0);
});
