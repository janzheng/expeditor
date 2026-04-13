# Agentic UX Improvements

Wishlist compiled 2026-04-12 during the gate-ratchet ship + self-playtest session. Lens: **expo is a tool for LLM agents, not for humans watching a terminal.** Every item here is friction I hit driving expo unattended or orchestrating it from another agent.

Pairs with TASKS-AUDIT.md (speed + security findings from the automated audit) — that file is generated; this one is the narrative wishlist.

## Output for agents

- [ ] Structured JSON output for refine results #agentic-ux #output
  - [*] Add `--json` flag to `expo refine` that emits the final summary as one JSON object on stdout (nothing else)
  - [*] Shape: `{verdict, iterations, kept, discarded, gateFailures, gatesProposed, finalVariantId, costUsd, perIteration: [{iter, action, change, summary, gateFailed?, cost}]}`
  - [*] Consumers: external agents driving expo, CI, the dashboard
  - [*] Optional `--event-file PATH` writes JSONL one line per bus event for live consumption

- [ ] Token-efficient formats for CLI output (TOON-style) #agentic-ux #output #toon
  - [*] `gate list`, `--tree`, `--status` render pretty text tables
  - [*] Add `--format=compact|toon|json` flag across these verbs
  - [*] Directly inspired by AXI principle 1 (token-efficient output). See `github-repos/axi/notes.md`
  - [*] Not strictly required right now — measure actual context usage first

- [ ] Expose REFINE.md heuristics to orchestrating agents #agentic-ux
  - [*] REFINE.md is read into the spawned agent's prompt but invisible externally
  - [*] Add `expo refine <dir> heuristics` subcommand that prints the file + parsed sections
  - [*] Include path + last-updated in `--json` status output

## Verification tools

