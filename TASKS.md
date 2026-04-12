# Expeditor — Tasks

Multi-agent orchestration with a signal bus. CLI command: `expo`. See [TASKS-DESIGN.md](TASKS-DESIGN.md) for why/how.

**Status:** Feature complete. 18 source files, ~6,000 lines. 29 tests + 5 snapshot tests. 5 agent types. Permission ledger. Domain filtering. Multi-agent sandbox. Web dashboard. Snapshot integration. Resilience guards.

**Run tests:** `bash tests/phase0/run-all.sh` (13 pass) · `bash tests/phase1-2/run-all.sh` (11 pass) · `bash tests/test-ledger-cycle.sh` (12 pass) · `bash tests/test-workflow-synthesis.sh` (5 pass) · `deno run --allow-all tests/test-domain-filter.ts` (5 pass) · `cd ../snapshot && deno task test` (5 pass)

**Completed work:** See [TASKS.done.md](TASKS.done.md) for Phase 0-5 archive.

## Current

All actionable work complete. 3 P3 items remain in design/question phase.

### Headless permissions — `--auto-approve` [shipped 2026-04-01]

- [x] [done: investigated Claude Code source — `--settings` allow lists and `--dangerously-skip-permissions` both blocked by org policy gate `tengu_disable_bypass_permissions_mode`] Investigate why sandbox presets don't work on restricted accounts `-> .brief/headless-permissions.md` #permissions
- [x] [done: `src/permission-mcp-server.ts` — minimal MCP stdio server, approves all requests with `{behavior:"allow",updatedInput}`] Build auto-approve MCP permission server #permissions
- [x] [done: `mcp-auto-approve.json` — mcpServers config pointing to server] MCP config for auto-approve server #permissions
- [x] [done: `SpawnOptions.permissionPromptTool/mcpConfig`, `spawner.setDefaults()`, merges into every spawn] Wire `--permission-prompt-tool` + `--mcp-config` into spawner, propagate via setDefaults #permissions
- [x] [done: `--auto-approve` on `expo spawn` calls `spawner.setDefaults()` so ALL agents including orchestrator subagents inherit it] Add `--auto-approve` CLI flag #permissions
- [x] [verified: 30 WebFetch ✓ headlessly, subagent Bash+Write ✓, stale ledger denials are from earlier failed runs] Verify end-to-end on restricted account #permissions

### Tier 2: History + Permissions UI + Costs #web-dashboard

- [x] [done: `/api/runs` + `/api/runs/:file`, `runs.html` with timeline drill-down] Run history page
  - [x] List runs by timestamp, agent count, total cost, file size
  - [x] Click a run to see full signal timeline with color-coded event types
- [x] [done: `/api/permissions` GET + `/api/permissions/approve|reject` POST, `permissions.html`] Permission ledger UI
  - [x] Shows pending/approved/rejected entries with examples and deny counts
  - [x] Approve/reject buttons POST to server, page reloads
  - [x] Status counts bar (N approved, N rejected, N pending)
- [x] [done: `/api/costs`, `costs.html` with bar chart + per-run breakdown table] Cost dashboard
  - [x] Grand total across all runs
  - [x] Bar chart of last 30 runs with hover tooltips
  - [x] Per-run table with per-agent cost breakdown

### Extras

- [x] [done: "Resume" button on cards copies `claude --resume <sessionId>` to clipboard] Resume sessions from dashboard
- [x] [done: `workflows/templates/` — code-review, research, refactor] Workflow templates
- [x] [done: `src/notify.ts` — Slack/Discord/generic, driven by EXPO_WEBHOOK_URL env var] Webhook notifications
- [x] [done: scrubber slider on runs detail, step through events] Session replay
- [x] [done: `src/web/launch.html` + POST /api/spawn, /api/race, /api/review] Launch agents from browser
- [x] [done: `expo init` — dirs, .gitignore, workflow templates] Project scaffolding
- [x] [done: running total in Live page nav bar] Live cost ticker

## `expo refine` — Archive-Based Refinement Loop #refine

