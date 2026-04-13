# Shakedown findings — expo-on-expo (2026-04-13)

Ongoing log. Added-to as findings surface during Shakedown A.

**Update 2026-04-13 evening:** Findings #1–#5 all fixed in the same day.
See "Fix status" sections appended to each.

---

## Finding #0 — Stale installed binary, silent

**Severity:** low (doc gap, not a bug)
**Where:** `~/.deno/bin/expo` after upgrading source

Installed binary was Mar 21 (pre-refine entirely). Running `expo refine ...`
printed top-level help and exited 0 — no "unknown subcommand" error. A user
who installed expo once and forgot to `deno task install` again after pulling
updates would silently run the old version and think the new flags were
broken.

### Fix direction

- Option A: unknown-subcommand error with exit code 2.
- Option B: embed git SHA at compile time + `expo --version` prints it +
  compare against source when run inside the repo.
- Option C (cheap): QUICKSTART.md note at top — "if flags don't work, run
  `deno task install` to recompile."

---

## Finding #1 — `expo refine --help` fires a real agent and creates a stray `--help/` directory

**Severity:** MEDIUM — real money burn + filesystem pollution on a typo.
**Where:** src/cli.ts refine subcommand arg parsing
**Cost of reproduction:** $0.33 (1 refine iteration + 1 update-md iteration)

### Repro

```bash
$ expo refine --help
[expo]  Refine Loop
  Directory:  --help      # <-- "--help" consumed as positional
  Rubric:     (none — agent will decide)
  Max iter:   10
  ...
# agent spawns, spends money, writes to ./--help/.refine/
```

### What happens

`expo refine <dir>` parses `--help` as the `<dir>` positional argument. It
then:
1. Creates `./--help/.refine/` (hidden-git backend, full manifest)
2. Spawns a real Claude agent against the empty directory
3. Spawns a second agent (`refine-update-md`) to write REFINE.md
4. Total burn: $0.33 for a run the user asked for with `--help`

Artifact preserved at `shakedown/2026-04-13-expo-on-expo/finding-01-dash-help-stray-dir/`
— includes the fabricated REFINE.md (the agent helpfully tried to reason
about what `--help/` should contain, concluding "Empty ≠ broken").

### Root cause

CLI arg parsing for `refine` takes `args[0]` as `<dir>` without checking
whether it starts with `--`. There's no explicit `--help` handling on
the refine subcommand at all.

### Fix direction

1. **Reject `--`-prefixed tokens as the positional dir** in `cmdRefine`
   (and analogously `cmdMxit`, `cmdWorkflow`, `cmdReview`, `cmdSpawn`,
   `cmdRace`). Exit code 2 with a clear message.
2. **Recognize `--help` / `-h` on subcommands** and print the subcommand-
   specific help block (falls out naturally from #1 if help is the only
   reason someone passes `--help`).
3. **Guard before `.refine/` creation**: if the target dir doesn't exist,
   refuse to implicitly mkdir it. Require the dir to exist already or
   require `--create-dir`. This catches the --help case AND typos like
   `expo refine srcc`.

### Related

This likely affects every other subcommand that takes a positional. Audit
needed. The worst case is that `expo spawn --help "actually my prompt"`
spawns an agent with `--help` as the prompt. Cheap test, worth doing.

---

## Finding #1-audit — full positional-eats-flag audit across all subcommands

**Done read-only** via `git show HEAD:src/cli.ts > /tmp/cli-audit.ts`, no
changes to working tree (shakedown was running — sandbox discipline).

### Method

Grepped every `args[0]`-style positional assignment in src/cli.ts and
inspected the 12 lines of validation after each. Classified by blast
radius when `--help` (or any `--flag`) is passed as the positional.

### Matrix (from cli.ts@cd31662)

