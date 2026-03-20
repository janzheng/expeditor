# Harness-Controlled Sandbox for Headless Agents

**Status:** ready
**From:** Live debugging session — 3 failed runs before working solution (2026-03-19)
**Task:** `-> TASKS.md` (pending)

## Problem

When expo spawns headless Claude Code agents (`claude -p`), those agents run in default permission mode. Every tool call that would normally prompt a human — WebSearch, WebFetch, Write, Bash — blocks the agent. There's no human to click "approve." The agent either stalls, retries repeatedly, or gives up.

This is the same problem anyone hits in default mode: you have to approve every single Read, Write, WebSearch, git command, curl — every ten seconds. For interactive use it's annoying. For headless agents it's fatal.

Corporate environments make it worse — some policies mandate default permission mode, meaning every tool call prompts. Teams can't use `dangerously-skip-permissions` because policy forbids it. They're stuck clicking approve all day, or their headless agents can't function at all.

Our first research run: immune-lens bailed after 46 seconds because it couldn't get WebSearch approved. metabolite-lens ground for 4 minutes trying curl, WebSearch, then fell back to training knowledge and still couldn't write its output file. $0.95 spent, zero usable output.

The core tension: headless agents need pre-approved permissions to function, but we don't want to give them unrestricted access. A research agent should be able to search the web and write to an output folder, but shouldn't be able to `rm -rf` or push to git.

## How We Thought About It

### Attempt 1: `--permission-mode acceptEdits`

Claude Code has a `--permission-mode` flag. Setting it to `acceptEdits` auto-approves file edits without prompting. Combined with `--allowedTools` to whitelist specific tools.

**What happened:** `--allowedTools` is a variadic flag — it consumes all remaining positional arguments. So `claude -p --allowedTools Read Write WebSearch "do the research"` treats `"do the research"` as another tool name, not the prompt. The agent spawned with no prompt and immediately errored.

**Fix attempted:** Pipe the prompt via stdin instead of as a positional arg. This worked — `echo "prompt" | claude -p --allowedTools Read Write` correctly passes the prompt through stdin while the tools go through the flag.

But `acceptEdits` + `allowedTools` is two separate permission mechanisms fighting each other. `acceptEdits` is a blanket mode that approves all edits. `allowedTools` is a tool-level whitelist. They don't compose well — you can't say "allow WebSearch but deny Bash(rm:*)" with these flags alone. And the agent is still technically in `acceptEdits` mode, which is broader than we want.

### Attempt 2: Think about what we actually want

The real question isn't "how do we pass permissions to Claude Code." It's "who should own the permission decision?"

Three models:

| Model | Who decides | How |
|-------|-----------|-----|
| **Agent-controlled** | The agent itself | `--permission-mode bypassPermissions` — agent does whatever it wants |
| **User-controlled** | The human at the terminal | Default mode — every tool call prompts |
| **Harness-controlled** | The orchestrator (expo) | Expo declares what each agent can do, passes rules to Claude Code |

For headless multi-agent workflows, the harness should own it. The person who wrote the workflow decided what tools are needed. The orchestrator should enforce that — not the agent, and not a human clicking approve in a terminal that nobody's watching.

### Attempt 3: `--settings <file>`

Claude Code has a `--settings` flag that accepts a path to a JSON file (or inline JSON). This file can declare `permissions.allow` and `permissions.deny` with glob patterns — the same format as `.claude/settings.json`.

This is the right primitive. The harness generates a temporary settings file per agent with exactly the tools that agent needs, passes it via `--settings`, and the agent runs in default (tight) permission mode. The settings file acts as a scoped capability grant from the harness.

## Solution

### Architecture

```
Workflow declares sandbox rules (or uses a preset)
        |
        v
Spawner resolves preset → SandboxConfig { allow, deny }
        |
        v
Spawner generates temp settings.json per agent
        |
        v
claude -p --settings /tmp/expo-sandbox-xxx/agent-settings.json "prompt"
        |
        v
Agent runs in default permission mode (tight)
  - Tools in allow list: auto-approved, zero prompts
  - Tools in deny list: removed from agent's world entirely
  - Everything else: would prompt (but headless, so effectively blocked)
        |
        v
Agent exits → spawner deletes temp settings file
```

The agent never knows it's sandboxed. It just sees that some tools work and others don't. The harness controls the boundary.

### Key discovery: `"Bash"` allows ALL Bash commands

