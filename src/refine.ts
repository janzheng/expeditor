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

import { globToRegExp } from "https://deno.land/std/path/glob_to_regexp.ts";
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
  /** Wall-clock cap for the entire refine run in seconds.
   *  When hit, the loop stops before the next iteration, returns verdict
   *  `WALL_CLOCK_EXCEEDED`, and still runs the REFINE.md summary. The
   *  per-iteration `timeout` is also clamped to the remaining budget so
   *  an in-flight iteration can't overrun the wall clock by much.
   *  0 or undefined = no wall-clock cap (existing behaviour). */
  runTimeout?: number;
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
  /** Glob patterns (relative to `dir`) defining which paths the agent is
   *  allowed to modify. If set, any iteration that touches a file outside
   *  these patterns is force-discarded before the rubric judgment even
   *  runs. This is a HARD constraint, unlike rubric prose — rubric text
   *  is a suggestion to an intelligent reader; a scope pattern is a gate.
   *
   *  Example: `["src/workflow.ts", "tests/**"]` — agent may only touch
   *  those paths. Modifying src/cli.ts auto-discards.
   *
   *  Matched against paths returned by `git status --porcelain` during
   *  the agent run. Glob semantics match Deno std's `globToRegExp`. */
  scope?: string[];
}

export interface RefineResult {
  verdict: "CONVERGED" | "MAX_ITERATIONS" | "EXHAUSTED" | "WALL_CLOCK_EXCEEDED";
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

  // Gate-failure feedback ring: keep the last few gate-broken attempts so we
  // can feed them into the next prompt. Bounded to keep context usage small;
  // after this many failures the first-in gets dropped.
  const MAX_RECENT_FAILURES = 3;
  const recentFailures: RecentFailure[] = [];

  let iterations = 0;
  let finalVariantId = getLastKeptId(variants) ?? "000";

  // Wall-clock budget for the whole run (if --run-timeout was passed).
  // Per-iteration timeout is also clamped to the remaining budget so a
  // single stuck iteration can't overrun the wall clock arbitrarily.
  const runStartedAt = Date.now();
  const runTimeoutMs = (opts.runTimeout ?? 0) * 1000;
  const runDeadline = runTimeoutMs > 0 ? runStartedAt + runTimeoutMs : 0;

