---
description: "Run expo orchestration commands — race, review, workflow, spawn, mxit, permissions. Use when the user says 'race', 'vs', 'review loop', 'expo', 'fan out', 'run workflow', 'run tasks', or wants multi-agent orchestration patterns beyond what Claude Code's Agent tool provides."
user_invocable: true
---

# expo — Multi-Agent Orchestration

expo adds orchestration patterns on top of Claude Code: race (parallel + judge), review loops, task-file execution, markdown workflows, and permission management. It runs as a compiled CLI binary.

## When to use expo vs Claude Code's Agent tool

- **Agent tool**: One subagent at a time, no competition, no iteration loop
- **expo race**: N approaches in parallel with worktree isolation, a judge picks the best
- **expo review**: Work → review → gate → iterate until quality converges
- **expo workflow**: Markdown-driven multi-agent research with synthesis
- **expo mxit**: Execute tasks from a TASKS.md file with claiming and cascading

## Commands

Run these via Bash. The `expo` binary must be installed (`deno task install` from the expo project).

### Race — parallel approaches, pick the best

```bash
expo race "approach A" vs "approach B" [vs "approach C"] \
  --criteria "cleanest code, best test coverage" \
  --timeout 120 --name my-race
```

Each branch runs in its own worktree. A judge agent picks the winner based on criteria.

### Review Loop — iterate until quality converges

```bash
expo review "implement auth middleware with JWT validation" \
  --max 3 --timeout 120
```

Runs: work agent → review agent → gate decision (DONE/ITERATE). Repeats up to `--max` iterations.

Cross-model review (different agent writes vs reviews):
```bash
expo review "implement the feature" \
  --work-agent codex --review-agent claude \
  --timeout 120
```

Works with any combination: `claude`, `codex`, `opencode`, `pi`.

### Spawn — single headless agent

```bash
expo spawn "do the thing" \
  --name my-agent --no-worktree --timeout 60 \
  --sandbox research
```

Sandbox presets: `permissive` (all tools), `research` (web + files, no git), `developer` (all tools, no destructive git).

Agent types: `claude` (default), `codex`, `opencode`, `pi` (pi-mono), `generic` (any CLI).

### Workflow — markdown-driven multi-agent pipeline

```bash
expo workflow path/to/workflow.md --timeout 120 --budget 5
```

Workflow files define agents, sandbox, synthesis instructions. See `tests/test-workflow.md` for format.

### mxit — run tasks from TASKS.md

```bash
expo mxit TASKS.md --parallel --max 5 --timeout 300
```

Reads ready tasks, claims them, spawns agents, marks done/fail, cascades to newly-ready tasks.

### Permissions — manage the permission ledger

```bash
expo permissions                        # list all entries
expo permissions approve "Bash(git:*)"  # approve for future runs
expo permissions reject "Bash(sudo:*)"  # deny for future runs
expo permissions reset                  # clear ledger
```

The ledger persists denied tool patterns across runs. Approved patterns are merged into the sandbox config automatically on subsequent runs.

### Status & Cleanup

```bash
expo status          # show all agents in registry
expo cleanup --all   # remove finished agents' worktrees
```

## How to respond

When the user asks for a race, review, or other orchestration pattern:

1. Build the appropriate `expo` command from their request
2. Run it via Bash — the output streams in real-time with signal indicators
3. Report the result (winner, verdict, cost, etc.)

The commands can take 1-5 minutes depending on complexity. Set appropriate `--timeout` values.

## Examples

User: "race two approaches for implementing the cache — one with Redis, one with in-memory LRU"
```bash
expo race "Implement a cache layer using Redis. Write to src/cache/" \
  vs "Implement a cache layer using an in-memory LRU. Write to src/cache/" \
  --criteria "performance, simplicity, test coverage" \
  --timeout 180
```

User: "review and iterate on this auth implementation"
```bash
expo review "Review and improve the auth implementation in src/auth/. Fix any bugs, add missing edge cases, ensure tests pass." \
  --max 3 --timeout 120
```

User: "run the next tasks"
```bash
expo mxit TASKS.md --max 3 --timeout 300
```