We initially built the permissive preset with 30+ `Bash(command:*)` patterns. Then discovered that **`"Bash"` (no parens) allows all Bash commands** — git, kill, curl, rm, everything. No enumeration needed.

This means the "auto-approve everything" settings file is just 12 entries:

```json
{
  "permissions": {
    "allow": [
      "Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit",
      "WebSearch", "WebFetch",
      "Bash",
      "Agent", "Task", "TaskOutput", "ToolSearch", "Skill",
      "mcp__*"
    ]
  }
}
```

No deny list needed. Claude Code's hardcoded safety layer (Layer 1) still catches truly destructive operations. `kill` works (useful for stopping hung dev servers). `rm` of individual files works. The safety layer protects against `rm -rf /` and similar.

Note: `"*"` alone does NOT work as a universal wildcard — it only matched Bash in testing. Each tool category needs to be listed explicitly. But `"Bash"` covers all Bash subcommands, and `"mcp__*"` covers all MCP tools.

### Sandbox presets

One word replaces the entire allow/deny config:

```json
{ "prompt": "...", "name": "my-agent", "sandbox": "permissive" }
```

| Preset | Use case | Allow | Deny |
|--------|----------|-------|------|
| **`permissive`** | "Stop asking me" | All file ops, Web, **all Bash** (git, kill, curl, rm, everything), all MCP, Agent/Task | Nothing — Layer 1 hardcoded safety is the only guardrail |
| **`research`** | Literature review, analysis | Read, Write, Edit, Web, curl, jq, MCP | git, gh, sudo |
| **`developer`** | Full coding workflow | Same as permissive | Force push, hard reset, git clean, sudo |

**Custom sandbox** still works for fine-grained control:

```json
{
  "sandbox": {
    "allow": ["Read", "WebSearch", "Bash(curl:*)"],
    "deny": ["Bash(git:*)"]
  }
}
```

### Presets implementation

```typescript
export const SANDBOX_PRESETS: Record<string, SandboxConfig> = {
  /** Auto-approve everything. The "stop asking me" mode. */
  permissive: {
    allow: [
      "Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit",
      "WebSearch", "WebFetch",
      "Bash",
      "Agent", "Task", "TaskOutput", "ToolSearch", "Skill",
      "mcp__*",
    ],
    // No deny list — Claude Code's hardcoded safety layer handles the rest
  },

  /** Research — web + files, no git */
  research: {
    allow: [
      "Read", "Write", "Edit", "Glob", "Grep",
      "WebSearch", "WebFetch",
      "Bash(mkdir:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(curl:*)", "Bash(jq:*)",
      "ToolSearch", "mcp__*",
    ],
    deny: ["Bash(git:*)", "Bash(gh:*)", "Bash(sudo:*)"],
  },

  /** Developer — everything, deny only destructive git ops */
  developer: {
    allow: [
      "Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit",
      "WebSearch", "WebFetch", "Bash",
      "Agent", "Task", "TaskOutput", "ToolSearch", "Skill", "mcp__*",
    ],
    deny: [
      "Bash(git push --force:*)", "Bash(git reset --hard:*)",
      "Bash(git clean:*)", "Bash(sudo:*)",
    ],
  },
};
```

SpawnOptions accepts either a preset string or a custom config:

```typescript
sandbox?: SandboxConfig | "permissive" | "research" | "developer";
```

### Verified: permissive preset auto-approves everything

Spawned a test agent with `"sandbox": "permissive"` in default permission mode. **7/7 tools auto-approved, zero prompts:**

| Tool | Result |
|------|--------|
| Read (workflow file) | SUCCESS — auto-approved |
| WebSearch ("test query") | SUCCESS — auto-approved |
| git log --oneline | SUCCESS — auto-approved |
| gh --version | SUCCESS — auto-approved |
| curl httpbin.org \| jq | SUCCESS — auto-approved |
| Write (output file) | SUCCESS — auto-approved |
| deno --version | SUCCESS — auto-approved |

Total cost: $0.15. Total prompts: **zero.** This is the "stop asking me" mode.

### Settings file generation and lifecycle

**Generation** — spawner writes a temp file before launching the agent:

