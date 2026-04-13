# Expeditor

**Expeditor** is a multi-agent orchestration system. It spawns coding agents (Claude Code, Codex, OpenCode, Pi-mono, or any CLI), intercepts their structured output, multiplexes everything into a signal bus, and runs workflow patterns on top — review loops, parallel races, task progression, markdown-driven research pipelines, and **`refine`**: a bounded iteration loop that produces reviewable commits one at a time, each passing rubric + gates before it lands.

The signal bus is the core primitive. Orchestrators, UIs, loggers, cost trackers, and webhook notifiers are all just consumers of the same stream.

> **Named after the kitchen expeditor** — the person who stands at the pass, sees every plate, coordinates the line, and calls out when something needs attention.

## What this is (and isn't)

Most AI-coding tools are either **autonomous agents** that ship code you
inspect later, or **autocomplete** that suggests code you accept immediately.
Expo's `refine` loop is a third shape: **bounded iteration inside a
hard-check box**. An agent proposes a change, the loop runs it through a
rubric (soft gate) + inherited gates (hard gates) + scope enforcement,
and either snapshots the change as a kept variant or discards it. You
trade some agent autonomy for output-quality guarantees.

### What it's good at

- **API-boundary hardening** — "this exported function accepts garbage input and fails cryptically downstream" is the canonical target
- **Error-message clarity** — consistent pattern-propagation across parallel call sites
- **Building out missing regression tests** — the rubric can require "new test per behavioral change"
- **Small hygiene fixes** — off-by-ones, missing awaits, wrong defaults that contradict nearby comments
- **Unattended runs with real money caps** — `--total-budget`, `--run-timeout`, `--per-agent-budget` are hard limits that have fired in production shakedowns

### What it's bad at

