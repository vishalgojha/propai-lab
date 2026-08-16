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

// Dynamic route params are URL slugs. They must resolve to the same canonical
// locality as their human-readable labels or every /localities/[slug] page
// falls through to notFound().
for (const [label, slug] of [
  ["Bandra West", "bandra-west"],
  ["Bandra Kurla Complex", "bandra-kurla-complex"],
  ["Andheri East", "andheri-east"],
  ["Vile Parle West", "vile-parle-west"],
] as const) {
  check(slug, {
    label,
    slug,
    public: true,
    standalonePage: true,
  });
}

console.log("locality canonicalization tests passed");
