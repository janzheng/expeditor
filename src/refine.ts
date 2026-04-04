/**
 * Expeditor — Archive-Based Refinement Loop (DGM-H inspired)
 *
 * Implements `expo refine <dir>` — an iterative refinement loop that uses
 * @snapshot/core for filesystem snapshots and REFINE.md for cross-session learning.
 *
 * The loop: snapshot baseline → agent refines → verdict (keep/discard/converged) →
 * snapshot or restore → repeat until converged, exhausted, or max iterations.
 *
 * On 3 consecutive discards in a lineage, branches to the best under-explored variant.
 */

import { SignalBus } from "./bus.ts";
import { AgentSpawner, type AgentType } from "./spawner.ts";
import { spawnAndWait } from "./orchestrator.ts";
import {
  init,
  snapshot,
  restore,
  list,
  tree,
  discard,
} from "@snapshot/core";
import type { Variant } from "@snapshot/core";

// ── Types ──────────────────────────────────────────────────────

export interface RefineOptions {
  /** Directory to refine */
  dir: string;
  /** Rubric — inline string or contents of a rubric file */
  rubric?: string;
  /** Max iterations (default: 10) */
  maxIterations?: number;
  /** Continue a previous session */
  continue?: boolean;
  /** Branch from a specific variant ID */
  branchFrom?: string;
  /** Interactive mode — human approves between iterations */
  interactive?: boolean;
  /** Agent name prefix */
  name?: string;
  /** Model override */
  model?: string;
  /** Agent type */
  agent?: AgentType;
  /** Timeout per iteration in seconds */
  timeout?: number;
  /** Sandbox preset */
  sandbox?: string;
}

export interface RefineResult {
  verdict: "CONVERGED" | "MAX_ITERATIONS" | "EXHAUSTED";
  iterations: number;
  totalCostUsd: number;
  keptVariants: number;
  discardedVariants: number;
  finalVariantId: string;
}

interface ParsedVerdict {
  action: "keep" | "discard" | "converged";
  change: string;
  summary: string;
}

// ── Constants ──────────────────────────────────────────────────

const MAX_CONSECUTIVE_DISCARDS = 3;
const ARCHIVE_CONTEXT_COUNT = 5;
const REFINE_MD = "REFINE.md";

/** Read a single line from stdin (for interactive mode) */
async function readStdinLine(): Promise<string> {
  const buf = new Uint8Array(256);
  const n = await Deno.stdin.read(buf);
  if (n === null) return "";
  return new TextDecoder().decode(buf.subarray(0, n)).trim();
}

// ── Main refine loop ───────────────────────────────────────────

