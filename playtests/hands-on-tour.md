# Expo — Hands-On Tour

Walk through every feature. Copy-paste the commands, see what happens. This is you experiencing the system, not automated verification.

**Time estimate:** ~10 minutes, ~$1 in API calls

**Prerequisites:** `claude` and `codex` on PATH, working API keys for both.

## 1. Single agent — does it work? (risk: none)

```bash
deno task expo spawn "Say exactly: hands-on tour single-agent OK" --name tour-1-single --no-worktree
```

- [ ] Agent spawns and you see `● spawned`
- [ ] Output shows "hands-on tour single-agent OK"
- [ ] You see `✅ done` with duration and cost
- [ ] Session ID is shown for resume

```bash
deno task expo status
```

- [ ] Registry shows `tour-1-single` as done with session ID

```bash
deno task expo cleanup --all
```

- [ ] Agent removed from registry

## 2. Codex agent (risk: none)

```bash
deno task expo spawn "What is 3+3? One word." --name tour-2-codex --agent codex --no-worktree
```

- [ ] Spawns with `(codex)` in the header
- [ ] Output shows "Six" (or similar)
- [ ] Shows `✅ done` with cost
- [ ] Shows `codex resume --last` for resume

```bash
deno task expo cleanup --all
```

## 3. Parallel agents (risk: none)

Task definitions live in this folder (`playtests/parallel-tasks.json`). From the repo root:

```bash
deno task expo spawn-all playtests/parallel-tasks.json
```

- [ ] All 3 agents spawn (you see 3 `● spawned` lines)
- [ ] Signals are interleaved (agents run in parallel)
- [ ] All 3 show `✅ done`
- [ ] Results section shows all 3 with session IDs

```bash
deno task expo status
```

- [ ] All 3 agents (`tour-par-a`, `tour-par-b`, `tour-par-c`) in registry

```bash
deno task expo cleanup --all
```

## 4. Resume a session (risk: none)

```bash
deno task expo spawn "Remember this word: mango. Say OK." --name tour-resume --no-worktree
```

- [ ] Agent says OK (might also try to save to memory — that's fine)

```bash
# Get the agent ID from status
deno task expo status
```

Now resume headlessly and ask for the word back:

```bash
deno task expo resume tour-resume --headless "What word did I tell you to remember?"
```

- [ ] Response includes "mango"
- [ ] This proves session context persists across resume

```bash
deno task expo cleanup --all
```

## 5. Cross-model review — the big one (risk: none)

Codex writes code, Claude reviews it:

```bash
deno task expo review "Write a Python function that reverses a linked list. Just the code." \
  --work-agent codex --review-agent claude --max 1 --name tour-cross-model
```

- [ ] Header shows `(cross-model: codex → claude)`
- [ ] Work agent (codex) writes code
- [ ] Review agent (claude) analyzes and critiques it
- [ ] Verdict shown (DONE or ITERATE)
- [ ] Total cost across both agents shown

```bash
deno task expo cleanup --all
rm -f bus-*.jsonl
```

## 6. TUI dashboard (risk: none)

First generate a bus file with parallel agents (`playtests/tui-tasks.json`):

```bash
deno task expo spawn-all playtests/tui-tasks.json
```

Now view the bus file in the TUI:

```bash
deno task tui bus-*.jsonl
```

- [ ] Cards render with colored borders (green for done, red for failed)
- [ ] Each card shows agent name, model, tool calls with ✓/✗
- [ ] Cost and token count shown per card
- [ ] Header shows total agent count and cost

```bash
deno task watch bus-*.jsonl --summary
```

- [ ] Summary shows per-agent stats
- [ ] Total cost across all agents

```bash
deno task expo cleanup --all
rm -f bus-*.jsonl
```

## 7. Race — two approaches, pick winner (risk: none)

```bash
deno task expo race \
  "Name 3 fruits that start with P" \
  vs \
  "Name 3 vegetables that start with C" \
  --criteria "which list would make a better salad" \
  --name tour-race
```

- [ ] Both branches spawn and run in parallel
- [ ] A judge agent compares them
- [ ] Winner declared with reasoning
- [ ] Total cost shown

```bash
deno task expo cleanup --all
rm -f bus-*.jsonl
```

## 8. Ralph — task progression (risk: none)

```bash
deno task expo ralph \
  "Pick a random color and say it" \
  "If you've seen at least 2 colors mentioned, say DONE. Otherwise say NEXT." \
  --max 3 --name tour-ralph
```

- [ ] Tasks run sequentially (task-1, gate-1, task-2, gate-2, etc.)
- [ ] Gate decides NEXT or DONE based on output
- [ ] Stops when gate says DONE (or hits max)
- [ ] Total tasks completed and cost shown

```bash
deno task expo cleanup --all
rm -f bus-*.jsonl
```

## Final cleanup

```bash
deno task expo cleanup --all
rm -f bus-*.jsonl
```

---

## What to look for

Beyond "does it work," notice:
- **How fast do parallel agents start?** All at once, or staggered?
- **Are signals interleaved?** You should see output from different agents mixed together
- **Does resume actually remember?** The mango test proves session persistence
- **Cross-model: do they catch different things?** Claude reviewing Codex's code should find issues a same-model review might miss
- **Cost:** Are you comfortable with the per-agent costs? The review loop runs 2+ agents per iteration
