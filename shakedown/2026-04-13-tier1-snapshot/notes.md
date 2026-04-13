# Running notes — Shakedown B tier-1 on `@snapshot/core`

Live observations as the run executes. Organized roughly chronologically
with section headers for what's being watched. Final analysis lives in
`findings.md` after the run completes.

---

## Context at fire time

- Target repo: `/Users/janzheng/Desktop/Projects/_deno/apps/snapshot`
- Branch: `shakedown-tier1` (throwaway — Finding #7 mitigation)
- Fresh .refine/ state (no prior variants; this is snapshot's first
  exposure to refine)
- 1275 LOC total, 488 impl / 713 tests / 48 types / 26 export barrel
- Heavy test ratio (713:488) — lots of gate signal available

## Hypotheses going in

Things I'm watching specifically:

1. **Auto-discovery on a Deno-only repo** — expo's `--auto` should
   seed `deno_test` as a gate. Does it pick the right task name
   (`test` vs `deno task test`)?

2. **Smaller codebase behavior** — with only 488 LOC to explore, the
   agent should reach the end of its exploration faster. Will it
   propose changes or immediately declare convergence?

3. **Finding #7 in action (on shakedown branch)** — every kept
   variant will commit to `shakedown-tier1` branch. After the run,
   we should see the snapshot tree reflected in branch commits.
   On the throwaway branch this is fine; it's a live demo of what
   would happen on master if #7 weren't mitigated.

4. **Cross-library awareness** — snapshot is USED by expo. Does the
   agent know that without being told? Does it propose changes that
   would break expo's dependency on it?

5. **Finding #4 fix carryover** — this is a fresh snapshot repo, no
   prior variants, so drift-detection should silently pass. The fix
   should be a no-op here.

6. **Cost profile on smaller repo** — expo self-refine averaged
   ~$0.70/iter. Snapshot's smaller codebase should iterate cheaper.

## Live log

### 17:52 — Iter-1 spawned

Banner confirms:
- Gates: 1 seeded (`deno_test`) — correct auto-discovery.
- Scope: 1 glob (`src/**`) — agent bounded to source only.
- No stale-baseline warning — correct, fresh repo.

### 17:52 — Iter-1 full-read exploration

Agent read all four source files (snapshot.ts, types.ts,
snapshot_test.ts, mod.ts) in ~18 seconds. Ratio-wise that's much
faster than on expo (which took several minutes on iter-1). The
small codebase means the agent gets to "now I understand the code"
quickly. Good signal for tier-1's thesis ("should just work on small
repos").

Not-surprising observation: agent is reading the tests FIRST,
probably to understand invariants before proposing changes. This is
good behavior — it means gate understanding precedes change
proposals. Hypothesis: on a heavy-test-coverage repo (like this
one at 713:488 test:impl), agents are MORE likely to converge
cleanly because they see the gate shape up front.

### 17:53 — Iter-1 made a REAL keep that got false-scope-violated

Iter-1 proposed: add validation to `addGate()` for empty `name`/`command`
strings. Wrote the validation in snapshot.ts, added a test, ran
`deno task test` → all 20 tests pass including the new one. 8 LOC
production change. Agent verdict: `keep`.

**Then:** force-discarded for scope violation on:
- `.expo/logs/bus-refine-1776102722292.jsonl`
- `.sigbus/`

### Finding #8 — scope enforcement can't distinguish agent edits from expo's own runtime output

**Severity:** HIGH. Makes refine unusable on any repo that doesn't
know to gitignore expo's internals.

`agentTouchedPaths` is computed as `postAgentDirty \ preAgentDirty`
from `git status --porcelain`. During every agent run, expo writes
to:
- `.expo/logs/bus-refine-NNN.jsonl` (its own bus event log)
- `.sigbus/*` (signal bus persistence)

These paths become "newly dirty" via git status during the agent run,
and scope enforcement treats them as agent-touched files.

**Why it didn't surface on expo self-refine:** expo's own
`.gitignore` explicitly lists `.expo/logs/`, `.expo/output/`, `.sigbus/`.
So those files never appeared in `git status --porcelain`, and they
never hit `agentTouchedPaths`.

**Snapshot's `.gitignore`** lists only `.refine/` and `.DS_Store`.
So `.expo/logs/` and `.sigbus/` ARE tracked, ARE in git status, and
scope enforcement falsely triggers.

Fix options:
1. **Exclude expo's state dirs from `listDirtyPaths()`.** Filter paths
   starting with `.expo/`, `.sigbus/`, `.refine/` before diffing.
   Cleanest. One-line change in `listDirtyPaths` in refine.ts.
2. **Auto-update .gitignore on init.** On first refine run, append
   those patterns to the target repo's .gitignore. Intrusive but
   transparent.
3. **Refuse to run if .gitignore doesn't cover expo state.** Defensive.
4. **Warn on startup if .gitignore doesn't cover these.** Softer.

Option 1 is the correct fix. Option 2 or 4 as companion UX. The
scope check should be about "what the AGENT deliberately touched,"
not "what changed in the working tree during the agent's run" — the
current implementation conflates these.

### 17:54 — Iter-2 debugs weird post-discard state for 30+ seconds

Iter-2 spawned at 17:53:20 (right after iter-1's force-discard).
Opened with exploration and quickly noticed: snapshot.ts and
snapshot_test.ts appeared deleted in `git status`. Agent spent
~20 seconds in Bash calls investigating:

- `git status`
- `ls .sigbus/`
- `git log --oneline -20`
- `git ls-files src/`
- `git show HEAD:src/snapshot.ts | wc -l`
- `git show --stat 428f0c7`

Ultimately recovered via `git checkout HEAD -- src/snapshot.ts
src/snapshot_test.ts`. Agent's diagnosis: "The 'refine/000' commit
was empty, so those deleted files were just leftover state."

### Finding #9 — post-force-discard working tree is confusing

**Severity:** MEDIUM. Causes wasted iteration budget.

After a scope-violation force-discard, the working tree ends up in a
state that doesn't match either the parent variant OR HEAD. Specifically:
- Parent variant (refine/000) is `git commit --allow-empty` of the
  initial state
- Discarded child (refine/001) committed iter-1's edits
- Restore to parent: `git checkout refine/000 -- .` reverts tree to
  refine/000's state, which MATCHES `a00e79c` (the initial tree)
- But HEAD of `shakedown-tier1` is STILL at refine/001's commit
  (commits aren't rolled back, only the working tree is)

So `git status` after force-discard says "deleted: src/snapshot.ts"
because:
- Index = refine/001 (has iter-1's version)
- Worktree = refine/000 (empty commit → inherits a00e79c's tree)

These AREN'T actually equivalent because refine's snapshot step
changes what's staged. The agent sees this as "files deleted" even
though the content is physically on disk via a00e79c's ancestry.

### Finding #10 — force-discard leaves branch HEAD advanced (Finding #7 compounding)

**Severity:** HIGH — this is the actual per-iteration variant of #7.

Finding #7 was "successful keeps commit to branch HEAD." Finding #10
is the flip side: **force-discards also commit first, then the
rollback only reverts the working tree — not the branch HEAD.**

Sequence:
1. Agent runs, makes edits
2. Snapshot backend commits to branch (advances HEAD), tags as
   `refine/001`, records `status: "kept"` in manifest
3. Post-snapshot: scope check fires, finds violation
4. `recordDiscardAndMaybeBranch` runs `restore(dir, parent)` to get
   working tree back to pre-iteration state
5. Variant's manifest record gets updated to `status: "discarded"`
6. **But the commit on the branch remains.** The tag moves from
   "kept" to "discarded" semantically, but the branch HEAD is still
   pointing at that commit.

Practical implication: every force-discarded iteration still leaves
a commit on the branch. Main branch (or in this case shakedown-tier1)
grows with discarded-variant commits. There's no way to distinguish
"kept" from "discarded" by looking at `git log` — they all show as
normal commits with message `refine/NNN`.

### 17:54 — Iter-2 recovers and pivots to restore() error clarity

Agent self-healed from the weird state (~30 seconds lost) then
pivoted to a different improvement:
- Improve `restore()` error when variant isn't found — list available IDs.
- Added production change + test.
- Tests passing.

If this also gets scope-violated, we'll have confirmation that #8
hits EVERY iteration, not just iter-1.

### [waiting for final verdict]

