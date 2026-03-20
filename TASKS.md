# expo — Tasks

Headless subagent orchestration with a signal bus. See [TASKS-DESIGN.md](TASKS-DESIGN.md) for why/how.

**Status:** Feature complete. 16 source files, ~3,700 lines. 24 tests. 5 agent types (Claude, Codex, OpenCode, Pi-mono, generic).

**Run tests:** `bash tests/phase0/run-all.sh` (13 pass) · `bash tests/phase1-2/run-all.sh` (11 pass)

**Completed work:** See [TASKS.done.md](TASKS.done.md)

## Current — What's left

### Phase 4: Rich UI Consumers

- [x] [done: `src/tui.tsx` — Ink/React, card grid with borders, tool history, cost] Terminal dashboard (Ink TUI) #tui
  - [x] Card per agent: status dot, model, tool calls with ✓/✗, latest text, cost/duration/tokens
  - [x] Collapsed "+N earlier tools" when >5 tool calls
  - [x] Color-coded borders: green=done, yellow=working, red=failed
  - [x] Grid layout: 3 cards per row
  - [x] Static mode (`tui.tsx <file>`) and watch mode (`--watch` polls for changes)
  - [x] [pass: T11 — 4/4 assertions, cards render with borders + cost] Tested
- [x] [done: `src/tmux-consumer.ts` — polls bus, updates pane titles + border colors] tmux consumer #tmux-ui
  - [x] Read bus JSONL, update tmux pane titles with status icon + agent name + tool + cost
  - [x] Color-coded pane borders by status
  - [x] `--create-panes` flag to auto-create panes for new agents
  - [*] Requires running inside tmux session
- [?] Web dashboard (SSE + React) #web-ui
  - [ ] SSE endpoint streaming bus events
  - [ ] Slate-style card grid in browser
  - [ ] Cost/duration aggregates

### Phase 5: Polish & Packaging

- [x] [done: `src/codex-adapter.ts` ~130 lines] Codex adapter #codex-adapter
  - [x] Maps 4 Codex event types: thread.started, item.started/completed, turn.completed
  - [x] command_execution → tool_call/tool_result, agent_message → output
  - [x] Tested live: `spawn --agent codex` works
- [x] [done: `--work-agent`/`--review-agent` flags on review command] Cross-model review loop #cross-model
  - [x] `review "prompt" --work-agent codex --review-agent claude` — Codex writes, Claude reviews
  - [x] Per-step model override: `--work-model`, `--review-model`
  - [x] Tested live: Codex wrote palindrome, Claude reviewed entire expo codebase, found a real bug (missing break)
  - [x] [fixed: cli.ts missing break in watch case — found by cross-model review!] Bug fix from dogfooding
