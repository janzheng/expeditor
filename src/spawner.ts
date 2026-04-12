/**
 * Agent Spawner — Launches Claude Code agents in worktrees with signal piping
 *
 * Each spawn runs:
 *   claude -p --output-format stream-json --verbose \
 *     --worktree <name> --session-id <uuid> --name <label> "<prompt>"
 *
 * Stdout is piped through the Claude adapter into the signal bus.
 */

import { parseStreamJsonLine } from "./claude-adapter.ts";
import { parseCodexLine } from "./codex-adapter.ts";
import { parseOpenCodeLine } from "./opencode-adapter.ts";
import { parsePiMonoLine } from "./pimono-adapter.ts";
import { parseGenericLine } from "./generic-adapter.ts";
import { SignalBus, lineStream } from "./bus.ts";
import { Registry, type RegistryEntry } from "./registry.ts";

export type AgentType = "claude" | "codex" | "opencode" | "pi" | "generic";

/**
 * Sandbox configuration — the harness controls what the agent can do.
 * Generates a temporary settings file passed via --settings.
 *
 * Use a preset string for common patterns, or a full SandboxConfig for custom rules.
 *   sandbox: "permissive"  — allow everything except destructive ops
 *   sandbox: "research"    — read/write/web/search, no git/rm
 *   sandbox: "developer"   — full dev workflow including git, no force-push/reset
 *   sandbox: { allow: [...], deny: [...] }  — custom rules
 */
export interface SandboxConfig {
  /** Tools/patterns to auto-approve (e.g. "Read", "Write", "Bash(curl:*)", "WebFetch") */
  allow?: string[];
  /** Tools/patterns to deny outright */
  deny?: string[];
  /** Additional directories the agent can access */
  addDirs?: string[];
  /** Restrict network access to these domains only (e.g. ["api.github.com", "pubmed.ncbi.nlm.nih.gov"]) */
  allowedDomains?: string[];
}

/**
 * Preset sandbox configurations.
 *
 * Key discovery: "Bash" (no parens) allows ALL Bash commands.
 * No need to enumerate Bash(git:*), Bash(curl:*), etc.
 * Claude Code's hardcoded safety layer (Layer 1) still blocks
 * truly destructive operations regardless of what we allow here.
 */
/**
 * Strict hostname regex for allowedDomains entries.
 *
 * Matches RFC-1123-ish labels separated by dots, case-insensitive, with no
 * leading/trailing hyphens. Crucially it rejects ANY shell-meaningful
 * character — quotes, backticks, `$`, `\`, whitespace, `;`, `|`, etc. — so
 * entries interpolated into a generated bash array can't break out of the
 * double-quoted context and inject commands.
 */
const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;

/** True iff `d` is a valid hostname safe to interpolate into a shell double-quoted string. */
export function isValidAllowedDomain(d: unknown): d is string {
  return typeof d === "string" && d.length > 0 && d.length <= 253 && HOSTNAME_RE.test(d);
}

/**
 * Validate an allowedDomains list and return the offending entries.
 * Throws an Error listing every invalid entry if any fail — callers should
 * surface this to the user rather than emit an unsafe hook.
 */
export function assertValidAllowedDomains(domains: readonly string[]): void {
  const invalid = domains.filter((d) => !isValidAllowedDomain(d));
  if (invalid.length > 0) {
    const quoted = invalid.map((d) => JSON.stringify(d)).join(", ");
    throw new Error(
      `Invalid allowedDomains entries: ${quoted}. ` +
      `Each entry must be a valid hostname (letters, digits, dots, hyphens; no shell metacharacters).`,
    );
  }
}

