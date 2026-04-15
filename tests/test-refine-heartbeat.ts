/**
 * Regression test for the concurrency-contract heartbeat (v1 fail-loud).
 *
 * See `../../snapshot/.brief/concurrency-contract.md` for the full design.
 * This test covers the expo-side integration: refine() must plant its own
 * heartbeat, refuse to start if a foreign fresh heartbeat exists, accept
 * `--force-stale-heartbeat` as an override, and clear the heartbeat on
 * clean shutdown.
 *
 * We can't exercise the full refine loop (needs a real agent), so we
 * assert behaviour at the heartbeat boundary — which fires BEFORE any
 * agent spawn.
 *
 * Run:  deno test --allow-all tests/test-refine-heartbeat.ts
 */

import { join } from "https://deno.land/std/path/mod.ts";
import {
  addGate,
  HeartbeatConflictError,
  init,
  readHeartbeat,
  snapshot,
  writeHeartbeat,
} from "@snapshot/core";
import { refine } from "../src/refine.ts";
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

/** Minimal git-initialized repo with one committed file and a snapshot
 *  baseline — enough to get past the pre-flight checks without touching
 *  an actual agent. */
async function makeRepo(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "expo-heartbeat-" });
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
  await snapshot(dir, { change: "baseline" });
  return dir;
}

async function cleanup(dir: string): Promise<void> {
  await Deno.remove(dir, { recursive: true }).catch(() => {});
}

/** Plant a fresh foreign heartbeat directly. Pid is `Deno.pid + 1` — the
 *  only value guaranteed not to be ours, regardless of what's running. */
async function plantForeignHeartbeat(dir: string, operation = "refine"): Promise<void> {
  const now = new Date().toISOString();
  const hb = {
    pid: Deno.pid + 1,
    operation,
    startedAt: now,
    updatedAt: now,
  };
  await Deno.writeTextFile(
    join(dir, ".refine", "heartbeat.json"),
    JSON.stringify(hb, null, 2),
  );
}

// ── Test 1: refine() refuses when a foreign fresh heartbeat exists ──

console.log(
  "\nheartbeat: refine() refuses to start when a foreign fresh heartbeat exists:",
);
{
  const dir = await makeRepo();
  const bus = new SignalBus();
  const spawner = new AgentSpawner(bus);
  try {
    await plantForeignHeartbeat(dir);
    let caught: unknown = null;
    try {
      await refine(bus, spawner, {
        dir,
        rubric: "test",
        maxIterations: 1,
        timeout: 1,
      });
    } catch (err) {
      caught = err;
    }
    check(
      "threw HeartbeatConflictError",
      caught instanceof HeartbeatConflictError,
      caught instanceof Error ? caught.message : String(caught),
    );
    if (caught instanceof HeartbeatConflictError) {
      check(
        "error identifies the holder's pid",
        caught.heartbeat.pid === Deno.pid + 1,
      );
      check(
        "error identifies the operation as 'refine'",
        caught.heartbeat.operation === "refine",
      );
      check(
        "message mentions 'another snapshot operation'",
        caught.message.includes("another snapshot operation"),
      );
      check(
        "message hints at manual recovery",
        caught.message.includes("remove") &&
          caught.message.includes("heartbeat.json"),
      );
    }
    // The foreign heartbeat must STILL be in place after the refusal —
    // we refused precisely because it's not ours to touch.
    const hb = await readHeartbeat(dir);
    check(
      "foreign heartbeat survives the refusal",
      hb !== null && hb.pid === Deno.pid + 1,
    );
  } finally {
    await cleanup(dir);
    await bus.close();
  }
}

// ── Test 2: forceStaleHeartbeat=true takes over a foreign heartbeat ──

