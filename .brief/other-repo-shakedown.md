# Shakedown: point expo at a real repo

**Status:** planning brief. Execute in a future session.
**Date:** 2026-04-13 (end of v0.2.9 session).
**Goal:** find the failure modes that only show up when expo is pointed at a
codebase it didn't help author. Everything we shipped today was motivated by
observations from self-playtest on expo's own source; the analog is to run
expo on repos with different shapes (polyglot, monorepo, generated code,
legacy, etc.) and catalog what breaks.

---

## Why this matters

Every v0.2.x bug we fixed was discovered by running expo on expo. That's a
biased sample — expo's own tree is:
- Single language (TypeScript/Deno)
- Well-gated (existing tests pass, type-check is tight)
- Small (~9k LOC)
- Written by an agent that understood the refine loop's constraints

We claim expo is "safe to point at other repos with guardrails on first run."
The claim is plausible but untested. This shakedown is the test.

**Exit criteria for "ready for broader recommendation":**
- Clean refine run on 3+ repos of different shapes (language, size, maturity)
- Zero destructive incidents (no lost uncommitted work, no runaway spend)
- At least one surprise failure mode documented + fixed OR explicitly deferred
  as a known limitation in QUICKSTART.md

---

## Prerequisites (do BEFORE starting a run)

- [ ] expo v0.2.9 installed: `deno task install` in `apps/expo/`
- [ ] `claude` CLI on PATH with a working API key + `--auto-approve` permission
      server confirmed working (`expo spawn "echo hi" --auto-approve --max-turns 1`)
- [ ] `gh` + working git identity on PATH (many rubrics will invoke git)
- [ ] **Decide the budget up front.** Open your Anthropic dashboard, pick an
      acceptable-burn figure for the session, work BACKWARDS from that:
      `--total-budget` should be 50-70% of your comfort limit so
      over-runs still land short of pain.
- [ ] Read `QUICKSTART.md` end to end. Brief checklist below pre-supposes it.

---

## Candidate-repo selection

Pick 3 repos in escalating shakedown difficulty. Bias toward repos you care
about (makes review meaningful) but don't depend on (keeps stakes reasonable).

### Tier 1 — "should just work"
Small, well-tested, single-language, <2k LOC. Goal: baseline sanity. If this
doesn't work cleanly, something is broken that we did not find in
self-playtest.

Candidates (pick one):
- A utility library you've written in Deno/Node
- A small CLI tool with a test suite
- A single-file script that's grown to ~500 lines and needs cleanup

### Tier 2 — "probably works with tuning"
Medium size (2k-20k LOC), polyglot or has non-trivial test setup, maybe some
generated code or build artifacts. Goal: find what `--auto` picks wrong,
find what `--scope` globs need.

Candidates:
- Something in `_deno/apps/` other than `expo` itself
- A node+typescript project with a nontrivial build step
- A python package with `tests/` requiring fixtures

### Tier 3 — "adversarial"
Actually messy. Deep dependency on CI env vars, secret-requiring tests, a
codebase that's been worked on by many hands. Goal: find the "why is this
weird" failure modes that only emerge in the wild.

Candidates:
- A work project (with read-only clone + revert-any-commits contract)
- An open-source repo you've contributed to
- Something with a monorepo or workspaces setup

---

## Run plan — graduated, not all-at-once

### Phase 1: 15-minute smoke (per candidate repo)

```bash
cd <candidate-repo>

# 1. Dry-ish discovery: what would --auto pick?
expo refine . --auto --max 0 2>&1 | head -20

# 2. gate check (after step 3 snapshots the baseline)
expo refine . --auto --max 1 --rubric "add one useful code comment"
expo refine . gate check

# 3. Short run with everything locked down
expo refine . \
  --auto \
  --rubric "fix any TODO comments; small focused changes" \
  --scope "src/**" \
  --max 3 \
  --run-timeout 900 \
  --per-agent-budget 1 \
  --total-budget 3 \
  --approval-hook './shakedown-log.sh' \
  --event-file /tmp/expo-shakedown-$(date +%s).jsonl
```

