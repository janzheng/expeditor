/**
 * Unit tests for the fenced `<verdict>{JSON}</verdict>` grammar in parseVerdict.
 *
 * Contract the orchestrating agent depends on:
 *   - Fenced block is preferred over legacy line grammar when BOTH are present
 *   - Absent fenced block → line grammar still works (backwards compat)
 *   - Malformed JSON inside fence → fall back to line grammar, don't crash
 *   - Multiple fence blocks → last one wins (same as line parser convention)
 *   - gate_proposals in the fenced JSON parse correctly and validate shape
 *   - Unknown / missing action → falls back to line grammar
 *
 * Run:  deno run --allow-all tests/test-refine-fenced-verdict.ts
 */

import { parseVerdict } from "../src/refine.ts";

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

// ── Test 1: basic fenced verdict parses ────────────────────────

console.log("\nparseVerdict — fenced block basic:");
{
  const output = `
Here's my work.

<verdict>
{"action": "keep", "change": "split parser", "summary": "cleaner boundaries"}
</verdict>
`;
  const r = parseVerdict(output);
  check("action=keep", r.action === "keep");
  check("change captured", r.change === "split parser");
  check("summary captured", r.summary === "cleaner boundaries");
  check("gateProposals empty", r.gateProposals.length === 0);
}

// ── Test 2: fenced overrides legacy when both present ──────────

console.log("\nparseVerdict — fenced wins over line format:");
{
  const output = `
VERDICT: DISCARD
CHANGE: line-style would say this
SUMMARY: should be ignored

<verdict>
{"action": "keep", "change": "fenced wins", "summary": "json takes precedence"}
</verdict>
`;
  const r = parseVerdict(output);
  check("action from fenced (keep, not discard)", r.action === "keep");
  check("change from fenced", r.change === "fenced wins");
  check("summary from fenced", r.summary === "json takes precedence");
}

// ── Test 3: malformed fenced JSON falls back to line grammar ──

console.log("\nparseVerdict — malformed fenced falls back:");
{
  const output = `
<verdict>
this is not valid json at all { "nope": ,, }
</verdict>

VERDICT: CONVERGED
CHANGE: after fence fails, line grammar runs
SUMMARY: backwards-compat path works
`;
  const r = parseVerdict(output);
  check("action from line fallback", r.action === "converged");
  check("change from line fallback", r.change === "after fence fails, line grammar runs");
  check("summary from line fallback", r.summary === "backwards-compat path works");
}

// ── Test 4: missing action field → fallback ────────────────────

console.log("\nparseVerdict — fenced JSON missing action → fallback:");
{
  const output = `
<verdict>
{"change": "no action", "summary": "what even"}
</verdict>
VERDICT: KEEP
CHANGE: line says keep
SUMMARY: hi
`;
  const r = parseVerdict(output);
  check("fell back to line grammar", r.action === "keep");
  check("change from fallback", r.change === "line says keep");
}

// ── Test 5: gate_proposals array in fenced block ──────────────

console.log("\nparseVerdict — fenced with gate_proposals:");
{
  const output = `
<verdict>
{
  "action": "keep",
  "change": "fixed auth",
  "summary": "refresh race",
  "gate_proposals": [
    {"name": "auth_tests", "command": "deno test tests/auth/", "rationale": "regression hot spot"},
    {"name": "lint", "command": "deno lint"}
  ]
}
</verdict>
`;
  const r = parseVerdict(output);
  check("action=keep", r.action === "keep");
  check("two proposals", r.gateProposals.length === 2);
  check("first proposal has rationale", r.gateProposals[0]?.rationale === "regression hot spot");
  check("second proposal no rationale", r.gateProposals[1]?.rationale === undefined);
  check("commands intact", r.gateProposals[1]?.command === "deno lint");
}

// ── Test 6: malformed entries in gate_proposals are filtered ──

console.log("\nparseVerdict — fenced gate_proposals: malformed filtered:");
{
  const output = `
<verdict>
{
  "action": "keep",
  "change": "x",
  "summary": "y",
  "gate_proposals": [
    "not an object",
    {"only_a_name": "missing_command"},
    {"name": "", "command": "empty name"},
    {"name": "x", "command": ""},
    {"name": "valid", "command": "deno test"}
  ]
}
</verdict>
`;
  const r = parseVerdict(output);
  check("only valid proposal survives", r.gateProposals.length === 1);
  check("survivor name=valid", r.gateProposals[0]?.name === "valid");
}

// ── Test 7: multiple fenced blocks → last wins ────────────────

console.log("\nparseVerdict — multiple fenced blocks: last wins:");
{
  const output = `
<verdict>{"action": "discard", "change": "first draft", "summary": "ignore me"}</verdict>

Actually on reflection:

<verdict>{"action": "keep", "change": "final answer", "summary": "better now"}</verdict>
`;
  const r = parseVerdict(output);
  check("action from last block", r.action === "keep");
  check("change from last block", r.change === "final answer");
}

// ── Test 8: legacy line grammar still works when no fenced ─────

console.log("\nparseVerdict — legacy line grammar (no fenced block):");
{
  const output = `
No fenced block here.

VERDICT: KEEP
CHANGE: just line format
SUMMARY: backwards compat preserved
`;
  const r = parseVerdict(output);
  check("action=keep", r.action === "keep");
  check("change from line", r.change === "just line format");
  check("summary from line", r.summary === "backwards compat preserved");
}

// ── Test 9: unknown action value in fenced → fallback ──────────

console.log("\nparseVerdict — unknown fenced action → fallback:");
{
  const output = `
<verdict>{"action": "accept", "change": "typo'd action", "summary": "should fallback"}</verdict>

VERDICT: DISCARD
CHANGE: caught by line grammar
SUMMARY: defaulted
`;
  const r = parseVerdict(output);
  check("fallback ran (line action=discard)", r.action === "discard");
  check("change from fallback", r.change === "caught by line grammar");
}

// ── Test 10: empty change in fenced → extractFirstMeaningfulLine fills in ─

console.log("\nparseVerdict — fenced with empty change falls back to first-line extract:");
{
  const output = `
This is the first meaningful line of substance.
Another line of prose.

<verdict>{"action": "keep", "change": "", "summary": "empty change test"}</verdict>
`;
  const r = parseVerdict(output);
  check("action=keep (fenced won)", r.action === "keep");
  check("summary from fenced", r.summary === "empty change test");
  check("change auto-filled from output", r.change.includes("first meaningful line"));
}

// ── Test 11: fenced with whitespace-only body → malformed → fallback ─

console.log("\nparseVerdict — fenced body whitespace → fallback:");
{
  const output = `
<verdict>


</verdict>

VERDICT: KEEP
CHANGE: saved by fallback
SUMMARY: x
`;
  const r = parseVerdict(output);
  check("action from fallback", r.action === "keep");
  check("change from fallback", r.change === "saved by fallback");
}

// ── Test 12: case-insensitive action strings ──────────────────

console.log("\nparseVerdict — fenced action case-insensitive:");
{
  const output = `<verdict>{"action": "KEEP", "change": "c", "summary": "s"}</verdict>`;
  const r = parseVerdict(output);
  check("uppercase KEEP accepted", r.action === "keep");
}

// ── Summary ────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const name of failures) console.log(`  - ${name}`);
  Deno.exit(1);
}
