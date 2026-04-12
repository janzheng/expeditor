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
  addGate,
  collectGates,
  discard,
  init,
  list,
  listGates,
  removeGate,
  restore,
  snapshot,
  tree,
} from "@snapshot/core";
import type { Gate, Variant } from "@snapshot/core";

// ── Types ──────────────────────────────────────────────────────

export interface RefineOptions {
  /** Directory to refine */
  dir: string;
  /** Rubric — inline string or contents of a rubric file */
  rubric?: string;
  /** Max iterations (default: 10) */
  maxIterations?: number;
  // (removed: `continue?: boolean` — threaded through but never read;
  //  refine already resumes correctly when `.refine/manifest.json`
  //  exists, because the loop only snapshots baseline on empty archive.)
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
  /** Initial gates to attach to the baseline variant. Inherited by all descendants.
   *  Use for project-wide invariants like `deno test` or `deno check`. */
  gates?: Array<{ name: string; command: string; rationale?: string }>;
  /** If true, the agent may propose new gates via GATE_PROPOSAL lines.
   *  Off by default — the feature is opt-in so runs stay comparable. */
  allowAgentGates?: boolean;
  /** Timeout (seconds) for each gate command. Default: 60. */
  gateTimeout?: number;
}

export interface RefineResult {
  verdict: "CONVERGED" | "MAX_ITERATIONS" | "EXHAUSTED";
  iterations: number;
  totalCostUsd: number;
  keptVariants: number;
  discardedVariants: number;
  finalVariantId: string;
  /** Count of times an inherited gate forced a discard. */
  gateFailures: number;
  /** Count of gates the agent proposed (0 if `allowAgentGates` is off). */
  gatesProposed: number;
}

interface GateProposal {
  name: string;
  command: string;
  rationale?: string;
}

interface ParsedVerdict {
  action: "keep" | "discard" | "converged";
  change: string;
  summary: string;
  /** Any GATE_PROPOSAL lines the agent emitted. Only used when
   *  allowAgentGates is true; otherwise ignored. */
  gateProposals: GateProposal[];
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

  // 2b. Seed baseline gates from opts.gates, if provided and not already present.
  //     These inherit to every descendant — perfect for project-wide invariants
  //     like `deno test` or a type-check command.
  if (opts.gates && opts.gates.length > 0) {
    const baseline = variants.find((v) => v.status === "baseline");
    if (baseline) {
      const existing = new Set((await listGates(dir, baseline.id)).map((g) => g.name));
      for (const g of opts.gates) {
        if (!existing.has(g.name)) {
          await addGate(dir, baseline.id, g);
        }
      }
    }
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

  // Counters for the result summary
  let gateFailures = 0;
  let gatesProposed = 0;
  const gateTimeoutMs = (opts.gateTimeout ?? 60) * 1000;

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
    const inheritedGates = await collectGates(dir, currentParentId);
    const prompt = buildRefinePrompt({
      rubric: opts.rubric,
      heuristics: refineHeuristics,
      archiveContext,
      iteration: iterations,
      maxIterations,
      dir,
      inheritedGates,
      allowAgentGates: opts.allowAgentGates ?? false,
    });

    // b. Snapshot of working-tree "dirty" paths BEFORE agent spawn.
    //    Used after the agent returns to compute which paths the agent
    //    actually touched, so snapshot() stages only those instead of
    //    sweeping up concurrent uncommitted work via `git add -A`.
    //    Best-effort — any failure (not a git repo, etc.) just skips the
    //    scoping and we fall back to the old -A behaviour.
    const preAgentDirty = await listDirtyPaths(dir);

    // c. Spawn agent
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

    // d. Compute agent-scoped paths by diffing post-agent dirty set
    //    against pre-agent dirty set. Any path newly dirty (or still
    //    dirty with changed content, which this simple check doesn't
    //    detect — acceptable edge case for now) is the agent's work.
    const postAgentDirty = await listDirtyPaths(dir);
    const agentTouchedPaths = preAgentDirty && postAgentDirty
      ? [...postAgentDirty].filter((p) => !preAgentDirty.has(p))
      : undefined;

    // e. Parse verdict
    const verdict = parseVerdict(result.output);

    // Emit refine_verdict signal for dashboard tracking
    await emitRefineProgress(bus, agentName, iterations, `refine_verdict: ${verdict.action} — ${verdict.change}`, {
      refineVerdict: verdict.action,
      refineChange: verdict.change,
      refineSummary: verdict.summary,
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
        addPaths: agentTouchedPaths,
      });
      variants = await list(dir);
      finalVariantId = getLastKeptId(variants) ?? "000";

      // Update REFINE.md with session log
      await updateRefineMd(bus, spawner, dir, variants, opts);

      return buildResult("CONVERGED", iterations, totalCost, variants, finalVariantId, gateFailures, gatesProposed);
    }

