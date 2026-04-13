/**
 * Smoke tests for `--format json` / `--json` on the three read-verbs:
 *   - expo refine <dir> --status --json
 *   - expo refine <dir> --tree --json
 *   - expo refine <dir> gate list [variantId] --json
 *
 * The CLI wrappers delegate to showRefineStatus / showRefineTree /
 * showRefineGates with `{json: true}`. We exercise those library entry
 * points directly so the tests stay fast and don't spawn subprocesses.
 *
 * Contract:
 *   - JSON mode emits exactly ONE JSON object on stdout
 *   - Structure matches what orchestrators need to parse programmatically
 *   - Empty / missing-archive paths still return valid JSON (no throw)
 *
 * Run:  deno run --allow-all tests/test-refine-json-output.ts
 */

import { join } from "https://deno.land/std/path/mod.ts";
import { addGate, init, snapshot } from "@snapshot/core";
import {
  showRefineGates,
  showRefineStatus,
  showRefineTree,
} from "../src/refine.ts";

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
  const dir = await Deno.makeTempDir({ prefix: "expo-json-output-" });
  await Deno.writeTextFile(join(dir, "README.md"), "# test\n");
  return dir;
}

async function cleanup(dir: string): Promise<void> {
  await Deno.remove(dir, { recursive: true }).catch(() => {});
}

/** Capture console.log output so we can assert on JSON shape. */
function captureStdout(fn: () => Promise<void>): Promise<string> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" "));
    };
    fn().then(() => {
      console.log = original;
      resolve(lines.join("\n"));
    }).catch((err) => {
      console.log = original;
      reject(err);
    });
  });
}

// ── Test 1: showRefineStatus --json on a populated archive ─────

console.log("\nshowRefineStatus --json — populated archive:");
{
  const dir = await makeDir();
  try {
    await init(dir);
    await snapshot(dir, { change: "baseline", summary: "first" });
    await snapshot(dir, { change: "second edit", summary: "iter 2" });

    const out = await captureStdout(async () => {
      await showRefineStatus(dir, { json: true });
    });

    const parsed = JSON.parse(out);
    check("emits valid JSON", typeof parsed === "object");
    check("dir field matches", parsed.dir === dir);
    check("totalVariants=2", parsed.totalVariants === 2);
    check("kept=2", parsed.kept === 2);
    check("discarded=0", parsed.discarded === 0);
    check("current points at last variant", parsed.current?.id === "001");
    check("refineMdExists=false (not yet created)", parsed.refineMdExists === false);
  } finally {
    await cleanup(dir);
  }
}

// ── Test 2: showRefineStatus --json on empty archive ────────────

console.log("\nshowRefineStatus --json — empty archive:");
{
  const dir = await makeDir();
  try {
    await init(dir);
    // no snapshots

    const out = await captureStdout(async () => {
      await showRefineStatus(dir, { json: true });
    });

    const parsed = JSON.parse(out);
    check("totalVariants=0", parsed.totalVariants === 0);
    check("kept=0", parsed.kept === 0);
    check("current=null", parsed.current === null);
  } finally {
    await cleanup(dir);
  }
}

// ── Test 3: showRefineTree --json emits variants array ────────

console.log("\nshowRefineTree --json — variants array:");
{
  const dir = await makeDir();
  try {
    await init(dir);
    const v1 = await snapshot(dir, { change: "baseline", summary: "first" });
    await addGate(dir, v1.id, { name: "tests", command: "deno test", rationale: "important" });
    await snapshot(dir, { change: "child edit", summary: "iter 2" });

    const out = await captureStdout(async () => {
      await showRefineTree(dir, { json: true });
    });

    const parsed = JSON.parse(out);
    check("variants array present", Array.isArray(parsed.variants));
    check("two variants", parsed.variants.length === 2);
    check("first is baseline", parsed.variants[0]?.status === "baseline");
    check("second parents off first", parsed.variants[1]?.parent === "000");
    check("gates array per variant", Array.isArray(parsed.variants[0]?.gates));
    check("first variant has the tests gate", parsed.variants[0]?.gates[0]?.name === "tests");
    check("second variant has no direct gate", parsed.variants[1]?.gates.length === 0);
  } finally {
    await cleanup(dir);
  }
}

// ── Test 4: showRefineGates --json without variantId ───────────

console.log("\nshowRefineGates --json — whole-archive view:");
{
  const dir = await makeDir();
  try {
    await init(dir);
    const v1 = await snapshot(dir, { change: "baseline", summary: "first" });
    await addGate(dir, v1.id, { name: "tests", command: "deno test" });
    await addGate(dir, v1.id, { name: "lint", command: "deno lint" });
    const v2 = await snapshot(dir, { change: "iter 2", summary: "edit" });
    await addGate(dir, v2.id, { name: "typecheck", command: "deno check" });

    const out = await captureStdout(async () => {
      await showRefineGates(dir, undefined, { json: true });
    });

    const parsed = JSON.parse(out);
    check("totalGates=3", parsed.totalGates === 3);
    check("totalVariants=2", parsed.totalVariants === 2);
    check("byVariant has 2 entries", parsed.byVariant.length === 2);
    check("v1 has 2 gates", parsed.byVariant[0]?.gates.length === 2);
    check("v2 has 1 gate", parsed.byVariant[1]?.gates.length === 1);
  } finally {
    await cleanup(dir);
  }
}

// ── Test 5: showRefineGates --json WITH variantId → inherited view ─

console.log("\nshowRefineGates --json — per-variant inherited view:");
{
  const dir = await makeDir();
  try {
    await init(dir);
    const v1 = await snapshot(dir, { change: "baseline", summary: "first" });
    await addGate(dir, v1.id, { name: "tests", command: "deno test" });
    const v2 = await snapshot(dir, { change: "iter 2", summary: "edit" });
    await addGate(dir, v2.id, { name: "lint", command: "deno lint" });

    const out = await captureStdout(async () => {
      await showRefineGates(dir, v2.id, { json: true });
    });

    const parsed = JSON.parse(out);
    check("variantId present", parsed.variantId === v2.id);
    check("two gates visible (1 inherited + 1 direct)", parsed.gates.length === 2);
    const sources = parsed.gates.map((g: { name: string; source: string }) => ({
      name: g.name,
      source: g.source,
    }));
    const sourceMap = new Map(sources.map((s: { name: string; source: string }) => [s.name, s.source]));
    check("tests is inherited", sourceMap.get("tests") === "inherited");
    check("lint is direct", sourceMap.get("lint") === "direct");
  } finally {
    await cleanup(dir);
  }
}

// ── Test 6: showRefineGates --json on empty archive ────────────

console.log("\nshowRefineGates --json — empty archive:");
{
  const dir = await makeDir();
  try {
    await init(dir);
    const out = await captureStdout(async () => {
      await showRefineGates(dir, undefined, { json: true });
    });
    const parsed = JSON.parse(out);
    check("totalGates=0", parsed.totalGates === 0);
    check("totalVariants=0", parsed.totalVariants === 0);
    check("byVariant empty", parsed.byVariant.length === 0);
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
