/**
 * Unit tests for `discoverAutoDefaults` — the engine behind `expo refine
 * <dir> --auto`. Verifies: polyglot repos pick up every relevant test
 * command, single-ecosystem repos pick up the right one, unknown repos
 * return {projectType: "unknown", gates: []} without throwing, and the
 * npm placeholder test script is correctly skipped.
 *
 * Run:  deno run --allow-all tests/test-refine-auto-discovery.ts
 */

import { join } from "https://deno.land/std/path/mod.ts";
import { discoverAutoDefaults } from "../src/refine.ts";

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
  return await Deno.makeTempDir({ prefix: "expo-auto-discovery-" });
}

async function cleanup(dir: string): Promise<void> {
  await Deno.remove(dir, { recursive: true }).catch(() => {});
}

// ── Test 1: empty dir → unknown project, no gates ──────────────

console.log("\ndiscoverAutoDefaults — empty directory:");
{
  const dir = await makeDir();
  try {
    const d = await discoverAutoDefaults(dir);
    check("projectType=unknown", d.projectType === "unknown");
    check("no gates seeded", d.gates.length === 0);
    check("rubric still populated", d.rubric.length > 0);
    check("reasons explain why empty", d.reasons.some((r) => r.includes("no test infrastructure")));
  } finally {
    await cleanup(dir);
  }
}

// ── Test 2: deno.json with tasks.test ──────────────────────────

console.log("\ndiscoverAutoDefaults — deno.json with tasks.test:");
{
  const dir = await makeDir();
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify({
      tasks: { test: "deno test --allow-all" },
    }, null, 2));
    const d = await discoverAutoDefaults(dir);
    check("projectType=deno", d.projectType === "deno");
    check("one gate seeded", d.gates.length === 1);
    check("gate name is deno_test", d.gates[0]?.name === "deno_test");
    check("command uses `deno task test`", d.gates[0]?.command === "deno task test");
    check("rationale mentions deno.json", (d.gates[0]?.rationale ?? "").includes("deno.json"));
  } finally {
    await cleanup(dir);
  }
}

// ── Test 3: deno.json WITHOUT tasks.test → deno_check fallback ─

console.log("\ndiscoverAutoDefaults — deno.json without tasks.test:");
{
  const dir = await makeDir();
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify({
      name: "hello",
      // no tasks field at all
    }, null, 2));
    const d = await discoverAutoDefaults(dir);
    check("projectType=deno", d.projectType === "deno");
    check("falls back to deno_check gate", d.gates[0]?.name === "deno_check");
  } finally {
    await cleanup(dir);
  }
}

// ── Test 4: package.json with npm's placeholder test script → skipped ─

console.log("\ndiscoverAutoDefaults — npm placeholder test → skipped:");
{
  const dir = await makeDir();
  try {
    await Deno.writeTextFile(join(dir, "package.json"), JSON.stringify({
      name: "hello",
      scripts: { test: 'echo "Error: no test specified" && exit 1' },
    }, null, 2));
    const d = await discoverAutoDefaults(dir);
    check("no npm_test gate for placeholder", !d.gates.some((g) => g.name === "npm_test"));
    check("reason explains the skip", d.reasons.some((r) => r.includes("placeholder")));
  } finally {
    await cleanup(dir);
  }
}

// ── Test 5: package.json with real test script ─────────────────

console.log("\ndiscoverAutoDefaults — package.json with real test:");
{
  const dir = await makeDir();
  try {
    await Deno.writeTextFile(join(dir, "package.json"), JSON.stringify({
      name: "hello",
      scripts: { test: "vitest" },
    }, null, 2));
    const d = await discoverAutoDefaults(dir);
    check("projectType=node", d.projectType === "node");
    check("npm_test gate present", d.gates.some((g) => g.name === "npm_test"));
  } finally {
    await cleanup(dir);
  }
}

// ── Test 6: pyproject.toml → pytest ─────────────────────────────

