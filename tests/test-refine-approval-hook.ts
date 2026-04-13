/**
 * Unit tests for `--approval-hook` — non-TTY approval gate.
 *
 * Covers the parser that turns hook stdout into an ApprovalDecision. Two
 * accepted shapes:
 *   1. JSON: `{"action": "accept"|"discard"|"converge"|"quit"}`
 *   2. Bare token: `accept` / `discard` / `converge` / `quit`
 *
 * Also exercises the shorthand letters the TTY prompt accepts (a/d/c/q)
 * because the hook's bare-token branch falls through to the same choice
 * mapper, so the vocabularies stay in sync.
 *
 * Run:  deno run --allow-all tests/test-refine-approval-hook.ts
 */

import { _testOnlyParseApprovalOutput as parseApprovalOutput } from "../src/refine.ts";

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

// ── JSON canonical form ────────────────────────────────────────

console.log("\nparseApprovalOutput — JSON canonical:");
{
  check("accept", parseApprovalOutput('{"action":"accept"}') === "accept");
  check("discard", parseApprovalOutput('{"action":"discard"}') === "discard");
  check("converge", parseApprovalOutput('{"action":"converge"}') === "converge");
  check("quit", parseApprovalOutput('{"action":"quit"}') === "quit");
}

// ── JSON with extra fields (ignored) ───────────────────────────

console.log("\nparseApprovalOutput — JSON with extra fields:");
{
  const r = parseApprovalOutput('{"action":"discard","reason":"too risky","agent":"oversight-1"}');
  check("extra fields ignored; action still parsed", r === "discard");
}

// ── JSON with action case variations ───────────────────────────

console.log("\nparseApprovalOutput — case-insensitive action:");
{
  check("ACCEPT uppercase", parseApprovalOutput('{"action":"ACCEPT"}') === "accept");
  check("Discard mixed case", parseApprovalOutput('{"action":"Discard"}') === "discard");
}

// ── Bare token form ────────────────────────────────────────────

console.log("\nparseApprovalOutput — bare tokens:");
{
  check("accept", parseApprovalOutput("accept") === "accept");
  check("discard", parseApprovalOutput("discard") === "discard");
  check("converge", parseApprovalOutput("converge") === "converge");
  check("quit", parseApprovalOutput("quit") === "quit");
}

// ── Shorthand letters (a/d/c/q) — matches TTY prompt ───────────

console.log("\nparseApprovalOutput — shorthand letters:");
{
  check("a → accept", parseApprovalOutput("a") === "accept");
  check("d → discard", parseApprovalOutput("d") === "discard");
  check("c → converge", parseApprovalOutput("c") === "converge");
  check("q → quit", parseApprovalOutput("q") === "quit");
}

// ── Multi-word bare output: first token wins ───────────────────

console.log("\nparseApprovalOutput — first token of multi-word output:");
{
  check(
    "discard because reason → discard",
    parseApprovalOutput("discard because reason") === "discard",
  );
}

// ── Unknown shape returns null ─────────────────────────────────

console.log("\nparseApprovalOutput — unknown shapes return null:");
{
  check("unknown action word", parseApprovalOutput('{"action":"yeet"}') === null);
  check("object without action", parseApprovalOutput('{"other":"field"}') === null);
  check("random prose", parseApprovalOutput("I don't know what to do") === null);
  check("empty-ish (whitespace-only preserved by caller)", parseApprovalOutput("   ") === null);
}

// ── Robustness: malformed JSON falls through to bare-token form ─

console.log("\nparseApprovalOutput — malformed JSON falls through to bare token:");
{
  // Leading garbage that looks JSON-ish but fails parse — then token scan
  // sees "discard" as the first word. Good — hook authors can be sloppy.
  check("malformed{...} but bare token present", parseApprovalOutput('discard {"maybe json}') === "discard");
  // Genuinely garbled → null
  check("fully garbled", parseApprovalOutput("{{{{{") === null);
}

// ── JSON with null action ──────────────────────────────────────

console.log("\nparseApprovalOutput — JSON with null / non-string action:");
{
  check("null action", parseApprovalOutput('{"action":null}') === null);
  check("number action", parseApprovalOutput('{"action":42}') === null);
}

// ── Summary ────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const name of failures) console.log(`  - ${name}`);
  Deno.exit(1);
}
