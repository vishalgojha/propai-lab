import assert from "node:assert/strict";
import test from "node:test";
import { HIDDEN, redactMcpResult, redactText, redactValue } from "./contactPrivacy.ts";

test("phone numbers are hidden in every common text form, prices and ids are kept", () => {
  const phones = [
    "9820056180", "+91 98200 56180", "98200-56180", "098200 56180", "919820056180", "+91-9820056180", "982 005 6180",
    "919820056180@s.whatsapp.net", "https://wa.me/919820056180?text=hi", "wa.me/9820056180", "tel:+919820056180", "+1 415 555 2671", "+44 20 7946 0958",
  ];
  for (const p of phones) {
    const out = redactText(`call me on ${p} for the flat`);
    assert.ok(!/\d{4}[\s.-]?\d{4}|wa\.me\/\d/.test(out.replace(HIDDEN, "")), `leaked: ${p} -> ${out}`);
    assert.ok(out.includes(HIDDEN), `not redacted: ${p}`);
  }
  for (const keep of ["2 BHK 1,250 sqft at 5.5 Cr", "price 5,00,00,000", "source 12345:0", "ID 482913", "rent 85000 per month", "Rs 3.25 crore negotiable", "1200 sq ft"]) {
    assert.equal(redactText(keep), keep, `over-redacted: ${keep}`);
  }
});

test("structured phone fields, nested payloads and MCP results are redacted", () => {
  const out: any = redactMcpResult({
    content: [{ type: "text", text: "Broker 9820056180 here" }],
    structuredContent: { primary_contact_number: "9820056180", primary_contact_wa: "https://wa.me/919820056180", broker_phone: "98200 56180", sender_phone: null, nested: [{ raw_payload: { full_text: "ring +91 98200 56180", contact_name: "Ravi" } }], source_message_id: "12:0" },
  });
  const s = JSON.stringify(out);
  assert.ok(!/9820056180|98200 56180|98200/.test(s), s);
  assert.equal(out.structuredContent.sender_phone, null);
  assert.equal(out.structuredContent.nested[0].raw_payload.contact_name, "Ravi");
  assert.equal(out.structuredContent.source_message_id, "12:0");
});
