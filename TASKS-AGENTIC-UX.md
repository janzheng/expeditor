# Agentic UX Improvements

Wishlist compiled 2026-04-12 during the gate-ratchet ship + self-playtest session. Lens: **expo is a tool for LLM agents, not for humans watching a terminal.** Every item here is friction I hit driving expo unattended or orchestrating it from another agent.

Pairs with TASKS-AUDIT.md (speed + security findings from the automated audit) — that file is generated; this one is the narrative wishlist.

## Output for agents

- [ ] Structured JSON output for refine results #agentic-ux #output
  - [*] Add `--json` flag to `expo refine` that emits the final summary as one JSON object on stdout (nothing else)
  - [*] Shape: `{verdict, iterations, kept, discarded, gateFailures, gatesProposed, finalVariantId, costUsd, perIteration: [{iter, action, change, summary, gateFailed?, cost}]}`
  - [*] Consumers: external agents driving expo, CI, the dashboard
  - [*] Optional `--event-file PATH` writes JSONL one line per bus event for live consumption

- [ ] Token-efficient formats for CLI output (TOON-style) #agentic-ux #output #toon
  - [*] `gate list`, `--tree`, `--status` render pretty text tables
  - [*] Add `--format=compact|toon|json` flag across these verbs
  - [*] Directly inspired by AXI principle 1 (token-efficient output). See `github-repos/axi/notes.md`
  - [*] Not strictly required right now — measure actual context usage first

- [ ] Expose REFINE.md heuristics to orchestrating agents #agentic-ux
  - [*] REFINE.md is read into the spawned agent's prompt but invisible externally
  - [*] Add `expo refine <dir> heuristics` subcommand that prints the file + parsed sections
  - [*] Include path + last-updated in `--json` status output

## Verification tools

- [ ] `gate check` subcommand — run inherited gates without a full refine loop #agentic-ux #gates
  - [*] `expo refine <dir> gate check [variant_id]` runs all inherited gates against current state
  - [*] Reports per-gate pass/fail with exit code 0 (all pass) / 1 (any fail)
  - [*] Eliminates the "trust fall" before firing a 5-minute loop that depends on them
  - [*] Doubles as CI primitive: gate check in a pre-commit hook

- [ ] Pass gate-failure context into next iteration's prompt #feedback #gates
  - [*] Currently: gate discards a variant → next agent has no memory of why → may propose same change
  - [*] Feed last N gate-failure reasons into the next prompt under "Do not repeat these failed approaches"
  - [*] Compound-discount wasted spend on obviously-doomed iterations

- [ ] Verdict parser: fenced-block grammar #agentic-ux #parsing
  - [*] `parseVerdict` scans lines for `VERDICT: ...` — fragile if the agent echoes the format in prose
  - [*] Currently "works" because last-match wins, but one bad explain-the-format output could misdirect
  - [*] Change to require `<verdict>{"action":"keep",...}</verdict>` XML block with JSON payload
  - [*] Side benefit: structured child fields naturally (gate_proposals array, optional fields)

## Wall-clock safety

- [ ] Per-run wall-clock timeout #safety #resilience
  - [*] `--timeout N` is per-iteration (per-agent), not per-run
  - [*] Add `--run-timeout N` that hard-caps total refine duration
  - [*] On hit: return verdict `WALL_CLOCK_EXCEEDED`, attempt graceful updateRefineMd, then exit

- [ ] Verify cost-guard actually kills vs just logs #security #budget
  - [*] Self-playtest showed `[cost-guard] selfplay-iter-3: $0.7684 exceeds per-agent budget $0.75`
  - [*] Iteration 3 STILL completed and got kept — so budget guard is advisory, not enforcing
  - [*] Needs: explicit "budget exceeded → stop/fail" path with distinct exit code, test for it

- [ ] Resumability after a crashed or killed run #agentic-ux #resilience
  - [*] If refine dies mid-iteration (network, pkill, deno panic), what survives?
  - [*] HEAD tracking means next snapshot will parent correctly — good baseline
  - [*] Untested: does `expo refine .` on a dir with an existing `.refine/` pick up cleanly?
  - [*] Possibly persist per-iteration in-flight state to `.refine/inflight.json`

## Discovery / zero-config

- [ ] `expo refine <dir> --auto` — zero-config discovery mode #agentic-ux #discover
  - [*] Inspired by evo's `/discover` command. See `github-repos/evo/notes.md`
  - [*] Reads `deno.json` / `package.json` / `pyproject.toml` for test commands
  - [*] Seeds default gates from existing test infrastructure (`deno task test`, `npm test`, `pytest -x`)
  - [*] Generates a default rubric from repo signals (README, recent commits, TODO comments)
  - [*] Reduces setup from 6 flags to 0 when the tool has sensible defaults

- [ ] Agent-in-loop approval (non-TTY) #agentic-ux
  - [*] `--interactive` reads stdin — assumes a human at terminal
  - [*] Need programmatic version: POST verdict to callback URL OR wait on named pipe
  - [*] Enables oversight agents approving individual variants between iterations
  - [*] Pairs naturally with a `fold` orchestrator driving multiple expo runs

## Discovered during this session (2026-04-12)

- [!] `@snapshot/core` snapshot() does `git add -A` — scoops uncommitted work into refine/NNN commits #bug #snapshot
  - [*] Symptom: during the audit-fix session, three of my direct-implementation edits (web.ts auth, notify.ts SSRF, cli.ts IPv6 fix) got bundled into `refine/004`, `refine/006`, `refine/007` alongside the agent's own changes. Provenance lost.
  - [*] Trigger: any parallel editor working in the repo while `expo refine` is running with the `project-git` backend.
  - [*] Fix: snapshot should stage only files that were actually modified between iterations (compare mtime/content against HEAD), or document the sole-writer contract and error out on unexpected changes.
  - [*] Located at `apps/snapshot/src/snapshot.ts` in the `snapshot()` function, `git add -A` call.

## Notes and connections

- The `gate check` and wall-clock timeout items unblock "unattended overnight" use cases. Without them, refine is only trustworthy for watched short runs.
- The verdict-parser fix is prerequisite for passing structured data between iterations (gate failure context, etc.). Do it before the feedback loop.
- `--auto` is a big lift but one of the highest-leverage items — turns "learn 6 flags" into "point and shoot" for every repo.
- All items above are things I noticed *as an agent driving expo*. If these ship, the next expo self-playtest should be able to do meaningfully more on less setup.
