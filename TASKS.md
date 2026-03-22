# Expeditor — Tasks

Multi-agent orchestration with a signal bus. CLI command: `expo`. See [TASKS-DESIGN.md](TASKS-DESIGN.md) for why/how.

**Status:** Feature complete. 18 source files, ~5,500 lines. 28 tests + 4 integration tests. 5 agent types. Permission ledger. Domain filtering. Multi-agent sandbox. Web dashboard. Claude Code skill.

**Run tests:** `bash tests/phase0/run-all.sh` (13 pass) · `bash tests/phase1-2/run-all.sh` (11 pass) · `bash tests/test-ledger-cycle.sh` (12 pass) · `bash tests/test-workflow-synthesis.sh` (5 pass) · `deno run --allow-all tests/test-domain-filter.ts` (5 pass)

**Completed work:** See [TASKS.done.md](TASKS.done.md) for Phase 0-5 archive.

## Current

No open tasks. Everything shipped.

### Tier 2: History + Permissions UI + Costs #web-dashboard

- [x] [done: `/api/runs` + `/api/runs/:file`, `runs.html` with timeline drill-down] Run history page
  - [x] List runs by timestamp, agent count, total cost, file size
  - [x] Click a run to see full signal timeline with color-coded event types
- [x] [done: `/api/permissions` GET + `/api/permissions/approve|reject` POST, `permissions.html`] Permission ledger UI
  - [x] Shows pending/approved/rejected entries with examples and deny counts
  - [x] Approve/reject buttons POST to server, page reloads
  - [x] Status counts bar (N approved, N rejected, N pending)
- [x] [done: `/api/costs`, `costs.html` with bar chart + per-run breakdown table] Cost dashboard
  - [x] Grand total across all runs
  - [x] Bar chart of last 30 runs with hover tooltips
  - [x] Per-run table with per-agent cost breakdown

### Extras

- [x] [done: "Resume" button on cards copies `claude --resume <sessionId>` to clipboard] Resume sessions from dashboard
- [x] [done: `workflows/templates/` — code-review, research, refactor] Workflow templates
- [x] [done: `src/notify.ts` — Slack/Discord/generic, driven by EXPO_WEBHOOK_URL env var] Webhook notifications
- [x] [done: scrubber slider on runs detail, step through events] Session replay
- [x] [done: `src/web/launch.html` + POST /api/spawn, /api/race, /api/review] Launch agents from browser
- [x] [done: `expo init` — dirs, .gitignore, workflow templates] Project scaffolding
- [x] [done: running total in Live page nav bar] Live cost ticker

## Later

- [~] [deferred: cosmetic — Live page already shows all cards] Workflow visualization — DAG view of fan-out → synthesis flow
- [~] [deferred: not a real use case currently] Multi-project support

## Discovered / Open Questions

- [*] Workshop deep dive: `.reduce/subagent-signal-bus.md`
- [*] Directory sandbox is independent of tool permissions — `Bash(ls:*)` in allow won't override CC directory restrictions
- [*] Some Bash commands are auto-safe regardless of allow list (`python3 --version`, `node --version`, `echo`)
- [*] "BLOCKED" (directory) vs "DENIED" (tool permission) are different failure modes — only DENIED can be fixed via ledger
- [*] Denials only reported in final result event — no mid-stream visibility
- [*] Pi-mono has no sub-command granularity — `Bash(git:*)` can't be mapped, only bare `Bash` deny
- [*] Pi-mono denials are silent — no events in JSON output
- [*] OpenCode denials appear as tool errors — indistinguishable from other errors

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
├── permission-ledger.ts ~200 lines  Persist/approve/reject/sync denied permissions
├── mxit-runner.ts      ~300 lines   Standalone task runner using mxit format
├── spawner.ts          ~550 lines   Spawn 5 agent types, sandbox for all, domain filter hooks
├── registry.ts         ~100 lines   Persistent agent→session mapping
├── orchestrator.ts     ~510 lines   Review, race, ralph, cost guard, escalation, timeout
├── timeout.ts           ~90 lines   withTimeout() — SIGTERM/SIGKILL escalation
├── workflow.ts         ~380 lines   Markdown workflow parser + multi-agent runner
├── web.ts              ~190 lines   SSE server + JSONL tailer for dashboard
├── web/index.html      ~250 lines   Live agent card dashboard (vanilla JS)
├── watch.ts            ~140 lines   JSONL replay + summary
├── tui.tsx             ~220 lines   Ink/React card dashboard
├── tmux-consumer.ts    ~190 lines   tmux pane status updates
└── cli.ts              ~900 lines   All commands + permissions + serve

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
expo spawn <prompt> [--name N] [--agent claude|codex|opencode|pi] [--model M] [--no-worktree] [--timeout N] [--sandbox permissive|research|developer]
expo spawn-all <tasks.json> [--timeout N]
expo status
expo resume <agentId> [--headless ["prompt"]]
expo fork <agentId>
expo cleanup <agentId> | --all
expo review <prompt> [--max N] [--work-agent TYPE] [--review-agent TYPE]
expo race "A" vs "B" [--criteria "..."] [--timeout N]
expo ralph "<work>" "<gate>" [--max N] [--review]
expo workflow <file.md> [--agent TYPE] [--model M] [--budget N] [--timeout N] [--sandbox S]
expo mxit <TASKS.md> [--agent TYPE] [--parallel] [--max N] [--timeout N] [--sandbox S]
expo serve [--port N] [--log <file.jsonl>]
expo permissions [list]
expo permissions approve <pattern> [--auto-sync]
expo permissions reject <pattern> [--auto-sync]
expo permissions sync [--dry-run]
expo permissions reset
expo watch <file.jsonl> [--json | --summary]
```
