/**
 * Regression test for shakedown Finding #13: pre-flight baseline-gate check.
 *
 * Pre-#13, a gate that failed on the baseline (e.g. integration test that
 * needs a running service, or a stale test that was broken before refine
 * started) would silently force-discard every iteration. The user would
 * see "N iterations, 0 kept" and assume refine doesn't converge on their
 * codebase, burning $5-20 of budget on what was actually a diagnosable-up-
 * front bug.
 *
 * Fix: before spawning iter-1, run all seeded gates against the baseline
 * via `checkRefineGates`. If any fail, print a helpful message and throw
 * "baseline gate failure" — CLI catches it and exits 5 (distinct from
 * exit 4 for stale-baseline, exit 1 for general errors).
 *
 * Test strategy: we can't run the full refine() loop without a real agent,
 * but we CAN verify the pre-flight fires cleanly AT THE pre-flight step,
 * before any agent spawn. The throw happens at a known line; catching it
 * and inspecting the message proves the guard works.
 *
 * Run:  deno run --allow-all tests/test-refine-baseline-gate-check.ts
 */

import { join } from "https://deno.land/std/path/mod.ts";
import { addGate, init, snapshot } from "@snapshot/core";
import { checkRefineGates, refine } from "../src/refine.ts";
import { AgentSpawner } from "../src/spawner.ts";
import { SignalBus } from "../src/bus.ts";

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

async function makeRepoWithFailingGate(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "expo-preflight-" });
  for (const cmd of [
    ["git", "init", "-q"],
    ["git", "config", "user.email", "test@test"],
    ["git", "config", "user.name", "test"],
  ]) {
    const p = await new Deno.Command(cmd[0], {
      args: cmd.slice(1),
      cwd: dir,
      stdout: "null",
      stderr: "null",
    }).output();
    if (!p.success) throw new Error(`setup failed: ${cmd.join(" ")}`);
  }
  await Deno.writeTextFile(join(dir, "seed.txt"), "seed\n");
  for (const cmd of [
    ["git", "add", "."],
    ["git", "commit", "-qm", "seed"],
  ]) {
    await new Deno.Command(cmd[0], {
      args: cmd.slice(1),
      cwd: dir,
      stdout: "null",
      stderr: "null",
    }).output();
  }
  await init(dir);
  const baseline = await snapshot(dir, { change: "baseline" });
  // Seed a gate that FAILS on baseline — emulates the Finding #13 scenario.
  await addGate(dir, baseline.id, {
    name: "always_fails",
    command: "sh -c 'exit 1'",
  });
  return dir;
}

async function cleanup(dir: string): Promise<void> {
  await Deno.remove(dir, { recursive: true }).catch(() => {});
}

// ── Test 1: checkRefineGates flags the failing baseline gate ──

console.log("\nbaseline gate check — checkRefineGates surfaces the failure:");
{
  const dir = await makeRepoWithFailingGate();
  try {
    const results = await checkRefineGates(dir);
    check("1 gate result", results.length === 1);
    check("gate failed (pass=false)", results[0].pass === false);
    check("non-zero exit code", results[0].exitCode === 1);
    check("name is 'always_fails'", results[0].name === "always_fails");
  } finally {
    await cleanup(dir);
  }
}

// ── Test 2: refine() throws with 'baseline gate failure' at pre-flight ──

console.log("\nFinding #13: refine() refuses to start when baseline gate fails:");
{
  const dir = await makeRepoWithFailingGate();
  const bus = new SignalBus();
  const spawner = new AgentSpawner(bus);
  let thrownMsg = "";
  try {
    await refine(bus, spawner, {
      dir,
      rubric: "test rubric",
      maxIterations: 1,
      // Explicitly do NOT set skipBaselineCheck — we want the throw.
    });
    check("should have thrown but didn't", false);
  } catch (err) {
    thrownMsg = err instanceof Error ? err.message : String(err);
    check("threw an error", true);
    check(
      "error mentions 'baseline gate failure'",
      thrownMsg.includes("baseline gate failure"),
      thrownMsg,
    );
    check(
      "error mentions --skip-baseline-check",
      thrownMsg.includes("--skip-baseline-check"),
      thrownMsg,
    );
    check(
      "error includes failure count",
      thrownMsg.includes("(1 of 1)"),
      thrownMsg,
    );
  }
  await cleanup(dir);
  await bus.close();
}

// ── Test 3: skipBaselineCheck=true bypasses the pre-flight ──
//
// We can't run the full loop (needs a real agent spawn), but we CAN verify
// that setting skipBaselineCheck changes the throw behaviour. With the flag
// set, the pre-flight should NOT throw "baseline gate failure" — instead
// the error will come from some later stage (likely agent-spawn). Catching
// and inspecting proves pre-flight didn't fire.

console.log(
  "\nFinding #13: skipBaselineCheck=true bypasses the pre-flight check:",
);
{
  const dir = await makeRepoWithFailingGate();
  const bus = new SignalBus();
  const spawner = new AgentSpawner(bus);
  let thrownMsg = "";
  try {
    await refine(bus, spawner, {
      dir,
      rubric: "test rubric",
      maxIterations: 1,
      skipBaselineCheck: true,
      // This run will still likely fail later (no real agent set up) but
      // the FIRST failure shouldn't be the baseline-gate pre-flight.
      timeout: 1, // force a quick agent timeout
    });
  } catch (err) {
    thrownMsg = err instanceof Error ? err.message : String(err);
  }
  check(
    "error is NOT 'baseline gate failure' (pre-flight bypassed)",
    !thrownMsg.includes("baseline gate failure"),
    thrownMsg || "(no error — full run succeeded, also acceptable)",
  );
  await cleanup(dir);
  await bus.close();
}

// ── Test 4: no gates → no pre-flight block ──

console.log(
  "\nFinding #13: repo with no seeded gates doesn't block on pre-flight:",
);
{
  const dir = await Deno.makeTempDir({ prefix: "expo-preflight-nogate-" });
  try {
    for (const cmd of [
      ["git", "init", "-q"],
      ["git", "config", "user.email", "test@test"],
      ["git", "config", "user.name", "test"],
    ]) {
      await new Deno.Command(cmd[0], {
        args: cmd.slice(1),
        cwd: dir,
        stdout: "null",
        stderr: "null",
      }).output();
    }
    await Deno.writeTextFile(join(dir, "seed.txt"), "seed\n");
    for (const cmd of [
      ["git", "add", "."],
      ["git", "commit", "-qm", "seed"],
    ]) {
      await new Deno.Command(cmd[0], {
        args: cmd.slice(1),
        cwd: dir,
        stdout: "null",
        stderr: "null",
      }).output();
    }
    await init(dir);
    await snapshot(dir, { change: "baseline" });
    // No gate added — checkRefineGates returns empty → pre-flight no-op.
    const results = await checkRefineGates(dir);
    check("no gates returned empty", results.length === 0);
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
