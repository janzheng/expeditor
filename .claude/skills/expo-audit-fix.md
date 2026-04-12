---
description: "Co-design an audit + fix session for a codebase. Reads the project shape, interviews the user about goals and scope, drafts a rubric + gates + budget, runs `expo refine`, and reports structured results. Use when the user says 'audit my repo', 'refine X', 'clean up audit findings', 'run expo on /path', 'fix the long tail', or wants safe autonomous bug fixes with regression tests. This skill wraps the `expo audit` + `expo refine` commands in a focused interview so users don't have to craft rubrics from scratch."
user_invocable: true
---

# expo — Audit & Fix Session

Co-design a gate-validated autonomous fix run. This skill is the **consultant**; `expo audit` + `expo refine` are the **execution engine**. Your job is to turn a vague ask ("clean up my repo") into a precise, safe configuration.

## What this skill produces

At the end, the user has:
- A `.brief/audit-YYYY-MM-DD.md` with ranked findings (if no recent audit existed)
- An optional `.brief/audit-YYYY-MM-DD-triage.md` filtering false positives
- 3–8 git commits, each fixing one audit finding with a regression test attached
- `refine/NNN` commits gate-validated against typecheck + the user's test suite
- A cost summary (typical range: $3–8 total)

## The 4-phase flow

### Phase 1 — Introspect (no questions yet)

Before asking the user anything, read the project:

1. **Language / test commands** — check for these in order, use the first match:
   - `deno.json` → `deno task test`, `deno check src/`
   - `package.json` → `npm test` (or `"test"` script), `tsc --noEmit` if TypeScript
   - `pyproject.toml` → `pytest -x` or `pytest tests/`
   - `Cargo.toml` → `cargo test --no-run` + `cargo check`
   - `go.mod` → `go test ./... -count=1`
   - Makefile with `test:` target → `make test`
2. **Git state** — `git status --porcelain`. If dirty, warn but don't block (refine's scope-fix handles parallel work).
3. **Prior audit** — `ls .brief/audit-*.md 2>/dev/null | sort | tail -1`. If found and less than 7 days old, offer to reuse; otherwise propose re-running.
4. **Prior refine archive** — `.refine/manifest.json` existence. If present, the session will continue from HEAD.
5. **REFINE.md** — if present, read its "Heuristics learned" section — those are cross-session learnings that should inform the rubric.
6. **TASKS-*.md** — scan for any `#audit` or `#agentic-ux` tagged items to understand existing priorities.

Do this introspection silently with Bash/Read/Glob. Output one summary line when done:

```
Project: <language> · tests: <command> · audit: <fresh|stale|none> · archive: <count> variants · heuristics: <yes|no>
```

### Phase 2 — Interview (minimum questions)

Ask the user **at most 3 questions** — fewer if you can infer. Use AskUserQuestion tool if available; otherwise plain text.

**Q1 — Session goal.** Pick one:
- `fix-audit` — work through `.brief/audit-*.md` findings (default if recent audit exists)
- `security` — run a security-focused audit, then fix P1/P2 findings
- `cleanup` — behavior-preserving clarity / DRY / dead-code removal
- `custom` — user provides a one-sentence goal

**Q2 — Budget.** Default `$4` total, `$1/agent`. Ask only if the user hasn't specified.

**Q3 — Scope.** Auto-propose based on goal:
- `fix-audit` → derive scope from the files mentioned in the audit's `**File:**` lines, **plus `src/**/*.ts` as a floor if those files import from unlisted helpers** (agents sometimes legitimately create new helper files for clean architecture — if scope is too narrow they can't do good work)
- `security` → all `src/**`
- `cleanup` → `src/**` but exclude tests/ and generated files
- `custom` → ask the user which files/globs

Always include `tests/**` in scope — refine requires regression tests per fix.

