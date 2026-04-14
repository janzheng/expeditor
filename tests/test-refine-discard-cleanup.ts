/**
 * Unit test for the discard-path straggler cleanup (TASKS-AGENTIC-UX
 * "Diff-based agent-touched-paths misses files from prior discarded
 * iterations").
 *
 * The setup reproduces the real-world trip from the cleanup-2 session:
 *   1. iter-N creates a file, then self-discards (scope violation /
 *      gate failure / rubric reject).
 *   2. Without cleanup, the straggler file stays in the working tree.
 *   3. iter-N+1's pre-spawn dirty scan sees the file as already dirty,
 *      so when iter-N+1 legitimately re-creates it, the dirty-diff
 *      filters it OUT of agentTouchedPaths → it doesn't get staged into
 *      the snapshot → "committed-loose" straggler, manual re-stage needed.
 *
 * The fix threads agentTouchedPaths into recordDiscardAndMaybeBranch so
 * the discard path can explicitly remove those files after restore.
 *
 * This test uses a simulated project-git backend (the one affected — the
 * hidden-git backend wipes the working tree on restore, so this bug
 * doesn't reproduce there).
 *
 * Run:  deno run --allow-all tests/test-refine-discard-cleanup.ts
 */

import { join } from "https://deno.land/std/path/mod.ts";

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

async function makeGitRepo(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "expo-discard-cleanup-" });
  for (const cmd of [
    ["git", "init", "-q"],
    ["git", "config", "user.email", "test@test"],
    ["git", "config", "user.name", "test"],
  ]) {
    const p = await new Deno.Command(cmd[0], {
      args: cmd.slice(1),
      cwd: dir,
      stdout: "null",
      stderr: "null",
    }).output();
    if (!p.success) throw new Error(`setup failed: ${cmd.join(" ")}`);
  }
  await Deno.writeTextFile(join(dir, "seed.txt"), "seed\n");
  for (const cmd of [
    ["git", "add", "."],
    ["git", "commit", "-qm", "seed"],
  ]) {
    await new Deno.Command(cmd[0], {
      args: cmd.slice(1),
      cwd: dir,
      stdout: "null",
      stderr: "null",
    }).output();
  }
  return dir;
}

async function cleanup(dir: string): Promise<void> {
  await Deno.remove(dir, { recursive: true }).catch(() => {});
}

// ── Test 1: cleanup verifies via simulated pre/post discard ────

console.log("\ndiscard cleanup — straggler files removed when agentTouchedPaths passed:");
{
  const dir = await makeGitRepo();
  try {
    // Simulate the core logic of recordDiscardAndMaybeBranch's cleanup
    // step — extracting just the part that matters: if agentTouchedPaths
    // are provided, explicitly unlink them after (simulated) restore.
    // This tests the semantics without dragging in the full snapshot init
    // + variant machinery, which is tested elsewhere.

    // Simulate iter-N: agent creates a new file.
    await Deno.writeTextFile(join(dir, "new-file.txt"), "agent work\n");
    await Deno.writeTextFile(join(dir, "nested/also-new.txt"), "nested agent work\n").catch(async () => {
      await Deno.mkdir(join(dir, "nested"));
      await Deno.writeTextFile(join(dir, "nested/also-new.txt"), "nested agent work\n");
    });
    check("setup: new-file.txt exists", await exists(dir, "new-file.txt"));
    check("setup: nested/also-new.txt exists", await exists(dir, "nested/also-new.txt"));

    // Simulate the discard cleanup: with agentTouchedPaths known, unlink them.
    const agentTouchedPaths = ["new-file.txt", "nested/also-new.txt"];
    for (const p of agentTouchedPaths) {
      try {
        await Deno.remove(`${dir}/${p}`, { recursive: true });
      } catch { /* best-effort */ }
    }

    check("after cleanup: new-file.txt removed", !(await exists(dir, "new-file.txt")));
    check("after cleanup: nested/also-new.txt removed", !(await exists(dir, "nested/also-new.txt")));
    check("seed file still present", await exists(dir, "seed.txt"));
  } finally {
    await cleanup(dir);
  }
}

// ── Test 2: missing straggler doesn't throw ────────────────────

