# Shakedown A round 3 — full-validation re-run on expo (2026-04-13 evening)

Fresh `.refine/` state (cleaned up earlier). All 10 shakedown fixes
applied. Same rubric, scope, caps as rounds 1-2. Binary rebuilt at
`f576db6`-era code.

## Result summary

**Verdict: EXHAUSTED.** 3 iterations, 0 session keeps, $7.45 spent.

| Metric | Round 1 | Round 2 | **Round 3** |
|--------|---------|---------|-------------|
| Verdict | MAX_ITERATIONS | CONVERGED | **EXHAUSTED** |
| Iterations | 10 | 9 | 3 |
| Session keeps | 0 | 0 | 0 |
| Gate fails | 1 (scope bug) | 1 (real typecheck) | 1 (real deno_test) |
| Budget overruns | 2 | 1 | **3** |
| API 500s | 5 | 0 | 0 |
| Cost | $8.84 | $8.64 | $7.45 |

Three "0 session keeps" outcomes with three very different reasons.
Round 3 is informative precisely BECAUSE it's not clean.

## Per-iteration breakdown

| Iter | Proposal | Outcome | Cost |
|------|----------|---------|------|
| 1 | `parseFloat` NaN validation for budget flags | budget_exceeded at $2.12 | — |
| 2 | workflow.ts "Unknown sandbox preset" error lists presets | `keep` → `gate_failed: deno_test (exit 1)` | — |
| 3 | Debugging pre-existing test failure (`t06`) | budget_exceeded at **$3.15** (> $2 cap) | — |

After 3 consecutive discards with no available branching target, the
loop hit `EXHAUSTED` and exited.

## New findings from this round

### Finding #12 (LOW-MEDIUM) — per-agent budget overrun can exceed cap significantly

**Observed:** iter-3 hit **$3.15 on a $2 per-agent budget** — 57% overrun.
Iter-1 and iter-2 were much more modest (6% and 9% overruns).

**Why:** cost-guard can't interrupt an in-flight `Bash` tool call. The
kill signal arrives when cost crosses the threshold, but if the agent
is mid-`deno task test` (which takes 60+ seconds on expo's test suite),
the agent keeps racking up cost until the Bash returns and the kill
signal can be processed.

**Severity:** LOW-to-MEDIUM. $1.15 overrun on a single agent is
uncomfortable but not catastrophic; total-budget ($15 in this run) still
bounded the damage. But imagine a `--per-agent-budget 5` run on a repo
with a 10-minute integration test gate — the overrun could be >$10.

**Fix direction:**
1. **Preempt long Bash calls** — when cost-guard fires, also `kill -9`
   the subprocess's process group (we already use `setsid`, so the
   group is there). Abort the Bash mid-flight.
2. **Softer:** emit a "cost-budget-warning" signal at 80% of budget;
   the agent can self-truncate before a kill arrives. Requires prompt
   framing the agent to check this mid-task.
3. **Document the loose cap** as a known behavior in QUICKSTART.md —
   per-agent budget is a floor, actual spend can be 50%+ over on
   long-running tool calls.

### Observation: the rubric is slightly too tight for current expo state

Iter-2 made a LEGITIMATE improvement (workflow.ts error message
listing available sandbox presets — the exact same fix attempted in
rounds 1 + 2 and in shakedown B tier-1's iter-2). This time it
reached keep + scope-clean and was force-discarded by `deno_test`
because a test in `test-workflow-sandbox-error.ts` asserted the exact
OLD error format.

This is NOT an expo-loop bug — the gate caught a test that needs
updating alongside the fix. But it means the agent would need to
update BOTH the code AND the test in the same iteration for the fix
to land. That's within the rubric ("new or updated test passes") but
the agent's pattern tends to be "update production, then add a new
test for the new behavior" — leaving the old test that asserted the
old behavior in place.

Possible rubric refinement for a future round:
> Before committing a production change, check if any existing test
> asserts the OLD behavior. If so, UPDATE that test in the same
> iteration — don't leave it to break the gate.

Not shipping this change; the rubric is committed and reusable, and
the improvement is meta.

## Validation of today's fixes

All 10 shipped fixes held under round 3:

- **Finding #1** (rejectFlagAsPositional) — didn't surface (no `--help`
  typos in this run, by construction).
- **Finding #2** (multi-value `--scope`) — visible on banner: "Scope: 2
  glob(s)" with both `src/**` and `tests/**`.
- **Finding #3** (infra failure classifier) — 0 API 500s this run, fix
  latent but ready.
- **Finding #4** (stale-baseline check) — silently passed (fresh
  `.refine/` state, nothing to detect).
- **Finding #5** (banner gate count) — worked.
- **Finding #6** (session vs lifetime) — banner reads "Kept: 0 this
  session (1 lifetime)" correctly.
- **Finding #7/#10** (branch HEAD stays put) — confirmed; expo's main
  branch at `f576db6` before + after.
- **Finding #8** (expo-internal path filter) — no false-positive
  scope violations.
- **Finding #9** (auto-resolved from #7/#10) — n/a.
- **Finding #11** (scope viols separate from gate fails) — banner
  shows "Gate fails: 1" (the real deno_test failure), no "Scope viols"
  line printed (correct since count was 0).

Nothing regressed. The round 3 "0 keeps" outcome is NOT a fix
regression — it's the agent running into the realities of a mature
rubric-scoped codebase where remaining targets have costs.

## Conclusion

Round 3 = real loop behavior on a mature codebase. Compared to:
- Round 1 (buggy loop) — EXHAUSTED was noise
- Round 2 (loose `--scope` + bugs) — CONVERGED was clean signal
- Round 3 (clean loop) — EXHAUSTED reflects gate-filter doing its job

**Actual gap identified:** Finding #12 (budget overrun on long Bash
calls). Worth fixing eventually; not a blocker.

The other validation data point: the loop CORRECTLY refuses to keep
iter-2's sandbox-preset fix because a real test asserts the old
behavior. That's gates working. A human reviewer would land the fix
with a test update; the loop (under the current rubric prompting) did
the fix without the test update and got caught. Not a loop bug.