export const SANDBOX_PRESETS: Record<string, SandboxConfig> = {
  /**
   * Auto-approve everything. The "stop asking me" mode.
   * 12 entries cover all tools. No deny list — Claude Code's
   * hardcoded safety layer handles the truly dangerous stuff.
   */
  permissive: {
    allow: [
      "Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit",
      "WebSearch", "WebFetch",
      "Bash",
      "Agent", "Task", "TaskOutput", "ToolSearch", "Skill",
      "mcp__*",
    ],
  },

  /** Research workflow — web + files, no git or system commands */
  research: {
    allow: [
      "Read", "Write", "Edit", "Glob", "Grep",
      "WebSearch", "WebFetch",
      "Bash(mkdir:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(head:*)", "Bash(curl:*)", "Bash(jq:*)",
      "ToolSearch",
      "mcp__*",
    ],
    deny: [
      "Bash(git:*)", "Bash(gh:*)", "Bash(sudo:*)",
    ],
  },

  /** Full dev workflow — all tools, deny only the most destructive git ops */
  developer: {
    allow: [
      "Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit",
      "WebSearch", "WebFetch",
      "Bash",
      "Agent", "Task", "TaskOutput", "ToolSearch", "Skill",
      "mcp__*",
    ],
    deny: [
      "Bash(git push --force:*)",
      "Bash(git reset --hard:*)",
      "Bash(git clean:*)",
      "Bash(sudo:*)",
    ],
  },
};

export interface SpawnOptions {
  prompt: string;
  /** Worktree name (also used as default agentId) */
  name: string;
  /** Agent type (default: "claude") */
  agent?: AgentType;
  /** Agent display label */
  label?: string;
  /** Session ID (auto-generated UUID if not provided) */
  sessionId?: string;
  /** Parent agent ID (for subagent trees) */
  parentId?: string;
  /** Working directory (defaults to cwd) */
  cwd?: string;
  /** Model override */
  model?: string;
  /** Use worktree isolation (default: true) */
  worktree?: boolean;
  /** Harness-controlled sandbox — preset name or custom config */
  sandbox?: SandboxConfig | keyof typeof SANDBOX_PRESETS;
  /** Permission mode (default: "default"). Prefer sandbox for harness-controlled permissions. */
  permissionMode?: "acceptEdits" | "bypassPermissions" | "default" | "plan";
  /** Tools to allow without prompting (legacy — prefer sandbox.allow) */
  allowedTools?: string[];
  /** Timeout in seconds (0 = no timeout). Applied at orchestration layer, not spawn. */
  timeout?: number;
  /** Extra flags */
  extraFlags?: string[];
  /**
   * MCP tool name to use for headless permission prompts (--permission-prompt-tool).
   * Pass the full tool name, e.g. "mcp__auto_approve__approve".
   * Requires mcpConfig to also be set so Claude can find the MCP server.
   * Only works with -p (print) mode.
   */
  permissionPromptTool?: string;
  /** Path to an MCP config JSON file to load additional MCP servers */
  mcpConfig?: string;
  /** Max conversation turns before Claude stops (default: 30 for complex tasks). Maps to --max-turns. */
  maxTurns?: number;
  /** Max tool calls before the harness kills the agent (thrashing protection). 0 = no limit. */
  maxToolCalls?: number;
  /** Shell command to run after agent completes. Non-zero exit = job marked failed. E.g. "test -f output.md" */
  validateCommand?: string;
}

export interface SpawnedAgent {
  agentId: string;
  sessionId: string;
  process: Deno.ChildProcess;
  /** Promise that resolves when the agent exits */
  done: Promise<{ exitCode: number }>;
}

export class AgentSpawner {
  private bus: SignalBus;
  private registry: Registry;
  private baseCwd: string;
  private spawnDefaults: Partial<SpawnOptions> = {};

  /** Per-process cache — computed once, reused for every spawn. */
  private static _setsidAvailable: boolean | undefined;

  /** Send SIGTERM to a running agent (and its process group if `setsid`
   *  was used at spawn). Looks up the pid from the registry. Idempotent;
   *  safe to call on already-dead agents.
   *
   *  Returns true if a signal was sent (live process found), false
   *  otherwise. Does NOT wait for exit — callers should listen for the
   *  `done`/`failed` signal on the bus if they need confirmation. */
  async killAgent(agentId: string, reason?: string): Promise<boolean> {
    const entry = this.registry.get(agentId);
    if (!entry || !entry.pid || entry.status !== "running") return false;

    const pid = entry.pid;
    // Group-kill first (reaches forked children when spawned under setsid),
    // fall back to leader-only kill. Mirrors the pattern in timeout.ts.
    const groupKilled = AgentSpawner.tryKillProcessGroup(pid, "TERM");
    if (!groupKilled) {
      try {
        Deno.kill(pid, "SIGTERM");
      } catch {
        return false; // process already gone
      }
    }
    if (reason) {
      console.warn(`[spawner] killed ${agentId} (pid ${pid}): ${reason}`);
    }
    return true;
  }

