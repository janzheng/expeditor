# expo — Tasks

Headless subagent orchestration with a signal bus. See [TASKS-DESIGN.md](TASKS-DESIGN.md) for why/how.

**Status:** Feature complete. 17 source files, ~5,200 lines. 28 tests + 4 integration tests. 5 agent types. Permission ledger. Domain filtering. Multi-agent sandbox.

**Run tests:** `bash tests/phase0/run-all.sh` (13 pass) · `bash tests/phase1-2/run-all.sh` (11 pass) · `bash tests/test-ledger-cycle.sh` (12 pass) · `bash tests/test-workflow-synthesis.sh` (5 pass) · `deno run --allow-all tests/test-domain-filter.ts` (5 pass)

**Completed work:** See [TASKS.done.md](TASKS.done.md)

## Current

All planned tasks complete. See [TASKS.done.md](TASKS.done.md) for Phase 0-5 archive.

## Later

- [ ] Web dashboard (SSE + React) — SSE endpoint, card grid, cost aggregates

## Discovered / Open Questions

- [x] [decided: Phase 5, and it was easy — 130 lines] Codex adapter timing
- [x] [decided: JSONL — more readable, good enough perf. SQLite queryable but not worth the complexity] Bus storage format
- [*] Workshop deep dive: `.reduce/subagent-signal-bus.md`
- [*] Directory sandbox is independent of tool permissions — `Bash(ls:*)` in allow won't override CC directory restrictions
- [*] Some Bash commands are auto-safe regardless of allow list (`python3 --version`, `node --version`, `echo`)
- [*] "BLOCKED" (directory) vs "DENIED" (tool permission) are different failure modes — only DENIED can be fixed via ledger
- [*] Denials only reported in final result event — no mid-stream visibility

## File Inventory

```
src/
├── types.ts            ~110 lines   Signal types + typed payloads (incl. DenialDetail)
├── claude-adapter.ts   ~330 lines   stream-json → AgentSignal + denial normalization
├── codex-adapter.ts    ~130 lines   Codex --json → AgentSignal
├── opencode-adapter.ts ~240 lines   OpenCode --format json → AgentSignal
├── pimono-adapter.ts   ~250 lines   Pi-mono --mode json → AgentSignal
├── generic-adapter.ts   ~95 lines   Any CLI → lifecycle signals
├── bus.ts              ~120 lines   Multiplexer + JSONL logger
├── permission-ledger.ts ~160 lines  Persist/approve/reject denied permissions
├── mxit-runner.ts      ~300 lines   Standalone task runner using mxit format
├── spawner.ts          ~550 lines   Spawn 5 agent types, sandbox for all, domain filter hooks
├── registry.ts         ~100 lines   Persistent agent→session mapping
├── orchestrator.ts     ~510 lines   Review, race, ralph, cost guard, escalation, timeout
├── timeout.ts           ~90 lines   withTimeout() — SIGTERM/SIGKILL escalation
├── workflow.ts         ~360 lines   Markdown workflow parser + multi-agent runner
├── watch.ts            ~140 lines   JSONL replay + summary
├── tui.tsx             ~220 lines   Ink/React card dashboard
├── tmux-consumer.ts    ~190 lines   tmux pane status updates
└── cli.ts              ~870 lines   All commands + permissions + --timeout flag

tests/
├── phase0/             13 tests     Validate Claude Code primitives
├── phase1-2/           10 tests     Unit + live tests for all phases
├── test-ledger-cycle.sh             12 checks — full approve→re-run cycle
├── test-workflow-synthesis.sh       5 checks — fan-out + synthesis e2e
├── test-domain-filter.ts            5 checks — hook generation unit test
└── test-sandbox-permissions.ts      Research sandbox empirical test
```

## CLI Reference

```
deno task expo spawn <prompt> [--name N] [--agent claude|codex|opencode|pi] [--model M] [--no-worktree] [--timeout N] [--sandbox permissive|research|developer]
deno task expo spawn-all <tasks.json> [--timeout N]
deno task expo status
deno task expo resume <agentId> [--headless ["prompt"]]
deno task expo fork <agentId>
deno task expo cleanup <agentId> | --all
deno task expo review <prompt> [--max N] [--work-agent claude|codex|opencode|pi] [--review-agent claude|codex|opencode|pi]
deno task expo race "A" vs "B" [--criteria "..."] [--timeout N]
deno task expo ralph "<work>" "<gate>" [--max N] [--review]
deno task expo permissions [approve|reject|reset] [<pattern>]
deno task watch <file.jsonl> [--json | --summary]
deno task tui <file.jsonl> [--watch]
deno task test
```
