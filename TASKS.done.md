# expo — Completed Tasks

Archived from TASKS.md on 2026-03-19.

## Phase 0: Validate Assumptions [shipped 2026-03-19]

13/13 tests pass. Run: `bash tests/phase0/run-all.sh`

- [x] [pass: 8 lines valid JSONL, 5 event types cataloged] T01: stream-json basics #test
- [x] [pass: `total_cost_usd`, `usage`, `modelUsage` all in result event] T02: cost/tokens #test
- [x] [pass: Agent tool_use captured with name/input/subagent_type] T03: subagent events #test
- [x] [pass: no top-level thinking events — thinking lives inside assistant.message.content] T04: thinking #test
- [x] [pass: session_id on every event: system, assistant, user, result] T05: session-id #test
- [x] [pass: resumed session returns "hello from session test" — context retained] T06: resume headless #test
- [x] [pass: resumed session emits valid JSONL] T07: resume + stream-json #test
- [x] [pass: worktree at `.claude/worktrees/test-wt`, branch `worktree-test-wt`] T08: worktree basic #test
- [x] [pass: worktree created from git-init repo with NO remote] T09: worktree no GitHub #test
- [x] [pass: --worktree + --name + --session-id + -p + stream-json all compose] T10: full combo #test
- [x] [pass: worktrees persist after exit — need manual cleanup] T11: worktree cleanup #test
- [x] [pass: fork creates new session ID from parent] T12: fork-session #test
- [x] [pass: catalog at tests/phase0/results/stream-json-event-catalog.md] T13: event catalog #test
- [x] [done: 13/13 pass] Run all Phase 0 tests
- [x] [done: `tests/phase0/results/stream-json-event-catalog.md`] Stream-json event catalog
- [x] [done: resume works headless→headless, fork creates new ID] Resume/intervention findings
- [x] [done: works without GitHub, persists after exit] Worktree findings
- [x] [decided: mostly yes — `--worktree` handles creation + branching, we only add cleanup + tracking] Does --worktree replace our workspace manager?

## Phase 1: Signal Bus Core [shipped 2026-03-19]

- [x] [done: `src/types.ts` ~90 lines, 8 signal types + typed payloads] Define AgentSignal interface
- [x] [done: `src/claude-adapter.ts` ~180 lines] Build the Claude adapter
- [x] [done: `src/generic-adapter.ts` ~80 lines] Build the generic CLI adapter
- [x] [done: `src/bus.ts` ~90 lines] Build the signal multiplexer

Tests (3/3 unit): `bash tests/phase1-2/run-all.sh 01 02 03`

- [x] [pass: 10/10 assertions] T01: adapter parses all stream-json event types
- [x] [pass: 3/3 assertions] T02: bus multiplexes + writes JSONL
- [x] [pass: 5/5 assertions] T03: registry persists to disk + survives reload

## Phase 2: Agent Spawner [shipped 2026-03-19]

- [x] [done: `src/spawner.ts` ~250 lines] Build spawner
- [x] [done: `src/cli.ts` ~640 lines] Build CLI
- [x] [done: spawner.cleanup() + cleanupAll()] Build workspace cleanup
- [x] [done: tested — "pineapple" remembered across resume] Wire up resume/intervention
- [x] [done: `src/registry.ts` ~100 lines, `.sigbus/registry.json`] Persist registry to disk

Tests (2/2 live): `bash tests/phase1-2/run-all.sh 04 05`

- [x] [pass: 4/4 assertions] T04: full spawn lifecycle (live)
- [x] [pass: 3/3 assertions] T05: parallel spawn (live)

## Phase 3: Orchestrator [shipped 2026-03-19]

- [x] [done: `src/orchestrator.ts` ~450 lines] Review loop, race, ralph, cost guard, escalation
- [x] [done: review CLI command] Review loop
- [x] [done: race CLI command] Race/vs with judge
- [x] [done: ralph CLI command] Task-list progression
- [x] [done: bus consumer] Cost guard
- [x] [done: bus consumer] Escalation routing

Tests (4/4): `bash tests/phase1-2/run-all.sh 06 07 08 09`

- [x] [pass: 4/4 assertions] T06: review loop
- [x] [pass: 3/3 assertions] T07: race
- [x] [pass: 5/5 assertions] T08: ralph
- [x] [pass: 4/4 assertions] T09: escalation (unit)

## Phase 4: UI Consumers (core) [shipped 2026-03-19]

- [x] [done: `src/watch.ts` ~140 lines] Headless logger / bus watcher
- [x] [done: built into CLI `printSignal`] Real-time signal printer

Tests (1/1): `bash tests/phase1-2/run-all.sh 10`

- [x] [pass: 3/3 assertions] T10: watch
