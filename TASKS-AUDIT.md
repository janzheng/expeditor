# Expo — Correctness Audit

Full sweep of `src/`. Findings only — no fixes applied. Created 2026-04-03.

**Totals: 30 findings across 4 parallel agents (1 wave) — 10 fixed**

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

- [ ] **A008** Signals dropped during log rotation — `emit()` returns early when `rotating=true`. Signals reach subscribers but are permanently lost from the persisted log. `bus.ts:79` #data-loss #local-real
- [ ] **A009** Double-rotate race under concurrent pipeLines — two concurrent `emit()` calls can both pass the `rotating` guard before either sets it. `bus.ts:79,107` #race-condition #at-scale-only
- [ ] **A010** Unawaited `bus.emit()` in maxToolCalls subscriber — `this.bus.emit(...)` called without `await`. Log write may not complete before process exits. `spawner.ts:582` #error-handling #local-real
- [x] [fixed: removed orphaned bus.emit, append validation error to output, return exitCode=1] **A011** `validateCommand` emits `failed` after `done` already emitted `orchestrator.ts` #logic-bug #local-real
- [x] [fixed: added partialResult?: boolean to DonePayload] **A012** `partialResult:true` not in `DonePayload` type `types.ts` #type-safety #local-real
- [x] [fixed: loadSnapshot() wrapped in try/catch, returns null on failure, logs warning] **A013** Lazy snapshot import failure unhandled `orchestrator.ts`, `mxit-runner.ts` #error-handling #local-real
- [x] [fixed: processBatch snapshots before batch, restores if ALL fail, snapshots success] **A014** Snapshot missing from `processBatch` `mxit-runner.ts` #correctness #local-real
- [ ] **A015** Webhook import fire-and-forget — `import("./notify.ts").then(...)` with no `.catch`. Import failure = silent unhandled rejection. `cli.ts:1246` #error-handling #local-real
- [ ] **A016** `escalationRouter` async subscriber — bus expects sync callback, returned Promise is dropped. If `onEscalate` throws after await, rejection is unhandled. `orchestrator.ts:403`, `bus.ts:70` #error-handling #local-real
- [ ] **A017** Workflow output file read failure → silent empty output — agent exits 0 but didn't write file. Synthesis agent gets empty entry, may hallucinate. No warning. `workflow.ts:350-354` #silent-failure #local-real
- [ ] **A018** `parseRalphVerdict` defaults to DONE on garbage — confused gate agent prematurely terminates ralph loop. `orchestrator.ts:588` #silent-failure #local-real
- [ ] **A019** `parseGateVerdict` defaults to DONE if no HIGH — confused review agent silently passes gate. `orchestrator.ts:575-578` #silent-failure #local-real
- [ ] **A020** Race: non-winning worktrees never cleaned up — stale git worktrees accumulate across race calls. `orchestrator.ts:200-210` #resource-leak #local-real
- [ ] **A021** `spawnBackground` in web.ts fully fire-and-forget — spawn failure returns 200 OK, dashboard shows nothing. `web.ts:397` #error-handling #local-real
- [ ] **A022** `withTimeout` hangs forever if stdout stuck after SIGKILL — no final-resort timeout. `timeout.ts:85` #hang #at-scale-only
- [ ] **A023** `spawnAndWait` subscriber unsubscribes before `validateCommand` — validation's `failed` signal has no accompanying `cost` signal. `orchestrator.ts:525,550` #logic-bug #local-real

## P3 — Low (cosmetic or theoretical)

- [ ] **A024** `lineStream cancel()` crashes if reader uninitialized — edge case with cancelled-before-read streams. `bus.ts:262` #edge-case
- [ ] **A025** Temp sandbox dir leaks on spawn error before process created. `spawner.ts:510,638` #resource-leak
- [ ] **A026** `stderrReader` lock never explicitly released. `spawner.ts:599-607` #resource-leak
- [ ] **A027** `as any` in watch.ts disables type checking for payload access. `watch.ts:30-60` #type-safety
- [ ] **A028** `getLastKeptId` returns empty string → `restore(dir, "")` on edge case. `refine.ts:229,424` #edge-case
- [ ] **A029** `parseVerdict` fallback matches "has not converged" as CONVERGED. `refine.ts:383-385` #logic-bug
- [ ] **A030** Dashboard `handleListRuns` returns partial data on file read error. `web.ts:268-296` #silent-failure

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