```typescript
private async generateSettingsFile(sandbox: SandboxConfig, agentId: string): Promise<string> {
  const settings = {
    permissions: {
      allow: sandbox.allow ?? [],
      deny: sandbox.deny ?? [],
    },
  };
  const tmpDir = await Deno.makeTempDir({ prefix: "expo-sandbox-" });
  const settingsPath = `${tmpDir}/${agentId}-settings.json`;
  await Deno.writeTextFile(settingsPath, JSON.stringify(settings, null, 2));
  return settingsPath;
}
```

**Passing** — settings path added as CLI flag:

```typescript
if (opts.settingsPath) {
  args.push("--settings", opts.settingsPath);
}
```

**Cleanup** — temp directory removed after agent exits:

```typescript
if (settingsPath) {
  await this.cleanupSettingsFile(settingsPath);
}
```

**Preset resolution** — string presets expanded at spawn time:

```typescript
const sandbox = typeof opts.sandbox === "string"
  ? SANDBOX_PRESETS[opts.sandbox]
  : opts.sandbox;
```

## Results

### Iterative runs (research workflow)

| Run | Permissions | Outcome | Cost |
|-----|-----------|---------|------|
| Run 1 | None (default mode) | Both agents stalled on WebSearch/Write. immune-lens bailed at 46s. metabolite-lens fell back to training knowledge, couldn't write output. | $0.95 |
| Run 2 | `acceptEdits` + `allowedTools` | `--allowedTools` variadic flag ate the prompt. Both agents errored instantly ("no prompt provided"). | $0.00 |
| Run 3 | `acceptEdits` + `allowedTools` via stdin | Fixed stdin piping. Both agents completed but used blunt `acceptEdits` mode. | $1.47 |
| Run 4 | Sandbox via `--settings` (custom config) | Both agents completed. Tight permissions. Agents auto-approved for whitelisted tools, couldn't touch rm/git. | $1.75 |
| **Run 5** | **Sandbox preset: `"permissive"`** | **7/7 tools auto-approved (Read, WebSearch, git, gh, curl, Write, deno). Zero prompts. $0.15.** | **$0.15** |

### Isolated verification (default sandbox mode)

Ran focused tests to confirm the harness auto-approves in Claude Code's default (most restrictive) permission mode — no `acceptEdits`, no `dangerously-skip-permissions`, just a `--settings` file.

**Allow list test** — all auto-approved, zero prompts:

| Tool | Settings rule | Result |
|------|--------------|--------|
| Read (README.md) | `allow: ["Read"]` | Auto-approved. |
| WebSearch ("gut brain axis") | `allow: ["WebSearch"]` | Auto-approved. |
| Write (/tmp/output.txt) | `allow: ["Write"]` | Auto-approved. |

**Deny list test** — blocked by the harness:

| Tool | Settings rule | Result |
|------|--------------|--------|
| Bash(rm:*) (delete file) | `deny: ["Bash(rm:*)"]` | Blocked. File survived. |

**Important clarification:** The deny in the test above was OUR deny, not something imposed from outside. We chose to block rm. If we had put `Bash(rm:*)` in the allow list instead, the harness would have approved it — but Claude Code's hardcoded safety layer would still block the actual `rm` execution. The deny list is for the harness to express intent; the hardcoded layer is the true safety net.

## Permission Hierarchy (Empirically Tested)

Three layers of enforcement, from hardest to softest:

```
Layer 1: Claude Code hardcoded safety (non-negotiable)
  - Destructive Bash ops (rm via shell, redirects) blocked regardless of settings
  - Cannot be overridden by any settings file, flag, or permission mode
  - Baked into the binary — the true safety net

Layer 2: Settings allow/deny (harness-controlled — this is what we built)
  - allow via --settings  →  auto-approves tools that default mode would prompt for
  - deny in ANY settings layer  →  tool removed entirely (doesn't exist, not "denied")
  - deny always wins over allow across layers — one-way ratchet
  - The harness operates here

Layer 3: Default mode prompting (the annoying part)
  - Everything not in allow/deny prompts the user
  - In headless mode (no user), this effectively blocks
  - The harness solves this by putting needed tools in the allow list
```

### What the harness CAN auto-approve

Verified across multiple test runs:

- **File operations:** Read, Write, Edit, Glob, Grep — all auto-approved
- **Web access:** WebSearch, WebFetch — auto-approved
- **Bash (non-destructive):** ls, mkdir, curl, cat, grep, git status, git log, git diff, gh, deno, node, npm, python — all auto-approved
- **MCP tools:** mcp__claude_ai_PubMed__*, etc. — auto-approved
- **Claude Code internal tools:** Agent, Task, ToolSearch, Skill — auto-approved

