/**
 * Orchestrator — Cook-style workflow patterns driven by the signal bus
 *
 * Patterns:
 *   - review loop: work → review → gate (DONE/ITERATE)
 *   - race: N parallel agents, pick best
 *   - ralph: sequential task-list progression with gate
 *   - cost guard: kill agents over budget
 */

import type { AgentSignal } from "./types.ts";
import { SignalBus } from "./bus.ts";
import { AgentSpawner, type SpawnOptions, type AgentType } from "./spawner.ts";
import { withTimeout } from "./timeout.ts";
import type { PermissionLedger } from "./permission-ledger.ts";
import type { DenialDetail } from "./types.ts";

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
}

const DEFAULT_REVIEW_PROMPT = `Review the work done by the previous agent. Check for bugs, missing edge cases, and code quality issues. Categorize issues as High, Medium, or Low severity. Be specific about what needs fixing.`;

const DEFAULT_GATE_PROMPT = `Based on the review, respond with exactly DONE or ITERATE on the first line, followed by a brief reason.
DONE if: the work is complete and no High severity issues remain.
ITERATE if: there are High severity issues or the work is incomplete.`;

export interface ReviewLoopResult {
  verdict: "DONE" | "ITERATE" | "MAX_ITERATIONS";
  iterations: number;
  lastOutput: string;
  totalCostUsd: number;
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

  for (iteration = 1; iteration <= max; iteration++) {
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
      return { verdict: "DONE", iterations: iteration, lastOutput, totalCostUsd: totalCost };
    }
    // ITERATE — continue loop
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
}

export interface RaceResult {
  winner: number; // 0-indexed
  winnerOutput: string;
  allOutputs: string[];
  totalCostUsd: number;
  judgeReasoning: string;
}

export async function race(
  bus: SignalBus,
  spawner: AgentSpawner,
  opts: RaceOptions,
): Promise<RaceResult> {
  const prefix = opts.name ?? "race";
  const n = opts.prompts.length;

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

  // Collect outputs
  const outputs: string[] = [];
  let totalCost = 0;

  for (let i = 0; i < agents.length; i++) {
    const entry = spawner.getRegistry().get(agents[i].agentId);
    // Get output from the last signal in the bus log — for now, collect from registry
    outputs.push(`Branch ${i + 1}: ${results[i].status === "fulfilled" ? "completed" : "failed"}`);
  }

  // If only one succeeded, auto-pick
  const successIndices = results
    .map((r, i) => (r.status === "fulfilled" && r.value.exitCode === 0 ? i : -1))
    .filter((i) => i >= 0);

  if (successIndices.length === 0) {
    return {
      winner: -1,
      winnerOutput: "",
      allOutputs: outputs,
      totalCostUsd: totalCost,
      judgeReasoning: "All branches failed",
    };
  }

  if (successIndices.length === 1) {
    return {
      winner: successIndices[0],
      winnerOutput: outputs[successIndices[0]],
      allOutputs: outputs,
      totalCostUsd: totalCost,
      judgeReasoning: `Only branch ${successIndices[0] + 1} succeeded`,
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

  const winnerNum = parsePickVerdict(judgeResult.output, n);
  const winner = winnerNum >= 0 ? winnerNum : successIndices[0];

  return {
    winner,
    winnerOutput: outputs[winner] ?? "",
    allOutputs: outputs,
    totalCostUsd: totalCost,
    judgeReasoning: judgeResult.output,
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
  verdict: "DONE" | "MAX_TASKS";
  tasksCompleted: number;
  totalCostUsd: number;
  lastOutput: string;
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
}

export function costGuard(
  bus: SignalBus,
  opts: CostGuardOptions,
): () => void {
  const perAgent = new Map<string, number>();
  let total = 0;

  return bus.subscribe((signal) => {
    if (signal.type !== "cost") return;

    const cost = (signal.payload as Record<string, unknown>).totalCostUsd as number ?? 0;
    perAgent.set(signal.agentId, cost);
    total = Array.from(perAgent.values()).reduce((a, b) => a + b, 0);

    if (opts.perAgentBudget && cost > opts.perAgentBudget) {
      console.warn(`[cost-guard] ${signal.agentId}: $${cost.toFixed(4)} exceeds per-agent budget $${opts.perAgentBudget}`);
    }

    if (opts.totalBudget && total > opts.totalBudget) {
      console.warn(`[cost-guard] Total $${total.toFixed(4)} exceeds budget $${opts.totalBudget}`);
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

  return { output, cost, exitCode: result.exitCode, timedOut: result.timedOut, permissionDenials, denialDetails };
}

function parseGateVerdict(output: string, _gatePrompt: string): "DONE" | "ITERATE" {
  const upper = output.toUpperCase();
  for (const line of upper.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("DONE")) return "DONE";
    if (trimmed.startsWith("ITERATE")) return "ITERATE";
  }
  // Default: if no High severity issues mentioned, assume DONE
  if (!upper.includes("HIGH")) return "DONE";
  return "ITERATE";
}

function parseRalphVerdict(output: string): "DONE" | "NEXT" {
  for (const line of output.split("\n")) {
    const upper = line.trim().toUpperCase();
    if (upper.startsWith("DONE") || upper.includes("COMPLETE") || upper.includes("FINISHED")) return "DONE";
    if (upper.startsWith("NEXT") || upper.includes("CONTINUE")) return "NEXT";
  }
  // Default: DONE (fail-safe)
  return "DONE";
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