- [x] [shipped 2026-04-13: `expo refine <dir> gate check [variant_id] [--timeout MS] [--json]`. checkRefineGates runs ALL gates (no fail-fast), returns per-gate {pass, exitCode, durationMs, timedOut, source, addedBy, stderr}. --json emits structured result for orchestrators. Exit 0 all-pass / 1 any-fail. tests/test-refine-gate-check.ts — 31 checks including fail-doesn't-short-circuit, inherited-source tracking, timeout surfaces distinctly from plain exit, typo protection on unknown variant IDs.] `gate check` subcommand — run inherited gates without a full refine loop #agentic-ux #gates

- [ ] Pass gate-failure context into next iteration's prompt #feedback #gates
  - [*] Currently: gate discards a variant → next agent has no memory of why → may propose same change
  - [*] Feed last N gate-failure reasons into the next prompt under "Do not repeat these failed approaches"
  - [*] Compound-discount wasted spend on obviously-doomed iterations

- [ ] Verdict parser: fenced-block grammar #agentic-ux #parsing
  - [*] `parseVerdict` scans lines for `VERDICT: ...` — fragile if the agent echoes the format in prose
  - [*] Currently "works" because last-match wins, but one bad explain-the-format output could misdirect
  - [*] Change to require `<verdict>{"action":"keep",...}</verdict>` XML block with JSON payload
  - [*] Side benefit: structured child fields naturally (gate_proposals array, optional fields)

## Wall-clock safety

- [x] [shipped 2026-04-13: `--run-timeout N` flag + RefineOptions.runTimeout. Loop checks deadline between iterations, emits wall_clock_exceeded progress signal, runs updateRefineMd, returns verdict `WALL_CLOCK_EXCEEDED` with iteration count, kept/discarded counts, total cost. Per-iteration `--timeout` is auto-clamped to remaining wall-clock budget so a single stuck iteration can't drag the run past the cap by much.] Per-run wall-clock timeout #safety #resilience

- [x] [fixed 2026-04-12 in 8d7f58e: costGuard now kills offending agent on per-agent overrun, kills all-running on total overrun, emits structured BudgetExceededPayload. spawner gained killAgent() + killAllRunning() using process-group kill. All 4 call sites updated to pass spawner. Fired in production during audit-cleanup session ($5.17 > $5 killed update-md agent cleanly).] Verify cost-guard actually kills vs just logs #security #budget

- [ ] Resumability after a crashed or killed run #agentic-ux #resilience
  - [*] If refine dies mid-iteration (network, pkill, deno panic), what survives?
  - [*] HEAD tracking means next snapshot will parent correctly — good baseline
  - [*] Untested: does `expo refine .` on a dir with an existing `.refine/` pick up cleanly?
  - [*] Possibly persist per-iteration in-flight state to `.refine/inflight.json`

## Discovery / zero-config

- [ ] `expo refine <dir> --auto` — zero-config discovery mode #agentic-ux #discover
  - [*] Inspired by evo's `/discover` command. See `github-repos/evo/notes.md`
  - [*] Reads `deno.json` / `package.json` / `pyproject.toml` for test commands
  - [*] Seeds default gates from existing test infrastructure (`deno task test`, `npm test`, `pytest -x`)
  - [*] Generates a default rubric from repo signals (README, recent commits, TODO comments)
  - [*] Reduces setup from 6 flags to 0 when the tool has sensible defaults

- [ ] Agent-in-loop approval (non-TTY) #agentic-ux
  - [*] `--interactive` reads stdin — assumes a human at terminal
  - [*] Need programmatic version: POST verdict to callback URL OR wait on named pipe
  - [*] Enables oversight agents approving individual variants between iterations
  - [*] Pairs naturally with a `fold` orchestrator driving multiple expo runs

## Discovered during this session (2026-04-12)

- [x] [fixed 2026-04-12: snapshot() gained `addPaths?: string[]`; refine.ts records git status --porcelain before/after agent spawn, passes the diff as addPaths. Validated live during audit-leaks session — refine/008-011 all stayed scoped, my parallel f278b4d web.ts symlink fix remained a separate clean commit] snapshot() does `git add -A` — scoops uncommitted work into refine/NNN commits #bug #snapshot

- [x] [fixed 2026-04-12: findScopeViolations now exempts 12 lockfile names across ecosystems. Covered by +5 scope tests. Validated live during cleanup-2 session — iters that auto-updated deno.lock no longer got wrongly discarded] Scope check wrongly flagged lockfiles — toolchain side-effects counted as scope violations #bug #scope

- [x] [fixed 2026-04-12: src/concurrency.ts ConcurrencyLimit + DEFAULT_MAX_CONCURRENT=5; wired into race/workflow/mxit's processBatch (full spawn+wait lifecycle per slot); --max-concurrent N CLI flag on all three; 36 unit tests in tests/test-concurrency.ts] Concurrency semaphore on fan-outs (race/workflow/mxit) #safety #agentic-ux

- [ ] Diff-based agent-touched-paths misses files from prior discarded iterations #bug #refine
  - [*] cleanup-2 iter-3 self-discarded but left tests/test-run-stats-cache.ts in the working tree. Iter-4's pre-spawn listDirtyPaths saw the file as already-dirty, so when iter-4 legitimately recreated it, the file was filtered out of agentTouchedPaths. Ended up committed-loose (had to manually stage).
  - [*] Two possible fixes: (a) after discard, clear non-scope-essential working-tree files too; (b) track "what was legitimately created this iteration" more precisely via timestamps or file-watcher rather than dirty-set difference.
  - [*] Benign as-is — straggler is easy to spot and commit separately. But worth logging so it doesn't surprise anyone.

- [ ] Stagger process kills in costGuard.killAllRunning #safety #bus
  - [*] Total-budget overrun triggers killAllRunning which loops sending SIGTERM to every running agent's process group in a tight for-loop. In a fan-out scenario this signals dozens of processes at once — they all die in unison, pipe flushes, bus contention, brief CPU spike.
  - [*] User noticed a 100% CPU spike during session 3 when this fired
  - [*] Fix: small delay between kills, OR Promise.all with concurrency cap. Not a correctness bug — just a politeness one.

- [ ] Drain bus pending writes before costGuard kills agents #bus #safety
  - [*] When kill-wave hits, dying agents flush stdout/stderr through pipes expo holds open, while the cost-guard is also trying to emit its `budget_exceeded` signal. If bus is rotating when this happens, pendingWrites can stack up quickly.
  - [*] Pairs with the stagger fix above. Both are about making the kill path less lumpy.

## Notes and connections

- The `gate check` and wall-clock timeout items unblock "unattended overnight" use cases. Without them, refine is only trustworthy for watched short runs.
- The verdict-parser fix is prerequisite for passing structured data between iterations (gate failure context, etc.). Do it before the feedback loop.
- `--auto` is a big lift but one of the highest-leverage items — turns "learn 6 flags" into "point and shoot" for every repo.
- All items above are things I noticed *as an agent driving expo*. If these ship, the next expo self-playtest should be able to do meaningfully more on less setup.
