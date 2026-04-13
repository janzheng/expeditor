/**
 * Unit tests for ConcurrencyLimit — the semaphore that bounds fan-out
 * width across race/workflow/mxit/spawn-all.
 *
 * Run:  deno run --allow-all tests/test-concurrency.ts
 */

import { ConcurrencyLimit, DEFAULT_MAX_CONCURRENT } from "../src/concurrency.ts";

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

/** Resolve after `ms` ms. Used to simulate slow agent work. */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

console.log("\nconstructor:");
{
  const ok = new ConcurrencyLimit(5);
  check("accepts positive integer", ok.max === 5);

  const fractional = new ConcurrencyLimit(3.7);
  check("floors fractional", fractional.max === 3);

  let threw = false;
  try { new ConcurrencyLimit(0); } catch { threw = true; }
  check("rejects max=0", threw);

  threw = false;
  try { new ConcurrencyLimit(-1); } catch { threw = true; }
  check("rejects negative", threw);

  threw = false;
  try { new ConcurrencyLimit(NaN); } catch { threw = true; }
  check("rejects NaN", threw);

  threw = false;
  try { new ConcurrencyLimit(Infinity); } catch { threw = true; }
  check("rejects Infinity", threw);
}

console.log("\ndefault:");
{
  check("DEFAULT_MAX_CONCURRENT is a reasonable small integer", DEFAULT_MAX_CONCURRENT === 5);
}

console.log("\nrun — single task:");
{
  const limit = new ConcurrencyLimit(3);
  const result = await limit.run(() => Promise.resolve(42));
  check("returns fn's result", result === 42);
  check("running back to 0 after", limit.running === 0);
  check("queue empty", limit.queued === 0);
}

console.log("\nrun — under limit (all concurrent):");
{
  const limit = new ConcurrencyLimit(5);
  const started: number[] = [];
  const tasks = Array.from({ length: 3 }, (_, i) =>
    limit.run(async () => {
      started.push(i);
      await sleep(20);
      return i;
    }),
  );
  // Yield twice to let all three acquire their slots before awaiting
  await sleep(0);
  await sleep(0);
  check("all 3 started immediately", started.length === 3);
  check("running = 3", limit.running === 3);
  const results = await Promise.all(tasks);
  check("all completed", results.join(",") === "0,1,2");
  check("running back to 0", limit.running === 0);
}

console.log("\nrun — over limit (waits for slots):");
{
  const limit = new ConcurrencyLimit(2);
  const started: number[] = [];
  const tasks = Array.from({ length: 5 }, (_, i) =>
    limit.run(async () => {
      started.push(i);
      await sleep(30);
      return i;
    }),
  );
  await sleep(5);
  check("only 2 started initially", started.length === 2, `got ${started.length}`);
  check("running = 2", limit.running === 2);
  check("3 queued", limit.queued === 3);

  await sleep(35); // first batch finishes
  check("next 2 started after first batch", started.length === 4, `got ${started.length}`);

  const results = await Promise.all(tasks);
  check("all 5 completed in order started", results.join(",") === "0,1,2,3,4");
  check("final running = 0", limit.running === 0);
  check("final queue empty", limit.queued === 0);
}

console.log("\nrun — FIFO order:");
{
  const limit = new ConcurrencyLimit(1);
  const order: number[] = [];
  const tasks = [10, 20, 30, 40, 50].map((i) =>
    limit.run(async () => {
      order.push(i);
      await sleep(5);
    }),
  );
  await Promise.all(tasks);
  check("tasks ran in submission order", order.join(",") === "10,20,30,40,50");
}

console.log("\nrun — slot released on throw:");
{
  const limit = new ConcurrencyLimit(1);
  let threw = false;
  try {
    await limit.run(async () => { throw new Error("boom"); });
  } catch (err) {
    threw = true;
    check("exception propagates to caller", String(err).includes("boom"));
  }
  check("throw path reached", threw);
  check("running released after throw", limit.running === 0);
  // Verify the limit still works after a throw — a leaked slot would
  // cause this next task to hang forever.
  const okResult = await limit.run(() => Promise.resolve("ok"));
  check("next task still runs after prior throw", okResult === "ok");
}

console.log("\nrun — mixed success and throw:");
{
  const limit = new ConcurrencyLimit(2);
  const tasks = [
    limit.run(async () => { await sleep(10); return "a"; }),
    limit.run(async () => { await sleep(10); throw new Error("b-failed"); }),
    limit.run(async () => { await sleep(10); return "c"; }),
    limit.run(async () => { await sleep(10); return "d"; }),
  ];
  const results = await Promise.allSettled(tasks);
  check("a fulfilled", results[0].status === "fulfilled" && results[0].value === "a");
  check("b rejected", results[1].status === "rejected");
  check("c fulfilled (waited for slot b released)", results[2].status === "fulfilled" && results[2].value === "c");
  check("d fulfilled", results[3].status === "fulfilled" && results[3].value === "d");
  check("running = 0 after all done", limit.running === 0);
}

console.log("\nrun — stress test (100 tasks, limit 5):");
{
  const limit = new ConcurrencyLimit(5);
  const runningObservations: number[] = [];
  const tasks = Array.from({ length: 100 }, (_, i) =>
    limit.run(async () => {
      runningObservations.push(limit.running);
      await sleep(1 + Math.floor(Math.random() * 3));
      return i;
    }),
  );
  const results = await Promise.all(tasks);
  check("all 100 completed", results.length === 100);
  check("results in submission order", results.every((v, i) => v === i));
  // Some observations will be <5 at startup, but none should exceed max.
  const maxObserved = Math.max(...runningObservations);
  check(`never exceeded max (saw max ${maxObserved})`, maxObserved <= 5);
  check("final running = 0", limit.running === 0);
  check("final queue empty", limit.queued === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  Deno.exit(1);
}
