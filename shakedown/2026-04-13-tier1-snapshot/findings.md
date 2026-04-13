# Shakedown B — tier-1 on `@snapshot/core` (2026-04-13)

Ran on branch `shakedown-tier1` of the snapshot repo to sidestep
Finding #7's unfixed snapshot-commits-to-HEAD behavior on master.

## Fire-time state

- Target: `/Users/janzheng/Desktop/Projects/_deno/apps/snapshot` on branch `shakedown-tier1`
- 1275 LOC total (488 impl, 713 tests, 48 types, 26 mod exports)
- Caps: $5 total / 15 min wall / 5 iter
- Scope: `src/**` only
- Rubric: `../2026-04-13-tier1-snapshot/RUBRIC.md` — tight, focused on
  error-message clarity and API-boundary validation
- Auto-seeded one gate: `deno_test: deno task test`

## Run statistics

- **Verdict:** `EXHAUSTED` (stopped after 3 consecutive force-discards)
- **Iterations:** 3 (of 5 cap)
- **Session keeps:** 0 (all 3 were force-discarded by Finding #8 scope)
- **Session discards:** 3 (100%)
- **Gate fails reported:** 3 (but these were SCOPE violations — see Finding #11)
- **Cost:** $2.24 (of $5 budget — under-spent because loop exited early)
- **Duration:** 320s (5.3 min of 15 cap)
- **Final head:** `[000]` (baseline — nothing survived)

### What was attempted (all legitimate, all force-discarded)

| Iter | Proposal | LOC | Tests | Verdict reason |
|------|----------|-----|-------|----------------|
| 1 | `addGate()` validates non-empty name/command | 8 | 20/20 pass | scope_violation: `.expo/logs/...jsonl`, `.sigbus/` |
| 2 | `restore()` errors list available variant IDs | 15 | 19/19 pass | scope_violation: `.sigbus/` |
| 3 | `init()` validates dir exists + is directory + non-empty | ~12 | 20/20 pass | scope_violation: `.sigbus/` |

Every one of these is a diff a senior reviewer would call "obviously
right." All three got eaten by the scope enforcement false-positive.

### Finding #6 fix verified in production

Banner output:
```
Kept:       0 this session (1 lifetime)
Discarded:  3 this session (3 lifetime)
```

The session-delta distinction is immediately clear. User knows at a
glance that THIS session produced nothing keep-worthy (regardless of
the "1 lifetime" which is just the baseline).

## Findings

### Finding #8 — scope enforcement trips on expo's own runtime output files

**Severity:** HIGH. Makes `expo refine` unusable on any repo that doesn't
explicitly gitignore `.expo/logs/`, `.sigbus/`, `.refine/`.

**Evidence:** Iter-1 made a legitimate keep (addGate validation, 8 LOC,
20 tests pass including new one) and was force-discarded on scope
violations for `.expo/logs/bus-refine-*.jsonl` and `.sigbus/`. These are
expo's OWN runtime output — it's writing them during the iteration, and
the scope check sees them in `postAgentDirty \ preAgentDirty` and
classifies them as "agent-touched."

**Root cause:** `listDirtyPaths()` uses `git status --porcelain` to
compute agent-touched set. expo's own `.gitignore` lists these paths,
so they don't show on expo self-refine runs. Any other repo that
doesn't have those lines in `.gitignore` gets false-positive scope
violations on every iteration.

Evidence on iter-2: same pattern — agent-proposed keep (`restore()`
error message improvement, 15 LOC, 19 tests pass) force-discarded for
scope violation on `.sigbus/` alone (`.expo/logs/` may have been
gitignored by that point due to bus rotation, needs confirmation).

**Fix direction:**
1. Filter paths starting with `.expo/`, `.sigbus/`, `.refine/` out of
   `listDirtyPaths()` result. One-line change.
2. On `init()`, append those patterns to the target repo's `.gitignore`
   if missing, with a comment explaining why.
3. Combine 1+2: filter in the matcher AND inform user.

This is a stronger cousin of Finding #2. The parser fix made `--scope
"src/**" "tests/**"` actually accept both globs — but doesn't help if
the agent-touched set is contaminated by expo's internal files.

### Finding #9 — post-force-discard working tree is in a confusing state

**Severity:** MEDIUM. Wastes agent budget debugging.

After a scope-violation force-discard, the working tree state doesn't
match either the parent variant or HEAD cleanly:
- Agent sees `snapshot.ts` as "deleted" in git status
- Agent spends ~30 seconds running `git status`, `git log`, `git ls-files`,
  `git show` to understand the state before being able to work
- Eventually recovers via `git checkout HEAD -- src/*.ts`

Root cause relates to Finding #10. The branch HEAD doesn't roll back
with working-tree restore, so the INDEX and WORKTREE disagree about
what's "the current state."

### Finding #10 — force-discards still commit; branch HEAD advances on every iteration (extends Finding #7)

**Severity:** HIGH. Every iteration — kept OR force-discarded — adds a
commit to the branch.

The project-git snapshot backend in `snapshot/src/snapshot.ts:199-202`
commits + tags BEFORE the verdict is applied. When a variant gets
force-discarded (via scope check or gate failure):
- The snapshot commit has already landed on the branch
- The tag (`refine/NNN`) still points to it
- Manifest's `status` field gets updated to `"discarded"`
- But branch HEAD stays at that commit

So main (or in this case shakedown-tier1) picks up a commit for EVERY
iteration, not just kept ones. A 10-iteration run leaves 10 commits
on the branch regardless of how many were "kept" semantically.

This is the per-iteration manifestation of Finding #7. Fix direction
is the same: snapshot commits should go to a detached HEAD or a
dedicated ref that doesn't advance the user's working branch.

## Cross-finding observations

These findings interact in interesting ways:

- **#8 × #10**: every scope-violation force-discard still leaves a
  commit, AND creates a confusing post-discard state (#9), AND triggers
  re-exploration cost in the next iteration (2-3 minutes lost per
  iteration). On snapshot tier-1, this took iter-1+iter-2 from "two
  clean keeps" to "zero keeps, all wasted."

- **#8 alone** is worth fixing because it's a portability issue — any
  repo without expo's specific `.gitignore` conventions can't use
  refine. That's ~100% of repos outside our ecosystem.

- **#10 alone** means every refine run permanently advances the user's
  branch. Even a "successful" run with 5 keeps leaves 5+ commits (one
  per keep) on main — you can't tell "real intent" from "refine
  output" without reading each commit's message or diff.

## What went well

Despite the scope bug killing both iter-1 and iter-2 keeps, several
observations suggest the refine loop is fundamentally working:

- **Agent prioritization:** went straight for rubric-aligned targets
  (API-boundary validation, error clarity). No over-engineering.
- **Iteration cost:** ~$0.60/iter on this small repo (vs expo's ~$1+)
  — rough linear with codebase size, as expected.
- **Gate enforcement:** `deno task test` gate ran correctly, caught
  nothing wrong on iter-1's change (because the agent added a proper
  test).
- **Agent self-recovery:** iter-2 successfully navigated the confused
  post-discard state and found a different improvement axis.

## What this means for Shakedown B

- **Tier-1 done, findings dense.** 3 new findings + 1 confirmation of
  cross-finding interaction. Shakedown B is producing high-quality
  signal exactly as the brief expected.
- **Finding #8 must be fixed before Shakedown B tier-2 or tier-3.**
  Running on any repo without expo-specific gitignore patterns would
  be useless.
- **Cannot recommend expo for external use until #8 + #10 are fixed.**
  Internal dogfooding on expo works because expo's own gitignore/
  branch conventions mask these issues. Any external user hits them
  on iteration 1.

### Finding #11 — final banner miscategorizes scope violations as "gate fails"

**Severity:** LOW (UX polish).

Banner output on tier-1 end:
```
Gate fails: 3 (variants forced-discarded by inherited gates)
```

But these 3 force-discards were SCOPE violations, not inherited gate
failures. The `gateFailures` counter in refine.ts is incremented on
both scope violations AND gate failures (see `gateFailures++` inside
the scope-violation branch around refine.ts:696).

Fix: either
1. Split the counter into `gateFailures` and `scopeViolations`, with
   separate banner lines.
2. Rename the banner line to "Forced-discards: 3 (scope violations
   or inherited gate failures)".

Option 1 is more informative; option 2 is a one-line change.

## Post-run cleanup

After reviewing this shakedown:
1. Reset `shakedown-tier1` branch or leave it for historical reference
2. Back to master on snapshot for continued development
3. Remove `.refine/` dir and expo's `.expo/`/`.sigbus/` state from
   snapshot repo