### What the harness CANNOT override

- **Claude Code hardcoded safety:** rm via Bash, shell redirects (echo > file) — blocked even with those tools in the allow list. This is Layer 1, not controlled by settings.
- **Project-level deny rules:** If a corporate `.claude/settings.json` denies WebSearch, the harness `--settings` file cannot re-allow it. Deny is a one-way ratchet — any layer can tighten, no layer can loosen what a higher layer denied. Tested by passing two `--settings` files (one deny, one allow for the same tool) — the deny won, tool was completely absent from the agent's world.

### What this means for "approve every little thing" environments

The harness solves the default-mode-is-annoying problem directly:

```
BEFORE (default mode, headless):
  Agent calls Read       → blocked (no human to approve)
  Agent calls WebSearch  → blocked
  Agent calls git status → blocked
  Agent calls Write      → blocked
  Result: agent stalls or gives up

AFTER (default mode + harness --settings):
  Agent calls Read       → auto-approved (in allow list)
  Agent calls WebSearch  → auto-approved (in allow list)
  Agent calls git status → auto-approved (in allow list)
  Agent calls Write      → auto-approved (in allow list)
  Agent calls rm -rf     → blocked (Layer 1 hardcoded safety)
  Result: agent runs to completion, zero prompts
```

For corporate environments that mandate default permission mode:
- **Security team** controls the project-level `.claude/settings.json` deny list (the floor nobody can breach)
- **Workflow author** controls the harness allow list via sandbox presets or custom config (what this specific workflow needs)
- **Claude Code** enforces the hardcoded safety layer regardless (the non-negotiable basement)

Three layers. Each can only tighten. The harness fills the gap between "prompts for everything" and "project policy denies specific things" — exactly the space where the annoying approvals live.

### No runtime escalation needed

The harness declares the full sandbox upfront. If the agent needs a tool, it's either in the allow list or it isn't. There's no mid-run negotiation — the workflow author knows what tools are needed when they write the workflow. If the sandbox is wrong, fix the workflow and re-run.

With the `permissive` preset, you almost never need to think about it. It allows everything non-destructive. If an agent hits a wall, it means the tool is genuinely dangerous or missing from the preset — update the preset or use a custom sandbox.

### Detecting permission issues

When an agent hits a permission wall, the stream-json output includes a `permission_denials` array in the `result` event. The bus could emit a signal for this so the harness logs which tools an agent needed but couldn't get. Not interactive approval (that's out of scope for headless mode), but visibility into "this agent was blocked on X — consider adding it to the sandbox."

```typescript
// In the result event from stream-json:
{
  "type": "result",
  "permission_denials": ["Bash(some_command)"],  // ← tools that were blocked
  ...
}
```

The harness could watch for non-empty `permission_denials` and emit a bus signal:

```
01:05:42  my-agent  ⚠ permission denied: Bash(some_command) — consider adding to sandbox
```

This closes the feedback loop: run → see what was blocked → update sandbox → re-run.

## Tradeoffs

**What this doesn't solve:**
- **Domain-level restrictions**: You can say `Bash(curl:*)` but not "only curl to pubmed.ncbi.nlm.nih.gov." Tool-level granularity, not URL-level. For URL filtering you'd need a PreToolUse hook that inspects the arguments.
- **Settings file persistence on crash**: If the agent crashes hard (SIGKILL), the temp settings file isn't cleaned up. Not a security issue (it's in /tmp with no sensitive data), but worth noting.
- **Project-level deny overrides**: If a corporate `.claude/settings.json` denies a tool, the harness can't grant it back. The team would need to modify the project settings. This is by design (security) but could frustrate users who want the harness to be the sole authority.

**What this does solve:**
- **The "approve every little thing" problem**: Default mode prompts for Read, Write, WebSearch, Bash — every single call. The harness settings file auto-approves all of them for the tools the workflow needs. Zero prompts during agent execution.
- **Corporate policy friction**: Teams that mandate default permission mode can use the harness to declare per-workflow tool grants. The security team controls the project-level deny list (the floor), the workflow author controls the allow list (the ceiling). Both are explicit and auditable.
- **One-word setup**: `"sandbox": "permissive"` replaces listing 30+ individual tool patterns. Custom configs available when precision matters.
- **Per-agent scoping**: Each agent gets its own sandbox. A research agent and a coding agent in the same workflow can have different permissions.
- **No dangerous flags**: No `dangerously-skip-permissions`, no `acceptEdits`. Agents stay in default (tight) permission mode. The settings file is a scoped grant, not a blanket override.
- **Automatic cleanup**: Temp settings files are deleted after each agent exits.
- **Glob pattern support**: Uses Claude Code's native pattern syntax (`Bash(curl:*)`, `mcp__*`) for concise rules.

