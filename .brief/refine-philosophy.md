# Refine philosophy — the rubric, the gates, and what expo is really doing

**Status:** distilled lab notes. Captures the conceptual model worked
out during the Shakedown A+B sessions of 2026-04-13.
**Pairs with:** `.brief/cost-per-keep-analytics.md` (the metric that
operationalizes "when is the loop done?").

---

## What `expo refine` actually is

A loop. The shape:

```
┌──────────────────────────────────────────────────────────────┐
│  restore → spawn agent → parse verdict → enforce scope       │
│  ↓                                                           │
│  run inherited gates → snapshot as kept OR discard → repeat  │
└──────────────────────────────────────────────────────────────┘
```

There are three things constraining what the agent can do:

1. **Rubric** — a natural-language prompt fragment. Soft constraint.
   The agent reads it, interprets it, and either complies or doesn't.
2. **Gates** — shell commands that must exit 0. Hard constraint.
   Machine-checked. Inherited down the variant tree.
3. **Scope** — path globs the agent is allowed to touch. Hard
   constraint. Enforced at the `git status --porcelain` layer.

Every iteration's output flows through all three. An iteration gets
KEPT only if:
- The agent's own rubric self-check says "keep"
- All scope globs pass
- Every inherited gate exits 0

A DISCARD from any of the three snaps the tree back to the parent
variant. Three discards in a row trigger a branch-to-underexplored.

---

## The central insight: the rubric is load-bearing

The shakedown on `snapshot` produced 5 clean keeps that a senior
reviewer would accept on sight. None of them were over-engineered.
None of them were slop.

That outcome was NOT because the agent is smart enough to know what's
good on its own. It was because **the rubric explicitly forbade the
bad shapes**:

```
Do not:
- Extract helpers "for clarity" with < 3 call sites.
- Rename public exports, restructure modules, reshape types.
- Add features, CLI flags, or new public API.
- "Improve" working code absent a concrete bug/error.

Quality bar for KEEP:
- Under ~40 LOC of production change.
- New or updated test passes.
- All inherited gates pass.
- A senior reviewer would call the diff "obviously right" —
  not "a judgment call."
```

Without those constraints, the same loop on the same codebase with
the same gates would have produced 5 keeps that LOOKED plausible
individually but drifted the library — extract-a-helper refactors,
pattern-matching renames, speculative validation that didn't fix any
real bug.

**The rubric is a soft gate.** It sits alongside the hard gates
(`deno task test`, typecheck, etc.) and does equivalent work:
filtering out plausible-but-wrong changes. It's natural language
instead of a shell command, but functionally it's the same role.

This is the meta-lesson: **treat the rubric as infrastructure, not
prompt engineering**. You write it once carefully, commit it to the
repo (`.brief/SELF-REFINE-RUBRIC.md` pattern), version it, reuse it
across sessions. It's doing a lot of work every iteration.

---

## Why cost-per-keep is meaningless without gates

See `.brief/cost-per-keep-analytics.md` for the full framing. The
short version that connects to this philosophy:

Running refine on a repo with no gates and no rubric means every
iteration auto-keeps (no hard failure signal, no soft failure
signal). Cost-per-keep looks great — $0.50/keep, $1/keep — but you
have no idea whether the keeps are improvements or drift. That's
the "pathological gambling run" case.

Running refine on a repo with real gates AND a tight rubric means
cost-per-keep climbs as the easy wins are exhausted. When it climbs
high enough that the marginal keep costs more than its value, you've
reached the s-curve top. That's the point of the metric.

**The metric works only because both gate types are doing their job.**
A looser rubric makes the numerator (cost) smaller and the
denominator (keeps) larger, giving you a deceptively healthy number
on a run that's actively drifting the code.

---

## The s-curve shape of a healthy refine project

A session on a codebase progresses through something like:

