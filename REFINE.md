# REFINE.md — Cross-Session Learning

Living notes for the autorefine loop on this project. Update each session; keep concise.

## Project shape

- Files touched so far: `src/refine.ts`, `src/workflow.ts`, `src/cli.ts`, `src/orchestrator.ts`.
- Verification gates that have been reliable signals:
  1. `deno check` / typecheck
  2. gate unit tests (29 cases)
  3. snapshot tests (17 cases)
- All three are fast and deterministic. Safe to rely on as the keep/discard oracle.
- `.brief/agentic-audit.md` is a durable source of scoped, prioritized refinement targets.

## Heuristics learned

**What worked**
- **Extract-helper refactors on duplicated or nested blocks.** ~30-line blocks with clear I/O lifted into named helpers, behavior preserved exactly. First-try pass rate: 100%.
- **Audit-driven fixes.** When pure-extraction wins dried up, `.brief/agentic-audit.md` gave a queue of real behavior bugs (empty-output success, NaN flags, fuzzy verdict parsers). Each fix added a new terminal status / exit code orchestrators can detect.
- **Rubric discipline.** When the rubric's scope is exhausted, a no-op iteration (007) is the correct answer — don't invent new work.
- **Follow the comments + prioritized audit lines.** Comments, P1/P2 tags, and file:line refs are free hints.

**What didn't work / unknown**
- No cross-file refactor attempted; all iterations stayed single-file.
- No performance or algorithmic work yet.
- No variant has been discarded — queue has been conservative. A discard would calibrate where the gates actually bite.

**Rules of thumb for keep/discard**
- If all three gates pass and the diff either reduces duplication/nesting OR adds a machine-readable failure signal without removing public API, keep.
- Behavior-preserving extractions are safest; audit-scoped fixes that only *add* failure modes (new statuses, new exit codes) are next safest.
- When rubric scope is exhausted, prefer baseline over scope creep.

## Suggestions for next session

1. **Pick a fresh rubric / audit slice.** Remaining audit items (costGuard enforcement, timeout pgid kill, web auth, bus rotation, SSRF) are bigger and riskier — rubric one at a time.
2. **Try a cross-file refactor.** E.g., shared verdict/exit-code constants across orchestrator, cli, refine. Tests whether gates catch integration breakage.
3. **Expect a first discard.** A bolder behavior change (not just new failure mode) will likely produce the first gate failure — useful signal.
4. **Avoid further extraction in `src/refine.ts`.** After 3 helpers, more splitting risks hollowing the main loop. Prefer other files.
5. **Add a regression test alongside audit fixes.** Sessions 2's 004-006 added new contracts that rely on existing gates — a targeted test would lock them in.

## Session log

### Session 2 (2026-04-12) — 8 variants, 8 kept, 0 discarded
Theme: shifted from structural extractions in `src/refine.ts` to audit-driven behavior fixes across `src/workflow.ts`, `src/cli.ts`, `src/orchestrator.ts`.

- **[000]** Baseline.
- **[001-003]** `recordDiscardAndMaybeBranch`, `attachProposedGates`, `emitRefineProgress` helpers in `src/refine.ts` (same pattern as Session 1).
- **[004]** `src/workflow.ts`: distinguish `status: "empty"` (exit 0, no output file) from real success; attach structured `reason`; surface empties in synthesis + CLI; skip synthesis when all agents empty. (audit P1, agentic-ux)
- **[005]** `src/cli.ts`: `parseIntArg` helper validating NaN/non-int/negative; replaced all 15 `parseInt(args[++i])` sites across spawn/spawn-all/review/race/ralph/workflow/mxit/refine/serve. Bad input → stderr + exit 2. (audit P2)
- **[006]** `src/orchestrator.ts`: `parseGateVerdict` / `parseRalphVerdict` require explicit `VERDICT:` line; return `UNCLEAR` on garbage. Propagated as terminal verdict, red CLI print, exit code 3. (audit P2, applied to DONE/NEXT parsers)
- **[007]** No-change iteration: all three rubric-scoped findings already landed; out-of-scope items explicitly excluded. Correct answer was "keep baseline."

All kept variants passed typecheck + 29 gate unit tests + 17 snapshot tests.

### Session 1 (2026-04-12) — 4 variants, 4 kept, 0 discarded
Theme: behavior-preserving helper extractions in `src/refine.ts` (`recordDiscardAndMaybeBranch`, `attachProposedGates`, `emitRefineProgress`). Established that the three gates are a reliable keep/discard oracle and that ~30-line duplicated blocks are the sweet spot for safe extraction.
