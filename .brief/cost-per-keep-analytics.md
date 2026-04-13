# Cost-per-keep analytics — design sketch

**Status:** design doc. Primitives mostly exist; rollup + CLI stop-flag
are new work.
**Date:** 2026-04-13.
**Coined during:** Shakedown A post-mortem, when I asked "how do you
figure out what the top of the asymptotic s-curve looks like?" and we
named the metric.

---

## The metric

**Cost per keep** = total USD spent on agent iterations ÷ count of
KEPT variants in that window.

A single number that answers: *how much money did each real
improvement cost us?*

### Why it matters

- **S-curve detection.** Early in a refine project, keeps come cheap —
  the agent finds obvious wins and the rubric passes them. As the
  codebase matures, keeps get rarer and each one takes multiple
  exploratory iterations. Cost-per-keep climbs. When it climbs past a
  threshold, you are on the flat top of the s-curve and further
  spending is gambling.
- **Objective stop signal.** Without it, "when to stop a refine run"
  is gut feel. With it, `--stop-at-cost-per-keep 3` is a declarative
  exit criterion that prevents runaway spend on a codebase that's
  already well-polished.
- **Rubric comparison.** "Error-message rubric: $0.60/keep. Performance
  rubric: $4.20/keep. Which rubric should we run tonight?" The number
  lets you budget your attention.
- **Pathology detection.** A run with 0 keeps has infinite
  cost-per-keep — an obvious red flag. A run with many cheap keeps
  but NO gates should be suspect ("keeping everything is also bad").

---

## Example: the gambling run

> *Imagine pointing expo at this research repo — the grab-bag of
> markdown notes and cloned source code at github-repos/.*
>
> No `deno.json`, no `Makefile`, no tests. `--auto` finds zero gates
> to seed. Every iteration's "keep" decision comes entirely from the
> agent's rubric compliance — there's no objective ratchet.
>
> Agent proposes "rewrite notes.md for clarity." Rubric says "improve
> writing." Agent says KEEP. Every iteration: KEEP. Run 100 iterations,
> spend $500, "cost per keep" = **$5**.
>
> That $5/keep number is LYING to you. All 100 keeps might be slop —
> the agent rewrote your original thinking into generic LLM prose. But
> the metric looks healthy because there's no objective failure signal.

This is why cost-per-keep is **necessary but not sufficient**. It
needs to be read alongside **discard rate** and **gate-failure rate**
to mean anything. A healthy s-curve top looks like:

- Cost-per-keep rising (from, say, $0.50 early to $3+ late)
- Discard rate rising (from 10% to 60%+)
- Gate failures nonzero (proving the ratchet is real)
- Kept change-summaries getting shorter and more marginal

A pathological "gambling" top looks like:

- Cost-per-keep steady ("healthy")
- Discard rate near 0
- Gate failures = 0 (because there are no gates)
- Kept change-summaries all look the same

If you don't have gates, **cost-per-keep is meaningless.** Budget your
caps on wall-clock and total-spend; don't use cost-per-keep to judge
quality.

---

## Computation

All primitives exist in the bus event log:

- Every `done` event carries `payload.cost` (USD) per agent spawn.
- Every `variant.status = "kept"` in the manifest is a keep.
- Every `refine_verdict: discard` progress signal is a discard.
- Every `gate_failed` is a gate-forced-discard.
- Every `scope_violation` is a scope-forced-discard.

Rollup:

```typescript
type RollupMetrics = {
  window: "session" | "last5" | "lifetime";
  iterations: number;
  keeps: number;
  rubricDiscards: number;
  gateFailures: number;
  scopeViolations: number;
  infraFailures: number;      // see Finding #3 — API 5xx, net timeouts
  totalCost: number;
  costPerKeep: number | null; // null when keeps === 0
  keepRate: number;           // keeps / iterations
  discardRate: number;        // all-discard / iterations
};
```

Null-safe: when `keeps === 0`, return `costPerKeep: null` and render
as `"∞"` or `"— (0 keeps)"`. Do NOT return `Infinity` — it serializes
as `null` in strict JSON anyway and is visually confusing.

---

## Where to surface it

### Final summary (immediate, zero design cost)

Today's final banner already shows iterations, kept, discarded, cost.
Add one line:

```
=== Refine Result ===
  Verdict:    CONVERGED
  Iterations: 20
  Kept:       6
  Discarded:  12
  Cost:       $8.42
  Cost/keep:  $1.40             # <-- new
  Discard %:  60%               # <-- new, paired signal
```

### During the run (iterative feedback)

Every 5 iterations, emit a `progress` signal with the current
rolling cost-per-keep:

```jsonl
{"type": "progress", "payload": {"kind": "metrics",
  "message": "iteration 15/20 — cost/keep $1.80 (up from $0.90 at iter 10)"}}
```

This lets dashboard consumers (and the planned midrun-steering hook)
react to cost creep before the run ends.

### Stop criterion (declarative exit)

New flag: `--stop-at-cost-per-keep <N>`. Checked at end of each
iteration after the keep/discard verdict is recorded:

```typescript
if (opts.stopAtCostPerKeep && keeps > 0) {
  const cpk = totalCost / keeps;
  if (cpk >= opts.stopAtCostPerKeep) {
    // Verdict: COST_CEILING
    return buildResult("COST_CEILING", ...);
  }
}
```

Require `keeps > 0` before the check fires — otherwise a run that
gets to iteration 1 with 0 keeps would immediately exit on the
divide-by-infinity.

New verdict enum: `COST_CEILING`. Distinct from `EXHAUSTED` (too many
consecutive discards), `MAX_ITERATIONS`, `WALL_CLOCK_EXCEEDED`. An
orchestrator can now tell "I hit my spend ceiling" from "I ran out
of ideas."

