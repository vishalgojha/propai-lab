import assert from "node:assert/strict";
import test from "node:test";
import { extractIntelLocality } from "./tools/intelligence.ts";

test("intel parser extracts locality before question punctuation", () => {
  assert.equal(extractIntelLocality("What's happening in Bandra West?"), "Bandra West");
});

test("intel parser stops locality before conversational qualifiers", () => {
  assert.equal(extractIntelLocality("What is happening in Bandra West right now?"), "Bandra West");
});
