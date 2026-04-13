// Regression test for Finding #1 (shakedown A, 2026-04-13).
//
// Before the fix: `expo refine --help` consumed `--help` as the <dir>
// positional, created a `./--help/` directory with `.refine/` state, and
// spawned a real Claude agent ($0.33 observed). `expo spawn --help` and
// `expo review --help` had analogous bugs (no stray dir, but real agent
// spawns with "--help" as the prompt).
//
// Fix: rejectFlagAsPositional() in cli.ts — any positional that starts
// with `--` or equals `-h` now prints usage + exits 1 before anything
// destructive runs.
//
// This test covers exit semantics only; the full audit of which
// subcommands take positionals is in shakedown/2026-04-13-expo-on-expo/findings.md.

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

async function runCli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
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

let pass = 0;
let fail = 0;
function check(cond: boolean, label: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else      { fail++; console.log(`  ✗ ${label}`); }
}

console.log("Flag-as-positional rejection (shakedown Finding #1):");

// --- refine ---
{
  const r = await runCli("refine", "--help");
  check(r.code === 1, "refine --help exits 1");
  check(/Usage: expo refine/.test(r.stderr), "refine --help prints usage to stderr");
  // The key behavioral assertion: no stray dir was created.
  let stray = false;
  try { await Deno.stat("--help"); stray = true; } catch { /* good */ }
  check(!stray, "refine --help does NOT create ./--help/ directory");
}

{
  const r = await runCli("refine", "-h");
  check(r.code === 1, "refine -h exits 1");
}

// --- spawn ---
{
  const r = await runCli("spawn", "--help");
  check(r.code === 1, "spawn --help exits 1");
  check(/Usage: cli\.ts spawn/.test(r.stderr), "spawn --help prints usage");
}

{
  const r = await runCli("spawn", "--some-other-flag");
  check(r.code === 1, "spawn --some-other-flag rejected (any --prefix)");
}

// --- review ---
{
  const r = await runCli("review", "--help");
  check(r.code === 1, "review --help exits 1");
  check(/Usage: cli\.ts review/.test(r.stderr), "review --help prints usage");
}

// --- regression: valid positionals still work ---
{
  // `refine . gate list` should succeed (dir="." is not a flag)
  const r = await runCli("refine", ".", "gate", "list");
  check(r.code === 0, "refine . gate list still succeeds (happy path)");
}

// --- Finding #1-audit polish: the 7 remaining subcommands ---
// None of these burn money on `--help`, but they used to print cryptic
// downstream errors (JSON.parse fails, file not found, "Unknown subcommand").
// The fix makes them print proper usage before those downstream errors.

for (const sub of ["spawn-all", "resume", "fork", "workflow", "mxit"]) {
  const r = await runCli(sub, "--help");
  check(r.code === 1, `${sub} --help exits 1`);
  check(/^Usage:/m.test(r.stderr), `${sub} --help prints clean usage (not downstream error)`);
}

// ralph takes TWO positionals — exercise the first-slot rejection.
{
  const r = await runCli("ralph", "--help", "anything");
  check(r.code === 1, "ralph --help <arg2> exits 1 on first positional");
  check(/Usage: cli\.ts ralph/.test(r.stderr), "ralph --help prints proper usage");
}

// permissions: any --flag as subcommand slot should print usage
{
  const r = await runCli("permissions", "--help");
  check(r.code === 1, "permissions --help exits 1");
  check(/Usage: expo permissions/.test(r.stderr), "permissions --help prints usage (not 'Unknown subcommand')");
}

console.log(`\n${pass} passed, ${fail} failed`);
Deno.exit(fail === 0 ? 0 : 1);
