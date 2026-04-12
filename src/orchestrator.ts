/**
 * Orchestrator — Cook-style workflow patterns driven by the signal bus
 *
 * Patterns:
 *   - review loop: work → review → gate (DONE/ITERATE)
 *   - race: N parallel agents, pick best
 *   - ralph: sequential task-list progression with gate
 *   - cost guard: kill agents over budget
 */

import { join } from "https://deno.land/std/path/mod.ts";
import type { AgentSignal } from "./types.ts";
import { SignalBus } from "./bus.ts";
import { AgentSpawner, type SpawnOptions, type AgentType } from "./spawner.ts";
import { withTimeout } from "./timeout.ts";
import type { PermissionLedger } from "./permission-ledger.ts";
import type { DenialDetail } from "./types.ts";
// Lazy-loaded snapshot functions — only resolved when snapshotDir is provided.
// This avoids hard dependency on @snapshot/core for tests that import orchestrator directly.
async function loadSnapshot() {
  try {
    const mod = await import("@snapshot/core");
    return { init: mod.init, snapshot: mod.snapshot, restore: mod.restore };
  } catch (err) {
    console.warn(`[snapshot] @snapshot/core not available: ${String(err).slice(0, 100)}. Continuing without snapshots.`);
    return null;
  }
}

/** Entries we never copy between worktrees and the project dir — git
 *  metadata, build artefacts, expo/refine state that would clobber the
 *  caller's setup. Matches the excludes used inside @snapshot/core. */
const SYNC_EXCLUDES = new Set([
  ".git", ".claude", ".refine", ".expo", ".DS_Store",
  "node_modules", "dist", "build", "target", ".next", ".nuxt",
  ".cache", "__pycache__", ".venv", "venv", ".svelte-kit", ".turbo",
]);

function isExcluded(name: string): boolean {
  return SYNC_EXCLUDES.has(name) || name.endsWith(".pyc");
}

/** Recursively copy `src` into `dest`, skipping excluded names. Creates
 *  dest directories as needed. Used by race() to copy a winner's worktree
 *  state into the caller's snapshotDir before snapshotting — otherwise
 *  snapshot() would just capture the unchanged pre-race state. */
async function copyDirRecursive(src: string, dest: string): Promise<void> {
  for await (const entry of Deno.readDir(src)) {
    if (isExcluded(entry.name)) continue;
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory) {
      await Deno.mkdir(destPath, { recursive: true }).catch(() => {});
      await copyDirRecursive(srcPath, destPath);
    } else if (entry.isSymlink) {
      // Preserve symlinks rather than dereferencing them.
      const target = await Deno.readLink(srcPath);
      await Deno.remove(destPath).catch(() => {});
      await Deno.symlink(target, destPath);
    } else {
      await Deno.copyFile(srcPath, destPath);
    }
  }
}

/** Replace the contents of `dest` with the contents of `src`, respecting
 *  excludes. First deletes non-excluded entries in dest, then copies from
 *  src. Used when race picks a winner whose changes live in an isolated
 *  worktree — we need those changes in the caller's project dir before
 *  snapshotting, or the "winner snapshot" is a lie. */
async function syncWorktreeIntoDir(src: string, dest: string): Promise<void> {
  // 1. Remove non-excluded entries from dest
  for await (const entry of Deno.readDir(dest)) {
    if (isExcluded(entry.name)) continue;
    await Deno.remove(join(dest, entry.name), { recursive: true }).catch(() => {});
  }
  // 2. Copy non-excluded entries from src into dest
  await copyDirRecursive(src, dest);
}

// --- Review Loop ---