  /** Kill every agent currently marked as `running`. Used by cost-guard on
   *  total-budget overrun — there's no way to tell which agent's cost put
   *  us over, and in fan-out patterns (race, workflow) all siblings share
   *  the budget. Safer to stop everything than let the overrun compound. */
  async killAllRunning(reason?: string): Promise<number> {
    const running = this.registry.getByStatus("running");
    let killed = 0;
    for (const entry of running) {
      if (await this.killAgent(entry.agentId, reason)) killed++;
    }
    return killed;
  }

  /** Private helper used by killAgent. Not shared with timeout.ts's
   *  identical function because the cross-module coupling isn't worth
   *  the few lines saved — both are leaf-level OS calls. */
  private static tryKillProcessGroup(pid: number, signal: "TERM" | "KILL"): boolean {
    try {
      const out = new Deno.Command("kill", {
        args: [`-${signal}`, `-${pid}`],
        stdout: "null",
        stderr: "null",
      }).outputSync();
      return out.success;
    } catch {
      return false;
    }
  }

  /** Check whether `setsid` is on PATH. Used by spawn() to decide whether
   *  to launch agents as their own session leader (so `kill -<pid>` on
   *  timeout reaches forked grandchildren). Cached after first lookup. */
  static async hasSetsid(): Promise<boolean> {
    if (AgentSpawner._setsidAvailable !== undefined) {
      return AgentSpawner._setsidAvailable;
    }
    try {
      const out = await new Deno.Command("sh", {
        args: ["-c", "command -v setsid"],
        stdout: "null",
        stderr: "null",
      }).output();
      AgentSpawner._setsidAvailable = out.success;
    } catch {
      AgentSpawner._setsidAvailable = false;
    }
    return AgentSpawner._setsidAvailable;
  }

  constructor(bus: SignalBus, opts?: { cwd?: string; registry?: Registry }) {
    this.bus = bus;
    this.baseCwd = opts?.cwd ?? Deno.cwd();
    this.registry = opts?.registry ?? new Registry({ cwd: this.baseCwd });
  }

  /** Set default options merged into every spawn/spawnAll call */
  setDefaults(defaults: Partial<SpawnOptions>): void {
    this.spawnDefaults = { ...this.spawnDefaults, ...defaults };
  }

  /** Load persisted registry from disk */
  async init(): Promise<void> {
    await this.registry.load();
  }

  /** Get the registry for external use */
  getRegistry(): Registry {
    return this.registry;
  }

  /** Generate a temporary settings file for harness-controlled sandboxing */
  private async generateSettingsFile(sandbox: SandboxConfig, agentId: string): Promise<string> {
    const tmpDir = await Deno.makeTempDir({ prefix: "expo-sandbox-" });

    const settings: Record<string, unknown> = {
      permissions: {
        allow: sandbox.allow ?? [],
        deny: sandbox.deny ?? [],
      },
    };

    // Generate domain-restriction hook if allowedDomains is set
    if (sandbox.allowedDomains?.length) {
      const hookPath = `${tmpDir}/${agentId}-domain-filter.sh`;
      await Deno.writeTextFile(hookPath, this.generateDomainFilterHook(sandbox.allowedDomains));
      await Deno.chmod(hookPath, 0o755);

      (settings as Record<string, unknown>).hooks = {
        PreToolUse: [
          { matcher: "Bash", command: hookPath },
          { matcher: "WebFetch", command: hookPath },
          { matcher: "WebSearch", command: hookPath },
        ],
      };
    }

    const settingsPath = `${tmpDir}/${agentId}-settings.json`;
    await Deno.writeTextFile(settingsPath, JSON.stringify(settings, null, 2));
    return settingsPath;
  }