export async function refine(
  bus: SignalBus,
  spawner: AgentSpawner,
  opts: RefineOptions,
): Promise<RefineResult> {
  const dir = opts.dir;
  const maxIterations = opts.maxIterations ?? 10;
  const prefix = opts.name ?? "refine";
  let totalCost = 0;

  // 1. Init snapshot tracking
  await init(dir);

  // 2. Snapshot baseline if this is a fresh session (no variants yet)
  let variants = await list(dir);
  if (variants.length === 0) {
    await snapshot(dir, { change: "Initial state", summary: "Baseline snapshot before refinement" });
    variants = await list(dir);
  }

  // Handle --branchFrom: restore to that variant before starting
  if (opts.branchFrom) {
    const target = variants.find((v) => v.id === opts.branchFrom);
    if (!target) {
      throw new Error(`Variant ${opts.branchFrom} not found in archive`);
    }
    await restore(dir, opts.branchFrom);
  }

  // Read REFINE.md heuristics if it exists
  const refineHeuristics = await readRefinemd(dir);

  // Consecutive discard tracking: parentId → count
  const discardCounts = new Map<string, number>();

  let iterations = 0;
  let finalVariantId = getLastKeptId(variants) ?? "000";

  for (let i = 0; i < maxIterations; i++) {
    iterations = i + 1;

    // Refresh variant list
    variants = await list(dir);
    const currentParentId = getLastKeptId(variants) ?? "000";
    finalVariantId = currentParentId;

    // a. Build agent prompt
    const archiveContext = buildArchiveContext(variants);
    const prompt = buildRefinePrompt({
      rubric: opts.rubric,
      heuristics: refineHeuristics,
      archiveContext,
      iteration: iterations,
      maxIterations,
      dir,
    });

    // b. Spawn agent
    const agentName = `${prefix}-iter-${iterations}`;
    const result = await spawnAndWait(bus, spawner, {
      prompt,
      name: agentName,
      agent: opts.agent,
      model: opts.model,
      worktree: false,
      cwd: dir,
      timeout: opts.timeout,
      sandbox: opts.sandbox,
    });
    totalCost += result.cost;

    // c. Parse verdict
    const verdict = parseVerdict(result.output);

    // Emit refine_verdict signal for dashboard tracking
    await bus.emit({
      agentId: agentName,
      sessionId: crypto.randomUUID(),
      timestamp: Date.now(),
      type: "progress",
      payload: {
        kind: "status",
        message: `refine_verdict: ${verdict.action} — ${verdict.change}`,
        refineVerdict: verdict.action,
        refineChange: verdict.change,
        refineSummary: verdict.summary,
        iteration: iterations,
      },
    });

    // Interactive mode: prompt human for approval
    if (opts.interactive) {
      console.log(`\n--- Iteration ${iterations} ---`);
      console.log(`Verdict: ${verdict.action.toUpperCase()}`);
      console.log(`Change:  ${verdict.change}`);
      console.log(`Summary: ${verdict.summary}`);
      console.log(`\n[a]ccept / [d]iscard / [c]onverge / [q]uit (default: accept) > `);

      const override = await readStdinLine();
      const choice = override.trim().toLowerCase();

      if (choice === "q" || choice === "quit") {
        // User wants to stop — treat as converged
        verdict.action = "converged";
        verdict.summary = "User stopped refinement via interactive mode";
      } else if (choice === "d" || choice === "discard") {
        verdict.action = "discard";
        if (!verdict.summary) verdict.summary = "User overrode to discard";
      } else if (choice === "c" || choice === "converge" || choice === "converged") {
        verdict.action = "converged";
        if (!verdict.summary) verdict.summary = "User declared convergence";
      }
      // "a", "accept", or empty → keep the agent's verdict as-is
    }

    // d/e. Handle verdict
    if (verdict.action === "converged") {
      // Snapshot the converged state
      await snapshot(dir, {
        change: verdict.change || "Converged",
        summary: verdict.summary || "Agent declared convergence",
      });
      variants = await list(dir);
      finalVariantId = getLastKeptId(variants) ?? "000";

      // Update REFINE.md with session log
      await updateRefineMd(bus, spawner, dir, variants, opts);

      return buildResult("CONVERGED", iterations, totalCost, variants, finalVariantId);
    }

    if (verdict.action === "keep") {
      // Snapshot the kept state
      await snapshot(dir, {
        change: verdict.change,
        summary: verdict.summary,
      });
      variants = await list(dir);
      finalVariantId = getLastKeptId(variants) ?? "000";

      // Reset consecutive discard count for this lineage
      discardCounts.set(finalVariantId, 0);
    } else {
      // Discard: restore to last kept state and log the failure
      const lastKeptId = getLastKeptId(variants);
      if (lastKeptId) {
        await restore(dir, lastKeptId);
      }
      await discard(dir, {
        change: verdict.change,
        summary: verdict.summary,
      });

      // Track consecutive discards for this parent lineage
      const parentKey = lastKeptId || "root";
      const count = (discardCounts.get(parentKey) ?? 0) + 1;
      discardCounts.set(parentKey, count);

      // f/g. On 3 consecutive discards, branch to best under-explored variant
      if (count >= MAX_CONSECUTIVE_DISCARDS) {
        variants = await list(dir);
        const branchTarget = findBestUnderExplored(variants, parentKey);

        if (branchTarget) {
          console.log(
            `[refine] ${count} consecutive discards on ${parentKey} — branching to ${branchTarget.id} (${branchTarget.change})`,
          );
          await restore(dir, branchTarget.id);
          discardCounts.set(parentKey, 0); // Reset count for the old parent
        } else {
          // No under-explored variants — all branches exhausted
          await updateRefineMd(bus, spawner, dir, variants, opts);
          return buildResult("EXHAUSTED", iterations, totalCost, variants, finalVariantId);
        }
      }
    }
  }

  // Max iterations reached
  variants = await list(dir);
  finalVariantId = getLastKeptId(variants) ?? "000";
  await updateRefineMd(bus, spawner, dir, variants, opts);
  return buildResult("MAX_ITERATIONS", iterations, totalCost, variants, finalVariantId);
}