export interface ReviewLoopOptions {
  /** The work prompt */
  workPrompt: string;
  /** Review prompt (default: check for issues) */
  reviewPrompt?: string;
  /** Gate prompt (default: DONE if no High issues, else ITERATE) */
  gatePrompt?: string;
  /** Max iterations (default: 3) */
  maxIterations?: number;
  /** Agent name prefix */
  name?: string;
  /** Model override (applies to both work and review unless overridden) */
  model?: string;
  /** Use worktrees (default: false for review loops) */
  worktree?: boolean;
  /** Timeout per agent in seconds (0 = no timeout, default: 600) */
  timeout?: number;
  /** Agent type for work step (default: "claude") */
  workAgent?: AgentType;
  /** Model for work step (overrides model) */
  workModel?: string;
  /** Agent type for review step (default: "claude") */
  reviewAgent?: AgentType;
  /** Model for review step (overrides model) */
  reviewModel?: string;
  /** Directory to snapshot before each iteration (restore on ITERATE) */
  snapshotDir?: string;
}

const DEFAULT_REVIEW_PROMPT = `Review the work done by the previous agent. Check for bugs, missing edge cases, and code quality issues. Categorize issues as High, Medium, or Low severity. Be specific about what needs fixing.`;

const DEFAULT_GATE_PROMPT = `Based on the review, respond with exactly one of these lines as the FIRST non-empty line:
  VERDICT: DONE      (the work is complete and no High severity issues remain)
  VERDICT: ITERATE   (there are High severity issues or the work is incomplete)
You may follow the verdict line with a brief reason on subsequent lines.
A bare "DONE" or "ITERATE" at the start of a line is also accepted.
Any other format will be treated as a parse failure and halt the loop.`;

export interface ReviewLoopResult {
  verdict: "DONE" | "ITERATE" | "MAX_ITERATIONS" | "UNCLEAR";
  iterations: number;
  lastOutput: string;
  totalCostUsd: number;
  /** Set when verdict === "UNCLEAR": the gate output that failed to parse. */
  unclearReason?: string;
}

export async function reviewLoop(
  bus: SignalBus,
  spawner: AgentSpawner,
  opts: ReviewLoopOptions,
): Promise<ReviewLoopResult> {
  const max = opts.maxIterations ?? 3;
  const prefix = opts.name ?? "review";
  const reviewPrompt = opts.reviewPrompt ?? DEFAULT_REVIEW_PROMPT;
  const gatePrompt = opts.gatePrompt ?? DEFAULT_GATE_PROMPT;

  let lastOutput = "";
  let totalCost = 0;
  let iteration = 0;

  // Snapshot setup — snapshot baseline before any work
  let lastSnapshotId: string | undefined;
  const snap = opts.snapshotDir ? await loadSnapshot() : null;
  if (snap && opts.snapshotDir) {
    await snap.init(opts.snapshotDir);
    const s = await snap.snapshot(opts.snapshotDir, { change: "pre-review baseline", summary: "Snapshot before review loop" });
    lastSnapshotId = s.id;
  }

  for (iteration = 1; iteration <= max; iteration++) {
    // Snapshot before each iteration so we can roll back on ITERATE
    if (snap && opts.snapshotDir && iteration > 1) {
      const s = await snap.snapshot(opts.snapshotDir, { change: `pre-iteration-${iteration}`, summary: `Snapshot before review iteration ${iteration}` });
      lastSnapshotId = s.id;
    }

    // --- Work step ---
    const workName = `${prefix}-work-${iteration}`;
    const workPrompt =
      iteration === 1
        ? opts.workPrompt
        : `${opts.workPrompt}\n\nPrevious review feedback:\n${lastOutput}`;

    const workResult = await spawnAndWait(bus, spawner, {
      prompt: workPrompt,
      name: workName,
      agent: opts.workAgent,
      model: opts.workModel ?? opts.model,
      worktree: opts.worktree ?? false,
      timeout: opts.timeout,
    });
    totalCost += workResult.cost;

    // --- Review step ---
    const reviewName = `${prefix}-review-${iteration}`;
    const reviewResult = await spawnAndWait(bus, spawner, {
      prompt: `${reviewPrompt}\n\nThe work agent's output:\n${workResult.output}`,
      name: reviewName,
      agent: opts.reviewAgent,
      model: opts.reviewModel ?? opts.model,
      worktree: false,
      timeout: opts.timeout,
    });
    totalCost += reviewResult.cost;

    // --- Gate decision ---
    const verdict = parseGateVerdict(
      reviewResult.output,
      gatePrompt,
    );
    lastOutput = reviewResult.output;

    if (verdict === "DONE") {
      // Snapshot the successful state
      if (snap && opts.snapshotDir) {
        await snap.snapshot(opts.snapshotDir, { change: `review-done-iter-${iteration}`, summary: "Review loop converged" });
      }
      return { verdict: "DONE", iterations: iteration, lastOutput, totalCostUsd: totalCost };
    }
    if (verdict === "UNCLEAR") {
      // Gate output didn't contain an explicit DONE/ITERATE — halt instead of
      // silently progressing so the caller can see the parse failure.
      if (snap && opts.snapshotDir && lastSnapshotId) {
        await snap.restore(opts.snapshotDir, lastSnapshotId);
      }
      return {
        verdict: "UNCLEAR",
        iterations: iteration,
        lastOutput,
        totalCostUsd: totalCost,
        unclearReason: reviewResult.output.slice(0, 500),
      };
    }
    // ITERATE — restore to pre-iteration state so bad changes don't accumulate
    if (snap && opts.snapshotDir && lastSnapshotId) {
      await snap.restore(opts.snapshotDir, lastSnapshotId);
    }
  }

  return {
    verdict: "MAX_ITERATIONS",
    iterations: max,
    lastOutput,
    totalCostUsd: totalCost,
  };
}