  /** Generate a shell script that blocks network access to non-allowed domains */
  private generateDomainFilterHook(allowedDomains: string[]): string {
    assertValidAllowedDomains(allowedDomains);
    const domainList = allowedDomains.map((d) => `"${d}"`).join(" ");
    // The hook receives tool input via $TOOL_INPUT env var (JSON)
    // For Bash: check if command contains curl/wget with a URL not matching allowed domains
    // For WebFetch/WebSearch: check the url/query parameter
    return `#!/bin/bash
# Domain filter hook — generated by expo sandbox
# Allows: ${allowedDomains.join(", ")}
ALLOWED_DOMAINS=(${domainList})

# Extract the tool input from environment
INPUT="\${TOOL_INPUT:-}"
TOOL="\${TOOL_NAME:-}"

# Extract URLs from the input
extract_urls() {
  echo "$1" | grep -oE 'https?://[^"'"'"'\\s,)>]+' | head -20
}

# Extract domain from URL
get_domain() {
  echo "$1" | sed -E 's|https?://([^/:]+).*|\\1|'
}

# Check if domain is in allowed list
is_allowed() {
  local domain="$1"
  for allowed in "\${ALLOWED_DOMAINS[@]}"; do
    # Exact match or subdomain match
    if [ "$domain" = "$allowed" ] || [[ "$domain" == *".$allowed" ]]; then
      return 0
    fi
  done
  return 1
}

# Get URLs to check based on tool type
URLS=""
if [ "$TOOL" = "Bash" ]; then
  # Only check Bash commands that look like network requests
  COMMAND=$(echo "$INPUT" | grep -o '"command":"[^"]*"' | head -1 | sed 's/"command":"//;s/"$//')
  case "$COMMAND" in
    *curl*|*wget*|*http*) URLS=$(extract_urls "$COMMAND") ;;
    *) exit 0 ;;  # Not a network command, allow
  esac
elif [ "$TOOL" = "WebFetch" ] || [ "$TOOL" = "WebSearch" ]; then
  URLS=$(extract_urls "$INPUT")
fi

# If no URLs found, allow
[ -z "$URLS" ] && exit 0

# Check each URL
while IFS= read -r url; do
  [ -z "$url" ] && continue
  domain=$(get_domain "$url")
  if ! is_allowed "$domain"; then
    echo "BLOCKED by domain filter: $domain not in allowed list (${allowedDomains.join(", ")})" >&2
    exit 2  # Non-zero exit blocks the tool call
  fi
done <<< "$URLS"

exit 0
`;
  }

  /**
   * Map a SandboxConfig to pi-mono's --tools flag values.
   * Pi-mono tools: read, bash, edit, write, grep, find, ls
   */
  private sandboxToPiTools(sandbox: SandboxConfig): string[] {
    const piTools = new Set<string>();
    const denied = new Set<string>();

    // Map deny patterns — only deny "bash" entirely if the bare "Bash" is denied
    // "Bash(git:*)" style denials can't be mapped to pi-mono (no sub-command granularity)
    for (const pattern of sandbox.deny ?? []) {
      if (pattern === "Bash") denied.add("bash"); // Only bare "Bash" removes bash entirely
      if (pattern === "Read") denied.add("read");
      if (pattern === "Write") denied.add("write");
      if (pattern === "Edit") denied.add("edit");
      if (pattern === "Grep") denied.add("grep");
      if (pattern === "Glob") denied.add("find");
    }

    // Map allow patterns to pi-mono tool names
    for (const pattern of sandbox.allow ?? []) {
      if (pattern === "Read") piTools.add("read");
      if (pattern === "Write") piTools.add("write");
      if (pattern === "Edit") piTools.add("edit");
      if (pattern === "Grep") piTools.add("grep");
      if (pattern === "Glob") { piTools.add("find"); piTools.add("ls"); }
      // "Bash" or "Bash(cmd:*)" → bash
      if (pattern.startsWith("Bash")) piTools.add("bash");
    }

    // If no explicit allow list, default to all non-denied tools
    if (piTools.size === 0 && (sandbox.allow ?? []).length === 0) {
      for (const t of ["read", "write", "edit", "bash", "grep", "find", "ls"]) {
        piTools.add(t);
      }
    }

    // Remove denied tools
    for (const d of denied) {
      piTools.delete(d);
    }

    return Array.from(piTools);
  }

