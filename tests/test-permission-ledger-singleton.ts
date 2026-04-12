/**
 * Regression test for the permission-ledger race condition.
 *
 * The web dashboard previously did `new PermissionLedger() → load → mutate →
 * save` for every approve/reject request. Two concurrent requests would each
 * load the same on-disk state, each mutate their own copy, then each save —
 * the later save clobbers whichever mutation landed first.
 *
 * This test locks in:
 *   1. `getPermissionLedger()` returns the same instance across calls.
 *   2. Concurrent `mutatePermissionLedger()` calls all persist — no lost
 *      writes, regardless of mutation type (approve / reject / mixed).
 *   3. The pre-fix pattern (`new PermissionLedger()` per caller) actually
 *      loses writes — a negative control so a regression in the fix can't
 *      pass by accident.
 *   4. Errors in one mutation don't poison the chain for subsequent ones.
 *
 * Run:  deno run --allow-all tests/test-permission-ledger-singleton.ts
 */

import {
  getPermissionLedger,
  mutatePermissionLedger,
  PermissionLedger,
  resetPermissionLedgerSingleton,
} from "../src/permission-ledger.ts";

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

async function readFromDisk(filePath: string): Promise<PermissionLedger> {
  const l = new PermissionLedger({ filePath });
  await l.load();
  return l;
}

console.log("\ngetPermissionLedger — singleton identity:");
{
  const tmpDir = await Deno.makeTempDir({ prefix: "expo-ledger-singleton-" });
  const filePath = `${tmpDir}/permissions.json`;

  resetPermissionLedgerSingleton();
  const a = getPermissionLedger({ filePath });
  const b = getPermissionLedger({ filePath });
  const c = getPermissionLedger(); // no opts — still same instance
  check("two calls return the same instance", a === b);
  check("third call (no opts) still returns the same instance", a === c);

  resetPermissionLedgerSingleton();
  const d = getPermissionLedger({ filePath });
  check("reset → next call constructs a fresh instance", d !== a);

  await Deno.remove(tmpDir, { recursive: true });
}

console.log("\nmutatePermissionLedger — concurrent approves all persist:");
{
  const tmpDir = await Deno.makeTempDir({ prefix: "expo-ledger-singleton-" });
  const filePath = `${tmpDir}/permissions.json`;

  resetPermissionLedgerSingleton();
  // Seed the singleton so every subsequent mutate() resolves to the same file.
  getPermissionLedger({ filePath });

  const patterns = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
  const promises = patterns.map((p) =>
    mutatePermissionLedger((l) => {
      l.approve(p);
    })
  );
  const results = await Promise.all(promises);
  check("all mutations resolved", results.length === 10);

  const onDisk = await readFromDisk(filePath);
  const approved = onDisk.getAll()
    .filter((e) => e.status === "approved")
    .map((e) => e.pattern)
    .sort();
  check(
    "all 10 concurrent approves persisted to disk",
    approved.length === 10 && approved.join(",") === patterns.slice().sort().join(","),
    `got ${approved.length}: [${approved.join(", ")}]`,
  );

  await Deno.remove(tmpDir, { recursive: true });
}

console.log("\nmutatePermissionLedger — concurrent approve + reject interleaved:");
{
  const tmpDir = await Deno.makeTempDir({ prefix: "expo-ledger-singleton-" });
  const filePath = `${tmpDir}/permissions.json`;

  resetPermissionLedgerSingleton();
  getPermissionLedger({ filePath });

  const ops: Array<{ kind: "approve" | "reject"; pattern: string }> = [
    { kind: "approve", pattern: "tool-1" },
    { kind: "reject", pattern: "tool-2" },
    { kind: "approve", pattern: "tool-3" },
    { kind: "reject", pattern: "tool-4" },
    { kind: "approve", pattern: "tool-5" },
    { kind: "reject", pattern: "tool-6" },
    { kind: "approve", pattern: "tool-7" },
    { kind: "reject", pattern: "tool-8" },
  ];
  await Promise.all(ops.map((op) =>
    mutatePermissionLedger((l) => {
      if (op.kind === "approve") l.approve(op.pattern);
      else l.reject(op.pattern);
    })
  ));

  const onDisk = await readFromDisk(filePath);
  const all = onDisk.getAll();
  const approved = all.filter((e) => e.status === "approved").map((e) => e.pattern).sort();
  const rejected = all.filter((e) => e.status === "rejected").map((e) => e.pattern).sort();

  check(
    "all 4 approves persisted",
    approved.length === 4 && approved.join(",") === "tool-1,tool-3,tool-5,tool-7",
    `got [${approved.join(", ")}]`,
  );
  check(
    "all 4 rejects persisted",
    rejected.length === 4 && rejected.join(",") === "tool-2,tool-4,tool-6,tool-8",
    `got [${rejected.join(", ")}]`,
  );
  check("no duplicate entries", all.length === 8);

  await Deno.remove(tmpDir, { recursive: true });
}

