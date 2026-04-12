/**
 * Regression test for RaceResult parse-vs-fallback provenance
 * (audit finding: .brief/agentic-audit.md — src/orchestrator.ts:369-370,
 * "race judge fallback silently elects branch 0 when judge output fails
 * to parse").
 *
 * Exercises `resolveRaceWinner`, the pure helper that was extracted so the
 * parse-vs-fallback distinction can be unit-tested without spawning real
 * judge agents.
 *
 * Invariants locked in:
 *   1. A valid `PICK <n>` verdict → pickParsed: true, no fallbackReason.
 *   2. Garbage / missing / out-of-range PICK → pickParsed: false,
 *      fallbackReason set, winner defaults to successIndices[0].
 *   3. Case-insensitive PICK match is preserved.
 *   4. First parseable PICK line wins (tolerates preamble).
 *
 * Run:  deno run --allow-all tests/test-race-verdict.ts
 */

import { resolveRaceWinner } from "../src/orchestrator.ts";

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

console.log("\n=== resolveRaceWinner (parsed picks) ===");

{
  const r = resolveRaceWinner("PICK 2\nReasoning: branch 2 is cleaner", [0, 1, 2], 3);
  check("parses PICK 2 → winner index 1", r.winner === 1);
  check("parsed pick sets pickParsed: true", r.pickParsed === true);
  check("parsed pick has no fallbackReason", r.fallbackReason === undefined);
}

{
  const r = resolveRaceWinner("pick 3\nrationale", [0, 1, 2], 3);
  check("case-insensitive pick match", r.winner === 2 && r.pickParsed === true);
}

{
  // First PICK line wins even with preamble
  const r = resolveRaceWinner(
    "Let me think about this.\nI considered all options.\nPICK 1\nThen I second-guessed.",
    [0, 1, 2],
    3,
  );
  check("first PICK line wins with preamble", r.winner === 0 && r.pickParsed === true);
}

console.log("\n=== resolveRaceWinner (fallback cases) ===");

{
  const r = resolveRaceWinner("no verdict here, just rambling", [1, 2], 3);
  check("missing PICK → pickParsed: false", r.pickParsed === false);
  check("missing PICK → winner defaults to successIndices[0]", r.winner === 1);
  check("missing PICK → fallbackReason present", typeof r.fallbackReason === "string" && r.fallbackReason.length > 0);
}

{
  const r = resolveRaceWinner("PICK 99", [0, 2], 3);
  check("out-of-range PICK → pickParsed: false", r.pickParsed === false);
  check("out-of-range PICK → defaults to successIndices[0]", r.winner === 0);
}

{
  const r = resolveRaceWinner("PICK 0", [1, 2], 3);
  // PICK is 1-indexed; 0 is invalid
  check("PICK 0 (1-indexed invalid) → pickParsed: false", r.pickParsed === false);
  check("PICK 0 → winner defaults to first success (1)", r.winner === 1);
}

{
  const r = resolveRaceWinner("", [2], 3);
  check("empty judge output → pickParsed: false", r.pickParsed === false);
  check("empty judge output → uses successIndices[0]", r.winner === 2);
}

// The key invariant: parsed and fallback picks must be DISTINGUISHABLE.
// Before this fix, both would return the same RaceResult shape and callers
// had no way to tell that the judge had silently defaulted.
{
  const parsed = resolveRaceWinner("PICK 1", [0, 1], 2);
  const fallback = resolveRaceWinner("judge crashed", [0, 1], 2);
  check(
    "parsed and fallback are distinguishable by pickParsed flag",
    parsed.pickParsed !== fallback.pickParsed,
  );
  check(
    "parsed and fallback can yield same winner index but different provenance",
    parsed.winner === 0 && fallback.winner === 0 && parsed.pickParsed && !fallback.pickParsed,
  );
}

console.log("");
if (failed === 0) {
  console.log(`\x1b[32m✓ all ${passed} checks passed\x1b[0m`);
} else {
  console.log(`\x1b[31m✗ ${failed} failed, ${passed} passed\x1b[0m`);
  for (const name of failures) console.log(`   - ${name}`);
  Deno.exit(1);
}