    if (verdict.action === "keep") {
      // Run inherited gates BEFORE snapshotting. Any failure converts
      // this keep into a forced discard — the invariant ratchet wins
      // over the LLM's aesthetic judgment.
      const gateResult = await runInheritedGates(
        inheritedGates,
        { dir, variantId: currentParentId, timeoutMs: gateTimeoutMs },
      );

      if (!gateResult.ok) {
        gateFailures++;
        await emitRefineProgress(
          bus,
          agentName,
          iterations,
          `gate_failed: ${gateResult.failed!.name} (exit ${gateResult.failed!.exitCode}) — forcing discard`,
          {
            gateFailed: gateResult.failed!.name,
            gateExitCode: gateResult.failed!.exitCode,
          },
        );
        console.log(
          `[refine] gate '${gateResult.failed!.name}' failed (exit ${gateResult.failed!.exitCode}) — discarding iteration ${iterations}`,
        );

        // Restore to last kept, discard with gate-failure reason, and
        // potentially branch if the discard streak hit the limit.
        const outcome = await recordDiscardAndMaybeBranch(dir, variants, discardCounts, {
          change: verdict.change,
          summary: `gate_failed:${gateResult.failed!.name} — ${verdict.summary}`.slice(0, 300),
        });
        if (outcome === "exhausted") {
          variants = await list(dir);
          await updateRefineMd(bus, spawner, dir, variants, opts);
          return buildResult("EXHAUSTED", iterations, totalCost, variants, finalVariantId, gateFailures, gatesProposed);
        }

        continue;
      }

      // Snapshot the kept state. Pass the agent's touched-paths so the
      // commit scope stays clean — any work a concurrent writer did
      // during the agent's execution stays in the working tree and is
      // NOT swept into the refine/NNN commit.
      await snapshot(dir, {
        change: verdict.change,
        summary: verdict.summary,
        addPaths: agentTouchedPaths,
      });
      variants = await list(dir);
      finalVariantId = getLastKeptId(variants) ?? "000";

      // Attach any agent-proposed gates to the newly kept variant.
      // Only honoured when allowAgentGates is true; we already filtered
      // in parseVerdict to an empty array otherwise.
      if (opts.allowAgentGates && verdict.gateProposals.length > 0) {
        gatesProposed += await attachProposedGates(bus, dir, finalVariantId, verdict.gateProposals, {
          agentName,
          iteration: iterations,
        });
      }

      // Reset consecutive discard count for this lineage
      discardCounts.set(finalVariantId, 0);
    } else {
      const outcome = await recordDiscardAndMaybeBranch(dir, variants, discardCounts, {
        change: verdict.change,
        summary: verdict.summary,
      });
      if (outcome === "exhausted") {
        variants = await list(dir);
        await updateRefineMd(bus, spawner, dir, variants, opts);
        return buildResult("EXHAUSTED", iterations, totalCost, variants, finalVariantId, gateFailures, gatesProposed);
      }
    }
  }

  // Max iterations reached
  variants = await list(dir);
  finalVariantId = getLastKeptId(variants) ?? "000";
  await updateRefineMd(bus, spawner, dir, variants, opts);
  return buildResult("MAX_ITERATIONS", iterations, totalCost, variants, finalVariantId, gateFailures, gatesProposed);
}

/** Emit a status-kind progress signal with refine-loop context. Collapses
 *  the repeated agentId/sessionId/timestamp/type boilerplate so call sites
 *  only carry what's actually unique to the event. */
async function emitRefineProgress(
  bus: SignalBus,
  agentName: string,
  iteration: number,
  message: string,
  extras: Record<string, unknown> = {},
): Promise<void> {
  await bus.emit({
    agentId: agentName,
    sessionId: crypto.randomUUID(),
    timestamp: Date.now(),
    type: "progress",
    payload: { kind: "status", message, iteration, ...extras },
  });
}

/** Attach agent-proposed gates to a newly-kept variant. Emits a progress
 *  signal and logs per successful attach; failures are logged and skipped
 *  so one bad proposal doesn't abort the others. Returns the number of
 *  gates actually attached. */
