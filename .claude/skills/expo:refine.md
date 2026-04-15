---
description: "Run `expo refine` — the archive-based refinement loop. Use when the user says 'refine this project', 'iterate on X', 'run refine', 'improve against a rubric', 'DGM loop', or wants autonomous iteration with snapshot rollback. Also covers the `--verdict-mcp` flag for structured verdict submission via MCP tool call."
user_invocable: true
---

# expo refine — Archive-Based Refinement Loop

`expo refine <dir>` runs an iterative improvement loop against a rubric. Each iteration: spawn agent → snapshot or roll back based on verdict → repeat until converged, exhausted, or max iterations. Inspired by DGM-H / Hyperagents.

Gate ratchet catches silent regressions; scope constraints stop the agent touching files outside its remit; every kept variant is preserved in the archive tree so you can diff, branch, or manually promote.

## Quickstart

```bash
expo refine <dir> --rubric-file RUBRIC.md --auto --max 10
```

- `<dir>` — the project being refined (usually a git repo, not required)
- `--rubric-file` — the quality criteria the agent iterates against
- `--auto` — auto-seed gates + rubric hints from project signals (deno.json / package.json / Cargo.toml / pyproject.toml / Makefile). Explicit `--rubric` / `--gate` still win.
- `--max N` — iteration cap (default 10)

Inspect afterwards:

```bash
expo refine <dir> --tree        # archive tree
expo refine <dir> --status      # summary + disk usage
expo refine <dir> --tree --json # machine-readable for orchestrators
expo refine <dir> heuristics    # cross-session REFINE.md
```

## Verdict submission: prose vs MCP tool

The loop needs to know after each iteration whether the agent wants to KEEP, DISCARD, or CONVERGED. Two paths:

### Default: prose `<verdict>` block

Agent ends its response with:

````
<verdict>
{ "action": "keep", "change": "…", "summary": "…" }
</verdict>
````

Claude CLI agents skip this block in 40–80% of iters (Finding #17). The loop has a 5-layer recovery cascade (fenced → legacy-line → prose inference → default-keep-if-safe → extraction-retry) so work is almost never destroyed, but the retry layer costs ~$0.10–$0.15 per iter.

### Preferred: `--verdict-mcp`

```bash
expo refine <dir> --rubric-file RUBRIC.md --verdict-mcp
```

Wires up an MCP stdio server (dispatched via the `expo __refine-mcp-server` hidden subcommand — works from both source and compiled binary) with one tool: `mcp__expo_refine__submit_verdict`. The tool is pre-approved via `--allowedTools` so the agent doesn't hit a permission prompt on first call. The loop reads the verdict directly from the tool call (Layer 0 — structural, highest confidence).

Validated live 2026-04-14 on a toy smoke repo: 2/2 iters hit Layer 0, `refineParseMethod: mcp-tool`, no prose fallback needed.

**When to use it:**
- Running on the claude adapter (other adapters ignore `--mcp-config` silently; the flag no-ops with a yellow banner warning)
- You want clean telemetry — `refineParseMethod` on the bus signal distinguishes `mcp-tool` from the fallback layers
- Long unattended runs where extraction-retry tax adds up

**How to verify it fired:**

```bash
expo refine <dir> --event-file /tmp/run.jsonl --verdict-mcp
# After run:
grep refine_verdict /tmp/run.jsonl | head
#   → look for "refineParseMethod": "mcp-tool"
```

Per-iteration verdict files accumulate under `<dir>/.refine/inbox/verdict-iter-N.json` for post-mortem. They're not auto-cleaned — remove by hand when the dir gets noisy.

## Common invocations

### Narrow the search space

```bash
expo refine <dir> \
  --rubric-file RUBRIC.md \
  --scope "src/**" "tests/**" \
  --gate "test=deno task test" \
  --gate "types=deno check --all" \
  --max 8
```

Scope is a HARD constraint — any iteration that touches a file outside the patterns is force-discarded before the rubric judgment even runs. Gates run after a keep verdict; any non-zero exit forces a discard.

### Long unattended run with budget caps

```bash
expo refine <dir> \
  --auto --rubric-file RUBRIC.md \
  --per-agent-budget 3 --total-budget 30 \
  --run-timeout 3600 \
  --verdict-mcp \
  --event-file /tmp/refine.jsonl
```

Wall-clock cap hits between iterations; per-agent-budget kills an agent that overruns mid-iteration; event file gives you a live tail.

### Pre-flight gate check before burning budget

```bash
expo refine <dir> gate check
```

Runs every inherited gate once against current baseline. Exits 0 if all pass, 1 if any fail. Useful before a long run: a broken baseline gate silently force-discards every iteration (Finding #13).

## Exit codes

- `0` — CONVERGED (rubric satisfied)
- `1` — MAX_ITERATIONS / EXHAUSTED / WALL_CLOCK_EXCEEDED / INFRA_FAILURE (see stderr banner)
- `4` — stale-baseline (working tree diverged from last-kept snapshot; use `--force-stale-baseline` to override)
- `5` — baseline-gate check failed (a seeded gate fails on current baseline; use `--skip-baseline-check` for TDD red-to-green)
- `6` — concurrency heartbeat conflict (another refine/snapshot is mid-flight on this dir; use `--force-stale-heartbeat` if the prior crashed)

## Rubric files — what works

Keep rubrics small and file-path-specific. Agents do better with 3–5 concrete criteria pinned to specific paths than with abstract quality goals. Include an explicit "out of scope" section — it dramatically reduces scope violations.

Examples of rubrics that shipped in `snapshot/.expo/output/cycle-rubric-{A,B,C}.md`.

## When NOT to use refine

- No gates, no tests, pure knowledge garden (markdown notes) → refine becomes a "gambling run" with no invariant ratchet. Use `expo workflow` instead to get one synthesis output without the loop.
- Single change you can describe in one prompt → use `expo spawn`, not refine.
- Comparing two approaches → use `expo race` — parallel + judge, no loop.

## See also

- `expo refine <dir> --tree` — the archive
- `REFINE.md` in the refined dir — cross-session heuristics the loop wrote
- `.expo/logs/bus-*.jsonl` — raw signal log for any run
- `expo` skill — the other expo commands (race, review, workflow, mxit, spawn)