// --- Race ---

export interface RaceOptions {
  /** Prompts for each branch (same prompt = race, different = vs) */
  prompts: string[];
  /** Criteria for picking the winner */
  criteria?: string;
  /** Agent name prefix */
  name?: string;
  /** Model override */
  model?: string;
  /** Use worktrees (default: true for races) */
  worktree?: boolean;
  /** Timeout per branch in seconds (0 = no timeout, default: 600) */
  timeout?: number;
  /** Directory to snapshot before race, restore winner's state after */
  snapshotDir?: string;
}

export interface RaceResult {
  winner: number; // 0-indexed, -1 if no winner
  winnerOutput: string;
  allOutputs: string[];
  totalCostUsd: number;
  judgeReasoning: string;
  /**
   * True only when a judge was consulted AND its output parsed as a valid
   * PICK verdict. False for auto-winners (only one branch succeeded),
   * all-failed results, or when the judge's output was unparseable and a
   * fallback branch was chosen. Lets callers branch on genuine vs default picks.
   */
  pickParsed: boolean;
  /**
   * Human-readable reason the winner was NOT a parsed judge pick. Present
   * whenever `pickParsed` is false (including no-winner and auto-winner
   * cases); absent when the judge produced a parseable verdict.
   */
  fallbackReason?: string;
}

/**
 * Resolve a race winner from judge output. Pure function so it can be tested
 * without spawning real agents.
 *
 * @param judgeOutput  Raw text returned by the judge agent.
 * @param successIndices 0-indexed list of branches that exited 0, in original order.
 * @param n            Total number of branches (max valid PICK value).
 * @returns winner index plus parse provenance. `pickParsed: false` means the
 *   judge output did not contain a `PICK <n>` line in range and we defaulted
 *   to the first successful branch. Callers must gate trust accordingly.
 */
export function resolveRaceWinner(
  judgeOutput: string,
  successIndices: number[],
  n: number,
): { winner: number; pickParsed: boolean; fallbackReason?: string } {
  const winnerNum = parsePickVerdict(judgeOutput, n);
  if (winnerNum >= 0) {
    return { winner: winnerNum, pickParsed: true };
  }
  return {
    winner: successIndices[0],
    pickParsed: false,
    fallbackReason:
      "judge output did not contain a parseable PICK <n> verdict in range; defaulted to first successful branch",
  };
}