  for (let i = 0; i < maxIterations; i++) {
    iterations = i + 1;

    // Wall-clock check: stop before we even start the next iteration so
    // the orchestrating agent can reason about a clean upper bound.
    if (runDeadline > 0 && Date.now() >= runDeadline) {
      await emitRefineProgress(bus, prefix, iterations, `wall_clock_exceeded: ${opts.runTimeout}s`, {
        runTimeoutSec: opts.runTimeout,
        elapsedMs: Date.now() - runStartedAt,
      });
      variants = await list(dir);
      finalVariantId = getLastKeptId(variants) ?? "000";
      await updateRefineMd(bus, spawner, dir, variants, opts);
      return buildResult("WALL_CLOCK_EXCEEDED", iterations - 1, totalCost, variants, finalVariantId, gateFailures, gatesProposed);
    }

    // Refresh variant list
    variants = await list(dir);
    const currentParentId = getLastKeptId(variants) ?? "000";
    finalVariantId = currentParentId;

    // Clamp per-iteration timeout to remaining wall-clock budget so a long
    // single iteration can't drag the run much past --run-timeout.
    const baseIterTimeout = opts.timeout; // seconds
    let iterTimeout = baseIterTimeout;
    if (runDeadline > 0) {
      const remainingMs = Math.max(0, runDeadline - Date.now());
      const remainingSec = Math.ceil(remainingMs / 1000);
      if (remainingSec <= 0) {
        // Deadline passed during prep — loop back to the wall-clock check.
        continue;
      }
      iterTimeout = baseIterTimeout
        ? Math.min(baseIterTimeout, remainingSec)
        : remainingSec;
    }

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
      recentFailures: recentFailures.length > 0 ? [...recentFailures] : undefined,
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
      timeout: iterTimeout,
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
      // Scope check — if the caller set --scope patterns, any agent-touched
      // path outside the allowed globs force-discards this iteration BEFORE
      // we spend time running gates or snapshotting. Hard constraint, unlike
      // rubric prose.
      if (opts.scope && opts.scope.length > 0 && agentTouchedPaths && agentTouchedPaths.length > 0) {
        const violations = findScopeViolations(agentTouchedPaths, opts.scope);
        if (violations.length > 0) {
          gateFailures++;
          console.log(
            `[refine] scope violation — agent touched ${violations.length} file(s) outside --scope: ${violations.slice(0, 3).join(", ")}${violations.length > 3 ? ` (+${violations.length - 3} more)` : ""}`,
          );
          await emitRefineProgress(
            bus,
            agentName,
            iterations,
            `scope_violation: ${violations.length} path(s) outside allowed globs — forcing discard`,
            { scopeViolations: violations },
          );

          // Restore + record the discard + feed into branch-on-streak.
          const outcome = await recordDiscardAndMaybeBranch(dir, variants, discardCounts, {
            change: verdict.change,
            summary: `scope_violation: ${violations.slice(0, 5).join(", ")}`.slice(0, 300),
          });
          if (outcome === "exhausted") {
            variants = await list(dir);
            await updateRefineMd(bus, spawner, dir, variants, opts);
            return buildResult("EXHAUSTED", iterations, totalCost, variants, finalVariantId, gateFailures, gatesProposed);
          }
          continue;
        }
      }

      // Run inherited gates BEFORE snapshotting. Any failure converts
      // this keep into a forced discard — the invariant ratchet wins
      // over the LLM's aesthetic judgment.
      const gateResult = await runInheritedGates(
        inheritedGates,
        { dir, variantId: currentParentId, timeoutMs: gateTimeoutMs },
      );

      if (!gateResult.ok) {
        gateFailures++;
        // Memo this failure into the feedback ring so the next iteration's
        // prompt explicitly warns against repeating the same approach.
        const gateFailedName = gateResult.failed!.name;
        const gateExit = gateResult.failed!.exitCode;
        recentFailures.push({
          iteration: iterations,
          change: verdict.change.slice(0, 200),
          gateName: gateFailedName,
          reason: gateExit === -1 ? "timeout" : `exit ${gateExit}`,
        });
        if (recentFailures.length > MAX_RECENT_FAILURES) {
          recentFailures.shift();
        }

        await emitRefineProgress(
          bus,
          agentName,
          iterations,
          `gate_failed: ${gateFailedName} (exit ${gateExit}) — forcing discard`,
          {
            gateFailed: gateFailedName,
            gateExitCode: gateExit,
          },
        );
        console.log(
          `[refine] gate '${gateFailedName}' failed (exit ${gateExit}) — discarding iteration ${iterations}`,
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

      // A kept iteration moved the lineage forward — prior gate failures are
      // now about a different starting state, so clear the warning ring to
      // avoid misleading the next iteration. (Only clear on KEEP; the
      // rubric-discard path leaves us on the same lineage, so keeping the
      // failure memos there is still useful.)
      recentFailures.length = 0;

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

export interface PromptContext {
  rubric?: string;
  heuristics: string;
  archiveContext: string;
  iteration: number;
  maxIterations: number;
  dir: string;
  inheritedGates: Gate[];
  allowAgentGates: boolean;
  /** Recently-failed attempts the agent should NOT repeat. Empty on iter 1.
   *  Fed from recentGateFailures in the refine loop. */
  recentFailures?: RecentFailure[];
}

/** Gate-failure memo from a prior iteration, injected into the next prompt
 *  so the agent avoids re-proposing the same broken approach. */
export interface RecentFailure {
  /** Iteration number the failure happened on. */
  iteration: number;
  /** The change the agent attempted that broke a gate. */
  change: string;
  /** Which gate blocked the attempt. */
  gateName: string;
  /** Exit code / "timeout" for quick triage. */
  reason: string;
}

/** Exported for unit tests — the refine loop calls this to assemble every
 *  iteration's agent prompt. Test surface covers: gate-failure feedback
 *  rendering, heuristics inlining, archive-context formatting. */
export function buildRefinePrompt(ctx: PromptContext): string {
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

  // Gate-failure feedback: if recent iterations got discarded because they
  // tripped a gate, surface them here so the agent doesn't re-propose the
  // same broken approach. Bounded to the last few so the context stays small.
  if (ctx.recentFailures && ctx.recentFailures.length > 0) {
    parts.push("## Do NOT repeat these recently-failed approaches");
    parts.push(
      "Prior iterations attempted these changes; each broke an inherited gate and was rolled back. Pick a different approach — the fix is not in this direction.",
    );
    parts.push("");
    for (const f of ctx.recentFailures) {
      parts.push(`- iter ${f.iteration}: "${f.change}" → broke gate \`${f.gateName}\` (${f.reason})`);
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
  parts.push("<verdict>");
  parts.push("{");
  parts.push('  "action": "keep" | "discard" | "converged",');
  parts.push('  "change": "short description of what you changed",');
  parts.push('  "summary": "why this was kept/discarded, or why the project has converged"');
  if (ctx.allowAgentGates) {
    parts.push('  , "gate_proposals": [ /* optional — see below */ ]');
  }
  parts.push("}");
  parts.push("</verdict>");
  parts.push("```");
  parts.push("");
  parts.push("The `<verdict>` block must be valid JSON — no trailing commas, strings double-quoted. This is the primary grammar; the harness will fall back to the legacy line format (`VERDICT: KEEP` etc.) ONLY if the `<verdict>` block is missing or malformed, so prefer the fenced form.");
  parts.push("");
  parts.push("Rules:");
  parts.push("- keep: You made a change that improves the project. The change will be snapshotted.");
  parts.push("- discard: You attempted a change but it made things worse or didn't help. The change will be rolled back.");
  parts.push("- converged: The project meets the rubric criteria and no further improvements are needed.");
  parts.push("- Make exactly ONE focused change per iteration — do not try to fix everything at once.");
  parts.push("- If you are not sure whether a change helps, lean toward discard so we can try a different approach.");

  if (ctx.allowAgentGates) {
    parts.push("");
    parts.push("## Optional: proposing a gate");
    parts.push("");
    parts.push(
      "If your keep change fixes a fragile behavior that descendants should NEVER regress, you MAY propose a gate. A gate is a shell command that will run before every future variant on this lineage; any non-zero exit auto-discards that variant.",
    );
    parts.push("");
    parts.push('Add proposals to the `gate_proposals` array in the `<verdict>` block:');
    parts.push("");
    parts.push("```");
    parts.push("<verdict>");
    parts.push("{");
    parts.push('  "action": "keep",');
    parts.push('  "change": "fixed auth refresh",');
    parts.push('  "summary": "refresh flow was racy under load",');
    parts.push('  "gate_proposals": [');
    parts.push('    { "name": "auth_tests", "command": "deno test tests/auth/", "rationale": "easy to regress" }');
    parts.push('  ]');
    parts.push("}");
    parts.push("</verdict>");
    parts.push("```");
    parts.push("");
    parts.push("Propose gates ONLY for non-negotiable behaviors. Do NOT gate every passing test — that over-constrains the search. Only propose on keep verdicts. Gate commands can use `{dir}` and `{variantId}` placeholders.");
    parts.push("");
    parts.push("(Legacy fallback: `GATE_PROPOSAL: {...}` lines before a line-style VERDICT block still work, but the fenced form is preferred.)");
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
  // Prefer a fenced `<verdict>{...}</verdict>` block when present — it's an
  // unambiguous grammar that can't collide with prose the agent writes about
  // the verdict format itself (the line-based parser has had issues there).
  // Falls back to the legacy line grammar when no block is found OR the block
  // exists but its JSON doesn't parse.
  const fenced = tryParseFencedVerdict(output);
  if (fenced) return fenced;

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

/**
 * Look for a `<verdict>{...JSON...}</verdict>` block in `output` and parse it.
 *
 * Returns a ParsedVerdict when the block is present AND the JSON is valid;
 * returns null when the block is absent OR malformed (callers fall back to
 * the line grammar in that case). A malformed block logs a warning so the
 * failure doesn't vanish — the line parser then tries its luck on the same
 * output, which usually still finds a verdict.
 *
 * Expected JSON shape:
 *   {
 *     "action": "keep" | "discard" | "converged",
 *     "change": "short description",
 *     "summary": "why",
 *     "gate_proposals": [{ "name", "command", "rationale"? }]   // optional
 *   }
 *
 * If multiple `<verdict>` blocks appear, the LAST one wins — same convention
 * as the line parser. This lets an agent that self-corrects end with its
 * final answer without us having to strip earlier drafts.
 */
function tryParseFencedVerdict(output: string): ParsedVerdict | null {
  // Capture content inside the last <verdict>...</verdict> block. `[\s\S]` to
  // match across newlines; `*?` to be non-greedy so multiple blocks don't
  // glom together into one giant capture.
  const re = /<verdict>\s*([\s\S]*?)\s*<\/verdict>/gi;
  let lastMatch: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) lastMatch = m[1];
  if (lastMatch === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(lastMatch);
  } catch (err) {
    console.error(
      `[refine] <verdict> block present but JSON invalid — falling back to line grammar: ${String(err).slice(0, 100)}`,
    );
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    console.error(`[refine] <verdict> block is not a JSON object — falling back to line grammar`);
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const rawAction = typeof obj.action === "string" ? obj.action.toLowerCase() : "";
  let action: "keep" | "discard" | "converged";
  if (rawAction === "keep") action = "keep";
  else if (rawAction === "discard") action = "discard";
  else if (rawAction === "converged") action = "converged";
  else {
    console.error(
      `[refine] <verdict> action must be keep|discard|converged (got ${JSON.stringify(obj.action)}) — falling back`,
    );
    return null;
  }

  const change = typeof obj.change === "string" ? obj.change.trim() : "";
  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";

  // gate_proposals is optional; filter malformed entries silently (same
  // tolerance as the line parser) so one bad proposal doesn't nuke the rest.
  const gateProposals: GateProposal[] = [];
  if (Array.isArray(obj.gate_proposals)) {
    for (const p of obj.gate_proposals) {
      if (typeof p !== "object" || p === null) continue;
      const pr = p as Record<string, unknown>;
      if (typeof pr.name !== "string" || typeof pr.command !== "string") continue;
      if (pr.name.length === 0 || pr.command.length === 0) continue;
      const proposal: GateProposal = { name: pr.name, command: pr.command };
      if (typeof pr.rationale === "string" && pr.rationale.length > 0) {
        proposal.rationale = pr.rationale;
      }
      gateProposals.push(proposal);
    }
  }

  return {
    action,
    change: change || extractFirstMeaningfulLine(output),
    summary,
    gateProposals,
  };
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
  verdict: "CONVERGED" | "MAX_ITERATIONS" | "EXHAUSTED" | "WALL_CLOCK_EXCEEDED",
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

// ── Zero-config discovery (--auto) ─────────────────────────────

/** A defaults-bundle that `expo refine <dir> --auto` can apply in lieu of
 *  hand-passed `--rubric` / `--gate` flags. Surfaces what was detected so
 *  the CLI can tell the user and an orchestrating agent can verify before
 *  firing the loop. */
export interface AutoDiscovery {
  /** Short label: "deno" | "node" | "python" | "rust" | "go" | "make" | "unknown" */
  projectType: string;
  /** Gates to auto-seed on the baseline variant. Usually just one "tests" gate. */
  gates: Array<{ name: string; command: string; rationale?: string }>;
  /** A minimal, safe default rubric. The user can override with --rubric. */
  rubric: string;
  /** Per-file reasons for the picks — shown in the CLI summary so nothing
   *  is surprising. */
  reasons: string[];
}

/**
 * Inspect `dir` for common project-type markers and return sensible refine
 * defaults. Never throws — if nothing is detected, returns {projectType:
 * "unknown"} with an empty gates list and a generic rubric so `--auto` still
 * works on bare directories.
 *
 * Detection order (first match wins for the project type, but ALL matching
 * test commands get seeded as gates so polyglot repos are covered):
 *   1. deno.json with a `test` task
 *   2. package.json with a `test` script (skipped if it's the npm default
 *      "echo \"Error: no test specified\" && exit 1")
 *   3. pyproject.toml (pytest is the de-facto default)
 *   4. Cargo.toml → `cargo test`
 *   5. go.mod → `go test ./...`
 *   6. Makefile with a `test:` target → `make test`
 */
export async function discoverAutoDefaults(dir: string): Promise<AutoDiscovery> {
  const gates: AutoDiscovery["gates"] = [];
  const reasons: string[] = [];
  let primaryType = "unknown";

  // deno.json
  try {
    const raw = await Deno.readTextFile(`${dir}/deno.json`);
    try {
      const parsed = JSON.parse(raw);
      const tasks = parsed?.tasks as Record<string, string> | undefined;
      if (tasks && typeof tasks.test === "string" && tasks.test.trim()) {
        gates.push({
          name: "deno_test",
          command: "deno task test",
          rationale: "auto-detected from deno.json tasks.test",
        });
        reasons.push(`deno.json has tasks.test → seeded "deno_test" gate`);
        if (primaryType === "unknown") primaryType = "deno";
      } else {
        // Even without a test task, `deno check` on the project root is a
        // cheap invariant — broken TS stops being committed.
        gates.push({
          name: "deno_check",
          command: "deno check **/*.ts",
          rationale: "auto-detected from deno.json (no tasks.test — using deno check)",
        });
        reasons.push(`deno.json found but no tasks.test → seeded "deno_check"`);
        if (primaryType === "unknown") primaryType = "deno";
      }
    } catch {
      reasons.push(`deno.json present but unparseable — skipping`);
    }
  } catch { /* no deno.json */ }

  // package.json
  try {
    const raw = await Deno.readTextFile(`${dir}/package.json`);
    try {
      const parsed = JSON.parse(raw);
      const scripts = parsed?.scripts as Record<string, string> | undefined;
      const testScript = scripts?.test;
      const isNpmDefault = testScript &&
        /no test specified/i.test(testScript);
      if (testScript && !isNpmDefault) {
        gates.push({
          name: "npm_test",
          command: "npm test",
          rationale: "auto-detected from package.json scripts.test",
        });
        reasons.push(`package.json has scripts.test → seeded "npm_test" gate`);
        if (primaryType === "unknown") primaryType = "node";
      } else if (isNpmDefault) {
        reasons.push(`package.json scripts.test is npm's placeholder — skipping`);
      }
    } catch {
      reasons.push(`package.json present but unparseable — skipping`);
    }
  } catch { /* no package.json */ }

  // pyproject.toml — we don't parse TOML, presence is enough to assume pytest
  try {
    await Deno.stat(`${dir}/pyproject.toml`);
    gates.push({
      name: "pytest",
      command: "pytest -x",
      rationale: "auto-detected from pyproject.toml (pytest is the de-facto default)",
    });
    reasons.push(`pyproject.toml found → seeded "pytest" gate (fail-fast with -x)`);
    if (primaryType === "unknown") primaryType = "python";
  } catch { /* no pyproject */ }

  // Cargo.toml
  try {
    await Deno.stat(`${dir}/Cargo.toml`);
    gates.push({
      name: "cargo_test",
      command: "cargo test --quiet",
      rationale: "auto-detected from Cargo.toml",
    });
    reasons.push(`Cargo.toml found → seeded "cargo_test" gate`);
    if (primaryType === "unknown") primaryType = "rust";
  } catch { /* no Cargo.toml */ }

  // go.mod
  try {
    await Deno.stat(`${dir}/go.mod`);
    gates.push({
      name: "go_test",
      command: "go test ./...",
      rationale: "auto-detected from go.mod",
    });
    reasons.push(`go.mod found → seeded "go_test" gate`);
    if (primaryType === "unknown") primaryType = "go";
  } catch { /* no go.mod */ }

  // Makefile with a test target — last-resort catch-all for polyglot repos
  // that use make as their task runner.
  if (gates.length === 0) {
    try {
      const raw = await Deno.readTextFile(`${dir}/Makefile`);
      if (/^test\s*:/m.test(raw)) {
        gates.push({
          name: "make_test",
          command: "make test",
          rationale: "auto-detected Makefile with `test:` target",
        });
        reasons.push(`Makefile has test target → seeded "make_test" gate`);
        if (primaryType === "unknown") primaryType = "make";
      }
    } catch { /* no Makefile */ }
  }

  if (gates.length === 0) {
    reasons.push(
      `no test infrastructure detected — no gates seeded (pass --gate "name=cmd" to add one)`,
    );
  }

  // Default rubric — deliberately generic. The real value-add of --auto is
  // the test gates, not the rubric. Users who care about rubric specifics
  // will pass --rubric; this just gives `--auto` something non-empty so the
  // loop has a direction to push on.
  const rubric = [
    "Improve this project incrementally. Each iteration should make ONE focused improvement:",
    "- readability of the most-edited files",
    "- clearer error messages or logging where behavior is user-visible",
    "- removing dead / unused code with care",
    "- tightening type signatures where TypeScript or similar helps",
    "",
    "Do NOT:",
    "- change public APIs or CLI flags without strong cause",
    "- rewrite big subsystems",
    "- add new dependencies",
    "",
    "All auto-detected test gates must continue to pass. If the tests reveal a",
    "latent bug during your change, fixing that IS a valid iteration.",
  ].join("\n");

  return { projectType: primaryType, gates, rubric, reasons };
}

/**
 * Parsed sections from a REFINE.md file. Sections are detected by `## Heading`
 * markers — typical headings are "Heuristics", "Next Session", and per-session
 * logs like "Session 1". Keeps the whole file available so callers can inspect
 * raw content if the section split doesn't match expectations.
 */
export interface RefineHeuristics {
  /** Raw file contents. Empty string when REFINE.md doesn't exist. */
  raw: string;
  /** Absolute path to REFINE.md. */
  path: string;
  /** Whether the file exists on disk. */
  exists: boolean;
  /** Line count of the raw content (0 when empty). */
  lineCount: number;
  /** Map of `## Heading` → body text (trimmed). */
  sections: Record<string, string>;
  /** Heading names in the order they appear in the file. */
  sectionOrder: string[];
}

/**
 * Load and parse the REFINE.md heuristics file for `dir`.
 *
 * Used by `expo refine <dir> heuristics` and by orchestrating agents that
 * want to inspect cross-session learnings without re-reading the raw file.
 * Returns `{exists: false, raw: ""}` when the file doesn't exist — callers
 * can treat a missing file as "no prior learnings" rather than an error.
 */
export async function loadRefineHeuristics(dir: string): Promise<RefineHeuristics> {
  const path = `${dir}/${REFINE_MD}`;
  let raw = "";
  let exists = true;
  try {
    raw = await Deno.readTextFile(path);
  } catch {
    exists = false;
  }

  const sections: Record<string, string> = {};
  const sectionOrder: string[] = [];

  // Split on `## Heading` lines — any deeper heading (###, etc.) stays in
  // the parent section body. A leading unlabeled block (before the first
  // `##`) gets stored under "_preamble" so nothing is lost.
  const lines = raw.split("\n");
  let current: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (current !== null) {
      sections[current] = buffer.join("\n").trim();
    } else if (buffer.some((l) => l.trim().length > 0)) {
      sections._preamble = buffer.join("\n").trim();
      if (!sectionOrder.includes("_preamble")) sectionOrder.unshift("_preamble");
    }
    buffer = [];
  };

  for (const line of lines) {
    const match = line.match(/^##\s+(.+?)\s*$/);
    if (match) {
      flush();
      current = match[1].trim();
      if (!sectionOrder.includes(current)) sectionOrder.push(current);
    } else {
      buffer.push(line);
    }
  }
  flush();

  return {
    raw,
    path,
    exists,
    lineCount: raw ? raw.split("\n").length : 0,
    sections,
    sectionOrder,
  };
}

/**
 * CLI handler for `expo refine <dir> heuristics`. Prints REFINE.md content
 * plus a parsed-section summary. Exposed so orchestrating agents can read
 * prior-session learnings programmatically before firing a new refine loop.
 */
export async function showRefineHeuristics(
  dir: string,
  opts?: { json?: boolean },
): Promise<void> {
  const h = await loadRefineHeuristics(dir);

  if (opts?.json) {
    console.log(JSON.stringify({
      path: h.path,
      exists: h.exists,
      lineCount: h.lineCount,
      sectionOrder: h.sectionOrder,
      sections: h.sections,
      raw: h.raw,
    }));
    return;
  }

  if (!h.exists) {
    console.log(`No REFINE.md found at ${h.path}.`);
    console.log(`This file is created/updated at the end of each refine loop with`);
    console.log(`cross-session heuristics. Run \`expo refine ${dir}\` to seed it.`);
    return;
  }

  console.log(`REFINE.md: ${h.path}`);
  console.log(`  ${h.lineCount} lines, ${h.sectionOrder.length} section${h.sectionOrder.length === 1 ? "" : "s"}`);
  console.log("");
  console.log("Sections:");
  for (const name of h.sectionOrder) {
    const body = h.sections[name] ?? "";
    const bodyLines = body ? body.split("\n").length : 0;
    const display = name === "_preamble" ? "(preamble — no heading)" : name;
    console.log(`  • ${display} — ${bodyLines} line${bodyLines === 1 ? "" : "s"}`);
  }
  console.log("");
  console.log("--- raw content ---");
  console.log(h.raw);
}

/** Per-gate result for `checkRefineGates`. */
export interface GateCheckResult {
  name: string;
  command: string;
  source: "direct" | "inherited";
  addedBy: string;
  pass: boolean;
  exitCode: number;
  durationMs: number;
  /** Timeout flag — pass is always false when timedOut */
  timedOut?: boolean;
  /** Truncated stderr for diagnostics on failure */
  stderr?: string;
}

/**
 * Run every inherited gate for `variantId` (default: last-kept) and return
 * per-gate results. Unlike `runInheritedGates` (which is fail-fast for the
 * refine loop), this runs ALL gates so callers see every failure.
 *
 * Used by `expo refine <dir> gate check [variant_id]` — the "verify before
 * firing a long loop" primitive that lets an orchestrating agent trust its
 * invariants are green before spending real tokens.
 */
export async function checkRefineGates(
  dir: string,
  variantId?: string,
  opts?: { timeoutMs?: number },
): Promise<GateCheckResult[]> {
  await init(dir);
  const variants = await list(dir);

  // Caller-provided ID must exist (typo protection)
  if (variantId && !variants.find((v) => v.id === variantId)) {
    throw new Error(`Variant ${variantId} not found`);
  }

  // No snapshots yet → no gates to check. Return empty so orchestrators
  // can treat "nothing to verify" as a pass instead of an error.
  const resolvedId = variantId ?? getLastKeptId(variants);
  if (!resolvedId) return [];

  const gates = await collectGates(dir, resolvedId);
  if (gates.length === 0) return [];

  // Mark which gates are direct vs inherited for clearer reporting
  const direct = await listGates(dir, resolvedId);
  const directNames = new Set(direct.map((g) => g.name));

  const timeoutMs = opts?.timeoutMs ?? 60_000;
  const results: GateCheckResult[] = [];

  for (const gate of gates) {
    const startedAt = Date.now();
    // Single-gate run reuses the same exec path as runInheritedGates but
    // doesn't short-circuit on first failure — we want the full picture.
    const cmd = gate.command
      .replaceAll("{dir}", shellEscape(dir))
      .replaceAll("{variantId}", shellEscape(resolvedId));

    const hasSetsid = await commandExists("setsid");
    const proc = hasSetsid
      ? new Deno.Command("setsid", {
          args: ["sh", "-c", cmd],
          cwd: dir,
          stdout: "piped",
          stderr: "piped",
        }).spawn()
      : new Deno.Command("sh", {
          args: ["-c", cmd],
          cwd: dir,
          stdout: "piped",
          stderr: "piped",
        }).spawn();

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (hasSetsid) {
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
    }, timeoutMs);

    let output: Deno.CommandOutput;
    try {
      output = await proc.output();
    } finally {
      clearTimeout(timer);
    }

    const stderrText = new TextDecoder().decode(output.stderr).slice(0, 500);
    results.push({
      name: gate.name,
      command: gate.command,
      source: directNames.has(gate.name) ? "direct" : "inherited",
      addedBy: gate.addedBy,
      pass: output.success && !timedOut,
      exitCode: timedOut ? -1 : output.code,
      durationMs: Date.now() - startedAt,
      timedOut: timedOut || undefined,
      stderr: !output.success || timedOut ? stderrText : undefined,
    });
  }

  return results;
}

/**
 * CLI handler for `expo refine <dir> gate check [variant_id]`.
 *
 * Runs every inherited gate, prints a per-gate table, and exits 0 if every
 * gate passes or 1 if any fail. This is the "pre-flight check" an
 * orchestrating agent runs before firing a 5-minute refine loop — so a
 * broken gate doesn't burn tokens before the first iteration even begins.
 */
export async function runRefineGateCheck(
  dir: string,
  variantId: string | undefined,
  opts?: { timeoutMs?: number; json?: boolean },
): Promise<void> {
  let results: GateCheckResult[];
  let resolvedId: string;

  try {
    await init(dir);
    const variants = await list(dir);
    resolvedId = variantId ?? getLastKeptId(variants) ?? "(no snapshots)";
    results = await checkRefineGates(dir, variantId, { timeoutMs: opts?.timeoutMs });
  } catch (err) {
    if (opts?.json) {
      console.log(JSON.stringify({
        ok: false,
        error: String(err instanceof Error ? err.message : err).slice(0, 500),
      }));
    } else {
      console.error(`[refine] gate check failed: ${String(err).slice(0, 200)}`);
    }
    Deno.exit(1);
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;

  if (opts?.json) {
    console.log(JSON.stringify({
      ok: failed === 0,
      variantId: resolvedId,
      total: results.length,
      passed,
      failed,
      gates: results.map((r) => ({
        name: r.name,
        source: r.source,
        addedBy: r.addedBy,
        command: r.command,
        pass: r.pass,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        timedOut: r.timedOut ?? false,
        stderr: r.stderr,
      })),
    }));
    Deno.exit(failed === 0 ? 0 : 1);
  }

  if (results.length === 0) {
    console.log(`No gates visible to variant [${resolvedId}].`);
    console.log(`Add one with: expo refine ${dir} gate add <variant> --name N --command C`);
    return;
  }

  console.log(`Checking ${results.length} gate${results.length === 1 ? "" : "s"} against [${resolvedId}]:\n`);
  for (const r of results) {
    const mark = r.pass ? "✓" : "✗";
    const src = r.source === "inherited" ? ` (inherited from [${r.addedBy}])` : "";
    const timing = `${r.durationMs}ms`;
    console.log(`  ${mark} ${r.name}${src}   ${timing}`);
    if (!r.pass) {
      const reason = r.timedOut ? `timeout after ${r.durationMs}ms` : `exit ${r.exitCode}`;
      console.log(`      command: ${r.command}`);
      console.log(`      reason:  ${reason}`);
      if (r.stderr && r.stderr.trim()) {
        console.log(`      stderr:  ${r.stderr.trim().split("\n").slice(0, 3).join(" | ").slice(0, 200)}`);
      }
    }
  }

  console.log("");
  if (failed === 0) {
    console.log(`All ${passed} gate${passed === 1 ? "" : "s"} pass.`);
    Deno.exit(0);
  } else {
    console.log(`${failed} of ${results.length} gate${results.length === 1 ? "" : "s"} failed.`);
    Deno.exit(1);
  }
}

/** Package-manager lock files and other build artefacts that get touched
 *  automatically as a side effect of legitimate agent work (e.g. adding
 *  an import triggers a Deno cache update). We always allow these through
 *  scope checks — the agent didn't "choose" to modify them, the
 *  toolchain did. If a rubric explicitly wants to prevent lockfile drift,
 *  use a gate that runs `git diff --name-only <file>` instead. */
const ALWAYS_IN_SCOPE: ReadonlySet<string> = new Set([
  "deno.lock",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "go.sum",
  "uv.lock",
  "poetry.lock",
  "Pipfile.lock",
  "composer.lock",
  "Gemfile.lock",
  "mix.lock",
]);

/** Return the subset of `paths` that don't match any of the allowed
 *  glob patterns. Non-empty return = scope violation — caller should
 *  discard the iteration. Lock files and similar build artefacts are
 *  always-allowed (see ALWAYS_IN_SCOPE). Globs are compiled once per
 *  call; for the scale of a refine loop (tens of files, a handful of
 *  patterns) the allocation cost is negligible. */
export function findScopeViolations(paths: string[], scope: string[]): string[] {
  if (scope.length === 0) return [];
  const regexes = scope.map((g) =>
    globToRegExp(g, { extended: true, globstar: true, caseInsensitive: false })
  );
  const violations: string[] = [];
  for (const p of paths) {
    // Build artefacts auto-modified by the toolchain are always fine.
    // Checks basename only so `./deno.lock` and `deno.lock` both match.
    const basename = p.split("/").pop() ?? p;
    if (ALWAYS_IN_SCOPE.has(basename)) continue;
    if (!regexes.some((rx) => rx.test(p))) {
      violations.push(p);
    }
  }
  return violations;
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
