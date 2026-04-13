/**
 * Unit tests for `loadGateFile` + `dedupeGatesByName` — the primitives
 * behind `--gate-file PATH`.
 *
 * Coverage:
 *   - flat array shape parses correctly
 *   - object-wrapper `{gates: [...]}` shape parses identically
 *   - rationale is optional; empty rationale is dropped
 *   - missing / empty name → throws with file-relative index
 *   - missing / empty command → throws with name context
 *   - non-JSON → throws
 *   - missing file → throws
 *   - wrong root shape (plain string, number) → throws
 *   - dedupeGatesByName: later entry wins, preserves order of first occurrences
 *
 * Run:  deno run --allow-all tests/test-refine-gate-file.ts
 */

import { join } from "https://deno.land/std/path/mod.ts";
import { dedupeGatesByName, loadGateFile } from "../src/refine.ts";

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

async function makeFile(content: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "expo-gate-file-" });
  const path = join(dir, "gates.json");
  await Deno.writeTextFile(path, content);
  return path;
}

async function cleanup(path: string): Promise<void> {
  const dir = path.replace(/\/[^/]+$/, "");
  await Deno.remove(dir, { recursive: true }).catch(() => {});
}

async function expectThrow(name: string, fn: () => Promise<unknown>, needleInMessage?: string): Promise<void> {
  try {
    await fn();
    check(name, false, "did not throw");
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err);
    if (needleInMessage && !msg.includes(needleInMessage)) {
      check(name, false, `threw but message "${msg.slice(0, 80)}" missing needle "${needleInMessage}"`);
    } else {
      check(name, true);
    }
  }
}

// ── Test 1: flat array shape ────────────────────────────────────

console.log("\nloadGateFile — flat array:");
{
  const path = await makeFile(JSON.stringify([
    { name: "tests", command: "deno test --allow-all" },
    { name: "lint", command: "deno lint", rationale: "regression hot spot" },
  ]));
  try {
    const gates = await loadGateFile(path);
    check("two gates loaded", gates.length === 2);
    check("first: name", gates[0]?.name === "tests");
    check("first: command", gates[0]?.command === "deno test --allow-all");
    check("first: no rationale", gates[0]?.rationale === undefined);
    check("second: rationale preserved", gates[1]?.rationale === "regression hot spot");
  } finally {
    await cleanup(path);
  }
}

// ── Test 2: object wrapper {gates: [...]} ──────────────────────

console.log("\nloadGateFile — object wrapper:");
{
  const path = await makeFile(JSON.stringify({
    gates: [
      { name: "typecheck", command: "deno check **/*.ts" },
    ],
  }));
  try {
    const gates = await loadGateFile(path);
    check("one gate loaded", gates.length === 1);
    check("name preserved", gates[0]?.name === "typecheck");
  } finally {
    await cleanup(path);
  }
}

// ── Test 3: whitespace-trimmed names/commands ──────────────────

console.log("\nloadGateFile — whitespace trimmed:");
{
  const path = await makeFile(JSON.stringify([
    { name: "  tests  ", command: "  deno test  ", rationale: "  why  " },
  ]));
  try {
    const gates = await loadGateFile(path);
    check("name trimmed", gates[0]?.name === "tests");
    check("command trimmed", gates[0]?.command === "deno test");
    check("rationale trimmed", gates[0]?.rationale === "why");
  } finally {
    await cleanup(path);
  }
}

// ── Test 4: empty rationale dropped ─────────────────────────────

console.log("\nloadGateFile — empty rationale dropped:");
{
  const path = await makeFile(JSON.stringify([
    { name: "a", command: "true", rationale: "" },
    { name: "b", command: "true", rationale: "   " },
  ]));
  try {
    const gates = await loadGateFile(path);
    check("rationale=undefined for empty", gates[0]?.rationale === undefined);
    check("rationale=undefined for whitespace", gates[1]?.rationale === undefined);
  } finally {
    await cleanup(path);
  }
}

// ── Test 5: missing name throws ────────────────────────────────

