// Verifies the page-header connection-health rule matches the per-phone card
// truth: a failed live probe must not flip the header to "status unavailable"
// while phone records still confirm a linked session.
// Usage: node header-health-verify.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = mkdtempSync(join(tmpdir(), "ch-test-"));
execFileSync("npx", ["tsc", "src/lib/connectionHealth.ts", "--outDir", out, "--module", "commonjs", "--target", "es2020"], { stdio: "inherit" });

writeFileSync(join(out, "run.cjs"), `
const { connectionHealth } = require(${JSON.stringify(join(out, "connectionHealth.js"))});
const base = { phonesLoading: false, liveStatusChecked: true, phonesError: null, liveStatusError: false, connectedCount: 1 };
const cases = [
  ["loading -> checking", { ...base, phonesLoading: true }, "checking"],
  ["probe unchecked -> checking", { ...base, liveStatusChecked: false }, "checking"],
  ["connected, probe ok -> healthy", base, "healthy"],
  ["connected, live probe FAILED -> healthy", { ...base, liveStatusError: true }, "healthy"],
  ["connected, phones fetch failed -> healthy", { ...base, phonesError: "x" }, "healthy"],
  ["none connected, probe failed -> warning", { ...base, connectedCount: 0, liveStatusError: true }, "warning"],
  ["none connected, phones failed -> warning", { ...base, connectedCount: 0, phonesError: "x" }, "warning"],
  ["none connected, all ok -> error", { ...base, connectedCount: 0 }, "error"],
];
let fail = 0;
for (const [name, input, want] of cases) {
  const got = connectionHealth(input).status;
  const ok = got === want;
  if (!ok) fail++;
  console.log((ok ? "PASS" : "FAIL") + " " + name + " -> " + got);
}
process.exit(fail ? 1 : 0);
`);

execFileSync("node", [join(out, "run.cjs")], { stdio: "inherit" });
console.log("header-health-verify: all cases passed");