export async function race(
  bus: SignalBus,
  spawner: AgentSpawner,
  opts: RaceOptions,
): Promise<RaceResult> {
  const prefix = opts.name ?? "race";
  const n = opts.prompts.length;

  // Snapshot baseline before race
  let preRaceSnapshotId: string | undefined;
  const snap = opts.snapshotDir ? await loadSnapshot() : null;
  if (snap && opts.snapshotDir) {
    await snap.init(opts.snapshotDir);
    const s = await snap.snapshot(opts.snapshotDir, { change: "pre-race baseline", summary: `Snapshot before ${n}-way race` });
    preRaceSnapshotId = s.id;
  }

  // Set up per-agent bus subscribers to capture output and cost
  const agentTrackers = new Map<string, { tracker: { output: string; cost: number }; unsub: () => void }>();
  for (let i = 0; i < n; i++) {
    const agentId = `${prefix}-branch-${i + 1}`;
    const tracker = { output: "", cost: 0 };
    const unsub = bus.subscribe((signal) => {
      if (signal.agentId !== agentId) return;
      if (signal.type === "output") {
        tracker.output += (signal.payload as Record<string, unknown>).text ?? "";
      }
      if (signal.type === "done") {
        const result = (signal.payload as Record<string, unknown>).result;
        if (typeof result === "string") tracker.output = result;
      }
      if (signal.type === "cost") {
        tracker.cost = (signal.payload as Record<string, unknown>).totalCostUsd as number ?? 0;
      }
    });
    agentTrackers.set(agentId, { tracker, unsub });
  }

  // Spawn all branches in parallel
  const spawnOpts: SpawnOptions[] = opts.prompts.map((prompt, i) => ({
    prompt,
    name: `${prefix}-branch-${i + 1}`,
    model: opts.model,
    worktree: opts.worktree ?? true,
  }));

  const agents = await spawner.spawnAll(spawnOpts);
  const timeoutMs = (opts.timeout ?? 600) * 1000;
  const results = await Promise.allSettled(
    agents.map((a) => withTimeout(a.process, a.done, { timeoutMs })),
  );

  // Collect outputs, costs, and unsubscribe
  const outputs: string[] = [];
  let totalCost = 0;

  for (let i = 0; i < agents.length; i++) {
    const entry = agentTrackers.get(agents[i].agentId);
    if (entry) {
      entry.unsub();
      outputs.push(entry.tracker.output || `Branch ${i + 1}: ${results[i].status === "fulfilled" ? "completed" : "failed"}`);
      totalCost += entry.tracker.cost;
    } else {
      outputs.push(`Branch ${i + 1}: ${results[i].status === "fulfilled" ? "completed" : "failed"}`);
    }
  }

  // If only one succeeded, auto-pick
  const successIndices = results
    .map((r, i) => (r.status === "fulfilled" && r.value.exitCode === 0 ? i : -1))
    .filter((i) => i >= 0);

  if (successIndices.length === 0) {
    // All failed — restore pre-race state
    if (snap && opts.snapshotDir && preRaceSnapshotId) {
      await snap.restore(opts.snapshotDir, preRaceSnapshotId);
    }
    return {
      winner: -1,
      winnerOutput: "",
      allOutputs: outputs,
      totalCostUsd: totalCost,
      judgeReasoning: "All branches failed",
      pickParsed: false,
      fallbackReason: "all branches failed; no judge consulted",
    };
  }

  if (successIndices.length === 1) {
    // Auto-winner. Before returning, materialize the winner's worktree
    // into snapshotDir so the caller sees the winner's actual changes —
    // otherwise the project dir stays at its pre-race state and any
    // snapshot we'd take would capture the wrong files.
    const winnerIdx = successIndices[0];
    if (snap && opts.snapshotDir) {
      const winnerWt = spawner.getRegistry().get(agents[winnerIdx].agentId)?.worktreePath;
      if (winnerWt) {
        await syncWorktreeIntoDir(winnerWt, opts.snapshotDir);
        await snap.snapshot(opts.snapshotDir, {
          change: `race-winner-branch-${winnerIdx + 1}`,
          summary: `Auto-winner (only branch ${winnerIdx + 1} succeeded)`,
        });
      }
    }
    return {
      winner: winnerIdx,
      winnerOutput: outputs[winnerIdx],
      allOutputs: outputs,
      totalCostUsd: totalCost,
      judgeReasoning: `Only branch ${winnerIdx + 1} succeeded`,
      pickParsed: false,
      fallbackReason: `only branch ${winnerIdx + 1} succeeded; no judge consulted`,
    };
  }

  // Spawn a judge to pick the winner
  const criteria = opts.criteria ?? "best overall quality";
  const judgePrompt = `You are judging ${n} parallel implementations. Pick the best one.

Criteria: ${criteria}

${outputs.map((o, i) => `--- Branch ${i + 1} ---\n${o}`).join("\n\n")}

Respond with PICK <number> (1-indexed) on the first line, followed by your reasoning.`;

  const judgeResult = await spawnAndWait(bus, spawner, {
    prompt: judgePrompt,
    name: `${prefix}-judge`,
    model: opts.model,
    worktree: false,
    timeout: opts.timeout,
  });
  totalCost += judgeResult.cost;

  const resolved = resolveRaceWinner(judgeResult.output, successIndices, n);
  const winner = resolved.winner;

  // Snapshot winner's state. Winner branches run in isolated worktrees,
  // so we must copy the winner's files into snapshotDir BEFORE snapshot —
  // otherwise snapshotDir is still at the pre-race baseline and we'd
  // capture the wrong files.
  if (snap && opts.snapshotDir) {
    const winnerWt = spawner.getRegistry().get(agents[winner].agentId)?.worktreePath;
    if (winnerWt) {
      await syncWorktreeIntoDir(winnerWt, opts.snapshotDir);
    }
    await snap.snapshot(opts.snapshotDir, {
      change: `race-winner-branch-${winner + 1}`,
      summary: judgeResult.output.slice(0, 200),
    });
  }

  return {
    winner,
    winnerOutput: outputs[winner] ?? "",
    allOutputs: outputs,
    totalCostUsd: totalCost,
    judgeReasoning: judgeResult.output,
    pickParsed: resolved.pickParsed,
    fallbackReason: resolved.fallbackReason,
  };
}

