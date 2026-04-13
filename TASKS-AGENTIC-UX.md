# Agentic UX Improvements

Wishlist compiled 2026-04-12 during the gate-ratchet ship + self-playtest session. Lens: **expo is a tool for LLM agents, not for humans watching a terminal.** Every item here is friction I hit driving expo unattended or orchestrating it from another agent.

Pairs with TASKS-AUDIT.md (speed + security findings from the automated audit) — that file is generated; this one is the narrative wishlist.

## Output for agents

- [x] [shipped 2026-04-13: `--json` on `expo refine <dir>` emits ONE JSON object on stdout: {verdict, iterations, kept, discarded, gateFailures, gatesProposed, finalVariantId, costUsd, durationMs, logFile, eventFile}. Signal prints go to stderr; banner suppressed. Exit 0 on CONVERGED / 1 otherwise. `--event-file PATH` also shipped — writes one JSONL line per bus signal for live consumption. perIteration array deferred: not tracked currently, the event-file covers the same need by being a superset.] Structured JSON output for refine results #agentic-ux #output

- [x] [shipped 2026-04-13: `--format json` (or `--json`) on all three read-verbs. gate list JSON: {totalGates, totalVariants, byVariant[]} for whole-archive, {variantId, gates[{source, addedBy}]} per-variant. --tree JSON: {variants[{id, status, parent, change, summary, timestamp, gates}]}. --status JSON: {dir, totalVariants, kept, discarded, current{id,change,summary,timestamp}|null, diskSize, refineMdExists}. 29 unit tests covering populated/empty archive, per-variant inherited-source tracking. TOON-proper deferred pending measurement — "one JSON object on stdout" covers the actual use case (orchestrators parsing programmatically) without a new format spec to maintain.] Token-efficient formats for CLI output (TOON-style) #agentic-ux #output #toon

- [x] [shipped 2026-04-13: `expo refine <dir> heuristics [--json]` prints REFINE.md + parsed `## Heading` sections. loadRefineHeuristics() exported from refine.ts so orchestrators can import directly. Missing file returns {exists:false} — no throw. Text form shows section names + line counts, raw content, and a pointer when file is missing. 28 tests in tests/test-refine-feedback.ts.] Expose REFINE.md heuristics to orchestrating agents #agentic-ux

## Verification tools

