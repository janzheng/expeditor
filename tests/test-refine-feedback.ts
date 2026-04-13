/**
 * Unit tests for the gate-failure feedback loop + REFINE.md heuristics parser.
 *
 * Covers the two new agentic-UX primitives:
 *   1. `buildRefinePrompt` renders a "Do NOT repeat these" section when the
 *      caller passes recentFailures — and omits it cleanly when not.
 *   2. `loadRefineHeuristics` parses `## Heading` sections, preserves raw,
 *      handles missing-file and empty-file paths without throwing.
 *
 * Run:  deno run --allow-all tests/test-refine-feedback.ts
 */

import { join } from "https://deno.land/std/path/mod.ts";
import {
  buildRefinePrompt,
  loadRefineHeuristics,
  type RecentFailure,
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

async function makeTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "expo-refine-feedback-" });
}

async function cleanup(dir: string): Promise<void> {
  await Deno.remove(dir, { recursive: true }).catch(() => {});
}

// ── Test 1: empty recentFailures → no feedback section rendered ─

console.log("\nbuildRefinePrompt — no recentFailures:");
{
  const prompt = buildRefinePrompt({
    rubric: "be clear",
    heuristics: "",
    archiveContext: "",
    iteration: 1,
    maxIterations: 5,
    dir: "/tmp/demo",
    inheritedGates: [],
    allowAgentGates: false,
  });
  check("no 'Do NOT repeat' header", !prompt.includes("Do NOT repeat"));
  check("no 'recently-failed' phrasing", !prompt.includes("recently-failed"));
}

// ── Test 2: recentFailures renders Do-NOT-repeat section ────────

console.log("\nbuildRefinePrompt — one recent failure:");
{
  const recentFailures: RecentFailure[] = [
    {
      iteration: 2,
      change: "refactored the router to use a switch",
      gateName: "auth_tests",
      reason: "exit 1",
    },
  ];
  const prompt = buildRefinePrompt({
    rubric: "be clear",
    heuristics: "",
    archiveContext: "",
    iteration: 3,
    maxIterations: 5,
    dir: "/tmp/demo",
    inheritedGates: [],
    allowAgentGates: false,
    recentFailures,
  });
  check("header present", prompt.includes("Do NOT repeat these recently-failed approaches"));
  check("failure entry rendered", prompt.includes("refactored the router to use a switch"));
  check("gate name rendered", prompt.includes("auth_tests"));
  check("reason rendered", prompt.includes("exit 1"));
  check("iteration number rendered", prompt.includes("iter 2"));
}

// ── Test 3: multiple failures + timeout reason format ──────────

console.log("\nbuildRefinePrompt — multiple failures incl. timeout:");
{
  const recentFailures: RecentFailure[] = [
    { iteration: 1, change: "change A", gateName: "tests", reason: "exit 2" },
    { iteration: 2, change: "change B", gateName: "lint", reason: "exit 1" },
    { iteration: 3, change: "change C", gateName: "typecheck", reason: "timeout" },
  ];
  const prompt = buildRefinePrompt({
    rubric: "be clear",
    heuristics: "",
    archiveContext: "",
    iteration: 4,
    maxIterations: 5,
    dir: "/tmp/demo",
    inheritedGates: [],
    allowAgentGates: false,
    recentFailures,
  });
  check("all three changes rendered", prompt.includes("change A") && prompt.includes("change B") && prompt.includes("change C"));
  check("all three gates named", prompt.includes("tests") && prompt.includes("lint") && prompt.includes("typecheck"));
  check("timeout reason preserved verbatim", prompt.includes("timeout"));
  // Order should be insertion order — iter 1 before iter 2 before iter 3
  const iter1 = prompt.indexOf("iter 1:");
  const iter3 = prompt.indexOf("iter 3:");
  check("rendered in insertion order", iter1 >= 0 && iter3 > iter1);
}

// ── Test 4: loadRefineHeuristics on missing file ───────────────

console.log("\nloadRefineHeuristics — missing REFINE.md:");
{
  const dir = await makeTempDir();
  try {
    const h = await loadRefineHeuristics(dir);
    check("exists=false", h.exists === false);
    check("raw empty", h.raw === "");
    check("lineCount=0", h.lineCount === 0);
    check("sectionOrder empty", h.sectionOrder.length === 0);
    check("sections empty", Object.keys(h.sections).length === 0);
    check("path still reported", h.path.endsWith("REFINE.md"));
  } finally {
    await cleanup(dir);
  }
}

// ── Test 5: loadRefineHeuristics on populated file ─────────────

console.log("\nloadRefineHeuristics — parses ## sections:");
{
  const dir = await makeTempDir();
  try {
    const content = `# Title
## Heuristics
- Always X
- Never Y

## Session 1
Iteration count: 4.
Change: split the parser.

## Next session
Try the AST rewrite.
`;
    await Deno.writeTextFile(join(dir, "REFINE.md"), content);
    const h = await loadRefineHeuristics(dir);
    check("exists=true", h.exists === true);
    check("raw preserved verbatim", h.raw === content);
    check("three named sections", h.sectionOrder.filter((s) => s !== "_preamble").length === 3);
    check("preamble captured", (h.sections._preamble ?? "").includes("# Title"));
    check("Heuristics body present", (h.sections["Heuristics"] ?? "").includes("Always X"));
    check("Session 1 body present", (h.sections["Session 1"] ?? "").includes("Iteration count"));
    check("Next session body present", (h.sections["Next session"] ?? "").includes("AST rewrite"));
    check("section order matches file", h.sectionOrder.indexOf("Heuristics") < h.sectionOrder.indexOf("Session 1"));
  } finally {
    await cleanup(dir);
  }
}

// ── Test 6: loadRefineHeuristics on empty file ─────────────────

console.log("\nloadRefineHeuristics — empty REFINE.md:");
{
  const dir = await makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, "REFINE.md"), "");
    const h = await loadRefineHeuristics(dir);
    check("exists=true", h.exists === true);
    check("raw empty string", h.raw === "");
    check("no sections", h.sectionOrder.length === 0);
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
