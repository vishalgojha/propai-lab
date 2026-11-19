import assert from "node:assert/strict";
import test from "node:test";
import {
  MarketReferenceError,
  MarketValidationError,
  canonicalJson,
  contactChoices,
  parsePropertySearch,
  redactContacts,
  searchBounds,
  searchFingerprint,
  searchTerms,
  seal,
  sourceHash,
  unseal,
} from "./brokerMarketPolicy.ts";

/**
 * Parity fixtures generated with the reviewed Python reference
 * (broker_market_policy.py, consent version broker-property-cross-search-v1):
 * seal() uses canonical sorted compact JSON + base64url-no-padding + HMAC-SHA256 hex.
 */
const PY_SECRET = "broker-market-v1:test-fixture-secret";
const PY_OPTION_PAYLOAD = {
  exp: 4102444800, // 2100-01-01: fixture never expires
  hash: "ab".repeat(32),
  id: 123456,
  kind: "option",
  reader: "mcp:tenant-abc:user-123",
};
const PY_TOKEN =
  "eyJleHAiOjQxMDI0NDQ4MDAsImhhc2giOiJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiIiwiaWQiOjEyMzQ1Niwia2luZCI6Im9wdGlvbiIsInJlYWRlciI6Im1jcDp0ZW5hbnQtYWJjOnVzZXItMTIzIn0.f5cdf14b0f542fec1e2b91459d3358b45c123f311bedfcfc042df2421cb0a9c6";
const PY_FP_BUILDING_ONLY = "dea93ed59d0e94ff2807a169d9d56fdb607daf57cfdb43d0a30dd9a9fc321500";
const PY_FP_MIXED = "8de188d33719093cc5cee88090b8059cf25440520a983261cb4f90f034c263a8";
// Non-ASCII fixtures (Python json.dumps escapes every non-ASCII char as \uXXXX,
// including surrogate pairs for astral characters):
const PY_UNICODE_READER = "mcp:tenant-\u00fcser:w\u00ebst-\u2019s \u{1F3E0}";
const PY_TOKEN_UNICODE =
  "eyJleHAiOjQxMDI0NDQ4MDAsImhhc2giOiJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiYWJhYmFiIiwiaWQiOjc3Nywia2luZCI6Im9wdGlvbiIsInJlYWRlciI6Im1jcDp0ZW5hbnQtXHUwMGZjc2VyOndcdTAwZWJzdC1cdTIwMTlzIFx1ZDgzY1x1ZGZlMCJ9.30d0aa9c8d03b3468cc7ae6c9424c7019b7d80906048ef768219a15b5ef75bfc";
const PY_FP_UNICODE_BUILDING = "1c789a5fb098266713d8819015651e6211f27437c964fb9b998a6e441229686b";

test("seal()/unseal() match Python byte-for-byte with non-ASCII payloads", () => {
  const payload = { exp: 4102444800, hash: "ab".repeat(32), id: 777, kind: "option", reader: PY_UNICODE_READER };
  assert.equal(seal(payload, PY_SECRET), PY_TOKEN_UNICODE);
  const value = unseal(PY_TOKEN_UNICODE, PY_SECRET, { kind: "option", reader: PY_UNICODE_READER });
  assert.equal(value.id, 777);
});

test("fingerprint escapes non-ASCII exactly like Python json.dumps", () => {
  const b = parsePropertySearch({ building: "Versova S\u00e9a F\u00e2ce CHS" });
  assert.equal(searchFingerprint(b), PY_FP_UNICODE_BUILDING);
  assert.deepEqual(searchTerms(b), [["versova s\u00e9a f\u00e2ce chs"]]);
});

test("name validator matches Python \\w semantics on unicode input", () => {
  // Precomposed and NFKC-composed forms both accepted and stored composed:
  assert.equal(parsePropertySearch({ building: "Caf\u00e9 Noir" }).building, "Caf\u00e9 Noir");
  assert.equal(parsePropertySearch({ building: "Cafe\u0301 Noir" }).building, "Caf\u00e9 Noir");
  assert.equal(parsePropertySearch({ building: "Na\u00efve Point" }).building, "Na\u00efve Point");
  assert.equal(parsePropertySearch({ building: "Jos\u00e9" }).building, "Jos\u00e9");
  // Combining marks that survive NFKC (Devanagari vowel signs, enclosing marks)
  // are rejected by both validators; curly quotes are not in the allowed class:
  assert.throws(() => parsePropertySearch({ building: "Wing \u0935\u0930\u094d\u0938\u094b\u0935\u093e" }), MarketValidationError);
  assert.throws(() => parsePropertySearch({ building: "Bad \u20dd mark" }), MarketValidationError);
  assert.throws(() => parsePropertySearch({ building: "O\u2019Brien Towers" }), MarketValidationError);
});