console.log(
  "\nheartbeat: forceStaleHeartbeat=true takes over an otherwise-blocking foreign heartbeat:",
);
{
  const dir = await makeRepo();
  const bus = new SignalBus();
  const spawner = new AgentSpawner(bus);
  try {
    await plantForeignHeartbeat(dir);
    let caught: unknown = null;
    try {
      await refine(bus, spawner, {
        dir,
        rubric: "test",
        maxIterations: 1,
        timeout: 1,
        forceStaleHeartbeat: true,
      });
    } catch (err) {
      // Any error OTHER than HeartbeatConflictError is acceptable — the
      // full run will still fail (no real agent set up), but it should
      // fail for a different reason now that the heartbeat is bypassed.
      caught = err;
    }
    check(
      "force-stale bypassed the conflict",
      !(caught instanceof HeartbeatConflictError),
      caught instanceof Error ? caught.message : "(no error)",
    );
  } finally {
    await cleanup(dir);
    await bus.close();
  }
}

// ── Test 3: clean shutdown clears the heartbeat ──

console.log(
  "\nheartbeat: clean shutdown clears the heartbeat (so the next refine can start):",
);
{
  const dir = await makeRepo();
  const bus = new SignalBus();
  const spawner = new AgentSpawner(bus);
  try {
    // The refine() call will fail (no real agent), but the finally block
    // in refine should still fire and clear OUR heartbeat.
    try {
      await refine(bus, spawner, {
        dir,
        rubric: "test",
        maxIterations: 1,
        timeout: 1,
      });
    } catch {
      /* expected — no real agent */
    }
    const hb = await readHeartbeat(dir);
    check(
      "heartbeat cleared after refine exits (even via error)",
      hb === null,
      hb ? `lingering heartbeat for pid ${hb.pid}` : undefined,
    );
  } finally {
    await cleanup(dir);
    await bus.close();
  }
}

// ── Test 4: stale foreign heartbeat auto-expires ──

console.log(
  "\nheartbeat: stale foreign heartbeat (older than 30s) is silently taken over:",
);
{
  const dir = await makeRepo();
  const bus = new SignalBus();
  const spawner = new AgentSpawner(bus);
  try {
    // Plant a heartbeat dated 60s in the past — the snapshot-side
    // staleness threshold is 30s, so this one should be treated as
    // crashed and silently taken over by refine.
    const ancient = new Date(Date.now() - 60_000).toISOString();
    await Deno.writeTextFile(
      join(dir, ".refine", "heartbeat.json"),
      JSON.stringify(
        {
          pid: Deno.pid + 1,
          operation: "refine",
          startedAt: ancient,
          updatedAt: ancient,
        },
        null,
        2,
      ),
    );
    let caught: unknown = null;
    try {
      await refine(bus, spawner, {
        dir,
        rubric: "test",
        maxIterations: 1,
        timeout: 1,
      });
    } catch (err) {
      caught = err;
    }
    check(
      "stale heartbeat did NOT produce a HeartbeatConflictError",
      !(caught instanceof HeartbeatConflictError),
      caught instanceof Error ? caught.message : "(no error)",
    );
  } finally {
    await cleanup(dir);
    await bus.close();
  }
}

// ── Test 5: nested snapshot/restore/discard under refine's heartbeat ──

console.log(
  "\nheartbeat: refine's own heartbeat doesn't conflict with its internal snapshot calls:",
);
{
  // This test validates the same-pid re-entry pattern. refine() claims the
  // heartbeat at the top and then internally calls snapshot/restore/
  // discard — those nested calls must pass the check (same-pid), not
  // throw a self-collision. We simulate by claiming a "refine" heartbeat
  // manually, then invoking snapshot directly.
  const dir = await makeRepo();
  try {
    await writeHeartbeat(dir, "refine");
    // Must not throw — it's our own heartbeat.
    const v = await snapshot(dir, { change: "nested" });
    check("nested snapshot under own heartbeat succeeds", v.id !== undefined);
    // Outer "refine" heartbeat must still exist after the nested call —
    // withHeartbeat's same-pid path skips both claim and clear.
    const hb = await readHeartbeat(dir);
    check(
      "outer refine heartbeat survives nested snapshot",
      hb !== null && hb.operation === "refine",
      hb ? `operation=${hb.operation}` : "missing",
    );
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