| Line | Subcommand     | `--help` consumed as | Blast radius                            | Status       |
|------|----------------|----------------------|-----------------------------------------|--------------|
| 182  | `spawn`        | `prompt`             | **Spawns real agent with "--help" prompt**  | VULNERABLE   |
| 334  | `spawn-all`    | `tasksFile`          | `JSON.parse` fails → exit 1             | fail-safe    |
| 426  | `resume`       | `agentId`            | Registry lookup fails → exit 1          | fail-safe    |
| 506  | `fork`         | `agentId`            | Registry lookup fails → exit 1          | fail-safe    |
| 565  | `review`       | `prompt`             | **Spawns two agents (work + review)**   | VULNERABLE   |
| 711  | `ralph`        | `workPrompt`         | `gatePrompt` missing → Usage → exit 1   | fail-safe    |
| 786  | `workflow`     | `workflowFile`       | `readTextFile("--help")` fails → exit 1 | fail-safe    |
| 905  | `mxit`         | `tasksFile`          | `readTextFile("--help")` fails → exit 1 | fail-safe    |
| 979  | `permissions`  | `subcommand`         | "Unknown subcommand: --help" → exit 1   | fail-safe    |
| 1109 | `refine`       | `dir`                | **Creates `--help/` dir, spawns agent** | VULNERABLE   |
| 1623 | `audit`        | `dir`                | Explicit `\|\| dir === "--help"` check  | **SAFE**     |

### Summary

- **3 commands burn real money** on `--help`: `spawn`, `review`, `refine`
- **7 commands fail safely** (misleading errors but no $ burn)
- **1 command is properly guarded** (`audit`): `if (!dir || dir === "--help")`

### Fix options (post-shakedown)

**Minimal:** copy `cmdAudit`'s pattern to the 3 vulnerable commands:
```typescript
if (!prompt || prompt === "--help" || prompt === "-h") {
  // print usage, exit 1
}
```

**Better:** extract a shared helper at the top of cli.ts:
```typescript
function requirePositional(args: string[], name: string, usage: string): string {
  const v = args[0];
  if (!v || v.startsWith("--") || v === "-h") {
    console.error(usage);
    Deno.exit(1);
  }
  return v;
}
```
Apply to every positional-taking command. The fail-safe ones get cleaner
error messages too ("expected filename, got flag `--help`" instead of
confusing downstream failures).

**Also consider:** a `parseArgs` refactor to use Deno's std `parseArgs` or
a minimal homegrown one. The current hand-rolled approach has inconsistent
`--help` semantics across commands (some don't even have per-command help
output — the top-level help is all there is).

### Severity re-think

Originally I rated Finding #1 as medium-severity. After this audit:
- `refine --help` → stray dir + agent spawn ($0.33)
- `spawn --help` → agent with "--help" as prompt (could easily run $2+)
- `review --help` → two-agent loop, can run much higher

Medium is still right — these are all user typos, not security issues,
and the worst case is bounded by the default `--timeout` (0 for spawn
means NO timeout, which is scary). Consider raising default `--timeout`
for `spawn` to something sane (5 min?) as a belt-and-suspenders change
independent of the `--help` fix.

---

## Finding #2 — scope glob `tests/**` does NOT match `tests/FILE.ts`

**Severity:** HIGH. This force-discarded a genuinely good iteration.
**Where:** wherever expo's `--scope` glob matcher lives (likely refine.ts)

### Evidence

Iter-3 of Shakedown A:
- Agent edited `src/workflow.ts` to improve the unknown-sandbox-preset error
  message (listing valid presets instead of failing opaquely).
- Agent wrote a regression test at `tests/test-workflow-sandbox-error.ts`.
- Agent verdict: `keep` (both gates + rubric satisfied).

But then:
```
[refine] scope violation — agent touched 1 file(s) outside --scope:
         tests/test-workflow-sandbox-error.ts
```

Shakedown's scope was `--scope "src/**" "tests/**"`. The path
`tests/test-workflow-sandbox-error.ts` matches `tests/**` by any
reasonable reading — a file directly under `tests/`. But the matcher
force-discarded it anyway.

### Root cause hypothesis

Classic `**`-semantics gotcha. In some glob libraries (including some
minimatch configurations), `tests/**` requires at least one additional
path component after `tests/`, so:
- `tests/sub/file.ts` ← matches
- `tests/file.ts`     ← does NOT match

Fix is usually a glob option (`matchBase`, `globstar: true`) OR writing
`tests/**/*` which the user would have to know to use.

### Impact