## Permission Ledger — Learn & Report (2026-03-20)

The sandbox system above is static: the workflow author declares permissions upfront, and if something gets denied, you see a yellow warning and move on. The **permission ledger** closes the feedback loop by persisting denials across runs and letting users approve patterns so subsequent runs don't hit the same walls.

### The problem it solves

The "detecting permission issues" section above described the feedback loop: run → see what was blocked → update sandbox → re-run. But "update sandbox" meant editing code — changing a preset or adding patterns to a custom sandbox config. For iterative workflows where you're discovering what permissions are needed, this is friction.

The ledger automates the "update sandbox" step. Denials are recorded to a persistent JSON file. The user reviews them with a CLI command and approves/rejects. On the next run, approved patterns are merged into the sandbox config automatically.

### Architecture

```
.expo/permissions.json          ← persistent ledger file
        |
        v
PermissionLedger class          ← load/save, record denials, approve/reject
        |
        v
ledger.buildSandbox(base)       ← merges approved → allow, rejected → deny
        |
        v
SandboxConfig passed to spawner ← agent never knows the ledger exists
```

The ledger follows the same `Registry` pattern: JSON file on disk, `Map`-based in-memory store, `load()`/`save()`.

### Data model

```typescript
interface PermissionEntry {
  pattern: string;        // "Bash(git push:*)", "Write", "mcp__slack__send"
  status: "approved" | "rejected" | "pending";
  firstSeen: number;      // epoch ms
  lastSeen: number;       // epoch ms
  count: number;          // how many times denied
  source?: string;        // which agent triggered it
  examples?: DenialExample[];  // last 3 denied commands with context
}

interface DenialExample {
  command?: string;       // "sudo ls /tmp"
  description?: string;   // "List /tmp directory contents with sudo"
  source?: string;        // "perm-test"
  timestamp: number;
}
```

### Raw denial format from Claude Code

**Important discovery (2026-03-20):** Claude Code's `permission_denials` in the stream-json `result` event are **objects, not strings**. The original code assumed strings and stored `[object Object]` — completely useless.

Actual format returned by Claude Code:

```json
{
  "type": "result",
  "permission_denials": [
    {
      "tool_name": "Bash",
      "tool_use_id": "toolu_01YKkHcnVvqbGc84ZdC8HBMZ",
      "tool_input": {
        "command": "sudo ls /tmp",
        "description": "List /tmp directory contents with sudo"
      }
    },
    {
      "tool_name": "Bash",
      "tool_use_id": "toolu_01BBXGHxDrqbzjFb6oGXkeuB",
      "tool_input": {
        "command": "git status",
        "description": "Show working tree status"
      }
    }
  ]
}
```

Each denial object contains:
- `tool_name` — the tool category (`"Bash"`, `"Write"`, etc.)
- `tool_use_id` — unique ID for this specific tool call
- `tool_input` — the full input the agent tried to pass (for Bash: `command` + `description`)

### How we normalize denials

The adapter (`claude-adapter.ts`) converts each denial object into two things:

1. **A pattern string** for matching/approval: `Bash(git:*)` (first word of command + glob)
2. **A `DenialDetail` object** preserving the full context:

```typescript
interface DenialDetail {
  pattern: string;       // "Bash(git:*)" — normalized for matching
  toolName: string;      // "Bash" — raw tool name
  command?: string;      // "git status" — full command string
  description?: string;  // "Show working tree status" — agent's intent
}
```

The pattern string flows into the ledger for approval/rejection. The detail flows into the ledger's `examples` array for display. Both travel through the signal bus as part of the done/failed payload.

### How it flows

**Run 1** — agent hits a denied tool:

```
$ expo spawn "push my code" --name pusher
...
✅ done (12.3s, 5 turns)

⚠ Permission Denials (1 pending):
  ✗ Bash(sudo:*)                   denied 1x   → pending
    ↳ sudo ls /tmp (List /tmp directory contents with sudo)

  Run expo permissions to review and approve for future runs.
```

