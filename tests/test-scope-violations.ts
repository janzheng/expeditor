/**
 * Unit tests for findScopeViolations — the hard-constraint version of
 * rubric-prose "don't modify X". Used by expo refine's --scope flag.
 *
 * Run:  deno run --allow-all tests/test-scope-violations.ts
 */

import { findScopeViolations } from "../src/refine.ts";

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

console.log("\nfindScopeViolations — exact path match:");
{
  const v = findScopeViolations(["src/workflow.ts", "src/cli.ts"], ["src/workflow.ts"]);
  check("one path in scope, one out", v.length === 1 && v[0] === "src/cli.ts");
}

console.log("\nfindScopeViolations — globstar:");
{
  const v1 = findScopeViolations(
    ["src/workflow.ts", "src/adapters/claude.ts", "tests/test-foo.ts"],
    ["src/**"],
  );
  check("src/** matches nested", v1.length === 1 && v1[0] === "tests/test-foo.ts");

  const v2 = findScopeViolations(
    ["src/workflow.ts", "tests/test-foo.ts"],
    ["src/**", "tests/**"],
  );
  check("multiple globs OR'd", v2.length === 0);
}

console.log("\nfindScopeViolations — empty scope is no-op:");
{
  const v = findScopeViolations(["src/foo.ts", "anything/at/all.rs"], []);
  check("empty scope → no violations (no filter)", v.length === 0);
}

console.log("\nfindScopeViolations — no paths is no-op:");
{
  const v = findScopeViolations([], ["src/**"]);
  check("no paths → no violations", v.length === 0);
}

console.log("\nfindScopeViolations — extension glob:");
{
  const v = findScopeViolations(
    ["src/main.ts", "src/README.md", "src/sub/foo.ts"],
    ["src/**/*.ts"],
  );
  check("*.ts filter excludes .md", v.length === 1 && v[0] === "src/README.md");
}

console.log("\nfindScopeViolations — realistic refine scope:");
{
  // Scenario from a real refine session: rubric scopes to bus + orchestrator
  // + mxit-runner + tests. Agent touches cli.ts (rubric violation).
  const agentTouched = [
    "src/bus.ts",
    "src/orchestrator.ts",
    "src/cli.ts",        // ← violation
    "tests/test-bus-pending-cap.ts",
  ];
  const scope = [
    "src/bus.ts",
    "src/orchestrator.ts",
    "src/mxit-runner.ts",
    "tests/**",
  ];
  const v = findScopeViolations(agentTouched, scope);
  check("catches the cli.ts violation", v.length === 1 && v[0] === "src/cli.ts");
}

console.log("\nfindScopeViolations — brace expansion (extended glob):");
{
  const v = findScopeViolations(
    ["src/bus.ts", "src/orchestrator.ts", "src/cli.ts"],
    ["src/{bus,orchestrator}.ts"],
  );
  check("brace expansion matches both", v.length === 1 && v[0] === "src/cli.ts");
}

console.log("\nfindScopeViolations — lock files always pass (toolchain artefacts):");
{
  // Scenario from refine-cleanup session: agent added an import that
  // triggered a deno.lock auto-update. Without this exemption, the
  // whole iteration got wrongly discarded twice. This test locks in
  // that we don't make the same mistake again.
  const scope = ["src/claude-adapter.ts", "tests/**"];
  const cases = [
    ["src/claude-adapter.ts", "tests/test-foo.ts", "deno.lock"],
    ["src/claude-adapter.ts", "package-lock.json"],
    ["src/claude-adapter.ts", "Cargo.lock"],
    ["src/claude-adapter.ts", "uv.lock", "poetry.lock", "Pipfile.lock"],
  ];
  for (const paths of cases) {
    const v = findScopeViolations(paths, scope);
    check(
      `lock files pass through — ${paths.filter((p) => !p.startsWith("src/") && !p.startsWith("tests/")).join(", ")}`,
      v.length === 0,
    );
  }

  // Real-looking violation (not a lock file) is still caught
  const stillCaught = findScopeViolations(
    ["src/claude-adapter.ts", "src/untouched.ts"],
    ["src/claude-adapter.ts", "tests/**"],
  );
  check("non-lock file outside scope still caught", stillCaught.length === 1 && stillCaught[0] === "src/untouched.ts");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  Deno.exit(1);
}