// ── Prompt building ────────────────────────────────────────────

interface PromptContext {
  rubric?: string;
  heuristics: string;
  archiveContext: string;
  iteration: number;
  maxIterations: number;
  dir: string;
}

function buildRefinePrompt(ctx: PromptContext): string {
  const parts: string[] = [];

  parts.push(`You are a refinement agent. Your job is to iteratively improve the project in: ${ctx.dir}`);
  parts.push(`This is iteration ${ctx.iteration} of ${ctx.maxIterations}.`);
  parts.push("");

  if (ctx.rubric) {
    parts.push("## Rubric");
    parts.push(ctx.rubric);
    parts.push("");
  }

  if (ctx.heuristics) {
    parts.push("## Heuristics from previous sessions (REFINE.md)");
    parts.push(ctx.heuristics);
    parts.push("");
  }

  if (ctx.archiveContext) {
    parts.push("## What has been tried so far");
    parts.push(ctx.archiveContext);
    parts.push("");
  }

  parts.push("## Instructions");
  parts.push("");
  parts.push("1. Examine the current state of the project");
  parts.push("2. Make ONE focused improvement based on the rubric");
  parts.push("3. Output your verdict in EXACTLY this format at the END of your response:");
  parts.push("");
  parts.push("```");
  parts.push("VERDICT: KEEP|DISCARD|CONVERGED");
  parts.push("CHANGE: <short description of what you changed>");
  parts.push("SUMMARY: <why this was kept/discarded, or why the project has converged>");
  parts.push("```");
  parts.push("");
  parts.push("Rules:");
  parts.push("- KEEP: You made a change that improves the project. The change will be snapshotted.");
  parts.push("- DISCARD: You attempted a change but it made things worse or didn't help. The change will be rolled back.");
  parts.push("- CONVERGED: The project meets the rubric criteria and no further improvements are needed.");
  parts.push("- Make exactly ONE focused change per iteration — do not try to fix everything at once.");
  parts.push("- If you are not sure whether a change helps, lean toward DISCARD so we can try a different approach.");

  return parts.join("\n");
}

function buildArchiveContext(variants: Variant[]): string {
  if (variants.length === 0) return "(no previous iterations)";

  // Show last N variants as one-liners
  const recent = variants.slice(-ARCHIVE_CONTEXT_COUNT);
  const lines = recent.map((v) => {
    const status = v.status === "discarded" ? "DISCARDED" : "KEPT";
    const desc = v.change || v.summary || "(no description)";
    return `- [${v.id}] ${status}: ${desc}`;
  });

  const keptCount = variants.filter((v) => v.status === "kept" || v.status === "baseline").length;
  const discardedCount = variants.filter((v) => v.status === "discarded").length;

  lines.unshift(`Archive: ${variants.length} variants total (${keptCount} kept, ${discardedCount} discarded)`);
  return lines.join("\n");
}

// ── Verdict parsing ────────────────────────────────────────────

