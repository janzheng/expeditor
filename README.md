# Expeditor

**Expeditor** is a multi-agent orchestration system. It spawns coding agents (Claude Code, Codex, OpenCode, Pi-mono, or any CLI), intercepts their structured output, multiplexes everything into a signal bus, and runs workflow patterns on top — review loops, parallel races, task progression, and markdown-driven research pipelines.

The signal bus is the core primitive. Orchestrators, UIs, loggers, cost trackers, and webhook notifiers are all just consumers of the same stream.

> **Named after the kitchen expeditor** — the person who stands at the pass, sees every plate, coordinates the line, and calls out when something needs attention.

## Install

```bash
# From the project directory
deno task install    # compiles and installs `expo` to ~/.deno/bin/

# Or run directly
deno task expo <command>
```

## Quick start

```bash
# Set up a new project
expo init

# Spawn an agent
expo spawn "implement auth middleware" --name auth-agent

# Open the web dashboard
expo serve
# → http://localhost:3000

# Race two approaches
expo race "implement with JWT" vs "implement with sessions" \
  --criteria "security and simplicity"

# Review loop — iterate until quality converges
expo review "refactor the auth module" --max 3

# Run tasks from a TASKS.md file
expo mxit TASKS.md --parallel

# Check what's running
expo status
```

### Prerequisites

