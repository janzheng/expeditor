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
}

/**
 * Preset sandbox configurations.
 *
 * Key discovery: "Bash" (no parens) allows ALL Bash commands.
 * No need to enumerate Bash(git:*), Bash(curl:*), etc.
 * Claude Code's hardcoded safety layer (Layer 1) still blocks
 * truly destructive operations regardless of what we allow here.
 */
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

  constructor(bus: SignalBus, opts?: { cwd?: string; registry?: Registry }) {
    this.bus = bus;
    this.baseCwd = opts?.cwd ?? Deno.cwd();
    this.registry = opts?.registry ?? new Registry({ cwd: this.baseCwd });
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
    const settings: Record<string, unknown> = {
      permissions: {
        allow: sandbox.allow ?? [],
        deny: sandbox.deny ?? [],
      },
    };

    // Write to a temp file in the OS temp dir
    const tmpDir = await Deno.makeTempDir({ prefix: "expo-sandbox-" });
    const settingsPath = `${tmpDir}/${agentId}-settings.json`;
    await Deno.writeTextFile(settingsPath, JSON.stringify(settings, null, 2));
    return settingsPath;
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
      if (opts.extraFlags) args.push(...opts.extraFlags);
      args.push(opts.prompt);
      return { cmd: "opencode", args };
    }

    if (agentType === "pi") {
      const args = ["--mode", "json"];
      if (opts.model) args.push("--model", opts.model);
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
    const sessionId = opts.sessionId ?? crypto.randomUUID();
    const agentId = opts.name;
    const cwd = opts.cwd ?? this.baseCwd;
    const agentType = opts.agent ?? "claude";

    // Generate harness-controlled sandbox settings file if configured
    let settingsPath: string | undefined;
    if (opts.sandbox && agentType === "claude") {
      const sandbox = typeof opts.sandbox === "string"
        ? SANDBOX_PRESETS[opts.sandbox]
        : opts.sandbox;
      if (!sandbox) throw new Error(`Unknown sandbox preset: ${opts.sandbox}`);
      settingsPath = await this.generateSettingsFile(sandbox, agentId);
    }

    const { cmd, args, stdinPrompt } = this.buildCommand({ ...opts, sessionId, cwd, settingsPath });

    const command = new Deno.Command(cmd, {
      args,
      cwd,
      stdin: stdinPrompt ? "piped" : "null",
      stdout: "piped",
      stderr: "piped",
    });

    const process = command.spawn();

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
        // Emit a failed signal so the bus knows
        await this.bus.emit({
          agentId,
          sessionId,
          timestamp: Date.now(),
          type: "failed",
          payload: { error: `Agent crashed: ${String(err).slice(0, 200)}`, exitCode: -1 },
        });
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