async function attachProposedGates(
  bus: SignalBus,
  dir: string,
  variantId: string,
  proposals: GateProposal[],
  ctx: { agentName: string; iteration: number },
): Promise<number> {
  let added = 0;
  for (const proposal of proposals) {
    try {
      await addGate(dir, variantId, proposal);
      added++;
      await emitRefineProgress(
        bus,
        ctx.agentName,
        ctx.iteration,
        `gate_added: ${proposal.name} on ${variantId}`,
        { gateAdded: proposal.name, gateCommand: proposal.command },
      );
      console.log(
        `[refine] agent added gate '${proposal.name}' on ${variantId}: ${proposal.command.slice(0, 80)}`,
      );
    } catch (err) {
      console.error(
        `[refine] failed to add gate '${proposal.name}': ${String(err).slice(0, 200)}`,
      );
    }
  }
  return added;
}

// ── Gate runner ────────────────────────────────────────────────

interface GateFailure {
  name: string;
  exitCode: number;
  stderr: string;
}

interface GateRunResult {
  ok: boolean;
  failed?: GateFailure;
}

/** Escape a string for safe interpolation into a `sh -c` command. We
 *  single-quote, and close/reopen the quote around any embedded single
 *  quote. The result is always safe to splice into double-quoted
 *  positions in a shell command, as long as the placeholder itself is
 *  already inside a quoted context in the user's command. */
function shellEscape(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Run inherited gates one at a time against the current state of `dir`.
 *  Short-circuits on the first failure — there's no value in running the
 *  rest if one already says the candidate is unacceptable.
 *
 *  On timeout, sends SIGKILL to the whole process group so long-running
 *  grandchildren (e.g. `deno test` spawned inside `sh -c`) also die. We
 *  achieve this via a `setsid` prefix so the shell becomes a session
 *  leader with its own PGID. */
async function runInheritedGates(
  gates: Gate[],
  opts: { dir: string; variantId: string; timeoutMs: number },
): Promise<GateRunResult> {
  for (const gate of gates) {
    // Placeholders are shell-escaped before substitution so that dirs
    // containing spaces or shell metacharacters don't cause command
    // corruption or injection.
    const cmd = gate.command
      .replaceAll("{dir}", shellEscape(opts.dir))
      .replaceAll("{variantId}", shellEscape(opts.variantId));

    // setsid puts the shell in a new session (and new process group),
    // so we can kill the whole tree on timeout. Falls back to plain
    // `sh` if setsid isn't available.
    const hasSetsid = await commandExists("setsid");
    const proc = hasSetsid
      ? new Deno.Command("setsid", {
          args: ["sh", "-c", cmd],
          cwd: opts.dir,
          stdout: "piped",
          stderr: "piped",
        }).spawn()
      : new Deno.Command("sh", {
          args: ["-c", cmd],
          cwd: opts.dir,
          stdout: "piped",
          stderr: "piped",
        }).spawn();

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (hasSetsid) {
        // Negative pid = kill the process group. Requires setsid to have
        // made the shell a session leader.
        try {
          new Deno.Command("kill", {
            args: ["-KILL", `-${proc.pid}`],
            stdout: "null",
            stderr: "null",
          }).outputSync();
        } catch { /* group already gone */ }
      } else {
        try { proc.kill("SIGKILL"); } catch { /* already exited */ }
      }
    }, opts.timeoutMs);

    let output;
    try {
      output = await proc.output();
    } finally {
      clearTimeout(timer);
    }

    if (!output.success) {
      const stderr = new TextDecoder().decode(output.stderr).slice(0, 500);
      return {
        ok: false,
        failed: {
          name: gate.name,
          exitCode: timedOut ? -1 : output.code,
          stderr: timedOut ? "timeout" : stderr,
        },
      };
    }
  }
  return { ok: true };
}

/** Cheap check for whether a command is on PATH. Cached per-process. */
const _cmdExistsCache = new Map<string, boolean>();
async function commandExists(name: string): Promise<boolean> {
  if (_cmdExistsCache.has(name)) return _cmdExistsCache.get(name)!;
  try {
    const out = await new Deno.Command("sh", {
      args: ["-c", `command -v ${name}`],
      stdout: "null",
      stderr: "null",
    }).output();
    const found = out.success;
    _cmdExistsCache.set(name, found);
    return found;
  } catch {
    _cmdExistsCache.set(name, false);
    return false;
  }
}

// ── Prompt building ────────────────────────────────────────────

interface PromptContext {
  rubric?: string;
  heuristics: string;
  archiveContext: string;
  iteration: number;
  maxIterations: number;
  dir: string;
  inheritedGates: Gate[];
  allowAgentGates: boolean;
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

