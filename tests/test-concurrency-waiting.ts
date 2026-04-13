/**
 * Unit tests for `ConcurrencyLimit.runWaiting` — the waiting-set variant
 * that prevents hierarchical starvation when a parent blocks on children
 * using the same semaphore.
 *
 * Core contract:
 *   1. Releases current slot for the duration of fn; re-acquires after.
 *   2. Solves the classic deadlock: max=2, two parents each awaiting a
 *      child on the SAME pool. Without runWaiting this deadlocks; with
 *      it, everyone finishes.
 *   3. Throws if called outside a run() (no slot to release).
 *   4. Slot re-acquired even if fn throws (parent's caller's run() can
 *      release cleanly).
 *   5. `running` counter stays consistent throughout.
 *
 * Run:  deno run --allow-all tests/test-concurrency-waiting.ts
 */

import { ConcurrencyLimit } from "../src/concurrency.ts";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Test 1: basic release/reacquire ────────────────────────────

console.log("\nrunWaiting — basic release/reacquire:");
{
  const limit = new ConcurrencyLimit(2);
  const events: string[] = [];

  await limit.run(async () => {
    events.push(`start running=${limit.running}`);
    await limit.runWaiting(async () => {
      events.push(`during waiting running=${limit.running}`);
    });
    events.push(`after running=${limit.running}`);
  });

  check("start had 1 running slot", events[0] === "start running=1");
  check("during: slot released (0 running)", events[1] === "during waiting running=0");
  check("after: slot reacquired (1 running)", events[2] === "after running=1");
  check("final running=0", limit.running === 0);
  check("final queued=0", limit.queued === 0);
}

// ── Test 2: deadlock prevention (the whole point) ──────────────

console.log("\nrunWaiting — solves max=2 hierarchical deadlock:");
{
  const limit = new ConcurrencyLimit(2);
  const log: string[] = [];

  const parent = async (name: string) => {
    await limit.run(async () => {
      log.push(`${name} parent start`);
      await limit.runWaiting(async () => {
        // This child needs a slot. Without runWaiting, both parents
        // would hold both slots and children would queue forever.
        await limit.run(async () => {
          log.push(`${name} child running`);
          await sleep(20);
        });
      });
      log.push(`${name} parent done`);
    });
  };

  // Both parents start simultaneously
  await Promise.all([parent("A"), parent("B")]);

  check("A parent started", log.includes("A parent start"));
  check("B parent started", log.includes("B parent start"));
  check("A child ran (no deadlock)", log.includes("A child running"));
  check("B child ran (no deadlock)", log.includes("B child running"));
  check("A parent completed", log.includes("A parent done"));
  check("B parent completed", log.includes("B parent done"));
  check("limit clean after test", limit.running === 0 && limit.queued === 0);
}

// ── Test 3: runWaiting outside a run throws ────────────────────

console.log("\nrunWaiting — throws when called without holding a slot:");
{
  const limit = new ConcurrencyLimit(2);
  let threw = false;
  let msg = "";
  try {
    await limit.runWaiting(async () => { /* no-op */ });
  } catch (err) {
    threw = true;
    msg = String(err instanceof Error ? err.message : err);
  }
  check("throws without holding a slot", threw);
  check("error mentions must be inside run()", msg.includes("without holding a slot"));
  check("counter unchanged after throw", limit.running === 0);
}

// ── Test 4: exception in fn still re-acquires slot ─────────────

console.log("\nrunWaiting — re-acquires slot even if fn throws:");
{
  const limit = new ConcurrencyLimit(2);
  const states: number[] = [];

  let caughtInParent = false;
  await limit.run(async () => {
    states.push(limit.running); // 1
    try {
      await limit.runWaiting(async () => {
        states.push(limit.running); // 0
        throw new Error("child boom");
      });
    } catch (err) {
      caughtInParent = String(err).includes("child boom");
    }
    states.push(limit.running); // should be 1 again
  });

  check("slot was 1 at start", states[0] === 1);
  check("slot was 0 during waiting", states[1] === 0);
  check("slot was 1 after throw (re-acquired)", states[2] === 1);
  check("exception propagated to caller", caughtInParent);
  check("final state clean", limit.running === 0 && limit.queued === 0);
}

// ── Test 5: queued parent resumes correctly ────────────────────

console.log("\nrunWaiting — returning parent respects FIFO queue:");
{
  const limit = new ConcurrencyLimit(1);
  const events: string[] = [];

  // Task 1: holds the one slot, calls runWaiting for a beat
  const t1 = (async () => {
    await limit.run(async () => {
      events.push("t1 start");
      await limit.runWaiting(async () => {
        // While we're waiting, give Task 2 a chance to grab the slot
        events.push(`t1 waiting (queued=${limit.queued})`);
        await sleep(30);
      });
      events.push("t1 resume");
    });
    events.push("t1 done");
  })();

  // Give t1 a microsecond head start, then Task 2 requests the slot
  await sleep(5);
  const t2 = (async () => {
    await limit.run(async () => {
      events.push("t2 start");
      await sleep(10);
    });
    events.push("t2 done");
  })();

  await Promise.all([t1, t2]);

  // Expected order: t1 start → t1 waiting → t2 runs (slot free) → t2 done
  //                 → t1 resume → t1 done
  check("t1 started first", events[0] === "t1 start");
  check("t1 entered waiting state", events[1].startsWith("t1 waiting"));
  check("t2 got the slot while t1 was waiting", events.indexOf("t2 start") < events.indexOf("t1 resume"));
  check("t2 completed first", events.indexOf("t2 done") < events.indexOf("t1 done"));
  check("both finished cleanly", events.includes("t1 done") && events.includes("t2 done"));
  check("final state clean", limit.running === 0 && limit.queued === 0);
}

// ── Test 6: nested runWaiting ──────────────────────────────────

console.log("\nrunWaiting — nested inside another runWaiting:");
{
  const limit = new ConcurrencyLimit(2);
  const depth: number[] = [];

  await limit.run(async () => {
    depth.push(limit.running); // 1
    await limit.runWaiting(async () => {
      depth.push(limit.running); // 0
      await limit.run(async () => {
        depth.push(limit.running); // 1
        await limit.runWaiting(async () => {
          depth.push(limit.running); // 0
        });
        depth.push(limit.running); // 1 again
      });
      depth.push(limit.running); // 0 again
    });
    depth.push(limit.running); // 1 again (parent re-acquired)
  });

  check("depth sequence matches 1,0,1,0,1,0,1", JSON.stringify(depth) === "[1,0,1,0,1,0,1]");
  check("final state clean", limit.running === 0 && limit.queued === 0);
}

// ── Test 7: returns fn's value ─────────────────────────────────

console.log("\nrunWaiting — returns fn's value:");
{
  const limit = new ConcurrencyLimit(1);
  let returned: number | undefined;

  await limit.run(async () => {
    returned = await limit.runWaiting(async () => 42);
  });

  check("value propagated through runWaiting", returned === 42);
}

// ── Summary ────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const name of failures) console.log(`  - ${name}`);
  Deno.exit(1);
}