**Scope-writing gotchas** (learned the hard way in Session 3 of this codebase's own refine history):

1. **Lock files are auto-exempt.** `deno.lock`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, `go.sum`, `uv.lock`, `poetry.lock`, `Pipfile.lock`, `composer.lock`, `Gemfile.lock`, `mix.lock` — all auto-allowed regardless of scope. The toolchain modifies them as a side effect when imports change; the agent didn't choose to touch them. (This is enforced by `findScopeViolations` in src/refine.ts; skill just documents the list.)

2. **Scope too narrowly → agents can't extract new helpers.** If the rubric's cleanest fix is "extract a pure helper into a new file", an over-narrow `--scope "src/specific-file.ts"` will force-discard the iteration. For audit-fix sessions, default to a 2-line floor: `"src/**/*.ts"` (or language equivalent) + `"tests/**"`. Add more restrictive globs only if the user explicitly needs a file to NOT be touched.

3. **Scope as a guardrail, not a map.** The user mental model should be "what must NOT be touched" → exclude from scope, NOT "what SHOULD be touched" → enumerate. Agents need room to create supporting files; that's usually good code, not a violation.

**Explicitly do NOT ask about:**
- Which gates to use (auto-derive from project shape — step 1)
- Which model (default claude-opus-4-6; only ask if user explicitly brings it up)
- Iteration count (default 5; auto-adjusts based on audit finding count)
- Timeout (default 300s per iteration)

### Phase 3 — Draft and confirm

Show the user a draft rubric + configuration **before running**. Format:

```markdown
Proposed refine session:

Directory: <dir>
Goal: <goal>
Findings targeted: <N> from .brief/audit-*.md

Rubric:
  Fix one audit-flagged <category> finding per iteration. Candidates:
    1. <finding name> (<file:line>) — <what goes wrong, one line>
    2. <finding name> (<file:line>) — <what goes wrong, one line>
    3. <finding name> (<file:line>) — <what goes wrong, one line>
  Each KEEP must add a regression test to tests/ or equivalent. If a fix
  ships without a test, DISCARD. Cite the finding name + test file in the
  verdict summary.

Scope (hard constraint):
  <src/file-a.ts, src/file-b.ts, tests/**>

Gates (must pass on every KEEP):
  - typecheck: <inferred command>
  - tests: <inferred command>
  - <any project-specific gates from TASKS.md or README>

Budget:
  --per-agent-budget $X  --total-budget $Y  --max N

Estimated cost: $<low>-$<high> · estimated time: <X>-<Y> min
```

**Ask for approval** with one of: yes/go/ship OR suggested edits.

If the user edits, apply and re-show. Common edits:
- "tighten the budget" → halve both budgets
- "fewer iterations" → reduce --max
- "add X to scope" → append glob
- "don't touch Y" → confirm Y isn't in scope (and if it is, remove it)

### Phase 4 — Execute + report

Run the command via Bash. Use `run_in_background: true` so the agent can continue while refine works. Stream status updates every ~60s by tailing the log. Don't re-read every line — just the last 10–20 after checking the process is still alive.

On completion:

```markdown
✓ Refine session complete

Verdict: <CONVERGED|MAX_ITERATIONS|EXHAUSTED>
Iterations: <N>  ·  Kept: <K>  ·  Discarded: <D>
Cost: $<total>
Final variant: <id>

Commits landed on main:
  <sha> <message>
  <sha> <message>
  ...

Findings addressed:
  ✓ <finding name> — <one-line summary> (test: tests/test-xxx.ts)
  ✓ <finding name> — <one-line summary> (test: tests/test-yyy.ts)
  ✗ <finding name> — discarded: <reason>

Remaining audit findings: <list any untouched items>

Next move:
  <suggestion>
```

If verdict is `EXHAUSTED` (3 consecutive discards), the loop hit a dead-end. Surface the discard reasons and ask the user whether to retry with a different rubric or stop.

If a gate failed or the budget was exceeded, say so explicitly — those are the two "failure modes that should never be silent."

## Rubric-writing heuristics (encoded)

These are rules the skill should bake in, not rules the user has to know:

1. **One focused change per iteration.** Never "fix multiple bugs in one diff." The rubric must say "pick the SINGLE most impactful finding."

2. **Require regression tests.** Always include "Each KEEP must add a regression test. If a fix ships without a test, DISCARD." This has been the highest-leverage constraint we've found.

3. **Cite file:line from the audit.** Tells the agent exactly where the bug is. Dramatically better than "find bugs in src/bus.ts."

4. **Use `--scope` globs, not rubric prose.** If a file MUST not be modified, put it outside --scope. Don't rely on "do NOT modify X" — that's a suggestion to an intelligent reader; --scope is a gate.

5. **Cite cross-session heuristics when relevant.** If REFINE.md exists, surface its "What worked" rules in the rubric. They're the agent's own advice.

6. **Gates must be fast and deterministic.** No network, no flaky tests, no long benchmarks. Gates run on every KEEP — 30s total is fine, 3min is painful, 10min kills the loop.

7. **When the rubric's scope is exhausted, KEEP BASELINE is the right answer.** Don't pressure the agent to invent new work. This comes up when refine converges before max iterations.

## Anti-patterns to avoid

**Don't** skip the audit phase and jump straight to refine with a vague rubric like "improve the codebase." Without audit findings the rubric is drift-bait.

**Don't** set `--total-budget` so high that a runaway iteration can't be stopped. $10 is usually already enough; $50 is "I forgot what this tool costs."

**Don't** run refine with no gates. The whole thesis is gates-as-trust-basis. Without gates, refine is expensive coin-flipping.

**Don't** use `--allow-agent-gates` on the first session. Let the agent earn that privilege after you've seen a couple of clean runs.

**Don't** run refine when the working tree has substantial uncommitted work. The scope-fix prevents mixing, but a clean tree is still cleaner.

**Don't** invoke this skill for code the user hasn't asked to touch. Always confirm the target directory.

## When NOT to use this skill

Use the direct commands (`expo audit`, `expo refine`) when:
- The user already has a rubric written (they know what they want)
- Running in CI / automation (no interactive interview)
- Iterating on a previous session (pass `--branch-from` to continue from a specific variant)
- Trying to calibrate what gates can catch (the user wants to deliberately try bolder changes)

## Examples

### Example: "audit my expo repo"

```
skill> Project: Deno · tests: deno task test · audit: stale (7 days) · archive: 7 variants · heuristics: yes

skill> I see an audit from 2026-04-12 plus REFINE.md heuristics. Want to:
       (a) reuse the existing audit, (b) re-run audit, or (c) skip audit entirely?

user> reuse

skill> Three audit findings remain unaddressed:
       - claude-adapter lossy command parse (P3)
       - domain filter bash injection (P2)
       - web endpoint full-rescan (P2)
       - permission HTTP ledger race (P2)

       Proposed:
       <full draft as above, cost $3-4>

       Approve?

user> go

skill> [runs expo refine in background, streams status, reports on completion]
```

### Example: "clean up src/workflow.ts"

```
skill> Project: Deno · tests: deno task test · audit: none · archive: 0 variants

skill> No audit found. I'll run a quick audit focused on src/workflow.ts
       first ($1-2), then draft a fix rubric. OK?

user> yes

skill> [runs expo audit . --focus all --cap 10, then drafts rubric]
```

### Example: "refine the parser to improve perf"

```
skill> Project: Python · tests: pytest tests/ · audit: none · archive: 0

skill> Perf work is harder — gates can't catch a slowdown unless you have
       a benchmark. Do you have a benchmark command that fails below some
       threshold? If not, I'd suggest either:
       (a) add a benchmark test first, then refine with it as a gate
       (b) refine for clarity/DRY only (safe) and check perf after

user> option a, I'll add the benchmark

skill> Good call. Once you have `pytest tests/perf_test.py` that fails
       below <target>, come back and I'll wire it as a gate.
```
