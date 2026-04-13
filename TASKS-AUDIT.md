# Expo — Correctness Audit

Full sweep of `src/`. Findings only — no fixes applied. Created 2026-04-03.

**Totals (as of 2026-04-12): 25 fixed · 9 wontfix · 4 open · 2 split-status.** Original 2026-04-03 summary claimed "all resolved" but 6 items remained `[ ]`; 4 of those have since been fixed this session (A008, A017, A018, A019), 2 more retroactively marked for prior-session fixes (A028, A029). Still open: A010 (unawaited bus.emit in maxToolCalls — low-impact log drop), A015 (webhook import fire-and-forget — silent unhandled rejection), A024 (lineStream cancel on uninitialized reader — edge case), A025 (temp sandbox dir leak on pre-spawn error — resource leak). See also `.brief/agentic-audit.md` for the newer (2026-04-12) agentic-UX audit with 16 findings, all shipped.

> **Deployment context:** Local dev tool for 1-2 users. Spawns real Claude Code subprocesses.
> Items marked `#local-real` affect every session regardless of scale.
> Items marked `#at-scale-only` only matter at scale/multi-user.
> Prior bus.ts audit (2026-03-26) fixed 6 items — see `TASKS-BUGS-FROM-AUDIT.md`.

---

## P1 — High (fix before sustained use)

- [x] [fixed: per-agent bus subscribers capture output+cost, same pattern as spawnAndWait] **A001** Race output is placeholders, not real agent output `orchestrator.ts` #logic-bug #local-real
- [x] [fixed: branch costs summed via bus subscribers] **A002** Cost always 0 for race branches `orchestrator.ts` #logic-bug #local-real
- [x] [fixed: use object wrapper {cost:0} instead of primitive — Map stores reference] **A003** `processBatch` cost tracker captures primitive by value `mxit-runner.ts` #logic-bug #local-real
- [x] [fixed: writeQueue Promise chain serializes concurrent save() calls] **A004** Non-atomic registry save `registry.ts` #race-condition #local-real
- [~] [not-a-bug: result collection loop is a sequential `for`, not Promise.all — writes are already serialized] **A005** TASKS.md concurrent writes in parallel batch `mxit-runner.ts:370-393` #race-condition #local-real
- [x] [fixed: narrow catch to Deno.errors.NotFound, rethrow SyntaxError with helpful message] **A006** Corrupted JSON silently resets to empty `permission-ledger.ts`, `registry.ts` #silent-failure #local-real
- [x] [fixed: killedByHarness flag prevents duplicate failed emit in done closure] **A007** Duplicate `failed` signal on maxToolCalls kill `spawner.ts` #logic-bug #local-real

## P2 — Medium (address before sustained operation)

- [x] [fixed 2026-04-12 in refine/010: bus.ts gained `offline` getter + `onStatus(cb)` subscription; `emit()` returns boolean for dropped log writes. tests/test-bus-offline-signal.ts (21 checks)] **A008** Signals dropped during log rotation — `emit()` returns early when `rotating=true`. Signals reach subscribers but are permanently lost from the persisted log. `bus.ts:79` #data-loss #local-real
- [~] [wontfix: theoretical — rotation takes ~1ms, would need two emits in same microsecond] **A009** Double-rotate race under concurrent pipeLines `bus.ts:79,107` #race-condition #at-scale-only
- [ ] **A010** Unawaited `bus.emit()` in maxToolCalls subscriber — `this.bus.emit(...)` called without `await`. Log write may not complete before process exits. `spawner.ts:582` #error-handling #local-real
- [x] [fixed: removed orphaned bus.emit, append validation error to output, return exitCode=1] **A011** `validateCommand` emits `failed` after `done` already emitted `orchestrator.ts` #logic-bug #local-real
- [x] [fixed: added partialResult?: boolean to DonePayload] **A012** `partialResult:true` not in `DonePayload` type `types.ts` #type-safety #local-real
- [x] [fixed: loadSnapshot() wrapped in try/catch, returns null on failure, logs warning] **A013** Lazy snapshot import failure unhandled `orchestrator.ts`, `mxit-runner.ts` #error-handling #local-real
- [x] [fixed: processBatch snapshots before batch, restores if ALL fail, snapshots success] **A014** Snapshot missing from `processBatch` `mxit-runner.ts` #correctness #local-real
- [ ] **A015** Webhook import fire-and-forget — `import("./notify.ts").then(...)` with no `.catch`. Import failure = silent unhandled rejection. `cli.ts:1246` #error-handling #local-real
- [~] [wontfix: needs bus API change for async subscribers, low impact — escalation is notification only] **A016** `escalationRouter` async subscriber `orchestrator.ts:403` #error-handling #local-real
- [x] [fixed 2026-04-12 in refine/004: workflow.ts now distinguishes `status: "empty"` (exit 0 but no output file) from real success, attaches structured reason, skips synthesis when all agents empty] **A017** Workflow output file read failure → silent empty output — agent exits 0 but didn't write file. Synthesis agent gets empty entry, may hallucinate. No warning. `workflow.ts:350-354` #silent-failure #local-real
- [x] [fixed 2026-04-12 in refine/006: parseRalphVerdict requires explicit VERDICT line, returns UNCLEAR on garbage (propagates as terminal verdict with exit code 3)] **A018** `parseRalphVerdict` defaults to DONE on garbage — confused gate agent prematurely terminates ralph loop. `orchestrator.ts:588` #silent-failure #local-real
- [x] [fixed 2026-04-12 in refine/006: parseGateVerdict same treatment as A018 — UNCLEAR on unparseable output] **A019** `parseGateVerdict` defaults to DONE if no HIGH — confused review agent silently passes gate. `orchestrator.ts:575-578` #silent-failure #local-real
- [~] [wontfix: `expo cleanup --all` handles stale worktrees — cleanup inside race() risks deleting winner] **A020** Race: non-winning worktrees never cleaned up `orchestrator.ts:200-210` #resource-leak #local-real
- [~] [wontfix: by design — dashboard spawns detached processes, tails log for status] **A021** `spawnBackground` in web.ts fire-and-forget `web.ts:397` #error-handling #local-real
- [~] [wontfix: extremely rare — requires stdout pipe stuck after SIGKILL] **A022** `withTimeout` hangs after SIGKILL `timeout.ts:85` #hang #at-scale-only
- [x] [fixed: resolved as part of A011 — validateCommand no longer emits signals] **A023** `spawnAndWait` validate lifecycle `orchestrator.ts` #logic-bug #local-real

