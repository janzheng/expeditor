// Regression tests for Shakedown A (2026-04-13) Findings #2, #3, #4, #5.
//
// Finding #2: `--scope "a" "b"` silently dropped "b" — parser took only the first glob.
// Finding #3: API 5xx errors treated as semantic discards, polluting consecutive-discard branching.
// Finding #4: Snapshot restore silently rewound working tree to pre-v0.2.2 state. SEV-1.
// Finding #5: Banner said "1 seeded on baseline" when 10 gates were actually in force.

import { isInfraFailure, detectSnapshotDrift } from "../src/refine.ts";

let pass = 0;
let fail = 0;
function check(cond: boolean, label: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else      { fail++; console.log(`  ✗ ${label}`); }
}

// --- Finding #3: isInfraFailure classifier -----------------------------------

console.log("\nFinding #3 — isInfraFailure classifier:");

check(isInfraFailure("API Error: 500"),
  "matches raw 'API Error: 500'");
check(isInfraFailure('API Error: 529 {"type":"overloaded_error"}'),
  "matches 529 overloaded");
check(isInfraFailure('{"type":"api_error","message":"Internal server error"}'),
  "matches JSON api_error payload");
check(isInfraFailure("fetch failed: ETIMEDOUT"),
  "matches network ETIMEDOUT");
check(isInfraFailure("ECONNRESET"),
  "matches ECONNRESET");
check(isInfraFailure("socket hang up"),
  "matches socket hang up");

check(!isInfraFailure("refine_verdict: discard — rubric mismatch"),
  "does NOT match a normal semantic discard");
check(!isInfraFailure("All gates pass. KEEP."),
  "does NOT match a normal keep summary");
check(!isInfraFailure(""),
  "does NOT match empty output");
check(!isInfraFailure("The agent noted an API design issue in src/cli.ts."),
  "does NOT match 'API' in prose");

// --- Finding #4: detectSnapshotDrift -----------------------------------------

console.log("\nFinding #4 — detectSnapshotDrift:");

// Build a tiny throwaway git repo with a manifest-like tag.
const tmp = await Deno.makeTempDir({ prefix: "drift-test-" });
try {
  async function runIn(args: string[], cwd = tmp): Promise<string> {
    const p = await new Deno.Command("git", { args, cwd, stdout: "piped", stderr: "piped" }).output();
    return new TextDecoder().decode(p.stdout);
  }
  await runIn(["init", "-q"]);
  await runIn(["config", "user.email", "drift@test"]);
  await runIn(["config", "user.name", "Drift Test"]);
  await Deno.writeTextFile(`${tmp}/a.txt`, "hello\n");
  await runIn(["add", "-A"]);
  await runIn(["commit", "-q", "-m", "initial"]);
  await runIn(["tag", "refine/000"]);

  // No drift yet.
  const clean = await detectSnapshotDrift(tmp, "000");
  check(clean === null, "returns null when tree matches the snapshot tag");

  // Introduce drift: new file + modified file.
  await Deno.writeTextFile(`${tmp}/a.txt`, "hello world\n");
  await Deno.writeTextFile(`${tmp}/b.txt`, "new\n");
  // Commit so drift includes committed work (uncommitted also drifts, but this
  // test covers the more dangerous case).
  await runIn(["add", "-A"]);
  await runIn(["commit", "-q", "-m", "drift"]);

  const drifted = await detectSnapshotDrift(tmp, "000");
  check(drifted !== null, "detects drift when tree has moved past snapshot");
  check(drifted?.variantId === "000", "reports correct variantId");
  check(drifted?.tag === "refine/000", "reports correct tag");
  check((drifted?.filesChanged ?? 0) >= 2, "counts >= 2 files changed");
  check((drifted?.linesAdded ?? 0) > 0, "counts lines added");

  // Missing tag → null (tag was never created for that id).
  const missing = await detectSnapshotDrift(tmp, "999");
  check(missing === null, "returns null for missing variant tag");

  // Non-git dir → null.
  const nonGit = await Deno.makeTempDir({ prefix: "drift-nongit-" });
  try {
    const r = await detectSnapshotDrift(nonGit, "000");
    check(r === null, "returns null outside a git repo");
  } finally {
    await Deno.remove(nonGit, { recursive: true });
  }
} finally {
  await Deno.remove(tmp, { recursive: true });
}

// --- Finding #2: --scope parser via CLI subprocess ---------------------------
//
// We assert the CLI parses multi-value `--scope` by running a dry-ish command
// that would print the scope. `refine . --status` doesn't show scope but it
// also doesn't spend money, and we can verify the parsing doesn't reject.
// The stronger contract is covered by test-scope-violations.ts (file-level
// glob match) + test-cli-flag-as-positional.ts (flag handling). Here we just
// lock in that BOTH values are accepted in a single `--scope` invocation.
//
// We verify by looking at the resulting `--help`/banner output stream — the
// CLI prints "Scope: N glob(s)" so we can count.

console.log("\nFinding #2 — multi-value --scope parser:");

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command("deno", {
    args: ["run", "--allow-all", CLI, ...args],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

{
  // Use --force-stale-baseline so refine starts (we'll never get to iteration
  // because --max 0 is rejected by validation; but the banner prints first
  // and shows the scope line). Use a nonexistent dir so refine() fails fast
  // before spawning any agent.
  // Actually simpler: the banner prints to stderr/stdout BEFORE the iteration
  // loop. Use --max 1 on /tmp/<nonexistent> will still print banner then error.
  const tmpDir = await Deno.makeTempDir({ prefix: "scope-test-" });
  try {
    const r = await runCli([
      "refine", tmpDir,
      "--rubric", "x",
      "--scope", "src/**", "tests/**", "docs/**",
      "--max", "1",
      "--force-stale-baseline",
      "--json",  // suppress extraneous spawns if any reach here
    ]);
    // Banner output goes to stderr under --json.
    const combined = r.stdout + r.stderr;
    // Our parser fix makes all three globs accepted.
    check(/Scope:\s+3 glob\(s\)/.test(combined),
      "banner reports 3 globs when passed 3 values under one --scope flag");
    check(/• src\/\*\*/.test(combined), "banner lists src/**");
    check(/• tests\/\*\*/.test(combined), "banner lists tests/**");
    check(/• docs\/\*\*/.test(combined), "banner lists docs/**");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }

  // Repeated-flag form still works.
  const tmpDir2 = await Deno.makeTempDir({ prefix: "scope-test-2-" });
  try {
    const r = await runCli([
      "refine", tmpDir2,
      "--rubric", "x",
      "--scope", "a/**",
      "--scope", "b/**",
      "--max", "1",
      "--force-stale-baseline",
      "--json",
    ]);
    const combined = r.stdout + r.stderr;
    check(/Scope:\s+2 glob\(s\)/.test(combined),
      "banner reports 2 globs when --scope is passed twice (repeat form)");
  } finally {
    await Deno.remove(tmpDir2, { recursive: true });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
Deno.exit(fail === 0 ? 0 : 1);