- [x] [shipped 2026-04-13: `expo refine <dir> gate check [variant_id] [--timeout MS] [--json]`. checkRefineGates runs ALL gates (no fail-fast), returns per-gate {pass, exitCode, durationMs, timedOut, source, addedBy, stderr}. --json emits structured result for orchestrators. Exit 0 all-pass / 1 any-fail. tests/test-refine-gate-check.ts — 31 checks including fail-doesn't-short-circuit, inherited-source tracking, timeout surfaces distinctly from plain exit, typo protection on unknown variant IDs.] `gate check` subcommand — run inherited gates without a full refine loop #agentic-ux #gates

- [x] [shipped 2026-04-13: recentFailures ring (cap 3) in refine() captures {iteration, change, gateName, reason} on every gate-forced discard. Next iteration's prompt gets a "Do NOT repeat these recently-failed approaches" section listing each attempt + which gate it broke + exit reason (or "timeout"). Cleared on KEEP since lineage has moved. Tests in tests/test-refine-feedback.ts cover prompt rendering (present/absent/multiple), gate/timeout reason formatting, and insertion-order preservation.] Pass gate-failure context into next iteration's prompt #feedback #gates

- [x] [shipped 2026-04-13: parseVerdict tries `<verdict>{JSON}</verdict>` block first. Expected JSON: {action: "keep"|"discard"|"converged", change, summary, gate_proposals?: [{name, command, rationale?}]}. Malformed/missing fenced block → falls back to legacy line grammar with a stderr warning so the failure is visible. Multiple fenced blocks → last wins (matches line-parser convention). Agent prompt rewritten to teach fenced form first, line form labelled "legacy fallback". 32 tests in tests/test-refine-fenced-verdict.ts.] Verdict parser: fenced-block grammar #agentic-ux #parsing

## Wall-clock safety

- [x] [shipped 2026-04-13: `--run-timeout N` flag + RefineOptions.runTimeout. Loop checks deadline between iterations, emits wall_clock_exceeded progress signal, runs updateRefineMd, returns verdict `WALL_CLOCK_EXCEEDED` with iteration count, kept/discarded counts, total cost. Per-iteration `--timeout` is auto-clamped to remaining wall-clock budget so a single stuck iteration can't drag the run past the cap by much.] Per-run wall-clock timeout #safety #resilience

- [x] [fixed 2026-04-12 in 8d7f58e: costGuard now kills offending agent on per-agent overrun, kills all-running on total overrun, emits structured BudgetExceededPayload. spawner gained killAgent() + killAllRunning() using process-group kill. All 4 call sites updated to pass spawner. Fired in production during audit-cleanup session ($5.17 > $5 killed update-md agent cleanly).] Verify cost-guard actually kills vs just logs #security #budget

- [x] [shipped 2026-04-13: `.refine/inflight.json` written at each iteration start with schema v1 {completedIterations, runStartedAt, persistedAt, totalCost, gateFailures, gatesProposed, recentFailures, discardCounts, dir}. On startup with existing inflight, refine resumes: iteration counter continues, --max respects the original budget, --run-timeout honors the original wall-clock start, cost/gate counters survive, feedback ring intact, discard-streak branching still coherent. Stale (>12h), malformed, wrong-schema, non-object, or missing-fields files are detected, logged, deleted, and ignored so corruption never blocks a fresh start. Cleared on clean exit (CONVERGED/EXHAUSTED/MAX_ITERATIONS/WALL_CLOCK_EXCEEDED). 22 unit tests in tests/test-refine-inflight.ts.] Resumability after a crashed or killed run #agentic-ux #resilience

## Discovery / zero-config

- [x] [shipped 2026-04-13: `expo refine <dir> --auto` + `discoverAutoDefaults(dir)` exported. Detects deno.json (tasks.test or `deno check` fallback), package.json (npm test; skips placeholder), pyproject.toml (pytest -x), Cargo.toml (cargo test --quiet), go.mod (go test ./...), Makefile (make test — only when no other markers found). Polyglot repos seed all matching gates. Explicit --rubric and --gate flags still win. Discovery reasons printed to stderr so nothing is invisible. Rubric is generic/conservative — the real --auto value-add is the gates. 33 tests in tests/test-refine-auto-discovery.ts. README / git-log heuristics for rubric tuning deferred.] `expo refine <dir> --auto` — zero-config discovery mode #agentic-ux #discover

- [x] [shipped 2026-04-13: `--approval-hook CMD` — any shell command. Receives verdict JSON on stdin, returns decision on stdout (JSON object, bare token, or single-letter). Fail-open with stderr logging on hook error/timeout/bad output (agent verdict applied) so a broken hook can't stall an unattended run. Timeout via `--approval-hook-timeout` (default 60s, fires SIGKILL). Mutually exclusive with --interactive (hook wins). Works with curl for HTTP-callback flavor, any scripting language otherwise. 24 parser tests.] Agent-in-loop approval (non-TTY) #agentic-ux

## Discovered during this session (2026-04-12)

- [x] [fixed 2026-04-12: snapshot() gained `addPaths?: string[]`; refine.ts records git status --porcelain before/after agent spawn, passes the diff as addPaths. Validated live during audit-leaks session — refine/008-011 all stayed scoped, my parallel f278b4d web.ts symlink fix remained a separate clean commit] snapshot() does `git add -A` — scoops uncommitted work into refine/NNN commits #bug #snapshot

- [x] [fixed 2026-04-12: findScopeViolations now exempts 12 lockfile names across ecosystems. Covered by +5 scope tests. Validated live during cleanup-2 session — iters that auto-updated deno.lock no longer got wrongly discarded] Scope check wrongly flagged lockfiles — toolchain side-effects counted as scope violations #bug #scope

- [x] [fixed 2026-04-12: src/concurrency.ts ConcurrencyLimit + DEFAULT_MAX_CONCURRENT=5; wired into race/workflow/mxit's processBatch (full spawn+wait lifecycle per slot); --max-concurrent N CLI flag on all three; 36 unit tests in tests/test-concurrency.ts] Concurrency semaphore on fan-outs (race/workflow/mxit) #safety #agentic-ux

- [x] [shipped 2026-04-13: recordDiscardAndMaybeBranch now accepts agentTouchedPaths and explicitly unlinks each path from the working tree AFTER restore. This targets project-git backend's `git checkout tag -- .` behaviour, which preserves untracked files by design — a discarded iteration's newly-created files otherwise lingered and confused the next iteration's dirty baseline. Wired into all 3 discard call sites (rubric-reject, scope-violation, gate-failure). Scoped to agent-created paths only (not concurrent user work). 10 unit tests in tests/test-refine-discard-cleanup.ts covering straggler removal, missing-file no-op, empty-touched-paths, and concurrent-user-work preservation.] Diff-based agent-touched-paths misses files from prior discarded iterations #bug #refine

- [x] [shipped 2026-04-13: `killAllRunning(reason, {staggerMs})` spaces SIGTERMs with DEFAULT_KILL_STAGGER_MS=25 between agents; fan-outs no longer all die in the same microsecond. Opt-out via staggerMs=0. 15 tests in tests/test-kill-wave-polish.ts.] Stagger process kills in costGuard.killAllRunning #safety #bus

- [x] [shipped 2026-04-13: `SignalBus.drainPending(timeoutMs=250)` + `bus.pendingWriteCount` getter. costGuard calls drainPending before killAllRunning so in-flight log rotation has a chance to complete and pending signals flush before the kill-wave adds more. Best-effort — proceeds with the kill if drain doesn't finish in time, losing tail signals is better than stalling. Pairs with stagger fix.] Drain bus pending writes before costGuard kills agents #bus #safety

## Notes and connections

- The `gate check` and wall-clock timeout items unblock "unattended overnight" use cases. Without them, refine is only trustworthy for watched short runs.
- The verdict-parser fix is prerequisite for passing structured data between iterations (gate failure context, etc.). Do it before the feedback loop.
- `--auto` is a big lift but one of the highest-leverage items — turns "learn 6 flags" into "point and shoot" for every repo.
- All items above are things I noticed *as an agent driving expo*. If these ship, the next expo self-playtest should be able to do meaningfully more on less setup.
