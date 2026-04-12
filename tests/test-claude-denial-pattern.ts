/**
 * Unit tests for the Bash permission-denial pattern produced by the Claude
 * adapter. Locks in that the ledger key preserves the full command
 * structure (quoted paths, pipes, env prefixes, command lists) instead of
 * collapsing everything to `Bash(<argv0>:*)`.
 *
 * Run:  deno run --allow-all tests/test-claude-denial-pattern.ts
 */

import {
  buildBashDenialPattern,
  parseStreamJsonLine,
} from "../src/claude-adapter.ts";
import type { DenialDetail } from "../src/types.ts";

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

// ---------------------------------------------------------------------------
// buildBashDenialPattern — pure helper
// ---------------------------------------------------------------------------

console.log("\nbuildBashDenialPattern — wraps command verbatim:");
{
  check(
    "simple command",
    buildBashDenialPattern("git status") === "Bash(git status)",
  );
  check(
    "preserves all args",
    buildBashDenialPattern("git push --force origin main") ===
      "Bash(git push --force origin main)",
  );
  check(
    "preserves quoted paths",
    buildBashDenialPattern('cp "my file.txt" /tmp/') ===
      'Bash(cp "my file.txt" /tmp/)',
  );
  check(
    "preserves single-quoted args",
    buildBashDenialPattern("echo 'hello world'") ===
      "Bash(echo 'hello world')",
  );
  check(
    "preserves pipes",
    buildBashDenialPattern("ls | grep foo") === "Bash(ls | grep foo)",
  );
  check(
    "preserves env prefixes",
    buildBashDenialPattern("GIT_TRACE=1 git log") ===
      "Bash(GIT_TRACE=1 git log)",
  );
  check(
    "preserves command lists",
    buildBashDenialPattern("cd /tmp && rm -rf build") ===
      "Bash(cd /tmp && rm -rf build)",
  );
  check(
    "preserves subshells",
    buildBashDenialPattern("echo $(date)") === "Bash(echo $(date))",
  );
  check(
    "preserves leading whitespace literally",
    buildBashDenialPattern("  git status") === "Bash(  git status)",
  );
  check(
    "empty string is permitted",
    buildBashDenialPattern("") === "Bash()",
  );
}

// ---------------------------------------------------------------------------
// Collision avoidance — the behavior the fix is about
// ---------------------------------------------------------------------------

console.log("\nCollision avoidance — structurally-different commands get distinct keys:");
{
  const a = buildBashDenialPattern("git push --force origin main");
  const b = buildBashDenialPattern("git status");
  const c = buildBashDenialPattern("GIT_TRACE=1 git log");
  check("git push --force ≠ git status", a !== b);
  check("env-prefixed git ≠ bare git", c !== b);
  check("all three keys distinct", new Set([a, b, c]).size === 3);

  // Quoted-path regression — previously `"my file.txt"` split to `"my`
  const q1 = buildBashDenialPattern('cp "my file.txt" /tmp/');
  const q2 = buildBashDenialPattern('cp "other file.txt" /tmp/');
  check("quoted path preserved (no split on whitespace)", q1.includes('"my file.txt"'));
  check("distinct quoted-path commands get distinct keys", q1 !== q2);

  // Pipe regression — previously `ls | grep foo` collapsed to `Bash(ls:*)`
  const p1 = buildBashDenialPattern("ls | grep foo");
  const p2 = buildBashDenialPattern("ls | grep bar");
  check("pipe structure preserved", p1.includes("|") && p1.includes("grep foo"));
  check("distinct pipe commands get distinct keys", p1 !== p2);
}

// ---------------------------------------------------------------------------
// End-to-end: parseStreamJsonLine wiring
// ---------------------------------------------------------------------------