```
   ▲  keeps-per-iter
   │
   │  ●●
   │    ●●
   │      ●●
   │        ●●●
   │           ●●●●
   │               ●●●●●●
   │                     ●●●●●●●●●
   └──────────────────────────────────▶ iteration
```

Early iterations find obvious wins (`parseIntArg` validation, missing
`await`, unclear error messages). They pass rubric + gates trivially.

Middle iterations start proposing things that need more thought. Some
pass, some fail rubric, some fail gates.

Late iterations propose pattern-propagation (apply this fix to three
other functions) and edge cases. Most get rubric-discarded or
gate-discarded because the remaining real bugs are hard or the agent
is reaching for over-engineering.

Top of the curve: the agent explicitly declares "no rubric-aligned
opportunities found" and the loop emits `CONVERGED`. This is the
right end state. See Shakedown A round 2 in `shakedown/` for a
concrete example.

**A run that ends in MAX_ITERATIONS is different from one that ends
in CONVERGED.** MAX_ITERATIONS could mean "the loop ran out of
patience" or "infrastructure prevented keeps." CONVERGED is the
agent's own signal that nothing meaningful remains. The diagnostic
section in `.brief/cost-per-keep-analytics.md` formalizes this
distinction into an interpretation algorithm.

---

## What expo's refine loop is NOT

Deliberately clarifying the negative space:

- **Not an autonomous code agent.** The agent never ships code;
  every iteration goes through snapshot-keep-or-discard. The agent's
  judgment is one input, not the final word.
- **Not a replacement for code review.** The rubric and gates filter
  for mechanical-correctness and rubric-alignment, not semantic
  correctness. Kept variants still need review before merging — the
  loop just makes sure review isn't wading through slop.
- **Not a style enforcer.** The rubric encodes intent, not
  formatting. Style things belong in linters or pre-commit hooks,
  called as gates.
- **Not a way to avoid writing gates.** If your project has no tests
  and no linter, refine cannot make it better. The gates are the
  floor.
- **Not "set it and forget it" for arbitrary tasks.** The rubric +
  scope + gates triad needs to be tuned per task class. Writing the
  rubric once per axis (error clarity, perf, security) is realistic;
  one rubric for everything is not.

---

## What the loop is actually GOOD at

Based on two full shakedown sessions (expo-on-expo + tier-1 on
snapshot):

1. **API-boundary hardening.** "This exported function accepts
   garbage input and fails cryptically downstream" is almost
   always a win if the rubric asks for it.
2. **Error-message clarity.** "This error doesn't tell the user
   what went wrong or how to fix it" — consistent pattern that
   almost always passes rubric + gates.
3. **Missing regression tests.** The rubric requiring "new test
   per behavioral change" means the loop systematically builds out
   test coverage alongside fixes.
4. **Pattern propagation.** Once a pattern is established (iter-1),
   applying it to other parallel call sites (iter-2, iter-3) is
   fast and mechanical. Often 3+ keeps in a row once a good pattern
   surfaces.
5. **Small hygiene fixes.** Off-by-ones, missing awaits, wrong
   defaults contradicting nearby comments — the agent notices these
   while exploring for the rubric's primary targets.

---

## What the loop is BAD at

1. **Anything requiring codebase-wide coordination.** "Rename this
   type across 15 files" tends to fail gates (partial changes break
   compilation) or violate scope. Do these by hand.
2. **Cross-module architectural changes.** The rubric's "under 40
   LOC" bar filters these out, but even without that, the agent
   lacks the mental model to restructure safely. It'll propose the
   change, produce something plausible-looking, and fail gates or
   drift the design.
3. **Anything requiring runtime / integration signal.** The gates
   are what you can run in CI. If the real signal requires a
   staging environment, a human spot-check, or a day of production
   traffic, the loop can't help.
4. **Value judgments.** "Should we use library A or library B?"
   has no objective answer that the gates can validate. The loop
   will pick something and snapshot it; that's not the same as
   choosing well.
