# Design-cycle orchestration — what expo might actually be

**Status:** distilled lab notes. Captures a reframing that surfaced
during the 2026-04-13 shakedown retrospectives, after the
convergent-vs-divergent discussion.
**Pairs with:** `.brief/refine-philosophy.md` (refine as convergent
inspection tool), `.brief/cost-per-keep-analytics.md` (metric for
s-curve detection).

---

## The observation

UX design thinking teaches the "double-diamond" cycle:
diverge → converge → diverge → converge. At each zoom level you
alternate:

1. **Diverge** on the problem — explore what's actually going on.
2. **Converge** on the problem — define what you're solving.
3. **Diverge** on solutions — generate many options.
4. **Converge** on solutions — pick and build.

Good design/research work doesn't stop at one diamond. Each converge
point feeds the next diverge, and the cycles keep going at finer
zoom levels as you learn more.

This cycle structure applies directly to code work, which is what
expo has been sort-of doing without naming it.

## Mapping the double-diamond onto code refinement

| Phase | In design thinking | In code refinement | Expo primitive |
|---|---|---|---|
| **Diverge** | Problem exploration — "what's really going on here?" | "Where are the issues in this codebase?" | **`audit`** — single agent, free-form markdown findings |
| **Converge** | Problem definition — pick the question | Extract a rubric: `.brief/RUBRIC.md` | Human reads audit → writes rubric |
| **Diverge** | Solution generation — many options | "Different ways to fix this" | **`race`** for 2–3 framings (limited) |
| **Converge** | Solution selection — pick + build | Gates + rubric filter | **`refine`** — the bounded inspection loop |
| **Diverge** | Next-cycle exploration | "What did we miss? What shifted?" | `audit` again, or manual tree review |
| **Converge** | Next-cycle rubric | Update rubric or pivot axis | Human + rubric edit |

All of those phases have expo primitives. What's *missing* is the
**wiring between them**.

## What's wired vs what's manual

**Wired (single command):**
- `audit` does one diverge → write findings → stop
- `race` does one diverge (N approaches) → converge (judge picks) → stop
- `refine` does many convergent iterations against a rubric → stop
- `workflow` chains whatever stages you define in a markdown file

**Manual (human handoff):**
- `audit` output → next rubric (human reads, extracts, writes)
- `refine` keeps → what to do next (review, merge, cycle again)
- Between cycles — no automatic "given last cycle's keeps, what's the next
  axis?" primitive

Every handoff between cycles currently requires a human reading
markdown and writing a new rubric or running a new command. The
primitives exist; the choreography is DIY.

## `workflow` is the underappreciated cycle engine

A markdown workflow file IS a design-cycle engine. Fan-out stages are
diverge. Synthesis stages are converge. Chain them and you get
diverge → converge → diverge → converge. You can build the full
double-diamond today if you're willing to hand-design the workflow
file.

Careful phrasing: **expo can *express* design cycles today; it doesn't
yet have a command called "run a design cycle."**

## Sketch — a first-class `cycle` command

```bash
expo cycle <topic>
# 1. audit pass — agent explores, writes .brief/cycle-NNN-findings.md
# 2. synthesis — judge agent reads findings, extracts top 3 axes,
#    writes one rubric per axis to .brief/cycle-NNN-rubric-{A,B,C}.md
# 3. refine per axis — parallel runs, each axis gets its own bounded
#    run with its own rubric (divergent at the rubric level,
#    convergent within each)
# 4. report — kept variants across all axes + findings that didn't
#    fit any axis + "unknowns" worth flagging for next cycle

expo cycle <topic> --continue
# 5. re-audit informed by last cycle's keeps + unknowns (diverge,
#    narrower)
# 6. synthesize again (converge to new rubric set)
# 7. refine parallel (converge)
# 8. report (diverge again — "what's next?")
```

Implementation estimate: 150–300 LOC if it's mostly glue over
existing primitives. A new top-level command, not a rewrite.

## The bigger reframe

Expo's original pitch: *multi-agent orchestration system with refine,
race, workflow, audit as a toolkit.*