### REFINE.md entry (cross-session memory)

At the end of every run, `updateRefineMd` writes a session log. Add
cost-per-keep to the log line so future sessions can see the trend:

```markdown
## Sessions

- **2026-04-13 Shakedown A**: 10 iter, 0 keep, $8.84, cost/keep $∞
  (all 5 API 500s + 2 budget kills — not indicative)
- **2026-04-12 self-playtest session 1**: 21 iter, 16 keep, $N.NN,
  cost/keep $M.MM
```

Watching this trend over multiple sessions is the actual s-curve view.

### Dashboard card (nice-to-have)

`/gates.html` has the variant list; `/runs.html` has the run list.
New `/analytics.html` (or just a card on runs.html) showing:

- Cost-per-keep over time (line chart, x = iteration, y = $)
- Cost-per-keep by rubric (bar chart)
- Discard-rate overlay on the same chart (secondary axis)

Low priority — the CLI summary is 90% of the value.

---

## Schema change

Add to `RefineOptions` in refine.ts:

```typescript
export interface RefineOptions {
  // ... existing ...
  /**
   * If set, stop the loop when cumulative cost / kept-count ≥ this
   * value. Guards against runaway spend once improvements dry up.
   * Only checked after keeps > 0; a run that never keeps will not
   * trigger this (it'll exit via EXHAUSTED or MAX_ITERATIONS).
   */
  stopAtCostPerKeep?: number;
}
```

Add to `RefineResult`:

```typescript
export interface RefineResult {
  // ... existing ...
  costPerKeep: number | null;
  keepRate: number;
  discardRate: number;
  // Existing verdict union extends:
  verdict: "CONVERGED" | "MAX_ITERATIONS" | "EXHAUSTED"
         | "WALL_CLOCK_EXCEEDED" | "COST_CEILING";
}
```

---

## What NOT to build

- **Auto-calibration of the threshold.** Tempting to learn from
  history — "if past 3 sessions averaged $1.20/keep, set the threshold
  to $3." Too clever. User-set thresholds are fine; a flag default
  is fine; auto-tuning hides the number.
- **Quality scoring for keeps.** Hard to get right without human
  review or a separate judge agent. Out of scope for the metric —
  cost-per-keep is the signal, quality is a separate axis.
- **Cost-per-keep as the ONLY stop criterion.** Keep
  `--max-iterations`, `--run-timeout`, `--total-budget` as independent
  caps. Cost-per-keep is additive, not replacement.
- **Normalizing across repos.** "Cost-per-keep in expo is $1, in
  smallstore it's $4 — expo is better!" No — different codebases,
  different rubrics, different LOC, different gate costs. Only
  comparable within the same repo+rubric.

---

## How it pairs with other shakedown findings

- **Finding #3 (API 5xx classification).** If we don't filter infra
  failures out of the iteration count, cost-per-keep gets inflated by
  failed-spawn noise. Fix #3 first so the metric is meaningful.
- **Finding #2 (scope parser).** Silently-dropped scope globs caused
  false scope-violations which inflated discard count in the
  shakedown. Also needs fixing before cost-per-keep numbers are
  trustworthy.
- **Midrun steering (.brief/midrun-steering.md).** Steering hook
  could trigger on rising cost-per-keep: "cost-per-keep jumped from
  $1 to $4 in the last 5 iterations — here's guidance to narrow
  focus." Nice emergent behavior.

---

## Open questions

1. **Rolling window size.** Cumulative cost-per-keep is a lagging
   indicator. A rolling "last-5-iterations" view might catch
   deterioration earlier. Ship cumulative first, add rolling later
   once we have real data on which timescale matters.

2. **Per-variant cost attribution.** Today we track agent cost by
   iteration, not by snapshot commit. Linking spend to the
   `kept`/`discarded` outcome makes the metric per-variant and opens
   richer analysis ("the most expensive keep was variant 017 at
   $1.40"). Punt until needed.

3. **Gate-run cost inclusion.** Gates fire after every iteration
   (deno_test, ssrf-tests, etc.). On this repo they're cheap
   (<2s total), but on a repo with a slow integration gate,
   wall-clock gate time could dominate. Decide whether to count
   gate-time as "cost" or only agent-spawn dollars. Default to
   dollars (less confusing).

4. **Null discard.** If `keeps === 0 && iterations === 1`, we're one
   iteration in and still need to see more. Don't early-exit on
   `COST_CEILING` unless we have at least some keeps to divide into.
   Rule of thumb: require `keeps >= 1 && iterations >= 3` before the
   check fires.

---

## Concrete first-ship scope

Smallest useful slice:

1. Add `costPerKeep`, `keepRate`, `discardRate` to `RefineResult`.
2. Print the three numbers in the final banner.
3. Add the rolling `[metrics]` signal every 5 iterations.
4. Write to REFINE.md session log.
5. **Do not** ship `--stop-at-cost-per-keep` on first pass. Surface
   the signal first, see how it looks across 3-4 real runs, THEN
   design the threshold flag once we know what numbers look healthy.

Estimated LOC: ~60 plus test. Shippable in one tight session.

---

## Related: the "pathological gambling run" as shakedown tier-4

Running expo on the research repo (no gates, no tests, markdown-only)
would be *expensive entertainment*. User estimated ~$500 for a real
run. Not recommended, but:

- Would test expo's behavior in a zero-gate regime.
- Would stress-test rubric-only scope enforcement.
- Would produce a natural "cost-per-keep is misleading" case study —
  worth capturing as illustration material for this doc.

File this as a rainy-day shakedown experiment. If ever run, capture
per-iteration event-file + every kept variant's REFINE.md update so
the "why this metric lies without gates" story can be told with
real numbers rather than hypothetical ones.
