# Expeditor — Tasks

Multi-agent orchestration with a signal bus. CLI command: `expo`. See [TASKS-DESIGN.md](TASKS-DESIGN.md) for why/how.

**Status:** Feature complete. 17 source files, ~5,200 lines. 28 tests + 4 integration tests. 5 agent types. Permission ledger. Domain filtering. Multi-agent sandbox.

**Run tests:** `bash tests/phase0/run-all.sh` (13 pass) · `bash tests/phase1-2/run-all.sh` (11 pass) · `bash tests/test-ledger-cycle.sh` (12 pass) · `bash tests/test-workflow-synthesis.sh` (5 pass) · `deno run --allow-all tests/test-domain-filter.ts` (5 pass)

**Completed work:** See [TASKS.done.md](TASKS.done.md)

## Current

All planned tasks complete. See [TASKS.done.md](TASKS.done.md) for Phase 0-5 archive.

## Current

### Permission Sync #permissions

- [x] [done: `expo permissions sync` + `--dry-run`, merges to .claude/settings.local.json] Push approved patterns to Claude Code settings
  - [x] Reads existing settings.local.json (creates if missing)
  - [x] Merges approved → `permissions.allow`, rejected → `permissions.deny`
  - [x] Dedupes — skips patterns already in the settings file
  - [x] `--dry-run` flag shows what would be added without writing
  - [x] Idempotent — re-sync skips already-synced patterns
- [x] [pass: approve 2 + reject 1 → dry-run shows 3 → sync writes correct JSON → re-sync skips all] Playtest sync

### Web Dashboard

### Tier 1: Live Monitor #web-dashboard

- [x] [done: `src/web.ts` — SSE server + JSONL tailer, auto-detects new log files] SSE endpoint
  - [x] `expo serve` command — starts HTTP server (default port 3000)
  - [x] Tails JSONL bus log, broadcasts each signal as SSE event
  - [x] Supports multiple concurrent browser clients
  - [x] Replays existing log on connect, then streams live events
  - [x] Auto-detects new log files when new expo commands start
- [x] [done: `src/web/index.html` — dark theme, vanilla JS, ~250 lines] Agent card page
  - [x] Cards appear on `spawned`, update on `tool_call`/`tool_result`/`progress`/`cost`
  - [x] Status dot + border: green=done, yellow=working, red=failed
  - [x] Agent name, model, recent tool calls (last 5), cost, duration, tokens
  - [x] "+N earlier tools" expandable collapse
  - [x] Working cards show live duration timer (updates every second)
  - [x] Permission denials shown on card
  - [x] Auto-reconnect on disconnect
- [ ] Playtest Tier 1 — open in browser, run `expo spawn`, verify cards appear and update live

### Tier 2: History + Permissions UI #web-dashboard #needs:tier1

- [ ] Run history page — browse past JSONL log files from `.expo/logs/`
  - [ ] List runs by timestamp, show agent count and total cost per run
  - [ ] Click a run to see timeline of all signals
- [ ] Permission ledger UI — read/write `.expo/permissions.json` from the browser
  - [ ] Show pending/approved/rejected entries with examples
  - [ ] Approve/reject buttons that POST to the server
  - [ ] Server endpoint: `POST /api/permissions/approve`, `POST /api/permissions/reject`
- [ ] Cost dashboard — aggregate costs across runs
  - [ ] Per-agent breakdown, per-run totals, running sum chart

### Tier 3: Interactive Control (Later) #web-dashboard #needs:tier2

- [ ] Start agents from browser — form to compose spawn/race/review commands
- [ ] Resume sessions — link to `claude --resume <sessionId>` or open terminal
- [ ] Workflow visualization — fan-out → synthesis flow as a simple diagram

## Later

- [?] Tier 3 interactive control — needs design discussion before building

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
