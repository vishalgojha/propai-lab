import assert from "node:assert/strict";
import { resolveBrokerPhone, buildWaLink, brokerStatusKey, parseStore } from "./brokerOutreach.ts";
assert.equal(resolveBrokerPhone("+919876543210", false).kind, "international");
assert.equal(resolveBrokerPhone("919876543210", false).kind, "international");
assert.equal(resolveBrokerPhone("9876543210", false).kind, "ambiguous");
assert.deepEqual(resolveBrokerPhone("9876543210", true), { kind: "assumed_india", e164digits: "919876543210" });
assert.equal(resolveBrokerPhone("1234567890", true).kind, "ambiguous");
assert.equal(resolveBrokerPhone("", true).kind, "none");
assert.equal(resolveBrokerPhone("98765", true).kind, "ambiguous");
assert.equal(resolveBrokerPhone("+44 7700 900123", false).kind, "international");
assert.equal(buildWaLink("919876543210", "Hi & bye"), "https://wa.me/919876543210?text=Hi%20%26%20bye");
assert.notEqual(brokerStatusKey("+91 98765 43210"), brokerStatusKey("9876543210"));
assert.equal(brokerStatusKey("+91 98765 43210"), brokerStatusKey("919876543210"));
assert.equal(brokerStatusKey("9876543210"), "bare:9876543210");
assert.equal(brokerStatusKey(""), "");
assert.equal(resolveBrokerPhone("+911234567890", false).kind, "ambiguous");
assert.equal(resolveBrokerPhone("+91987654321", false).kind, "ambiguous");
assert.equal(resolveBrokerPhone("+0123456789012", false).kind, "ambiguous");
assert.equal(resolveBrokerPhone("+97150123456789", false).kind, "international");
assert.equal(resolveBrokerPhone("447700900123", false).kind, "ambiguous");
assert.equal(parseStore("garbage", "T").template, "T");
assert.equal(parseStore(JSON.stringify({statuses:{a:{status:"bad",at:"x"},b:{status:"sent",at:"2026-11-28"}}}), "T").statuses.a, undefined);
assert.equal(parseStore(null, "T").assumeIndia, true);
assert.equal(parseStore(JSON.stringify({assumeIndia:false}), "T").assumeIndia, false);
assert.equal(parseStore("{}", "T").assumeIndia, true);
console.log("ok");

// Previous unedited default moves to the new default; an edited template is kept.
{
  const prev = ["old default"];
  assert.equal(parseStore(JSON.stringify({ template: "old default" }), "new default", prev).template, "new default");
  assert.equal(parseStore(JSON.stringify({ template: "my edit" }), "new default", prev).template, "my edit");
  assert.equal(parseStore(null, "new default", prev).template, "new default");
}
console.log("brokerOutreach template migration tests passed");
