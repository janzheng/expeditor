/**
 * mxit Runner — Reads TASKS.md, spawns agents for ready tasks, tracks completion
 *
 * Standalone task runner using mxit's markdown format. No Claude Code required.
 * Reads → Claims → Spawns → Listens → Marks done/fail → Cascades.
 */

import {
  parseTasks,
  getReady,
  claimTask,
  completeTask,
  failTask,
  resetCrashed,
  type Task,
} from "@mxit/parser";

import { SignalBus } from "./bus.ts";
import { AgentSpawner, type SpawnOptions, type AgentType, type SandboxConfig, SANDBOX_PRESETS } from "./spawner.ts";
import { Registry } from "./registry.ts";
import { withTimeout } from "./timeout.ts";
import { costGuard } from "./orchestrator.ts";
import type { PermissionLedger } from "./permission-ledger.ts";
// Lazy-loaded snapshot functions — avoids hard dependency on @snapshot/core
async function loadSnapshot() {
  try {
    const mod = await import("@snapshot/core");
    return { init: mod.init, snapshot: mod.snapshot, restore: mod.restore };
  } catch (err) {
    console.warn(`[snapshot] @snapshot/core not available: ${String(err).slice(0, 100)}. Continuing without snapshots.`);
    return null;
  }
}

export interface MxitRunnerOptions {
  /** Path to TASKS.md file */
  tasksFile: string;
  /** Agent type to use (default: "claude") */
  agent?: AgentType;
  /** Model override */
  model?: string;
  /** Timeout per task in seconds (default: 600) */
  timeout?: number;
  /** Max tasks to process before stopping (default: 10) */
  maxTasks?: number;
  /** Run tasks in parallel when independent (default: false) */
  parallel?: boolean;
  /** Cost budget in USD (default: 10) */
  budget?: number;
  /** Use worktrees for isolation (default: true for claude) */
  worktree?: boolean;
  /** Sandbox preset (default: "developer") */
  sandbox?: string;
  /** Recover crashed tasks before starting (default: true) */
  recover?: boolean;
  /** Signal handler for live output */
  onSignal?: (signal: import("./types.ts").AgentSignal) => void;
  /** Permission ledger for tracking denials and merging approvals */
  ledger?: PermissionLedger;
  /** Directory to snapshot before each task (restore on failure) */
  snapshotDir?: string;
}

export interface MxitRunResult {
  tasksCompleted: number;
  tasksFailed: number;
  tasksSkipped: number;
  totalCostUsd: number;
  /** Tasks that were processed */
  results: TaskResult[];
}

export interface TaskResult {
  task: Task;
  status: "completed" | "failed" | "timed_out";
  exitCode: number;
  agentId: string;
  costUsd: number;
}

/**
 * Build a prompt for an agent from a mxit task.
 */
function buildTaskPrompt(task: Task, tasksFile: string): string {
  const parts: string[] = [];

  parts.push(`# Task\n${task.description}`);

  // Include annotations as context
  if (Object.keys(task.annotations).length > 0) {
    const annots = Object.entries(task.annotations)
      .map(([k, v]) => `- **${k}**: ${v}`)
      .join("\n");
    parts.push(`# Annotations\n${annots}`);
  }

  // Include child tasks as sub-requirements
  const openChildren = task.children.filter(
    (c) => c.status === " " || c.status === "!",
  );
  if (openChildren.length > 0) {
    const subs = openChildren.map((c) => `- ${c.description}`).join("\n");
    parts.push(`# Sub-tasks\nAlso complete these:\n${subs}`);
  }

  parts.push(
    `# Instructions\nDo the work described above. When done, report what you changed and whether tests pass.`,
  );

  return parts.join("\n\n");
}

/**
 * Run the mxit task loop.
 *
 * 1. Recover crashed tasks
 * 2. Find ready tasks
 * 3. Claim → Spawn → Wait → Mark done/fail
 * 4. Repeat until no more ready tasks or maxTasks reached
 */
