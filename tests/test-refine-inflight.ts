/**
 * Unit tests for resumability: .refine/inflight.json round-trip + edge cases.
 *
 * Coverage:
 *   - persist → load round-trip preserves all fields
 *   - missing file → load returns null without warning
 *   - malformed JSON → load returns null, deletes the bad file
 *   - wrong schema version → load returns null, deletes
 *   - stale (older than threshold) → load returns null, deletes
 *   - required-field validation catches partial / old shapes
 *   - clear() is idempotent on already-missing files
 *
 * Does NOT test the full refine-loop resume because that needs real agent
 * spawns. Those primitives are covered by the existing gate/scope tests;
 * what matters here is that the persistence layer is bulletproof.
 *
 * Run:  deno run --allow-all tests/test-refine-inflight.ts
 */

import { join } from "https://deno.land/std/path/mod.ts";
import { _testOnlyInflight as inflight } from "../src/refine.ts";

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

async function makeDir(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "expo-inflight-" });
  // refine loop relies on .refine/ existing (init() creates it). Pre-create
  // so persist() doesn't have to mkdir in every test.
  await Deno.mkdir(join(dir, ".refine"), { recursive: true });
  return dir;
}

async function cleanup(dir: string): Promise<void> {
  await Deno.remove(dir, { recursive: true }).catch(() => {});
}

const baseState = () => ({
  schemaVersion: inflight.SCHEMA_VERSION,
  completedIterations: 3,
  runStartedAt: Date.now() - 60_000,
  persistedAt: Date.now(),
  totalCost: 0.42,
  gateFailures: 1,
  gatesProposed: 0,
  recentFailures: [
    { iteration: 2, change: "tried X", gateName: "tests", reason: "exit 1" },
  ],
  discardCounts: [["000", 2] as [string, number]],
  dir: "/tmp/placeholder",
});

// ── Test 1: round-trip persist → load ──────────────────────────

console.log("\ninflight — persist/load round-trip:");
{
  const dir = await makeDir();
  try {
    const state = { ...baseState(), dir };
    await inflight.persist(dir, state);
    const loaded = await inflight.load(dir);
    check("loaded is not null", loaded !== null);
    check("completedIterations preserved", loaded?.completedIterations === 3);
    check("totalCost preserved", loaded?.totalCost === 0.42);
    check("gateFailures preserved", loaded?.gateFailures === 1);
    check("recentFailures preserved", loaded?.recentFailures.length === 1);
    check("recentFailures[0].change", loaded?.recentFailures[0]?.change === "tried X");
    check("discardCounts preserved (array form)", JSON.stringify(loaded?.discardCounts) === '[["000",2]]');
    check("dir preserved", loaded?.dir === dir);
  } finally {
    await cleanup(dir);
  }
}

// ── Test 2: missing file → null ─────────────────────────────────

console.log("\ninflight — missing file returns null:");
{
  const dir = await makeDir();
  try {
    const loaded = await inflight.load(dir);
    check("null on missing", loaded === null);
  } finally {
    await cleanup(dir);
  }
}

// ── Test 3: malformed JSON → null + deletes file ───────────────

console.log("\ninflight — malformed JSON is discarded:");
{
  const dir = await makeDir();
  try {
    const path = join(dir, ".refine", "inflight.json");
    await Deno.writeTextFile(path, "{ garbled: ");
    const loaded = await inflight.load(dir);
    check("null on bad JSON", loaded === null);
    // File should have been cleaned up so it doesn't affect future loads
    try {
      await Deno.stat(path);
      check("bad file cleaned up", false, "file still exists");
    } catch {
      check("bad file cleaned up", true);
    }
  } finally {
    await cleanup(dir);
  }
}

// ── Test 4: wrong schema version → null + deletes ─────────────