What it's become in practice: *a cycle orchestrator for AI-assisted
code work — capable of convergent inspection (refine), divergent
exploration (audit), parallel synthesis (race, workflow), and
sequential task progression (mxit) — currently presented as separate
tools rather than phases of one cycle.*

That's a more ambitious framing. It's also more honest about what
someone uses expo for in practice, if they use the whole toolkit.

### Why this reframe matters

- **README positioning.** Current README presents five separate commands.
  Recasting them as "the four phases + the glue" would make the value
  clearer to someone approaching expo cold.
- **Roadmap priorities.** A `cycle` command suddenly becomes a credible
  feature request rather than speculative. So does "automatic rubric
  generation from audit findings." So does "cycle report persists the
  state needed to continue later."
- **What to build next.** If expo is a cycle orchestrator, the gaps are
  wiring + vocabulary + reporting — not more solo commands.
- **Marketing / narrative.** "Cycle orchestrator for AI-assisted design
  work on code" is a more coherent story than "here are five commands."

## What this doesn't change (yet)

- Doesn't demand any code changes. The primitives are fine as they are.
- Doesn't mean the `refine` loop is incomplete. Refine is a good
  convergent tool; it's meant to be one phase of a cycle, not the
  whole cycle.
- Doesn't require writing a `cycle` command — it's a sketch, not a
  roadmap commitment.

## Rules of thumb if this framing holds

- **Name the phase you're in.** "I'm diverging" (exploring) vs
  "I'm converging" (filtering, picking). Different commands, different
  prompts, different success criteria.
- **Don't skip phases.** Jumping straight to `refine` without a
  rubric-generating diverge → converge cycle first is why round 1 of
  Shakedown A produced mostly discards — the rubric hadn't been
  informed by an exploration pass.
- **Plan for multiple cycles.** One cycle is rarely enough. Budget for
  2–4 at a minimum on anything non-trivial.
- **Let the cycle terminate naturally.** If audit finds nothing worth
  rubricizing, stop the cycle. That's CONVERGED at the outer loop
  level — the project is done (for this axis), not just this iteration.

## Relation to existing briefs

- **`.brief/refine-philosophy.md`** says "refine is a convergent
  inspection tool." That's still true — but the convergent-vs-divergent
  section there was already pointing at this larger cycle shape. Refine
  is one phase; the phases together are the thing.
- **`.brief/cost-per-keep-analytics.md`** says cost-per-keep reveals
  the s-curve within one refine run. Extending to cycles: cost-per-cycle
  and keeps-per-cycle are the analogous metrics at the outer loop.
  Worth tracking if a `cycle` command ships.
- **`.brief/other-repo-shakedown.md`** structured shakedown as A then
  B tier 1 then B tier 2. That's a cycle pattern — each shakedown run
  was a diverge (explore unknowns), the fixes were a converge. Today's
  session went through four such cycles.

## Why I didn't see this at the start

The first refine loop was built to solve a specific problem: "I want
to iteratively improve this code and have the agent not break it."
That's a convergent problem — "improve" with a "don't break" gate.

The design-cycle framing needs you to ALREADY understand that
iterative improvement is one slice of a bigger loop. You don't see
that until you've done the bigger loop by hand a few times — which
is what today's shakedown was. Audit → write findings → pick axes →
write rubric → refine → review → repeat. I was running the double-
diamond manually while claiming expo was just a convergent tool.

This brief exists because the manual version is real work and
expensive, and expo's primitives are literally 80% of the
choreography. The missing 20% is a `cycle` command (or better
documentation that lets a user build it themselves with workflow).

---

## Source

Surfaced during the wrap-up conversation of 2026-04-13, after:
- Round 2 of Shakedown A showed convergent behavior (CONVERGED, 0 keeps)
- Round 3 showed a real gate catching a real issue (test-version drift)
- Tier-2 on smolvm revealed baseline-gate issues (Finding #13)
- A methodological question about whether agent convergence across
  runs is signal or bias (it's both, depending on what you're asking)
- An explicit mapping of double-diamond design thinking onto the
  commands expo already has

The "not sure what this means for expo" moment is the honest
admission that the tool being built is bigger than the initial
framing. That's worth saving.