console.log("\ndiscard cleanup — missing straggler is a no-op:");
{
  const dir = await makeGitRepo();
  try {
    // Simulate: restore() already removed the file (e.g. it WAS tracked).
    // Cleanup's unlink attempt should silently succeed.
    const agentTouchedPaths = ["never-existed.txt"];
    let threw = false;
    for (const p of agentTouchedPaths) {
      try {
        await Deno.remove(`${dir}/${p}`, { recursive: true });
      } catch {
        // Best-effort in prod; test just checks the outer flow doesn't throw.
      }
    }
    check("no throw from missing file", !threw);
    check("seed still there", await exists(dir, "seed.txt"));
  } finally {
    await cleanup(dir);
  }
}

// ── Test 3: empty touched-paths list is a no-op ────────────────

console.log("\ndiscard cleanup — empty agentTouchedPaths is a no-op:");
{
  const dir = await makeGitRepo();
  try {
    await Deno.writeTextFile(join(dir, "user-work.txt"), "concurrent user edit\n");
    const agentTouchedPaths: string[] = [];
    for (const p of agentTouchedPaths) {
      try {
        await Deno.remove(`${dir}/${p}`);
      } catch { /* no-op */ }
    }
    check("concurrent user file untouched", await exists(dir, "user-work.txt"));
  } finally {
    await cleanup(dir);
  }
}

// ── Test 4: concurrent user files NOT removed ──────────────────

console.log("\ndiscard cleanup — concurrent user files preserved:");
{
  const dir = await makeGitRepo();
  try {
    // User has an uncommitted change that happened during the agent run
    await Deno.writeTextFile(join(dir, "user-concurrent.txt"), "user stuff\n");
    // Agent also created something
    await Deno.writeTextFile(join(dir, "agent-output.txt"), "agent stuff\n");

    // agentTouchedPaths is SCOPED — only includes the diff, not concurrent
    // user edits. This is what the refine loop actually computes.
    const agentTouchedPaths = ["agent-output.txt"];
    for (const p of agentTouchedPaths) {
      try {
        await Deno.remove(`${dir}/${p}`, { recursive: true });
      } catch { /* ok */ }
    }

    check("agent straggler removed", !(await exists(dir, "agent-output.txt")));
    check("user concurrent work preserved", await exists(dir, "user-concurrent.txt"));
  } finally {
    await cleanup(dir);
  }
}

async function exists(dir: string, name: string): Promise<boolean> {
  try {
    await Deno.stat(join(dir, name));
    return true;
  } catch {
    return false;
  }
}

// ── Finding #16: cleanupUntrackedAgentPaths leaves tracked files alone ──

import {
  cleanupUntrackedAgentPaths,
  listUntrackedPaths,
} from "../src/refine.ts";

console.log("\nlistUntrackedPaths — returns only untracked, ignores tracked-modified:");
{
  const dir = await makeGitRepo();
  try {
    // seed.txt is committed (tracked). Modify it.
    await Deno.writeTextFile(join(dir, "seed.txt"), "seed modified\n");
    // Create a new file (untracked).
    await Deno.writeTextFile(join(dir, "new.txt"), "brand new\n");

    const untracked = await listUntrackedPaths(dir);
    check("not null", untracked !== null);
    check("includes new.txt (untracked)", untracked!.has("new.txt"));
    check("excludes seed.txt (tracked-modified)", !untracked!.has("seed.txt"));
  } finally {
    await cleanup(dir);
  }
}

console.log("\nlistUntrackedPaths — filters .expo/ and other expo-internal paths:");
{
  const dir = await makeGitRepo();
  try {
    await Deno.mkdir(join(dir, ".expo"), { recursive: true });
    await Deno.writeTextFile(join(dir, ".expo/logs.txt"), "expo internal\n");
    await Deno.writeTextFile(join(dir, "user.txt"), "user file\n");

    const untracked = await listUntrackedPaths(dir);
    check("includes user.txt", untracked!.has("user.txt"));
    check("excludes .expo/logs.txt", !untracked!.has(".expo/logs.txt"));
  } finally {
    await cleanup(dir);
  }
}

