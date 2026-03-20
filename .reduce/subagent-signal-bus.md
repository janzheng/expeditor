# Subagent Signal Bus

*Deep dive — what if the orchestration layer was just a signal/logging system, and everything else (UI, dashboards, intervention) was built on top of that data stream?*

## The idea

Across cook, agentgrid, and Slate, there are three different answers to "how do you orchestrate subagents":

| System | Orchestration | Visibility | Intervention |
|--------|--------------|------------|--------------|
| **cook** | CLI spawns processes, AST-driven | Session logs (text files) | None — headless, fire and forget |
| **agentgrid** | tmux sends keystrokes | Pane labels via custom tmux options | Manual — switch to pane, type |
| **Slate** | Single-threaded orchestrator, DSL | Action cards with status/cost | Subagent takeover (ctrl-o) |
| **Conductor** | Worktrees per task, manual subagent touch | Intercepts `claude -p --output-format stream-json`, renders beautifully | Manual — must touch each worktree/subagent |
| **Superset** | Worktrees per workspace, mastracode harness | Poll-based `getDisplayState()`, per-workspace events | Chat approvals, sandbox questions |

They all have the same gap: **the signaling between orchestrator and subagents is tightly coupled to the UI/execution layer.** Cook's logs are just text files. Agentgrid's status lives in tmux custom options. Slate's cards are rendered by its own TUI.

What if you separated concerns:

1. **Signal bus** — a structured event stream that subagents emit to (started, progress, tool_call, escalated, done, failed, cost)
2. **Orchestrator** — reads the bus to make decisions (gate, route, retry, escalate)
3. **UI layer** — reads the bus to render whatever you want (cards, grid, dashboard, logs, nothing)

The signal bus is the primitive. Everything else is a consumer.

## Why this matters

**Conductor doesn't do this.** The user noted that Conductor (which they use for orchestration) doesn't provide this kind of subagent signal visibility. Most orchestration tools treat subagents as black boxes — you get the final output, maybe an error, but not the stream of what happened along the way.

The three exit states from Slate (Done/Escalated/Aborted) are more expressive than binary pass/fail, but they're still just the *final* signal. The interesting data is the *stream*:

```
[agent-1] started task="implement auth middleware"
[agent-1] tool_call tool=read_file path="src/auth.ts"
[agent-1] tool_call tool=edit_file path="src/auth.ts"
[agent-1] progress message="Auth middleware implemented, writing tests"
[agent-1] tool_call tool=bash command="npm test"
[agent-1] escalated reason="3 tests failing, unsure if auth config issue"
[agent-2] started task="review agent-1 changes"
[agent-2] tool_call tool=git_diff
[agent-2] done verdict="ITERATE" reason="missing error handling in token refresh"
```

This stream is what lets you build:
- **Slate-style cards** — render active actions with recent tool calls
- **Agentgrid-style spatial view** — map agents to panes, show status labels
- **Cook-style headless logs** — append to session log files
- **Cost dashboards** — aggregate token usage across all subagents
- **Intervention points** — detect escalation signals and route to human
- **Replay/debugging** — full trace of what every agent did and why

## What the signal schema might look like

```typescript
interface AgentSignal {
  agentId: string
  parentId?: string        // who spawned this agent
  timestamp: number
  type:
    | 'spawned'            // agent created with task
    | 'started'            // agent began execution
    | 'progress'           // free-form status update
    | 'tool_call'          // agent invoked a tool
    | 'tool_result'        // tool returned
    | 'output'             // streaming text output
    | 'escalated'          // agent hit a blocker, needs help
    | 'done'               // task completed successfully
    | 'failed'             // task failed
    | 'aborted'            // task cancelled externally
    | 'cost'               // token/cost update
  payload: Record<string, unknown>
}
```