  /** Generate a temporary opencode agent config for sandboxing */
  private async generateOcAgentConfig(sandbox: SandboxConfig, agentId: string): Promise<string> {
    const tools = this.sandboxToOcTools(sandbox);
    const agentConfig = {
      name: `expo-${agentId}`,
      tools,
      permission: tools.map((t: string) => ({
        permission: t, action: "allow", pattern: "*",
      })),
    };
    const tmpDir = await Deno.makeTempDir({ prefix: "expo-oc-" });
    const configPath = `${tmpDir}/${agentId}-agent.json`;
    await Deno.writeTextFile(configPath, JSON.stringify(agentConfig, null, 2));
    return configPath;
  }

  /**
   * Map a SandboxConfig to opencode tool names.
   * OpenCode tools: bash, read, write, edit, list, glob, grep, webfetch, websearch, task, todowrite, todoread
   */
  private sandboxToOcTools(sandbox: SandboxConfig): string[] {
    const tools = new Set<string>();
    const denied = new Set<string>();

    // Map deny patterns
    for (const pattern of sandbox.deny ?? []) {
      if (pattern === "Bash") denied.add("bash");
      if (pattern === "Read") denied.add("read");
      if (pattern === "Write") denied.add("write");
      if (pattern === "Edit") denied.add("edit");
      if (pattern === "Grep") denied.add("grep");
      if (pattern === "Glob") { denied.add("glob"); denied.add("list"); }
      if (pattern === "WebFetch") denied.add("webfetch");
      if (pattern === "WebSearch") denied.add("websearch");
    }

    // Map allow patterns
    for (const pattern of sandbox.allow ?? []) {
      if (pattern === "Read") tools.add("read");
      if (pattern === "Write") tools.add("write");
      if (pattern === "Edit") tools.add("edit");
      if (pattern === "Grep") tools.add("grep");
      if (pattern === "Glob") { tools.add("glob"); tools.add("list"); }
      if (pattern === "WebFetch") tools.add("webfetch");
      if (pattern === "WebSearch") tools.add("websearch");
      if (pattern.startsWith("Bash")) tools.add("bash");
      if (pattern.startsWith("mcp__")) tools.add("task"); // MCP → task
    }

    // If no explicit allow list, default to all non-denied tools
    if (tools.size === 0 && (sandbox.allow ?? []).length === 0) {
      for (const t of ["bash", "read", "write", "edit", "list", "glob", "grep", "webfetch", "websearch", "task"]) {
        tools.add(t);
      }
    }

    for (const d of denied) tools.delete(d);
    return Array.from(tools);
  }

  /** Clean up a temporary settings file */
  private async cleanupSettingsFile(settingsPath: string): Promise<void> {
    try {
      const dir = settingsPath.replace(/\/[^/]+$/, "");
      await Deno.remove(dir, { recursive: true });
    } catch {
      // Best-effort cleanup
    }
  }