console.log("\nmutatePermissionLedger — late-arriving mutation sees prior mutations' state:");
{
  const tmpDir = await Deno.makeTempDir({ prefix: "expo-ledger-singleton-" });
  const filePath = `${tmpDir}/permissions.json`;

  resetPermissionLedgerSingleton();
  getPermissionLedger({ filePath });

  // First approve, then reject the same pattern — last write should win and
  // be observable in-memory to the same mutation.
  let observedStatus: string | undefined;
  await mutatePermissionLedger((l) => { l.approve("X"); });
  await mutatePermissionLedger((l) => {
    l.reject("X");
    observedStatus = l.getAll().find((e) => e.pattern === "X")?.status;
  });

  check("mutation observes its own write", observedStatus === "rejected");

  const onDisk = await readFromDisk(filePath);
  const entry = onDisk.getAll().find((e) => e.pattern === "X");
  check("last write wins on disk", entry?.status === "rejected");

  await Deno.remove(tmpDir, { recursive: true });
}

console.log("\nmutatePermissionLedger — failed mutation does not poison the chain:");
{
  const tmpDir = await Deno.makeTempDir({ prefix: "expo-ledger-singleton-" });
  const filePath = `${tmpDir}/permissions.json`;

  resetPermissionLedgerSingleton();
  getPermissionLedger({ filePath });

  // Fire a throwing mutation and a succeeding one concurrently. The first
  // should reject, the second should still land cleanly.
  const thrower = mutatePermissionLedger((_l) => {
    throw new Error("boom");
  });
  const survivor = mutatePermissionLedger((l) => { l.approve("survivor"); });

  let threw = false;
  try {
    await thrower;
  } catch (err) {
    threw = err instanceof Error && err.message === "boom";
  }
  await survivor;

  check("thrown error propagates to caller", threw);

  const onDisk = await readFromDisk(filePath);
  const approved = onDisk.getAll().filter((e) => e.status === "approved").map((e) => e.pattern);
  check(
    "subsequent mutation still landed despite prior failure",
    approved.length === 1 && approved[0] === "survivor",
    `got [${approved.join(", ")}]`,
  );

  await Deno.remove(tmpDir, { recursive: true });
}

console.log("\npre-fix pattern (new PermissionLedger per caller) — negative control:");
{
  const tmpDir = await Deno.makeTempDir({ prefix: "expo-ledger-singleton-" });
  const filePath = `${tmpDir}/permissions.json`;

  // Simulate the old web.ts pattern: N concurrent load→mutate→save cycles
  // on independent instances. This is the bug the fix addresses; the test
  // below documents it so nobody accidentally reintroduces the pattern.
  const N = 20;
  const patterns = Array.from({ length: N }, (_, i) => `old-${i}`);
  await Promise.all(patterns.map(async (p) => {
    const l = new PermissionLedger({ filePath });
    await l.load();
    l.approve(p);
    await l.save();
  }));

  const onDisk = await readFromDisk(filePath);
  const landed = onDisk.getAll().filter((e) => e.status === "approved").length;

  // We can't assert an exact number — it's a race — but we *can* assert
  // the fix is actually needed: at least some should have been lost.
  // If this ever stops losing writes on its own, the fix may still be
  // valuable (serialized = cheaper than optimistic races) but the bug
  // is no longer reproducible and this negative control is stale.
  check(
    `pre-fix pattern loses writes (landed ${landed}/${N}, expected < ${N})`,
    landed < N,
    landed === N ? "no writes lost — negative control no longer reproduces the race" : undefined,
  );

  await Deno.remove(tmpDir, { recursive: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  Deno.exit(1);
}
