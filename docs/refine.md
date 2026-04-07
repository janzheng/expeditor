# expo refine — Archive-Based Refinement

Iterative improvement loop with snapshot/restore and cross-session learning. Inspired by [Hyperagents](https://arxiv.org/abs/2603.19461) (DGM-H).

## How it works

```
expo refine <dir>
  │
  ├── 1. Init snapshot tracking (.refine/)
  ├── 2. Snapshot baseline
  │
  ├── LOOP:
  │   ├── 3. Spawn agent with rubric + REFINE.md heuristics + archive context
  │   ├── 4. Agent makes ONE focused change
  │   ├── 5. Agent judges: KEEP, DISCARD, or CONVERGED
  │   ├── 6. Expo snapshots (keep) or restores (discard)
  │   ├── 7. On 3 consecutive discards → branch to under-explored variant
  │   └── 8. Repeat until converged / exhausted / max iterations
  │
  └── 9. Agent updates REFINE.md with session log + heuristics
```

**Expo owns the loop. The agent does one iteration at a time.** The agent doesn't know about snapshots or the archive — it just makes a change, judges it, and reports a verdict. Expo handles all the infrastructure.

## Quick start

```bash
# Refine a directory with a rubric
expo refine ./src --rubric "clarity, brevity, no dead code" --max 5

# Use a detailed rubric file
expo refine ./src --rubric-file RUBRIC.md

# Continue a previous session
expo refine ./src --continue

# See what's in the archive
expo refine ./src --tree
expo refine ./src --status
```

## The verdict protocol

The agent must output a verdict block at the end of its response:

```
VERDICT: KEEP|DISCARD|CONVERGED
CHANGE: short description of what changed
SUMMARY: why it was kept/discarded, or why the project has converged
```

- **KEEP** — the change improved things. Expo snapshots the current state.
- **DISCARD** — the change didn't help or made things worse. Expo restores from the last kept snapshot.
- **CONVERGED** — the project meets the rubric. Loop ends.

If the agent doesn't output a parseable verdict, expo defaults to DISCARD (safe fallback).

## Branching

When the agent discards 3 times in a row on the same lineage, expo branches to a different variant in the archive:

```
000 baseline
├── 001 kept — extracted helpers
│   ├── 002 kept — simplified errors
│   ├── 003 discarded — over-abstracted
│   ├── 004 discarded — wrong approach
│   └── 005 discarded — still wrong     ← 3 discards, plateau!
│
│   expo branches to 000 (fewest children, promising summary)
│
└── 006 kept — completely different approach (branched from 000)
```

The branching heuristic picks the kept variant with the fewest children — the least-explored promising path. If all variants are exhausted (all have 3+ children and discards), the loop stops.

## REFINE.md — cross-session learning

`REFINE.md` lives in the project root and accumulates refinement knowledge across sessions. The agent reads it before starting and updates it after finishing.

```markdown
# REFINE.md

## Strategy
How to approach refinement in this project.

## Heuristics
- **2026-03-25 / skill cleanup** — Shorter prompts win unless they drop a concept
- **2026-03-24 / API errors** — Tests need --experimental flag

## What worked
- Breaking monolithic functions into pipeline steps

## What didn't work
- Reordering sections without changing content (tried 3x)

## Session log
### 2026-03-25 — skill cleanup
- Target: SKILL.md
- Iterations: 8 (5 kept, 3 discarded)
- Net result: 30% shorter, clearer phase transitions
```

The autorefine skill (which can run as the agent inside `expo refine`) manages the progressive interview — first session asks all the questions, subsequent sessions get shorter as REFINE.md accumulates answers.

**REFINE.md is not MEMORY.md.** It's owned by the refinement process, not the agent's memory system. It works with any agent or orchestrator.

## Snapshot layer

`expo refine` uses `@snapshot/core` (`apps/snapshot/`) for all file operations:

- **Git repos** → tagged commits in the project's own repo (`refine/000`, `refine/001`, ...)
- **Plain folders** → hidden git repo in `.refine/.git`, files rsynced in/out

The agent never touches snapshots directly. Expo calls `snapshot()`, `restore()`, `branch()`, `discard()` based on the verdict.

Common junk is excluded automatically (node_modules, dist, .cache, venv, etc.).

## Architecture

```
expo refine
  │
  ├── @snapshot/core          Snapshot/restore/branch (git-based)
  │   ├── .refine/manifest.json   Archive metadata
  │   └── .refine/.git/           Hidden git (plain folders)
  │
  ├── Signal bus               Verdict events logged to JSONL + dashboard
  │
  ├── Agent (spawned per iteration)
  │   ├── Reads: rubric, REFINE.md, archive context
  │   ├── Does: ONE focused change + judgment
  │   └── Outputs: VERDICT block
  │
  └── REFINE.md               Cross-session learning (agent-managed)
```

## Flags

| Flag | Description |
|------|-------------|
| `--rubric "..."` | Inline quality criteria |
| `--rubric-file F` | Read rubric from file |
| `--max N` | Iteration limit (default 10) |
| `--continue` | Resume a previous session |
| `--branch-from ID` | Start from a specific variant |
| `--interactive` | Human approves between iterations |
| `--agent TYPE` | Agent type (claude, codex, etc.) |
| `--timeout N` | Seconds per iteration |
| `--tree` | Show archive tree and exit |
| `--status` | Show archive summary and exit |

## Comparison to other expo patterns

| | refine | review | race |
|---|---|---|---|
| Goal | Iterative improvement | Quality gate | Pick best approach |
| Iterations | Many (default 10) | Few (default 3) | 1 round |
| Snapshots | Every iteration | Not yet (planned) | Not yet (planned) |
| Branching | On plateau | No | No |
| Cross-session | REFINE.md | No | No |
| Best for | Skills, docs, config, small code | Code quality gates | Comparing strategies |

## Design origins

This system is inspired by [Hyperagents (DGM-H)](https://arxiv.org/abs/2603.19461) — self-referential self-improving agents from Meta/FAIR. Their key insight: if the improvement mechanism itself is editable, the system can get better at getting better.

We simplified their approach:
- No Docker containers — git snapshots instead
- No numeric scores — descriptions only (LLM scores are theater)
- No population-based evolution — simple "branch from least-explored" heuristic
- No self-modifying code — REFINE.md accumulates strategy as prose

The result is the same loop (modify → evaluate → keep/discard → branch on plateau) but practical for real projects.

Full design specs: `github-repos/research/hyperagents/_workshop/expo-local-worktrees.md` and `github-repos/research/hyperagents/_workshop/refine-md-spec.md`
