/**
 * Regression test for mxit-runner in-memory task cache
 * (audit finding: .brief/agentic-audit.md — src/mxit-runner.ts:181-211,
 * "sequential mode re-reads and re-parses TASKS.md every iteration").
 *
 * Exercises the pure helpers that back the cache in runMxit's sequential
 * loop so the invariant can be unit-tested without spawning real agents.
 *
 * Invariants locked in:
 *   1. findTaskByLine locates top-level tasks by 1-based line number.
 *   2. findTaskByLine walks into nested children and returns undefined for
 *      line numbers that don't exist.
 *   3. updateCachedStatus mutates the task in place and returns true.
 *   4. updateCachedStatus returns false (and is a no-op) for unknown lines.
 *   5. After updateCachedStatus → "x", getReady no longer returns the task.
 *   6. updateCachedStatus to a non-"@" status clears the cached agent field.
 *   7. Child updates via updateCachedStatus flow through to getReady — once
 *      every child of a parent is "x", the parent becomes ready.
 *
 * Run:  deno run --allow-all tests/test-mxit-cache.ts
 */

import { parseTasks, getReady } from "@mxit/parser";
import { findTaskByLine, updateCachedStatus } from "../src/mxit-runner.ts";

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

const FIXTURE = `# Tasks

- [ ] First open task
- [@claude-1] Claimed task
- [x] Already done
- [ ] Parent with children
  - [x] Child one
  - [ ] Child two
`;

console.log("\n=== findTaskByLine (top-level) ===");
{
  const tasks = parseTasks(FIXTURE);
  const t = findTaskByLine(tasks, 3);
  check("finds top-level task by line", !!t && t.description === "First open task",
    t ? `got line ${t.line} "${t.description}"` : "undefined");
}

console.log("\n=== findTaskByLine (nested child) ===");
{
  const tasks = parseTasks(FIXTURE);
  const child = findTaskByLine(tasks, 8);
  check("walks into children", !!child && child.description === "Child two",
    child ? `got "${child.description}"` : "undefined");
}

console.log("\n=== findTaskByLine (missing) ===");
{
  const tasks = parseTasks(FIXTURE);
  const missing = findTaskByLine(tasks, 999);
  check("returns undefined for unknown line", missing === undefined);
}

console.log("\n=== updateCachedStatus (happy path) ===");
{
  const tasks = parseTasks(FIXTURE);
  const ok = updateCachedStatus(tasks, 3, "x");
  check("returns true on success", ok === true);
  const t = findTaskByLine(tasks, 3);
  check("status is updated in place", !!t && t.status === "x",
    t ? `got "${t.status}"` : "undefined");
}

console.log("\n=== updateCachedStatus (unknown line) ===");
{
  const tasks = parseTasks(FIXTURE);
  const ok = updateCachedStatus(tasks, 999, "x");
  check("returns false on miss", ok === false);
  // Nothing else should have been touched
  check("no stray mutation on miss",
    tasks[0].status === " " && tasks[1].status === "@",
    `[${tasks.map(t => t.status).join(",")}]`);
}

console.log("\n=== updateCachedStatus clears agent when moving away from '@' ===");
{
  const tasks = parseTasks(FIXTURE);
  const claimed = findTaskByLine(tasks, 4)!;
  check("precondition: claimed task has agent",
    claimed.status === "@" && !!claimed.agent,
    `status="${claimed.status}" agent="${claimed.agent}"`);
  updateCachedStatus(tasks, 4, " ");
  const after = findTaskByLine(tasks, 4)!;
  check("status flipped to open", after.status === " ");
  check("agent cleared on non-@ status", after.agent === undefined,
    `agent="${after.agent}"`);
}

console.log("\n=== getReady reflects cache updates (complete flow) ===");
{
  const tasks = parseTasks(FIXTURE);
  const beforeIds = getReady(tasks).map((t) => t.line);
  check("initially ready: first open + 'Child two'",
    beforeIds.includes(3) && beforeIds.includes(8),
    `got lines [${beforeIds.join(",")}]`);
  // Simulate the sequential loop: completeTask on line 3 → cache marks "x".
  updateCachedStatus(tasks, 3, "x");
  const afterIds = getReady(tasks).map((t) => t.line);
  check("line 3 no longer ready after status 'x'", !afterIds.includes(3),
    `got lines [${afterIds.join(",")}]`);
}

console.log("\n=== getReady reflects cache updates (parent unblocks) ===");
{
  const tasks = parseTasks(FIXTURE);
  const parent = findTaskByLine(tasks, 6)!;
  check("parent not ready while child open",
    !getReady(tasks).some((t) => t.line === parent.line));
  // Complete the remaining open child (line 8) in-memory.
  updateCachedStatus(tasks, 8, "x");
  const ids = getReady(tasks).map((t) => t.line);
  check("parent becomes ready once every child is 'x'", ids.includes(6),
    `got [${ids.join(",")}]`);
}

console.log(`\n=== Summary ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
if (failed > 0) {
  console.log(`\nFailures:`);
  for (const f of failures) console.log(`  - ${f}`);
  Deno.exit(1);
}
console.log(`\nAll ${passed} cache-helper checks passed ✓`);