- Iter-3 was the ONLY legitimate keep-quality iteration in the whole
  shakedown. It was thrown away.
- A user running `--scope tests/**` thinking it means "anything under
  tests/" gets silent force-discards on top-level test files. Given that
  most `tests/` directories are flat, this is the common case.
- No warning, no "did you mean `tests/**/*`?" — just discard.

### Fix direction

1. Audit the glob matcher implementation in src/refine.ts. Identify
   whether this is minimatch, a hand-rolled matcher, or something else.
2. If minimatch: `{ matchBase: true }` or equivalent so top-level
   matches work.
3. Alternatively: internally normalize `<glob>/**` → `<glob>/**/*` at
   scope-parse time so users don't have to know the distinction.
4. Add a test case: `tests/foo.ts` should match `tests/**`.

### Related findings

Hypothesis #5 in the shakedown brief was "Scope enforcement misses some
path". This is the inverse — scope enforcement is OVER-eager. Both
variants of scope bugs are now known to exist.

---

## Finding #3 — API 500 storm gets treated as "discard" noise; loop keeps iterating

**Severity:** MEDIUM. Not a bug per se, but a money-waster during transient Anthropic outages.

### Evidence

Iterations 6, 7, 8, 9, 10 all hit `API Error: 500` within seconds of
spawning. Each was classified as `refine_verdict: discard` and the loop
kept spawning the next iteration. After 3 consecutive 500 discards, the
loop "branched to 000 (Initial state)" as if this were a semantic
convergence signal rather than infrastructure failure.

```
15:31:29  refine-iter-6  ✗ failed: API Error: 500
15:31:37  refine-iter-7  ✗ failed: API Error: 500
15:31:50  refine-iter-8  ✗ failed: API Error: 500
15:31:57  refine-iter-9  ✗ failed: API Error: 500
15:32:05  refine-iter-10 ✗ failed: API Error: 500
```

Total cost of these 5 failed iterations: ~$0.58. Small thanks to early
kill, but a longer outage on a longer run could waste much more.

### Fix direction

1. Distinguish transient infrastructure errors (API 5xx, network
   timeout) from semantic discards. Don't count them toward
   consecutive-discard branching logic.
2. Exponential backoff on 5xx errors with ceiling. If 3 consecutive
   5xx errors at short interval, PAUSE the loop (not abort, not
   branch) for N seconds and retry.
3. If backoff ceiling is exceeded, EXIT the loop with a distinct
   verdict (`INFRA_FAILURE`) instead of MAX_ITERATIONS — orchestrators
   need to know this was not a normal convergence.

### Silver lining

costGuard bounded the damage. $0.58 on 5 failed iterations is well
inside the $15 budget. So the MITIGATION (budget) worked. The BEHAVIOR
(treat infra failure as semantic signal) is wrong.

---

## Finding #4 — SEVERITY-1: snapshot restore silently rewinds working tree to state from 8 versions ago

