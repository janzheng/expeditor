# expo — Tasks

Headless subagent orchestration with a signal bus. See [TASKS-DESIGN.md](TASKS-DESIGN.md) for why/how.

**Status:** Feature complete. 18 source files, ~4,200 lines. 24 tests. 5 agent types. mxit task runner. Permission ledger.

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
- [~] Web dashboard (SSE + React) — moved to Later #web-ui

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
- [~] Package as installable CLI (`deno install --global`) — moved to Later
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
- [x] [done: `src/mxit-runner.ts` + CLI `expo mxit TASKS.md` — reads ready tasks, claims, spawns, marks done/fail, cascades] mxit integration #goal:fold-stack
- [ ] Claude Code skill — `/expo review "prompt"` from inside Claude Code #goal:fold-stack
- [x] [done: `deno compile` → standalone binary, `deno task install` puts it in ~/.deno/bin/expo] Package as installable CLI
- [ ] Web dashboard (SSE + React) — SSE endpoint, card grid, cost aggregates
- [x] [done: subscribe to cost signals per agent, show per-agent + agents/synthesis/total breakdown] Cost tracking per workflow
- [ ] Domain-level URL restrictions — `Bash(curl:*)` allows curl to anywhere; needs PreToolUse hook for URL filtering

### Pi-mono Full Integration #multi-agent #pi

- [ ] Pi-mono sandbox support — equivalent of `--settings` for pi-mono's permission model
  - [*] Adapter exists (`src/pimono-adapter.ts`) but sandbox/permissions not wired
- [ ] Pi-mono permission denial capture — parse pi-mono's denial format into `DenialDetail`
- [ ] Pi-mono in workflow runner — `--agent pi` support in `expo workflow`
- [ ] Pi-mono in mxit runner — `expo mxit TASKS.md --agent pi` end-to-end test
- [ ] Pi-mono cross-model review — `--work-agent pi --review-agent claude` and vice versa

### OpenCode Full Integration #multi-agent #opencode

- [ ] OpenCode sandbox support — equivalent of `--settings` for opencode's permission model
  - [*] Adapter exists (`src/opencode-adapter.ts`) but sandbox/permissions not wired
- [ ] OpenCode permission denial capture — parse opencode's denial format into `DenialDetail`
- [ ] OpenCode in workflow runner — `--agent opencode` support in `expo workflow`
- [ ] OpenCode in mxit runner — `expo mxit TASKS.md --agent opencode` end-to-end test
- [ ] OpenCode cross-model review — `--work-agent opencode --review-agent claude` and vice versa

### Permission Ledger

- [x] [done: `src/permission-ledger.ts` — persistent JSON, record/approve/reject/merge] Permission ledger #permissions
  - [x] Tracks denied tool patterns across runs in `.expo/permissions.json`
  - [x] `expo permissions` CLI command (list/approve/reject/reset)
  - [x] `buildSandbox()` merges approved → allow, rejected → deny into SandboxConfig
  - [x] Wired into spawn, workflow, mxit — all backward-compatible via optional param
- [x] [fixed: denials are objects not strings — normalize to `Bash(git:*)` patterns] Adapter denial parsing #permissions
  - [x] Rich `DenialDetail` type preserves full command + description from Claude Code
  - [x] Ledger stores last 3 examples per pattern for display context
  - [x] CLI shows command/description under each denied pattern
- [x] [done: `tests/test-ledger-cycle.sh` — 12/12 pass, full approve→re-run cycle verified] Verify full approve → re-run cycle end-to-end #permissions #testing
- [x] [done: `--sandbox <preset>` flag with validation, defaults to developer] Add `--sandbox` flag to `expo spawn` #permissions

### Testing Gaps

- [x] [done: `tests/test-workflow-synthesis.sh` — 5/5 pass, 2 agents + synthesis all produce output] End-to-end workflow synthesis test #testing
- [x] [done: covered by ledger cycle test above] Permission ledger full cycle test #testing

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
├── spawner.ts          ~340 lines   Spawn 5 agent types, cleanup worktrees, worktree gate
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
deno task expo permissions [approve|reject|reset] [<pattern>]
deno task watch <file.jsonl> [--json | --summary]
deno task tui <file.jsonl> [--watch]
deno task test
```
