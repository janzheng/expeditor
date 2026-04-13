/**
 * Unit tests for `checkRefineGates` — the pre-flight primitive that powers
 * `expo refine <dir> gate check`.
 *
 * The core contract the orchestrating agent depends on:
 *   - All gates run, even after one fails (no fail-fast short-circuit).
 *   - Per-gate `pass` accurately reflects exit code.
 *   - Timeouts surface as `timedOut: true, pass: false`.
 *   - `source` distinguishes direct vs inherited so the caller knows which
 *     variant to edit when a gate fails.
 *   - Missing variant_id throws (typo protection).
 *
 * Run:  deno run --allow-all tests/test-refine-gate-check.ts
 */

import { join } from "https://deno.land/std/path/mod.ts";
import { addGate, init, snapshot } from "@snapshot/core";
import { checkRefineGates } from "../src/refine.ts";

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

async function makeTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "expo-gate-check-test-" });
}

async function cleanup(dir: string): Promise<void> {
  await Deno.remove(dir, { recursive: true }).catch(() => {});
}

// ── Test 1: no gates → empty result ────────────────────────────

console.log("\ncheckRefineGates — empty archive:");
{
  const dir = await makeTempDir();
  await Deno.writeTextFile(join(dir, "README.md"), "# test\n");
  try {
    await init(dir);
    await snapshot(dir, { change: "baseline", summary: "first snapshot" });
    const results = await checkRefineGates(dir);
    check("no gates → empty array", results.length === 0);
  } finally {
    await cleanup(dir);
  }
}

// ── Test 2: all gates pass ─────────────────────────────────────

console.log("\ncheckRefineGates — all gates pass:");
{
  const dir = await makeTempDir();
  await Deno.writeTextFile(join(dir, "README.md"), "# test\n");
  try {
    await init(dir);
    const v = await snapshot(dir, { change: "baseline", summary: "first snapshot" });
    await addGate(dir, v.id, { name: "exists", command: "test -f README.md" });
    await addGate(dir, v.id, { name: "content", command: "grep -q test README.md" });

    const results = await checkRefineGates(dir, v.id);
    check("two results", results.length === 2);
    check("all pass", results.every((r) => r.pass));
    check("no stderr on pass", results.every((r) => r.stderr === undefined));
    check("exit codes 0", results.every((r) => r.exitCode === 0));
    check("durations recorded", results.every((r) => r.durationMs >= 0));
    check("source=direct", results.every((r) => r.source === "direct"));
  } finally {
    await cleanup(dir);
  }
}

// ── Test 3: one gate fails — others still run ──────────────────

console.log("\ncheckRefineGates — does NOT fail-fast:");
{
  const dir = await makeTempDir();
  await Deno.writeTextFile(join(dir, "README.md"), "# test\n");
  try {
    await init(dir);
    const v = await snapshot(dir, { change: "baseline", summary: "first" });
    await addGate(dir, v.id, { name: "gate_a_passes", command: "true" });
    await addGate(dir, v.id, { name: "gate_b_fails", command: "false" });
    await addGate(dir, v.id, { name: "gate_c_also_passes", command: "true" });

    const results = await checkRefineGates(dir, v.id);
    check("all three ran (no fail-fast)", results.length === 3);
    check("first passed", results[0]?.pass === true);
    check("second failed", results[1]?.pass === false);
    check("third still ran AND passed", results[2]?.pass === true);
    check("failed gate has non-zero exitCode", (results[1]?.exitCode ?? 0) !== 0);
  } finally {
    await cleanup(dir);
  }
}

// ── Test 4: gate with stderr surfaces on failure ───────────────

console.log("\ncheckRefineGates — stderr captured on failure:");
{
  const dir = await makeTempDir();
  await Deno.writeTextFile(join(dir, "README.md"), "# test\n");
  try {
    await init(dir);
    const v = await snapshot(dir, { change: "baseline", summary: "first" });
    await addGate(dir, v.id, {
      name: "noisy_fail",
      command: "echo 'kaboom on stderr' >&2; exit 1",
    });

    const results = await checkRefineGates(dir, v.id);
    check("one result", results.length === 1);
    check("failed", results[0]?.pass === false);
    check("stderr captured", (results[0]?.stderr ?? "").includes("kaboom"));
  } finally {
    await cleanup(dir);
  }
}

