/**
 * Regression test for bus pendingWrites cap
 * (audit finding: .brief/agentic-audit.md — src/bus.ts:79-83,
 * "Unbounded pendingWrites during persistent rotation").
 *
 * Exercises `enqueueBounded`, the pure helper that enforces the cap so the
 * invariant can be unit-tested without orchestrating a stalled rotation.
 *
 * Invariants locked in:
 *   1. Under cap → no drops, queue grows.
 *   2. At cap → one drop per push, oldest removed, newest retained.
 *   3. Cap of 0 → every push drops itself (queue stays empty).
 *   4. Cap of 1 → queue always holds most recent only.
 *   5. FIFO order: oldest out first.
 *
 * Run:  deno run --allow-all tests/test-bus-pending-cap.ts
 */

import { enqueueBounded } from "../src/bus.ts";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, predicate: boolean, detail?: string): void {
  if (predicate) {
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
    failures.push(name);
  }
}

console.log("\n=== enqueueBounded (under cap) ===");
{
  const q: number[] = [];
  const d1 = enqueueBounded(q, 1, 3);
  const d2 = enqueueBounded(q, 2, 3);
  const d3 = enqueueBounded(q, 3, 3);
  check("no drops while under cap", d1 === 0 && d2 === 0 && d3 === 0);
  check("queue holds all inserted items", JSON.stringify(q) === "[1,2,3]", `got ${JSON.stringify(q)}`);
}

console.log("\n=== enqueueBounded (at cap — drop oldest) ===");
{
  const q: number[] = [1, 2, 3];
  const dropped = enqueueBounded(q, 4, 3);
  check("one drop when pushing into full queue", dropped === 1, `got ${dropped}`);
  check("oldest (1) evicted", !q.includes(1));
  check("newest (4) retained", q.includes(4));
  check("queue length equals cap", q.length === 3, `got ${q.length}`);
  check("FIFO order preserved", JSON.stringify(q) === "[2,3,4]", `got ${JSON.stringify(q)}`);
}

console.log("\n=== enqueueBounded (burst above cap) ===");
{
  const q: number[] = [];
  let totalDropped = 0;
  for (let i = 0; i < 100; i++) totalDropped += enqueueBounded(q, i, 10);
  check("queue never exceeds cap under burst", q.length === 10, `len=${q.length}`);
  check("total drops = inserted - cap", totalDropped === 90, `got ${totalDropped}`);
  check("queue holds the 10 most recent", JSON.stringify(q) === JSON.stringify([90,91,92,93,94,95,96,97,98,99]));
}

console.log("\n=== enqueueBounded (cap = 1, most-recent-wins) ===");
{
  const q: string[] = [];
  enqueueBounded(q, "a", 1);
  enqueueBounded(q, "b", 1);
  const d = enqueueBounded(q, "c", 1);
  check("cap=1 keeps only newest", JSON.stringify(q) === '["c"]', `got ${JSON.stringify(q)}`);
  check("cap=1 drops one per push (after first)", d === 1, `got ${d}`);
}

console.log("\n=== enqueueBounded (cap = 0, degenerate) ===");
{
  const q: number[] = [];
  const d = enqueueBounded(q, 42, 0);
  check("cap=0 drops every push", d === 1 && q.length === 0, `dropped=${d}, len=${q.length}`);
}

console.log("\n=== enqueueBounded (unboundedness prevention — audit scenario) ===");
{
  // Simulates the audit trigger: hundreds of signals/sec with rotation stalled.
  // Before the fix: queue would grow to 100k. After the fix: capped at 10k.
  const CAP = 10_000;
  const q: { i: number }[] = [];
  let totalDropped = 0;
  for (let i = 0; i < 100_000; i++) {
    totalDropped += enqueueBounded(q, { i }, CAP);
  }
  check("queue stays at cap under 100k-burst", q.length === CAP, `len=${q.length}`);
  check("reports exact drop count", totalDropped === 100_000 - CAP, `got ${totalDropped}`);
  check("oldest retained item is inserted - cap", q[0].i === 100_000 - CAP, `got ${q[0].i}`);
  check("newest retained item is last inserted", q[q.length - 1].i === 100_000 - 1);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  Deno.exit(1);
}