Where `shakedown-log.sh` rubber-stamps but logs verdict to a file:
```bash
#!/bin/bash
cat | tee -a /tmp/shakedown-verdicts.log
echo accept
```

**Hard stop:** any of these means stop + investigate:
- Cost exceeds $3 (budget should have killed it; if it didn't, that's a bug)
- Any file outside `src/**` modified
- `git status` shows uncommitted changes you didn't make
- Refine exits with a stack trace
- Bus log shows errors you don't recognize

### Phase 2: 1-hour exploration

Only after Phase 1 passes on ALL three tier-1 candidates. Pick a tier-2 repo.

```bash
expo refine . \
  --auto --allow-agent-gates \
  --rubric-file ./shakedown-rubric.md \
  --scope "src/**" "tests/**" \
  --max 10 --run-timeout 3600 \
  --total-budget 15 \
  --event-file /tmp/expo-tier2-$(date +%s).jsonl
```

`shakedown-rubric.md` should be specific to the repo. Generic rubric is
how we found the "agent over-engineers" failure mode during self-playtest —
it's a known rough edge.

### Phase 3: 6-hour overnight (optional — only if Phase 2 is clean)

Only after Phase 2 produces kept variants that survive post-run review.
Tier-2 or tier-3 repo.

```bash
nohup expo refine . \
  --auto --allow-agent-gates \
  --rubric-file ./rubric.md \
  --scope "src/**" "tests/**" \
  --max 30 --run-timeout 21600 \
  --total-budget 50 \
  --event-file /tmp/expo-overnight-$(date +%s).jsonl \
  > /tmp/expo-overnight.log 2>&1 &

# Tail from elsewhere
tail -f /tmp/expo-overnight.jsonl | jq 'select(.type == "progress")'
```

Go have dinner. Review in the morning.

---

## Instrumentation: what to capture per run

Before kicking off, seed a per-run directory:

```
shakedown/
├── YYYY-MM-DD-repo-name/
│   ├── repo-before.txt         # git log -5 + git status
│   ├── auto-discovery.txt      # stdout from `--max 0 --auto`
│   ├── rubric.md
│   ├── command.sh              # exact expo invocation
│   ├── event.jsonl             # --event-file output
│   ├── verdicts.log            # approval-hook output
│   ├── stdout.log              # redirected stdout
│   ├── repo-after.txt          # git log + status post-run
│   ├── tree.txt                # expo refine . --tree
│   ├── refine-md.txt           # cat REFINE.md
│   └── findings.md             # YOUR post-run audit (see below)
```

The whole directory becomes the artifact for the next session to review.
It's what "picking this back up" looks like concretely.

---

## What to specifically watch for

Hypotheses about where expo breaks in the wild — to verify or refute:

| # | Hypothesis | How to detect |
|---|------------|---------------|
| 1 | `--auto` seeds a gate that fails from the start | Run `gate check` before agent spawn |
| 2 | Rubric is too generic → iterations over-engineer | Review tree for "helper extraction" patterns |
| 3 | Agent makes trivial changes to claim KEEP | Review tree: are changes actually improvements? |
| 4 | Gate failures don't get communicated well | Recent-failures ring should have recent reasons; if empty during visible drift, something's broken |
| 5 | Scope enforcement misses some path | `git status` after a scope-force-discard should be clean |
| 6 | snapshot restore leaves stragglers (discard-cleanup) | `git status` between iterations; see `.brief/` for known edge |
| 7 | cost-guard fires too early (throttled) or too late (overshoot) | Compare final cost to `--total-budget` |
| 8 | `--run-timeout` exit is graceful vs abrupt | REFINE.md should still update on WALL_CLOCK_EXCEEDED |
| 9 | `.refine/inflight.json` resume lands correctly | Simulate crash: `kill -9` mid-run, restart with same flags |
| 10 | Polyglot: multiple language gates trip each other | Python + Node in same repo — do both `--auto` gates pass? |
| 11 | Monorepo: `--scope "packages/foo/src/**"` works | Does refine isolate to the subpackage? |
| 12 | REFINE.md heuristics from one session help the next | Run two short refines on same repo; does the 2nd show fewer discards? |

Items 1-9 we'd expect to work based on test coverage. Items 10-12 are
genuinely new territory.

