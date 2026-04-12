# REFINE.md — Cross-Session Learning

Living notes for the autorefine loop on this project. Update each session; keep concise.

## Project shape

- Files touched so far: `src/refine.ts`, `src/workflow.ts`, `src/cli.ts`, `src/orchestrator.ts`, `src/bus.ts`, `src/mxit-runner.ts`, `src/spawner.ts`.
- Verification gates (fast, deterministic — safe keep/discard oracle):
  1. `deno check` / typecheck
  2. gate unit tests (29 cases)
  3. snapshot tests (17–19 cases)
  4. SSRF tests (28 cases) — added as audit scope expanded
- `.brief/agentic-audit.md` remains the durable source of scoped, prioritized targets.
- Regression tests now land alongside audit fixes (tests/test-race-verdict, test-bus-pending-cap, test-bus-offline-signal, test-mxit-cache, test-domain-filter-injection).

## Heuristics learned

**What worked**
- **Extract-helper refactors.** ~30-line duplicated/nested blocks lifted into named helpers — 100% pass rate, still the safest class.
- **Audit-driven fixes with a paired regression test.** Session 3 pattern: pick one audit finding, land the fix + a focused test file that exercises the pure helper. Test locks in the contract without needing to mutate the existing gate suites.
- **Pure helpers as the test surface.** Exporting `resolveRaceWinner`, `enqueueBounded`, `findTaskByLine`/`updateCachedStatus`, `isValidAllowedDomain`, `buildBashDenialPattern` made each fix trivially testable — the helper is the seam.
- **Scope discipline under pressure.** When 4 rubric findings are already landed, "no-op" ([007], [012]) is the correct answer. Trying to fit out-of-scope work caused all 3 discards in this session ([014]–[016] scope_violation).

**What didn't work**
- **Scope violations.** Three discards in a row ([014], [015], [016]) all from touching files outside the rubric's allow-list (new singleton file, deno.lock, web.ts, claude-adapter.ts). The gate that bit was the scope-file check, not the test gates — a new, useful signal. Leftover artifacts: `src/permission-ledger-singleton.ts`, `src/run-file-cache.ts`, and three test files in `tests/` are still untracked from these attempts.
- **Verdict parse failures as discards.** [012] and [017] discarded with "Could not parse agent verdict." When the agent's final message doesn't emit a clean VERDICT line, the orchestrator defaults to discard — worth watching whether this masks legitimate keeps.
- Still no cross-file refactor landed; all kept variants remain single-file.

**Rules of thumb for keep/discard**
- If all gates pass AND the diff stays within rubric scope AND it either reduces duplication/nesting OR adds a machine-readable failure signal without removing public API → keep.
- Behavior-preserving extractions are safest; audit-scoped fixes that only *add* failure modes are next.
- When rubric scope is exhausted, prefer baseline over scope creep — this is now a confirmed pattern (2 no-op iterations across sessions).
- Scope check is a hard gate — don't add new files or touch lockfiles unless explicitly allowed.

## Suggestions for next session

1. **Clean up Session 3 stragglers.** Untracked files (`src/permission-ledger-singleton.ts`, `src/run-file-cache.ts`, three test files) from discarded variants should be decided on — either land them in-scope or remove.
2. **Rubric the remaining audit items individually.** costGuard enforcement, timeout pgid kill, web auth, permission-ledger race. Each deserves its own rubric pass with a regression test.
3. **Cross-file refactor still unattempted.** Shared verdict/exit-code constants across orchestrator/cli/refine would test whether gates catch integration breakage.
4. **Investigate verdict-parse discards.** [012]/[017] suggest the agent sometimes finishes work but fails to emit a clean VERDICT. Worth checking if the prompt can be tightened.
5. **Keep the pure-helper-as-seam pattern.** It's now the house style for audit fixes and makes regression tests cheap.

## Session log

### Session 3 (2026-04-12) — 18 variants, 13 kept, 5 discarded
Theme: audit-driven fixes with paired regression tests; first discards of the project (all scope violations or verdict-parse failures).

- **[000]** Baseline.
- **[001–003]** Same `src/refine.ts` helper extractions as Session 1 (re-landed).
- **[004–006]** Session 2 audit fixes re-landed (workflow empty-output, parseIntArg, verdict parsers).
- **[007]** No-change iteration — rubric exhausted.
- **[008]** `src/orchestrator.ts`: `resolveRaceWinner` helper distinguishes parsed judge picks from fallback-to-branch-0; CLI flags fallbacks yellow. First regression test landed (`tests/test-race-verdict.ts`, 16 checks).
- **[009]** `src/bus.ts`: `enqueueBounded` caps pendingWrites at 10k, drops oldest FIFO on overflow with consolidated warning (`tests/test-bus-pending-cap.ts`, 17 checks).
- **[010]** `src/bus.ts`: `offline` getter + `onStatus` subscription; `emit()` returns boolean for dropped log writes (`tests/test-bus-offline-signal.ts`, 21 checks).
- **[011]** `src/mxit-runner.ts`: cache parsed TASKS.md across loop iterations via mtime + `findTaskByLine`/`updateCachedStatus` helpers (`tests/test-mxit-cache.ts`, 14 checks).
- **[012]** DISCARDED — verdict parse failure; rubric scope already exhausted.
- **[013]** `src/spawner.ts`: `isValidAllowedDomain`/`assertValidAllowedDomains` with RFC-1123 regex; refuses bash metacharacters before interpolation (`tests/test-domain-filter-injection.ts`, 37 checks). Closes injection finding.
- **[014]–[016]** DISCARDED — scope violations (new singleton file, deno.lock, web.ts, claude-adapter.ts touched outside rubric).
- **[017]** DISCARDED — verdict parse failure.

Gates evolved during session: typecheck + 29 gate tests + 17→19 snapshot tests + 28 SSRF tests; individual iterations also ran their own regression tests.

### Session 2 (2026-04-12) — 8 variants, 8 kept, 0 discarded
Shifted from extractions in `src/refine.ts` to audit-driven behavior fixes across workflow/cli/orchestrator: status:"empty" for no-output success, `parseIntArg` NaN validation across 15 CLI sites, strict `VERDICT:` line requirement with UNCLEAR + exit code 3. Established that adding machine-readable failure signals is the second-safest class of change.

### Session 1 (2026-04-12) — 4 variants, 4 kept, 0 discarded
Behavior-preserving helper extractions in `src/refine.ts`. Established the three-gate oracle and the ~30-line duplicated-block sweet spot for safe extraction.