- **Codebase-wide coordination** — "rename this type across 15 files" tends to fail gates mid-change or violate scope
- **Cross-module architectural change** — the <40-LOC rubric pattern filters these out, and even without it the agent lacks the mental model
- **Anything needing runtime / integration / staging signal** — if the real validation requires production traffic, the loop can't help
- **Value judgments** — "should we use library A or B?" has no objective gate answer
- **Creative design** — do the invention work by hand, then use the loop for polish
- **Divergent exploration / finding new bug classes** — refine is a convergent tool. Same rubric + similar codebase = similar output across runs, by design. For "tell me what's wrong when I can't formulate the question yet," reach for `expo audit` (single exploration-mode agent writes ranked findings to markdown) or `expo race` (parallel approaches, judge picks winner). See [refine-philosophy.md](.brief/refine-philosophy.md#convergent-vs-divergent-briefs--both-valid-different-purposes) for the convergent-vs-divergent framing.

See **[.brief/refine-philosophy.md](.brief/refine-philosophy.md)** for
the full conceptual model (rubric-as-soft-gate, cost-per-keep, the
s-curve shape of a healthy project), and
**[.brief/cost-per-keep-analytics.md](.brief/cost-per-keep-analytics.md)**
for the metric that tells you when the loop has exhausted easy wins.

### Prerequisites for trusting the output

`refine` filters, it doesn't decide. Three things have to be in place:

1. **A tight rubric**, committed to the repo (we use `.brief/SELF-REFINE-RUBRIC.md`). The rubric is load-bearing — a looser rubric produces plausible-looking keeps that drift the codebase.
2. **Real gates** — `deno task test`, `mypy`, `eslint --max-warnings=0`, whatever your CI runs. Gates are what make cost-per-keep a meaningful metric rather than a gambling stat.
3. **Scope globs** (`--scope "src/**"`) — cheap force-discards catch scope creep before money is spent.

Without all three, refine reduces to an expensive randomness generator. See `shakedown/2026-04-13-*/findings.md` for concrete examples of each guardrail catching real bugs in practice.

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

### Audit → fix pipeline

The high-leverage workflow: have an agent find bugs, then have agents fix them with gate-validated autonomy.

```bash
# 1. Audit — an Opus agent reads your code and writes ranked findings.
#    No code changes. $1-2 for a typical project.
expo audit . --focus all --cap 20

# 2. (optional) Triage — a second agent reads the audit and flags false
#    positives. Cheap insurance: $0.50-1.
expo audit . --triage

# 3. Review .brief/audit-YYYY-MM-DD.md (and -triage.md). Pick findings.

# 4. Fix — expo refine runs N iterations, each: one focused change,
#    run gates, keep if tests pass else discard. Scope-enforced so
#    the agent can't stray.
expo refine . \
  --rubric "Fix audit-flagged silent-failure bugs from .brief/audit-*.md. Each fix must add a regression test." \
  --gate "typecheck=deno check src/" \
  --gate "tests=deno test" \
  --scope "src/workflow.ts" --scope "src/bus.ts" --scope "tests/**" \
  --per-agent-budget 1.00 --total-budget 5.00 \
  --max 5
```

**What each piece does for you:**

- **`audit`**: structured findings with severity, file:line, what-goes-wrong, trigger, suggested-fix. Cap-bounded, focus-bounded. Writes to `.brief/` by default.
- **`--triage`**: second-agent pass that filters KEEP / REJECT / NEEDS-CONTEXT. Run this before acting on audits you didn't personally verify.
- **`refine --scope GLOB`**: hard constraint. Agent modifies a file outside the globs → iteration auto-discarded before gates even run. Not rubric prose.
- **`refine --gate NAME=CMD`**: inherited invariant checks. Any non-zero exit forces discard. Same pattern across iterations so progress only goes one direction.
- **`refine --per-agent-budget / --total-budget`**: real enforcement (kills agents on overrun, emits structured failure). Not advisory.
- **`refine --allow-agent-gates`**: agent may propose *new* gates when it fixes a fragile behavior. Opt-in; locks behavior in across descendants (gate ratchet).

**Why it works**: the agent's aesthetic judgment is unreliable; your test suite is not. Gates collapse "did the agent do the right thing?" into "do the tests still pass?". The ratchet means the set of things that must remain true only grows.

**When it doesn't work**: thin test coverage. If your gates can't distinguish a good change from a subtle regression, this whole loop is just expensive coin-flipping. Invest in the test suite first.

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

### Archive-based refinement

Iterative improvement loop with snapshot/restore, inspired by [Hyperagents](https://arxiv.org/abs/2603.19461):

```bash
# Refine a directory with a rubric
expo refine ./src --rubric "clarity, brevity, no dead code" --max 5

# Continue a previous session
expo refine ./src --continue

# Branch from a specific variant
expo refine ./src --branch-from 003

# View the archive tree
expo refine ./src --tree
# └── 000 baseline — Initial state
#     ├── 001 kept — Extracted helpers
#     │   ├── 002 kept — Simplified error handling
#     │   └── 003 discarded — Over-abstracted
#     └── 004 kept — Branched: different approach

# Use a rubric file
expo refine ./src --rubric-file RUBRIC.md --max 10
```

Each iteration: agent makes ONE focused change → keeps or discards → snapshots or rolls back. On 3 consecutive discards, branches to an under-explored variant. Cross-session learning via REFINE.md.

## Commands

Grouped by which phase of a design cycle they serve. See [`.brief/design-cycle-orchestration.md`](.brief/design-cycle-orchestration.md) for the diverge → converge → diverge → converge framing that motivates this taxonomy.

### Diverge — explore, find what's there

Open-ended exploration. Useful when you can't yet formulate the question.

| Command | Description |
|---------|-------------|
| `expo audit <dir>` | Findings-only audit; writes `.brief/audit-*.md` |
| `expo audit <dir> --triage` | Audit + second-agent triage pass |
| `expo race "A" vs "B"` | Parallel framings, judge picks winner |

### Converge — select, filter, build

Bounded improvement against an explicit rubric or gate. Useful once you know what "good" looks like.

| Command | Description |
|---------|-------------|
| `expo refine <dir>` | Archive-based refinement loop (gates + scope + budget) |
| `expo review <prompt>` | Review loop: work → review → gate |

### Progress — work through known tasks

Sequential execution when the shape of the work is already specified.

| Command | Description |
|---------|-------------|
| `expo mxit <TASKS.md>` | Execute tasks from a task file |
| `expo workflow <file.md>` | Run a markdown workflow (also: a cycle engine if you design the stages) |
| `expo ralph "<work>" "<gate>"` | Sequential task progression |

### Glue — single-shot spawns, dashboards, infrastructure

The plumbing that ties phases together.

| Command | Description |
|---------|-------------|
| `expo init` | Set up Expeditor in current project |
| `expo spawn <prompt>` | Spawn a single agent |
| `expo spawn-all <file.json>` | Spawn multiple agents in parallel |
| `expo status` | Show all agents in registry |
| `expo resume <id>` | Resume an agent interactively |
| `expo fork <id>` | Fork from an agent's session state |
| `expo cleanup --all` | Clean up finished agents' worktrees |
| `expo serve` | Web dashboard (auth-gated, 127.0.0.1 default) |
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
| `--rubric "..."` | refine | Quality criteria for refinement |
| `--rubric-file F` | refine | Read rubric from file |
| `--continue` | refine | Resume previous refinement session |
| `--branch-from ID` | refine | Branch from a specific variant |
| `--tree` | refine | Show archive tree and exit |
| `--status` | refine | Show archive summary and exit |
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

## Ideas & use cases

### When Expeditor shines

**Code review from multiple angles.** Three agents look at the same diff — one hunts bugs, one checks security, one reviews style. Synthesis combines findings and deduplicates. Catches things a single reviewer misses.

**"Which approach is better?"** Race two implementations in parallel worktrees. A judge picks the winner based on your criteria. You get both branches to compare, not just one person's opinion.

**Research with synthesis.** Fan out agents to investigate a topic from different angles (literature, practical examples, contrarian view). Synthesis agent reads all findings and produces a balanced summary with citations.

**Iterating until it's actually good.** Review loop runs work → review → gate → iterate. Different models catch different things. Claude writes, Codex reviews (or vice versa). Stops when the reviewer says DONE.

**Permission discovery.** Don't guess what 500 tool patterns your agents need. Run them, see what gets denied, approve what makes sense, sync to settings. Your permission config grows from real usage.

**Headless CI/CD agents.** Spawn agents in CI pipelines. The sandbox system means agents run in default (tight) permission mode with only the tools they need. No `dangerously-skip-permissions`. Webhook notifications alert Slack when agents finish.

**Task-driven development.** Write tasks in TASKS.md, run `expo mxit TASKS.md --parallel`. Agents claim tasks, work them, mark done, cascade to newly-ready tasks. You review the results.

### Recipes

**Quick code review of your last commit:**
```bash
expo workflow workflows/templates/code-review.md --timeout 120
```

**Compare two refactoring approaches:**
```bash
expo race \
  "Refactor auth using middleware pattern" \
  vs \
  "Refactor auth using decorator pattern" \
  --criteria "readability, testability, minimal changes"
```

**Research a topic before building:**
```bash
# Edit workflows/templates/research.md — replace [topic] with your topic
expo workflow workflows/templates/research.md --budget 3
```

**Cross-model adversarial review:**
```bash
expo review "implement rate limiting for the API" \
  --work-agent claude --review-agent codex --max 3
```

**Discover permissions organically:**
```bash
expo spawn "set up the CI pipeline" --sandbox research --no-worktree
# → sees what's denied
expo permissions approve "Bash(git:*)" --auto-sync
# → next run works without that denial
```

**Monitor everything from one place:**
```bash
expo serve
# Open http://localhost:3000
# Launch agents from the Launch tab
# Watch them work on the Live tab
# Review costs on the Costs tab
```

### Future ideas

- **`expo diff`** — side-by-side comparison of race branch outputs
- **`expo replay`** — re-run a past session with different settings or agent type
- **`expo doctor`** — diagnose setup issues (agents on PATH, permissions, disk)
- **Workflow chaining** — output of one workflow feeds into the next
- **Export** — render a run as a shareable standalone HTML report

## Design docs

- `TASKS-DESIGN.md` — mission, architecture, goals, decisions
- `.reduce/subagent-signal-bus.md` — original deep dive on the signal bus concept
- `.reduce/harness-controlled-sandbox.md` — permission system design + empirical findings
- `.reduce/workflow-driven-research.md` — workflow architecture

## License

MIT
