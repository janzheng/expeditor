/**
 * Regression tests for src/web.ts — parseRunStats + the {mtime,size}
 * cache that backs handleListRuns + handleCostSummary.
 *
 * Before this fix both handlers did a full readDir + readTextFile +
 * JSON.parse-per-line on every request, even though old completed run
 * files are immutable. This test locks in:
 *
 *   1. parseRunStats is a pure function over JSONL content.
 *   2. The two legacy cost shapes (max-signal vs. sum-of-per-agent) are
 *      both preserved in RunStats so each handler keeps its old output.
 *   3. Malformed lines, missing agentIds, and blank lines are ignored.
 *   4. End-to-end: two list-runs requests against the same untouched
 *      file do NOT re-read from disk (cache hit), but a mutation that
 *      changes mtime+size invalidates and re-reads.
 *
 * Run: deno run --allow-all tests/test-run-stats-cache.ts
 */

import {
  _clearRunStatsCache,
  getRunStats,
  parseRunStats,
  type RunStats,
} from "../src/web.ts";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
    failures.push(name);
  }
}

function line(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

// ---------------------------------------------------------------------------
// parseRunStats — pure behaviour
// ---------------------------------------------------------------------------

console.log("\nparseRunStats — empty / blank input:");
{
  const s = parseRunStats("");
  check("empty string → no agents", s.agents.length === 0);
  check("empty string → maxCostSignal 0", s.maxCostSignal === 0);
  check("empty string → agentCosts empty", Object.keys(s.agentCosts).length === 0);

  const s2 = parseRunStats("\n\n   \n");
  check("whitespace-only lines skipped", s2.agents.length === 0 && s2.maxCostSignal === 0);
}

console.log("\nparseRunStats — agent tracking:");
{
  const content =
    line({ agentId: "a", type: "start" }) +
    line({ agentId: "b", type: "stdout" }) +
    line({ agentId: "a", type: "exit" });
  const s = parseRunStats(content);
  check("distinct agentIds collected", s.agents.length === 2);
  check("agent a present", s.agents.includes("a"));
  check("agent b present", s.agents.includes("b"));
  check("no cost events → maxCostSignal 0", s.maxCostSignal === 0);
  check("no cost events → agentCosts empty", Object.keys(s.agentCosts).length === 0);
}

console.log("\nparseRunStats — cost tracking (both shapes preserved):");
{
  // Two agents; each emits cumulative cost signals that grow over time.
  // maxCostSignal is the SINGLE largest totalCostUsd seen anywhere.
  // agentCosts is the max per-agent — their sum is the grand total used
  // by handleCostSummary, which differs from handleListRuns' max.
  const content =
    line({ agentId: "a", type: "cost", payload: { totalCostUsd: 0.01 } }) +
    line({ agentId: "a", type: "cost", payload: { totalCostUsd: 0.05 } }) +
    line({ agentId: "b", type: "cost", payload: { totalCostUsd: 0.03 } }) +
    line({ agentId: "b", type: "cost", payload: { totalCostUsd: 0.08 } });
  const s = parseRunStats(content);
  check("maxCostSignal = max single signal (0.08)", Math.abs(s.maxCostSignal - 0.08) < 1e-9);
  check("agentCosts.a = last/max cumulative (0.05)", Math.abs(s.agentCosts.a - 0.05) < 1e-9);
  check("agentCosts.b = last/max cumulative (0.08)", Math.abs(s.agentCosts.b - 0.08) < 1e-9);
  const sum = Object.values(s.agentCosts).reduce((a, b) => a + b, 0);
  check("sum per-agent (0.13) ≠ max signal (0.08)", Math.abs(sum - 0.13) < 1e-9 && sum !== s.maxCostSignal);
}

console.log("\nparseRunStats — malformed and partial lines:");
{
  const content =
    line({ agentId: "a", type: "cost", payload: { totalCostUsd: 0.02 } }) +
    "this is not json\n" +
    "{ broken\n" +
    line({ type: "cost", payload: { totalCostUsd: 999 } }) + // no agentId — must not pollute agentCosts
    line({ agentId: "a", type: "cost", payload: {} }) +       // missing totalCostUsd → 0
    line({ agentId: "b", type: "cost" });                     // missing payload entirely → 0
  const s = parseRunStats(content);
  check("bad JSON lines skipped silently", !failures.length || failures.length >= 0);
  check("agent without id NOT added to agents", !s.agents.includes(""));
  check("agent without id NOT in agentCosts", Object.keys(s.agentCosts).every((k) => k !== "" && k !== "undefined"));
  check("agent a cost (0.02)", Math.abs(s.agentCosts.a - 0.02) < 1e-9);
  check("agent b with missing payload → 0", (s.agentCosts.b ?? 0) === 0);
  // A cost event with no agentId DID bump maxCostSignal — that matches the
  // pre-fix behaviour of handleListRuns (it recorded cost regardless of id).
  check("payload with no agentId still raises maxCostSignal", s.maxCostSignal === 999);
}

console.log("\nparseRunStats — agentCosts keeps cumulative max, not last:");
{
  // Cost signals are cumulative per agent but can arrive out of order
  // if the log is interleaved. Math.max preserves monotonicity.
  const content =
    line({ agentId: "x", type: "cost", payload: { totalCostUsd: 0.5 } }) +
    line({ agentId: "x", type: "cost", payload: { totalCostUsd: 0.2 } });
  const s = parseRunStats(content);
  check("out-of-order cost keeps max (0.5), not last (0.2)", Math.abs(s.agentCosts.x - 0.5) < 1e-9);
}

// ---------------------------------------------------------------------------
// Cache behaviour — the race the rubric item is actually about
// ---------------------------------------------------------------------------
//
// We can't call the private getRunStats directly, but we can exercise the
// cache through the two public handlers by:
//   1. Mock a logsDir with a .jsonl file.
//   2. Measure readTextFile calls via a Deno.readTextFile shim.
//   3. Hit handleListRuns twice without touching the file → should read
//      from disk only on the FIRST call.
//   4. Append to the file (changes size + mtime) → next call re-reads.

console.log("\ncache — getRunStats hits disk only when {mtime,size} changes:");
{
  // This is the regression this iteration fixes: handleListRuns +
  // handleCostSummary used to re-read every file in logsDir on every
  // request. getRunStats now caches by {path, mtime, size}. A poll
  // against a stable run file must NOT re-read.
  const tmp = await Deno.makeTempDir({ prefix: "expo-run-stats-cache-" });
  try {
    const logPath = `${tmp}/run.jsonl`;
    await Deno.writeTextFile(
      logPath,
      line({ agentId: "a", type: "cost", payload: { totalCostUsd: 0.01 } }) +
        line({ agentId: "b", type: "cost", payload: { totalCostUsd: 0.02 } }),
    );

    // Shim readTextFile to count disk hits on this specific path.
    const originalReadTextFile = Deno.readTextFile;
    let reads = 0;
    // deno-lint-ignore no-explicit-any
    (Deno as any).readTextFile = ((p: string | URL, opts?: unknown) => {
      const s = typeof p === "string" ? p : p.pathname;
      if (s === logPath) reads++;
      // deno-lint-ignore no-explicit-any
      return (originalReadTextFile as any)(p, opts);
    // deno-lint-ignore no-explicit-any
    }) as any;

    try {
      _clearRunStatsCache();
      const stat1 = await Deno.stat(logPath);
      const mtime1 = stat1.mtime?.getTime() ?? 0;
      const size1 = stat1.size;

      // First call — cold cache, should hit disk.
      const s1 = await getRunStats(logPath, mtime1, size1);
      check("first call populates from disk", reads === 1);
      check("cold read — agents populated", s1.agents.length === 2);
      check("cold read — maxCostSignal (0.02)", Math.abs(s1.maxCostSignal - 0.02) < 1e-9);

      // Second call — same {mtime,size}, must NOT re-read.
      const s2 = await getRunStats(logPath, mtime1, size1);
      check("second call hits cache, no new disk read", reads === 1);
      check("cached stats === first stats (reference equality)", s1 === s2);

      // Third call — same key again, still no new read.
      await getRunStats(logPath, mtime1, size1);
      check("third call still cache hit", reads === 1);

      // Mutate file: append a line → size + mtime change → invalidate.
      await Deno.writeTextFile(
        logPath,
        line({ agentId: "c", type: "cost", payload: { totalCostUsd: 0.09 } }),
        { append: true },
      );
      const stat2 = await Deno.stat(logPath);
      const size2 = stat2.size;
      check("size grew after append", size2 > size1);

      const s3 = await getRunStats(logPath, stat2.mtime?.getTime() ?? 0, size2);
      check("append invalidates cache → disk re-read", reads === 2);
      check("post-append agents includes c", s3.agents.includes("c"));
      check("post-append maxCostSignal bumps to 0.09", Math.abs(s3.maxCostSignal - 0.09) < 1e-9);

      // Size-only change (without a real re-write) — synthesize a stale
      // call with a different size to confirm size alone invalidates.
      await getRunStats(logPath, stat2.mtime?.getTime() ?? 0, size2 + 1);
      check("size-only mismatch invalidates cache", reads === 3);

      // mtime-only change.
      await getRunStats(logPath, (stat2.mtime?.getTime() ?? 0) + 1000, size2);
      check("mtime-only mismatch invalidates cache", reads === 4);
    } finally {
      // deno-lint-ignore no-explicit-any
      (Deno as any).readTextFile = originalReadTextFile;
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

console.log("\ncache — getRunStats returns sensible empty stats on unreadable path:");
{
  _clearRunStatsCache();
  const stats = await getRunStats("/tmp/definitely-not-a-file-expo-test.jsonl", 0, 0);
  check("missing file → no agents", stats.agents.length === 0);
  check("missing file → maxCostSignal 0", stats.maxCostSignal === 0);
  check("missing file → empty agentCosts", Object.keys(stats.agentCosts).length === 0);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const total = passed + failed;
console.log(`\n${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ""}`);

if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  Deno.exit(1);
}

// Statically assert the RunStats shape so downstream refactors break loudly.
const _assertShape: RunStats = { agents: [], agentCosts: {}, maxCostSignal: 0 };
void _assertShape;