  if (ctx.inheritedGates.length > 0) {
    parts.push("## Inherited gates (invariants your change MUST preserve)");
    parts.push(
      "These commands will run automatically after your change. If any exits non-zero, your change will be auto-discarded regardless of the rubric. Make sure your change doesn't break any of them.",
    );
    parts.push("");
    for (const g of ctx.inheritedGates) {
      const rationale = g.rationale ? ` — ${g.rationale}` : "";
      parts.push(`- **${g.name}**: \`${g.command}\`${rationale}`);
    }
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

  if (ctx.allowAgentGates) {
    parts.push("");
    parts.push("## Optional: proposing a gate");
    parts.push("");
    parts.push(
      "If your KEEP change fixes a fragile behavior that descendants should NEVER regress, you MAY propose a gate. A gate is a shell command that will run before every future variant on this lineage; any non-zero exit auto-discards that variant.",
    );
    parts.push("");
    parts.push("Add one or more GATE_PROPOSAL lines before your VERDICT block, in JSON:");
    parts.push("");
    parts.push("```");
    parts.push(
      'GATE_PROPOSAL: {"name": "auth_tests", "command": "deno test tests/auth/", "rationale": "spent 3 iterations; easy to regress"}',
    );
    parts.push("```");
    parts.push("");
    parts.push("Propose gates ONLY for non-negotiable behaviors. Do NOT gate every passing test — that over-constrains the search. Only propose on KEEP verdicts. Gates can use `{dir}` and `{variantId}` placeholders.");
  }

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

// Exported for unit testing only — not part of the public API.
export function parseVerdict(output: string): ParsedVerdict {
  // Try to find structured verdict in the output
  const lines = output.split("\n");

  let action: "keep" | "discard" | "converged" | null = null;
  let change = "";
  let summary = "";
  const gateProposals: GateProposal[] = [];

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

    // Match GATE_PROPOSAL: {...}
    const gateMatch = trimmed.match(/^GATE_PROPOSAL:\s*(.+)$/i);
    if (gateMatch) {
      const proposal = parseGateProposalLine(gateMatch[1]);
      if (proposal) gateProposals.push(proposal);
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

  return { action, change, summary, gateProposals };
}

/** Parse a single GATE_PROPOSAL line payload. Returns null on any error
 *  so a malformed proposal just gets silently ignored instead of crashing
 *  the whole refine loop. */
function parseGateProposalLine(payload: string): GateProposal | null {
  try {
    const parsed = JSON.parse(payload);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.name !== "string" ||
      typeof parsed.command !== "string" ||
      parsed.name.length === 0 ||
      parsed.command.length === 0
    ) {
      return null;
    }
    const proposal: GateProposal = {
      name: parsed.name,
      command: parsed.command,
    };
    if (typeof parsed.rationale === "string" && parsed.rationale.length > 0) {
      proposal.rationale = parsed.rationale;
    }
    return proposal;
  } catch {
    return null;
  }
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
 * Restore to the last kept state, log a discard, bump the consecutive-discard
 * counter for that parent lineage, and — if the streak hit the limit — either
 * branch to the best under-explored variant or signal exhaustion.
 *
 * Returns "exhausted" when the caller should break out of the refine loop;
 * "continue" when the loop should proceed to the next iteration.
 */
async function recordDiscardAndMaybeBranch(
  dir: string,
  variants: Variant[],
  discardCounts: Map<string, number>,
  entry: { change: string; summary: string },
): Promise<"continue" | "exhausted"> {
  const lastKeptId = getLastKeptId(variants);
  if (lastKeptId) {
    await restore(dir, lastKeptId);
  }
  await discard(dir, entry);

  const parentKey = lastKeptId || "root";
  const count = (discardCounts.get(parentKey) ?? 0) + 1;
  discardCounts.set(parentKey, count);

  if (count < MAX_CONSECUTIVE_DISCARDS) return "continue";

  const fresh = await list(dir);
  const branchTarget = findBestUnderExplored(fresh, parentKey);
  if (!branchTarget) return "exhausted";

  console.log(
    `[refine] ${count} consecutive discards on ${parentKey} — branching to ${branchTarget.id} (${branchTarget.change})`,
  );
  await restore(dir, branchTarget.id);
  discardCounts.set(parentKey, 0);
  return "continue";
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
  gateFailures: number,
  gatesProposed: number,
): RefineResult {
  return {
    verdict,
    iterations,
    totalCostUsd,
    keptVariants: variants.filter((v) => v.status === "kept" || v.status === "baseline").length,
    discardedVariants: variants.filter((v) => v.status === "discarded").length,
    finalVariantId,
    gateFailures,
    gatesProposed,
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

// ── Gate subcommand helpers (for `expo refine <dir> gate ...`) ──

/** Print every gate in the archive, showing where each is directly attached
 *  and which variants inherit it. When variantId is given, only show gates
 *  that variant sees (direct + inherited). */
export async function showRefineGates(dir: string, variantId?: string): Promise<void> {
  try {
    await init(dir);
    const variants = await list(dir);

    if (variants.length === 0) {
      console.log("No refinement sessions found.");
      return;
    }

    if (variantId) {
      const target = variants.find((v) => v.id === variantId);
      if (!target) {
        console.error(`Variant ${variantId} not found.`);
        Deno.exit(1);
      }
      const direct = await listGates(dir, variantId);
      const inherited = await collectGates(dir, variantId);
      const directNames = new Set(direct.map((g) => g.name));

      console.log(`Gates visible to variant [${variantId}] (${target.change || target.summary || ""}):`);
      if (inherited.length === 0) {
        console.log("  (none)");
        return;
      }
      for (const g of inherited) {
        const source = directNames.has(g.name) ? "direct" : `inherited from [${g.addedBy}]`;
        console.log(`  • ${g.name} (${source})`);
        console.log(`      command: ${g.command}`);
        if (g.rationale) console.log(`      why:     ${g.rationale}`);
      }
      return;
    }

    // No variantId — show gates across the whole archive, grouped by where
    // each was added.
    let total = 0;
    for (const v of variants) {
      const gates = v.gates ?? [];
      if (gates.length === 0) continue;
      total += gates.length;
      console.log(`[${v.id}] ${v.status} — ${v.change || v.summary || ""}`);
      for (const g of gates) {
        console.log(`  • ${g.name}: ${g.command}`);
        if (g.rationale) console.log(`      why: ${g.rationale}`);
      }
    }
    if (total === 0) {
      console.log("No gates in this archive. Use `expo refine <dir> gate add <variant> --name N --command C` to add one.");
    } else {
      console.log(`\n${total} gate${total === 1 ? "" : "s"} across ${variants.length} variant${variants.length === 1 ? "" : "s"}.`);
    }
  } catch (err) {
    console.error(`[refine] Failed to list gates: ${String(err).slice(0, 200)}`);
    Deno.exit(1);
  }
}

/** CLI wrapper around addGate with useful error messages. */
export async function addRefineGate(
  dir: string,
  variantId: string,
  gate: { name: string; command: string; rationale?: string },
): Promise<void> {
  try {
    await init(dir);
    const added = await addGate(dir, variantId, gate);
    console.log(`✓ Added gate '${added.name}' to [${variantId}]`);
    console.log(`  command: ${added.command}`);
    if (added.rationale) console.log(`  why:     ${added.rationale}`);
  } catch (err) {
    console.error(`[refine] Failed to add gate: ${String(err).slice(0, 200)}`);
    Deno.exit(1);
  }
}

/** CLI wrapper around removeGate. */
export async function removeRefineGate(
  dir: string,
  variantId: string,
  name: string,
): Promise<void> {
  try {
    await init(dir);
    await removeGate(dir, variantId, name);
    console.log(`✓ Removed gate '${name}' from [${variantId}]`);
  } catch (err) {
    console.error(`[refine] Failed to remove gate: ${String(err).slice(0, 200)}`);
    Deno.exit(1);
  }
}

/** Run `git status --porcelain` and return the set of dirty/untracked
 *  paths, relative to `dir`. Returns null when the command fails (not a
 *  git repo, git missing) so callers can fall back to unscoped staging.
 *
 *  Porcelain format: `XY<space><path>` where XY are two status chars.
 *  Rename lines also include ` -> <newpath>`; we strip that and keep
 *  only the rename destination since that's what the agent produced. */
async function listDirtyPaths(dir: string): Promise<Set<string> | null> {
  try {
    const proc = await new Deno.Command("git", {
      args: ["status", "--porcelain"],
      cwd: dir,
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!proc.success) return null;
    const out = new TextDecoder().decode(proc.stdout);
    const paths = new Set<string>();
    for (const line of out.split("\n")) {
      if (line.length < 4) continue; // empty or too short to be XY<sp>path
      const rest = line.slice(3); // drop the 3-char status prefix
      // Handle rename arrows: `old -> new`; keep the new path
      const arrowIdx = rest.indexOf(" -> ");
      paths.add(arrowIdx >= 0 ? rest.slice(arrowIdx + 4) : rest);
    }
    return paths;
  } catch {
    return null;
  }
}