console.log("\nparseStreamJsonLine — object-form Bash denial flows through:");
{
  const line = JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: "sess-1",
    is_error: false,
    result: "ok",
    duration_ms: 10,
    num_turns: 1,
    usage: {},
    permission_denials: [
      {
        tool_name: "Bash",
        tool_use_id: "t1",
        tool_input: {
          command: "git push --force origin main",
          description: "force push feature branch",
        },
      },
    ],
  });
  const signals = parseStreamJsonLine(line, { agentId: "a1" });
  const done = signals.find((s) => s.type === "done");
  check("emits a done signal", !!done);
  const payload = done!.payload as Record<string, unknown>;
  const details = payload.denialDetails as DenialDetail[] | undefined;
  const patterns = payload.permissionDenials as string[] | undefined;
  check("denialDetails has one entry", details?.length === 1);
  check(
    "pattern is the full command verbatim",
    details?.[0]?.pattern === "Bash(git push --force origin main)",
  );
  check("toolName is Bash", details?.[0]?.toolName === "Bash");
  check(
    "full command preserved in detail.command",
    details?.[0]?.command === "git push --force origin main",
  );
  check(
    "description flows through",
    details?.[0]?.description === "force push feature branch",
  );
  check(
    "permissionDenials mirrors the rich pattern",
    patterns?.length === 1 &&
      patterns[0] === "Bash(git push --force origin main)",
  );
}

console.log("\nparseStreamJsonLine — non-Bash denials pass through untouched:");
{
  const line = JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: "sess-2",
    is_error: true,
    result: "blocked",
    duration_ms: 5,
    num_turns: 1,
    usage: {},
    permission_denials: [
      {
        tool_name: "WebFetch",
        tool_use_id: "t2",
        tool_input: { url: "https://example.com" },
      },
    ],
  });
  const signals = parseStreamJsonLine(line, { agentId: "a2" });
  const failed = signals.find((s) => s.type === "failed");
  check("emits a failed signal", !!failed);
  const payload = failed!.payload as Record<string, unknown>;
  const details = payload.denialDetails as DenialDetail[] | undefined;
  check(
    "WebFetch pattern is just toolName (no Bash wrapper)",
    details?.[0]?.pattern === "WebFetch",
  );
  check("WebFetch has no command field", details?.[0]?.command === undefined);
}

console.log("\nparseStreamJsonLine — string-form denials still work:");
{
  const line = JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: "sess-3",
    is_error: false,
    result: "ok",
    duration_ms: 1,
    num_turns: 1,
    usage: {},
    permission_denials: ["Bash(rm:*)", "Write"],
  });
  const signals = parseStreamJsonLine(line, { agentId: "a3" });
  const done = signals.find((s) => s.type === "done");
  const payload = done!.payload as Record<string, unknown>;
  const details = payload.denialDetails as DenialDetail[] | undefined;
  const patterns = payload.permissionDenials as string[] | undefined;
  check("two details emitted", details?.length === 2);
  check("string denial 1 pattern preserved", details?.[0]?.pattern === "Bash(rm:*)");
  check("string denial 2 pattern preserved", details?.[1]?.pattern === "Write");
  check(
    "permissionDenials preserves order",
    patterns?.[0] === "Bash(rm:*)" && patterns?.[1] === "Write",
  );
}

console.log("\nparseStreamJsonLine — multiple Bash denials stay distinct in ledger keys:");
{
  // Core regression: two structurally-different git commands must not collapse
  // to the same pattern (previously both would become `Bash(git:*)`).
  const line = JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: "sess-4",
    is_error: false,
    result: "ok",
    duration_ms: 10,
    num_turns: 1,
    usage: {},
    permission_denials: [
      { tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "git push --force" } },
      { tool_name: "Bash", tool_use_id: "t2", tool_input: { command: "git status" } },
      { tool_name: "Bash", tool_use_id: "t3", tool_input: { command: 'cp "my file" /tmp/' } },
    ],
  });
  const signals = parseStreamJsonLine(line, { agentId: "a4" });
  const done = signals.find((s) => s.type === "done");
  const payload = done!.payload as Record<string, unknown>;
  const patterns = payload.permissionDenials as string[];
  check("three distinct patterns (no collision)", new Set(patterns).size === 3);
  check(
    "push --force preserved",
    patterns.includes("Bash(git push --force)"),
  );
  check("status preserved", patterns.includes("Bash(git status)"));
  check(
    "quoted path preserved end-to-end",
    patterns.includes('Bash(cp "my file" /tmp/)'),
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  Deno.exit(1);
}
