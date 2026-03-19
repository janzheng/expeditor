# expo — Design

## Mission

A headless-first subagent orchestration system that lets you spawn, monitor, and coordinate multiple coding agents through a unified signal bus — simpler than Conductor/Superset, more visible than cook.

## Who

- **Solo developers** using Claude Code / Codex who want to run multiple agents in parallel without a GUI desktop app
- **Tool builders** who want a programmable orchestration layer they can call from scripts, CI, or other tools
- **Anyone frustrated** that Conductor/Superset require GitHub repos and manual per-agent interaction

## What

sigbus spawns coding agents (Claude Code, Codex, any CLI) in isolated worktrees, intercepts their structured output streams, normalizes them into a common signal format, and multiplexes everything into a single bus. The bus feeds orchestration logic (review loops, races, task progression) and pluggable UI consumers (terminal dashboard, JSONL logs, web dashboard).

The key insight: **the signal bus is the primitive, everything else is a consumer.** Orchestrators, UIs, cost trackers, and escalation handlers all subscribe to the same stream.

## Why

Existing tools each solve part of the problem but miss the full picture:

| Tool | Does well | Missing |
|------|-----------|---------|
| **cook** | Composable workflow grammar (review, race, ralph) | No signal visibility — headless black box |
| **agentgrid** | Spatial layout (tmux panes) | No structured signals, no orchestration |
| **Slate** | Swarm UX (action cards, subagent takeover) | Proprietary, coupled to its own UI |
| **Conductor** | Beautiful stream-json rendering | GUI-only, requires GitHub, no cross-agent bus |
| **Superset** | Worktree isolation, mastracode harness | Per-workspace events, no shared bus, poll-based |

sigbus fills the gap: **headless orchestration with a shared signal bus that any consumer can read.**

## How It Works

```
┌──────────────────────────────────────────────────────┐
│                    Signal Bus (JSONL)                  │
│  Multiplexes normalized AgentSignal from all agents   │
└────┬──────────┬──────────┬──────────┬────────────────┘
     │          │          │          │
  Consumers:   │          │          │
  ├─ Orchestrator (review/race/ralph)
  ├─ CLI pretty-printer (real-time)
  ├─ JSONL logger (replay/debug)
  ├─ Cost guard (budget enforcement)
  ├─ Escalation router (failure detection)
  └─ Watch (post-hoc replay + summary)
     │          │          │
     ▼          ▼          ▼
  ┌──────┐  ┌──────┐  ┌──────┐
  │ Claude│  │Claude│  │ Any  │
  │ Agent │  │Agent │  │ CLI  │
  │  -p   │  │ -p   │  │      │
  └──┬────┘  └──┬───┘  └──┬───┘
     │          │          │
  Worktree 1  Worktree 2  (cwd)
```

**Data flow:**
1. CLI spawns agent: `claude -p --output-format stream-json --verbose --worktree <name> --session-id <uuid> "<prompt>"`
2. Agent's stdout (stream-json) pipes through the **Claude adapter** → normalized `AgentSignal` objects
3. Signals flow into the **Signal Bus** (in-memory EventEmitter + JSONL file)
4. All consumers see every signal from every agent, tagged with `agentId` and `sessionId`
5. **Orchestrator** reads signals to make decisions (DONE/ITERATE, PICK winner, NEXT task)
6. **Registry** persists agent→session→worktree mappings to `.sigbus/registry.json`

**Key discovery from Phase 0:** Claude Code's `--worktree`, `--session-id`, `--resume`, `--fork-session`, and `stream-json` flags mean we're not building infrastructure — we're building a thin multiplexer on top of already-solid primitives.

**The adapter is thin by design.** Claude's stream-json has 5 event types; our adapter mostly unwraps `assistant.message.content[]` and normalizes field names. The `_raw` field preserves the original event so rich consumers can access agent-specific data. If all agents converge on stream-json format, the adapter becomes a passthrough.

## Goals

- [x] Validate that Claude Code's primitives (stream-json, worktree, resume, session-id) work together
- [x] Build adapter + bus + multiplexer for normalized signals
- [x] Build spawner with worktree isolation (no GitHub required)
- [x] Build cook-style orchestration (review loop, race, ralph)
- [x] Build headless UI consumers (pretty printer, JSONL logger, summary)
- [ ] Rich TUI dashboard (Slate-style cards)
- [ ] tmux consumer (agentgrid-style)
- [?] Web dashboard (SSE + React)
- [?] Codex adapter

## Team

- [*] @yawnxyz — human, product direction, research context, testing
- [*] @claude — AI agent, primary dev + architecture

## Non-Goals

- [*] Replacing Conductor/Superset — we're a lightweight alternative, not a competitor
- [*] Building a GUI desktop app — headless-first, GUI is a consumer
- [*] Managing GitHub PRs/reviews — Conductor/Superset do that well
- [*] Running without git — worktrees need git, but NOT GitHub

## Decisions

- [x] [decided: Deno] Runtime — TypeScript-first, good CLI tooling, simpler than Node for scripts
- [x] [decided: JSONL file] Bus transport — simplest, append-only, tail for real-time, cat for replay. Upgrade to SQLite if querying matters.
- [x] [decided: adapter pattern] Signal normalization — thin adapters per agent, not a universal parser. Preserves `_raw` for rich consumers.
- [x] [decided: Claude does it] Worktree management — `claude --worktree` handles creation + branching, we only add cleanup + registry tracking
- [x] [decided: JSON file] Registry persistence — `.sigbus/registry.json`, simple and sufficient
- [x] [decided: in-process] Orchestrator runs in same process as spawner — simpler, no IPC needed
- [?] Codex adapter — depends on how different Codex's output format is

## Risks

- [!] `stream-json` format is not documented as a stable API — Anthropic could change it. Mitigated: adapter is isolated, changes break one file.
- [*] Rate limits — spawning many parallel agents may hit API rate limits. Observed 0.85 utilization warning in tests.
- [*] Cost — parallel agents multiply cost. Cost guard helps but can't prevent overspend if budgets aren't set.