// --- Ralph (task-list progression) ---

export interface RalphOptions {
  /** Work prompt — should be self-directing (e.g. "do the next task in PLAN.md") */
  workPrompt: string;
  /** Ralph gate prompt — must contain DONE/NEXT logic */
  gatePrompt: string;
  /** Max tasks to process (default: 10) */
  maxTasks?: number;
  /** Wrap each task in a review loop? */
  review?: boolean;
  /** Review options if review=true */
  reviewMaxIterations?: number;
  /** Agent name prefix */
  name?: string;
  model?: string;
  worktree?: boolean;
  /** Timeout per agent in seconds (0 = no timeout, default: 600) */
  timeout?: number;
}

export interface RalphResult {
  verdict: "DONE" | "MAX_TASKS" | "UNCLEAR";
  tasksCompleted: number;
  totalCostUsd: number;
  lastOutput: string;
  /** Set when verdict === "UNCLEAR": the gate output that failed to parse. */
  unclearReason?: string;
}

export async function ralph(
  bus: SignalBus,
  spawner: AgentSpawner,
  opts: RalphOptions,
): Promise<RalphResult> {
  const maxTasks = opts.maxTasks ?? 10;
  const prefix = opts.name ?? "ralph";
  let totalCost = 0;
  let lastOutput = "";

  for (let task = 1; task <= maxTasks; task++) {
    // --- Work (optionally with review loop) ---
    if (opts.review) {
      const reviewResult = await reviewLoop(bus, spawner, {
        workPrompt: opts.workPrompt,
        maxIterations: opts.reviewMaxIterations ?? 3,
        name: `${prefix}-task-${task}`,
        model: opts.model,
        worktree: opts.worktree,
        timeout: opts.timeout,
      });
      totalCost += reviewResult.totalCostUsd;
      lastOutput = reviewResult.lastOutput;

      if (reviewResult.verdict === "MAX_ITERATIONS") {
        // Inner loop didn't converge — stop ralph
        return {
          verdict: "MAX_TASKS",
          tasksCompleted: task - 1,
          totalCostUsd: totalCost,
          lastOutput,
        };
      }
      if (reviewResult.verdict === "UNCLEAR") {
        // Inner review gate failed to parse — propagate as terminal failure
        return {
          verdict: "UNCLEAR",
          tasksCompleted: task - 1,
          totalCostUsd: totalCost,
          lastOutput,
          unclearReason: reviewResult.unclearReason,
        };
      }
    } else {
      const workResult = await spawnAndWait(bus, spawner, {
        prompt: opts.workPrompt,
        name: `${prefix}-task-${task}`,
        model: opts.model,
        worktree: opts.worktree ?? false,
        timeout: opts.timeout,
      });
      totalCost += workResult.cost;
      lastOutput = workResult.output;
    }

    // --- Ralph gate ---
    const gateResult = await spawnAndWait(bus, spawner, {
      prompt: `${opts.gatePrompt}\n\nLast task output:\n${lastOutput}`,
      name: `${prefix}-gate-${task}`,
      model: opts.model,
      worktree: false,
      timeout: opts.timeout,
    });
    totalCost += gateResult.cost;

    const verdict = parseRalphVerdict(gateResult.output);
    if (verdict === "DONE") {
      return { verdict: "DONE", tasksCompleted: task, totalCostUsd: totalCost, lastOutput };
    }
    if (verdict === "UNCLEAR") {
      // Gate output didn't contain an explicit DONE/NEXT — halt instead of
      // silently continuing so the caller can see the parse failure.
      return {
        verdict: "UNCLEAR",
        tasksCompleted: task,
        totalCostUsd: totalCost,
        lastOutput,
        unclearReason: gateResult.output.slice(0, 500),
      };
    }
    // NEXT — continue to next task
  }

  return { verdict: "MAX_TASKS", tasksCompleted: maxTasks, totalCostUsd: totalCost, lastOutput };
}

