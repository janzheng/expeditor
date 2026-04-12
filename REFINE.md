# REFINE.md — Cross-Session Learning

Living notes for the autorefine loop on this project. Update each session; keep concise.

## Project shape

- Target file so far: `src/refine.ts` — the main refinement loop orchestrator.
- Verification gates that have been reliable signals:
  1. `deno check` / typecheck
  2. gate unit tests (29 cases)
  3. snapshot tests
- All three are fast and deterministic. Safe to rely on as the keep/discard oracle.

## Heuristics learned

**What worked**
- **Extract-helper refactors on duplicated or nested blocks.** Three wins in a row (discard+branch, proposed-gates attachment, progress-signal emit) all followed the same recipe: find a ~30-line block with clear inputs/outputs, lift into a named helper in the same file, preserve behavior exactly. Every one passed all gates on first try.
- **Single-file, single-concern diffs.** Keeping changes scoped to `src/refine.ts` made verification cheap and kept the blast radius small.
- **Follow the comments.** 001 was spotted because a comment literally flagged the duplication. Author intent markers are free hints.

**What didn't come up yet (so unknown)**
- Cross-file refactors.
- Behavior changes (all three kept variants were pure restructuring).
- Performance or algorithmic improvements.

**Rules of thumb for keep/discard**
- If all three gates pass and the diff reduces line count or nesting without changing semantics, keep.
- Behavior-preserving extractions are the safest genre; prefer them early in a project's refine history before attempting riskier rewrites.

## Suggestions for next session

1. **Look beyond `src/refine.ts`.** The loop file has had three consecutive extractions — diminishing returns likely. Scan sibling files (gates, bus, session logging) for similar duplication patterns.
2. **Try a naming/clarity pass.** Now that helpers exist, their names and signatures may be improvable. Low-risk, high-readability.
3. **Consider a small behavior improvement.** E.g., better error messages on gate failure, or clearer progress-signal payloads. Still low-risk but not purely structural.
4. **Watch for over-extraction.** If the main loop starts feeling thin / hollowed-out (just a sequence of helper calls with no narrative), back off. Readability is the goal, not helper count.

## Session log

### Session 1 (2026-04-12) — 4 variants, 4 kept, 0 discarded
Theme: behavior-preserving extractions in `src/refine.ts`.

- **[000] Baseline** snapshot.
- **[001] Keep** — `recordDiscardAndMaybeBranch` helper. Unified gate-failure and rubric-discard paths (restore-to-parent, discard logging, consecutive-discard counting, 3-strikes branching). Call sites ~30 → ~6 lines.
- **[002] Keep** — `attachProposedGates` helper. Lifted nested try/loop/emit block (~30 lines) out of main loop.
- **[003] Keep** — `emitRefineProgress` helper. Collapsed bus.emit boilerplate across 3 call sites (refine_verdict, gate_failed, gate_added).

All three passed typecheck + gate-unit-tests + snapshot-tests. No public API changes.
