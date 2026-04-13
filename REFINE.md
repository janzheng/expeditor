# REFINE.md — Cross-Session Learning

Living notes for the autorefine loop on this project. Update each session; keep concise.

## Project shape

- Files touched: `src/refine.ts`, `src/workflow.ts`, `src/cli.ts`, `src/orchestrator.ts`, `src/bus.ts`, `src/mxit-runner.ts`, `src/spawner.ts`, `src/claude-adapter.ts`, `src/permission-ledger.ts`, `src/web.ts`.
- Verification gates (fast, deterministic keep/discard oracle):
  1. `deno check` / typecheck
  2. gate unit tests (29 cases)
  3. snapshot tests (19 cases)
  4. SSRF tests (28 cases)
  5. Per-iteration regression tests under `tests/` (added alongside most audit fixes)
- `.brief/agentic-audit.md` remains the durable source of scoped, prioritized targets.

## Heuristics learned

**What worked**
- **Extract-helper refactors.** ~30-line duplicated/nested blocks lifted into named helpers — still 100% pass rate.
- **Pure helper as the test surface.** Every audit fix this session (`resolveRaceWinner`, `enqueueBounded`, `findTaskByLine`, `isValidAllowedDomain`, `buildBashDenialPattern`, `parseRunStats`, `mutatePermissionLedger`) exported a pure seam so the regression test stays cheap.
- **Cache via mtime + `{path,mtime,size}`.** Works for both TASKS.md (mxit-runner) and immutable run files (web.ts) — same shape, same gates green.
- **Process-wide singleton + serialized mutation chain.** `permission-ledger.ts` closed the read-modify-write race without touching web handler shape dramatically — passed scope check once kept to a single file.

**What didn't work**
- **Scope violations on multi-file fixes.** 3 discards in Session 3 ([014]–[016]) and stubs in this session tried adding new files (`permission-ledger-singleton.ts`) or touching `deno.lock`/multiple adapters at once. Lesson: when the fix naturally spans files, land the core as a single-file in-place change first (in-place singleton instead of new file) and let a later iteration wire consumers.
- **Verdict-parse discards.** [012], [017], [020] — agent finished clean work but emitted no `VERDICT:` line, defaulting to discard. Unresolved; may be masking legit keeps.
- **Still no cross-file refactor landed.** Every keep remains single-file.

**Rules of thumb for keep/discard**
- All gates green + diff stays in rubric scope + reduces duplication/nesting OR adds machine-readable failure signal without removing public API → keep.
- Scope check is a hard gate — no new files, no lockfile touches, no unlisted adapters.
- When rubric is exhausted, baseline beats scope creep (confirmed across 3 sessions).

## Suggestions for next session

1. **Resolve verdict-parse discards.** 3 instances this session alone. Tighten rubric prompt to demand `VERDICT:` at start of final message, or relax orchestrator to accept terminal `KEEP`/`DISCARD` when no parse-match found.
2. **Attempt the cross-file refactor.** Shared verdict/exit-code constants across orchestrator/cli/refine is still the cleanest test for whether gates catch integration breakage.
3. **Remaining audit items.** costGuard enforcement, timeout pgid kill, web auth — each as its own single-file rubric pass with paired regression test.
4. **Clean Session 3 stragglers.** Untracked `src/permission-ledger-singleton.ts`, `src/run-file-cache.ts` and leftover test files should be removed (Session 4's [019]/[021] landed superseded in-place variants; the scratch files are now dead).
5. **Keep the pure-helper-as-seam pattern.** It's the house style for audit fixes.

## Session log

### Session 4 (2026-04-12) — 22 variants, 16 kept, 6 discarded
Theme: continued audit-driven fixes with paired regression tests. Broadest session yet — touched 4 new files (`claude-adapter.ts`, `permission-ledger.ts`, `web.ts`, plus re-touches). Discards split between verdict-parse failures (3) and scope violations (3) from trying to solve inherently multi-file audit findings.

- **[000]** Baseline.
- **[001–006]** Re-landed Sessions 1 & 2 work (refine.ts helpers; workflow empty-output; parseIntArg; verdict parsers).
- **[007]** No-op — rubric exhausted at that point.
- **[008]** `orchestrator.ts`: `resolveRaceWinner` + `pickParsed`/`fallbackReason` on RaceResult; CLI flags fallback winners yellow (tests/test-race-verdict.ts, 16 checks).
- **[009]** `bus.ts`: `enqueueBounded` caps pendingWrites at 10k, FIFO drop-oldest (tests/test-bus-pending-cap.ts, 17 checks).
- **[010]** `bus.ts`: `offline` getter + `onStatus` subscription; `emit()` returns bool on dropped log (tests/test-bus-offline-signal.ts, 21 checks).
- **[011]** `mxit-runner.ts`: mtime-gated TASKS.md cache + `findTaskByLine`/`updateCachedStatus` (tests/test-mxit-cache.ts, 14 checks).
- **[012]** DISCARDED — verdict parse failure.
- **[013]** `spawner.ts`: `isValidAllowedDomain` RFC-1123 check refuses bash metacharacters (tests/test-domain-filter-injection.ts, 37 checks).
- **[014]–[016]** DISCARDED — scope violations (new singleton file, deno.lock touches, multi-file adapter).
- **[017]** DISCARDED — verdict parse failure.
- **[018]** `claude-adapter.ts`: `buildBashDenialPattern` wraps full command verbatim instead of whitespace-splitting (tests/test-claude-denial-pattern.ts, 35 checks).
- **[019]** `permission-ledger.ts`: process-wide singleton + serialized mutation chain, in-place (no new file, stayed in scope).
- **[020]** DISCARDED — verdict parse failure.
- **[021]** `web.ts`: `parseRunStats` + `{path,mtime,size}` cache shared by handleListRuns + handleCostSummary; fixes incidental undefined-agentId pollution bug.

### Session 3 (2026-04-12) — 18 variants, 13 kept, 5 discarded
First discards of the project: 3 scope violations (new files, lockfile) + 2 verdict-parse failures. Established scope-file check as a distinct hard gate, and the no-op iteration as the correct answer when rubric is exhausted. Landed: resolveRaceWinner, enqueueBounded bus cap, bus offline signals, mxit TASKS.md cache, domain filter injection guard.

### Session 2 (2026-04-12) — 8 variants, 8 kept, 0 discarded
Shifted from extractions to audit-driven behavior fixes: status:"empty" for no-output success, `parseIntArg` NaN validation, strict `VERDICT:` parsing with UNCLEAR exit code 3. Established machine-readable failure signals as the second-safest change class.

### Session 1 (2026-04-12) — 4 variants, 4 kept, 0 discarded
Behavior-preserving helper extractions in `src/refine.ts`. Established the three-gate oracle and the ~30-line duplicated-block sweet spot.