console.log("\nloadGateFile — missing name throws:");
{
  const path = await makeFile(JSON.stringify([
    { command: "deno test" }, // no name
  ]));
  try {
    await expectThrow("throws on missing name", () => loadGateFile(path), "missing or empty \"name\"");
    await expectThrow("error mentions index", () => loadGateFile(path), "[0]");
  } finally {
    await cleanup(path);
  }
}

// ── Test 6: empty name throws ───────────────────────────────────

console.log("\nloadGateFile — empty name throws:");
{
  const path = await makeFile(JSON.stringify([
    { name: "", command: "deno test" },
    { name: "   ", command: "deno test" },
  ]));
  try {
    await expectThrow("throws on empty-string name", () => loadGateFile(path), "missing or empty \"name\"");
  } finally {
    await cleanup(path);
  }
}

// ── Test 7: missing command throws with name context ──────────

console.log("\nloadGateFile — missing command throws:");
{
  const path = await makeFile(JSON.stringify([
    { name: "tests" }, // no command
  ]));
  try {
    await expectThrow("throws on missing command", () => loadGateFile(path), "missing or empty \"command\"");
    await expectThrow("error includes gate name", () => loadGateFile(path), "name=tests");
  } finally {
    await cleanup(path);
  }
}

// ── Test 8: non-JSON throws ────────────────────────────────────

console.log("\nloadGateFile — non-JSON throws:");
{
  const path = await makeFile("{ this is not valid json");
  try {
    await expectThrow("throws on bad JSON", () => loadGateFile(path), "not valid JSON");
  } finally {
    await cleanup(path);
  }
}

// ── Test 9: missing file throws ─────────────────────────────────

console.log("\nloadGateFile — missing file throws:");
{
  await expectThrow(
    "throws on missing file",
    () => loadGateFile("/nonexistent/path/gates.json"),
    "cannot read",
  );
}

// ── Test 10: wrong root shape throws ────────────────────────────

console.log("\nloadGateFile — wrong root shape throws:");
{
  const p1 = await makeFile(JSON.stringify("just a string"));
  const p2 = await makeFile(JSON.stringify({ other: "field" })); // no `gates` array
  const p3 = await makeFile(JSON.stringify(42));
  try {
    await expectThrow("plain string rejected", () => loadGateFile(p1), "expected array");
    await expectThrow("object without gates field rejected", () => loadGateFile(p2), "expected array");
    await expectThrow("number rejected", () => loadGateFile(p3), "expected array");
  } finally {
    await cleanup(p1);
    await cleanup(p2);
    await cleanup(p3);
  }
}

// ── Test 11: non-object entry in array throws ───────────────────

console.log("\nloadGateFile — non-object array entry throws:");
{
  const path = await makeFile(JSON.stringify(["not an object"]));
  try {
    await expectThrow("throws on string-in-array", () => loadGateFile(path), "expected object");
  } finally {
    await cleanup(path);
  }
}

// ── Test 12: dedupeGatesByName — later wins ─────────────────────

console.log("\ndedupeGatesByName — later wins:");
{
  const gates = [
    { name: "tests", command: "old" },
    { name: "lint", command: "deno lint" },
    { name: "tests", command: "new" }, // should override first
  ];
  const out = dedupeGatesByName(gates);
  check("two unique names", out.length === 2);
  const testsGate = out.find((g) => g.name === "tests");
  check("tests has new command", testsGate?.command === "new");
}

// ── Test 13: dedupe on empty list ─────────────────────────────

console.log("\ndedupeGatesByName — empty list:");
{
  const out = dedupeGatesByName([]);
  check("empty in → empty out", out.length === 0);
}

// ── Test 14: dedupe preserves single-entry list ─────────────────

console.log("\ndedupeGatesByName — single entry:");
{
  const out = dedupeGatesByName([{ name: "only", command: "x" }]);
  check("single-entry passthrough", out.length === 1 && out[0].name === "only");
}

// ── Summary ────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const name of failures) console.log(`  - ${name}`);
  Deno.exit(1);
}