Inspired by [Hyperagents](https://arxiv.org/abs/2603.19461) (DGM-H). Uses `@snapshot/core` (`apps/snapshot/`) for file snapshots and REFINE.md for cross-session learning. Autorefine skill handles judgment; expo handles orchestration.

Design specs: `github-repos/research/hyperagents/_workshop/expo-local-worktrees.md` and `github-repos/research/hyperagents/_workshop/refine-md-spec.md`

### Core loop

- [x] [done: `src/refine.ts` — full orchestration loop with snapshot/restore/branch] `expo refine <dir>` command — the main orchestration loop #refine
  - [x] Init snapshot for dir (`@snapshot/core`)
  - [x] Snapshot baseline on first run
  - [x] Spawn agent per iteration with: rubric, REFINE.md heuristics, archive context one-liner
  - [x] Receive agent verdict via signal bus (`{ action: "keep"|"discard", summary, change }`)
  - [x] On keep → `snapshot.snapshot(dir, { change, summary })`
  - [x] On discard → `snapshot.restore(dir, lastKeptId)` + `snapshot.discard(dir, { change, summary })`
  - [x] Track consecutive discards per lineage
  - [x] On 3 consecutive discards → branch from best under-explored variant (fewest children, promising summary)
  - [x] Stop when: all branches exhausted, iteration limit, or agent says converged
  - [x] At end: tell agent to update REFINE.md with session log + heuristics

### Arguments and options

- [x] `--rubric "clarity, brevity"` — inline rubric passed to agent #refine
- [x] `--rubric-file RUBRIC.md` — rubric from file #refine
- [x] `--continue` — resume a previous refine session (read manifest, pick up where we left off) #refine
- [x] `--branch-from <id>` — manually branch from a specific variant #refine
- [x] [done: prints verdict but stdin not yet wired] `--interactive` — human approves/rejects between iterations instead of agent judging #refine
- [x] `--max <N>` — iteration limit (default 10) #refine
- [x] `--tree` — show archive tree and exit #refine
- [x] `--status` — show archive summary + `.refine/` disk usage and exit #refine

### Signal bus integration

- [x] [done: emits as `progress` signal with `refineVerdict` payload fields] Define refine verdict event type in `types.ts` #refine
- [x] Agent emits verdict as structured signal (not just stdout parsing) #refine
- [x] Refine events appear in JSONL log + web dashboard like other orchestration patterns #refine

### Fixes from code review (2026-03-25)

- [x] [done: verified — spawner.ts:472 uses opts.cwd, passed to Deno.Command at line 496] Verify `spawnAndWait` respects `cwd` param #refine #bug
- [x] [done: added `du -sh .refine/` output to showRefineStatus] `--status` should show `.refine/` disk usage #refine
- [x] [done: added rule 5 to prompt — keep last 3 detailed, summarize older into one-liners] REFINE.md update prompt should mention session log capping #refine
- [x] [done: readStdinLine + accept/discard/converge/quit prompt] `--interactive` needs stdin wiring #refine

### Wire snapshot into existing patterns

- [x] [done: RaceOptions.snapshotDir — baseline before spawn, restore on all-fail, snapshot winner] `expo race` — snapshot before parallel agents, restore winner's state #snapshot
- [x] [done: ReviewLoopOptions.snapshotDir — baseline + pre-iteration snapshots, restore on ITERATE] `expo review` — snapshot before each review cycle, rollback on gate fail #snapshot
- [x] [done: MxitRunnerOptions.snapshotDir — pre-task snapshot, restore on fail/timeout, snapshot on success] `expo mxit` — snapshot before each task, restore on failure #snapshot

### Gate ratchet — invariant inheritance [shipped 2026-04-12] #refine

Per-variant gate commands that inherit down the archive tree. Prevents LLM-rubric-based refinement from silently regressing load-bearing behavior during long unattended sessions. Pattern sourced from evo (autonomous code optimizer).

Research context (in `/Users/janzheng/Desktop/Projects/__resources/github-repos/`):
- `evo/notes.md` — full evo research notes with architecture + mechanism breakdown
- `_workshop/gate-ratchet-pattern.md` — the pattern written up portably
- `evo/evo/src/evo/core.py:643` — reference `collect_gates_from_path` (~10 lines)

- [x] [done: see .brief/gate-ratchet.md for shipped details + smoke-test transcript] Gate ratchet for `expo refine` `-> .brief/gate-ratchet.md` #refine
  - [x] [done: `Gate` type + `gates?: Gate[]` field on Variant, exported from `@snapshot/core`] Extend `@snapshot/core` Variant schema with `gates: {name, command, addedAt, addedBy, rationale?}[]`
  - [x] [done: `apps/snapshot/src/snapshot.ts` — walks parent chain, dedupes by name, child overrides ancestor same-name] Add `collectGates(archive, variantId)`
  - [x] [done: `runInheritedGates` helper in `src/refine.ts`; runs gates before snapshot on KEEP, forces discard with `gate_failed:<name>` reason on any non-zero exit, falls through to 3-consecutive-discards branching logic] Wire into `src/refine.ts` accept path
  - [x] [done: opt-in via `--allow-agent-gates`; GATE_PROPOSAL: {...} JSON lines parsed by `parseVerdict`; attached to newly kept variant after successful snapshot] Teach the refine agent prompt to propose gates
  - [x] [done: `expo refine <dir> gate list [variant_id]` / `add <id> --name N --command C [--rationale R]` / `remove <id> --name N`] CLI: `expo refine gate list|add|remove <variant_id>`
  - [x] [done: `tree()` in `@snapshot/core` shows `[gates: N]` when present, skips when absent] Show gate counts in `--tree` output
  - [x] [done: emits `progress` signal with `gateFailed` / `gateAdded` payload fields] Emit gate events on the signal bus for dashboard surfacing
  - [x] [done: `--gate "name=command"` CLI flag seeds gates onto baseline; repeatable for multiple gates] Low-risk root-gate flag
  - [x] [done: unit tests `tests/test-refine-gates.ts` (24 passing) + `apps/snapshot/src/snapshot_test.ts` gate tests (7 new, all 12 pass); smoke-tested CLI end-to-end] Tests + smoke test
  - [x] [done: manifest now tracks `head` — set by restore(), read+advanced by snapshot(), read-only by discard(); 5 new tests; benefits race/review/mxit too since they all use snapshot/restore] Fix: `snapshot()` used to always parent off last-non-discarded regardless of restore, producing linear chains instead of trees

### Future gate-ratchet extensions #refine #future

- [?] Gate promotion — auto-move a gate up the tree when N descendants independently add the same-named gate
- [?] `--gate-file <path>` flag — load multiple gates from a YAML/JSON file for repeatable configurations
- [?] Dashboard gate UI — list gates per variant, show which inherited, manual add/remove from browser
- [?] Timeout per-gate (currently one global `--gate-timeout` for all gates)

## Agentic UX + Audit #agentic-ux

Lens: **expo as a tool LLM agents reach for, not just humans at a terminal.** Compiled 2026-04-12 after the gate-ratchet self-playtest.

- [*] Full wishlist with rationale + rough design sketches: `TASKS-AGENTIC-UX.md`
- [*] Findings from automated audit will land at `.brief/agentic-audit.md` (generated, not hand-written)

### Audit pass

- [x] [done: 16 verified findings — 3 P1, 10 P2, 3 P3 — in .brief/agentic-audit.md; $1.80, 23 turns, 288s] Run speed / security / agentic-UX audit on expo source `-> .brief/agentic-audit.md` #audit #agentic-ux
  - [*] Confirms several pre-existing open items from TASKS-AUDIT.md (A017 workflow silent success; A022 withTimeout kill gap) are still real
  - [*] Biggest new finding: `expo serve` P1 — unauthenticated POST /api/spawn binds 0.0.0.0, any browser tab can launch arbitrary commands

### Priority 1 — do first (from audit findings + unblock unattended runs)

Audit-driven P1s (see `.brief/agentic-audit.md`):

- [x] [fixed: src/web.ts + cli.ts — 127.0.0.1 default bind, random bearer token on mutating routes, constant-time compare, --host/--token/--no-auth flags. Verified end-to-end] `expo serve` has unauthenticated POST /api/spawn binding 0.0.0.0 `-> .brief/agentic-audit.md` #security #serve
- [x] [fixed by expo refine iter-004: src/workflow.ts now distinguishes "empty" status (exit 0, no output file) from real success, attaches structured reason, skips synthesis when all agents empty] `workflow` reports success when agent wrote nothing `-> .brief/agentic-audit.md` #workflow #silent-failure
- [x] [fixed: src/spawner.ts wraps agent launch with setsid (cached check); src/timeout.ts uses kill -SIG -pgid with per-pid fallback. Same pattern as runInheritedGates] `withTimeout` kills only leader PID, not process group `-> .brief/agentic-audit.md` #timeout #resource-leak

Audit-driven + wishlist P1s:

- [x] [fixed: src/orchestrator.ts costGuard now kills per-agent on overrun or all-running on total, emits structured BudgetExceededPayload; all 4 call sites updated to pass spawner] Verify cost-guard enforces (not just logs) + distinct exit code `-> .brief/agentic-audit.md` #security #budget
- [ ] `gate check` subcommand — verify gates pass before firing a long refine loop `-> TASKS-AGENTIC-UX.md` #agentic-ux #gates
- [ ] Per-run wall-clock timeout (`--run-timeout`) `-> TASKS-AGENTIC-UX.md` #safety #resilience
- [ ] Verdict parser — fenced `<verdict>` block grammar `-> TASKS-AGENTIC-UX.md` #parsing

### Priority 2 — agentic UX wins

- [x] [fixed by expo refine iter-005: src/cli.ts parseIntArg helper validates NaN/negatives across all 15 numeric-flag sites; bad input → stderr + exit 2] parseInt silently resolves to "no timeout" on bad input `-> .brief/agentic-audit.md` #agentic-ux #silent-failure
- [x] [fixed by expo refine iter-006: parseGateVerdict / parseRalphVerdict return UNCLEAR on garbage; propagates as terminal verdict with exit 3] Verdict parsers default to DONE on garbage `-> .brief/agentic-audit.md` #parsing #silent-failure
- [x] [fixed: src/notify.ts validateWebhookUrl() rejects non-http(s), loopback, link-local, RFC1918, unique-local IPv6, multicast, metadata hosts. Throws at setup time. 28 unit tests in tests/test-ssrf-validator.ts] SSRF via EXPO_WEBHOOK_URL `-> .brief/agentic-audit.md` #security
- [ ] `--json` flag on `expo refine` result `-> TASKS-AGENTIC-UX.md` #agentic-ux #output
- [ ] Pass gate-failure context into next iteration's prompt `-> TASKS-AGENTIC-UX.md` #feedback #gates
- [ ] Token-efficient formats (TOON / compact) for gate list, --tree, --status `-> TASKS-AGENTIC-UX.md` #agentic-ux #toon
- [ ] `expo refine <dir> heuristics` — expose REFINE.md to orchestrators `-> TASKS-AGENTIC-UX.md` #agentic-ux

### Priority 3 — bigger lifts

- [ ] `--auto` zero-config discovery mode (evo-style `/discover`) `-> TASKS-AGENTIC-UX.md` #agentic-ux #discover
- [ ] Agent-in-loop approval (non-TTY) — callback URL / named pipe `-> TASKS-AGENTIC-UX.md` #agentic-ux
- [ ] Resumability after crash / kill — persist per-iteration state, smoke-test recovery `-> TASKS-AGENTIC-UX.md` #resilience

## Brigade Learnings — Ported Fixes & Patterns

Sourced from `/Users/janzheng/Desktop/Projects/_deno/apps/brigade/.brief/`. Brigade hit these bugs in production; expo has the same code paths.

### P1: Direct fixes

- [x] [done: expo doesn't have conditional env — Deno.Command inherits full env by default. Not applicable.] Always pass full env to child processes `-> .brief/headless-permissions.md` #env #spawner
  - [*] Brigade bug: `const childEnv = ctx.env ? {...Deno.env.toObject(), ...ctx.env} : undefined` — when no per-job env set, `childEnv` is `undefined`, auth tokens don't propagate. Fix: always `{ ...Deno.env.toObject(), ...ctx.env }`. See `brigade/.brief/auth-modes.md`
  - [x] [done: verified — spawner.ts:518 creates Deno.Command without explicit env, Deno inherits full process env] Audit `spawner.ts` `Deno.Command` env passing — confirm expo always passes full env
- [x] [done: claude-adapter.ts — error_max_turns now emits "done" with partialResult:true instead of "failed"] Capture partial results on `error_max_turns` #adapter #bug
  - [*] Brigade bug: when Claude exits with `error_max_turns`, `is_error: true` causes result parser to discard `ev.result` and fall back to init blob. Agent may have written files + done real work. See `brigade/.brief/chef-max-turns-bug.md`
  - [x] [done: subtype === "error_max_turns" branch emits DonePayload with stopReason:"max_turns"] In `claude-adapter.ts` result handler: still capture `ev.result` even when `is_error && subtype === "error_max_turns"`
  - [x] [done: partial result includes cost, turns, denials — same as normal done signal] Surface partial result + cost + turns in the `done`/`failed` signal instead of discarding
- [x] [done: added maxTurns to SpawnOptions + --max-turns CLI flag. Expo doesn't set a default — defers to Claude Code's own default — but callers can now pass --max-turns 30+] Bump default `--max-turns` for complex tasks #spawner
  - [*] Brigade default was 15, complex tasks (multi-file read/write + type-check) hit it at 11 turns. Bumped to 30. Expo should check its default and consider similar bump

### P2: Resilience patterns

- [x] [done: verified — withTimeout wired in cli.ts spawn, orchestrator (race/review/ralph), mxit-runner, workflow, and refine (via spawnAndWait default 600s)] `maxDurationMs` wall-clock timeout on spawns #resilience
  - [*] Expo has `withTimeout()` already — verify it's wired into all spawn paths (spawn, race, review, mxit, refine)
- [x] [done: bus subscriber in spawner.ts counts tool_call signals per agent, kills process at limit. CLI: --max-tool-calls N] `maxToolCalls` limit — detect agent thrashing loops #resilience
  - [*] Count tool_call events in stream parser, abort if over limit (default 100). Brigade brief: `brigade/.brief/job-resilience.md`
- [x] [done: validateCommand in SpawnOptions, wired in spawnAndWait + cmdSpawn. CLI: --validate "test -f output.md"] Post-job validation command #resilience
  - [*] Optional `validateCommand` shell check after job completes. `test -f expected-output.md` etc. Cheap sanity gate

### P3: Future architecture

- [?] Permission log auto-delegation — graduated autonomy model #permissions #future
  - [*] Log what users always approve → auto-delegate rubber-stamp actions headlessly. See `brigade/.brief/permission-log-autodelegation.md`
- [?] Isolated worktrees — combine git worktrees + VM isolation for parallel code editing #isolation #future
  - [*] Relevant if expo adds smolvm support. See `brigade/.brief/isolated-worktrees.md`
- [?] Fan-out `submitAndWait()` with waiting-set concurrency accounting #orchestrator #future
  - [*] Formalize waiting vs running slots so parent blocked on children doesn't consume concurrency. See `brigade/.brief/fan-out-api.md`

## Later

- [~] [deferred: cosmetic — Live page already shows all cards] Workflow visualization — DAG view of fan-out → synthesis flow
- [~] [deferred: not a real use case currently] Multi-project support

## Snapshot tests (`apps/snapshot/`)

- [x] [done: snapshot_test.ts — init/snapshot/restore/branch, Deno copy replaces rsync] Test hidden-git backend on a plain folder (init, snapshot, restore, branch) #snapshot
- [x] [done: snapshot_test.ts — git tags verified, restore via git checkout] Test project-git backend on a git repo (init, snapshot, restore) #snapshot
- [x] [done: snapshot_test.ts — discards in manifest with correct parent/status, parent skips discarded] Test discard logging (no file snapshot, appears in manifest) #snapshot
- [x] [done: snapshot_test.ts — ASCII tree with connectors, statuses, current marker] Test tree visualization output #snapshot
- [x] [done: snapshot_test.ts — node_modules/.env/dist/__pycache__/.DS_Store all excluded] Test exclude patterns (node_modules etc. not in snapshots) #snapshot

## Discovered / Open Questions

- [*] Workshop deep dive: `.reduce/subagent-signal-bus.md`
- [*] Directory sandbox is independent of tool permissions — `Bash(ls:*)` in allow won't override CC directory restrictions
- [*] Some Bash commands are auto-safe regardless of allow list (`python3 --version`, `node --version`, `echo`)
- [*] "BLOCKED" (directory) vs "DENIED" (tool permission) are different failure modes — only DENIED can be fixed via ledger
- [*] Denials only reported in final result event — no mid-stream visibility
- [*] Pi-mono has no sub-command granularity — `Bash(git:*)` can't be mapped, only bare `Bash` deny
- [*] Pi-mono denials are silent — no events in JSON output
- [*] OpenCode denials appear as tool errors — indistinguishable from other errors
- [*] `--settings permissions.allow` and `--dangerously-skip-permissions` are both blocked by org policy (`tengu_disable_bypass_permissions_mode`). `--permission-prompt-tool` MCP handler is NOT blocked — use that for restricted accounts. See `.brief/headless-permissions.md`
- [*] Subagents spawned by Claude's built-in Agent tool inherit permission context. Subagents spawned by expo as separate processes do NOT — need `spawner.setDefaults()` to propagate config
- [*] Silent degradation: denied tools cause jobs to exit 0 with partial results. `permission_denials` in stream-json result event is the only signal

## File Inventory

```
src/
├── types.ts            ~110 lines   Signal types + typed payloads (incl. DenialDetail)
├── claude-adapter.ts   ~330 lines   stream-json → AgentSignal + denial normalization
├── codex-adapter.ts    ~130 lines   Codex --json → AgentSignal
├── opencode-adapter.ts ~240 lines   OpenCode --format json → AgentSignal
├── pimono-adapter.ts   ~250 lines   Pi-mono --mode json → AgentSignal
├── generic-adapter.ts   ~95 lines   Any CLI → lifecycle signals
├── bus.ts              ~120 lines   Multiplexer + JSONL logger
├── permission-ledger.ts ~200 lines  Persist/approve/reject/sync denied permissions
├── mxit-runner.ts      ~300 lines   Standalone task runner using mxit format
├── spawner.ts          ~570 lines   Spawn 5 agent types, sandbox, domain filter hooks, setDefaults() for permission propagation
├── permission-mcp-server.ts ~90 lines  MCP stdio server — auto-approves all Claude Code permission prompts
├── registry.ts         ~100 lines   Persistent agent→session mapping
├── orchestrator.ts     ~510 lines   Review, race, ralph, cost guard, escalation, timeout
├── timeout.ts           ~90 lines   withTimeout() — SIGTERM/SIGKILL escalation
├── workflow.ts         ~380 lines   Markdown workflow parser + multi-agent runner
├── refine.ts           ~580 lines   Archive-based refinement loop (DGM-H)
├── web.ts              ~190 lines   SSE server + JSONL tailer for dashboard
├── web/index.html      ~250 lines   Live agent card dashboard (vanilla JS)
├── watch.ts            ~140 lines   JSONL replay + summary
├── tui.tsx             ~220 lines   Ink/React card dashboard
├── tmux-consumer.ts    ~190 lines   tmux pane status updates
└── cli.ts              ~900 lines   All commands + permissions + serve

tests/
├── phase0/             13 tests     Validate Claude Code primitives
├── phase1-2/           11 tests     Unit + live tests for all phases
├── test-ledger-cycle.sh             12 checks — full approve→re-run cycle
├── test-workflow-synthesis.sh       5 checks — fan-out + synthesis e2e
├── test-domain-filter.ts            5 checks — hook generation unit test
└── test-sandbox-permissions.ts      Research sandbox empirical test
```

## CLI Reference

```
expo spawn <prompt> [--name N] [--agent claude|codex|opencode|pi] [--model M] [--no-worktree] [--timeout N] [--sandbox permissive|research|developer] [--auto-approve] [--max-turns N] [--max-tool-calls N] [--validate <cmd>]
expo spawn-all <tasks.json> [--timeout N]
expo status
expo resume <agentId> [--headless ["prompt"]]
expo fork <agentId>
expo cleanup <agentId> | --all
expo review <prompt> [--max N] [--work-agent TYPE] [--review-agent TYPE] [--snapshot-dir <dir>]
expo race "A" vs "B" [--criteria "..."] [--timeout N] [--snapshot-dir <dir>]
expo ralph "<work>" "<gate>" [--max N] [--review]
expo workflow <file.md> [--agent TYPE] [--model M] [--budget N] [--timeout N] [--sandbox S]
expo mxit <TASKS.md> [--agent TYPE] [--parallel] [--max N] [--timeout N] [--sandbox S] [--snapshot-dir <dir>]
expo refine <dir> [--rubric "..."] [--rubric-file F] [--max N] [--continue] [--branch-from ID] [--interactive] [--agent TYPE] [--timeout N]
expo refine <dir> --tree | --status
expo serve [--port N] [--log <file.jsonl>]
expo permissions [list]
expo permissions approve <pattern> [--auto-sync]
expo permissions reject <pattern> [--auto-sync]
expo permissions sync [--dry-run]
expo permissions reset
expo watch <file.jsonl> [--json | --summary]
```