// --- Escalation ---

export type EscalationHandler = (signal: AgentSignal, context: {
  agentId: string;
  reason: string;
  failCount: number;
}) => void | Promise<void>;

export interface EscalationOptions {
  /** How many consecutive failures before escalating (default: 2) */
  failThreshold?: number;
  /** Handler called on escalation */
  onEscalate: EscalationHandler;
}

export function escalationRouter(
  bus: SignalBus,
  opts: EscalationOptions,
): () => void {
  const failCounts = new Map<string, number>();
  const threshold = opts.failThreshold ?? 2;

  return bus.subscribe(async (signal) => {
    if (signal.type === "failed") {
      const count = (failCounts.get(signal.agentId) ?? 0) + 1;
      failCounts.set(signal.agentId, count);

      if (count >= threshold) {
        const reason = (signal.payload as Record<string, unknown>).error as string ?? "Unknown failure";
        await opts.onEscalate(signal, {
          agentId: signal.agentId,
          reason,
          failCount: count,
        });
      }
    }

    // Reset on success
    if (signal.type === "done") {
      failCounts.delete(signal.agentId);
    }
  });
}

// --- Cost Guard ---

export interface CostGuardOptions {
  /** Max cost per agent in USD */
  perAgentBudget?: number;
  /** Max total cost in USD */
  totalBudget?: number;
  /** When provided, overrun triggers actual kill of the offending agent
   *  (per-agent) or all running agents (total). Without spawner the guard
   *  is advisory-only (warns to stderr). Always pass the spawner when
   *  running unattended — warnings alone don't stop the spend. */
  spawner?: AgentSpawner;
}

/** Signal emitted on the bus when a budget is exceeded. Consumers
 *  (orchestrators, CI scripts, monitoring) should watch for this and
 *  treat it as a terminal condition — distinct from an agent's own
 *  `failed` signal. */
export interface BudgetExceededPayload {
  kind: "per-agent" | "total";
  agentId?: string; // set for per-agent overruns
  cost: number; // the cost that triggered
  limit: number; // the budget that was exceeded
  total: number; // accumulated cost across all agents
  killed: boolean; // whether we actually killed; false when spawner wasn't provided
}