**Severity:** 1 (per brief's decision matrix: "Uncommitted-work loss").
**Where:** project-git snapshot backend, restore operation.
**Impact:** Not actual data loss — but a legitimate panic trigger for a new user.

### Evidence

When I type-checked `src/cli.ts` after the shakedown completed, 13
errors appeared. Investigation revealed they were all caused by the
working tree having been rewound to **variant 021's snapshot state**,
which is from April 12 (the day prior) — **BEFORE** we shipped
v0.2.2-v0.2.9. The rewound state is missing:
- `loadGateFile`, `dedupeGatesByName` (v0.2.8)
- `gatePromoteThreshold` in `RefineOptions` (v0.2.8)
- `runRefineGateCheck`, `showRefineHeuristics`, `discoverAutoDefaults` (v0.2.5)
- `maxConcurrent` across race/workflow/mxit (v0.2.x)
- "WALL_CLOCK_EXCEEDED" verdict string (v0.2.3)

### What actually happened

The manifest had head=021, snapshotted April 12 21:50. Since then, the
user (me, in prior sessions) shipped 10 commits bumping versions and
adding many new exports. Those commits updated main's working tree,
but the snapshot backend kept its own internal state pointing at the
021 commit.

When Shakedown A's refine loop started, it did its normal first action:
restore the working tree to `currentParentId=021`'s state. That
restore overwrote the (newer) working tree with the (older) snapshot.

### Reversibility

Full. `git checkout HEAD -- src/` restored everything to cd31662. No
commits were altered. But during the window where the working tree was
rewound, **any build/test would have failed confusingly**, and to an
unfamiliar user this looks indistinguishable from catastrophic data
loss.

### Fix direction

This is the hardest finding to fix cleanly. Options:

1. **Detect drift before restore:** before rewinding, check
   `git rev-parse HEAD` against the snapshot's base commit. If main's
   HEAD has moved, refuse to auto-restore. Prompt: "Your working tree
   is N commits ahead of the last snapshot (021). Rebase the refine
   tree onto HEAD first with `expo refine . --sync-to-head`, or pass
   `--force` to restore anyway."
2. **Sync helper:** give users a way to fast-forward the refine tree
   to a new baseline. `expo refine . --reset-to-head` or similar —
   discards the in-flight snapshot tree and re-baselines at current
   HEAD.
3. **Warn on banner:** if head-of-main != snapshot-base-commit, banner
   should say: "⚠ Refine tree is based on <sha>, your working tree is
   at <sha>. Iterations will rewind to the older state."

Option 1 is the safest default. Option 3 is the cheapest first ship.

### Historical note

The self-playtest that drove v0.2.2-v0.2.9 ran against the working tree
AT THAT TIME. As long as you're running refine in an active session,
this problem doesn't surface. It surfaces the moment you come back to
refine after non-refine commits, which is extremely common in real use.
A critical gap for "point at another repo" — you'd hit this instantly
on any repo with ongoing non-refine development.

---

## Finding #5 — banner says "1 gate seeded on baseline" but 10 are actually in force

**Severity:** low (UX polish, not a bug)

Banner output:
```
Gates:  1 seeded on baseline
        • deno_test: deno task test
```

But iter-1's gate run included typecheck, gate-unit-tests,
snapshot-tests, ssrf-tests, race-verdict-tests, bus-pending-cap-tests,
bus-offline-signal-tests, mxit-cache-tests, scope-violations-tests PLUS
deno_test — 10 total.

A user can't tell from the banner that 9 inherited gates exist. They'd
assume they were running with just 1 gate and be surprised when a
failure references a gate they didn't know about.

### Fix direction

Banner should show: "Gates: 10 in force (9 inherited from [021] + 1
auto-seeded)". Or just the breakdown as two lines. This is a one-line
template change.

---

## Run statistics (Shakedown A, 2026-04-13)

- Verdict: `MAX_ITERATIONS` (not CONVERGED — see Finding #3: API storm
  polluted the last 5 iterations)