  /** Build command args for a specific agent type */
  private buildCommand(opts: SpawnOptions & { sessionId: string; cwd: string; settingsPath?: string }): { cmd: string; args: string[]; stdinPrompt?: string } {
    const agentType = opts.agent ?? "claude";

    if (agentType === "codex") {
      const args = ["exec", "--json", "--full-auto", "--skip-git-repo-check"];
      if (opts.model) args.push("--model", opts.model);
      if (opts.cwd) args.push("--cd", opts.cwd);
      if (opts.extraFlags) args.push(...opts.extraFlags);
      args.push(opts.prompt);
      return { cmd: "codex", args };
    }

    if (agentType === "opencode") {
      const args = ["run", "--format", "json"];
      if (opts.model) args.push("--model", opts.model);
      // settingsPath doubles as agent config path for opencode (generated in spawn())
      if (opts.settingsPath) args.push("--agent", opts.settingsPath);
      if (opts.extraFlags) args.push(...opts.extraFlags);
      args.push(opts.prompt);
      return { cmd: "opencode", args };
    }

    if (agentType === "pi") {
      const args = ["-p", "--mode", "json"];
      if (opts.model) args.push("--model", opts.model);
      // Map sandbox config to pi-mono's --tools flag
      if (opts.sandbox) {
        const sandbox = typeof opts.sandbox === "string"
          ? SANDBOX_PRESETS[opts.sandbox]
          : opts.sandbox;
        if (sandbox) {
          const piTools = this.sandboxToPiTools(sandbox);
          if (piTools.length > 0) {
            args.push("--tools", piTools.join(","));
          }
        }
      }
      if (opts.extraFlags) args.push(...opts.extraFlags);
      args.push(opts.prompt);
      return { cmd: "pi", args };
    }

    if (agentType === "generic") {
      // Split prompt: first token is command, rest are args
      const parts = opts.prompt.split(/\s+/);
      const cmd = parts[0];
      const cmdArgs = parts.slice(1);
      if (opts.extraFlags) cmdArgs.push(...opts.extraFlags);
      return { cmd, args: cmdArgs };
    }

    // Default: claude
    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    const useWorktree = opts.worktree !== false;
    if (useWorktree) args.push("--worktree", opts.name);
    args.push("--session-id", opts.sessionId);
    if (opts.label) args.push("--name", opts.label);
    if (opts.model) args.push("--model", opts.model);

    // Harness-controlled sandbox via --settings file (preferred)
    if (opts.settingsPath) {
      args.push("--settings", opts.settingsPath);
    }

    // MCP config for additional servers (e.g. auto-approve permission server)
    if (opts.mcpConfig) args.push("--mcp-config", opts.mcpConfig);

    // Headless permission handler — delegates prompts to an MCP tool instead of prompting
    if (opts.permissionPromptTool) args.push("--permission-prompt-tool", opts.permissionPromptTool);

    // Max conversation turns (default 30 — brigade found 15 too low for multi-file tasks)
    if (opts.maxTurns) args.push("--max-turns", String(opts.maxTurns));

    // Legacy: direct permission mode
    if (opts.permissionMode) args.push("--permission-mode", opts.permissionMode);

    if (opts.extraFlags) args.push(...opts.extraFlags);

    // --allowedTools is variadic and swallows positional args after it,
    // so when it's used we pipe the prompt via stdin instead.
    if (opts.allowedTools?.length) {
      args.push("--allowedTools", ...opts.allowedTools);
      return { cmd: "claude", args, stdinPrompt: opts.prompt };
    }

    args.push(opts.prompt);
    return { cmd: "claude", args };
  }

  /** Get the right adapter for an agent type */
  private getAdapter(agentType: AgentType, adapterOpts: { agentId: string; parentId?: string }) {
    if (agentType === "codex") {
      return (line: string) => parseCodexLine(line, adapterOpts);
    }
    if (agentType === "opencode") {
      return (line: string) => parseOpenCodeLine(line, adapterOpts);
    }
    if (agentType === "pi") {
      return (line: string) => parsePiMonoLine(line, adapterOpts);
    }
    if (agentType === "generic") {
      return (line: string) => parseGenericLine(line, adapterOpts);
    }
    return (line: string) => parseStreamJsonLine(line, adapterOpts);
  }