## P3 — Low (cosmetic or theoretical)

- [ ] **A024** `lineStream cancel()` crashes if reader uninitialized — edge case with cancelled-before-read streams. `bus.ts:262` #edge-case
- [ ] **A025** Temp sandbox dir leaks on spawn error before process created. `spawner.ts:510,638` #resource-leak
- [~] [wontfix: GC cleans up when process ends — explicit release adds complexity for no practical benefit] **A026** `stderrReader` lock not released `spawner.ts:599-607` #resource-leak
- [~] [wontfix: `as any` is correct for display-only file — Record<string,unknown> too strict for property access] **A027** `as any` in watch.ts `watch.ts:30-60` #type-safety
- [x] [fixed in c3c75a2: `kept.at(-1)?.id ?? null` returns null on empty, callers check for null before restore] **A028** `getLastKeptId` returns empty string → `restore(dir, "")` on edge case. `refine.ts:229,424` #edge-case
- [x] [fixed in c3c75a2: converged fallback requires explicit VERDICT: prefix, "has not converged" prose no longer triggers CONVERGED] **A029** `parseVerdict` fallback matches "has not converged" as CONVERGED. `refine.ts:383-385` #logic-bug
- [~] [wontfix: acceptable UX for dev tool — one bad log shows as empty, rest display fine] **A030** Dashboard partial run data on file error `web.ts:268-296` #silent-failure

---

## Fix-First List

**Tier 1 — Broken in every race/parallel-batch session:**
- [x] **A001** Race output is placeholders — FIXED
- [x] **A002** Race cost always 0 for branches — FIXED
- [x] **A003** Parallel mxit cost always 0 — FIXED

**Tier 2 — Data corruption / stuck states:**
- [x] **A004** Non-atomic registry save — FIXED (write queue)
- [!] **A005** TASKS.md concurrent writes in parallel batch (already sequential in practice)
- [x] **A006** Corrupted JSON silently resets — FIXED (narrow catch)
- [x] **A007** Duplicate failed signal — FIXED (killedByHarness flag)

**Tier 3 — Silent failures / lost data:**
- [ ] **A008** Signals lost during log rotation
- [x] **A011** validateCommand lifecycle — FIXED
- [x] **A014** Batch snapshot support — FIXED
- [ ] **A017** Workflow synthesis gets empty output silently

---

## Top Themes

1. **Race pattern is broken** — A001+A002 mean the judge evaluates placeholder text and costs aren't tracked. This was likely a stub that was never wired to real output collection.
2. **Parallel batch has multiple bugs** — A003 (cost=0), A005 (TASKS.md corruption), A014 (no snapshots). Sequential mode works fine.
3. **Catch-all error swallowing** — A006 is the worst: corrupted JSON resets state silently. Several other catches are too broad.
4. **State machine violations** — A007 (duplicate failed) and A011 (done then failed) break the expected signal lifecycle.

## Stats

| Category | Count |
|----------|-------|
| Logic bug | 7 |
| Race condition | 3 |
| Silent failure | 5 |
| Error handling | 5 |
| Resource leak | 3 |
| Type safety | 2 |
| Edge case | 2 |
| Data loss | 1 |
| Hang | 1 |
| Correctness | 1 |