function parseVerdict(output: string): ParsedVerdict {
  // Try to find structured verdict in the output
  const lines = output.split("\n");

  let action: "keep" | "discard" | "converged" | null = null;
  let change = "";
  let summary = "";

  for (const line of lines) {
    const trimmed = line.trim();

    // Match VERDICT: KEEP|DISCARD|CONVERGED
    const verdictMatch = trimmed.match(/^VERDICT:\s*(KEEP|DISCARD|CONVERGED)/i);
    if (verdictMatch) {
      const v = verdictMatch[1].toUpperCase();
      if (v === "KEEP") action = "keep";
      else if (v === "DISCARD") action = "discard";
      else if (v === "CONVERGED") action = "converged";
    }

    // Match CHANGE: ...
    const changeMatch = trimmed.match(/^CHANGE:\s*(.+)/i);
    if (changeMatch) {
      change = changeMatch[1].trim();
    }

    // Match SUMMARY: ...
    const summaryMatch = trimmed.match(/^SUMMARY:\s*(.+)/i);
    if (summaryMatch) {
      summary = summaryMatch[1].trim();
    }
  }

  // If no structured verdict found, default to DISCARD
  if (!action) {
    // Try to infer from the output
    const upper = output.toUpperCase();
    if (upper.includes("VERDICT: CONVERGED") || upper.includes("VERDICT:CONVERGED") || upper === "CONVERGED") {
      action = "converged";
    } else if (upper.includes("VERDICT: KEEP") || upper.includes("VERDICT:KEEP")) {
      action = "keep";
    } else {
      // Default to discard if unparseable — safe fallback
      action = "discard";
      if (!summary) {
        summary = "Could not parse agent verdict — defaulting to discard";
      }
    }
  }

  // If change is empty, try to extract something useful from the output
  if (!change) {
    change = extractFirstMeaningfulLine(output);
  }

  return { action, change, summary };
}

function extractFirstMeaningfulLine(output: string): string {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (
      trimmed.length > 10 &&
      !trimmed.startsWith("#") &&
      !trimmed.startsWith("```") &&
      !trimmed.startsWith("VERDICT") &&
      !trimmed.startsWith("CHANGE") &&
      !trimmed.startsWith("SUMMARY")
    ) {
      return trimmed.slice(0, 80);
    }
  }
  return "(no description)";
}

// ── Variant helpers ────────────────────────────────────────────

function getLastKeptId(variants: Variant[]): string | null {
  const kept = variants.filter((v) => v.status !== "discarded");
  return kept.at(-1)?.id ?? null;
}

/**
 * Find the best under-explored variant to branch to.
 * Prefers kept variants with fewest children, earlier ones breaking ties.
 * Excludes the current parent to avoid looping.
 */
function findBestUnderExplored(
  variants: Variant[],
  excludeParentId: string,
): Variant | null {
  const candidates = variants.filter(
    (v) => v.status !== "discarded" && v.id !== excludeParentId,
  );

  if (candidates.length === 0) return null;

  // Sort by fewest children first, then by id (earlier = lower)
  candidates.sort((a, b) => {
    if (a.children !== b.children) return a.children - b.children;
    return a.id.localeCompare(b.id);
  });

  return candidates[0];
}

// ── REFINE.md integration ──────────────────────────────────────

async function readRefinemd(dir: string): Promise<string> {
  try {
    const path = `${dir}/${REFINE_MD}`;
    return await Deno.readTextFile(path);
  } catch {
    return "";
  }
}

async function updateRefineMd(
  bus: SignalBus,
  spawner: AgentSpawner,
  dir: string,
  variants: Variant[],
  opts: RefineOptions,
): Promise<void> {
  const existingContent = await readRefinemd(dir);
  const sessionLog = buildSessionLog(variants);

  const prompt = `You are updating REFINE.md — a cross-session learning document for iterative refinement.

## Current REFINE.md
${existingContent || "(empty — this is the first session)"}

## This session's log
${sessionLog}

## Instructions
Update REFINE.md with:
1. A brief summary of what this session accomplished
2. Key heuristics learned (what worked, what didn't)
3. Suggestions for the next session
4. Keep the file concise — no more than ~100 lines total
5. Session log management: keep the last 3 session logs detailed, summarize older sessions into one-liners (e.g. "Session 1: 5 iterations, improved error handling, learned X")

Write the updated REFINE.md file to: ${dir}/${REFINE_MD}`;

  try {
    await spawnAndWait(bus, spawner, {
      prompt,
      name: `${opts.name ?? "refine"}-update-md`,
      agent: opts.agent,
      model: opts.model,
      worktree: false,
      cwd: dir,
      timeout: opts.timeout ?? 120,
      sandbox: opts.sandbox,
    });
  } catch (err) {
    console.error(`[refine] Failed to update REFINE.md: ${String(err).slice(0, 200)}`);
  }
}

