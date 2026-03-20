# Agent Orchestration Landscape

*Comparative research — how different tools solve multi-agent coordination for AI coding agents. This doc is the context behind expo's signal bus design.*

- **Date:** 2026-03-19

## The landscape

Six systems studied, each with a different answer to "how do you coordinate AI agents":

| System | Repo | Approach | Visibility | Intervention |
|--------|------|----------|------------|--------------|
| **cook** | [rjcorwin/cook](https://github.com/rjcorwin/cook) | CLI spawns processes, composable DSL | Session logs (text files) | None — headless, fire and forget |
| **agentgrid** | [naman10parikh/agentgrid](https://github.com/naman10parikh/agentgrid) | tmux sends keystrokes | Pane labels via custom tmux options | Manual — switch to pane, type |
| **Slate** | *(by [@realmcore_](https://x.com/realmcore_/status/2033020007257649473) — [writeup](https://x.com/realmcore_/status/2034429313177813214))* | Single-threaded orchestrator, DSL | Action cards with status/cost | Subagent takeover (ctrl-o) |
| **Conductor** | [ryanmac/code-conductor](https://github.com/ryanmac/code-conductor) | Worktrees per task, GitHub-native | Intercepts `stream-json`, renders beautifully | Manual — must touch each worktree |
| **Superset** | [superset-sh/superset](https://github.com/superset-sh/superset) | Worktrees per workspace, mastracode harness | Poll-based `getDisplayState()` | Chat approvals, sandbox questions |
| **Paperclip** | [paperclipai/paperclip](https://github.com/paperclipai/paperclip) | Hierarchical org chart, heartbeats | React dashboard, audit logs | Board governance, budget caps |

### Also relevant

| System | Repo | What it does |
|--------|------|-------------|
| **superpowers** | [obra/superpowers](https://github.com/obra/superpowers) | 88K stars. Complete dev methodology: brainstorm → spec → plan → subagent execution → review. Not an orchestrator per se, but defines the workflow that orchestrators execute. |
| **Overstory** | [jayminwest/overstory](https://github.com/jayminwest/overstory) | Multi-agent orchestration with pluggable runtime adapters (Claude, Pi, etc.). SQLite mail system for coordination, tiered conflict resolution. |
| **Agent Orchestrator** | [ComposioHQ/agent-orchestrator](https://github.com/ComposioHQ/agent-orchestrator) | Agent-agnostic orchestrator. Each agent gets own worktree, branch, PR. Auto-handles CI fixes. |
| **CLI Agent Orchestrator** | [awslabs/cli-agent-orchestrator](https://github.com/awslabs/cli-agent-orchestrator) | AWS. Lightweight tmux-based, hierarchical multi-agent with MCP server communication. |

## What each system gets right

### cook — composable workflow primitives
- Elegant left-to-right DSL: `cook "work" review x3 pick "best"` — each operator wraps everything to its left
- Race pattern with git worktrees — `vN` creates N parallel branches, then resolves
- Ralph pattern — task-list progression with DONE/NEXT gating
- Ships as both CLI and pure skill (no-code). The no-code version is more interesting — agent IS the orchestrator
- **Gap:** no real-time visibility into what agents are doing. Session logs are text files, not structured signals.

### agentgrid — tmux as orchestration substrate
- Single bash script (~52KB), zero deps beyond tmux. `agentgrid 2x3 claude` → 6 tiled Claude instances
- Supports 10+ agent types (Claude, Codex, Gemini, Aider, Goose, etc.) and arbitrary commands
- Status labels via Claude Code hooks → tmux custom pane options (`@pane_status`, `@pane_label`)
- Session save/restore — captures agent type, directory, session ID per pane, resumes with agent-specific flags
- Broadcast command — `agentgrid broadcast "git pull"` sends same keystrokes to all panes
- Sound alerts on done/waiting/subagent events via `afplay`/`paplay`
- **Gap:** tmux state is the only signal store. No structured events, no persistence, no cross-agent awareness.

### Slate — best UI for agent swarms
- By [@realmcore_](https://x.com/realmcore_). RLM-based coding agent with single-threaded orchestrator delegating to subagent threads
- "Show actions, not agents" — displays currently active actions as cards, not a permanent agent dashboard
- Card contents: task, follow-up instructions, agent outputs, recent tool calls, cost, completion status
- Three exit states: Done / Escalated / Aborted — decided by the orchestrator, not the subagent
- Subagent takeover (ctrl-o) — navigate all sessions, select one, directly interact. ctrl-b returns to main thread
- Episode compaction — subthreads return compressed traces ("episodes") to main thread, keeping orchestrator context manageable
- Hive-mind architecture — single orchestrator thread, not a peer network
- **Gap:** cards are tightly coupled to Slate's own TUI. Can't use the signal data elsewhere.

### Conductor — best signal consumer
- Parses `claude -p --output-format stream-json` into beautiful renders
- Per-event icons: brain (thinking), terminal (bash), file (read), dots (agent spawn)
- Shows cost, duration, token count per subagent
- "+33 earlier tools" — collapsed tool call history
- Nested subagent rendering with indented child tool calls
- **Gap:** one session at a time. No cross-agent bus. Requires GitHub. No automated orchestration.

### Superset — closest to "IDE for agents"
- Worktree isolation per workspace with setup/teardown scripts
- Mastracode harness gives structured events (`agent_start`, `agent_end`, `error`, `sandbox_access_request`)
- Two modes: chat (structured) and terminal (raw pty)
- Local SQLite tracks project → workspace → PR relationships
- **Gap:** events are per-workspace, not cross-workspace. Poll-based, not push. Limited event vocabulary (no tool_call, progress, cost, escalated). Desktop GUI only.

### Paperclip — the "AI company" metaphor
- Org charts, roles, reporting lines — agents have bosses and job descriptions
- Goal alignment — every task traces back to company mission
- Budget caps per agent with hard stops on overspend
- Heartbeat protocol — agents wake on schedule, check for work, act
- Multi-company isolation on one deployment
- Adapter pattern across agent types (Claude, Codex, Cursor, Gemini, OpenClaw)
- **Gap:** the corporate hierarchy is mostly theater — a "CEO agent" is just an LLM with a different system prompt. The coordination doesn't actually benefit from the org chart. The real value is budgets + audit trails + the adapter abstraction.

## The shared gap

**Every system couples signaling to its execution/UI layer.**

- Cook's `loopEvents` EventEmitter is wired to its Ink TUI
- Agentgrid's status lives in tmux custom options
- Slate's cards are rendered by its own TUI
- Conductor shows one session at a time — no shared bus
- Superset's events are per-workspace with no aggregation
- Paperclip's signals are internal to its server/dashboard

None of them expose a **signal bus** — a structured, multiplexed event stream that any consumer can read independently.

## What expo does differently

Expo's thesis: **separate the signal from the consumer.**

```
Claude Code ──→ [claude adapter]  ──┐
Codex       ──→ [codex adapter]   ──┤──→ Signal Bus ──→ Consumers
Any CLI     ──→ [stdout adapter]  ──┘
```

The signal bus is the primitive. Everything else is a consumer:
- **Orchestrator** — reads bus, makes decisions (cook-style review loops, cost guards, escalation routing)
- **UI** — reads bus, renders whatever you want (or nothing — headless)
- **Logger** — reads bus, writes JSONL for replay/debugging
- **Webhook** — reads bus, posts to Slack on escalation

Key differences from the landscape:
1. **Headless-first** — no server, no GUI, no database required. Library, not a platform.
2. **Adapter model** — normalizes heterogeneous agent outputs into common signals. Adapters shrink as agents improve their own signaling.
3. **Stream, not final state** — the interesting data is tool calls, progress, escalations as they happen, not just done/failed at the end.
4. **No hierarchy assumption** — flat bus supports trees (Slate's hive-mind), flat sets (cook's race), or any topology.

## Discussion

### 2026-03-19 — Initial analysis

The orchestration space is converging on similar primitives (worktrees, structured output parsing, parallel agent dispatch) but diverging on philosophy:

- **Workflow-first** (cook, superpowers): define the process, agents fill slots
- **UI-first** (Conductor, Superset, Slate): make agents visible and controllable
- **Metaphor-first** (Paperclip): make agents legible through corporate framing
- **Signal-first** (expo): make the event stream the foundation, build everything else on top

Paperclip's 30k stars vs cook's 83 stars tells you something — the narrative of "run an AI company" is more compelling than composable workflow primitives, even though cook's architecture is arguably more useful for actual development work. Paperclip is theater that sells; cook is infrastructure that works.

The real question for expo: can a signal-bus-first approach be compelling enough to attract adoption, or does it need a "story" layer on top? The bus is the right primitive, but primitives alone don't get stars.
