# Expo Agentic Audit

Audit of the `expo` CLI from the perspective of an LLM agent driving it unattended. Findings are ranked by severity (P1 blocks unattended operation or leaks; P2 causes silent wrong state; P3 is friction). Findings verified against source.

---

## SECURITY

### Unauthenticated launch endpoints on `expo serve`
- **Severity:** P1
- **Category:** security
- **File:** src/web.ts:238-246
- **What goes wrong:** `POST /api/spawn`, `/api/race`, `/api/review`, and `/api/permissions/approve|reject` have no auth, no CORS origin check, and `Access-Control-Allow-Origin: *`; `Deno.serve` defaults to binding `0.0.0.0`, so any network peer (or any page a user visits in a browser) can launch arbitrary `expo` commands, which in turn run `deno run --allow-all src/cli.ts ...`.
- **Trigger:** User runs `expo serve` on a laptop on a public/café network, or a browser visits a page that POSTs to `http://localhost:3000/api/spawn`.
- **Suggested fix:** Bind to `127.0.0.1` by default, require a `Authorization: Bearer <token>` (printed on startup) for mutating routes, and drop the wildcard CORS for mutating routes.

### SSRF via `EXPO_WEBHOOK_URL`
- **Severity:** P2
- **Category:** security
- **File:** src/notify.ts:84-88
- **What goes wrong:** `fetch(opts.webhookUrl, { method: "POST", body: JSON.stringify({ signal }) })` is called on every `done`/`failed` without validating the URL, so `http://169.254.169.254/...`, internal services, or `file://`-ish handlers can be reached; agent-ID/error strings are exfiltrated in the body.
- **Trigger:** An agentic workflow writes a TASKS.md that instructs a sub-agent to `export EXPO_WEBHOOK_URL=...` before spawning, or the user follows an untrusted "setup snippet."
- **Suggested fix:** Reject loopback, link-local, RFC1918, and metadata IPs by default; require `https://` and an allowlist in a config file, or require an explicit `--webhook-allow-private` flag.

### `--validate` passed directly to `sh -c`
- **Severity:** P2
- **Category:** security
- **File:** src/cli.ts:292-298
- **What goes wrong:** `validateCommand` from CLI args is run through `new Deno.Command("sh", { args: ["-c", validateCommand] })`; if a higher-level orchestrator (mxit, workflow, web API) ever threads untrusted text into `--validate`, it becomes arbitrary shell execution.
- **Trigger:** A TASKS.md entry or workflow spec contains a `validate:` field copied from an untrusted source; or the web API grows a `validate` passthrough.
- **Suggested fix:** Document that `--validate` is untrusted-shell and keep it CLI-only, and/or split on whitespace + exec without `sh -c` for the common case. At minimum refuse `--validate` when the invoker isn't a TTY.