function buildSessionLog(variants: Variant[]): string {
  if (variants.length === 0) return "(no variants)";

  const lines = variants.map((v) => {
    const status = v.status.toUpperCase();
    const desc = v.change || v.summary || "(no description)";
    return `- [${v.id}] ${status}: ${desc}${v.summary && v.change ? ` — ${v.summary}` : ""}`;
  });

  const keptCount = variants.filter((v) => v.status === "kept" || v.status === "baseline").length;
  const discardedCount = variants.filter((v) => v.status === "discarded").length;

  return [
    `Total: ${variants.length} variants (${keptCount} kept, ${discardedCount} discarded)`,
    "",
    ...lines,
  ].join("\n");
}

// ── Result builder ─────────────────────────────────────────────

function buildResult(
  verdict: "CONVERGED" | "MAX_ITERATIONS" | "EXHAUSTED",
  iterations: number,
  totalCostUsd: number,
  variants: Variant[],
  finalVariantId: string,
): RefineResult {
  return {
    verdict,
    iterations,
    totalCostUsd,
    keptVariants: variants.filter((v) => v.status === "kept" || v.status === "baseline").length,
    discardedVariants: variants.filter((v) => v.status === "discarded").length,
    finalVariantId,
  };
}

// ── Public helpers for CLI ─────────────────────────────────────

/** Print the archive tree for --tree flag */
export async function showRefineTree(dir: string): Promise<void> {
  try {
    await init(dir);
    const treeStr = await tree(dir);
    console.log(treeStr);
  } catch (err) {
    console.error(`[refine] Failed to show tree: ${String(err).slice(0, 200)}`);
  }
}

/** Print the archive status for --status flag */
export async function showRefineStatus(dir: string): Promise<void> {
  try {
    await init(dir);
    const variants = await list(dir);

    if (variants.length === 0) {
      console.log("No refinement sessions found.");
      return;
    }

    const keptCount = variants.filter((v) => v.status === "kept" || v.status === "baseline").length;
    const discardedCount = variants.filter((v) => v.status === "discarded").length;
    const lastKept = variants.filter((v) => v.status !== "discarded").at(-1);

    console.log(`Refinement archive for: ${dir}`);
    console.log(`  Variants: ${variants.length} total (${keptCount} kept, ${discardedCount} discarded)`);

    if (lastKept) {
      console.log(`  Current:  [${lastKept.id}] ${lastKept.change || lastKept.summary || "(no description)"}`);
      console.log(`  Since:    ${lastKept.timestamp}`);
    }

    // Show last few variants
    const recent = variants.slice(-5);
    console.log(`\n  Recent:`);
    for (const v of recent) {
      const status = v.status === "discarded" ? "DISC" : v.status === "baseline" ? "BASE" : "KEPT";
      const desc = v.change || v.summary || "";
      console.log(`    [${v.id}] ${status} ${desc.slice(0, 60)}`);
    }

    // Show .refine/ disk usage
    try {
      const cmd = new Deno.Command("du", { args: ["-sh", `${dir}/.refine`], stdout: "piped", stderr: "piped" });
      const out = await cmd.output();
      if (out.success) {
        const size = new TextDecoder().decode(out.stdout).split("\t")[0]?.trim() ?? "?";
        console.log(`\n  Disk:      ${size} (.refine/)`);
      }
    } catch { /* du not available */ }

    // Show REFINE.md existence
    try {
      await Deno.stat(`${dir}/${REFINE_MD}`);
      console.log(`  REFINE.md: exists`);
    } catch {
      console.log(`  REFINE.md: not yet created`);
    }
  } catch (err) {
    console.error(`[refine] Failed to show status: ${String(err).slice(0, 200)}`);
  }
}