  /** Spawn an agent (Claude or Codex) */
  async spawn(opts: SpawnOptions): Promise<SpawnedAgent> {
    // Merge spawner-level defaults (e.g. mcpConfig + permissionPromptTool from --auto-approve)
    // Explicit opts take priority over defaults
    opts = { ...this.spawnDefaults, ...opts };
    const sessionId = opts.sessionId ?? crypto.randomUUID();
    const agentId = opts.name;
    const cwd = opts.cwd ?? this.baseCwd;
    const agentType = opts.agent ?? "claude";

    // Generate harness-controlled sandbox config if configured
    let settingsPath: string | undefined;
    if (opts.sandbox) {
      const sandbox = typeof opts.sandbox === "string"
        ? SANDBOX_PRESETS[opts.sandbox]
        : opts.sandbox;
      if (!sandbox && typeof opts.sandbox === "string") throw new Error(`Unknown sandbox preset: ${opts.sandbox}`);
      if (sandbox) {
        if (agentType === "claude") {
          settingsPath = await this.generateSettingsFile(sandbox, agentId);
        } else if (agentType === "opencode") {
          settingsPath = await this.generateOcAgentConfig(sandbox, agentId);
        }
        // pi-mono sandbox is handled in buildCommand via --tools flag
      }
    }

    const { cmd, args, stdinPrompt } = this.buildCommand({ ...opts, sessionId, cwd, settingsPath });

    // Launch the agent as a new session/process-group leader via `setsid` so
    // child subprocesses (git, rg, curl, test runners) can be killed as a
    // group on timeout instead of leaking. Falls back to a direct exec when
    // setsid isn't on PATH (non-Linux/macOS envs, stripped containers).
    const detached = await AgentSpawner.hasSetsid();
    const spawnCmd = detached ? "setsid" : cmd;
    const spawnArgs = detached ? [cmd, ...args] : args;

    const command = new Deno.Command(spawnCmd, {
      args: spawnArgs,
      cwd,
      stdin: stdinPrompt ? "piped" : "null",
      stdout: "piped",
      stderr: "piped",
    });

    let process: Deno.ChildProcess;
    try {
      process = command.spawn();
    } catch (err) {
      if (settingsPath) this.cleanupSettingsFile(settingsPath);
      throw err;
    }

    // Pipe prompt via stdin when --allowedTools is used (variadic flag eats positional args)
    if (stdinPrompt && process.stdin) {
      const writer = process.stdin.getWriter();
      await writer.write(new TextEncoder().encode(stdinPrompt));
      await writer.close();
    }

    // Register (persist to disk)
    const useWorktree = agentType === "claude" && opts.worktree !== false;
    const worktreeName = useWorktree ? opts.name : undefined;
    const worktreePath = useWorktree
      ? `${cwd}/.claude/worktrees/${opts.name}`
      : undefined;

    await this.registry.register({
      agentId,
      sessionId,
      name: opts.name,
      label: opts.label,
      pid: process.pid,
      cwd,
      worktreePath,
      worktreeName,
      status: "running",
      startedAt: Date.now(),
      prompt: opts.prompt,
      model: opts.model,
    });

    // Pipe stdout through the right adapter → bus
    const adapterOpts = { agentId, parentId: opts.parentId };
    const adapter = this.getAdapter(agentType, adapterOpts);
    const lines = lineStream(process.stdout);
    const pipePromise = this.bus.pipeLines(lines, adapter);

    // Thrashing protection: kill agent if tool calls exceed limit
    let killedByHarness = false;
    const maxToolCalls = opts.maxToolCalls ?? 0;
    if (maxToolCalls > 0) {
      let toolCallCount = 0;
      const unsub = this.bus.subscribe((signal) => {
        if (signal.agentId !== agentId) return;
        if (signal.type === "tool_call") {
          toolCallCount++;
          if (toolCallCount >= maxToolCalls) {
            console.error(`[spawner] ${agentId} hit maxToolCalls (${maxToolCalls}) — killing`);
            this.bus.emit({
              agentId,
              sessionId,
              timestamp: Date.now(),
              type: "failed",
              payload: { error: `Agent killed: exceeded ${maxToolCalls} tool calls (thrashing protection)` },
            }).catch(() => {}); // best-effort log write — process is being killed
            killedByHarness = true;
            try { process.kill("SIGTERM"); } catch { /* already dead */ }
            unsub();
          }
        }
        // Clean up subscriber when agent exits
        if (signal.type === "done" || signal.type === "failed") unsub();
      });
    }

    // Collect stderr for diagnostics
    const stderrReader = process.stderr.getReader();
    const stderrChunks: Uint8Array[] = [];
    const stderrPromise = (async () => {
      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        stderrChunks.push(value);
      }
    })();

