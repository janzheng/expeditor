/**
 * Per-gate timeout: verifies that a gate can specify its own timeout that
 * overrides the global `--gate-timeout`.
 *
 * Coverage:
 *   - loadGateFile parses `timeoutMs` straight through
 *   - loadGateFile coerces `timeoutSec` → timeoutMs (common mistake ergonomic)
 *   - invalid timeout values (zero/negative/NaN) are dropped
 *   - checkRefineGates respects per-gate timeout: a fast gate with short
 *     override finishes fast; a slow gate without override uses the global
 *
 * Run:  deno run --allow-all tests/test-refine-per-gate-timeout.ts
 */

import { join } from "https://deno.land/std/path/mod.ts";
import { addGate, init, snapshot } from "@snapshot/core";
import { checkRefineGates, loadGateFile } from "../src/refine.ts";

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
  const dir = await Deno.makeTempDir({ prefix: "expo-gate-timeout-" });
  await Deno.writeTextFile(join(dir, "README.md"), "# test\n");
  return dir;
}

async function cleanup(dir: string): Promise<void> {
  await Deno.remove(dir, { recursive: true }).catch(() => {});
}

async function writeJson(path: string, obj: unknown): Promise<void> {
  await Deno.writeTextFile(path, JSON.stringify(obj));
}

// ── Test 1: loadGateFile carries timeoutMs through ─────────────

console.log("\nloadGateFile — timeoutMs preserved:");
{
  const dir = await makeDir();
  const path = join(dir, "gates.json");
  try {
    await writeJson(path, [
      { name: "fast", command: "true", timeoutMs: 500 },
      { name: "slow", command: "true", timeoutMs: 30000 },
    ]);
    const gates = await loadGateFile(path);
    check("first gate timeoutMs=500", gates[0]?.timeoutMs === 500);
    check("second gate timeoutMs=30000", gates[1]?.timeoutMs === 30000);
  } finally {
    await cleanup(dir);
  }
}

// ── Test 2: loadGateFile coerces timeoutSec → timeoutMs ────────

console.log("\nloadGateFile — timeoutSec coerced to ms:");
{
  const dir = await makeDir();
  const path = join(dir, "gates.json");
  try {
    await writeJson(path, [
      { name: "timed", command: "true", timeoutSec: 30 },
    ]);
    const gates = await loadGateFile(path);
    check("30s → 30000ms", gates[0]?.timeoutMs === 30000);
  } finally {
    await cleanup(dir);
  }
}

// ── Test 3: timeoutMs takes precedence over timeoutSec ─────────

console.log("\nloadGateFile — timeoutMs wins over timeoutSec:");
{
  const dir = await makeDir();
  const path = join(dir, "gates.json");
  try {
    await writeJson(path, [
      { name: "both", command: "true", timeoutMs: 1000, timeoutSec: 99 },
    ]);
    const gates = await loadGateFile(path);
    check("timeoutMs wins", gates[0]?.timeoutMs === 1000);
  } finally {
    await cleanup(dir);
  }
}

// ── Test 4: invalid timeouts dropped ───────────────────────────

console.log("\nloadGateFile — invalid timeouts dropped:");
{
  const dir = await makeDir();
  const path = join(dir, "gates.json");
  try {
    await writeJson(path, [
      { name: "zero", command: "true", timeoutMs: 0 },
      { name: "negative", command: "true", timeoutMs: -500 },
      { name: "nan", command: "true", timeoutMs: "not a number" },
      { name: "inf", command: "true", timeoutMs: Infinity },
    ]);
    const gates = await loadGateFile(path);
    check("zero dropped", gates[0]?.timeoutMs === undefined);
    check("negative dropped", gates[1]?.timeoutMs === undefined);
    check("non-number dropped", gates[2]?.timeoutMs === undefined);
    check("Infinity dropped", gates[3]?.timeoutMs === undefined);
  } finally {
    await cleanup(dir);
  }
}

// ── Test 5: per-gate timeout enforced at runtime ────────────────