export function costGuard(
  bus: SignalBus,
  opts: CostGuardOptions,
): () => void {
  const perAgent = new Map<string, number>();
  let total = 0;
  // Guard against double-fire: once total-exceeded triggers, we kill
  // every agent and stop checking. Further cost signals from in-flight
  // processes shouldn't re-trigger the kill cascade.
  let totalExceededFired = false;
  const perAgentExceededFired = new Set<string>();

  return bus.subscribe(async (signal) => {
    if (signal.type !== "cost") return;

    const cost = (signal.payload as Record<string, unknown>).totalCostUsd as number ?? 0;
    perAgent.set(signal.agentId, cost);
    total = Array.from(perAgent.values()).reduce((a, b) => a + b, 0);

    // Per-agent overrun: kill just this agent.
    if (
      opts.perAgentBudget &&
      cost > opts.perAgentBudget &&
      !perAgentExceededFired.has(signal.agentId)
    ) {
      perAgentExceededFired.add(signal.agentId);
      console.warn(
        `[cost-guard] ${signal.agentId}: $${cost.toFixed(4)} exceeds per-agent budget $${opts.perAgentBudget} — killing`,
      );
      let killed = false;
      if (opts.spawner) {
        killed = await opts.spawner.killAgent(
          signal.agentId,
          `budget exceeded ($${cost.toFixed(4)} > $${opts.perAgentBudget})`,
        );
      }
      await bus.emit({
        agentId: signal.agentId,
        sessionId: signal.sessionId,
        timestamp: Date.now(),
        type: "failed",
        payload: {
          error: `budget_exceeded: per-agent $${cost.toFixed(4)} > $${opts.perAgentBudget}`,
          budgetExceeded: {
            kind: "per-agent",
            agentId: signal.agentId,
            cost,
            limit: opts.perAgentBudget,
            total,
            killed,
          } satisfies BudgetExceededPayload,
        },
      }).catch(() => {}); // best-effort — process is being killed
    }

    // Total overrun: kill everything. Fatal for the run.
    if (opts.totalBudget && total > opts.totalBudget && !totalExceededFired) {
      totalExceededFired = true;
      console.warn(
        `[cost-guard] Total $${total.toFixed(4)} exceeds budget $${opts.totalBudget} — killing all running agents`,
      );
      let killedCount = 0;
      if (opts.spawner) {
        killedCount = await opts.spawner.killAllRunning(
          `total budget exceeded ($${total.toFixed(4)} > $${opts.totalBudget})`,
        );
      }
      await bus.emit({
        agentId: signal.agentId,
        sessionId: signal.sessionId,
        timestamp: Date.now(),
        type: "failed",
        payload: {
          error: `budget_exceeded: total $${total.toFixed(4)} > $${opts.totalBudget}`,
          budgetExceeded: {
            kind: "total",
            cost,
            limit: opts.totalBudget,
            total,
            killed: killedCount > 0,
          } satisfies BudgetExceededPayload,
        },
      }).catch(() => {});
    }
  });
}

// --- Helpers ---

export interface SpawnResult {
  output: string;
  cost: number;
  exitCode: number;
  timedOut: boolean;
  permissionDenials: string[];
  denialDetails: DenialDetail[];
}