5. **Creative / novel design.** If the task needs new abstractions
   invented, the loop will rubric-discard exotic proposals (if the
   rubric is tight) or produce generic slop (if the rubric is
   loose). Human design work first, then the loop for polish.

---

## Practical rules of thumb

From the sessions that produced this doc:

- **Commit your rubric.** `.brief/SELF-REFINE-RUBRIC.md` (expo) and
  the tier-1 variant live in git. They're as important as the code
  they constrain.
- **Run with `--scope`.** Always. Even on a throwaway branch. It's
  the cheapest force-discard and it catches scope creep early.
- **Tight rubric > loose rubric.** Err on the side of "this
  constraint may be too strict." You can always loosen and re-run.
  Loosening during a run is cheaper than reviewing 10 slop commits.
- **Per-gate timeouts.** Slow integration gates should have their
  own `timeoutMs` so fast typecheck gates aren't penalized.
- **Budget caps are load-bearing.** `--per-agent-budget`,
  `--total-budget`, `--run-timeout` — these are hard limits that
  have fired multiple times in real shakedown sessions. They work.
- **Start with `--max 3` on a new repo.** Three iterations is enough
  to see whether the loop is going to produce noise or signal, and
  $5-10 is a cheap sanity check before committing to a longer run.
- **Read the kept changes before merging.** The loop is a filter,
  not a decision maker. Every kept commit still gets human review.

---

## The governance tension

The loop produces commits faster than a human can review. Today's
snapshot tier-1 re-run landed 5 commits with 44 LOC production +
155 LOC test in ~10 minutes. Reading that carefully takes longer
than producing it.

This is a legitimate governance problem, not a bug. Mitigations:

- **Strong rubric** is the first line of defense. If the rubric is
  tight enough that bad keeps can't sneak through, review becomes
  "confirm rubric is being enforced" rather than "evaluate each
  change on its own merits."
- **Kept change summaries.** `manifest.json` stores a summary per
  variant. A 10-iter run is 10 one-liners — reviewable in 2 min.
- **Revert is cheap.** `git revert <sha>` undoes a kept commit
  without breaking the tree. Bias toward "keep fast, revert
  slowly" rather than "agonize over each keep."
- **Treat merged-to-main as the review boundary.** Keeps on a
  refine branch are candidates; you can cherry-pick or revert at
  merge time with the full context.

---

## Why this is interesting

Most "AI coding" tools are either:
- **Autonomous agents** that ship code you inspect after the fact, OR
- **Autocomplete / chat** that writes code you inspect immediately.

`expo refine` is a third shape: **bounded iteration inside a
hard-check box**. The agent can be dumb, the prompt can be mediocre,
the model can hallucinate — but the hard-check box (gates + scope)
and the soft-check box (rubric) mean the output is still usable. You
trade some agent autonomy for output quality guarantees.

The rubric is the soft-check box. The philosophy of this doc is
that the rubric is where the care goes. Get the rubric right once
per task class; the loop does the rest.

---

## Source

Written after Shakedown A+B sessions of 2026-04-13. Specific evidence:

- Shakedown A round 1: broken-loop + rubric-too-loose example. See
  `shakedown/2026-04-13-expo-on-expo/findings.md`.
- Shakedown A round 2: canonical CONVERGED + s-curve-top example.
  `shakedown/2026-04-13-expo-on-expo-round-2/`.
- Shakedown B tier-1 v1: rubric-tight-but-infra-broken. Shows
  scope enforcement eating legitimate keeps.
  `shakedown/2026-04-13-tier1-snapshot/findings.md`.
- Shakedown B tier-1 re-run: clean 5-keep run. Proves the
  philosophy in practice once infra was fixed.
  `shakedown/2026-04-13-tier1-snapshot-rerun/findings.md`.
- Rubrics used: `.brief/SELF-REFINE-RUBRIC.md` (expo),
  `shakedown/2026-04-13-tier1-snapshot/RUBRIC.md` (snapshot).
