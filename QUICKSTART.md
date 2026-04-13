# Expo Quickstart — pointing it at a real repo

This is the "I've read the README, now what?" guide. Opinionated. Written after
~90 minutes of self-playtest on expo's own codebase and another ~3 hours of
feature-building sessions; read it as "here's what worked" rather than a spec.

## The 30-second version

```bash
# Install
cd apps/expo && deno task install    # `expo` → ~/.deno/bin/

# First run on a new repo — keep blast radius small
cd /path/to/target/repo
expo refine . --auto --max 3 --run-timeout 900 --scope "src/**"

# Drive from another agent / CI — structured I/O everywhere
expo refine . --json --event-file /tmp/run.jsonl --approval-hook ./review.sh
```

`--auto` reads your repo's build files and seeds sensible gates + rubric.
`--max 3 --run-timeout 900` caps iterations AND wall clock.
`--scope "src/**"` prevents the agent from touching config/CI/README.

## Three-step first-run recipe

### 1. Discover what `--auto` would do (no tokens spent yet)

```bash
expo refine . --auto --max 0 2>&1 | head -30
```

You'll see what project type was detected and which gates would seed. If it
picked wrong (e.g. `deno task test` on a repo whose tests need a DB running),
fix it now:

```bash
# Manual gate with a better command
expo refine . --gate "tests=make test-ci"
```

Or write a `gates.json` alongside your repo:

```json
[
  { "name": "tests",     "command": "pytest -x",          "timeoutMs": 120000 },
  { "name": "typecheck", "command": "mypy src/",          "rationale": "regression hot spot" },
  { "name": "lint",      "command": "ruff check",         "timeoutSec": 30 }
]
```

```bash
expo refine . --gate-file gates.json --max 3
```

### 2. Sanity-check gates before spending tokens

```bash
expo refine . --gate-file gates.json
# then in another terminal or after the baseline snapshot:
expo refine . gate check
```

`gate check` runs every inherited gate against the current state, reports
per-gate pass/fail with timings. If anything fails BEFORE refine fires any
agent, you've already saved $1–5.

### 3. Run the short one

```bash
expo refine . \
  --rubric "improve error messages where user-visible behavior is unclear" \
  --gate-file gates.json \
  --scope "src/**" \
  --max 3 \
  --run-timeout 900 \
  --per-agent-budget 2 \
  --total-budget 6
```

3 iterations, 15-min wall clock, $6 total cap, can only touch `src/**`.
Worst case: $6 and 15 minutes. Best case: three focused improvements,
each gate-verified and snapshotted.

## What you can trust

| Guardrail                    | What it protects                                        |
| ---------------------------- | ------------------------------------------------------- |
| `costGuard`                  | Per-agent + total $ limits; kills agents on overrun     |
| `--scope`                    | Force-discards iterations that touch out-of-bounds paths |
| `--run-timeout`              | Hard wall-clock cap; stops between iterations           |
| `--timeout`                  | Per-agent timeout (kills process group via setsid)       |
| Gate ratchet                 | Inherited invariants force-discard regressing iterations |
| Snapshot rollback            | Discards reset working tree; no partial state           |
| `.refine/inflight.json`      | Crash-resume preserves budget + iteration counter        |
| `--max-tool-calls`           | Thrashing protection (agent loops → killed)              |
| `--max-turns`                | Conversation-length cap                                  |

## What might still bite

1. **`--auto` picks the wrong gate.** E.g. seeds `deno task test` on a repo
   where tests need env setup. Mitigation: run `gate check` first.
2. **Rubric-driven discards don't feed the next prompt.** Only gate failures
   populate the "do not repeat" memory ring. If the agent keeps failing the
   rubric the same way, you'll see the same proposal iteration after iteration.
   Workaround: update `--rubric` between runs with the specific anti-pattern.
3. **We haven't stress-tested unattended multi-hour runs.** The longest dogfood
   session was ~90 min. Some long-tail failure almost certainly lurks past that
   — which is why `--run-timeout` is your friend.
4. **Agent prompt was tuned on expo's own repo.** It may subtly assume ts/deno
   conventions. Rewrite `--rubric` with project-specific phrasing on your first
   run.
5. **No dry-run mode.** You find out what `--auto` seeded by running it.

## Scaling up (once the short run looks sensible)

| Loosening                      | When                                                 |
| ------------------------------ | ---------------------------------------------------- |
| `--max 10` → `--max 25`        | After 2–3 short runs land cleanly                    |
| Drop `--scope`                 | Only after you trust rubric to keep agent focused    |
| Remove `--approval-hook`       | After verdicts consistently match your judgement     |
| Enable `--allow-agent-gates`   | When you want emergent invariants (promotion ratchet) |
| Raise `--total-budget`         | Pair with `--run-timeout` so a stuck loop can't bleed |

## Driving from another agent / CI

The orchestrator-friendly flags:

```bash
# One JSON object on stdout; JSONL bus events to file; exit 0 on CONVERGED
expo refine . \
  --auto --max 5 --run-timeout 1800 \
  --json \
  --event-file /tmp/refine-$(date +%s).jsonl \
  --approval-hook ./my-review.sh

echo "exit: $?"
# 0 = converged, 1 = exhausted/max-iterations/wall-clock-exceeded
```

Your `review.sh` can be anything from `cat > /dev/null; echo accept` (rubber-
stamp) to a curl to Slack with thumbs-up/down reactions. It receives the
verdict as JSON on stdin, returns an action on stdout.

Read REFINE.md between runs:
```bash
expo refine . heuristics --json | jq '.sections.Heuristics'
```

## When to reach for which command

```
expo refine <dir>       Iterative improvement against a rubric
expo mxit <TASKS.md>    Work through a checklist (parallel or sequential)
expo race "A" vs "B"    Two approaches, judge picks winner
expo workflow <file>    Multi-stage DAG: fan-out → synthesis
expo review <prompt>    Work agent + review agent ping-pong
expo spawn <prompt>     One-shot; bus log + cost tracking
```

A common pattern:

1. **Discuss** the design with a full-context agent (Claude Code / yourself).
2. **Break down** into a `TASKS.md` with per-task definition-of-done.
3. **Execute** with `expo mxit TASKS.md --parallel` — each task is an
   independent agent with its own budget + gate.
4. **Iterate** on anything unclear with `expo refine <dir>` scoped to just
   that feature's files.

Refine is for "I don't know the exact shape of the answer."
Mxit is for "I have a checklist."
Race is for "which of these two approaches is better?"

## A real first-run session

```bash
cd ~/projects/my-cool-lib

# Step 1: see what --auto would seed
$ expo refine . --auto --max 0 2>&1 | head -10
Auto-discovery (deno):
  • deno.json has tasks.test → seeded "deno_test" gate

# Step 2: gate check
$ expo refine . --auto gate check
Checking 1 gate against [(no snapshots)]:
No gates visible to variant [(no snapshots)].

# (run baseline snapshot first — any short refine bootstraps one)
$ expo refine . --auto --max 1 --rubric "fix any TODO comments"

# Step 3: gate check now that we have a baseline
$ expo refine . gate check
Checking 1 gate against [001]:
  ✓ deno_test   482ms
All 1 gate passes.

# Step 4: real run
$ expo refine . \
    --rubric "improve error messages; small focused changes" \
    --scope "src/**" \
    --max 5 --run-timeout 1200 \
    --total-budget 8
```

## Troubleshooting

**"`expo refine` did 5 iterations and kept everything, cost $7, but the
changes are weird."**
→ Your rubric was too loose. LLMs will accept almost anything as an
"improvement" absent specificity. Try `--rubric-file RUBRIC.md` with examples
of what you DO and DON'T want.

**"The agent keeps proposing the same change that fails the gate."**
→ The feedback ring captures gate failures but bounded to 3. If the pattern
persists, add an explicit "do not try X" paragraph to `--rubric`. This is
also a signal that the gate is right but the rubric is underspecified.

**"Every iteration gets discarded for scope violations."**
→ Your `--scope` globs are too tight. Run `expo refine . --tree` after a
run to see which paths the agent touched; adjust globs accordingly.

**"Cost-guard killed a run I wanted to finish."**
→ Per-agent budget defaults to $2, total to $20. Raise with
`--per-agent-budget 5 --total-budget 50` for ambitious runs. Pair with
`--run-timeout` so an overshoot doesn't run indefinitely.

**"Dashboard shows the wrong bearer token after `expo serve` restart."**
→ The token is generated fresh each startup. Clear localStorage in your
browser (the `expo-auth-token` key), refresh, paste the new token from
`expo serve`'s output.

## The ideal that isn't quite here yet

> "Kick it off Friday, review Monday."

Close. The budget/wall-clock/scope guardrails make this *technically* safe
for bounded runs. But we haven't run expo unattended for 72 hours on an
unfamiliar codebase. Before that's a responsible default: another session
or two of real-world shakedown. For now, the shipping-honest advice is to
*bound the run*, not *bound-and-walk-away*.

Today's best approximation:

```bash
# Overnight iterative refinement, capped
nohup expo refine . \
  --auto --allow-agent-gates \
  --max 20 \
  --run-timeout 28800 \
  --total-budget 100 \
  --scope "src/**" "tests/**" \
  --event-file /tmp/overnight.jsonl \
  > /tmp/overnight.log 2>&1 &

# Tail from anywhere
tail -f /tmp/overnight.jsonl | jq .
```

8-hour cap, $100 ceiling, scoped to code + tests, event log for
post-mortem. Worst case: $100 and one night. Review in the morning with
`expo refine . --tree` and `git log main..HEAD`.
