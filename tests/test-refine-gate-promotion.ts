/**
 * Unit tests for gate promotion — `findPromotionCandidates` (pure function,
 * heavy coverage) + end-to-end behavior through a real snapshot archive
 * (smoke test for addGate/removeGate side effects).
 *
 * Promotion contract:
 *   - (name, command) is the tuple — two variants with same name but
 *     different commands do NOT count as consensus.
 *   - Root (baseline) variant is excluded from the count — it's the target.
 *   - Root variant already having the exact tuple means no promotion needed.
 *   - Threshold 0 disables entirely.
 *   - Threshold 1 means "any single non-root attachment promotes" — useful
 *     for testing, not usually for production.
 *
 * Run:  deno run --allow-all tests/test-refine-gate-promotion.ts
 */

import { join } from "https://deno.land/std/path/mod.ts";
import { addGate, collectGates, init, snapshot } from "@snapshot/core";
import type { Variant } from "@snapshot/core";
import { findPromotionCandidates } from "../src/refine.ts";

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
  const dir = await Deno.makeTempDir({ prefix: "expo-gate-promote-" });
  await Deno.writeTextFile(join(dir, "README.md"), "# test\n");
  return dir;
}

async function cleanup(dir: string): Promise<void> {
  await Deno.remove(dir, { recursive: true }).catch(() => {});
}

/** Build an in-memory variant list without touching disk — pure tests are
 *  10x faster and clearer about what they exercise. */
function v(
  id: string,
  status: "baseline" | "kept" | "discarded",
  gates: Array<{ name: string; command: string; rationale?: string; addedBy?: string }> = [],
): Variant {
  return {
    id,
    parent: id === "000" ? null : "000",
    status,
    change: "test",
    summary: "test",
    timestamp: new Date().toISOString(),
    gates: gates.map((g) => ({
      name: g.name,
      command: g.command,
      rationale: g.rationale,
      addedBy: g.addedBy ?? id,
      addedAt: new Date().toISOString(),
    })),
  };
}

// ── Test 1: no gates → no candidates ───────────────────────────

console.log("\nfindPromotionCandidates — empty archive:");
{
  check("empty variant list → no candidates", findPromotionCandidates([], 3).length === 0);
  check("one variant, no gates → no candidates", findPromotionCandidates([v("000", "baseline")], 3).length === 0);
}

// ── Test 2: below threshold ────────────────────────────────────

console.log("\nfindPromotionCandidates — below threshold:");
{
  const variants = [
    v("000", "baseline"),
    v("001", "kept", [{ name: "tests", command: "deno test" }]),
    v("002", "kept", [{ name: "tests", command: "deno test" }]),
  ];
  const candidates = findPromotionCandidates(variants, 3);
  check("2 attachments < threshold 3", candidates.length === 0);
}

// ── Test 3: exactly at threshold ───────────────────────────────

console.log("\nfindPromotionCandidates — at threshold:");
{
  const variants = [
    v("000", "baseline"),
    v("001", "kept", [{ name: "tests", command: "deno test" }]),
    v("002", "kept", [{ name: "tests", command: "deno test" }]),
    v("003", "kept", [{ name: "tests", command: "deno test" }]),
  ];
  const candidates = findPromotionCandidates(variants, 3);
  check("3 attachments == threshold 3 → promote", candidates.length === 1);
  check("attachedOn has 3 variants", candidates[0]?.attachedOn.length === 3);
  check("name correct", candidates[0]?.name === "tests");
  check("command correct", candidates[0]?.command === "deno test");
}

// ── Test 4: threshold 0 disables entirely ──────────────────────

console.log("\nfindPromotionCandidates — threshold 0 disables:");
{
  const variants = [
    v("000", "baseline"),
    v("001", "kept", [{ name: "tests", command: "deno test" }]),
    v("002", "kept", [{ name: "tests", command: "deno test" }]),
    v("003", "kept", [{ name: "tests", command: "deno test" }]),
  ];
  check("threshold 0 → never promote", findPromotionCandidates(variants, 0).length === 0);
}

// ── Test 5: root variant with existing gate excludes the tuple ─

console.log("\nfindPromotionCandidates — root already has gate:");
{
  const variants = [
    v("000", "baseline", [{ name: "tests", command: "deno test" }]),
    v("001", "kept", [{ name: "tests", command: "deno test" }]),
    v("002", "kept", [{ name: "tests", command: "deno test" }]),
    v("003", "kept", [{ name: "tests", command: "deno test" }]),
  ];
  check("root has exact tuple → skip promotion", findPromotionCandidates(variants, 3).length === 0);
}

// ── Test 6: root has same-named but different-command gate ─────