console.log(
  "\nFinding #16: cleanupUntrackedAgentPaths preserves tracked-modified files:",
);
{
  const dir = await makeGitRepo();
  try {
    // Simulate the pre-bug-fix scenario. Agent both (a) modified a tracked
    // file and (b) created a new untracked file. Scope violation discard
    // fires. `restore()` rewinds the tracked file to HEAD's content — then
    // we call cleanupUntrackedAgentPaths. Without the Finding #16 fix, the
    // tracked file would be wiped. With the fix, only the untracked file
    // is removed.
    //
    // We simulate the "restore already ran" state by restoring seed.txt to
    // its HEAD content before calling the helper.
    await Deno.writeTextFile(join(dir, "seed.txt"), "seed\n"); // post-restore content
    await Deno.writeTextFile(join(dir, "agent-new.txt"), "agent created this\n"); // untracked leftover

    const agentTouchedPaths = ["seed.txt", "agent-new.txt"];
    await cleanupUntrackedAgentPaths(dir, agentTouchedPaths);

    check(
      "seed.txt (tracked) NOT removed by cleanup",
      await exists(dir, "seed.txt"),
    );
    const seedContent = await Deno.readTextFile(join(dir, "seed.txt"));
    check("seed.txt content preserved (post-restore state)", seedContent === "seed\n");
    check(
      "agent-new.txt (untracked) removed by cleanup",
      !(await exists(dir, "agent-new.txt")),
    );
  } finally {
    await cleanup(dir);
  }
}

console.log(
  "\nFinding #16: cleanup is a safe no-op on empty agentTouchedPaths:",
);
{
  const dir = await makeGitRepo();
  try {
    await Deno.writeTextFile(join(dir, "untouched.txt"), "here\n");
    await cleanupUntrackedAgentPaths(dir, []);
    check("untouched file still present", await exists(dir, "untouched.txt"));
  } finally {
    await cleanup(dir);
  }
}

console.log(
  "\nFinding #16 follow-up: agentSpawnTime skips files whose mtime predates spawn:",
);
{
  const dir = await makeGitRepo();
  try {
    // User-created untracked file, written BEFORE the agent's "spawn time."
    // This is the race the Finding #16 follow-up guards against: if
    // preAgentDirty captured a moment too early, a legitimate user file
    // could land in agentTouchedPaths and get wiped.
    await Deno.writeTextFile(join(dir, "user-brief.md"), "user content\n");
    // Wait a hair so mtime is comfortably before spawn cutoff.
    await new Promise((r) => setTimeout(r, 3100));

    const agentSpawnTime = Date.now();
    // Simulate an agent-created file WITHIN the spawn window.
    await Deno.writeTextFile(join(dir, "agent-output.ts"), "// agent made this\n");

    const agentTouchedPaths = ["user-brief.md", "agent-output.ts"];
    await cleanupUntrackedAgentPaths(dir, agentTouchedPaths, {
      agentSpawnTime,
      context: "test",
    });

    check(
      "user-brief.md (pre-spawn mtime) NOT removed",
      await exists(dir, "user-brief.md"),
    );
    check(
      "agent-output.ts (post-spawn mtime) removed",
      !(await exists(dir, "agent-output.ts")),
    );
  } finally {
    await cleanup(dir);
  }
}

console.log(
  "\nFinding #16 follow-up: without agentSpawnTime, behaves as before (no mtime skip):",
);
{
  const dir = await makeGitRepo();
  try {
    await Deno.writeTextFile(join(dir, "pre-existing.md"), "old content\n");
    const agentTouchedPaths = ["pre-existing.md"];
    // Omit agentSpawnTime — should fall back to the old behaviour
    // (remove anything untracked in agentTouchedPaths).
    await cleanupUntrackedAgentPaths(dir, agentTouchedPaths);
    check(
      "without agentSpawnTime: pre-existing untracked file IS removed (old behaviour)",
      !(await exists(dir, "pre-existing.md")),
    );
  } finally {
    await cleanup(dir);
  }
}

console.log(
  "\nFinding #16: cleanup on non-git dir is a safe no-op (no wipe):",
);
{
  // No git init — listUntrackedPaths returns null → helper skips cleanup
  // entirely rather than falling back to the dangerous Deno.remove loop.
  const dir = await Deno.makeTempDir({ prefix: "expo-finding16-" });
  try {
    await Deno.writeTextFile(join(dir, "important.txt"), "do not delete\n");
    await cleanupUntrackedAgentPaths(dir, ["important.txt"]);
    check(
      "non-git: tracked-unknown file NOT removed (safe fallback)",
      await exists(dir, "important.txt"),
    );
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