console.log("\ncheckRefineGates — per-gate timeout enforced:");
{
  const dir = await makeDir();
  try {
    await init(dir);
    const v = await snapshot(dir, { change: "baseline", summary: "first" });
    // Short-override gate hits its own deadline well before the 60s global
    await addGate(dir, v.id, {
      name: "short_timeout",
      command: "sleep 5",
      timeoutMs: 200,
    });

    const started = Date.now();
    const results = await checkRefineGates(dir, v.id, { timeoutMs: 60_000 });
    const elapsed = Date.now() - started;

    check("one result", results.length === 1);
    check("timed out (pass=false)", results[0]?.pass === false);
    check("timedOut flag set", results[0]?.timedOut === true);
    check("actually used per-gate timeout, not global", elapsed < 2000, `elapsed=${elapsed}ms`);
  } finally {
    await cleanup(dir);
  }
}

// ── Test 6: gate WITHOUT override uses global ─────────────────

console.log("\ncheckRefineGates — no override falls back to global:");
{
  const dir = await makeDir();
  try {
    await init(dir);
    const v = await snapshot(dir, { change: "baseline", summary: "first" });
    // No per-gate timeout; use small global so the gate times out fast
    await addGate(dir, v.id, { name: "no_override", command: "sleep 5" });

    const started = Date.now();
    const results = await checkRefineGates(dir, v.id, { timeoutMs: 150 });
    const elapsed = Date.now() - started;

    check("timed out", results[0]?.pass === false);
    check("used global timeout (fast)", elapsed < 2000, `elapsed=${elapsed}ms`);
  } finally {
    await cleanup(dir);
  }
}

// ── Test 7: mix of override + fallback in same run ─────────────

console.log("\ncheckRefineGates — mixed per-gate and fallback:");
{
  const dir = await makeDir();
  try {
    await init(dir);
    const v = await snapshot(dir, { change: "baseline", summary: "first" });
    // Fast gate with generous per-gate timeout (well beyond cmd runtime)
    await addGate(dir, v.id, { name: "fast_pass", command: "true", timeoutMs: 5000 });
    // Slow gate with tight per-gate timeout
    await addGate(dir, v.id, { name: "slow_times_out", command: "sleep 5", timeoutMs: 200 });

    const results = await checkRefineGates(dir, v.id, { timeoutMs: 60_000 });
    check("two results", results.length === 2);
    check("fast_pass succeeded", results[0]?.pass === true);
    check("slow_times_out timed out", results[1]?.pass === false);
    check("slow timedOut flag set", results[1]?.timedOut === true);
  } finally {
    await cleanup(dir);
  }
}

// ── Test 8: addGate stores timeoutMs in manifest ──────────────

console.log("\naddGate — timeoutMs persisted to manifest:");
{
  const dir = await makeDir();
  try {
    await init(dir);
    const v = await snapshot(dir, { change: "baseline", summary: "first" });
    const added = await addGate(dir, v.id, {
      name: "integration",
      command: "deno test tests/integration/",
      timeoutMs: 120_000,
    });
    check("returned gate has timeoutMs", added.timeoutMs === 120_000);

    // Reload from disk and verify persistence
    const { listGates } = await import("@snapshot/core");
    const gates = await listGates(dir, v.id);
    check("reloaded gate has timeoutMs", gates[0]?.timeoutMs === 120_000);
  } finally {
    await cleanup(dir);
  }
}

// ── Test 9: addGate without timeoutMs keeps manifest compact ──

console.log("\naddGate — no timeoutMs means no field stored:");
{
  const dir = await makeDir();
  try {
    await init(dir);
    const v = await snapshot(dir, { change: "baseline", summary: "first" });
    await addGate(dir, v.id, { name: "plain", command: "true" });

    const { listGates } = await import("@snapshot/core");
    const gates = await listGates(dir, v.id);
    check("gate lacks timeoutMs field", gates[0]?.timeoutMs === undefined);
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