test("redactContacts keeps non-ASCII wording while masking contacts", () => {
  const out = redactContacts("Caf\u00e9 \u201cSea\u201d call 98111 22233 \u{1F600}");
  assert.equal(out, "Caf\u00e9 \u201cSea\u201d call [number hidden] \u{1F600}");
});

test("seal() is byte-identical to the Python reference for the same payload and secret", () => {
  assert.equal(seal(PY_OPTION_PAYLOAD, PY_SECRET), PY_TOKEN);
});

test("unseal() accepts a Python-sealed reference (same kind and reader)", () => {
  const value = unseal(PY_TOKEN, PY_SECRET, { kind: "option", reader: "mcp:tenant-abc:user-123" });
  assert.equal(value.id, 123456);
  assert.equal(value.hash, "ab".repeat(32));
});

test("unseal() fails closed: wrong kind, wrong reader, tampered body, bad signature, expired, empty secret", () => {
  assert.throws(() => unseal(PY_TOKEN, PY_SECRET, { kind: "cursor", reader: "mcp:tenant-abc:user-123" }), MarketReferenceError);
  assert.throws(() => unseal(PY_TOKEN, PY_SECRET, { kind: "option", reader: "mcp:tenant-abc:other" }), MarketReferenceError);
  assert.throws(() => unseal(PY_TOKEN.replace("MTIz", "MTI0"), PY_SECRET, { kind: "option", reader: "mcp:tenant-abc:user-123" }), MarketReferenceError);
  const [body] = PY_TOKEN.split(".");
  assert.throws(() => unseal(`${body}.${"0".repeat(64)}`, PY_SECRET, { kind: "option", reader: "mcp:tenant-abc:user-123" }), MarketReferenceError);
  assert.throws(() => unseal(body, PY_SECRET, { kind: "option", reader: "mcp:tenant-abc:user-123" }), MarketReferenceError);
  assert.throws(() => unseal("a.b.c", PY_SECRET, { kind: "option", reader: "mcp:tenant-abc:user-123" }), MarketReferenceError);
  const expired = seal({ kind: "option", reader: "r", exp: 1000000000 }, PY_SECRET);
  assert.throws(() => unseal(expired, PY_SECRET, { kind: "option", reader: "r" }), MarketReferenceError);
  assert.throws(() => unseal(PY_TOKEN, "", { kind: "option", reader: "mcp:tenant-abc:user-123" }), /not configured/);
});

test("fingerprint and terms match the Python reference exactly", () => {
  const b = parsePropertySearch({ building: "Lodha World One" });
  assert.equal(searchFingerprint(b), PY_FP_BUILDING_ONLY);
  assert.deepEqual(searchTerms(b), [["lodha world one"]]);
  const m = parsePropertySearch({ locality: "Bandra", property_type: "office", transaction: "lease", bedrooms: 3, days: 45, limit: 7 });
  assert.equal(searchFingerprint(m), PY_FP_MIXED);
  assert.deepEqual(searchTerms(m), [["bandra"], ["office"], ["lease"], ["3bhk", "3 bhk", "3 bedroom", "3 bed"]]);
});