export async function spawnAndWait(
  bus: SignalBus,
  spawner: AgentSpawner,
  opts: SpawnOptions & { worktree?: boolean; ledger?: PermissionLedger },
): Promise<SpawnResult> {
  let output = "";
  let cost = 0;
  const permissionDenials: string[] = [];
  const denialDetails: DenialDetail[] = [];
  const agentId = opts.name;

  // Subscribe to capture this agent's output
  const unsub = bus.subscribe((signal) => {
    if (signal.agentId !== agentId) return;
    if (signal.type === "output") {
      output += (signal.payload as Record<string, unknown>).text ?? "";
    }
    if (signal.type === "done") {
      const p = signal.payload as Record<string, unknown>;
      const result = p.result;
      if (typeof result === "string") output = result;
      const denials = p.permissionDenials as string[] | undefined;
      if (denials) permissionDenials.push(...denials);
      const details = p.denialDetails as DenialDetail[] | undefined;
      if (details) denialDetails.push(...details);
    }
    if (signal.type === "failed") {
      const p = signal.payload as Record<string, unknown>;
      const denials = p.permissionDenials as string[] | undefined;
      if (denials) permissionDenials.push(...denials);
      const details = p.denialDetails as DenialDetail[] | undefined;
      if (details) denialDetails.push(...details);
    }
    if (signal.type === "cost") {
      cost = (signal.payload as Record<string, unknown>).totalCostUsd as number ?? 0;
    }
  });

  const agent = await spawner.spawn({
    ...opts,
    worktree: opts.worktree ?? false,
  });

  const timeoutMs = (opts.timeout ?? 600) * 1000;
  const result = await withTimeout(agent.process, agent.done, { timeoutMs });

  if (result.timedOut) {
    await bus.emit({
      agentId,
      sessionId: agent.sessionId,
      timestamp: Date.now(),
      type: "failed",
      payload: { error: `Agent timed out after ${opts.timeout ?? 600}s`, exitCode: -1, timedOut: true },
    }).catch(() => {});
  }

  unsub();

  // Record denials in the ledger if provided
  if (opts.ledger && permissionDenials.length > 0) {
    opts.ledger.recordDenials(permissionDenials, opts.name, denialDetails);
  }

  // Post-job validation: run a shell command to sanity-check the result
  let validationFailed: string | undefined;
  if (opts.validateCommand && result.exitCode === 0 && !result.timedOut) {
    try {
      const validate = new Deno.Command("sh", {
        args: ["-c", opts.validateCommand],
        cwd: opts.cwd ?? Deno.cwd(),
        stdout: "piped",
        stderr: "piped",
      });
      const vResult = await validate.output();
      if (!vResult.success) {
        const stderr = new TextDecoder().decode(vResult.stderr).trim();
        validationFailed = `Validation failed (exit ${vResult.code}): ${opts.validateCommand}${stderr ? ` — ${stderr}` : ""}`;
      }
    } catch (err) {
      validationFailed = `Validation error: ${String(err).slice(0, 200)}`;
    }
  }

  return {
    output: validationFailed ? `${output}\n\n[validation] ${validationFailed}` : output,
    cost,
    exitCode: validationFailed ? 1 : result.exitCode,
    timedOut: result.timedOut,
    permissionDenials,
    denialDetails,
  };
}

// Strict verdict parsers — require an explicit `VERDICT: <X>` or bare `<X>`
// at the start of a line. Returns "UNCLEAR" when no well-formed verdict is
// found so the orchestrator can halt with a parse failure rather than
// silently defaulting (and e.g. treating chatty prose containing "looks good"
// or "continue" as a verdict).
function parseGateVerdict(output: string, _gatePrompt: string): "DONE" | "ITERATE" | "UNCLEAR" {
  for (const line of output.split("\n")) {
    const trimmed = line.trim().toUpperCase();
    const m = trimmed.match(/^(?:VERDICT\s*:\s*)?(DONE|ITERATE)\b/);
    if (m) return m[1] as "DONE" | "ITERATE";
  }
  return "UNCLEAR";
}

function parseRalphVerdict(output: string): "DONE" | "NEXT" | "UNCLEAR" {
  for (const line of output.split("\n")) {
    const trimmed = line.trim().toUpperCase();
    const m = trimmed.match(/^(?:VERDICT\s*:\s*)?(DONE|NEXT)\b/);
    if (m) return m[1] as "DONE" | "NEXT";
  }
  return "UNCLEAR";
}

function parsePickVerdict(output: string, maxN: number): number {
  for (const line of output.split("\n")) {
    const match = line.match(/PICK\s+(\d+)/i);
    if (match) {
      const n = parseInt(match[1]) - 1; // 0-indexed
      if (n >= 0 && n < maxN) return n;
    }
  }
  return -1;
}
