# Research Notes: expo

- **Origin:** Built from scratch during research session, 2026-03-19
- **Name:** Expo — the kitchen expeditor. Stands at the pass, sees every plate, coordinates the line.

## What it is

A headless-first subagent orchestration system. Spawns multiple Claude Code (or any CLI) agents in isolated worktrees, intercepts their structured output streams via a thin adapter layer, multiplexes everything into a single signal bus, and runs cook-style orchestration patterns (review loops, races, task progression) on top. ~2,200 lines of Deno TypeScript. 23 tests.

## Why it exists

Every existing tool solves part of the problem:
- **cook** has great workflow grammar but no signal visibility
- **agentgrid** has spatial layout but no structured signals
- **Slate** has swarm UX but is proprietary and coupled to its UI
- **Conductor/Superset** render signals beautifully but are GUI-only, require GitHub, and have no cross-agent bus

Expo fills the gap: headless orchestration with a shared signal bus that any consumer can read. No GitHub required.

## Key insight

Claude Code already has `--worktree`, `--session-id`, `--resume`, `--fork-session`, and `--output-format stream-json`. We're not building infrastructure — we're building a thin multiplexer on top of already-solid primitives.

## What to study

- **Adapter pattern** — `claude-adapter.ts` is ~300 lines that normalize 5 stream-json event types into 8 signal types. Thin by design.
- **Bus multiplexer** — `bus.ts` is ~120 lines. EventEmitter + JSONL append. That's the whole bus.
- **Orchestrator** — `orchestrator.ts` has review loop, race, ralph, cost guard, and escalation — all as bus consumers.
- **CLI** — `cli.ts` wires it all together: spawn, resume, fork, review, race, ralph, watch, status, cleanup.

## Discussion

### 2026-03-19 — Built in one session

Started from research (cook, agentgrid, Slate tweet, superset), workshopped the signal bus idea, validated assumptions with 13 tests against Claude Code's actual behavior, then built the whole system. The Phase 0 validation was crucial — discovering that `--worktree` works without GitHub and `--resume` works on headless sessions changed the architecture dramatically (made Phase 2 much simpler).

The name "expo" fits because the expeditor's job is exactly what this does:
- **See every plate** → signal bus sees every agent's output
- **Call out orders** → spawner launches agents with tasks
- **Check quality** → review loop gates on severity
- **Coordinate timing** → race runs parallel, ralph runs sequential
- **Escalate problems** → escalation router on repeated failures
- **Track the board** → registry persists agent states
