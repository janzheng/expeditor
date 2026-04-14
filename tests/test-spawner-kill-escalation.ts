/**
 * Regression test for shakedown Finding #12: per-agent budget overrun on
 * long subprocesses.
 *
 * Pre-#12, `killAgent` sent SIGTERM to the process group once and walked
 * away. If the subprocess ignored SIGTERM (or was blocked in a syscall
 * that didn't propagate the signal cleanly — e.g., deno waiting on a test
 * subprocess), cost kept accumulating until natural completion. Observed
 * $3.15 on a $2 budget (57% overrun).
 *
 * Fix: after SIGTERM, schedule a SIGKILL escalation after `KILL_GRACE_MS`
 * if the agent is still marked running in the registry. Fire-and-forget,
 * unrefed so it doesn't hold the event loop open.
 *
 * This test fakes the scenario by putting a long-running process into the
 * registry as if it were a spawned agent, then calling killAgent with a
 * short grace period and asserting the process is dead shortly after.
 *
 * Run:  deno run --allow-all tests/test-spawner-kill-escalation.ts
 */

import { AgentSpawner, DEFAULT_KILL_STAGGER_MS } from "../src/spawner.ts";
import { SignalBus } from "../src/bus.ts";
import { Registry } from "../src/registry.ts";

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

async function isAlive(pid: number): Promise<boolean> {
  try {
    // Signal 0 is a liveness probe — doesn't deliver a signal, just
    // checks whether the process exists and we have permission to signal.
    Deno.kill(pid, "SIGCONT");
    // SIGCONT is safer than "0" on macOS — it's a no-op for running
    // processes. Throws on not-found.
    return true;
  } catch {
    return false;
  }
}

async function spawnStubbornProcess(): Promise<{ pid: number; cleanup: () => void }> {
  // A shell that traps SIGTERM and keeps sleeping — the exact pathological
  // case Finding #12 describes (subprocess doesn't respond to SIGTERM).
  const proc = new Deno.Command("sh", {
    args: [
      "-c",
      // Trap SIGTERM so SIGTERM alone doesn't kill us. Only SIGKILL ends it.
      "trap '' TERM; sleep 30",
    ],
    stdout: "null",
    stderr: "null",
  }).spawn();
  // Wait a moment to ensure the trap is installed.
  await new Promise((r) => setTimeout(r, 100));
  return {
    pid: proc.pid,
    cleanup: () => {
      try {
        Deno.kill(proc.pid, "SIGKILL");
      } catch { /* already dead */ }
    },
  };
}

// ── Test 1: killAgent escalates to SIGKILL when SIGTERM is ignored ──

console.log("\nFinding #12: killAgent escalates to SIGKILL after grace period:");
{
  const bus = new SignalBus();
  const spawner = new AgentSpawner(bus);
  const registry = spawner.getRegistry();
  const stub = await spawnStubbornProcess();

  // Register the stub as if it were a spawned agent.
  await registry.register({
    agentId: "stubborn-agent",
    sessionId: "test-session",
    name: "stubborn-agent",
    cwd: Deno.cwd(),
    pid: stub.pid,
    status: "running",
    startedAt: Date.now(),
  });

  // Shrink the grace period so the test runs fast.
  const originalGrace = AgentSpawner.KILL_GRACE_MS;
  AgentSpawner.KILL_GRACE_MS = 200;

  try {
    check("process is alive before kill", await isAlive(stub.pid));

    const killed = await spawner.killAgent("stubborn-agent", "test");
    check("killAgent returned true (signal sent)", killed);

    // SIGTERM doesn't kill the stub because of its trap. After grace
    // period, the escalation timer fires SIGKILL.
    await new Promise((r) => setTimeout(r, AgentSpawner.KILL_GRACE_MS + 300));

    check("process is dead after SIGKILL escalation", !(await isAlive(stub.pid)));
  } finally {
    AgentSpawner.KILL_GRACE_MS = originalGrace;
    stub.cleanup();
    await bus.close();
  }
}

// ── Test 2: no escalation if agent exited cleanly on SIGTERM ──
//
// If the agent DOES respond to SIGTERM (the normal case), the registry
// status should have moved off "running" by the time the grace timer
// fires. The escalation must check status and skip the SIGKILL.

console.log(
  "\nFinding #12: no SIGKILL escalation when SIGTERM was honoured:",
);
{
  const bus = new SignalBus();
  const spawner = new AgentSpawner(bus);
  const registry = spawner.getRegistry();

  // Spawn a process that DOES respond to SIGTERM (no trap).
  const proc = new Deno.Command("sh", {
    args: ["-c", "sleep 30"],
    stdout: "null",
    stderr: "null",
  }).spawn();
  await new Promise((r) => setTimeout(r, 100));

  await registry.register({
    agentId: "cooperative-agent",
    sessionId: "test-session",
    name: "cooperative-agent",
    cwd: Deno.cwd(),
    pid: proc.pid,
    status: "running",
    startedAt: Date.now(),
  });

  const originalGrace = AgentSpawner.KILL_GRACE_MS;
  AgentSpawner.KILL_GRACE_MS = 200;

  let escalationHappened = false;
  const origWarn = console.warn;
  console.warn = (msg: string) => {
    if (typeof msg === "string" && msg.includes("escalating to SIGKILL")) {
      escalationHappened = true;
    }
    origWarn(msg);
  };

  try {
    await spawner.killAgent("cooperative-agent", "test");
    // Simulate the agent's exit handler marking registry "done" — which
    // is what the real spawn() exit handler does. Update status so the
    // escalation timer skips.
    await registry.update("cooperative-agent", { status: "done" });

    await new Promise((r) => setTimeout(r, AgentSpawner.KILL_GRACE_MS + 200));

    check(
      "no SIGKILL escalation when agent status moved off 'running'",
      !escalationHappened,
    );
  } finally {
    AgentSpawner.KILL_GRACE_MS = originalGrace;
    console.warn = origWarn;
    try { Deno.kill(proc.pid, "SIGKILL"); } catch { /* already dead */ }
    await bus.close();
  }
}

// ── Test 3: killAgent is a no-op on an unknown agent ──

console.log(
  "\nkillAgent returns false for unknown agent (regression shield):",
);
{
  const bus = new SignalBus();
  const spawner = new AgentSpawner(bus);
  const killed = await spawner.killAgent("no-such-agent", "test");
  check("returned false for unknown agent", killed === false);
  await bus.close();
}

// ── Summary ────────────────────────────────────────────────────

// Silence the stagger const ref warning.
void DEFAULT_KILL_STAGGER_MS;

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const name of failures) console.log(`  - ${name}`);
  Deno.exit(1);
}
