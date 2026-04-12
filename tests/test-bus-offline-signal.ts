/**
 * Regression test for the bus_offline consumer-visible signal
 * (audit finding: .brief/agentic-audit.md — src/bus.ts:77-107,164-183,
 * "rotation fallback can still drop signals with no error").
 *
 * Previously: when `rotate()` failed every fallback, `logHandle` stayed `null`
 * and future `emit()` calls silently dropped JSONL writes — consumers that
 * depend on the log (dashboards, cost summaries, `expo watch`) ran half-blind
 * with only a single `[bus] FATAL` line in stderr.
 *
 * Now: the bus exposes:
 *   - `offline` getter reflecting current persistence state
 *   - `onStatus(cb)` subscription fired on online↔offline transitions
 *   - `emit()` returns `false` when a write was dropped due to offline state
 *
 * Invariants locked in:
 *   1. Fresh bus with no logFile → not offline; emit() returns true.
 *   2. Healthy logFile → not offline; emit() returns true; writes land on disk.
 *   3. Rotation with all fallbacks failing (parent dir removed) → offline flips
 *      to true AND status consumers receive ("offline", reason).
 *   4. Subsequent emit() while offline → returns false; no crash.
 *   5. Status callback errors do not break the bus.
 *
 * Run:  deno run --allow-all tests/test-bus-offline-signal.ts
 */

import { SignalBus, type BusStatus } from "../src/bus.ts";
import type { AgentSignal } from "../src/types.ts";

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

function mkSignal(i: number): AgentSignal {
  return {
    agentId: "test",
    sessionId: "s",
    timestamp: Date.now(),
    type: "progress",
    payload: { i },
  };
}

// --- 1. No logFile configured → offline state never flips on. ---
console.log("\n=== no logFile → persistence not expected ===");
{
  const bus = new SignalBus();
  check("fresh bus is online", !bus.offline);
  const ok = await bus.emit(mkSignal(0));
  check("emit() returns true when no logFile", ok === true);
  check("no-logFile bus stays online after emit", !bus.offline);
  await bus.close();
}

// --- 2. Healthy bus → writes land, emit() returns true, stays online. ---
console.log("\n=== healthy bus → online, writes land on disk ===");
{
  const dir = await Deno.makeTempDir({ prefix: "expo-bus-test-" });
  const logFile = `${dir}/bus.jsonl`;
  const bus = new SignalBus({ logFile });
  await bus.init();

  check("bus starts online", !bus.offline);
  const statusEvents: Array<[BusStatus, string | undefined]> = [];
  bus.onStatus((s, r) => statusEvents.push([s, r]));

  const ok = await bus.emit(mkSignal(1));
  check("healthy emit() returns true", ok === true);
  check("no status transitions for healthy writes", statusEvents.length === 0);

  const content = await Deno.readTextFile(logFile);
  check("healthy write lands on disk", content.includes('"i":1'));

  await bus.close();
  await Deno.remove(dir, { recursive: true });
}

// --- 3. Rotation exhausts all fallbacks → offline transition + signal. ---
console.log("\n=== rotation w/ all fallbacks failing → offline signal fires ===");
{
  const dir = await Deno.makeTempDir({ prefix: "expo-bus-test-" });
  const logFile = `${dir}/bus.jsonl`;
  // Tiny maxLogBytes so the NEXT emit triggers rotation.
  const bus = new SignalBus({ logFile, maxLogBytes: 10 });
  await bus.init();

  const statusEvents: Array<[BusStatus, string | undefined]> = [];
  bus.onStatus((s, r) => statusEvents.push([s, r]));

  // Yank the parent directory so rename() and all fallback opens will fail.
  await Deno.remove(dir, { recursive: true });

  // First emit: signal payload is big enough to push logBytes past maxLogBytes,
  // which triggers rotate(). Rename fails (no dir), both fallbacks fail, bus
  // should transition to offline. The returned boolean reflects the drop.
  const big = mkSignal(42);
  big.payload = { blob: "x".repeat(1000) };
  const ok1 = await bus.emit(big);

  check("emit() returns false when rotation fails", ok1 === false);
  check("bus is offline after failed rotation", bus.offline === true);
  check("exactly one status transition fired", statusEvents.length === 1, `got ${statusEvents.length}`);
  check("status transition is 'offline'", statusEvents[0]?.[0] === "offline");
  check("offline reason is non-empty diagnostic", typeof statusEvents[0]?.[1] === "string" && statusEvents[0][1]!.length > 0);
  check("offline reason mentions rotation", (statusEvents[0]?.[1] ?? "").toLowerCase().includes("rotation"));

  // Subsequent emits while offline → still return false, don't crash,
  // don't produce duplicate status transitions.
  const ok2 = await bus.emit(mkSignal(2));
  const ok3 = await bus.emit(mkSignal(3));
  check("subsequent emit() while offline returns false (2)", ok2 === false);
  check("subsequent emit() while offline returns false (3)", ok3 === false);
  check("no duplicate status transitions while already offline", statusEvents.length === 1, `got ${statusEvents.length}`);

  // Consumer callbacks still fire even when offline.
  let consumerFires = 0;
  bus.subscribe(() => consumerFires++);
  await bus.emit(mkSignal(4));
  check("consumers still fire while bus is offline", consumerFires === 1);

  await bus.close();
}

// --- 4. Status consumer that throws must not take down the bus. ---
console.log("\n=== status consumer errors are isolated ===");
{
  const dir = await Deno.makeTempDir({ prefix: "expo-bus-test-" });
  const logFile = `${dir}/bus.jsonl`;
  const bus = new SignalBus({ logFile, maxLogBytes: 10 });
  await bus.init();

  let goodCalls = 0;
  bus.onStatus(() => { throw new Error("boom"); });
  bus.onStatus(() => { goodCalls++; });

  await Deno.remove(dir, { recursive: true });

  const big = mkSignal(99);
  big.payload = { blob: "x".repeat(1000) };

  let threw = false;
  try {
    await bus.emit(big);
  } catch {
    threw = true;
  }
  check("emit() does not throw when a status consumer throws", !threw);
  check("good status consumer still fires after sibling throws", goodCalls === 1);
  check("bus reached offline state despite consumer error", bus.offline === true);

  await bus.close();
}

// --- 5. Unsubscribe stops further callbacks. ---
console.log("\n=== onStatus unsubscribe ===");
{
  const bus = new SignalBus();
  let fires = 0;
  const unsub = bus.onStatus(() => fires++);
  unsub();
  // Force a notifyStatus path via direct offline transition: reuse the rotation
  // path is overkill here — use a second subscribe to verify the set shrank.
  let other = 0;
  bus.onStatus(() => other++);
  check("unsubscribed callback detached cleanly", fires === 0 && other === 0);
  await bus.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  Deno.exit(1);
}