---

## Post-run audit checklist (`findings.md` per run)

After each run, fill out:

```markdown
# Shakedown findings: <repo> — <date>

## Numbers
- Iterations: X (of Y max)
- Kept: X / Discarded: Y / Gate failures: Z
- Cost: $X (of $Y budget)
- Duration: Xm (of Y max)
- Verdict: CONVERGED | MAX_ITERATIONS | EXHAUSTED | WALL_CLOCK_EXCEEDED

## Git state delta
- Lines changed: +X -Y across N files
- Files outside --scope (should be zero): <list or "none">
- Uncommitted (non-refine) changes (should be zero): <list or "none">

## Review of kept variants
For each kept variant: one-sentence "was this actually an improvement?"
yes / no / neutral / harmful.

## Failure modes observed
- Hypothesis #X confirmed: <describe>
- New failure mode not in hypothesis table: <describe>
- Something expected to fail that didn't: <describe>

## Cost anatomy
- % in agent spawns vs gate runs
- Were any iterations wasted (gate-discarded) and why

## Would I run this again on this repo?
yes / yes-with-changes / no / not-until-<specific fix>
```

---

## Decision matrix

After all Phase 1 runs:

| Outcome                                   | Next step                                    |
|-------------------------------------------|----------------------------------------------|
| All clean, kept variants mostly good      | Proceed to Phase 2 on a tier-2 repo          |
| All clean but kept variants mostly bad    | Iterate on rubric, re-run Phase 1            |
| One repo failed cleanly (clear error)     | File specific bug, fix, re-run that repo     |
| One repo failed silently (drift, wasted $)| STOP. This is the exact thing we're hunting. |
| Cost overshoot > 20%                      | costGuard bug — do not proceed to Phase 2    |
| Uncommitted-work loss                     | SEVERITY-1: stop all shakedown, emergency fix|

---

## Known-open design items to revisit after shakedown

Items we deliberately haven't built because they want real-world data to
motivate the exact shape:

- **Midrun steering** (`.brief/midrun-steering.md`) — ship this IF Phase 2 or
  Phase 3 reveals clear drift patterns that human nudging would fix.
- **Mxit resumability** — analogous to refine's inflight.json. Build if Phase
  3 ever involves a multi-task mxit run that crashes partway.
- **Rubric-discard feedback loop** — current recentFailures ring only captures
  gate failures. If Phase 2 shows agents repeating the same rubric-failing
  proposal, extend the ring to rubric discards.
- **Dry-run `--auto --plan-only`** — if Phase 1's "run with `--max 0`" proves
  awkward, build a real dry-run that exits before the first spawn.
- **Per-iteration variant cost attribution** — currently we track totalCost
  but not per-iteration. Phase 3 review will need this if "which iterations
  were wasteful?" is a real question.

---

## Deliverables for the session that executes this

1. `shakedown/` directory with all per-run artifacts committed or archived.
2. A short findings summary suitable for pasting into TASKS.md or a new
   `.brief/shakedown-results.md`.
3. A prioritized list of any new bugs or UX rough edges discovered, with
   severity and concrete repros.
4. Explicit verdict on whether "kick it off Friday, review Monday" is now
   defensible with specific caveats.

---

## Self-care notes for the driver

- Each run burns real money. Cap session-level spend in your own head, not
  just in `--total-budget` flags. If you've run 4 shakedowns and spent $40,
  stop even if budget flags would allow more.
- Don't shakedown on a repo you care about AND don't have a clean git state
  for. Bad run → lost uncommitted work is the one thing expo's scope
  enforcement can't fully protect you from (concurrent edits during a run
  are already hard, and you'll sometimes have them without realizing).
- Expect to find bugs. That's the point. A clean shakedown means we didn't
  look hard enough.

---

## Where to restart

If a future session picks this up:

1. Read `.brief/other-repo-shakedown.md` (this file)
2. Check `shakedown/` for any prior runs' findings
3. Confirm expo version: `cat apps/expo/deno.json | grep version`
4. Start at the tier + phase where the prior work left off (or Phase 1 if
   this is the first execution)
5. Budget a specific session-spend cap before any `expo refine` fires