console.log("\nfindPromotionCandidates — root has different command:");
{
  const variants = [
    v("000", "baseline", [{ name: "tests", command: "old test cmd" }]),
    v("001", "kept", [{ name: "tests", command: "deno test" }]),
    v("002", "kept", [{ name: "tests", command: "deno test" }]),
    v("003", "kept", [{ name: "tests", command: "deno test" }]),
  ];
  // Root has "tests" but different command — the descendants' tuple IS
  // distinct, so promotion should still trigger. The existing gate at root
  // would be shadowed by the inheritance (collectGates dedupes by name,
  // child wins) — but that's a separate post-promotion cleanup concern.
  const candidates = findPromotionCandidates(variants, 3);
  check("different root command doesn't block", candidates.length === 1);
  check("new tuple flagged", candidates[0]?.command === "deno test");
}

// ── Test 7: two different tuples same name don't combine ───────

console.log("\nfindPromotionCandidates — same name, different commands, DON'T combine:");
{
  const variants = [
    v("000", "baseline"),
    v("001", "kept", [{ name: "tests", command: "deno test" }]),
    v("002", "kept", [{ name: "tests", command: "npm test" }]),
    v("003", "kept", [{ name: "tests", command: "pytest" }]),
  ];
  // All three have "tests" but different commands — NO consensus.
  check("different commands never consensus", findPromotionCandidates(variants, 3).length === 0);
}

// ── Test 8: multiple tuples can promote simultaneously ─────────

console.log("\nfindPromotionCandidates — multiple promotions at once:");
{
  const variants = [
    v("000", "baseline"),
    v("001", "kept", [
      { name: "tests", command: "deno test" },
      { name: "lint", command: "deno lint" },
    ]),
    v("002", "kept", [
      { name: "tests", command: "deno test" },
      { name: "lint", command: "deno lint" },
    ]),
    v("003", "kept", [
      { name: "tests", command: "deno test" },
      { name: "lint", command: "deno lint" },
    ]),
  ];
  const candidates = findPromotionCandidates(variants, 3);
  check("both gates promoted", candidates.length === 2);
  const names = candidates.map((c) => c.name).sort();
  check("both names captured", JSON.stringify(names) === '["lint","tests"]');
}

// ── Test 9: rationale preserved from first variant with one ────

console.log("\nfindPromotionCandidates — rationale preserved:");
{
  const variants = [
    v("000", "baseline"),
    v("001", "kept", [{ name: "tests", command: "deno test" }]), // no rationale
    v("002", "kept", [{ name: "tests", command: "deno test", rationale: "regression hot spot" }]),
    v("003", "kept", [{ name: "tests", command: "deno test", rationale: "different reason" }]),
  ];
  const candidates = findPromotionCandidates(variants, 3);
  check("one candidate", candidates.length === 1);
  check("rationale from first variant that had one", candidates[0]?.representativeRationale === "regression hot spot");
}

// ── Test 10: discarded variants can count (they proposed the gate) ─

console.log("\nfindPromotionCandidates — discarded variants count:");
{
  // If an agent proposed a gate that got auto-promoted or the variant
  // was accepted then later discarded for other reasons, the proposal
  // signal is still evidence of the pattern. We count all non-root.
  const variants = [
    v("000", "baseline"),
    v("001", "discarded", [{ name: "tests", command: "deno test" }]),
    v("002", "kept", [{ name: "tests", command: "deno test" }]),
    v("003", "kept", [{ name: "tests", command: "deno test" }]),
  ];
  const candidates = findPromotionCandidates(variants, 3);
  check("discarded counts as independent attachment", candidates.length === 1);
  check("attachedOn includes discarded variant", candidates[0]?.attachedOn.includes("001"));
}

// ── Test 11: end-to-end — build an archive, trigger promotion ──

console.log("\nfindPromotionCandidates — live archive round-trip:");
{
  const dir = await makeDir();
  try {
    await init(dir);
    await snapshot(dir, { change: "root", summary: "baseline" });
    const v1 = await snapshot(dir, { change: "iter 1", summary: "first" });
    await addGate(dir, v1.id, { name: "tests", command: "deno test" });
    const v2 = await snapshot(dir, { change: "iter 2", summary: "second" });
    await addGate(dir, v2.id, { name: "tests", command: "deno test" });
    const v3 = await snapshot(dir, { change: "iter 3", summary: "third" });
    await addGate(dir, v3.id, { name: "tests", command: "deno test" });

    // Re-read from disk — tests the full persistence path
    const { list } = await import("@snapshot/core");
    const variants = await list(dir);
    const candidates = findPromotionCandidates(variants, 3);
    check("3 descendants → 1 promotion candidate", candidates.length === 1);
    check("candidate's attachedOn correct", candidates[0]?.attachedOn.length === 3);

    // And collectGates from each child shows the gate (currently direct)
    const inherited = await collectGates(dir, v3.id);
    const testsGate = inherited.find((g) => g.name === "tests");
    check("gate currently visible via inheritance chain", testsGate !== undefined);
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
