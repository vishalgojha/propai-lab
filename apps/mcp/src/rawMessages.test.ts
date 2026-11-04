import assert from "node:assert/strict";
import test from "node:test";
import { formatRawMessageEvidence } from "./tools/rawMessages.ts";

test("raw WhatsApp evidence text includes message, author, chat, time, and source id", () => {
  const text = formatRawMessageEvidence([{
    id: 4812,
    group_name: "Bandra West Rentals",
    chat_jid: "120363000000@g.us",
    sender: "Amit",
    message: "3 BHK for rent near Bandra West, 3.8 lakh monthly",
    timestamp: "2026-11-04T10:00:00.000Z",
    is_group: true,
    match_type: "semantic_and_keyword",
    similarity: 0.81234,
  }]);

  assert.match(text, /Amit/);
  assert.match(text, /Bandra West Rentals/);
  assert.match(text, /2026-11-04T10:00:00.000Z/);
  assert.match(text, /raw message 4812/);
  assert.match(text, /3 BHK for rent near Bandra West, 3\.8 lakh monthly/);
  assert.match(text, /similarity 0\.812/);
});

test("raw WhatsApp context marks its anchor and bounds the displayed result count", () => {
  const items = Array.from({ length: 27 }, (_, index) => ({
    id: index + 1,
    sender: "Sender",
    message: `message ${index + 1}`,
    timestamp: "2026-11-04T10:00:00.000Z",
    is_group: false,
    chat_jid: "919800000001@s.whatsapp.net",
    is_anchor: index === 0,
  }));
  const text = formatRawMessageEvidence(items);

  assert.match(text, /CONTEXT ANCHOR/);
  assert.match(text, /message 25/);
  assert.doesNotMatch(text, /message 26/);
  assert.match(text, /2 more result\(s\) omitted/);
});
