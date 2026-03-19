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
import { SignalBus, lineStream } from "./bus.ts";
import { Registry, type RegistryEntry } from "./registry.ts";

export type AgentType = "claude" | "codex";

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

  /** Build command args for a specific agent type */
  private buildCommand(opts: SpawnOptions & { sessionId: string; cwd: string }): { cmd: string; args: string[] } {
    const agentType = opts.agent ?? "claude";

    if (agentType === "codex") {
      const args = ["exec", "--json", "--full-auto", "--skip-git-repo-check"];
      if (opts.model) args.push("--model", opts.model);
      if (opts.cwd) args.push("--cd", opts.cwd);
      if (opts.extraFlags) args.push(...opts.extraFlags);
      args.push(opts.prompt);
      return { cmd: "codex", args };
    }

    // Default: claude
    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    const useWorktree = opts.worktree !== false;
    if (useWorktree) args.push("--worktree", opts.name);
    args.push("--session-id", opts.sessionId);
    if (opts.label) args.push("--name", opts.label);
    if (opts.model) args.push("--model", opts.model);
    if (opts.extraFlags) args.push(...opts.extraFlags);
    args.push(opts.prompt);
    return { cmd: "claude", args };
  }

  /** Get the right adapter for an agent type */
  private getAdapter(agentType: AgentType, adapterOpts: { agentId: string; parentId?: string }) {
    if (agentType === "codex") {
      return (line: string) => parseCodexLine(line, adapterOpts);
    }
    return (line: string) => parseStreamJsonLine(line, adapterOpts);
  }

  /** Spawn an agent (Claude or Codex) */
  async spawn(opts: SpawnOptions): Promise<SpawnedAgent> {
    const sessionId = opts.sessionId ?? crypto.randomUUID();
    const agentId = opts.name;
    const cwd = opts.cwd ?? this.baseCwd;
    const agentType = opts.agent ?? "claude";

    const { cmd, args } = this.buildCommand({ ...opts, sessionId, cwd });

    const command = new Deno.Command(cmd, {
      args,
      cwd,
      stdout: "piped",
      stderr: "piped",
    });

    const process = command.spawn();

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

  /** Spawn multiple agents in parallel */
  async spawnAll(
    tasks: SpawnOptions[],
  ): Promise<SpawnedAgent[]> {
    return Promise.all(tasks.map((t) => this.spawn(t)));
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