Denials saved to `.expo/permissions.json` with full context:

```json
[
  {
    "pattern": "Bash(sudo:*)",
    "status": "pending",
    "firstSeen": 1774044751069,
    "lastSeen": 1774044751069,
    "count": 1,
    "source": "perm-test",
    "examples": [
      {
        "command": "sudo ls /tmp",
        "description": "List /tmp directory contents with sudo",
        "source": "perm-test",
        "timestamp": 1774044751069
      }
    ]
  }
]
```

**Between runs** — user reviews with full context:

```
$ expo permissions

Permission Ledger

  ● Bash(sudo:*)                   pending  1x  (from: perm-test)
    ↳ sudo ls /tmp (List /tmp directory contents with sudo)

Approve:  expo permissions approve "<pattern>"
Reject:   expo permissions reject "<pattern>"
Reset:    expo permissions reset
```

The examples tell the user exactly what was attempted, not just the pattern. This matters when deciding whether to approve — `Bash(git:*)` with example `git status (Show working tree status)` is very different context from `Bash(git:*)` with example `git push --force origin main`.

```
$ expo permissions approve "Bash(sudo:*)"
Approved: Bash(sudo:*)
```

**Run 2** — ledger merges approval into sandbox:

```
CLI loads ledger → ledger.buildSandbox(developerPreset) →
  allow: [...developer defaults..., "Bash(sudo:*)"]
  → spawner gets merged config → no more denial for that pattern
```

### `buildSandbox` — the key method

Given a base preset, returns a new `SandboxConfig` with approved patterns added to `allow` and rejected patterns added to `deny`. Does not mutate the input.

```typescript
buildSandbox(base: SandboxConfig): SandboxConfig {
  const allow = [...(base.allow ?? [])];
  const deny = [...(base.deny ?? [])];

  for (const entry of this.entries.values()) {
    if (entry.status === "approved" && !allow.includes(entry.pattern)) {
      allow.push(entry.pattern);
    }
    if (entry.status === "rejected" && !deny.includes(entry.pattern)) {
      deny.push(entry.pattern);
    }
  }

  return { ...base, allow, deny };
}
```

This means the three-layer hierarchy still holds. The ledger operates at Layer 2 (harness-controlled). If a corporate `.claude/settings.json` denies a tool, approving it in the ledger won't override that — deny is still a one-way ratchet across layers.

### CLI commands

```
expo permissions                    # list all entries
expo permissions approve <pattern>  # approve for future runs
expo permissions reject <pattern>   # explicitly deny for future runs
expo permissions reset              # clear the ledger
```

### Where it's wired in

| Command | How |
|---------|-----|
| `spawn` | Loads ledger, merges into `developer` preset, tracks denials from bus signals, saves + reports |
| `workflow` | Passes ledger to `runWorkflow`, merges before spawning agents and synthesis |
| `mxit` | Passes ledger to `runMxit`, merges before spawning task agents |
| `orchestrator.spawnAndWait` | Accepts optional `ledger`, calls `recordDenials` on completion |

All wiring is backward-compatible — `ledger` is optional everywhere. If you don't use the permissions system, nothing changes.

### Design decisions

**No subsumption logic.** If a user approves `Bash`, it won't auto-subsume `Bash(git:*)`. Claude Code's own pattern matching handles glob semantics. The ledger stores exactly what the user types.

**No auto-approve.** The ledger never approves anything on its own. It records, the user decides, the next run applies. This is deliberate — headless agents shouldn't escalate their own permissions.

**Last-write-wins for concurrent runs.** The JSON file doesn't do locking. If two runs finish simultaneously, the last one to save wins. But data converges because denials are additive (new patterns get added, counts increment, no data is deleted by a write).

**`recordDenials` doesn't overwrite status.** If a pattern is already approved or rejected and the same denial comes in again, the count increments but the status stays. This prevents a re-run from resetting a user's decision back to pending.

### Updated feedback loop

```
BEFORE (original sandbox):
  run → see warning → edit code → re-run

AFTER (with ledger):
  run → see structured denial report → `expo permissions approve "X"` → re-run
```

The sandbox presets are still the right starting point. The ledger handles the edge cases where a preset is almost-but-not-quite right — you discover what's missing through actual runs rather than guessing upfront.

### Data flow through the system

