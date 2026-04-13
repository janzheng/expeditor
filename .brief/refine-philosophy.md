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

## Convergent vs divergent briefs — both valid, different purposes

Observed during the Shakedown B tier-1 runs: the same rubric on
similar codebases produces very similar iter-1 proposals. On expo,
snapshot v1, snapshot v2, and smolvm, iter-1's target was always
some form of "API-boundary validation" — because that's literally
what the rubric told it to look for first.

This *looks* like convergence bias (same model + same brief =
similar output), and in a strict methodological sense it is. But
that framing misses the key distinction:

**A refine run is inspection, not research.** You're not asking
"what's interesting here?" — you're asking "apply this checklist."
Convergence across runs is the target behavior, not a failure mode.
When two senior engineers independently review the same code against
the same checklist, we want them to find similar issues. The
convergence validates the checklist, it doesn't devalue the review.

That said, the framing matters because **sometimes you want
divergence** — finding *new classes* of bugs you didn't know to
look for. For that you want a different tool shape.

### When to use a convergent (tight) brief

- You know the class of bug you're hunting (validation gaps,
  error clarity, test coverage holes, style inconsistency).
- You want repeatable, auditable sweeps — same rubric, multiple
  repos, compare output across them.
- You're doing maintenance-grade polish on mature code.
- Cost matters — tight rubric keeps cost-per-keep low.

This is expo `refine`'s sweet spot. The rubric in
`.brief/SELF-REFINE-RUBRIC.md` is a convergent brief.

### When to use a divergent (open) brief

- You don't yet know what the bug classes are.
- You're doing first-pass exploration of unfamiliar code.
- You want parallel proposals that surface different angles.
- You can afford the noise — many proposals won't pan out, and
  the value is in the occasional surprising hit.

Expo `refine` is NOT ideal for this. The rubric is a single prompt,
one model, one direction at a time. You could loosen the rubric to
"find anything wrong" but you'd likely get cheap-looking keeps that
drift the code without finding surprises.

For divergent exploration, reach for:

- **`expo race`** — run two or three approaches in parallel, judge
  picks the winner. A natural fit for "try these three framings
  of the problem and see which turns up something real."
- **`expo workflow`** — fan out multiple focused agents (each with
  its own narrower rubric), synthesize findings. The fan-out step
  IS divergence; the synthesis lets a reviewer agent spot clusters.
- **Multiple refine runs with different rubrics** — the operator's
  version of the same idea. Run refine with a validation rubric,
  then a performance rubric, then a security rubric. Each is
  convergent on its own; the COLLECTION is divergent.
- **Manual audit** — `expo audit` spawns a single exploration-mode
  agent with no constrained output, writes findings to markdown,
  no code changes. Designed for "tell me what's wrong" when you
  can't formulate the question yet.

### Methodology caveats worth knowing

For anyone using refine as a research tool (e.g. evaluating a
codebase, comparing refactor approaches, etc.) — a few things to
be honest about:

1. **Convergence across runs is the mode, not the measurement.**
   If iter-1 on five independent runs all find the same bug, that's
   consistent with (a) it being a real bug AND (b) the rubric
   steering strongly. Both are true; neither eliminates the other.
   Don't use refine output as independent evidence — treat it as
   systematic inspection under a single lens.

2. **Repeat-run variance is a weak but real signal.** Temperature
   isn't zero. If five fresh runs on the same codebase + same
   rubric produce noticeably different iter-1 attempts, the model's
   prior is weak here — probably because the "validation gap"
   surface is small and the agent has to reach. If all five
   converge, the prior is strong — probably because the issue is
   genuinely salient.

3. **Cross-model convergence is a stronger signal.** If running the
   same rubric on the same code with Opus vs Sonnet vs Codex all
   produce similar proposals, that's closer to independent
   confirmation. Different training regimes, different priors,
   same output shape = the code pattern is really there. Not
   currently easy to do in expo; would require running refine with
   `--agent claude-opus`, then `--agent codex`, etc., with state
   reset between.

4. **Rubric-comparison reveals what the rubric is actually aimed
   at.** If you run rubric A and rubric B on the same code and
   get *very different* keeps, the rubrics are doing real work.
   If they overlap heavily, one rubric is probably dominant
   (likely the model's own prior is overriding both and picking
   its preferred target).

### What this means for expo's design

Mostly: **don't try to make refine do both jobs.** It's a
convergent-brief inspection tool. That's a real thing. The
ecosystem around it (race, workflow, audit) already covers the
divergent-exploration jobs. The honest documentation move is to
say THIS IS WHAT IT IS, and point users at the right tool for the
other job.

If there's ever an itch to build divergent-refine, some sketches:
- **`refine --parallel-rubrics RUBRIC1 RUBRIC2 RUBRIC3`** —
  each iteration spawns three agents in parallel, each with a
  different rubric, keeps whichever passes gates. Race-inside-refine.
- **`refine --rubric-rotation`** — cycle through a rubric list
  across iterations. iter-1 uses rubric A, iter-2 uses B, etc.
  Keeps convergence within each rubric class but diverges across.
- **`refine --explore`** — special mode where the rubric is
  deliberately loose ("find something worth fixing") and the
  keep/discard decision is made by a separate judge agent
  reviewing a pool of proposals at once, picking the K most
  interesting. Essentially a generate-then-judge loop.

None of these are on the roadmap. Flagging them because the
vocabulary ("convergent" vs "divergent" refine) might prove useful
if patterns we haven't thought of emerge.

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
