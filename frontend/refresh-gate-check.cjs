// Behavioral check for src/lib/inFlight.ts (the Connections-page poll gate).
// Run from the frontend root: node refresh-gate-check.cjs
const fs = require('fs'), assert = require('assert/strict'), ts = require('typescript');
const source = fs.readFileSync('src/lib/inFlight.ts', 'utf8');
fs.writeFileSync('.refresh-gate-check.cjs', ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText);
const { createInFlightGate, nextPollDelay } = require('./.refresh-gate-check.cjs');

(async () => {
  // 1. Overlap is impossible: a trigger during a slow run is dropped.
  const gate = createInFlightGate();
  let runs = 0, release;
  const slow = gate(() => { runs++; return new Promise((r) => { release = r; }); });
  const dropped = gate(async () => { runs++; return 'second'; });
  assert.equal(await dropped, undefined, 'second trigger must be dropped while first is in flight');
  release('first');
  assert.equal(await slow, 'first');
  assert.equal(runs, 1, 'only one task body may execute');

  // 2. The gate recovers after completion and after failure.
  assert.equal(await gate(async () => 'third'), 'third', 'gate must run again after completion');
  await gate(async () => { throw new Error('boom'); }).catch(() => undefined);
  assert.equal(await gate(async () => 'fourth'), 'fourth', 'gate must recover after a rejection');

  // 3. Concurrent triggers collapse to exactly one run.
  let bodies = 0;
  await Promise.all([
    gate(async () => { bodies++; await new Promise((r) => setTimeout(r, 20)); }),
    gate(async () => { bodies++; }),
    gate(async () => { bodies++; }),
  ]);
  assert.equal(bodies, 1, 'three simultaneous triggers must run the body once');

  // 4. Poll delays stay within [base, base+jitter] and honor a seeded RNG.
  for (let i = 0; i < 500; i++) {
    const d = nextPollDelay(15000, 5000);
    assert(d >= 15000 && d <= 20000, `delay ${d} outside 15000..20000`);
  }
  assert.equal(nextPollDelay(15000, 5000, () => 0), 15000, 'rng=0 must give exactly the base');
  assert.equal(nextPollDelay(15000, 5000, () => 0.9999), 20000, 'rng~1 must reach base+jitter');
  assert.equal(nextPollDelay(15000, 0, () => 0.5), 15000, 'zero jitter must give exactly the base');

  // 5. The page wires both polls through the gate and self-scheduling timers.
  const page = fs.readFileSync('src/app/connections/page.tsx', 'utf8');
  assert(!/setInterval\(\(\) => \{\s*refreshData\(\);?\s*\}\s*,\s*15000\)/.test(page), '15s refresh must not use a bare setInterval');
  assert(!/setInterval\(\(\) => void fetchStats\(\),\s*30000\)/.test(page), '30s stats poll must not use a bare setInterval');
  assert(page.includes('refreshGateRef.current'), 'refreshData must go through the in-flight gate');
  assert(page.includes('statsGateRef.current'), 'fetchStats poll must go through the in-flight gate');
  assert(page.includes('nextPollDelay(15000, 5000)'), 'refresh poll must self-schedule with jitter');
  assert(page.includes('nextPollDelay(30000, 5000)'), 'stats poll must self-schedule with jitter');
  assert(page.includes('propai_whatsapp_status_updated'), 'status-update listener must be preserved');

  fs.unlinkSync('.refresh-gate-check.cjs');
  console.log('PASS in-flight gate: overlap dropped, recovery after failure, jitter bounds, page wiring preserved');
})().catch((err) => { try { fs.unlinkSync('.refresh-gate-check.cjs'); } catch {} console.error(err); process.exit(1); });