```
Claude Code result event
  → { tool_name: "Bash", tool_input: { command: "git status", description: "..." } }

claude-adapter.ts (normalize)
  → pattern: "Bash(git:*)"
  → DenialDetail: { pattern, toolName, command, description }

Signal bus (done/failed payload)
  → permissionDenials: ["Bash(git:*)"]          ← backward-compat strings
  → denialDetails: [{ pattern, toolName, ... }]  ← rich objects

orchestrator.spawnAndWait
  → captures both from bus signals
  → calls ledger.recordDenials(patterns, source, details)

PermissionLedger
  → stores pattern + status + count for matching
  → stores last 3 examples with command/description for display

CLI / TUI / web dashboard
  → reads entries + examples for rich rendering
```

### Empirical sandbox testing (2026-03-20)

Ran 19 Bash commands through the **research** sandbox preset (allows `Bash(mkdir:*)`, `Bash(ls:*)`, `Bash(cat:*)`, `Bash(head:*)`, `Bash(curl:*)`, `Bash(jq:*)`; denies `Bash(git:*)`, `Bash(gh:*)`, `Bash(sudo:*)`).

| # | Command | Result | Category |
|---|---------|--------|----------|
| 1 | `ls /tmp` | BLOCKED | Directory sandbox — `/tmp` is outside project dir |
| 2 | `mkdir -p /tmp/...` | BLOCKED | Directory sandbox |
| 3 | `cat /etc/hostname` | BLOCKED | Directory sandbox |
| 4 | `touch /tmp/...` | BLOCKED | Directory sandbox + not in allow list |
| 5 | `sed 's/a/b/'` | BLOCKED | Not in allow list |
| 6 | `awk 'BEGIN{...}'` | DENIED | Not in allow list — "requires approval" |
| 7 | `find /tmp ...` | BLOCKED | Directory sandbox |
| 8 | `chmod 644 ...` | DENIED | Not in allow list — "requires approval" |
| 9 | `mv /tmp/...` | BLOCKED | Directory sandbox |
| 10 | `cp /tmp/...` | BLOCKED | Directory sandbox |
| 11 | `python3 --version` | **OK** | Auto-safe — Claude Code allows version checks |
| 12 | `node --version` | **OK** | Auto-safe |
| 13 | `git status` | DENIED | In deny list |
| 14 | `git log --oneline -1` | DENIED | In deny list |
| 15 | `curl httpbin.org/get` | **OK** | In allow list |
| 16 | `jq --version` | **OK** | In allow list |
| 17 | `rm /tmp/...` | BLOCKED | Directory sandbox |
| 18 | `sudo ls /tmp` | DENIED | In deny list |
| 19 | `echo "done"` | **OK** | Auto-safe |

Also ran all 19 through the **developer** sandbox preset (allows `"Bash"` = all Bash). **Every command succeeded.** The blanket `"Bash"` pattern truly allows everything.

#### Key findings

**1. Claude Code has a directory sandbox independent of tool permissions.**

`Bash(ls:*)` in the allow list does NOT override directory restrictions. `ls` within the project dir works; `ls /tmp` is blocked because `/tmp` is outside the allowed directory. This is a separate safety layer — not controlled by the `--settings` file.

This means the `Bash(cmd:*)` patterns in the research preset are partially misleading: `Bash(ls:*)` approves the *tool*, but the *directory sandbox* may still block the command if it targets paths outside the project.

**2. Some commands are auto-safe regardless of the allow list.**

`python3 --version`, `node --version`, `echo`, `curl`, `jq` all worked without being in the allow list. Claude Code has built-in safe-listing for version checks and simple non-destructive commands. This is Layer 1 behavior.

**3. "BLOCKED" vs "DENIED" are different failure modes.**

- **BLOCKED** (directory sandbox): The command was approved at the tool level but Claude Code's directory sandbox prevented execution. Shows as "outside allowed directory" in the agent's output.
- **DENIED** (tool permission): The command was not in the allow list and no human was present to approve. Shows as "requires approval (denied)" or "DENIED by user."

Both show up in the `permission_denials` array in the result event. The ledger captures both, but only the DENIED cases (tool-level) can be resolved by approving patterns. BLOCKED cases (directory-level) require either running the command on project-local paths or a different approach entirely.

**4. All 14 denied commands were captured in a single `permission_denials` array.**

Claude Code collects every denial across the entire session and reports them all at once in the result event. There's no mid-stream denial signal — you only learn what was blocked after the agent finishes. The ledger's examples help users understand what happened without re-reading the full agent output.