    // Wait for exit — with crash protection
    const done = (async () => {
      let exitCode = 1;
      try {
        // pipePromise can reject if the process crashes mid-stream
        const [status] = await Promise.all([
          process.status,
          pipePromise.catch((err) => {
            console.error(`[spawner] ${agentId} pipe error:`, String(err).slice(0, 200));
          }),
          stderrPromise.catch(() => {}),
        ]);

        exitCode = status.code;
      } catch (err) {
        console.error(`[spawner] ${agentId} crashed:`, String(err).slice(0, 200));
        // Emit a failed signal so the bus knows (skip if harness already emitted one)
        if (!killedByHarness) {
          await this.bus.emit({
            agentId,
            sessionId,
            timestamp: Date.now(),
            type: "failed",
            payload: { error: `Agent crashed: ${String(err).slice(0, 200)}`, exitCode: -1 },
          });
        }
      }

      const newStatus = exitCode === 0 ? "done" as const : "failed" as const;

      // Clean up harness sandbox settings file
      if (settingsPath) {
        await this.cleanupSettingsFile(settingsPath);
      }

      await this.registry.update(agentId, {
        status: newStatus,
        exitCode,
        finishedAt: Date.now(),
      }).catch(() => {}); // registry write can fail if disk is full etc.

      if (exitCode !== 0) {
        const decoder = new TextDecoder();
        const stderr = stderrChunks.map(c => decoder.decode(c)).join("");
        if (stderr.trim()) {
          console.error(`[spawner] ${agentId} stderr:`, stderr.trim().slice(0, 500));
        }
      }

      return { exitCode };
    })();

    return { agentId, sessionId, process, done };
  }

  /**
   * Spawn multiple agents.
   * Agents are spawned sequentially with a worktree-readiness gate to avoid a
   * Claude CLI race condition where concurrent --worktree creation causes one
   * process to die silently (empty stdout, never closes fd).
   * After spawning, all agents run concurrently — only the setup is serialized.
   */
  async spawnAll(
    tasks: SpawnOptions[],
  ): Promise<SpawnedAgent[]> {
    const agents: SpawnedAgent[] = [];
    for (const t of tasks) {
      const agent = await this.spawn(t);
      // If using worktrees, wait for the worktree directory to be created
      // before spawning the next agent. Claude CLI creates the worktree
      // asynchronously after process.spawn() returns.
      const usesWorktree = (t.agent ?? "claude") === "claude" && t.worktree !== false;
      if (usesWorktree) {
        const wtPath = `${t.cwd ?? this.baseCwd}/.claude/worktrees/${t.name}`;
        await this.waitForPath(wtPath, 15000);
      }
      agents.push(agent);
    }
    return agents;
  }

  /** Wait for a path to exist (poll-based, for worktree readiness) */
  private async waitForPath(path: string, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        await Deno.stat(path);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    console.warn(`[spawner] worktree path not ready after ${timeoutMs}ms: ${path}`);
  }

  /** Clean up a worktree for a finished agent */
  async cleanup(agentId: string): Promise<void> {
    const entry = this.registry.get(agentId);
    if (!entry) throw new Error(`Agent not found: ${agentId}`);
    if (entry.status === "running") throw new Error(`Agent still running: ${agentId}`);

    if (entry.worktreeName && entry.cwd) {
      // Check for uncommitted changes
      try {
        const status = new Deno.Command("git", {
          args: ["-C", entry.worktreePath!, "status", "--porcelain"],
          stdout: "piped",
        });
        const out = await status.output();
        const dirty = new TextDecoder().decode(out.stdout).trim();
        if (dirty) {
          console.warn(`[cleanup] ${agentId}: worktree has uncommitted changes`);
          console.warn(`  ${entry.worktreePath}`);
          return;
        }
      } catch {
        // git status failed — worktree might already be gone
      }

      // Remove worktree
      try {
        const rm = new Deno.Command("git", {
          args: ["-C", entry.cwd, "worktree", "remove", entry.worktreePath!],
          stdout: "piped",
          stderr: "piped",
        });
        await rm.output();
      } catch {
        // Already removed or not a worktree
      }

      // Remove branch
      try {
        const br = new Deno.Command("git", {
          args: ["-C", entry.cwd, "branch", "-D", `worktree-${entry.worktreeName}`],
          stdout: "piped",
          stderr: "piped",
        });
        await br.output();
      } catch {
        // Branch might not exist
      }
    }

    await this.registry.remove(agentId);
  }

  /** Clean up all finished agents' worktrees */
  async cleanupAll(): Promise<string[]> {
    const finished = [
      ...this.registry.getByStatus("done"),
      ...this.registry.getByStatus("failed"),
    ];
    const cleaned: string[] = [];
    for (const entry of finished) {
      try {
        await this.cleanup(entry.agentId);
        cleaned.push(entry.agentId);
      } catch (err) {
        console.warn(`[cleanup] ${entry.agentId}: ${err}`);
      }
    }
    return cleaned;
  }
}
