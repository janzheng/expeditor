# expo

**expo** is a headless subagent orchestration system. It spawns multiple coding agents (Claude Code, Codex, or any CLI), intercepts their structured output, multiplexes everything into a single signal bus, and runs workflow patterns on top — review loops, parallel races, sequential task progression.

The signal bus is the core primitive. Orchestrators, UIs, loggers, and cost trackers are all just consumers of the same stream.

> **Named after the kitchen expeditor** — the person who stands at the pass, sees every plate, coordinates the line, and calls out when something needs attention.

## Quick start

```bash
cd _workshop/expo

# Spawn a single agent
deno task expo spawn "implement auth middleware" --name auth-agent

# Spawn with Codex instead of Claude
deno task expo spawn "write tests" --name test-agent --agent codex

# Run 3 agents in parallel
deno task expo spawn-all tasks.json

# Check what's running
deno task expo status
```

### Prerequisites

- [Deno](https://deno.land/) 1.40+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI (`claude` on PATH)
- [Codex CLI](https://github.com/openai/codex) (`codex` on PATH) — optional, for cross-model workflows

## Features

### Signal bus

Every agent emits structured signals: `spawned`, `tool_call`, `tool_result`, `output`, `done`, `failed`, `cost`. These are normalized into a common format regardless of which agent produced them, and multiplexed into a single JSONL stream.

```
18:06:30  auth-agent  ● spawned (claude-opus-4-6)
18:06:34  auth-agent  ├ Read src/auth.ts ✓
18:06:38  auth-agent  ├ Edit src/auth.ts ✓
18:06:42  auth-agent  ✅ done (12.1s, 3 turns)
18:06:42  auth-agent  💰 $0.1523 · 4090 tokens
```

Signals are written to a JSONL file. Any number of consumers can read the same bus.

### Cross-model review

Run a review loop where one model does the work and a different model reviews it:

```bash
# Codex writes code, Claude reviews it
deno task expo review "implement a linked list" \
  --work-agent codex \
  --review-agent claude

# Or the reverse
deno task expo review "refactor the auth module" \
  --work-agent claude \
  --review-agent codex
```

The review loop runs: **work → review → gate → iterate** until the reviewer says DONE or max iterations is reached. Different models catch different things — adversarial collaboration between frontier models.

### Parallel races

Run multiple approaches simultaneously, then have a judge pick the best:

```bash
deno task expo race \
  "implement auth with JWT" \
  vs \
  "implement auth with sessions" \
  --criteria "best security and simplicity"
```

Each branch runs in its own git worktree. A judge agent compares the results and picks a winner.

### Task progression (ralph)

Work through a task list sequentially, with a gate after each task:

```bash
deno task expo ralph \
  "do the next task in PLAN.md" \
  "DONE if all tasks complete, else NEXT" \
  --max 10
```

### Resume and fork

Every agent gets a session ID. Resume any session interactively or headlessly:

```bash
# Drop into an agent's session interactively
deno task expo resume auth-agent

# Resume headlessly with a follow-up prompt (signals flow back through the bus)
deno task expo resume auth-agent --headless "what files did you change?"

# Fork — branch from an agent's state into a new session
deno task expo fork auth-agent
```

### Worktree isolation

Each agent can run in its own git worktree. No GitHub required — `git init` is enough:

```bash
# With worktree (default)
deno task expo spawn "implement feature X" --name feature-x

# Without worktree (run in current directory)
deno task expo spawn "quick fix" --name hotfix --no-worktree
```

Worktrees are created at `.claude/worktrees/<name>`. Clean up with:

```bash
deno task expo cleanup --all
```

### UI consumers

The signal bus supports pluggable consumers. Three are included:

**Terminal printer** — live line-by-line output (built into every command):

```
18:06:30  auth-agent  ● spawned (claude-opus-4-6)
18:06:34  auth-agent  ├ Read src/auth.ts ✓
```

**TUI dashboard** — Slate-style card grid with colored borders:

```bash
deno task tui bus-1234.jsonl          # static view
deno task tui bus-1234.jsonl --watch  # live polling
```

```
╭────────────────────────╮ ╭────────────────────────╮
│ ✓ auth-agent    opus   │ │ ✗ test-agent   sonnet  │
│   ├ Read src/auth.ts ✓ │ │   ├ Bash npm test ✗    │
│   ├ Edit src/auth.ts ✓ │ │   Tests failing: auth… │
│   11.0s · $0.15        │ │   7.5s · $0.04         │
╰────────────────────────╯ ╰────────────────────────╯
```

**Watch** — JSONL replay with optional summary:

```bash
deno task watch bus-1234.jsonl            # replay signals
deno task watch bus-1234.jsonl --summary  # per-agent stats + total cost
deno task watch bus-1234.jsonl --json     # raw JSON pass-through
```

**tmux consumer** — agentgrid-style pane status labels (run inside tmux):

```bash
deno run --allow-all src/tmux-consumer.ts bus-1234.jsonl
```

## Commands

| Command | Description |
|---------|-------------|
| `expo spawn <prompt>` | Spawn a single agent |
| `expo spawn-all <file.json>` | Spawn multiple agents in parallel |
| `expo status` | Show all agents in registry |
| `expo resume <id>` | Resume an agent interactively |
| `expo resume <id> --headless` | Resume headlessly (signals → bus) |
| `expo fork <id>` | Fork from an agent's session state |
| `expo cleanup <id>` | Remove agent's worktree + registry entry |
| `expo cleanup --all` | Clean up all finished agents |
| `expo review <prompt>` | Review loop: work → review → gate |
| `expo race "A" vs "B"` | Race branches, judge picks winner |
| `expo ralph "<work>" "<gate>"` | Sequential task progression |
| `expo watch <file.jsonl>` | Replay a bus log |

### Spawn flags

| Flag | Description |
|------|-------------|
| `--name <name>` | Agent name (also worktree name) |
| `--agent claude\|codex` | Agent type (default: `claude`) |
| `--model <model>` | Model override |
| `--no-worktree` | Run in current directory |

### Review flags

| Flag | Description |
|------|-------------|
| `--work-agent claude\|codex` | Agent for work step |
| `--review-agent claude\|codex` | Agent for review step |
| `--work-model <model>` | Model for work step |
| `--review-model <model>` | Model for review step |
| `--max <N>` | Max review iterations (default: 3) |

### Race flags

| Flag | Description |
|------|-------------|
| `--criteria "..."` | Judging criteria |
| `--name <prefix>` | Agent name prefix |

## Architecture

```
Agents (Claude, Codex, any CLI)
  │ stdout (stream-json / --json)
  ▼
Adapters (claude-adapter, codex-adapter, generic-adapter)
  │ normalize to AgentSignal
  ▼
Signal Bus (JSONL multiplexer)
  │
  ├──→ Orchestrator (review, race, ralph)
  ├──→ Terminal printer (live output)
  ├──→ TUI dashboard (Ink/React cards)
  ├──→ JSONL logger (replay, debug)
  ├──→ Cost guard (budget enforcement)
  ├──→ Escalation router (failure detection)
  └──→ tmux consumer (pane labels)
```

The adapters are thin by design. Claude's adapter normalizes 5 event types from `stream-json`. Codex's adapter normalizes 4 event types from `--json`. Both preserve the original event in a `_raw` field so rich consumers can access agent-specific data.

If all agents converge on the same output format, the adapters become pass-throughs. They're designed to shrink toward zero.

## Signal types

| Signal | When | Key fields |
|--------|------|------------|
| `spawned` | Agent initialized | `cwd`, `model`, `tools` |
| `tool_call` | Agent invoked a tool | `tool`, `input`, `isSubagent` |
| `tool_result` | Tool returned | `result`, `isError` |
| `output` | Agent produced text | `text` |
| `progress` | Agent is thinking | `message`, `kind` |
| `done` | Task completed | `result`, `durationMs`, `numTurns` |
| `failed` | Task failed | `error`, `exitCode` |
| `cost` | Cost/token update | `totalCostUsd`, `inputTokens`, `outputTokens` |

## Testing

```bash
# Automated tests (24 total)
deno task test             # unit + live tests (11)
deno task test:phase0      # Claude Code primitive validation (13)
deno task test:all          # everything

# Hands-on playtest
# See playtests/hands-on-tour.md for a guided walkthrough
```

## File structure

```
src/
├── types.ts              Signal types + typed payloads
├── claude-adapter.ts     Claude stream-json → AgentSignal
├── codex-adapter.ts      Codex --json → AgentSignal
├── generic-adapter.ts    Any CLI → lifecycle signals
├── bus.ts                Multiplexer + JSONL logger + rotation
├── spawner.ts            Spawn agents, cleanup worktrees
├── registry.ts           Persistent agent→session mapping
├── orchestrator.ts       Review, race, ralph, cost guard, escalation
├── cli.ts                All commands
├── watch.ts              JSONL replay + summary
├── tui.tsx               Ink/React card dashboard
└── tmux-consumer.ts      tmux pane status updates

tests/
├── phase0/               13 tests — Claude Code primitive validation
└── phase1-2/             11 tests — unit + live tests

playtests/
├── hands-on-tour.md      Guided walkthrough of every feature
├── parallel-tasks.json   Multi-agent spawn-all example for the tour
└── tui-tasks.json        Parallel tasks for the TUI dashboard step
```

## Background

expo grew from studying how existing tools handle subagent orchestration:

- **[cook](../../cook/)** — composable workflow grammar (review, race, ralph) but no signal visibility
- **[agentgrid](../../agentgrid/)** — tmux spatial layout but no structured signals
- **Slate** — swarm UX with action cards but proprietary and coupled to its UI
- **Conductor / [Superset](../../superset/)** — beautiful signal rendering but GUI-only, requires GitHub

The key insight: Claude Code's `--output-format stream-json`, `--worktree`, `--session-id`, and `--resume` flags already provide the hard primitives. expo is a thin multiplexer on top.

See `TASKS-DESIGN.md` for the full design rationale, `subagent-signal-bus.md` for the original deep dive, and `TASKS.md` for remaining work.

## License

Research prototype. Not yet packaged for distribution.