### Domain-filter hook interpolates domains into bash with only `"`-quoting
- **Severity:** P2
- **Category:** security
- **File:** src/spawner.ts:210-274
- **What goes wrong:** `generateDomainFilterHook` builds `ALLOWED_DOMAINS=("d1" "d2" ...)` with `map(d => \`"${d}"\`)`; any `"`, backtick, `$`, or `\` in a domain injects bash. Agents that supply `sandbox.allowedDomains` (via custom sandbox markdown) can break the sandbox they're meant to be locked inside.
- **Trigger:** A workflow/sandbox definition includes `domains: api.github.com, x"$(id)"`.
- **Suggested fix:** Validate each entry against a strict hostname regex before generation; additionally, pass domains via an env var (NUL-separated) and read them in the hook without interpolation.

### Path check for run files uses string match, not `realpath`
- **Severity:** P3
- **Category:** security
- **File:** src/web.ts:299-313
- **What goes wrong:** `handleGetRun` rejects `..` and `/` but does not canonicalize; if `logsDir` contains a symlink (e.g., `.expo/logs/foo.jsonl` → `/etc/passwd`), the dashboard will serve any readable file.
- **Trigger:** An agent with write access to `.expo/logs/` creates a symlink to an interesting file before the dashboard serves it.
- **Suggested fix:** `Deno.realPath(join(logsDir, filename))` and assert it starts with `Deno.realPath(logsDir)`.

---

## AGENTIC UX

### `workflow` reports success even when the agent wrote nothing
- **Severity:** P1
- **Category:** agentic-ux
- **File:** src/workflow.ts:348-355
- **What goes wrong:** If the sub-agent exits `0` but the expected `output/<name>.md` is missing, the code `console.warn`s and records `status: "success"` with `output: "(no output file written by agent...)"`, which then feeds synthesis. The orchestrating agent sees "success" and has no machine-readable signal that the step was effectively empty.
- **Trigger:** Agent spawned by `expo workflow` exits cleanly without writing to the output path (wrong CWD, misinterpreted prompt, sandbox blocked Write).
- **Suggested fix:** Treat missing-output as `status: "failed"` (or a new `"empty"` status) with a structured `reason`; surface in the returned JSON so the parent can branch on it.

### `withTimeout` kills only the leader PID, not the process group
- **Severity:** P1
- **Category:** agentic-ux (resource correctness)
- **File:** src/timeout.ts:54-59, 78-82
- **What goes wrong:** `process.kill("SIGTERM"/"SIGKILL")` signals only the spawned binary. The Claude/Codex CLI commonly forks `git`, `rg`, `curl`, test runners; those keep running after the parent exits, holding worktree locks and network sockets, and they can keep writing to `logHandle`/stdout the adapter no longer reads.
- **Trigger:** Any agent timeout while a child subprocess is still running (frequent under `--timeout`).
- **Suggested fix:** Spawn with `setsid`/detached process group and `Deno.kill(-pgid, signal)`; or on Unix, `Deno.Command("setsid", { args: [cmd, ...args] })` and track the group PID.

### `parseInt(...)` of CLI numeric flags never checks NaN
- **Severity:** P2
- **Category:** agentic-ux
- **File:** src/cli.ts:194-203 (and similar in other `cmd*` functions)
- **What goes wrong:** `--timeout abc` yields `timeout = NaN`; downstream `timeout > 0 ? timeout*1000 : undefined` resolves to `undefined`, i.e. **no timeout**. The CLI silently disables exactly the safety flag the caller asked for.
- **Trigger:** Agent constructs `--timeout ${maybeString}` without validation, or typos a value.
- **Suggested fix:** `const v = Number(args[++i]); if (!Number.isFinite(v) || v < 0) { error; exit(2); }`. Exit non-zero on bad numeric args instead of silently defaulting.

### `costGuard` warns but never enforces
- **Severity:** P2
- **Category:** agentic-ux
- **File:** src/orchestrator.ts:542-564
- **What goes wrong:** On budget overrun the function only `console.warn`s. The README advertises `--budget N` as a hard cap, but agents can blow through it with no kill/abort. An orchestrating agent has no way to tell from exit codes that the budget was exceeded.
- **Trigger:** `expo workflow ... --budget 1` on a job that costs $4; it will spend $4 and exit 0.
- **Suggested fix:** On overrun, emit a `budget_exceeded` signal, kill the offending agent (and/or all agents), and return a non-zero exit. Consider also clamping via `Deno.kill(-pgid)` per the timeout fix.

### `bus.ts` rotation fallback can still drop signals with no error
- **Severity:** P2
- **Category:** agentic-ux
- **File:** src/bus.ts:77-107, 164-183
- **What goes wrong:** When `rotate()` fails all fallbacks, `logHandle` stays `null`; future `emit()` calls hit the `if (this.logHandle)` guard and silently discard the log line. Consumers fire, but anything relying on the JSONL log (dashboards, `expo watch`, cost summaries) silently loses data with only a single one-shot `[bus] FATAL` line in stderr.
- **Trigger:** Disk full, `.expo/logs` unwritable, or permissions flip mid-run.
- **Suggested fix:** When `logHandle` is null after rotation, propagate failure through `emit()` (e.g., return a boolean or emit a `bus_offline` consumer-visible signal) so the orchestrator can abort instead of running half-blind.

### Unbounded `pendingWrites` during persistent rotation
- **Severity:** P2
- **Category:** agentic-ux (OOM)
- **File:** src/bus.ts:79-83
- **What goes wrong:** While `this.rotating` is true, every `emit` appends to `this.pendingWrites` with no cap. If rotation hangs (slow rename on network FS, or fallback loop stuck), memory grows linearly with signal rate.
- **Trigger:** Hundreds of tool-call signals/sec from a race or workflow, rotation stalled.
- **Suggested fix:** Cap `pendingWrites` (e.g. 10k entries); drop oldest with a single `[bus] dropped N` warning, or backpressure by making `emit` await a flush.

### `mxit` re-reads + re-parses TASKS.md every loop iteration
- **Severity:** P3
- **Category:** speed
- **File:** src/mxit-runner.ts:181-211
- **What goes wrong:** Every iteration does `readTextFile(tasksFile)` and `parseTasks(content)` even in sequential mode. For `--max 100` on a 1000-line TASKS.md that's 100 full re-parses for no new info (sequential can only unblock tasks after its own write).
- **Trigger:** `expo mxit TASKS.md --max 100` with a moderately sized task file.
- **Suggested fix:** In sequential mode, keep parsed tasks in memory and only re-read when `claim/complete/fail` mutates the file; in parallel mode, keep current behavior (external edits matter).

### `web.ts` `/api/runs` and `/api/costs` fully re-read every log on each call
- **Severity:** P2
- **Category:** speed
- **File:** src/web.ts:256-297, 343-382
- **What goes wrong:** Both endpoints enumerate `logsDir`, `Deno.readTextFile` every `*.jsonl` from start, and `JSON.parse` every line — on every request. `tmux-consumer.ts:109` does the same full-file read every 500ms poll.
- **Trigger:** Dashboard kept open (it polls), or long-running bus logs (tens of MB after a full workflow). Many GB/minute of disk reads at steady state.
- **Suggested fix:** Keep an `{ filename, mtime, parsed }` cache keyed on `stat.mtime + size`; invalidate via `Deno.watchFs(logsDir)`. For `tmux-consumer`, seek to `lastSize` instead of re-reading from byte 0.

### Permission HTTP endpoints load/save the whole ledger per request
- **Severity:** P2
- **Category:** speed + agentic-ux (races)
- **File:** src/web.ts:316-341
- **What goes wrong:** Each handler dynamically imports `PermissionLedger`, `new`s it, `load()`s, mutates, and `save()`s. Two concurrent approves → two independent in-memory copies → last `save()` wins and drops the other's change. No write queue.
- **Trigger:** User double-clicks "Approve", or dashboard has two tabs open and both approve patterns in quick succession.
- **Suggested fix:** Hold a module-level singleton ledger; serialize mutations through a single promise chain (same pattern as `Registry`'s writeQueue).

### Race judge parser falls back to branch 0 without signaling parse failure
- **Severity:** P2
- **Category:** agentic-ux
- **File:** src/orchestrator.ts:369-370
- **What goes wrong:** `const winner = winnerNum >= 0 ? winnerNum : successIndices[0];` silently elects the first success when the judge's output fails to parse. The return payload's `judgeReasoning` is whatever the judge wrote, but there's no structured flag that the "pick" was a fallback — callers can't tell a parsed win from a scan-failed default.
- **Trigger:** Judge agent produces prose without a `PICK <n>` line (common with non-Claude judges).
- **Suggested fix:** Add a `pickParsed: boolean` / `fallbackReason` field to the race result, and consider re-prompting the judge with stricter format once before falling back.

### `refine` interactive mode reads stdin synchronously while bus is live
- **Severity:** P3
- **Category:** agentic-ux
- **File:** src/refine.ts:215-237
- **What goes wrong:** `await readStdinLine()` blocks the async loop; bus-subscribed consumers still fire (they're sync callbacks) but any `await`ed emit from downstream code (registry writes, log rotations) queues behind the prompt. If a human walks away, running agent state stays frozen.
- **Trigger:** `expo refine ./src --interactive` and the user tabs away.
- **Suggested fix:** Mark interactive mode as non-agentic (document: "do not drive `refine --interactive` from an agent"); or add a `--interactive-timeout` that auto-chooses `accept`/`quit` after N seconds.

### Claude adapter's Bash-command parsing is lossy for denial details
- **Severity:** P3
- **Category:** agentic-ux
- **File:** src/claude-adapter.ts (permission-denied branch, ~line 280)
- **What goes wrong:** Denial details are reconstructed by splitting the command on whitespace; commands with quoted paths or pipes lose their structure, and the ledger records `Bash(cd:*)` style patterns that don't match how the agent actually invoked the command.
- **Trigger:** Any agent tries `git commit -m "msg with spaces"` and gets denied.
- **Suggested fix:** Don't re-parse — store the raw command string from the tool-input JSON and let `PermissionLedger` key on the exact pattern Claude produced.

---

## Summary

- **P1 (3):** unauthenticated web-launch endpoints, workflow silent-empty "success", leader-only kill leaks children.
- **P2 (10):** SSRF, shell-exec flag, domain-filter quoting, NaN-timeout, budget non-enforcement, bus-offline silence, pendingWrites unbounded, log-endpoint full-rescan, ledger race, judge-parse silent fallback.
- **P3 (3):** symlink bypass in log serving, mxit redundant re-parse, interactive refine stdin block, lossy command parse in claude adapter.

The most dangerous patterns for unattended agent driving: CLI commands that accept bad input and silently disable safety (NaN timeout, warn-only budget), and `expo serve` exposing spawn on the network without auth — combined these let a rogue agent produce cost/damage with no guardrail traceable in exit codes.