console.log("\ndiscoverAutoDefaults — pyproject.toml:");
{
  const dir = await makeDir();
  try {
    await Deno.writeTextFile(join(dir, "pyproject.toml"), `[project]\nname = "hello"\n`);
    const d = await discoverAutoDefaults(dir);
    check("projectType=python", d.projectType === "python");
    check("pytest gate present", d.gates.some((g) => g.name === "pytest"));
    check("pytest uses -x fail-fast", d.gates[0]?.command.includes("-x"));
  } finally {
    await cleanup(dir);
  }
}

// ── Test 7: Cargo.toml → cargo_test ────────────────────────────

console.log("\ndiscoverAutoDefaults — Cargo.toml:");
{
  const dir = await makeDir();
  try {
    await Deno.writeTextFile(join(dir, "Cargo.toml"), `[package]\nname = "hello"\n`);
    const d = await discoverAutoDefaults(dir);
    check("projectType=rust", d.projectType === "rust");
    check("cargo_test gate present", d.gates.some((g) => g.name === "cargo_test"));
  } finally {
    await cleanup(dir);
  }
}

// ── Test 8: go.mod → go_test ───────────────────────────────────

console.log("\ndiscoverAutoDefaults — go.mod:");
{
  const dir = await makeDir();
  try {
    await Deno.writeTextFile(join(dir, "go.mod"), `module hello\n`);
    const d = await discoverAutoDefaults(dir);
    check("projectType=go", d.projectType === "go");
    check("go_test gate present", d.gates.some((g) => g.name === "go_test"));
    check("go test covers all packages", d.gates[0]?.command === "go test ./...");
  } finally {
    await cleanup(dir);
  }
}

// ── Test 9: Makefile with test target (fallback — no other markers) ─

console.log("\ndiscoverAutoDefaults — Makefile test target only:");
{
  const dir = await makeDir();
  try {
    await Deno.writeTextFile(
      join(dir, "Makefile"),
      `.PHONY: test\ntest:\n\techo running tests\n`,
    );
    const d = await discoverAutoDefaults(dir);
    check("projectType=make", d.projectType === "make");
    check("make_test gate present", d.gates.some((g) => g.name === "make_test"));
  } finally {
    await cleanup(dir);
  }
}

// ── Test 10: Makefile skipped when other gates already found ───

console.log("\ndiscoverAutoDefaults — Makefile skipped when other markers present:");
{
  const dir = await makeDir();
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify({
      tasks: { test: "deno test" },
    }));
    await Deno.writeTextFile(
      join(dir, "Makefile"),
      `test:\n\techo tests\n`,
    );
    const d = await discoverAutoDefaults(dir);
    check("projectType=deno (primary)", d.projectType === "deno");
    check("only deno_test seeded, no make_test", d.gates.length === 1 && d.gates[0]?.name === "deno_test");
  } finally {
    await cleanup(dir);
  }
}

// ── Test 11: polyglot (deno.json + Cargo.toml) seeds both ──────

console.log("\ndiscoverAutoDefaults — polyglot repo:");
{
  const dir = await makeDir();
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), JSON.stringify({
      tasks: { test: "deno test" },
    }));
    await Deno.writeTextFile(join(dir, "Cargo.toml"), `[package]\nname = "mixed"\n`);
    const d = await discoverAutoDefaults(dir);
    check("two gates seeded", d.gates.length === 2);
    const names = d.gates.map((g) => g.name).sort();
    check("both deno_test and cargo_test", JSON.stringify(names) === JSON.stringify(["cargo_test", "deno_test"]));
    // Primary type is whichever was detected first; deno.json is first in
    // the detection order, so projectType should be "deno".
    check("primary projectType=deno (first match wins)", d.projectType === "deno");
  } finally {
    await cleanup(dir);
  }
}

// ── Test 12: malformed deno.json → graceful skip ───────────────

console.log("\ndiscoverAutoDefaults — malformed deno.json doesn't throw:");
{
  const dir = await makeDir();
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), `{ this is not json`);
    const d = await discoverAutoDefaults(dir);
    check("did not throw", d.projectType !== undefined);
    check("no deno gate seeded from bad json", !d.gates.some((g) => g.name.startsWith("deno")));
    check("reason explains parse failure", d.reasons.some((r) => r.includes("unparseable")));
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