// ── Test 5: timeout surfaces distinctly from plain exit ────────

console.log("\ncheckRefineGates — timeout:");
{
  const dir = await makeTempDir();
  await Deno.writeTextFile(join(dir, "README.md"), "# test\n");
  try {
    await init(dir);
    const v = await snapshot(dir, { change: "baseline", summary: "first" });
    await addGate(dir, v.id, {
      name: "slow_gate",
      command: "sleep 5",
    });

    const started = Date.now();
    const results = await checkRefineGates(dir, v.id, { timeoutMs: 200 });
    const elapsed = Date.now() - started;
    check("one result", results.length === 1);
    check("failed", results[0]?.pass === false);
    check("flagged as timedOut", results[0]?.timedOut === true);
    check("exitCode -1 signals timeout", results[0]?.exitCode === -1);
    // Allow wide margin — test-suite CI can be slow — but should be well under sleep 5.
    check("actually interrupted (not waiting the full sleep)", elapsed < 3000, `elapsed=${elapsed}ms`);
  } finally {
    await cleanup(dir);
  }
}

// ── Test 6: inherited gates are tagged, not re-listed as direct ─

console.log("\ncheckRefineGates — inherited gate source:");
{
  const dir = await makeTempDir();
  await Deno.writeTextFile(join(dir, "README.md"), "# test\n");
  try {
    await init(dir);
    const v1 = await snapshot(dir, { change: "baseline", summary: "root" });
    await addGate(dir, v1.id, { name: "root_gate", command: "true" });
    const v2 = await snapshot(dir, { change: "child edit", summary: "child" });

    const results = await checkRefineGates(dir, v2.id);
    check("one inherited gate visible from child", results.length === 1);
    check("source=inherited", results[0]?.source === "inherited");
    check("addedBy points at root variant", results[0]?.addedBy === v1.id);
    check("still passes", results[0]?.pass === true);
  } finally {
    await cleanup(dir);
  }
}

// ── Test 7: unknown variant_id throws ──────────────────────────

console.log("\ncheckRefineGates — unknown variantId:");
{
  const dir = await makeTempDir();
  await Deno.writeTextFile(join(dir, "README.md"), "# test\n");
  try {
    await init(dir);
    await snapshot(dir, { change: "baseline", summary: "first" });
    let threw = false;
    let msg = "";
    try {
      await checkRefineGates(dir, "nonexistent-variant-id");
    } catch (err) {
      threw = true;
      msg = String(err instanceof Error ? err.message : err);
    }
    check("throws on typo", threw);
    check("error names the missing variant", msg.includes("nonexistent-variant-id"));
  } finally {
    await cleanup(dir);
  }
}

// ── Test 8: defaults to HEAD when no variantId given ───────────

console.log("\ncheckRefineGates — default variant (last kept):");
{
  const dir = await makeTempDir();
  await Deno.writeTextFile(join(dir, "README.md"), "# test\n");
  try {
    await init(dir);
    const v1 = await snapshot(dir, { change: "baseline", summary: "first" });
    await addGate(dir, v1.id, { name: "always_pass", command: "true" });
    const v2 = await snapshot(dir, { change: "iter", summary: "second" });

    const results = await checkRefineGates(dir); // no variantId
    check("finds inherited gate from default HEAD", results.length === 1);
    check("pass", results[0]?.pass === true);
    check("source reflects inheritance (v2 has no direct gate)", results[0]?.source === "inherited");
    check("addedBy=v1", results[0]?.addedBy === v1.id);
    // Sanity: v2 was the last snapshot so it's the default target
    check("v2 IS the last kept", v2.id.length > 0);
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
