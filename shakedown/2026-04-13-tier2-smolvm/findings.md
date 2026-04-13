# Shakedown B tier-2 on smolvm (2026-04-13 evening)

Polyglot repo: Rust core + Deno/TS CLI + TS SDK. 15.9k TS LOC in
`cli/`, `sdk-ts/`, `tests/`. Scope was TS-only. Running on branch
`shakedown-tier2` of smolvm to isolate Finding #7/#10 commits (though
the fix is in place and branch HEAD would not have advanced anyway).

## Result summary

**Verdict: EXHAUSTED.** 3 iterations, 0 session keeps, $3.24 spent,
8 min duration. Every iteration hit the SAME `deno_test` gate.

Per-iter breakdown:

| Iter | Proposal | Outcome |
|------|----------|---------|
| 1 | `parseFlags` errors "flag --X requires a value" when flag expects value | `keep` → `gate_failed: deno_test` |
| 2 | (agent self-discarded — small 11-line proposal rejected on own review) | discard |
| 3 | Fix `job.timeout_secs` → `job.timeoutSecs` naming consistency in cli | `keep` → `gate_failed: deno_test` |

## The refine-update-md agent diagnosed it

Final REFINE.md writer noticed: "all 3 candidates failed the same
`deno_test` gate, suggesting the gate is failing on baseline."

Confirmed empirically:

```
$ cd smolvm && deno task test
==========================================
  CX04 smolvm — Basic Machine Test
==========================================

Health Check:
error: Uncaught (in promise) TypeError: error sending request for url
  (http://127.0.0.1:9090/health): Connection refused (os error 61)
```

smolvm's `deno task test` is an INTEGRATION TEST that hits a running
`smolvm serve` instance at 127.0.0.1:9090. With no server running,
the test errors out. The baseline was broken before refine ever
spawned its first iteration.

## Finding #13 (MEDIUM) — `--auto` seeds gates without pre-flight check

This is exactly Hypothesis #1 from `.brief/other-repo-shakedown.md`:
> `--auto` seeds a gate that fails from the start.

The mitigation the brief proposed was: "Run `gate check` before agent
spawn." We shipped `expo refine . gate check` as a separate command
but `expo refine . --auto` does NOT invoke it before starting the
refine loop. So a broken baseline gate silently sabotages every
iteration.

**Impact on tier-2:** iter-1's `parseFlags` validation and iter-3's
`timeout_secs`→`timeoutSecs` naming fix were BOTH legitimate keep-
quality changes. Both force-discarded for reasons orthogonal to
their correctness.

**Severity:** MEDIUM. Loud and consistent symptom. Users will figure
it out within one failed run because the error message says
"gate_failed: deno_test (exit 1) — forcing discard" on every
iteration. But: each failed iteration burns $0.60-1.00 of budget
before the user notices. On an 8-iter run that's $5-8 wasted on a
diagnosable-in-advance condition.

**Fix direction:**

1. **Pre-flight on startup.** Before spawning iter-1, run the
   seeded gates against the baseline. If any fail, refuse to start
   and point at the failing gate:
   ```
   ⚠ Baseline gate 'deno_test' fails with exit 1.
     stderr: Connection refused (os error 61)...

     Your gates need to pass on the unmodified tree before refine can
     use them as a ratchet. Options:
     - Fix the baseline failure manually, then re-run refine
     - Override gate via --gate "deno_test=<new command>"
     - Remove gate via `expo refine . gate remove deno_test`
   ```

2. **Softer:** add a `--skip-baseline-check` escape hatch for cases
   where the baseline is intentionally failing (e.g. TDD red-to-green
   work). But default to refusing, same pattern as Finding #4's
   stale-baseline.

3. **Auto-classify test-environment failures differently.** A
   `Connection refused` / `EADDRNOTAVAIL` is almost certainly "your
   test needs a service running" not "your test logic is broken."
   Surface this distinction to the user explicitly.

This is the last of the 3 hypotheses from the shakedown brief that
had been untested (the others were #10 polyglot and #11 monorepo —
polyglot was partially tested by tier-2 and worked fine at the scope-
glob level).

## Finding #14 (LOW) — `--auto` on polyglot seeds both language's gates

Banner:
```
Gates:  2 seeded on baseline
          • deno_test: deno task test
          • cargo_test: cargo test --quiet
```

smolvm's `--auto` correctly detected BOTH `deno.json` (→ `deno_test`)
AND `Cargo.toml` (→ `cargo_test`). Both seeded on baseline. Since the
agent was scoped to TS-only and couldn't touch Rust, `cargo_test`
would never fail on any of its iterations (Rust state unchanged) and
`deno_test` was the one that mattered.

Not a bug — auto-discovery is doing the right thing. But WORTH
NOTING: a user running `--auto` on a polyglot repo gets gates for
ALL the languages auto-detected, which could slow iteration if some
are expensive (e.g. 5-min cargo test suite). Users may want:

- `--auto-exclude deno,cargo` to opt out of specific auto-seeds, OR
- `--no-auto-cargo` style for each, OR
- A message during `--auto` showing what was seeded + how to remove

Minor UX, low priority.

## Polyglot-specific validation from this run

- **Finding #8 (expo internal path filter)** worked on smolvm. Zero
  false-positive scope violations from `.expo/logs/` or `.sigbus/`.
- **Finding #7/#10 (branch HEAD)** worked. smolvm's `shakedown-tier2`
  and `main` branches BOTH still at `e9cc956` post-run.
- **Finding #2 (multi-value scope)** worked. Banner showed "Scope: 3
  glob(s)" with `cli/**`, `sdk-ts/**`, `tests/**` all listed.
- **Finding #6 (session vs lifetime)** — not meaningfully tested
  (fresh repo had only baseline + 3 discards, no interesting delta).

## Conclusion + recommendation

**Tier-2 surfaced exactly one new finding (#13) plus one observation
(#14).** #13 is the last of the three pre-session brief hypotheses
to get validated empirically — and the answer was "yes it happens,
and we should pre-flight."

The two "keep" attempts (iter-1 parseFlags + iter-3 timeoutSecs) are
real improvements that the user could cherry-pick if desired:

```bash
# iter-1's change is in tag refine/001 of shakedown-tier2
cd smolvm && git diff main...refine/001 -- cli/
# iter-3's change is in tag refine/003
cd smolvm && git diff main...refine/003 -- cli/
```

Or just discard the whole shakedown-tier2 branch + tags and ignore —
the validation of #13 is the primary outcome.

## Answer to the brief's exit criteria

From `.brief/other-repo-shakedown.md`:
> Clean refine run on 3+ repos of different shapes.

Score after all four runs today:

| Shape | Repo | Verdict |
|-------|------|---------|
| Self-refine (tier-0) | expo | CONVERGED (round 2), EXHAUSTED (round 3) |
| Small single-lang (tier-1) | snapshot | 5 kept iters on re-run |
| Medium polyglot (tier-2) | smolvm | EXHAUSTED — baseline gate broken |

**Exit criterion NOT met** on "clean run" count — 1 of 3 shapes
(snapshot) produced a clean positive run with actual keeps landing.
But: the two non-clean runs both produced signal we can act on
(Finding #12 budget overrun, Finding #13 baseline gate pre-flight).

Realistic end-of-day take: **expo works on external repos in the
happy path**, but **fails informatively in two common
not-happy-path cases**:
- baseline-breaking test suites that need env setup (Finding #13)
- long-running gates that slip the per-agent budget (Finding #12)

Both are shippable fixes. Neither is SEV-1. The shakedown series'
original goal — "find the bugs that self-refine can't find" —
is complete.