console.log("\ninflight — wrong schema version is discarded:");
{
  const dir = await makeDir();
  try {
    const path = join(dir, ".refine", "inflight.json");
    await Deno.writeTextFile(path, JSON.stringify({
      ...baseState(),
      schemaVersion: 999, // future schema — our code won't understand
      dir,
    }));
    const loaded = await inflight.load(dir);
    check("null on schema mismatch", loaded === null);
    try {
      await Deno.stat(path);
      check("bad-schema file cleaned up", false);
    } catch {
      check("bad-schema file cleaned up", true);
    }
  } finally {
    await cleanup(dir);
  }
}

// ── Test 5: stale file → null + deletes ────────────────────────

console.log("\ninflight — stale file is discarded:");
{
  const dir = await makeDir();
  try {
    const path = join(dir, ".refine", "inflight.json");
    // persistedAt well in the past — way older than STALE_MS
    const stale = {
      ...baseState(),
      persistedAt: Date.now() - (inflight.STALE_MS + 60_000),
      dir,
    };
    await Deno.writeTextFile(path, JSON.stringify(stale));
    const loaded = await inflight.load(dir);
    check("null on stale", loaded === null);
    try {
      await Deno.stat(path);
      check("stale file cleaned up", false);
    } catch {
      check("stale file cleaned up", true);
    }
  } finally {
    await cleanup(dir);
  }
}

// ── Test 6: missing required fields → null + deletes ──────────

console.log("\ninflight — partial state is discarded:");
{
  const dir = await makeDir();
  try {
    const path = join(dir, ".refine", "inflight.json");
    // Valid schema + fresh timestamp but missing gateFailures etc.
    await Deno.writeTextFile(path, JSON.stringify({
      schemaVersion: inflight.SCHEMA_VERSION,
      completedIterations: 1,
      persistedAt: Date.now(),
      runStartedAt: Date.now(),
      dir,
      // missing: totalCost, gateFailures, gatesProposed, recentFailures, discardCounts
    }));
    const loaded = await inflight.load(dir);
    check("null on missing fields", loaded === null);
  } finally {
    await cleanup(dir);
  }
}

// ── Test 7: non-object root → null ─────────────────────────────

console.log("\ninflight — non-object root is discarded:");
{
  const dir = await makeDir();
  try {
    const path = join(dir, ".refine", "inflight.json");
    await Deno.writeTextFile(path, JSON.stringify([1, 2, 3]));
    const loaded = await inflight.load(dir);
    check("null on array root", loaded === null);
  } finally {
    await cleanup(dir);
  }
}

// ── Test 8: clear() on missing file is a no-op ────────────────

console.log("\ninflight.clear — idempotent on missing file:");
{
  const dir = await makeDir();
  try {
    // Should not throw
    await inflight.clear(dir);
    check("no throw on missing", true);
    // Do it twice — still no throw
    await inflight.clear(dir);
    check("still no throw second call", true);
  } finally {
    await cleanup(dir);
  }
}

// ── Test 9: persist → clear → load returns null ────────────────

console.log("\ninflight — clear removes file:");
{
  const dir = await makeDir();
  try {
    const state = { ...baseState(), dir };
    await inflight.persist(dir, state);
    const before = await inflight.load(dir);
    check("persisted state loads", before !== null);
    await inflight.clear(dir);
    const after = await inflight.load(dir);
    check("cleared state loads as null", after === null);
  } finally {
    await cleanup(dir);
  }
}

// ── Test 10: persist auto-creates .refine if missing ──────────

console.log("\ninflight.persist — auto-creates .refine/:");
{
  const dir = await Deno.makeTempDir({ prefix: "expo-inflight-bare-" });
  try {
    // Note: NOT pre-creating .refine/ this time
    const state = { ...baseState(), dir };
    await inflight.persist(dir, state);
    const loaded = await inflight.load(dir);
    check("persist created .refine and wrote", loaded !== null);
  } finally {
    await cleanup(dir);
  }
}

// ── Summary ────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const name of failures) console.log(`  - ${name}`);
  Deno.exit(1);
}