export async function runMxit(opts: MxitRunnerOptions): Promise<MxitRunResult> {
  const {
    tasksFile,
    agent = "claude",
    model,
    timeout = 600,
    maxTasks = 10,
    parallel = false,
    budget = 10,
    worktree,
    sandbox: sandboxRaw = "developer",
    recover = true,
    onSignal,
    ledger,
    snapshotDir,
  } = opts;

  // Merge ledger approvals/rejections into sandbox
  let sandbox: string | SandboxConfig = sandboxRaw;
  if (ledger) {
    const baseConfig = typeof sandboxRaw === "string"
      ? SANDBOX_PRESETS[sandboxRaw]
      : undefined;
    if (baseConfig) {
      sandbox = ledger.buildSandbox(baseConfig);
    }
  }

  // Set up infrastructure
  const logsDir = ".expo/logs";
  await Deno.mkdir(logsDir, { recursive: true }).catch(() => {});
  const logFile = `${logsDir}/bus-mxit-${Date.now()}.jsonl`;
  const bus = new SignalBus({ logFile });
  await bus.init();

  if (onSignal) {
    bus.subscribe(onSignal);
  }

  const registry = new Registry();
  const spawner = new AgentSpawner(bus, { registry });
  await spawner.init();

  const unguard = costGuard(bus, { totalBudget: budget, spawner });

  const results: TaskResult[] = [];
  let totalCost = 0;

  try {
    // Step 1: Recover crashed tasks
    if (recover) {
      const recovered = await resetCrashed(tasksFile);
      if (recovered > 0) {
        console.log(`[mxit] Recovered ${recovered} crashed task(s)`);
      }
    }

    let processed = 0;

    // Step 2-4: Main loop
    while (processed < maxTasks) {
      // Re-read and find ready tasks each iteration (file may have changed)
      const content = await Deno.readTextFile(tasksFile);
      const tasks = parseTasks(content);
      const ready = getReady(tasks);

      if (ready.length === 0) {
        console.log(`[mxit] No more ready tasks`);
        break;
      }

      if (parallel && ready.length > 1) {
        // Fan-out: process all ready tasks in parallel
        const batch = ready.slice(0, maxTasks - processed);
        const batchResults = await processBatch(
          batch, tasksFile, bus, spawner, { agent, model, timeout, worktree, sandbox, ledger, snapshotDir },
        );
        results.push(...batchResults);
        totalCost += batchResults.reduce((sum, r) => sum + r.costUsd, 0);
        processed += batch.length;
      } else {
        // Sequential: process one task at a time
        const task = ready[0];
        const result = await processTask(
          task, tasksFile, bus, spawner, { agent, model, timeout, worktree, sandbox, ledger, snapshotDir },
        );
        results.push(result);
        totalCost += result.costUsd;
        processed++;
      }
    }
  } finally {
    unguard();
    await bus.close();
  }

  return {
    tasksCompleted: results.filter((r) => r.status === "completed").length,
    tasksFailed: results.filter((r) => r.status === "failed" || r.status === "timed_out").length,
    tasksSkipped: 0,
    totalCostUsd: totalCost,
    results,
  };
}

interface ProcessOpts {
  agent: AgentType;
  model?: string;
  timeout: number;
  worktree?: boolean;
  sandbox: string | SandboxConfig;
  ledger?: PermissionLedger;
  snapshotDir?: string;
}

/**
 * Process a single task: claim → spawn → wait → mark done/fail
 */
async function processTask(
  task: Task,
  tasksFile: string,
  bus: SignalBus,
  spawner: AgentSpawner,
  opts: ProcessOpts,
): Promise<TaskResult> {
  const agentId = `mxit-${task.line}`;
  const prompt = buildTaskPrompt(task, tasksFile);
  const useWorktree = opts.worktree ?? (opts.agent === "claude");

  // Claim
  await claimTask(tasksFile, task.line, agentId);
  console.log(`[mxit] Claimed: line ${task.line} → ${task.description.slice(0, 60)}`);

  // Track cost for this agent
  let cost = 0;
  const unsub = bus.subscribe((signal) => {
    if (signal.agentId !== agentId) return;
    if (signal.type === "cost") {
      cost = (signal.payload as Record<string, unknown>).totalCostUsd as number ?? 0;
    }
  });

  // Spawn
  const spawnOpts: SpawnOptions = {
    prompt,
    name: agentId,
    agent: opts.agent,
    model: opts.model,
    worktree: useWorktree,
    sandbox: opts.sandbox,
  };

  // Snapshot before task so we can restore on failure
  let preTaskSnapshotId: string | undefined;
  const snap = opts.snapshotDir ? await loadSnapshot() : null;
  if (snap && opts.snapshotDir) {
    await snap.init(opts.snapshotDir);
    const s = await snap.snapshot(opts.snapshotDir, { change: `pre-task-line-${task.line}`, summary: task.description.slice(0, 100) });
    preTaskSnapshotId = s.id;
  }

  try {
    const agent = await spawner.spawn(spawnOpts);
    const timeoutMs = opts.timeout * 1000;
    const result = await withTimeout(agent.process, agent.done, { timeoutMs });

    unsub();

    if (result.timedOut) {
      if (snap && opts.snapshotDir && preTaskSnapshotId) await snap.restore(opts.snapshotDir, preTaskSnapshotId);
      await failTask(tasksFile, task.line, `Timed out after ${opts.timeout}s`);
      console.log(`[mxit] Timed out: line ${task.line}`);
      return { task, status: "timed_out", exitCode: -1, agentId, costUsd: cost };
    }

    if (result.exitCode === 0) {
      // Snapshot successful state
      if (snap && opts.snapshotDir) await snap.snapshot(opts.snapshotDir, { change: `task-done-line-${task.line}`, summary: `Completed: ${task.description.slice(0, 80)}` });
      await completeTask(tasksFile, task.line, `agent ${agentId}`);
      console.log(`[mxit] Done: line ${task.line}`);
      return { task, status: "completed", exitCode: 0, agentId, costUsd: cost };
    }

    // Failed — restore pre-task state
    if (snap && opts.snapshotDir && preTaskSnapshotId) await snap.restore(opts.snapshotDir, preTaskSnapshotId);
    await failTask(tasksFile, task.line, `Exit code ${result.exitCode}`);
    console.log(`[mxit] Failed: line ${task.line} (exit ${result.exitCode})`);
    return { task, status: "failed", exitCode: result.exitCode, agentId, costUsd: cost };
  } catch (err) {
    unsub();
    if (snap && opts.snapshotDir && preTaskSnapshotId) await snap.restore(opts.snapshotDir, preTaskSnapshotId).catch(() => {});
    await failTask(tasksFile, task.line, String(err).slice(0, 100));
    console.log(`[mxit] Error: line ${task.line} — ${String(err).slice(0, 100)}`);
    return { task, status: "failed", exitCode: -1, agentId, costUsd: cost };
  }
}