- Iterations: 10
- Keeps this session: 0 (iter-3 should have been a keep but got
  force-discarded by Finding #2)
- Gate-forced-discards: 1 (iter-3, via Finding #2 scope bug)
- Budget-exceeded kills: 2 (iter-4 at $2.40, iter-5 at $2.00)
- API 500 errors: 5 consecutive (iter-6 through 10)
- Cost: $8.84 of $15 budget (59% — costGuard worked)
- Duration: 1376s of 3600s cap (38%)
- Final head: `[021]` (unchanged; nothing kept)

### Was the run useful?

Enormously — despite "0 keeps", the shakedown surfaced **5 distinct
findings** including 1 severity-1 (snapshot rewind). The keep count was
supposed to be the success metric but turned out to be the wrong metric
for a shakedown: we're hunting bugs, not improving code. Finding-count
is the right metric, and 5 findings in one 23-minute run is a great
yield.

### Would I run this again on this repo?

**No — not until Finding #4 is fixed.** A second run would silently
rewind the working tree AGAIN, and if you didn't happen to investigate
type errors afterward you'd never know. Fix #4 first, then re-run
Shakedown A to confirm clean behavior.

---

## Conclusions

### Against the brief's exit criteria

> Clean refine run on 3+ repos of different shapes (language, size, maturity)

**Not met.** Shakedown A wasn't clean (5 findings). Do NOT proceed to
Shakedown B.

> Zero destructive incidents (no lost uncommitted work, no runaway spend)

**Runaway spend: no** (costGuard bounded at $8.84 of $15).
**Uncommitted work loss: yes, Finding #4** — technically reversible,
but a user who didn't know git could convincingly think they'd lost
their v0.2.2-v0.2.9 work.

> At least one surprise failure mode documented + fixed OR explicitly deferred

**Met.** Finding #1 documented and FIXED in the same session (see commit
adding `rejectFlagAsPositional`).

### Next steps (prioritized)

1. **Fix Finding #4** (snapshot rewind) before any other refine run.
   Safest is "detect drift + refuse without --force". This is probably
   ~30 min of work.
2. **Fix Finding #2** (scope glob `tests/**`) — one-line fix in the
   glob matcher. Essential for keeping legitimate iterations.
3. **Fix Finding #3** (API 5xx distinction) — ~20 min. Add an
   `INFRA_FAILURE` verdict. Not strictly required for Shakedown B but
   insurance for any longer run.
4. **Fix Finding #5** (banner) — 5 min. Pure UX polish.
5. **Defer until fix-round 2:** full audit of positional-eats-flag
   on the 7 fail-safe commands (see Finding #1-audit).

After fixes 1 + 2, re-run Shakedown A before moving to Shakedown B.

---

## Fix round (2026-04-13 evening)

All five findings landed as fixes in the same day. Commit `a71452d`
shipped the Finding #1 fix plus artifacts; this round adds #2-#5 and
the `cost-per-keep-analytics.md` brief that came out of the retrospective.

### Finding #1 — FIXED (earlier same day, commit `a71452d`)

`rejectFlagAsPositional` helper applied to cmdSpawn, cmdReview,
cmdRefine. `tests/test-cli-flag-as-positional.ts` (10 checks) locks in
exit 1 + usage-to-stderr + no stray `./--help/` dir for both `--help`
and `-h` + happy path still works.

### Finding #2 — FIXED (this commit)

cli.ts `--scope` parser is now greedy. Consumes all following
non-flag values as additional globs, AND still supports the
repeated-flag form. Both `--scope "src/**" "tests/**" "docs/**"` and
`--scope "src/**" --scope "tests/**"` work. Regression:
`tests/test-shakedown-findings.ts` checks banner reports correct count
for both forms.

The ROOT-CAUSE analysis in the original write-up above was wrong — I
assumed a glob-matcher bug. The glob library is fine; the parser
silently dropped trailing globs. Corrected narrative in the brief.

### Finding #3 — FIXED (this commit)

- New `isInfraFailure(output)` helper in refine.ts detects API 5xx,
  `api_error`, `overloaded_error`, and network errors (ECONNRESET,
  ETIMEDOUT, socket hang up, fetch failed).
- New `INFRA_FAILURE` verdict in `RefineResult.verdict`. Distinct from
  MAX_ITERATIONS / EXHAUSTED / WALL_CLOCK_EXCEEDED.
- New `infraFailures` + `consecutiveInfraFailures` counters in the
  refine loop.
- Infra failures do NOT count toward consecutive-discard branching.
- `MAX_CONSECUTIVE_INFRA_FAILURES` = 3 → early exit with
  `INFRA_FAILURE` verdict instead of spending more budget on a
  persistent outage.
- Final banner surfaces `Infra fails: N` when > 0.

10 regression checks in `tests/test-shakedown-findings.ts` cover the
classifier across real API 5xx shapes and confirm no false positives
on legitimate verdict prose.

### Finding #4 — FIXED (this commit)

- New `detectSnapshotDrift(dir, variantId)` helper — compares working
  tree against the `refine/<id>` tag via `git diff --stat`, returns
  structured summary of changed files + lines.
- Refine now refuses to start if the working tree has drifted from the
  last-kept variant's snapshot. Prints a loud, multi-line explanation
  with three recovery paths (commit/stash, `--force-stale-baseline`,
  or manual promotion).
- New CLI flag `--force-stale-baseline` skips the check explicitly.
- Exits with code 4 (distinct from existing 0/1/2/3) so orchestrators
  can detect this specific failure mode.
- 8 regression checks in `tests/test-shakedown-findings.ts` cover the
  drift detector across no-drift, file-change drift, line-add counts,
  missing tag, and non-git directory cases.

Smoke-test on this repo:
```
$ expo refine . --max 1 --rubric "test"
⚠ STALE BASELINE — refine refuses to start
  Last-kept variant:  [021] (tag refine/021)
  Drift:              48 file(s), +8271/-331 lines
  ...
```
Before this fix, that run would have SILENTLY rewound 48 files of
v0.2.2-v0.2.9 work on its first discard. Sev-1 door closed.

### Finding #5 — FIXED (this commit)

Banner now reads the baseline's gate count from the manifest before
printing. Output now correctly shows e.g. "Gates: 10 inherited from
baseline [000]" instead of "Gates: 1 seeded on baseline" when 9 gates
were already inherited. Three display modes handle the permutations:
- inherited-only: "N inherited from baseline [000]"
- seeded-only: "N seeded on baseline"
- both: "N in force (A inherited + B seeded this run)"

### Related: new brief `.brief/cost-per-keep-analytics.md`

Came out of the retrospective question "how do you figure out what
the top of the asymptotic s-curve looks like?" Cost-per-keep is the
framing. Design sketch covers the metric, why it matters, computation,
where to surface it (final summary, mid-run `[metrics]` signal,
REFINE.md session log, declarative `--stop-at-cost-per-keep` exit
flag), and why it's **meaningless without gates** (illustrated via the
"pathological gambling run" on a markdown knowledge garden). First-ship
scope is ~60 LOC; deferred to a separate session.

---

## Shakedown A status after fix round

All five findings either fixed or explicitly deferred. The question
now is whether a RE-RUN of Shakedown A would surface new bugs or be
clean. Outstanding risks:

- The working tree drift on this repo means the re-run MUST start with
  either a commit-all step OR the `--force-stale-baseline` flag. If
  forced, it re-creates the same cleanup-on-discard dynamics.
- Finding #2's fix changes shakedown semantics: `--scope "src/**"
  "tests/**"` now really scopes to BOTH directories, so iter-3's
  legitimate keep (workflow.ts + test file) would survive this time.
  That could unblock real keep-quality progress.
- Finding #3's fix means an API 500 storm no longer wastes 5 iterations
  — it exits cleanly after 3 consecutive. A re-run during a flaky
  period would exit early with INFRA_FAILURE instead of MAX_ITERATIONS.
- Finding #4's fix now hard-stops before wasting any money on a stale
  baseline, so a naive user can't silently burn the wrong tree.

Recommended: commit current working-tree drift as a snapshot variant
("re-baseline"), then re-run. OR shift to Shakedown B tier-1
(`snapshot`) since the same class of fixes applies universally.

---

# Round 2 (post-fix re-run, 2026-04-13 afternoon)

Fired with `--force-stale-baseline` since all work from the morning
fixes was committed to main at `1e41888` (not at risk). Same rubric,
same scope, same caps.

## Round-2 statistics

- Verdict: **CONVERGED** (not MAX_ITERATIONS — agent itself declared done)
- Iterations: 9
- Session keeps: 0 (all rubric- or gate-discarded)
- Session discards: 8 (7 rubric, 1 budget)
- Gate fails: 1 (real typecheck failure, NOT the buggy scope violation)
- Infra failures: 0
- Cost: $8.64 (vs round 1's $8.84 — nearly identical, very different outcomes)
- Duration: 1409s (23 min)

## Round-2 findings

All 5 pre-round-2 findings are fixed and working. Direct confirmation:
- **#2 fix (--scope parser)** — iter-2 touched both `src/**` AND `tests/**`
  files and was scope-validated correctly. Previously would have
  false-positive discarded on the test file.
- **#3 fix (infra classifier)** — zero API errors this run, but the
  classifier is in place for next time.
- **#4 fix (stale-baseline detection)** — drift check fired before
  run, `--force-stale-baseline` bypassed it as designed.
- **#5 fix (banner gate count)** — banner correctly showed "11 in
  force (10 inherited + 1 seeded this run)".

## Finding #6 — session-delta vs lifetime in final banner

**Severity:** low (UX).

Final banner reads:
```
Kept:       17
Discarded:  24
```

These are LIFETIME counts across all sessions' variants. On round 2,
that "17" includes variants 001-021 (prior sessions) plus the
single "no change" convergence marker (variant 040). Session keeps
were effectively **zero**. A user reading the banner thinks the
session produced 17 keeps.

### Fix direction

Add `sessionKept` + `sessionDiscarded` to `RefineResult` (computed as
delta between pre-run and post-run variant counts). Change banner to:
```
Kept:       1 this session (17 lifetime)
Discarded:  8 this session (24 lifetime)
```

When session == lifetime (fresh run, first time ever), collapse to
the single-number form for brevity.

## Finding #7 — SEVERITY-1: project-git snapshot backend commits to HEAD of main

**Severity:** 1. Upstream of Finding #4 and strictly worse.
**Where:** `/Users/janzheng/Desktop/Projects/_deno/apps/snapshot/src/snapshot.ts:199-202`

### Evidence

During round 2's final iteration (variant 040, "no change" convergence
keep), the snapshot backend ran:
```typescript
await run(
  ["git", "commit", "--allow-empty", "-m", `${TAG_PREFIX}${id}`],
  { cwd: dir },  // ← commits to whatever branch is currently checked out
);
```

`cwd: dir` means the project directory — whose current branch was
`main`. So the commit `refine/040` landed on `main` as a regular
commit, advancing HEAD.

Result: `main` became `1e41888 → 8f2bb47` (refine/040). The new HEAD's
code was variant 040's snapshot state, which anchored to **variant
021's pre-v0.2.2 code** — i.e. all v0.2.2 through v0.2.9 fixes were
wiped from `src/refine.ts` (2859 → 1205 lines), `src/cli.ts`, the
TASKS files, etc.

Recovery was simple because origin still had `1e41888`: `git reset
--hard 1e41888`. But:
- If `git push` had happened, recovery requires `--force-with-lease`
  and coordinating with anyone who pulled.
- Every KEPT variant advances HEAD. A 20-iteration run with 6 keeps
  produces 6 commits to main. Even clean runs leave commit noise.
- Uncommitted work between runs would be wiped by `git add -A` before
  each commit (already addressed for scope, but the `add -A` fallback
  is still there for the un-scoped case).

### Comparison to Finding #4

Finding #4 (stale-baseline rewind) was about the WORKING TREE being
silently rewound. Reversible via `git checkout HEAD -- .`.

Finding #7 is about BRANCH HEAD being silently advanced. Requires
reflog surgery or `--force-with-lease` to undo.

Both trigger from the same event (snapshot operations during a refine
run). My #4 fix catches the START condition but not the PER-KEEP
behavior during the run. #7 is the actual destructive mechanism.

### Fix direction

The hidden-git backend (`.refine/work/.git` with its own HEAD) is
already correctly implemented; the project-git path is the broken one.
Options:

1. **Detach HEAD for snapshot commits.** Before each commit, switch
   to detached HEAD at the current commit; commit; tag; switch back
   to the original branch without fast-forwarding. The tag preserves
   the commit's contents for restore; main branch HEAD stays put.
   This is the minimum-invasive fix — users' main branch never moves.
2. **Dedicated refine-only ref.** Maintain a `refs/refine/head` ref
   that advances with each kept variant. The main branch is never
   touched. Tags (`refine/NNN`) still point into this chain.
3. **Always use hidden-git backend for refine.** Expose a flag to
   force `.refine/work/` isolation even in a project-git repo.
   Skips the "commits modify your tree" problem entirely. Downside:
   the agent works in a separate worktree, so terminal UX and IDE
   integration require explicit copy paths.
4. **Refuse project-git backend by default; require `--inline`.**
   Defensive default. Combined with the hidden-git backend, makes the
   destructive path opt-in.

Option 1 is surgical; Option 3 is the safest ergonomically but
relocates where the user's code lives during a run. I'd ship Option
1 as the urgent fix and Option 3 as the long-term recommended
default.

### Severity rationale

This is arguably the single worst finding in the entire shakedown.
Unlike #4 (reversible local state), #7 produces real git history
changes that propagate on `git push`. A user following the QUICKSTART
"kick it off Friday, review Monday" flow could come back to 30+
snapshot commits on main branch, with no way to distinguish real
intent from automated snapshot noise without reading each commit.

The only reason it's not currently causing broader damage is that
we caught it before pushing. If round 2 had pushed automatically
(via a hook, CI, or a `git push` in the rubric), every downstream
consumer of expeditor would have pulled a corrupted main.

**Do not run `expo refine` on any project-git-backed repo until #7
is fixed**, unless you're on a throwaway branch you're prepared to
reset.

### Shakedown B implications

This blocks a clean Shakedown B on `snapshot` (or any tier-1/2
candidate). Workarounds for tier-1 run:
- Run on a disposable branch (`git checkout -b shakedown-refine-A` in
  the target repo first).
- Plan to `git reset --hard` back after review, regardless of outcome.

---

## Addendum: the s-curve shape of round 2

The shakedown brief asked "how do you tell when you're at the top of
the asymptotic s-curve." Round 2 produced a concrete answer worth
documenting.

### The shape of a healthy "top of the curve" run

Iter-by-iter of round 2:
1. `parseFloatArg` helper — rubric says no. Discard.
2. Error message improvement — legitimate, but typecheck failure on real code. Gate-discard.
3. Budget-exceeded on pre-existing test failure debug. Cost-guard kill.
4. Budget-flag NaN validation — discard as over-engineering.
5-8. Agent itself declares "no rubric-aligned opportunities. Declining to propose slop."
9. `converged — no change`.

The diagnostic pattern:
- Real attempts (1, 2, 4) each get a different objection — rubric,
  gate, rubric. No single-failure-mode repetition.
- Real failures (3) are bounded by existing guards.
- Self-recognition (5-8) — the agent itself says "nothing to find"
  based on its own recent-failures memory.
- Convergence (9) is the agent's OWN signal, not a system cap.

That last point is the subtle one: **ending in CONVERGED is
qualitatively different from ending in MAX_ITERATIONS**. MAX_ITERATIONS
means "ran out of trying." CONVERGED means "the loop itself agreed
we're done." If the agent's rubric is sound and its gates are real,
CONVERGED is the s-curve top.

### Why round-1's ending was LESS informative

Round 1 ended in MAX_ITERATIONS. That's consistent with three
different realities:
- Loop is broken (what actually happened — infra + parser + glob bugs).
- Rubric is wrong (we'd need to change it to know).
- Loop is correct but genuinely still has findings (one more session
  would help).

We couldn't tell which. Round 2's CONVERGED narrows it — we now know
the loop works AND the current rubric is at-or-near the top.

### Cost-per-keep signal from round 2

- Session cost-per-keep: **∞** (0 keeps / $8.64).
- Lifetime cost-per-keep on expo: $TBD / 16 real keeps ≈ some finite number.

The infinite session cost-per-keep is NOT a bug — it's a valid signal
meaning "this session produced no keeps." Combined with the
CONVERGED verdict, it means "and that's the correct answer."

Compare to round 1's session cost-per-keep (also ∞, but for the wrong
reason: the loop never got a chance to keep anything because of bugs).

This is exactly the "metric needs to be read alongside other metrics"
point from `.brief/cost-per-keep-analytics.md`. Infinite cost-per-keep
+ CONVERGED = meaningful s-curve top. Infinite cost-per-keep +
MAX_ITERATIONS + high gate-fail or infra-failure rate = broken loop
noise.

### Practical implication: what it takes to make expo-on-expo productive again

You can't extract more keeps by running more iterations with the
same rubric. You'd need to either:
1. **Change the rubric axis.** "Performance hot paths" or "ergonomic
   flag consistency" instead of error-message clarity.
2. **Change the scope.** Widen beyond `src/**` `tests/**` or narrow
   to a single file you know has issues.
3. **Change the gate set.** Add a "no TODO comments" gate, a "no
   file exceeds 500 lines" gate, a perf benchmark gate.

Each of these effectively reshapes the s-curve. The agent's
"nothing to find" message IS relative to the rubric + gates + scope
triad — not an absolute statement about the codebase.

---