- [x] [done: `spawn --agent codex|claude` flag] Multi-agent spawn support #multi-agent
- [x] [done: `deno.json` with tasks for expo, tui, watch, tmux, test] Deno task setup
- [ ] Package as installable CLI (`deno install --global`)
- [x] [done: try/catch on pipe, adapter, registry write; crash emits failed signal] Error handling hardening
  - [x] Spawner: catches pipe errors, process crashes, emits `failed` signal to bus
  - [x] Bus: catches consumer errors (one bad consumer doesn't break others), log write errors
  - [x] Bus: adapter errors skip bad lines instead of killing the pipe
  - [x] lineStream: handles broken pipes, flushes buffer on error
- [x] [done: bus rotates at 50MB, renames to .old, configurable via maxLogBytes] JSONL rotation
  - [x] Strips `_raw` from logged signals to save ~50% disk space
  - [x] Auto-rotates when file exceeds limit (default 50MB)
  - [x] Keeps one `.old` backup
- [x] [done: `src/timeout.ts` + wired into orchestrator, workflow, cli] Agent timeout & process watchdog #reliability
  - [x] `withTimeout()` helper: races `agent.done` against timer, SIGTERM → grace period → SIGKILL
  - [x] Wired into `spawnAndWait` (default 600s), `race`, `reviewLoop`, `ralph`, `runWorkflow`
  - [x] `--timeout <seconds>` CLI flag on all commands (spawn, spawn-all, review, race, ralph, workflow)
  - [x] `timedOut: boolean` on `SpawnResult`, emits `failed` signal with `timedOut: true`
  - [x] Timer cleanup in `finally` blocks prevents Deno exit hangs
- [x] [fixed: serialize spawns + poll-wait for worktree dir before next spawn] Concurrent worktree race condition #reliability
  - [x] Root cause: Claude CLI creates worktrees async after process start; concurrent `--worktree` causes one process to die silently (zero stdout, never closes fd)
  - [x] `spawnAll` now spawns sequentially with worktree-readiness gate
  - [x] t07-race test updated: pre-cleanup of stale branches + `--timeout 30`

## Later

- [x] [done: `src/opencode-adapter.ts` — maps step_start, tool_use, text, reasoning, step_finish, error] OpenCode adapter #multi-agent
- [x] [done: `src/pimono-adapter.ts` — structured adapter, pi-mono has `--mode json` with typed events] Pi-mono adapter #multi-agent
- [x] [done: `AgentType = "claude" | "codex" | "opencode" | "pi" | "generic"`, buildCommand + getAdapter for each] Extend AgentType #multi-agent
- [ ] mxit integration — expo reads TASKS.md for ready work, spawns agents, updates tasks on completion #goal:fold-stack
- [ ] Claude Code skill — `/expo review "prompt"` from inside Claude Code #goal:fold-stack

## Discovered / Open Questions

- [x] [decided: Phase 5, and it was easy — 130 lines] Codex adapter timing
- [x] [decided: JSONL — more readable, good enough perf. SQLite queryable but not worth the complexity] Bus storage format
- [*] Workshop deep dive: `.reduce/subagent-signal-bus.md`

## File Inventory

```
src/
├── types.ts            ~100 lines   Signal types + typed payloads
├── claude-adapter.ts   ~310 lines   stream-json → AgentSignal
├── codex-adapter.ts    ~130 lines   Codex --json → AgentSignal
├── opencode-adapter.ts ~240 lines   OpenCode --format json → AgentSignal
├── pimono-adapter.ts   ~250 lines   Pi-mono --mode json → AgentSignal
├── generic-adapter.ts   ~95 lines   Any CLI → lifecycle signals
├── bus.ts              ~120 lines   Multiplexer + JSONL logger
├── spawner.ts          ~310 lines   Spawn Claude/Codex, cleanup worktrees, worktree gate
├── registry.ts         ~100 lines   Persistent agent→session mapping
├── orchestrator.ts     ~500 lines   Review, race, ralph, cost guard, escalation, timeout
├── timeout.ts           ~90 lines   withTimeout() — SIGTERM/SIGKILL escalation
├── workflow.ts         ~360 lines   Markdown workflow parser + multi-agent runner
├── watch.ts            ~140 lines   JSONL replay + summary
├── tui.tsx             ~220 lines   Ink/React card dashboard
├── tmux-consumer.ts    ~190 lines   tmux pane status updates
└── cli.ts              ~700 lines   All commands + --timeout flag

tests/
├── phase0/             13 tests     Validate Claude Code primitives
│   ├── run-all.sh
│   ├── t01-t13-*.sh
│   └── results/
└── phase1-2/           10 tests     Unit + live tests for all phases
    ├── run-all.sh
    ├── t01-t10-*.sh
    └── results/
```

## CLI Reference

```
deno task expo spawn <prompt> [--name N] [--agent claude|codex] [--model M] [--no-worktree] [--timeout N]
deno task expo spawn-all <tasks.json> [--timeout N]
deno task expo status
deno task expo resume <agentId> [--headless ["prompt"]]
deno task expo fork <agentId>
deno task expo cleanup <agentId> | --all
deno task expo review <prompt> [--max N] [--work-agent claude|codex] [--review-agent claude|codex]
deno task expo race "A" vs "B" [--criteria "..."] [--timeout N]
deno task expo ralph "<work>" "<gate>" [--max N] [--review]
deno task watch <file.jsonl> [--json | --summary]
deno task tui <file.jsonl> [--watch]
deno task test
```