test("criteria validation: property-only, no browsing, no contacts or query operators in names", () => {
  assert.throws(() => parsePropertySearch({}), MarketValidationError);
  assert.throws(() => parsePropertySearch({ building: "x" }), MarketValidationError); // < 2 chars after trim
  assert.throws(() => parsePropertySearch({ building: "Call 98111 22233" }), MarketValidationError);
  assert.throws(() => parsePropertySearch({ building: "a%b" }), MarketValidationError);
  assert.throws(() => parsePropertySearch({ locality: "bandra_w" }), MarketValidationError);
  assert.throws(() => parsePropertySearch({ building: "some:thing" }), MarketValidationError);
  assert.throws(() => parsePropertySearch({ property_type: "office" }), MarketValidationError); // only one criterion
  assert.throws(() => parsePropertySearch({ building: "ok", extra_field: 1 }), MarketValidationError); // forbid extra
  assert.throws(() => parsePropertySearch({ bedrooms: 0, transaction: "rent" }), /too_small|Invalid/);
  assert.throws(() => parsePropertySearch({ days: 120, building: "Sea View" }), /too_big|Invalid/);
  // building-only / locality-only / two-criteria are accepted
  assert.ok(parsePropertySearch({ building: "Sea View CHS" }).building === "Sea View CHS");
  assert.ok(parsePropertySearch({ locality: "Khar West" }).locality === "Khar West");
  assert.ok(parsePropertySearch({ transaction: "rent", bedrooms: 2 }));
  // normalization: NFKC + trim, case preserved
  assert.equal(parsePropertySearch({ building: "  Oberoi Splendor  " }).building, "Oberoi Splendor");
});

test("redactContacts masks numbers, emails and links, keeps property wording", () => {
  const out = redactContacts("2BHK Bandra West 85k call 98111 22233 or +91 98200-11122, mail a@b.co, wa.me/919811122233 http://x.co/y");
  assert.ok(!/98111|98200|a@b\.co|wa\.me\/9|http:\/\/x/.test(out), out);
  assert.ok(out.includes("2BHK Bandra West 85k"));
  assert.ok(out.includes("[number hidden]") && out.includes("[contact hidden]") && out.includes("[link hidden]"));
});

test("sourceHash uses body and both sender identity fields; never returns them", () => {
  const a = sourceHash({ body: "2bhk", sender_phone: "9198", sender_jid: "j" });
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, sourceHash({ body: "2bhk", sender_phone: "9199", sender_jid: "j" }), "changed contact identity changes the hash");
  assert.notEqual(a, sourceHash({ body: "2bhk!", sender_phone: "9198", sender_jid: "j" }));
  assert.equal(a, sourceHash({ body: "2bhk", sender_phone: "9198", sender_jid: "j" }));
  assert.equal(sourceHash({ body: "x" }), sourceHash({ body: "x", sender_phone: null, sender_jid: null }));
});

test("searchBounds: cursor pins window and rejects a changed query", () => {
  const body = parsePropertySearch({ building: "Sea View", days: 10 });
  const free = searchBounds(body, null);
  assert.ok(Date.parse(free.until) - Date.parse(free.since) === 10 * 86400 * 1000);
  const cursor = { kind: "cursor", reader: "r", query: searchFingerprint(body), since: "2026-01-01T00:00:00Z", until: "2026-01-31T00:00:00Z", last_id: 5, last_at: "2026-01-30T00:00:00Z", exp: 4102444800 };
  const bound = searchBounds(body, cursor);
  assert.deepEqual(bound, { since: cursor.since, until: cursor.until, lastId: 5, lastAt: cursor.last_at });
  const other = parsePropertySearch({ building: "Other Building" });
  assert.throws(() => searchBounds(other, cursor), MarketValidationError);
});

test("contactChoices: labelled candidates, dedupe, and message-poster fallback", () => {
  const two = contactChoices({ body: "Two flats: A call 98111 00001, B call 98111 00001 and C 98200 00003. 2BHK Andheri", sender_phone: null });
  assert.equal(two.length, 2);
  assert.equal(two[0].digits, "9811100001");
  assert.equal(two[1].digits, "9820000003");
  assert.ok(two.every((c) => !/\d{7,}/.test(c.label)), "labels carry no digits");
  assert.ok(two[0].label.includes("(this contact)"));
  const fallback = contactChoices({ body: "3bhk juhu sale no numbers here", sender_phone: "919820011122" });
  assert.deepEqual(fallback, [{ digits: "9820011122", label: "Message poster, not necessarily the property's broker or owner" }]);
  assert.deepEqual(contactChoices({ body: "no numbers", sender_phone: "bad" }), []);
});

test("canonicalJson matches Python json.dumps(sort_keys, compact)", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: null, c: [2, "x"] } }), '{"a":{"c":[2,"x"],"d":null},"b":1}');
});