Key design decisions:
- **`parentId`** — makes the agent tree navigable. Slate's hive-mind is a tree; cook's race is a flat set of siblings. Both expressible.
- **`escalated`** — Slate's third state, promoted to a first-class signal. This is the "I need a human" signal that most systems lack.
- **`tool_call` / `tool_result`** as separate signals — enables real-time tool call display (Slate's "recent tool calls" on cards) without waiting for completion.
- **`cost`** — Slate shows per-subagent cost. Making it a signal means any consumer can aggregate.

## How existing agents could emit signals

### Claude Code

Claude Code has **hooks** — shell commands that fire on events:
- `PreToolUse` / `PostToolUse` — maps to `tool_call` / `tool_result`
- `Stop` — maps to `done`
- `SubagentStop` — maps to done for subagents

The hook could write to a shared signal file or named pipe:

```bash
# .claude/hooks/post-tool-use.sh
echo '{"agentId":"'$CLAUDE_SESSION_ID'","type":"tool_call","payload":{"tool":"'$TOOL_NAME'"}}' >> /tmp/signal-bus.jsonl
```

### Codex

Codex in `--full-auto` mode writes to stdout. Cook already captures this with `onLine` callbacks. Those lines could be parsed and emitted as signals.

### Any agent (generic)

Wrap any agent process and parse its stdout/stderr for structured signals. The `NativeRunner` pattern from cook already does this — it just doesn't emit structured events.

## The orchestrator as signal consumer

Cook's executor currently makes decisions inline:

```typescript
// cook's gate logic
if (no High severity issues) → DONE
if (High issues && iteration < max) → ITERATE
```

With a signal bus, the orchestrator is just another consumer:

```typescript
bus.on('escalated', (signal) => {
  // Route to human, or retry with different strategy
})

bus.on('done', (signal) => {
  // Check gate criteria, decide NEXT or DONE
})

bus.on('cost', (signal) => {
  // Kill agent if over budget
})
```

This makes the orchestration logic pluggable. Cook's review loop, Slate's hive-mind, and a simple "run N agents and take the first success" are all just different event handlers on the same bus.

## The UI as signal consumer

This is where it gets interesting. The signal bus doesn't prescribe a UI — it enables any UI:

**Terminal dashboard (like agentgrid but data-driven):**
```
┌─────────────┬─────────────┬─────────────┐
│ Agent 1     │ Agent 2     │ Agent 3     │
│ ⚡ WORKING  │ ✅ DONE     │ ⏳ ESCALATED│
│ edit_file   │ 3 files     │ "auth issue"│
│ $0.12       │ $0.08       │ $0.15       │
└─────────────┴─────────────┴─────────────┘
```

**Web dashboard:** Real-time SSE stream → React cards (Slate-style)

**Headless:** Just pipe to a JSONL file for later analysis

**Slack/webhook:** Filter for `escalated` signals → post to Slack channel

All reading the same bus. The orchestration and visibility are fully decoupled.

## The signal source already exists (mostly)

**Key realization: we don't need to replace agent signals. We need a harmonizer.**

Every coding agent emits *some* kind of structured output, but they're all different formats. If they all converged on the same perfect signal format, we wouldn't need anything. But they won't — and even if Claude Code's `stream-json` is great, Codex does it differently, Gemini does it differently, Aider does it differently, and they all change between versions.

Our signal system should be an **adapter layer**, not a replacement:
- If an agent has a great signal system (Claude Code's `stream-json`) → pass it through, maybe normalize field names
- If an agent has a partial signal system → fill in the blanks (infer status from exit codes, parse stdout for tool calls)
- If an agent has nothing (random CLI tool) → wrap it and emit basic signals (started, stdout lines, exit code)

Think of it like a **codec**. Each agent gets an adapter that speaks its native format and emits a common signal format. If stream-json becomes the universal standard, the adapter for Claude Code is a no-op passthrough. If Codex converges to the same format, its adapter becomes a passthrough too. The adapters shrink as agents improve their own signaling — and that's fine.

### Claude Code's `stream-json`

`claude -p --output-format stream-json` emits structured JSON for every event:
- `thinking` — with preview text
- `tool_use` — tool name, input, file paths
- `tool_result` — output, success/failure
- `text` — streaming assistant text
- `result` — final output with cost/token stats
- Subagent events are nested (Agent tool spawns appear as tool_use with nested events)

**Conductor already proves this works.** The Conductor screenshots show it parsing every event type from this stream and rendering them with appropriate icons:
- Thinking blocks (brain icon, preview text)
- Bash/shell tool calls (terminal icon, command shown inline)
- Skill activation (clock icon)
- Agent subagent spawns (dots icon, with nested tool calls indented)
- Read tool calls (file icon, path + line count)
- Duration + cost per subagent

This is just a very good *consumer* of Claude Code's existing output stream. The rendering is a data transformation step — structured JSON in, pretty UI out.

### Codex's equivalent

Codex also outputs structured JSON in auto mode. Cook's `NativeRunner` already captures stdout from both `claude -p` and `codex exec --full-auto`. The structured data is there.

### The missing piece: harmonization + multiplexing

The signal sources exist but they're fragmented. What's missing is:

1. **Adapters per agent** — normalize each agent's native format into a common schema. Thin where the agent's signals are good, thick where they're not.
2. **Aggregation** — multiple adapted streams → one bus
3. **Persistence** — write to a store for replay/debugging
4. **Cross-agent awareness** — agent A's signals visible alongside agent B's
5. **Consumer API** — subscribe to the bus from any process (UI, orchestrator, webhook)

The adapter model means we're **not fighting the agents' own signal systems** — we're harmonizing them. If Claude Code adds cost signals to `stream-json` tomorrow, our Claude adapter just passes them through. If Gemini CLI adds tool_call events, its adapter gets thinner. The adapters are the seam between "their world" and "our bus."

```
Claude Code ──→ [claude adapter]  ──┐
Codex       ──→ [codex adapter]   ──┤──→ Signal Bus ──→ Consumers
Gemini CLI  ──→ [gemini adapter]  ──┤
Aider       ──→ [generic adapter] ──┤
Any CLI     ──→ [stdout adapter]  ──┘
```

The generic/stdout adapter is the fallback — it wraps any process, emits `started`/`output`/`done`/`failed` based on process lifecycle. Thin signals, but enough for basic orchestration and monitoring.

## What Conductor/Superset actually do (and don't)

### What they do well

**Conductor:**
- Intercepts `stream-json` from Claude Code and renders it beautifully
- Each subagent gets a polished view: thinking, tool calls, file reads, bash commands
- Shows cost ($0.71), token count (483k), duration (2m 10s) per subagent
- "+33 earlier tools" collapsed history — smart summarization of tool call stream
- Worktree isolation per task

**Superset:**
- Same worktree isolation pattern
- mastracode harness gives structured events (`agent_start`, `agent_end`, `error`, `sandbox_access_request`)
- Two modes: chat (structured) and terminal (raw pty)
- Local SQLite tracks project → workspace → PR relationships

### What they DON'T do

**No cross-agent signal bus:**
- Conductor shows one session at a time. To see another subagent, you must manually navigate to that worktree.
- Superset's events are per-workspace — no shared bus across workspaces.
- Neither lets you see all agents' signals in one view (Slate's card grid).

**No automated orchestration:**
- Both require manual human touch for each subagent. You start each one, you check each one.
- Cook's review loop (work → review → gate → iterate) has no equivalent. There's no "run 5 agents, review each, iterate until done."
- Ralph's task-list progression doesn't exist — no "work through this list, checking after each task."

**No headless/API mode:**
- Both are desktop GUI apps. You can't call them from a script.
- No CLI that says "run these 5 tasks in parallel worktrees, review, pick the best."
- Cook has this but lacks the signal visibility.

**GitHub requirement:**
- Conductor requires a GitHub repo (not just git init). Can't use for non-code projects.
- Superset same — cloud API syncs with GitHub repos.
- This is a real blocker: research projects, writing, design work — anything that's not a code repo committed to GitHub can't use the worktree system.
- Note: `/Users/janzheng/conductor/workspaces/agentscape/jerusalem-v1/apps/mva` documents a workaround — git init without GitHub.

## The vision: headless cook + signal bus + pluggable UI

### Architecture

```
┌─────────────────────────────────────────────────┐
│                   Signal Bus                     │
│  (JSONL stream — multiplexes all agent signals)  │
└──────────┬──────────┬──────────┬────────────────┘
           │          │          │
    ┌──────┴──┐ ┌─────┴────┐ ┌──┴─────────────┐
    │ Agent 1 │ │ Agent 2  │ │ Agent N        │
    │ (claude │ │ (codex   │ │ (any CLI)      │
    │  -p)    │ │  exec)   │ │                │
    └─────────┘ └──────────┘ └────────────────┘
           │          │          │
           ▼          ▼          ▼
      Worktree 1  Worktree 2  Worktree N
      (git init)  (git init)  (git init)  ← NO GitHub required

Signal Bus Consumers:
├── Orchestrator (cook-style: review loops, ralph, race)
├── UI: Terminal (agentgrid tmux panes)
├── UI: Cards (Slate-style TUI)
├── UI: Web (SSE → React dashboard)
├── UI: GUI (Electron/Tauri — Conductor-style)
├── Logger (JSONL file for replay)
├── Cost tracker (aggregate token usage)
└── Webhook (Slack/Discord on escalation)
```

### Layer 1: Agent adapters (the "data conversion step")

Each agent gets a thin adapter that speaks its native signal format and emits common signals. The adapter's job is to **harmonize, not replace** — pass through what's good, fill in what's missing.

**Claude Code adapter** (rich — stream-json has almost everything):
```typescript
// Raw stream-json event
{"type":"tool_use","name":"Read","input":{"file_path":"src/auth.ts"},"id":"toolu_123"}

// Adapter emits normalized signal (thin transformation — mostly field renames)
{
  "agentId": "wt-auth-impl",
  "parentId": "orchestrator",
  "timestamp": 1710835200000,
  "type": "tool_call",
  "payload": {
    "tool": "Read",
    "input": {"file_path": "src/auth.ts"},
    "toolUseId": "toolu_123",
    "_raw": { /* original stream-json event preserved */ }
  }
}
```

**Codex adapter** (medium — has structured output, different format):
```typescript
// Adapter normalizes codex's format to common schema
// Fills in fields codex doesn't provide (e.g., cost breakdown)
```

**Generic CLI adapter** (thin — just process lifecycle):
```typescript
// Any CLI tool that writes to stdout
// Adapter emits: spawned, started, output (per line), done/failed (exit code)
// No tool_call, no cost, no thinking — those signals don't exist for generic CLIs
```

Key principle: **`_raw` field preserves the original event.** Consumers that understand Claude-specific data can read `_raw` for richer info. Consumers that only understand the common schema ignore it. This means the adapter is lossless — you never throw away information, you just add a common envelope.

If stream-json becomes the universal standard and all agents adopt it, every adapter becomes a passthrough and the "signal bus" is just a multiplexer with no transformation. That's the ideal end state — our adapters are designed to shrink toward zero.

### Layer 2: Signal bus (the multiplexer)

All normalized signals from all agents flow into one stream:

```
{"agentId":"wt-auth","type":"started","payload":{"task":"implement auth"}}
{"agentId":"wt-tests","type":"started","payload":{"task":"write test suite"}}
{"agentId":"wt-auth","type":"tool_call","payload":{"tool":"Read","input":{"file_path":"src/auth.ts"}}}
{"agentId":"wt-tests","type":"tool_call","payload":{"tool":"Bash","input":{"command":"npm test"}}}
{"agentId":"wt-auth","type":"done","payload":{"cost":0.71,"tokens":483000,"duration":130}}
{"agentId":"wt-tests","type":"escalated","payload":{"reason":"3 tests failing, need auth config"}}
```

Transport options (simplest first):
1. **JSONL file** — append-only, tail -f for consumers, dead simple
2. **Named pipe / Unix socket** — real-time, no disk
3. **SQLite WAL** — queryable, persistent, single-writer-multi-reader
4. **Redis stream** — if you need network distribution

Start with JSONL. It's what cook's session logs already are, just not structured.

### Layer 3: Orchestrator (reads bus, makes decisions)

This is cook's executor, but bus-driven:

```typescript
// Review loop — reads signals, decides DONE/ITERATE
bus.on('done', async (signal) => {
  if (signal.agentId === currentReviewAgent) {
    const verdict = parseGateVerdict(signal.payload.output)
    if (verdict === 'DONE') resolveTask(signal)
    else if (verdict === 'ITERATE') spawnIterateAgent(signal)
  }
})

// Ralph — reads signals, decides NEXT task
bus.on('done', async (signal) => {
  if (signal.agentId === currentRalphTask) {
    const verdict = parseRalphVerdict(signal.payload.output)
    if (verdict === 'DONE') finishRalph()
    else spawnNextTask()
  }
})

// Cost guard — kills agents over budget
bus.on('cost', async (signal) => {
  if (signal.payload.totalCost > budget) {
    abortAgent(signal.agentId)
  }
})

// Escalation router — surfaces to human
bus.on('escalated', async (signal) => {
  notifyHuman(signal)  // Slack, UI notification, etc.
})
```

### Layer 4: UI consumers (reads bus, renders)

**Option A: agentgrid (tmux)**
```bash
# Read bus, update tmux pane labels
tail -f signal-bus.jsonl | while read line; do
  agent=$(echo $line | jq -r .agentId)
  type=$(echo $line | jq -r .type)
  tmux set-option -p -t "$agent" @pane_status "$type"
done
```

**Option B: Slate-style cards (TUI)**
Ink/React TUI that reads the bus and renders cards per agent, with tool call history, cost, status.

**Option C: Web dashboard**
SSE endpoint that streams bus events → React frontend with Slate-style cards.

**Option D: Conductor-style GUI**
Electron/Tauri app. The prettiest consumer. But now it's *just a consumer* — the orchestration runs independently.

**Option E: Nothing (headless)**
Just log to JSONL. Run from CI. Check results later.

### Layer 5: Worktrees (without GitHub)

```bash
# Create a workspace — just git init, no GitHub needed
mkdir -p .workspaces/auth-impl
cd .workspaces/auth-impl
git init
# OR if parent is a git repo:
git worktree add .workspaces/auth-impl -b auth-impl

# Agent runs in the worktree
claude -p --output-format stream-json --cwd .workspaces/auth-impl "implement auth"
```

The key insight from the mva project: you can `git init` any folder and use it as a workspace. Worktrees are better when you have a shared repo (agents can see each other's base), but plain `git init` works for non-code projects.

## What this enables that nothing else does

1. **`cook "implement auth" review v3 pick "cleanest"`** but with live visibility into all 3 racing agents, their tool calls, costs, and the ability to intervene if one gets stuck.

2. **Non-code swarms** — run 5 agents researching different topics, each in a git-init workspace, with a dashboard showing progress and an orchestrator that compiles results.

3. **Mix and match agents** — Claude Code for work, Codex for review, Gemini for a third opinion. All emitting to the same bus. All visible in the same UI.

4. **CI/CD integration** — headless mode, run from GitHub Actions, signal bus writes to JSONL artifact, cost report at the end.

5. **Gradual UI upgrade** — start with agentgrid (tmux panes), upgrade to Slate-style cards, upgrade to Conductor-style GUI. Same bus, different consumers.

## Open questions

- **Transport:** Start with JSONL (simplest). Upgrade to SQLite WAL if querying matters. Upgrade to Redis if network distribution matters.
- **Backpressure:** If an agent emits thousands of tool calls, does the bus need filtering/sampling?
- **Episode compaction:** Slate's key innovation — subthreads return compressed traces. Should compaction happen at the signal level (consumers get raw signals + a "summary" signal at the end) or at the orchestrator level?
- **Signal trust:** Should the orchestrator trust agent-emitted signals? An agent saying "done" doesn't mean the work is actually correct. Cook's review loop exists precisely because you can't trust the work agent's self-assessment.
- **stream-json stability:** Is Claude Code's `stream-json` format stable/documented? If it changes, the adapter breaks. Same for Codex. But adapters are thin and isolated — a format change only breaks one adapter, not the whole bus.
- **Convergence:** Will all agents converge on one signal format? If yes, the adapter layer becomes trivial (passthrough). If no, the adapter layer is the whole value. Either way, we need the multiplexer.
- **Adapter thickness:** How thick should adapters be? Claude's might be near-passthrough. A generic CLI adapter might need to infer tool calls from stdout patterns. Where's the line between "useful inference" and "unreliable guessing"?
- **Persistence:** Signals are ephemeral (real-time monitoring) but also historical (debugging, replay, cost analysis). JSONL gives you both — tail for real-time, cat for history.
- **Intervention model:** Slate lets you take over a subagent (ctrl-o). Claude Code has `--resume <sessionId>` which may solve this — start headless with `-p`, then `--resume` interactively to "drop in." Need to validate: can you resume a `-p` session interactively? What about `--fork-session` to branch from a subagent's state?
- **Claude Code's built-in `--worktree`:** Claude Code already has `--worktree [name]` and `--tmux` flags. This may eliminate manual worktree management entirely. Combined with `--session-id`, `--name`, and `--resume`, Claude Code might already have 80% of the spawner + workspace manager built in. Need to test: does `--worktree` work without GitHub? Does it clean up?
- **Adapter thickness over time:** Our adapter layer should be designed to get thinner. If Claude Code's stream-json adds cost signals, our adapter stops adding them. If Codex adopts stream-json format, its adapter becomes a passthrough. The adapters are seams, not walls.

## Connections

- **[cook](../cook/notes.md)** — already has the runner/executor split. The `onLine` callback is a proto-signal bus. The `agentLoop` emitter (`loopEvents`) is literally an EventEmitter that emits step/prompt/line/done events. This is 80% of the way there.
- **[agentgrid](../agentgrid/notes.md)** — status labels via tmux custom options is a signal store (write `@pane_status`, read it for display). Just not structured or cross-agent.
- **[swarm-subagent-ux.md](../swarm-subagent-ux.md)** — Slate's action cards are the best existing UI consumer of agent signals. Their episode compaction is the best existing signal compression.
- **[three-sub-agent-patterns.md](../three-sub-agent-patterns.md)** — sync/async/scheduled delegation patterns all need different signal semantics. Sync = blocking wait for `done`. Async = fire and subscribe to future `done`. Scheduled = `spawned` now, `started` later.
- **[agent-collaboration-primitives.md](agent-collaboration-primitives.md)** — the "ephemeral collaboration channel" pattern. Signals are ephemeral channels between agents and any observer.
- **[superset](../superset/notes.md)** — Conductor-like open source desktop app. Has the harness event model (`agent_start`, `agent_end`, `error`, `sandbox_access_request`) and poll-based display state. Proves the gap: per-workspace events, no cross-workspace bus, no persistence, no cost signals.

## Discussion

### 2026-03-19 — Initial exploration

The core thesis: **separate the signal from the consumer.** Every agent orchestration system we've looked at bundles its signaling with its execution and display. Cook's EventEmitter is wired to its Ink TUI. Agentgrid's status is wired to tmux. Slate's cards are wired to its own UI.

If you extract the signal bus as an independent primitive, you get:
1. **Composable orchestration** — swap orchestration logic without changing agents or UI
2. **Composable visibility** — build any UI on the same data stream
3. **Composable intervention** — route escalation signals to humans via any channel

The practical starting point might be cook's `loopEvents` EventEmitter. It already emits `step`, `prompt`, `line`, `done` events. If those were structured signals written to a shared JSONL file (or similar), any external process could consume them. Cook's Ink TUI would just be one consumer. A web dashboard could be another. A Slack bot watching for escalations could be a third.

The question is whether this needs to be a library/framework or just a convention (emit JSONL to a known path). Given that the agents are already different processes (Claude Code, Codex, etc.), a file-based convention might be simpler and more universal than an in-process event system.

### 2026-03-19 — After reading superset (Conductor-like OSS)

Superset confirms the gap. Their `ChatRuntimeManager` has harness events (`agent_start`, `agent_end`, `error`, `sandbox_access_request`) and a `getDisplayState()` poll method. But:

1. **Events are per-workspace, not cross-workspace.** Each workspace subscribes to its own harness. There's no shared bus where you can see all agents.
2. **Poll, not push.** The UI calls `getDisplayState()` on an interval rather than subscribing to an event stream. This means the UI can't react instantly to signals.
3. **Events aren't persisted.** They're consumed by the runtime manager for bookkeeping (clear error on `agent_start`, track pending questions) and then forgotten. No replay, no debugging.
4. **Limited event vocabulary.** No `tool_call`, no `progress`, no `cost`, no `escalated`. Just start/end/error/sandbox-access.

The Slate screenshots (from the user) show what the signal bus *could* enable:
- **Subagent card grid** — each card shows task, tool calls, status (green dot = done, orange = escalated), cost, token count, duration. This requires streaming `tool_call`, `cost`, and `done`/`escalated` signals per agent.
- **Subagent takeover** — click a card, drop into the session. This requires the signal bus to carry enough context to resume interaction (session ID, parent task, current state).
- **"... +33 earlier tools"** — collapsed history. The signal bus needs to support both real-time streaming (show latest) and historical query (expand to see all).

The interesting contrast: Superset runs agents in two modes — **chat** (mastracode harness, structured events) and **terminal** (node-pty, raw bytes). The signal bus should unify both. Whether the agent is a harness emitting typed events or a subprocess emitting stdout, the signal format should be the same. Cook's `NativeRunner` already parses stdout into lines — adding structured signal emission there would bridge the gap.

**Key insight from the screenshots:** The subagent card UI is a *consumer* of signals, not a *source*. The UI doesn't need to know whether signals come from Claude Code hooks, mastracode harness events, or parsed terminal output. It just reads the bus. This is the decoupling that makes the whole thing work — and what neither Conductor, Superset, nor cook currently do cleanly.

### 2026-03-19 — Conductor deep look + the real architecture

Major reframing after looking at Conductor screenshots closely and understanding how it works.

**The signal source already exists.** Conductor intercepts `claude -p --output-format stream-json` and does a "polishing data conversion step" — parsing the structured JSON events into a pretty UI. This means:
- Thinking → brain icon + preview text
- tool_use (Bash) → terminal icon + command
- tool_use (Read) → file icon + path + line count
- tool_use (Agent) → dots icon + nested subagent with its own indented tool calls
- Skill activation → clock icon
- Cost/duration/token count at the bottom

Codex does similar structured output. So the problem isn't "how do we get signals" — it's "how do we multiplex multiple agents' signals into one bus and let different consumers read them."

**The architecture should be functions all the way down:**
1. **Interceptor function** — takes raw agent stdout (stream-json), emits normalized signals
2. **Multiplexer function** — aggregates signals from N interceptors into one bus
3. **Orchestrator function** — reads bus, makes decisions (cook's review/ralph/race logic)
4. **Consumer function** — reads bus, does something (render UI, log, webhook, cost track)

Everything is headless. Everything is callable. The CLI is just one way to invoke these functions. An API endpoint is another. A GUI app is another.

**The worktree thing is key.** Conductor and Superset both require GitHub repos. This blocks non-code work (research, writing, design). The fix: support both `git worktree add` (for proper repos) and plain `git init` (for anything else). The mva project at `/Users/janzheng/conductor/workspaces/agentscape/jerusalem-v1/apps/mva` already does this — creates workspaces from scratch without needing a committed GitHub repo.

**What we'd build differently from Conductor:**
- Conductor is a GUI-first desktop app. We'd be headless-first, CLI+API, GUI optional.
- Conductor requires manual touch per subagent. We'd have cook's orchestration (review loops, ralph, race) running autonomously.
- Conductor's signal parsing is internal to its UI layer. We'd externalize it as a bus that any consumer can read.
- Conductor requires GitHub. We'd work with any git-init'd folder.

**What we'd steal from Conductor:**
- The stream-json interceptor/parser. The data conversion step that turns raw events into pretty renderable data.
- The "+N earlier tools" collapsed history pattern.
- The per-subagent cost/duration/token display.
- The nested subagent rendering (Agent tool → indented child tool calls).

### 2026-03-19 — Phase 0 validated: 13/13 tests pass

Ran the full validation suite. Key findings that change the architecture:

**stream-json is simpler than expected.** Only 5 top-level event types:
- `system` (init) → has session_id, cwd, model, tools, mcp_servers
- `assistant` (model output) → `message.content[]` contains tool_use, text, thinking as content blocks
- `user` (tool results) → `tool_use_result` with results from tools
- `rate_limit_event` → rate limit status (internal, skip)
- `result` (final) → `total_cost_usd`, `duration_ms`, `usage` (input/output/cache tokens), `modelUsage` per-model breakdown

The adapter is THIN. It's mostly unwrapping `assistant.message.content[]` into flat signals.

**Subagents are just tool_use events.** An Agent tool spawn appears as `content[].type = "tool_use", name = "Agent"` with `input.description`, `input.prompt`, `input.subagent_type`. The `parent_tool_use_id` on subsequent events links child→parent. No special subagent event type needed.

**Resume works perfectly.** `claude --resume <id> -p --output-format stream-json --verbose` gives you a headless resumed session with full context, emitting structured events. This IS the intervention model — start headless, resume interactively to "drop in."

**Fork works.** `--fork-session` creates a new session ID while retaining parent context. You can branch from any session state.

**Worktrees work without GitHub.** `--worktree <name>` creates `.claude/worktrees/<name>` on branch `worktree-<name>`. Just `git init` + one commit is enough. No remote required. But worktrees are NOT auto-cleaned — they persist after exit.

**The spawn command is one line:**
```bash
claude -p --output-format stream-json --verbose \
  --worktree <name> --session-id <uuid> --name <label> "<prompt>"
```

This gives you: isolated worktree + deterministic session tracking + named agent + structured signal stream. The entire Phase 2 spawner is basically wrapping this command, piping stdout to the adapter, and maintaining a small JSON registry of agent→session→worktree mappings.

**Revised effort estimate:** The whole MVP (adapter + multiplexer + spawner + headless logger) is maybe a weekend project. Claude Code did 80% of the work for us with `--worktree` + `--session-id` + `stream-json`.
