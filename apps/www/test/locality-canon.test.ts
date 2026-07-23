import assert from "node:assert/strict";
import { canonicalLocality } from "../src/lib/locality-canon";

function check(input: string, expected: ReturnType<typeof canonicalLocality>) {
  assert.deepEqual(canonicalLocality(input), expected, input);
}

check("Pali Hill", {
  label: "Bandra West",
  slug: "bandra-west",
  public: true,
  standalonePage: true,
});

check("Mount Mary", {
  label: "Bandra West",
  slug: "bandra-west",
  public: true,
  standalonePage: true,
});

check("Lokhandwala", {
  label: "Andheri West",
  slug: "andheri-west",
  public: true,
  standalonePage: true,
});

check("Bandra West to Versova Corridor", {
  label: "",
  slug: "",
  public: false,
  standalonePage: false,
});

check("Andheri East", {
  label: "Andheri East",
  slug: "andheri-east",
  public: true,
  standalonePage: true,
});

console.log("locality canonicalization tests passed");