- [Deno](https://deno.land/) 2.0+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI (`claude` on PATH)
- Optional: [Codex](https://github.com/openai/codex), [OpenCode](https://github.com/nicholasgriffintn/opencode), [Pi-mono](https://github.com/mariozechner/pi-coding-agent) for cross-model workflows

## Features

### Web dashboard

Live agent monitoring in the browser:

```bash
expo serve [--port 3000]
```

- **Live** — real-time agent cards with status, tool calls, costs, resume buttons
- **Runs** — browse past runs with session replay scrubber
- **Permissions** — approve/reject denied patterns from the browser
- **Costs** — grand total, bar chart, per-agent breakdown
- **Launch** — start spawn/race/review from browser forms

### Permission ledger

Agents running headlessly can't prompt for permission. The ledger tracks what gets denied, lets you approve patterns, and merges them into future runs automatically.

```bash
# After a run, see what was denied
expo permissions
# ● Bash(git:*)    pending  2x  (from: auth-agent)
#   ↳ git push origin main (Push changes to remote)

# Approve for future runs
expo permissions approve "Bash(git:*)"

# Sync to Claude Code settings (works outside expo too)
expo permissions sync
# → .claude/settings.local.json updated

# One-step approve + sync
expo permissions approve "Bash(git:*)" --auto-sync
```

### Sandbox presets

Control what each agent can do:

```bash
expo spawn "research topic" --sandbox research    # web + files, no git
expo spawn "implement feature" --sandbox developer # full dev, no force-push
expo spawn "do everything" --sandbox permissive   # all tools
```

Custom sandbox with domain filtering:

```markdown
## sandbox
allow: Read, Write, WebFetch, Bash(curl:*)
deny: Bash(git:*)
domains: api.github.com, pubmed.ncbi.nlm.nih.gov
```

### Cross-model workflows

Mix and match agent types:

```bash
# Codex writes, Claude reviews
expo review "implement linked list" --work-agent codex --review-agent claude

# Pi-mono with research sandbox
expo spawn "analyze codebase" --agent pi --sandbox research

# OpenCode in a workflow
expo workflow research.md --agent opencode
```

Supported agents: `claude`, `codex`, `opencode`, `pi`, `generic`

### Signal bus

Every agent emits structured signals normalized into a common format:

```
18:06:30  auth-agent  ● spawned (claude-opus-4-6)
18:06:34  auth-agent  ├ Read src/auth.ts ✓
18:06:38  auth-agent  ├ Edit src/auth.ts ✓
18:06:42  auth-agent  ✅ done (12.1s, 3 turns)
18:06:42  auth-agent  💰 $0.1523 · 4090 tokens
```

### Markdown workflows

Define multi-agent research pipelines as markdown:

```bash
expo workflow workflows/templates/code-review.md --budget 5
```

Included templates: `code-review.md`, `research.md`, `refactor.md`

### Webhook notifications

```bash
export EXPO_WEBHOOK_URL=https://hooks.slack.com/services/...
export EXPO_WEBHOOK_FORMAT=slack  # or discord, generic

# Now all commands send alerts on done/failed
expo spawn "deploy to staging" --name deploy
```

### Task execution (mxit)

Run tasks from a TASKS.md file:

```bash
expo mxit TASKS.md --parallel --max 5 --timeout 300
```

Reads ready tasks, claims them, spawns agents, marks done/fail, cascades to newly-ready tasks.

## Commands

| Command | Description |
|---------|-------------|
| `expo init` | Set up Expeditor in current project |
| `expo spawn <prompt>` | Spawn a single agent |
| `expo spawn-all <file.json>` | Spawn multiple agents in parallel |
| `expo status` | Show all agents in registry |
| `expo resume <id>` | Resume an agent interactively |
| `expo fork <id>` | Fork from an agent's session state |
| `expo cleanup --all` | Clean up finished agents' worktrees |
| `expo review <prompt>` | Review loop: work → review → gate |
| `expo race "A" vs "B"` | Race branches, judge picks winner |
| `expo ralph "<work>" "<gate>"` | Sequential task progression |
| `expo workflow <file.md>` | Run a markdown workflow |
| `expo mxit <TASKS.md>` | Execute tasks from a task file |
| `expo serve` | Web dashboard |
| `expo permissions` | Manage permission ledger |
| `expo watch <file.jsonl>` | Replay a bus log |

### Key flags

| Flag | Available on | Description |
|------|-------------|-------------|
| `--agent TYPE` | spawn, workflow, mxit | Agent type: claude, codex, opencode, pi, generic |
| `--sandbox PRESET` | spawn, mxit | Permission preset: permissive, research, developer |
| `--timeout N` | all | Kill after N seconds |
| `--no-worktree` | spawn | Run in current directory |
| `--work-agent TYPE` | review | Agent for work step |
| `--review-agent TYPE` | review | Agent for review step |
| `--parallel` | mxit | Fan out independent tasks |
| `--budget N` | workflow | Max cost in USD |
| `--auto-sync` | permissions approve/reject | Also sync to .claude/settings.local.json |

## Architecture

```
Agents (Claude, Codex, OpenCode, Pi-mono, any CLI)
  │ stdout (stream-json / --json / --mode json)
  ▼
Adapters (claude, codex, opencode, pimono, generic)
  │ normalize to AgentSignal
  ▼
Signal Bus (JSONL multiplexer)
  │
  ├──→ Orchestrator (review, race, ralph, workflow)
  ├──→ Permission ledger (record denials, merge approvals)
  ├──→ Terminal printer (live CLI output)
  ├──→ Web dashboard (SSE → browser cards)
  ├──→ TUI dashboard (Ink/React cards)
  ├──→ JSONL logger (replay, debug)
  ├──→ Cost guard (budget enforcement)
  ├──→ Webhook notifier (Slack, Discord)
  ├──→ Escalation router (failure detection)
  └──→ tmux consumer (pane labels)
```

## Testing

```bash
deno task test             # phase 1-2 tests (11)
deno task test:phase0      # Claude Code primitive validation (13)
deno task test:all         # everything

# Integration tests
bash tests/test-ledger-cycle.sh        # permission approve→re-run (12 checks)
bash tests/test-workflow-synthesis.sh   # fan-out + synthesis e2e (5 checks)
deno run --allow-all tests/test-domain-filter.ts  # domain hooks (5 checks)
```

## Design docs

- `TASKS-DESIGN.md` — mission, architecture, goals, decisions
- `.reduce/subagent-signal-bus.md` — original deep dive on the signal bus concept
- `.reduce/harness-controlled-sandbox.md` — permission system design + empirical findings
- `.reduce/workflow-driven-research.md` — workflow architecture

## License

MIT