/**
 * Process a batch of tasks in parallel.
 */
async function processBatch(
  tasks: Task[],
  tasksFile: string,
  bus: SignalBus,
  spawner: AgentSpawner,
  opts: ProcessOpts,
): Promise<TaskResult[]> {
  // Snapshot before batch so we can restore if ALL fail
  let preBatchSnapshotId: string | undefined;
  const snap = opts.snapshotDir ? await loadSnapshot() : null;
  if (snap && opts.snapshotDir) {
    await snap.init(opts.snapshotDir);
    const s = await snap.snapshot(opts.snapshotDir, {
      change: `pre-batch-${tasks.length}-tasks`,
      summary: `Snapshot before parallel batch of ${tasks.length} tasks`,
    });
    preBatchSnapshotId = s.id;
  }

  // Claim all tasks first
  for (const task of tasks) {
    const agentId = `mxit-${task.line}`;
    await claimTask(tasksFile, task.line, agentId);
    console.log(`[mxit] Claimed: line ${task.line} → ${task.description.slice(0, 60)}`);
  }

  // Spawn all agents
  const spawnedAgents = [];
  const costTrackers = new Map<string, { tracker: { cost: number }; unsub: () => void }>();

  for (const task of tasks) {
    const agentId = `mxit-${task.line}`;
    const prompt = buildTaskPrompt(task, tasksFile);
    const useWorktree = opts.worktree ?? (opts.agent === "claude");

    const tracker = { cost: 0 };
    const unsub = bus.subscribe((signal) => {
      if (signal.agentId !== agentId) return;
      if (signal.type === "cost") {
        tracker.cost = (signal.payload as Record<string, unknown>).totalCostUsd as number ?? 0;
      }
    });
    costTrackers.set(agentId, { tracker, unsub });

    const agent = await spawner.spawn({
      prompt,
      name: agentId,
      agent: opts.agent,
      model: opts.model,
      worktree: useWorktree,
      sandbox: opts.sandbox,
    });
    spawnedAgents.push({ task, agent, agentId });
  }

  // Wait for all with timeout
  const timeoutMs = opts.timeout * 1000;
  const settled = await Promise.allSettled(
    spawnedAgents.map(({ agent }) =>
      withTimeout(agent.process, agent.done, { timeoutMs })
    ),
  );

  // Collect results and update TASKS.md
  const results: TaskResult[] = [];

  for (let i = 0; i < spawnedAgents.length; i++) {
    const { task, agentId } = spawnedAgents[i];
    const entry = costTrackers.get(agentId)!;
    entry.unsub();
    const cost = entry.tracker.cost;
    const s = settled[i];

    if (s.status === "rejected") {
      await failTask(tasksFile, task.line, String(s.reason).slice(0, 100));
      results.push({ task, status: "failed", exitCode: -1, agentId, costUsd: cost });
      continue;
    }

    const result = s.value;
    if (result.timedOut) {
      await failTask(tasksFile, task.line, `Timed out after ${opts.timeout}s`);
      results.push({ task, status: "timed_out", exitCode: -1, agentId, costUsd: cost });
    } else if (result.exitCode === 0) {
      await completeTask(tasksFile, task.line, `agent ${agentId}`);
      results.push({ task, status: "completed", exitCode: 0, agentId, costUsd: cost });
    } else {
      await failTask(tasksFile, task.line, `Exit code ${result.exitCode}`);
      results.push({ task, status: "failed", exitCode: result.exitCode, agentId, costUsd: cost });
    }
  }

  // Snapshot after batch: restore if ALL failed, snapshot success otherwise
  const allFailed = results.every(r => r.status !== "completed");
  if (allFailed && snap && opts.snapshotDir && preBatchSnapshotId) {
    await snap.restore(opts.snapshotDir, preBatchSnapshotId);
  } else if (!allFailed && snap && opts.snapshotDir) {
    const doneCount = results.filter(r => r.status === "completed").length;
    await snap.snapshot(opts.snapshotDir, {
      change: `batch-done-${doneCount}-of-${results.length}`,
      summary: results.filter(r => r.status === "completed").map(r => r.task.description.slice(0, 40)).join(", "),
    });
  }

  return results;
}
