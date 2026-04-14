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
  /** Non-TTY approval hook: shell command that receives the verdict as
   *  JSON on stdin and returns a decision JSON `{action: "accept" |
   *  "discard" | "converge" | "quit"}` on stdout. Runs once per iteration,
   *  mutually exclusive with `interactive` (file/callback wins).
   *
   *  Enables oversight agents, CI approvals, and HTTP callbacks (the
   *  hook can be a curl invocation) without needing a TTY. */
  approvalHook?: string;
  /** Timeout in seconds for the approval hook. Default 60. On timeout we
   *  accept the agent's verdict as-is (fail-open) so a misconfigured hook
   *  doesn't permanently stall an unattended run. */
  approvalHookTimeout?: number;
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
  /** Gate promotion threshold — when this many variants INDEPENDENTLY
   *  attach the same (name, command) gate, auto-promote it to the root
   *  variant so the whole archive inherits it going forward. Emergent
   *  consensus ratchet: the system turns "three agents agreed this is
   *  important" into a project-wide invariant.
   *
   *  Default: 3. Set to 0 to disable promotion. Requires allowAgentGates
   *  in practice — without agent proposals, gates only arrive via CLI
   *  flags or --gate-file, which tend to already be root-level. */
  gatePromoteThreshold?: number;
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

  /** Skip the pre-run stale-baseline check (shakedown Finding #4).
   *
   *  By default, if the working tree has diverged from the snapshot
   *  tag of the last kept variant, refine refuses to start — because
   *  the first discard would silently rewind the tree, destroying
   *  work that wasn't captured in the snapshot tree. Set this to
   *  accept the rewind explicitly (e.g. for resume flows where drift
   *  is expected). */
  forceStaleBaseline?: boolean;

  /** Skip the pre-run baseline-gate check (shakedown Finding #13).
   *
   *  By default, before spawning iter-1, refine runs all seeded gates
   *  once against the current baseline. If any fail, refine refuses
   *  to start — because otherwise every iteration's gate step would
   *  force-discard regardless of the agent's actual work (since the
   *  gate was already broken before the agent touched anything).
   *
   *  Set this to accept a failing baseline gate explicitly. The
   *  primary legitimate use is TDD red-to-green workflows where the
   *  gate is SUPPOSED to fail on baseline and the agent's job is to
   *  make it pass. The other case is a gate that expects a running
   *  service (e.g. integration tests) where the user will start the
   *  service after refine launches. */
  skipBaselineCheck?: boolean;
}

export interface RefineResult {
  verdict: "CONVERGED" | "MAX_ITERATIONS" | "EXHAUSTED" | "WALL_CLOCK_EXCEEDED" | "INFRA_FAILURE";
  iterations: number;
  totalCostUsd: number;
  /** Lifetime kept-variant count (includes baseline + all prior sessions). */
  keptVariants: number;
  /** Lifetime discarded-variant count (includes all prior sessions). */
  discardedVariants: number;
  /** Keeps that landed during THIS refine() call specifically. Fixes
   *  shakedown Finding #6 — previously the banner mixed session with
   *  lifetime and was misleading on repeat runs ("Kept: 17" on a
   *  zero-productive session). */
  sessionKept: number;
  /** Discards during this refine() call. */
  sessionDiscarded: number;
  finalVariantId: string;
  /** Count of times an inherited gate forced a discard. */
  gateFailures: number;
  /** Count of times scope enforcement force-discarded an iteration
   *  (agent touched a file outside --scope). Separated from gateFailures
   *  per shakedown Finding #11 — previously both counts were bundled as
   *  "Gate fails" which mis-described scope issues as gate issues. */
  scopeViolations: number;
  /** Count of gates the agent proposed (0 if `allowAgentGates` is off). */
  gatesProposed: number;
  /** Count of iterations whose output looked like an infrastructure error
   *  (API 5xx, network timeout) rather than a semantic discard. Not counted
   *  toward consecutive-discard branching. Fixes shakedown Finding #3. */
  infraFailures?: number;
}

/** Classify an agent's output as infrastructure failure vs semantic output.
 *  Used to avoid counting API 5xx / network errors as "discards" for the
 *  consecutive-discard branching and cost-per-keep metrics. Exported for
 *  test coverage. */
export function isInfraFailure(output: string): boolean {
  if (!output) return false;
  // Anthropic API 5xx / overloaded — the most common case on long runs.
  if (/API Error:\s*5\d{2}/.test(output)) return true;
  if (/"type":\s*"api_error"/.test(output)) return true;
  if (/"type":\s*"overloaded_error"/.test(output)) return true;
  // Network-layer failures the spawner surfaces as output. Conservative
  // match — these are unlikely to appear in legitimate rubric-violation
  // prose; if the agent is quoting one it'll also produce structured
  // verdict lines and we'd rather mis-classify as infra (safer) than
  // as semantic.
  if (/ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed/.test(output)) return true;
  return false;
}

interface GateProposal {
  name: string;
  command: string;
  rationale?: string;
  /** Optional per-gate timeout override in milliseconds. When present,
   *  overrides the run-level --gate-timeout for this gate only. */
  timeoutMs?: number;
}

/** Which layer in the multi-layer verdict-parsing stack produced this
 *  verdict. Observability (and the #15-adjacent research question of
 *  whether the agent-harness contract is drifting over time). Ordered
 *  by preference — "fenced" is ideal, later entries are progressively
 *  less trustworthy. */
type ParseMethod =
  | "fenced" // Layer 1: <verdict>{...}</verdict> block, ideal path
  | "legacy-line" // Layer 2: VERDICT: KEEP / CHANGE: / SUMMARY: lines
  | "inferred-prose" // Layer 3: natural-language patterns in the agent's prose
  | "defaulted-keep" // Layer 4: no verdict emitted, but gates pass + changes made
  | "extraction-retry" // Layer 5: spawned a cheap recovery agent (rare, last resort)
  | "defaulted-discard"; // No layer succeeded; safest default

interface ParsedVerdict {
  action: "keep" | "discard" | "converged";
  change: string;
  summary: string;
  /** Any GATE_PROPOSAL lines the agent emitted. Only used when
   *  allowAgentGates is true; otherwise ignored. */
  gateProposals: GateProposal[];
  /** True when neither the fenced `<verdict>{...}</verdict>` block, the
   *  legacy line grammar, nor natural-language inference could parse the
   *  agent's output, and the action was defaulted to "discard". Callers
   *  may choose to spawn an extraction-retry before accepting the default
   *  — see Finding #15 and #17 (2026-04-13 snapshot shakedown): agents
   *  doing real work frequently forget the verdict wrapper and get force-
   *  discarded despite passing gates. Kept on the interface for backward
   *  compatibility with early-Finding-#15 callers; new code should use
   *  `parseMethod` for richer signal. */
  parseFailed?: boolean;
  /** Which layer produced this verdict. Always set. "fenced" and
   *  "legacy-line" are high-confidence; "inferred-prose", "defaulted-keep",
   *  and "extraction-retry" are mitigations for the agent-harness contract
   *  gap and should be tracked over time. "defaulted-discard" means no
   *  layer succeeded — equivalent to `parseFailed: true`. */
  parseMethod?: ParseMethod;
}

// ── Constants ──────────────────────────────────────────────────

const MAX_CONSECUTIVE_DISCARDS = 3;
const MAX_CONSECUTIVE_INFRA_FAILURES = 3;
const ARCHIVE_CONTEXT_COUNT = 5;
const REFINE_MD = "REFINE.md";
/** Default threshold for gate promotion: this many independent direct
 *  attachments of the same (name, command) tuple trigger auto-promote
 *  to root. 3 feels right — one or two attachments could be coincidence,
 *  three is consensus. */
const DEFAULT_GATE_PROMOTE_THRESHOLD = 3;

// Resumability: per-iteration runtime state persisted under .refine/ so a
// crashed / killed run can continue without losing its iteration budget
// or discard-streak tracking. Stale files older than this are ignored
// with a warning and overwritten — prevents accidental resume across
// unrelated sessions (e.g. a week-old interrupted run).
const INFLIGHT_FILE = "inflight.json";
const INFLIGHT_STALE_MS = 12 * 60 * 60 * 1000; // 12 hours
const INFLIGHT_SCHEMA_VERSION = 1;

/**
 * Serialized mid-run state written at the start of each iteration.
 * Schema-versioned so future changes can cleanly reject old shapes.
 */
interface InflightState {
  schemaVersion: number;
  /** Iterations already fully completed (keep+snapshot, or discard+record). */
  completedIterations: number;
  /** Wall-clock of the original run start, so --run-timeout survives resume. */
  runStartedAt: number;
  /** When we last wrote this file — used to detect stale leftovers. */
  persistedAt: number;
  /** Running totals so cost/budget accounting survives a crash. */
  totalCost: number;
  gateFailures: number;
  gatesProposed: number;
  /** Gate-failure feedback ring (capped to MAX_RECENT_FAILURES at write time). */
  recentFailures: RecentFailure[];
  /** Consecutive-discard counts keyed by parent variant ID. Serialized as
   *  array-of-pairs because JSON doesn't preserve Map natively. */
  discardCounts: Array<[string, number]>;
  /** The dir + rubric checksum we started with — optional sanity check so
   *  a resume detects when inflight belongs to a different run config. */
  dir: string;
}

/**
 * Decision returned by the approval gate (TTY prompt or hook command).
 * "accept" — apply the agent's verdict as-is.
 * "discard" — force the iteration to be discarded regardless of agent's call.
 * "converge" — stop the refine loop, treating current state as converged.
 * "quit" — same as converge semantically; kept as a distinct signal so the
 *           reason-string can reflect "user stopped" vs "user converged".
 */
export type ApprovalDecision = "accept" | "discard" | "converge" | "quit";

/**
 * Run the user-provided approval hook: exec its shell command with the
 * verdict payload as JSON on stdin, parse `{"action": ...}` from stdout.
 *
 * Fail-open on any error (hook crashes, times out, emits unparseable output)
 * — returns "accept" so a misconfigured hook doesn't permanently stall an
 * unattended run. Errors are logged so the misconfiguration is visible.
 */
async function runApprovalHook(
  command: string,
  payload: { iteration: number; verdict: { action: string; change: string; summary: string }; variantId: string },
  opts: { timeoutMs: number },
): Promise<ApprovalDecision> {
  const json = JSON.stringify(payload);
  try {
    const proc = new Deno.Command("sh", {
      args: ["-c", command],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    // Write payload to stdin, close it so hook can terminate cleanly
    const writer = proc.stdin.getWriter();
    await writer.write(new TextEncoder().encode(json));
    await writer.close();

    // Race output against the timeout — kill the hook if it overruns so
    // an unattended run doesn't stall indefinitely on a broken hook.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill("SIGKILL"); } catch { /* already exited */ }
    }, opts.timeoutMs);

    let output: Deno.CommandOutput;
    try {
      output = await proc.output();
    } finally {
      clearTimeout(timer);
    }

    if (timedOut) {
      console.error(`[refine] approval hook timed out after ${opts.timeoutMs}ms — accepting agent verdict as fallback`);
      return "accept";
    }
    if (!output.success) {
      const stderr = new TextDecoder().decode(output.stderr).slice(0, 300);
      console.error(`[refine] approval hook exited ${output.code}${stderr ? ` — stderr: ${stderr.trim()}` : ""}`);
      console.error(`[refine] accepting agent verdict as fallback`);
      return "accept";
    }

    const stdout = new TextDecoder().decode(output.stdout).trim();
    if (!stdout) {
      console.error(`[refine] approval hook returned no output — accepting agent verdict as fallback`);
      return "accept";
    }

    const parsed = parseApprovalOutput(stdout);
    if (parsed === null) {
      console.error(`[refine] approval hook output unparseable: ${stdout.slice(0, 200)} — accepting agent verdict as fallback`);
      return "accept";
    }
    return parsed;
  } catch (err) {
    console.error(`[refine] approval hook spawn failed: ${String(err).slice(0, 200)} — accepting agent verdict as fallback`);
    return "accept";
  }
}

/**
 * Parse the approval hook's stdout. Accepts two shapes for ergonomics:
 *   1. Plain JSON object: `{"action": "accept"}` — the canonical form.
 *   2. Bare token: `accept`, `discard`, `converge`, `quit` — for shell
 *      one-liners like `echo discard` that don't want to emit JSON.
 *
 * Returns null on any unrecognized shape so the caller can fall back.
 */
function parseApprovalOutput(stdout: string): ApprovalDecision | null {
  // Try JSON first
  try {
    const parsed = JSON.parse(stdout);
    if (typeof parsed === "object" && parsed !== null) {
      const action = (parsed as Record<string, unknown>).action;
      if (typeof action === "string") {
        const lowered = action.toLowerCase() as ApprovalDecision;
        if (lowered === "accept" || lowered === "discard" || lowered === "converge" || lowered === "quit") {
          return lowered;
        }
      }
    }
  } catch { /* not JSON — try token form */ }

  // Bare token form
  const token = stdout.toLowerCase().split(/\s+/)[0];
  if (token === "accept" || token === "discard" || token === "converge" || token === "quit") {
    return token;
  }
  // Common shorthand: a/d/c/q — same letters the TTY prompt accepts.
  const choice = choiceToDecision(token);
  if (choice !== "accept" || token === "a" || token === "accept") return choice;
  return null;
}

/** Shared mapping from one-letter / word input → ApprovalDecision.
 *  Used by both the TTY path (--interactive) and the hook's bare-token
 *  fallback parse so both flavors accept the same vocabulary. */
function choiceToDecision(choice: string): ApprovalDecision {
  const trimmed = choice.trim().toLowerCase();
  if (trimmed === "q" || trimmed === "quit") return "quit";
  if (trimmed === "d" || trimmed === "discard") return "discard";
  if (trimmed === "c" || trimmed === "converge" || trimmed === "converged") return "converge";
  // "a", "accept", empty, anything else → accept (matches prior TTY default)
  return "accept";
}

/** Apply an ApprovalDecision to a ParsedVerdict in place. Extracted so the
 *  TTY and hook paths share the same semantics — no drift between the two. */
function applyApprovalDecision(verdict: ParsedVerdict, decision: ApprovalDecision): void {
  if (decision === "quit") {
    verdict.action = "converged";
    verdict.summary = "User/hook stopped refinement via approval gate";
  } else if (decision === "discard") {
    verdict.action = "discard";
    if (!verdict.summary) verdict.summary = "Approval gate overrode to discard";
  } else if (decision === "converge") {
    verdict.action = "converged";
    if (!verdict.summary) verdict.summary = "Approval gate declared convergence";
  }
  // accept → keep verdict as-is
}

/** Exported for unit tests so we can exercise the parser without actually
 *  spawning shell commands. */
export function _testOnlyParseApprovalOutput(stdout: string): ApprovalDecision | null {
  return parseApprovalOutput(stdout);
}

// ── Resumability helpers ───────────────────────────────────────

/** Write current mid-run state to `.refine/inflight.json`. Best-effort —
 *  a failed write logs a warning but doesn't fail the iteration (losing
 *  resume state is better than aborting a paid-for iteration). */
async function persistInflight(dir: string, state: InflightState): Promise<void> {
  try {
    const refineDir = `${dir}/.refine`;
    // .refine/ is always created by snapshot init() before we get here, so
    // we don't need to mkdir — but the try/catch handles the case where
    // someone nuked the dir.
    await Deno.mkdir(refineDir, { recursive: true });
    await Deno.writeTextFile(`${refineDir}/${INFLIGHT_FILE}`, JSON.stringify(state));
  } catch (err) {
    console.error(`[refine] inflight persist failed (non-fatal): ${String(err).slice(0, 200)}`);
  }
}

/** Try to load + validate existing inflight state. Returns null on any
 *  failure (missing file, parse error, schema mismatch, stale) — the
 *  caller starts fresh in that case. */
async function loadInflight(dir: string): Promise<InflightState | null> {
  const path = `${dir}/.refine/${INFLIGHT_FILE}`;
  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch {
    return null; // no file → normal start, no warning
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`[refine] inflight.json unparseable, ignoring: ${String(err).slice(0, 200)}`);
    await Deno.remove(path).catch(() => {});
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    console.error(`[refine] inflight.json is not an object, ignoring`);
    await Deno.remove(path).catch(() => {});
    return null;
  }
  const s = parsed as Partial<InflightState>;
  if (s.schemaVersion !== INFLIGHT_SCHEMA_VERSION) {
    console.error(`[refine] inflight.json schema v${s.schemaVersion} != expected v${INFLIGHT_SCHEMA_VERSION}, ignoring`);
    await Deno.remove(path).catch(() => {});
    return null;
  }

  const age = Date.now() - (s.persistedAt ?? 0);
  if (age > INFLIGHT_STALE_MS) {
    console.error(
      `[refine] inflight.json is ${Math.round(age / 3600_000)}h old (> ${Math.round(INFLIGHT_STALE_MS / 3600_000)}h threshold) — starting fresh`,
    );
    await Deno.remove(path).catch(() => {});
    return null;
  }

  // Required fields check — paranoid, but cheap. An old partial object
  // missing a new field would otherwise crash downstream.
  if (
    typeof s.completedIterations !== "number" ||
    typeof s.runStartedAt !== "number" ||
    typeof s.totalCost !== "number" ||
    typeof s.gateFailures !== "number" ||
    typeof s.gatesProposed !== "number" ||
    !Array.isArray(s.recentFailures) ||
    !Array.isArray(s.discardCounts) ||
    typeof s.dir !== "string"
  ) {
    console.error(`[refine] inflight.json missing required fields, ignoring`);
    await Deno.remove(path).catch(() => {});
    return null;
  }

  return s as InflightState;
}

/** Delete the inflight file on clean exit so the next run doesn't resume. */
async function clearInflight(dir: string): Promise<void> {
  try {
    await Deno.remove(`${dir}/.refine/${INFLIGHT_FILE}`);
  } catch { /* already gone */ }
}

// ── Test hooks ────────────────────────────────────────────────

/** Re-exported for unit tests — exercise the persist/load/stale logic
 *  without having to run a full refine loop. */
export const _testOnlyInflight = {
  persist: persistInflight,
  load: loadInflight,
  clear: clearInflight,
  STALE_MS: INFLIGHT_STALE_MS,
  SCHEMA_VERSION: INFLIGHT_SCHEMA_VERSION,
};

/** Read a single line from stdin (for interactive mode) */
async function readStdinLine(): Promise<string> {
  const buf = new Uint8Array(256);
  const n = await Deno.stdin.read(buf);
  if (n === null) return "";
  return new TextDecoder().decode(buf.subarray(0, n)).trim();
}

/** Drift info for the stale-baseline check (shakedown Finding #4).
 *  Non-null means the working tree has moved since the last-kept
 *  variant's snapshot. The first discard during the refine loop will
 *  reset the tree to the snapshot state, so this delta is effectively
 *  at-risk work. */
export interface SnapshotDrift {
  variantId: string;
  tag: string;
  /** Parsed `git diff --stat refine/<id>` — empty string means clean. */
  summary: string;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
}

/** Compare the current working tree against the snapshot tag for
 *  `variantId`. Returns null when there's no drift or when the check
 *  can't be performed (non-git repo, tag missing). */
export async function detectSnapshotDrift(
  dir: string,
  variantId: string,
): Promise<SnapshotDrift | null> {
  try {
    const tag = `refine/${variantId}`;
    // Verify tag exists — silent null if this variant's snapshot isn't tagged.
    const tagCheck = await new Deno.Command("git", {
      args: ["rev-parse", "--verify", tag],
      cwd: dir,
      stdout: "null",
      stderr: "null",
    }).output();
    if (!tagCheck.success) return null;

    // --stat gives us a human-readable summary + trailing totals line.
    const diff = await new Deno.Command("git", {
      args: ["diff", "--stat", tag, "--", "."],
      cwd: dir,
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!diff.success) return null;
    const summary = new TextDecoder().decode(diff.stdout).trim();
    if (!summary) return null;

    // Parse the trailing " N files changed, A insertions(+), R deletions(-)" line.
    const totalsMatch = summary.match(
      /(\d+)\s+files?\s+changed(?:,\s*(\d+)\s+insertions?\(\+\))?(?:,\s*(\d+)\s+deletions?\(-\))?/,
    );
    return {
      variantId,
      tag,
      summary,
      filesChanged: Number(totalsMatch?.[1] ?? 0),
      linesAdded: Number(totalsMatch?.[2] ?? 0),
      linesRemoved: Number(totalsMatch?.[3] ?? 0),
    };
  } catch {
    return null;
  }
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

  // Record pre-run variant counts so we can report session-delta in the
  // final result. Fixes shakedown Finding #6 (banner showed lifetime
  // "Kept: 17" on a session that kept only 1 variant — misleading).
  const preRunKept = variants.filter((v) => v.status === "kept" || v.status === "baseline").length;
  const preRunDiscarded = variants.filter((v) => v.status === "discarded").length;

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

  // 2c. Stale-baseline check (shakedown Finding #4). If the working tree
  //     has drifted from the last-kept variant's snapshot (because the
  //     user made commits or uncommitted edits since the last refine run),
  //     the first discard will rewind the tree and silently destroy that
  //     work. Detect + refuse-by-default with a clear recovery path.
  //     Skipped on fresh repos (< 2 variants) where no "last kept" exists.
  if (!opts.forceStaleBaseline && variants.length > 1) {
    const headKeptId = getLastKeptId(variants) ?? "000";
    const drift = await detectSnapshotDrift(dir, headKeptId);
    if (drift && drift.filesChanged > 0) {
      console.error(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠  STALE BASELINE — refine refuses to start
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The working tree has drifted from the last-kept refine variant.
Since every discard restores to that variant's snapshot, the first
iteration that discards would rewind away your changes.

  Last-kept variant:  [${drift.variantId}] (tag ${drift.tag})
  Drift:              ${drift.filesChanged} file(s), +${drift.linesAdded}/-${drift.linesRemoved} lines

What changed since the snapshot (summary):
${drift.summary.split("\n").slice(-5).map((l) => "  " + l).join("\n")}

To proceed, pick one:

  1. Commit or stash your work, then run refine again.
     Everything you've done will be preserved in git.

  2. Re-run with --force-stale-baseline to accept the rewind.
     Your tree WILL be reset to [${drift.variantId}] on the first discard.
     Any uncommitted changes will be lost. Committed changes are
     recoverable via 'git reflog' but will disappear from HEAD.

  3. Promote your current state as the new baseline. For now, this
     means manually: snapshot with 'expo refine . --max 1 --rubric
     "promote current state as new variant"', then re-run refine.
     (A dedicated --reset-to-head flag is planned.)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
      throw new Error(`refine: stale baseline — use --force-stale-baseline to override`);
    }
  }

  // Pre-flight baseline-gate check (shakedown Finding #13). Agents can only
  // produce keep-quality work if the invariant ratchet is green to start
  // with; a gate that fails on the unmodified tree force-discards every
  // iteration regardless of what the agent does. That's a silent-$20-per-run
  // burn with no useful signal.
  //
  // Opt out with --skip-baseline-check (TDD red-to-green or
  // agent-will-start-the-service flows).
  if (!opts.skipBaselineCheck) {
    const baselineId = getLastKeptId(variants);
    if (baselineId) {
      const checkResults = await checkRefineGates(dir, baselineId, {
        timeoutMs: (opts.gateTimeout ?? 60) * 1000,
      });
      const failures = checkResults.filter((r) => !r.pass);
      if (failures.length > 0) {
        console.error(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠  BASELINE GATE FAILURE — refine refuses to start
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Seeded gates FAIL against the current baseline — before any agent
has touched the code. Every iteration would force-discard on these
gates regardless of what the agent produces, burning budget for
no useful signal.

  Failing gate${failures.length === 1 ? "" : "s"}: ${failures.length} of ${checkResults.length}

${failures
  .map((f) => {
    const src = f.source === "inherited" ? ` (inherited from [${f.addedBy}])` : "";
    const reason = f.timedOut ? `timeout after ${f.durationMs}ms` : `exit ${f.exitCode}`;
    const stderrLine = f.stderr && f.stderr.trim()
      ? `\n      stderr: ${f.stderr.trim().split("\n").slice(0, 2).join(" | ").slice(0, 180)}`
      : "";
    return `  ✗ ${f.name}${src}
      command: ${f.command}
      reason:  ${reason}${stderrLine}`;
  })
  .join("\n\n")}

To proceed, pick one:

  1. Fix the baseline failure manually, then re-run refine.
     Most common: start a service the gate depends on, install a
     missing tool, or commit a fix to the current tree.

  2. Re-run with --skip-baseline-check to accept the failing gate.
     Use this for TDD red-to-green (agent's job is to MAKE it pass)
     or for gates that expect a service you'll start after launch.
     The gate step still runs every iteration — if baseline was the
     only thing broken, agent's first keep will turn it green.

  3. Remove or replace the gate:
       expo refine . gate remove ${failures[0].name}
     …or override its command:
       expo refine . gate add ${failures[0].name} --command 'new-cmd'

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
        throw new Error(
          `refine: baseline gate failure (${failures.length} of ${checkResults.length}) — use --skip-baseline-check to override`,
        );
      }
    }
  }

  // Read REFINE.md heuristics if it exists
  const refineHeuristics = await readRefinemd(dir);

  // Consecutive discard tracking: parentId → count
  const discardCounts = new Map<string, number>();

  // Counters for the result summary
  let gateFailures = 0;
  // Track scope-violation force-discards separately from real gate failures
  // so the final banner can describe each accurately (shakedown Finding #11).
  let scopeViolations = 0;
  let gatesProposed = 0;
  // Infra-failure tracking (shakedown Finding #3). Counts API 5xx /
  // network errors separately from semantic discards. Consecutive count
  // drives an early-exit after MAX_CONSECUTIVE_INFRA_FAILURES (3) to
  // avoid burning budget on a persistent upstream outage.
  let infraFailures = 0;
  let consecutiveInfraFailures = 0;
  const gateTimeoutMs = (opts.gateTimeout ?? 60) * 1000;

  // Gate-failure feedback ring: keep the last few gate-broken attempts so we
  // can feed them into the next prompt. Bounded to keep context usage small;
  // after this many failures the first-in gets dropped.
  const MAX_RECENT_FAILURES = 3;
  const recentFailures: RecentFailure[] = [];

  // Resumability: pick up mid-run state from a prior crashed/killed run.
  // Loop starts at completedResumeOffset so `--max` still honors the
  // original budget; cost + gate counters survive; discard-streak state
  // restored so the branching logic doesn't double-count.
  let completedResumeOffset = 0;
  const existingInflight = await loadInflight(dir);
  if (existingInflight && existingInflight.dir === dir) {
    completedResumeOffset = existingInflight.completedIterations;
    totalCost = existingInflight.totalCost;
    gateFailures = existingInflight.gateFailures;
    gatesProposed = existingInflight.gatesProposed;
    for (const f of existingInflight.recentFailures) recentFailures.push(f);
    for (const [k, v] of existingInflight.discardCounts) discardCounts.set(k, v);
    console.log(
      `[refine] resuming from .refine/inflight.json — ${completedResumeOffset} iteration${completedResumeOffset === 1 ? "" : "s"} already completed, $${totalCost.toFixed(4)} spent, ${gateFailures} gate failure${gateFailures === 1 ? "" : "s"}`,
    );
  }

  let iterations = completedResumeOffset;
  let finalVariantId = getLastKeptId(variants) ?? "000";

  // Wall-clock budget for the whole run (if --run-timeout was passed).
  // Per-iteration timeout is also clamped to the remaining budget so a
  // single stuck iteration can't overrun the wall clock arbitrarily.
  // On resume, the run-started time is the ORIGINAL start so the total
  // wall clock honors the user's --run-timeout across crashes.
  const runStartedAt = existingInflight?.runStartedAt ?? Date.now();
  const runTimeoutMs = (opts.runTimeout ?? 0) * 1000;
  const runDeadline = runTimeoutMs > 0 ? runStartedAt + runTimeoutMs : 0;

  for (let i = completedResumeOffset; i < maxIterations; i++) {
    iterations = i + 1;

    // Persist mid-run state BEFORE spawning the agent — if we die mid-spawn
    // the next run will at least know how far we got. Best-effort; losing a
    // write doesn't abort the iteration.
    await persistInflight(dir, {
      schemaVersion: INFLIGHT_SCHEMA_VERSION,
      completedIterations: i,
      runStartedAt,
      persistedAt: Date.now(),
      totalCost,
      gateFailures,
      gatesProposed,
      recentFailures: [...recentFailures],
      discardCounts: Array.from(discardCounts.entries()),
      dir,
    });

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
      await clearInflight(dir);
      return buildResult("WALL_CLOCK_EXCEEDED", iterations - 1, totalCost, variants, finalVariantId, gateFailures, gatesProposed, infraFailures, preRunKept, preRunDiscarded, scopeViolations);
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

    // e. Classify infra failure vs semantic output (shakedown Finding #3).
    //    API 5xx / network errors get their own bucket — they don't count
    //    toward consecutive-discard branching OR cost-per-keep quality
    //    signals, and N in a row means we exit early instead of burning
    //    more budget on a persistent outage.
    if (isInfraFailure(result.output)) {
      infraFailures++;
      consecutiveInfraFailures++;
      await emitRefineProgress(bus, agentName, iterations,
        `infra_failure: ${result.output.slice(0, 120).replace(/\s+/g, " ").trim()}`,
        { infraFailure: true, consecutiveInfraFailures });
      console.log(
        `[refine] infra failure (${consecutiveInfraFailures}/${MAX_CONSECUTIVE_INFRA_FAILURES}) — treating as noise, not discard`,
      );
      if (consecutiveInfraFailures >= MAX_CONSECUTIVE_INFRA_FAILURES) {
        console.log(
          `[refine] ${MAX_CONSECUTIVE_INFRA_FAILURES} consecutive infra failures — exiting early. Not a semantic convergence; retry later.`,
        );
        await updateRefineMd(bus, spawner, dir, variants, opts);
        await clearInflight(dir);
        return buildResult("INFRA_FAILURE", iterations, totalCost, variants, finalVariantId, gateFailures, gatesProposed, infraFailures, preRunKept, preRunDiscarded, scopeViolations);
      }
      // Skip this iteration entirely — don't record a variant, don't run
      // gates, don't update discardCounts. It never happened semantically.
      continue;
    }
    // Any non-infra iteration resets the streak.
    consecutiveInfraFailures = 0;

    // f. Parse verdict — multi-layer stack (Finding #15 + #17):
    //    Layer 1: fenced <verdict>{...}</verdict>                 (ideal, inside parseVerdict)
    //    Layer 2: legacy VERDICT: KEEP lines                      (inside parseVerdict)
    //    Layer 3: natural-language prose inference                (inside parseVerdict)
    //    Layer 4: default-keep-if-safe (gates will verify)        (below)
    //    Layer 5: spawn a verdict-extraction retry agent          (below, last resort)
    //
    // Silent-destroy of legitimate work is the bug class we're defending
    // against. Agents skip the structured wrapper in 40-80% of iters on
    // Claude Code CLI despite explicit instructions; the multi-layer stack
    // preserves work without trusting the agent to follow the contract.
    let verdict = parseVerdict(result.output);

    if (verdict.parseFailed) {
      // Layer 4: default-keep-if-safe. If the agent made tracked changes
      // and didn't emit any discard signal, default to KEEP — the gate
      // step that runs after this will still force-discard if the agent's
      // changes broke anything, so the invariant ratchet is intact.
      // Flipping the default from discard to keep eliminates the P0
      // silent-destroy class (Finding #15) at the harness level.
      const madeChanges = agentTouchedPaths !== undefined && agentTouchedPaths.length > 0;
      const cantTellIfChanges = agentTouchedPaths === undefined;

      if (madeChanges) {
        verdict = {
          action: "keep",
          change: verdict.change || "(no change description emitted)",
          summary: "No explicit verdict emitted; agent made changes. Gates will verify.",
          gateProposals: verdict.gateProposals,
          parseMethod: "defaulted-keep",
        };
        console.log(
          `[refine] iter ${iterations}: no explicit verdict — defaulting to keep (gates will verify) [Layer 4]`,
        );
      } else if (cantTellIfChanges) {
        // Layer 5: last-resort retry. We can't see what the agent did
        // (e.g., non-git backend), so ask a cheap extraction agent to
        // read the prose and emit a verdict on the original agent's
        // behalf. ~$0.10-$0.15 per retry.
        console.log(
          `[refine] iter ${iterations}: no explicit verdict + can't determine changes — attempting extraction retry [Layer 5]`,
        );
        const retried = await retryVerdictExtraction(result.output, bus, spawner, {
          name: `${agentName}-verdict-retry`,
          agent: opts.agent,
          model: opts.model,
          cwd: dir,
          sandbox: opts.sandbox,
        });
        if (retried) {
          console.log(
            `[refine] iter ${iterations}: extraction retry recovered verdict: ${retried.action}`,
          );
          verdict = { ...retried, parseMethod: "extraction-retry" };
        } else {
          console.log(
            `[refine] iter ${iterations}: extraction retry also failed — accepting default discard`,
          );
        }
      } else {
        // agentTouchedPaths is defined but empty — agent made NO changes.
        // Discard is correct; no work to preserve.
        console.log(
          `[refine] iter ${iterations}: no explicit verdict and no changes made — discarding`,
        );
      }
    }

    // Emit refine_verdict signal for dashboard tracking. Annotate the verdict
    // string with the parse method when it wasn't the ideal fenced path —
    // surfaces the harness-contract drift described in Finding #17 so we can
    // see over time whether the agent's adherence is improving or degrading.
    const method = verdict.parseMethod ?? "unknown";
    const methodAnnotation = (method === "fenced" || method === "legacy-line") ? "" : ` [${method}]`;
    await emitRefineProgress(
      bus,
      agentName,
      iterations,
      `refine_verdict: ${verdict.action}${methodAnnotation} — ${verdict.change}`,
      {
        refineVerdict: verdict.action,
        refineChange: verdict.change,
        refineSummary: verdict.summary,
        refineParseMethod: method,
      },
    );

    // Approval gate: either interactive (TTY) or hook (non-TTY). Hook wins
    // if both set — non-TTY is the more deliberate configuration.
    if (opts.approvalHook) {
      const decision = await runApprovalHook(opts.approvalHook, {
        iteration: iterations,
        verdict: {
          action: verdict.action,
          change: verdict.change,
          summary: verdict.summary,
        },
        variantId: currentParentId,
      }, { timeoutMs: (opts.approvalHookTimeout ?? 60) * 1000 });

      applyApprovalDecision(verdict, decision);
    } else if (opts.interactive) {
      console.log(`\n--- Iteration ${iterations} ---`);
      console.log(`Verdict: ${verdict.action.toUpperCase()}`);
      console.log(`Change:  ${verdict.change}`);
      console.log(`Summary: ${verdict.summary}`);
      console.log(`\n[a]ccept / [d]iscard / [c]onverge / [q]uit (default: accept) > `);

      const override = await readStdinLine();
      const choice = override.trim().toLowerCase();
      applyApprovalDecision(verdict, choiceToDecision(choice));
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

      await clearInflight(dir);
      return buildResult("CONVERGED", iterations, totalCost, variants, finalVariantId, gateFailures, gatesProposed, infraFailures, preRunKept, preRunDiscarded, scopeViolations);
    }

    if (verdict.action === "keep") {
      // Scope check — if the caller set --scope patterns, any agent-touched
      // path outside the allowed globs force-discards this iteration BEFORE
      // we spend time running gates or snapshotting. Hard constraint, unlike
      // rubric prose.
      if (opts.scope && opts.scope.length > 0 && agentTouchedPaths && agentTouchedPaths.length > 0) {
        const violations = findScopeViolations(agentTouchedPaths, opts.scope);
        if (violations.length > 0) {
          scopeViolations++;
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
          // Pass agentTouchedPaths so scope-violation cleanup doesn't leave
          // stragglers that poison the next iteration's dirty baseline.
          const outcome = await recordDiscardAndMaybeBranch(dir, variants, discardCounts, {
            change: verdict.change,
            summary: `scope_violation: ${violations.slice(0, 5).join(", ")}`.slice(0, 300),
          }, agentTouchedPaths);
          if (outcome === "exhausted") {
            variants = await list(dir);
            await updateRefineMd(bus, spawner, dir, variants, opts);
            await clearInflight(dir);
            return buildResult("EXHAUSTED", iterations, totalCost, variants, finalVariantId, gateFailures, gatesProposed, infraFailures, preRunKept, preRunDiscarded, scopeViolations);
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
        // potentially branch if the discard streak hit the limit. Pass
        // agentTouchedPaths so straggler files from this failed attempt
        // don't linger and confuse the next iteration's dirty baseline.
        const outcome = await recordDiscardAndMaybeBranch(dir, variants, discardCounts, {
          change: verdict.change,
          summary: `gate_failed:${gateResult.failed!.name} — ${verdict.summary}`.slice(0, 300),
        }, agentTouchedPaths);
        if (outcome === "exhausted") {
          variants = await list(dir);
          await updateRefineMd(bus, spawner, dir, variants, opts);
          await clearInflight(dir);
          return buildResult("EXHAUSTED", iterations, totalCost, variants, finalVariantId, gateFailures, gatesProposed, infraFailures, preRunKept, preRunDiscarded, scopeViolations);
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

        // Gate promotion: if multiple descendants independently attached the
        // same (name, command) tuple, promote it to root. Runs after every
        // gate-adding iteration since the same iteration's own attachments
        // may complete a consensus that prior iterations started.
        const promoteThreshold = opts.gatePromoteThreshold ?? DEFAULT_GATE_PROMOTE_THRESHOLD;
        if (promoteThreshold > 0) {
          await promoteGatesIfWarranted(bus, dir, promoteThreshold, {
            agentName,
            iteration: iterations,
          });
        }
      }

      // Reset consecutive discard count for this lineage
      discardCounts.set(finalVariantId, 0);
    } else {
      // Rubric-driven discard — same scope cleanup applies.
      const outcome = await recordDiscardAndMaybeBranch(dir, variants, discardCounts, {
        change: verdict.change,
        summary: verdict.summary,
      }, agentTouchedPaths);
      if (outcome === "exhausted") {
        variants = await list(dir);
        await updateRefineMd(bus, spawner, dir, variants, opts);
        await clearInflight(dir);
        return buildResult("EXHAUSTED", iterations, totalCost, variants, finalVariantId, gateFailures, gatesProposed, infraFailures, preRunKept, preRunDiscarded, scopeViolations);
      }
    }
  }

  // Max iterations reached
  variants = await list(dir);
  finalVariantId = getLastKeptId(variants) ?? "000";
  await updateRefineMd(bus, spawner, dir, variants, opts);
  await clearInflight(dir);
  return buildResult("MAX_ITERATIONS", iterations, totalCost, variants, finalVariantId, gateFailures, gatesProposed, infraFailures, preRunKept, preRunDiscarded, scopeViolations);
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

/**
 * Count direct attachments of each (name, command) tuple across the archive
 * and return the tuples that hit the promotion threshold.
 *
 * "Direct" = the gate is on the variant's own `gates` list, not inherited.
 * (name, command) tuples are the unit of consensus — if two variants have a
 * "tests" gate but one runs `deno test` and the other `npm test`, they're
 * NOT the same invariant and neither should promote on their joint count.
 * Rationales are prose and vary freely — they don't affect the tuple.
 *
 * Variants that already inherit the gate are EXCLUDED from the count since
 * their descendant didn't "independently add" it — they got it for free.
 *
 * The root variant (000) is also excluded: if root already has the gate,
 * there's nothing to promote. Its presence in the count would also be
 * double-counted since inheritance originates there.
 */
export interface PromotionCandidate {
  name: string;
  command: string;
  attachedOn: string[]; // variant IDs with direct attachment
  representativeRationale?: string; // first non-empty rationale seen
}

export function findPromotionCandidates(
  variants: Variant[],
  threshold: number,
): PromotionCandidate[] {
  if (threshold <= 0) return [];
  // Identify the root variant. Convention: status === "baseline" OR id === "000".
  const root = variants.find((v) => v.status === "baseline") ?? variants[0];
  if (!root) return [];

  // Group direct gates by (name, command) tuple
  const groups = new Map<string, PromotionCandidate>();
  for (const v of variants) {
    if (v.id === root.id) continue; // root doesn't vote for its own promotion
    for (const g of v.gates ?? []) {
      const key = `${g.name}\x00${g.command}`;
      const existing = groups.get(key);
      if (existing) {
        existing.attachedOn.push(v.id);
        if (!existing.representativeRationale && g.rationale) {
          existing.representativeRationale = g.rationale;
        }
      } else {
        groups.set(key, {
          name: g.name,
          command: g.command,
          attachedOn: [v.id],
          representativeRationale: g.rationale,
        });
      }
    }
  }

  // Exclude tuples that the root variant already has (identical name+command)
  const rootKeys = new Set(
    (root.gates ?? []).map((g) => `${g.name}\x00${g.command}`),
  );

  return Array.from(groups.entries())
    .filter(([key, c]) => !rootKeys.has(key) && c.attachedOn.length >= threshold)
    .map(([, c]) => c);
}

/**
 * If any gates have reached the consensus threshold, promote them to the
 * root variant and remove the (now-redundant) direct attachments from
 * descendants. Returns the number of gates promoted.
 *
 * Best-effort throughout — addGate/removeGate failures are logged and
 * skipped so one bad promotion doesn't abort the rest.
 */
async function promoteGatesIfWarranted(
  bus: SignalBus,
  dir: string,
  threshold: number,
  ctx: { agentName: string; iteration: number },
): Promise<number> {
  if (threshold <= 0) return 0;
  const variants = await list(dir);
  const candidates = findPromotionCandidates(variants, threshold);
  if (candidates.length === 0) return 0;

  const root = variants.find((v) => v.status === "baseline") ?? variants[0];
  if (!root) return 0;

  let promoted = 0;
  for (const c of candidates) {
    try {
      // Attach to root with a promotion-flavoured rationale so it's clear in
      // `gate list` output that this wasn't a manual root gate.
      const rationale = c.representativeRationale
        ? `promoted from ${c.attachedOn.length} descendants; originally: ${c.representativeRationale}`
        : `auto-promoted from ${c.attachedOn.length} descendants`;
      await addGate(dir, root.id, {
        name: c.name,
        command: c.command,
        rationale: rationale.slice(0, 400),
      });

      // Remove redundant direct attachments from descendants. They still see
      // the gate via inheritance from root; direct copies would run the same
      // command redundantly (collectGates dedupes by name, but storage bloat
      // is real and confusing in `gate list`).
      for (const variantId of c.attachedOn) {
        try {
          await removeGate(dir, variantId, c.name);
        } catch {
          // Best-effort — if removal fails, inheritance de-dup in collectGates
          // means the runtime still behaves correctly.
        }
      }

      promoted++;
      await emitRefineProgress(
        bus,
        ctx.agentName,
        ctx.iteration,
        `gate_promoted: '${c.name}' → root (${c.attachedOn.length} descendants agreed)`,
        {
          gatePromoted: c.name,
          gateCommand: c.command,
          promotedFromCount: c.attachedOn.length,
          promotedFromVariants: c.attachedOn,
        },
      );
      console.log(
        `[refine] promoted gate '${c.name}' to root — ${c.attachedOn.length} descendants independently added it`,
      );
    } catch (err) {
      console.error(
        `[refine] gate promotion failed for '${c.name}': ${String(err).slice(0, 200)}`,
      );
    }
  }

  return promoted;
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

    // Per-gate timeout override: if the gate defines its own timeoutMs,
    // use that; else fall back to the run-level timeout. Lets long
    // integration checks coexist with sub-second smoke gates in the
    // same archive without having to tune a global for the slowest one.
    const effectiveTimeoutMs = (typeof gate.timeoutMs === "number" && gate.timeoutMs > 0)
      ? gate.timeoutMs
      : opts.timeoutMs;

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
    }, effectiveTimeoutMs);

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
  parts.push("3. End your response with the verdict block described below");
  parts.push("");
  parts.push("## Verdict — REQUIRED");
  parts.push("");
  parts.push("Your response MUST end with a `<verdict>...</verdict>` block. If you omit it, or if prose follows `</verdict>`, your iteration will be force-discarded regardless of the quality of your code changes. Do NOT narrate your verdict in prose instead of emitting the block.");
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
  parts.push("Requirements:");
  parts.push("- Valid JSON: double-quoted strings, no trailing commas, no comments.");
  parts.push("- The block must be the LAST thing you emit. Multiple `<verdict>` blocks are tolerated (the last one wins) but prose after `</verdict>` is ignored.");
  parts.push("- Emit the block even if you end up making no change — use `action: \"discard\"` with a summary explaining why you chose not to act.");
  parts.push("");
  parts.push("Action semantics:");
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
//
// The verdict parser is a multi-layer stack. Each layer catches the cases
// the previous one missed, so we get robustness without a rewrite when
// agents drift off the contract. Observed on snapshot shakedown (2026-04-13)
// that Claude agents skip the fenced block in 40-80% of iterations despite
// explicit instructions — so the cheaper layers here are the difference
// between a working tool and a tool that silently throws away half its work.
//
//   Layer 1: fenced `<verdict>{...}</verdict>` block           (ideal)
//   Layer 2: legacy `VERDICT: KEEP` lines                      (rarely used by agents)
//   Layer 3: natural-language prose inference (keep-only)      (Finding #17)
//   Layer 4: default-keep-if-safe (in the caller, not here)    (Finding #17)
//   Layer 5: spawn a verdict-extraction retry agent            (last resort)
//
// Discard is only returned when an AGENT explicitly signals it (fenced, legacy,
// or explicit prose — "rolling back", "discarding"). We never infer discard
// from absence of signal — silent-destroy is the bug we're defending against.

// Exported for unit testing only — not part of the public API.
export function parseVerdict(output: string): ParsedVerdict {
  // Layer 1: fenced block. High confidence.
  const fenced = tryParseFencedVerdict(output);
  if (fenced) return { ...fenced, parseMethod: "fenced" };

  // Layer 2: legacy line grammar.
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

  if (action) {
    if (!change) change = extractFirstMeaningfulLine(output);
    return { action, change, summary, gateProposals, parseMethod: "legacy-line" };
  }

  // Loose inference from the top-level output for corrupted legacy formats
  // ("the verdict is VERDICT: KEEP" — keyword present but not line-anchored).
  // Kept for backward compatibility with the pre-#17 parser.
  const upper = output.toUpperCase();
  if (upper.includes("VERDICT: CONVERGED") || upper.includes("VERDICT:CONVERGED") || upper.trim() === "CONVERGED") {
    return {
      action: "converged",
      change: change || extractFirstMeaningfulLine(output),
      summary,
      gateProposals,
      parseMethod: "legacy-line",
    };
  }
  if (upper.includes("VERDICT: KEEP") || upper.includes("VERDICT:KEEP")) {
    return {
      action: "keep",
      change: change || extractFirstMeaningfulLine(output),
      summary,
      gateProposals,
      parseMethod: "legacy-line",
    };
  }

  // Layer 3: natural-language prose inference (Finding #17). The agent
  // emitted real work + a prose summary but forgot the structured wrapper.
  // Only infer "keep" or "converged" from prose — never "discard" — so
  // silent destruction remains impossible.
  const inferred = inferVerdictFromProse(output);
  if (inferred) {
    return {
      action: inferred.action,
      change: change || inferred.change || extractFirstMeaningfulLine(output),
      summary: summary || inferred.summary || "",
      gateProposals,
      parseMethod: "inferred-prose",
    };
  }

  // All layers missed. Return a defaulted-discard; callers may upgrade to
  // defaulted-keep (Layer 4) or extraction-retry (Layer 5) with more context.
  return {
    action: "discard",
    change: change || extractFirstMeaningfulLine(output),
    summary: summary || "Could not parse agent verdict — defaulting to discard",
    gateProposals,
    parseFailed: true,
    parseMethod: "defaulted-discard",
  };
}

/** Layer 3 of the verdict-parsing stack (Finding #17): infer a verdict from
 *  natural-language patterns in the agent's prose. Only infers "keep" and
 *  "converged" — never "discard", because discard requires positive evidence
 *  of agent intent. Silent-destroy-the-work is the bug class this whole
 *  stack defends against.
 *
 *  Returns `null` when the signal is absent, weak, or ambiguous (both keep
 *  and discard phrases present in the tail). Ambiguous → fall through to
 *  Layer 4 (default-keep-if-safe) in the caller. */
export function inferVerdictFromProse(
  output: string,
): { action: "keep" | "converged"; change: string; summary: string } | null {
  // Only look at the tail — older prose (file reads, scratchpad thinking)
  // shouldn't dilute the signal from the agent's final summary.
  const tail = output.length > 3000 ? output.slice(-3000) : output;

  // Discard signals force a fall-through. If the agent used any of these,
  // we don't want to guess — either they had a legit discard intent we
  // shouldn't clobber into keep, or the signal is mixed and Layer 4/5
  // will handle it with more context. Kept narrow to avoid false positives
  // on agent self-narration ("I was going to discard but kept it").
  const discardSignals = [
    /\brolling[ -]back\b/i,
    /\breverting (?:the |my |this )?(?:change|work|edit)/i,
    /\bdiscarding (?:this|the|my)\b/i,
    /\bthis (?:change )?(?:made (?:it|things) worse|didn't help|wasn't (?:useful|an improvement))/i,
    /\bnot (?:worth keeping|an improvement)\b/i,
  ];
  for (const re of discardSignals) {
    if (re.test(tail)) return null;
  }

  // Converged signals (rare in practice but worth surfacing).
  const convergedSignals = [
    /\brubric (?:is )?(?:fully |completely |now )?(?:met|satisfied|addressed)\b/i,
    /\ball (?:rubric )?(?:criteria|items|points) (?:are )?(?:met|satisfied|addressed)\b/i,
    /\bnothing (?:more|else|further|left) to (?:do|improve|address|add)\b/i,
    /\bproject (?:is )?(?:now )?converged\b/i,
  ];
  for (const re of convergedSignals) {
    if (re.test(tail)) {
      return { action: "converged", change: "", summary: "inferred: rubric met (prose)" };
    }
  }

  // Keep signals — observed patterns from 2026-04-13 snapshot shakedown.
  // Agents reliably emit "All N tests pass" + change summary after a
  // successful iteration. Also common: "closes/resolves rubric item X".
  const keepSignals = [
    /\ball \d+ tests? (?:pass(?:ing|ed)?|are passing)\b/i,
    /\b(?:close[sd]?|resolve[sd]?|address(?:e[sd])?) (?:the )?rubric\b/i,
    /\b(?:this |the )?change (?:is|was) (?:kept|an improvement|a (?:clear )?win)\b/i,
    /\bi(?:'ll| am going to|'ve)? keep(?:ing|s|t)?\b(?!\s+(?:in mind|track))/i,
    /\bkeeping (?:this|the change|it)\b/i,
  ];
  for (const re of keepSignals) {
    if (re.test(tail)) {
      return { action: "keep", change: "", summary: "inferred: keep (prose pattern)" };
    }
  }

  return null;
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
      // Per-gate timeout in ms or seconds — mirror the loadGateFile ergonomics.
      if (typeof pr.timeoutMs === "number" && pr.timeoutMs > 0 && Number.isFinite(pr.timeoutMs)) {
        proposal.timeoutMs = Math.floor(pr.timeoutMs);
      } else if (typeof pr.timeoutSec === "number" && pr.timeoutSec > 0 && Number.isFinite(pr.timeoutSec)) {
        proposal.timeoutMs = Math.floor(pr.timeoutSec * 1000);
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
    // Accept per-gate timeout in ms or seconds (timeoutSec) — same ergonomic
    // coercion as loadGateFile, since agents write both forms organically.
    if (typeof parsed.timeoutMs === "number" && parsed.timeoutMs > 0 && Number.isFinite(parsed.timeoutMs)) {
      proposal.timeoutMs = Math.floor(parsed.timeoutMs);
    } else if (typeof parsed.timeoutSec === "number" && parsed.timeoutSec > 0 && Number.isFinite(parsed.timeoutSec)) {
      proposal.timeoutMs = Math.floor(parsed.timeoutSec * 1000);
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

// ── Verdict extraction retry ───────────────────────────────────

/**
 * Spawn a tiny extraction agent to recover a verdict when the refinement
 * agent produced real output but forgot the `<verdict>...</verdict>` wrapper.
 * This is the Finding #15 fix: in the 2026-04-13 snapshot validation run,
 * 2 of 5 iterations did real work (tests passed, clean implementations)
 * but emitted their verdict as prose — the harness force-discarded them on
 * parse failure despite the work being keep-quality.
 *
 * The retry is intentionally narrow: it does NOT re-read the code, run
 * tests, or make its own judgment. It only reflects the original agent's
 * stated view back into a parseable block. If the extraction itself also
 * fails (malformed output, spawn error, etc.), returns null and callers
 * fall through to the existing "defaulted to discard" behaviour.
 *
 * Cost: a single short agent turn, typically $0.05–0.15. Compared to the
 * $0.50–1.00 spent on the original iteration, recovering even some of
 * these is a large ROI lift on any multi-iter run.
 */
async function retryVerdictExtraction(
  originalOutput: string,
  bus: SignalBus,
  spawner: AgentSpawner,
  opts: {
    name: string;
    agent?: AgentType;
    model?: string;
    cwd: string;
    sandbox?: string;
  },
): Promise<ParsedVerdict | null> {
  // Tail-truncate: the verdict (if any trace of it exists) lives near the
  // end of the agent's output. 4000 chars is enough to capture the last
  // few turns' worth of prose without blowing up retry cost.
  const tail = originalOutput.length > 4000 ? originalOutput.slice(-4000) : originalOutput;

  const prompt = [
    "A refinement agent produced the output below but did not end it with a",
    "`<verdict>{...}</verdict>` block in the expected format. Your ONLY job is to",
    "read what the agent said and emit the verdict block they should have emitted.",
    "",
    "Rules:",
    "- Read the agent's final statements about what they changed and whether tests passed.",
    "- If the agent indicated their change was a success (tests pass, rubric met, keep-quality), emit action=keep.",
    "- If the agent indicated the change was a problem (tests failed, rolled back, not useful), emit action=discard.",
    "- If the agent said the project is done / rubric fully met, emit action=converged.",
    "- If you genuinely can't tell, emit action=discard — safe default beats a mistaken keep.",
    "- Do NOT make your own judgment about whether the change was actually good. Reflect the agent's stated view.",
    "- Do NOT read files, run commands, or write code. Emit the verdict block and nothing else.",
    "",
    "End your response with this block — exact format:",
    "",
    "<verdict>",
    "{",
    '  "action": "keep" | "discard" | "converged",',
    '  "change": "short description of what the agent said they changed",',
    '  "summary": "why the agent considered it a success or failure"',
    "}",
    "</verdict>",
    "",
    "--- Agent output begins (tail) ---",
    tail,
    "--- Agent output ends ---",
  ].join("\n");

  try {
    const result = await spawnAndWait(bus, spawner, {
      prompt,
      name: opts.name,
      agent: opts.agent,
      model: opts.model,
      worktree: false,
      cwd: opts.cwd,
      timeout: 60,
      sandbox: opts.sandbox,
    });
    const parsed = parseVerdict(result.output);
    if (parsed.parseFailed) return null;
    return parsed;
  } catch (err) {
    console.error(
      `[refine] verdict-extraction retry spawn failed: ${String(err).slice(0, 200)}`,
    );
    return null;
  }
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
  /** Paths the agent actually touched this iteration (diff of dirty set).
   *  When provided, we explicitly remove these from the working tree AFTER
   *  restore — project-git's `git checkout tag -- .` doesn't clean untracked
   *  files, so a discarded attempt's newly-created files would otherwise
   *  linger. Stragglers confuse the next iteration's pre-spawn dirty diff
   *  (file appears already-dirty, so the legitimate re-creation gets
   *  filtered out of agentTouchedPaths at snapshot time). Scoped to paths
   *  the AGENT created, not concurrent user work. */
  agentTouchedPaths?: string[],
): Promise<"continue" | "exhausted"> {
  const lastKeptId = getLastKeptId(variants);
  if (lastKeptId) {
    await restore(dir, lastKeptId);
  }

  // Belt-and-suspenders cleanup for project-git backend. `restore()` handles
  // tracked files via `git checkout tag -- .` — those are back at the parent's
  // content already. But UNTRACKED files the agent created survive `restore()`
  // and pollute the next iteration's dirty baseline, so we clean them here.
  //
  // Finding #16 (2026-04-13): the prior loop called `Deno.remove` on every
  // agent-touched path, which wiped tracked files that the agent had merely
  // modified (restore brought them back; we then deleted them). Fix: intersect
  // `agentTouchedPaths` with the untracked-file set from
  // `git ls-files --others --exclude-standard` so only genuinely-untracked
  // files get removed. Tracked-modified paths are safe.
  //
  // On git-unavailable (shouldn't happen on project-git — agentTouchedPaths
  // comes from `git status` upstream, so git works here — but defend against
  // it), we skip cleanup entirely. Leaving untracked cruft is strictly better
  // than wiping tracked files.
  if (agentTouchedPaths && agentTouchedPaths.length > 0) {
    await cleanupUntrackedAgentPaths(dir, agentTouchedPaths);
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
  verdict: "CONVERGED" | "MAX_ITERATIONS" | "EXHAUSTED" | "WALL_CLOCK_EXCEEDED" | "INFRA_FAILURE",
  iterations: number,
  totalCostUsd: number,
  variants: Variant[],
  finalVariantId: string,
  gateFailures: number,
  gatesProposed: number,
  infraFailures = 0,
  preRunKept = 0,
  preRunDiscarded = 0,
  scopeViolations = 0,
): RefineResult {
  const keptVariants = variants.filter((v) => v.status === "kept" || v.status === "baseline").length;
  const discardedVariants = variants.filter((v) => v.status === "discarded").length;
  return {
    verdict,
    iterations,
    totalCostUsd,
    keptVariants,
    discardedVariants,
    sessionKept: Math.max(0, keptVariants - preRunKept),
    sessionDiscarded: Math.max(0, discardedVariants - preRunDiscarded),
    finalVariantId,
    gateFailures,
    scopeViolations,
    gatesProposed,
    ...(infraFailures > 0 ? { infraFailures } : {}),
  };
}

// ── Public helpers for CLI ─────────────────────────────────────

/** Print the archive tree for --tree flag. `--format json` emits a machine-
 *  readable variant list so orchestrators can parse without regex. */
export async function showRefineTree(dir: string, opts?: { json?: boolean }): Promise<void> {
  try {
    await init(dir);
    if (opts?.json) {
      const variants = await list(dir);
      console.log(JSON.stringify({
        variants: variants.map((v) => ({
          id: v.id,
          status: v.status,
          parent: v.parent ?? null,
          change: v.change ?? "",
          summary: v.summary ?? "",
          timestamp: v.timestamp,
          gates: (v.gates ?? []).map((g) => ({ name: g.name, command: g.command, addedBy: g.addedBy })),
        })),
      }));
      return;
    }
    const treeStr = await tree(dir);
    console.log(treeStr);
  } catch (err) {
    console.error(`[refine] Failed to show tree: ${String(err).slice(0, 200)}`);
  }
}

/** Print the archive status for --status flag. `--format json` emits a
 *  structured summary so orchestrators can gate on it programmatically
 *  (e.g. "only start a new run if no kept variants from today"). */
export async function showRefineStatus(dir: string, opts?: { json?: boolean }): Promise<void> {
  try {
    await init(dir);
    const variants = await list(dir);

    const keptCount = variants.filter((v) => v.status === "kept" || v.status === "baseline").length;
    const discardedCount = variants.filter((v) => v.status === "discarded").length;
    const lastKept = variants.filter((v) => v.status !== "discarded").at(-1);

    // Disk usage — best-effort; may be missing on stripped systems.
    let diskSize: string | null = null;
    try {
      const cmd = new Deno.Command("du", { args: ["-sh", `${dir}/.refine`], stdout: "piped", stderr: "piped" });
      const out = await cmd.output();
      if (out.success) {
        diskSize = new TextDecoder().decode(out.stdout).split("\t")[0]?.trim() ?? null;
      }
    } catch { /* du not available */ }

    // REFINE.md presence
    let refineMdExists = false;
    try {
      await Deno.stat(`${dir}/${REFINE_MD}`);
      refineMdExists = true;
    } catch { /* not created yet */ }

    if (opts?.json) {
      console.log(JSON.stringify({
        dir,
        totalVariants: variants.length,
        kept: keptCount,
        discarded: discardedCount,
        current: lastKept
          ? {
            id: lastKept.id,
            change: lastKept.change ?? "",
            summary: lastKept.summary ?? "",
            timestamp: lastKept.timestamp,
          }
          : null,
        diskSize,
        refineMdExists,
      }));
      return;
    }

    if (variants.length === 0) {
      console.log("No refinement sessions found.");
      return;
    }

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

    if (diskSize) console.log(`\n  Disk:      ${diskSize} (.refine/)`);
    console.log(`  REFINE.md: ${refineMdExists ? "exists" : "not yet created"}`);
  } catch (err) {
    console.error(`[refine] Failed to show status: ${String(err).slice(0, 200)}`);
  }
}

// ── Gate subcommand helpers (for `expo refine <dir> gate ...`) ──

/** Print every gate in the archive, showing where each is directly attached
 *  and which variants inherit it. When variantId is given, only show gates
 *  that variant sees (direct + inherited). `--format json` emits machine-
 *  readable output so orchestrators can filter/inspect programmatically. */
export async function showRefineGates(
  dir: string,
  variantId?: string,
  opts?: { json?: boolean },
): Promise<void> {
  try {
    await init(dir);
    const variants = await list(dir);

    if (opts?.json) {
      if (variantId) {
        const target = variants.find((v) => v.id === variantId);
        if (!target) {
          console.log(JSON.stringify({ ok: false, error: `Variant ${variantId} not found` }));
          Deno.exit(1);
        }
        const direct = await listGates(dir, variantId);
        const inherited = await collectGates(dir, variantId);
        const directNames = new Set(direct.map((g) => g.name));
        console.log(JSON.stringify({
          variantId,
          gates: inherited.map((g) => ({
            name: g.name,
            command: g.command,
            rationale: g.rationale ?? null,
            addedBy: g.addedBy,
            source: directNames.has(g.name) ? "direct" : "inherited",
          })),
        }));
        return;
      }
      // No variantId — emit the whole archive's gate map
      const byVariant: Array<{ variantId: string; status: string; gates: Array<{ name: string; command: string; rationale: string | null }> }> = [];
      let total = 0;
      for (const v of variants) {
        const gates = v.gates ?? [];
        if (gates.length === 0) continue;
        total += gates.length;
        byVariant.push({
          variantId: v.id,
          status: v.status,
          gates: gates.map((g) => ({
            name: g.name,
            command: g.command,
            rationale: g.rationale ?? null,
          })),
        });
      }
      console.log(JSON.stringify({
        totalGates: total,
        totalVariants: variants.length,
        byVariant,
      }));
      return;
    }

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

// ── Gate-file loading ──────────────────────────────────────────

/** Shape accepted by `loadGateFile`. A flat array is the minimum; object
 *  form leaves room for future metadata (e.g. `{version: 1, gates: [...]}`). */
export type GateFileShape =
  | Array<{ name: string; command: string; rationale?: string; timeoutMs?: number }>
  | { gates: Array<{ name: string; command: string; rationale?: string; timeoutMs?: number }> };

/**
 * Read + validate a gate config JSON file. Used by `expo refine --gate-file
 * PATH` to seed the baseline with a curated invariant set without eight
 * repeated `--gate` flags.
 *
 * Accepts either a flat array of `{name, command, rationale?}` OR an object
 * `{gates: [...]}` — the object form lets us add metadata later without
 * breaking consumers.
 *
 * Throws with a pointed error message on: missing file, unparseable JSON,
 * wrong root shape, or any gate missing `name`/`command`. Early throw is
 * intentional — a typo in a gate config is the kind of silent-fail that
 * later manifests as "why didn't my test gate run?"
 */
export async function loadGateFile(
  path: string,
): Promise<Array<{ name: string; command: string; rationale?: string; timeoutMs?: number }>> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch (err) {
    throw new Error(`cannot read gate file ${path}: ${String(err).slice(0, 200)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`gate file ${path} is not valid JSON: ${String(err).slice(0, 200)}`);
  }

  // Normalize both shapes to an array
  let arr: unknown;
  if (Array.isArray(parsed)) {
    arr = parsed;
  } else if (parsed && typeof parsed === "object" && Array.isArray((parsed as { gates?: unknown }).gates)) {
    arr = (parsed as { gates: unknown[] }).gates;
  } else {
    throw new Error(`gate file ${path}: expected array of {name, command, rationale?} or {gates: [...]}`);
  }

  const result: Array<{ name: string; command: string; rationale?: string; timeoutMs?: number }> = [];
  const rawArr = arr as unknown[];
  for (let i = 0; i < rawArr.length; i++) {
    const entry = rawArr[i];
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`gate file ${path}[${i}]: expected object, got ${typeof entry}`);
    }
    const g = entry as Record<string, unknown>;
    if (typeof g.name !== "string" || g.name.trim().length === 0) {
      throw new Error(`gate file ${path}[${i}]: missing or empty "name"`);
    }
    if (typeof g.command !== "string" || g.command.trim().length === 0) {
      throw new Error(`gate file ${path}[${i}] (name=${g.name}): missing or empty "command"`);
    }
    const gate: { name: string; command: string; rationale?: string; timeoutMs?: number } = {
      name: g.name.trim(),
      command: g.command.trim(),
    };
    if (typeof g.rationale === "string" && g.rationale.trim().length > 0) {
      gate.rationale = g.rationale.trim();
    }
    // Per-gate timeout override. Coerce from seconds if users supplied
    // `timeoutSec` (common mistake); otherwise treat `timeoutMs` as ms.
    if (typeof g.timeoutMs === "number" && g.timeoutMs > 0 && Number.isFinite(g.timeoutMs)) {
      gate.timeoutMs = Math.floor(g.timeoutMs);
    } else if (typeof g.timeoutSec === "number" && g.timeoutSec > 0 && Number.isFinite(g.timeoutSec)) {
      gate.timeoutMs = Math.floor(g.timeoutSec * 1000);
    }
    result.push(gate);
  }

  return result;
}

/**
 * De-duplicate a gates list by `name` — later entries win. Used after
 * merging `--gate-file` contents with `--gate` flags so CLI flags can
 * cleanly override the file for one-off customizations without editing
 * the shared config.
 */
export function dedupeGatesByName<G extends { name: string }>(gates: G[]): G[] {
  const byName = new Map<string, G>();
  for (const g of gates) byName.set(g.name, g);
  return Array.from(byName.values());
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

    // Per-gate timeout override — same semantics as runInheritedGates.
    // `timeoutMs` (the --timeout flag to `gate check`) is the fallback.
    const effectiveTimeoutMs = (typeof gate.timeoutMs === "number" && gate.timeoutMs > 0)
      ? gate.timeoutMs
      : timeoutMs;

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
    }, effectiveTimeoutMs);

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
/** Paths that expo's own runtime writes during every refine iteration.
 *  Excluded from agent-touched set so scope enforcement doesn't flag them
 *  (shakedown Finding #8). Excluded by PREFIX — any child under these
 *  dirs is also excluded. */
const EXPO_INTERNAL_PATH_PREFIXES = [
  ".expo/",     // bus/agent log files
  ".sigbus/",   // signal bus persistence
  ".refine/",   // refine manifest + snapshot state (usually gitignored, but belt+suspenders)
];

export function isExpoInternalPath(p: string): boolean {
  return EXPO_INTERNAL_PATH_PREFIXES.some((pfx) => p === pfx.slice(0, -1) || p.startsWith(pfx));
}

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
      const path = arrowIdx >= 0 ? rest.slice(arrowIdx + 4) : rest;
      // Filter expo's own runtime output — those aren't "agent-touched",
      // that's just us writing our own logs/bus state (Finding #8).
      if (isExpoInternalPath(path)) continue;
      paths.add(path);
    }
    return paths;
  } catch {
    return null;
  }
}

/** List paths that git considers untracked (new files the agent created that
 *  aren't in HEAD's tree and aren't gitignored). Used post-restore to
 *  distinguish "agent added a file" from "agent modified a tracked file" —
 *  only the former needs explicit cleanup, since `restore()` already handles
 *  tracked paths via `git checkout tag -- .`.
 *
 *  Returns null when git is unavailable; callers must treat null as "unknown"
 *  and skip the cleanup rather than wipe files blindly. Finding #16. */
export async function listUntrackedPaths(dir: string): Promise<Set<string> | null> {
  try {
    const proc = await new Deno.Command("git", {
      args: ["ls-files", "--others", "--exclude-standard"],
      cwd: dir,
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!proc.success) return null;
    const out = new TextDecoder().decode(proc.stdout);
    const paths = new Set<string>();
    for (const line of out.split("\n")) {
      const p = line.trim();
      if (!p) continue;
      if (isExpoInternalPath(p)) continue;
      paths.add(p);
    }
    return paths;
  } catch {
    return null;
  }
}

/** Remove genuinely-untracked agent-created files from the working tree after
 *  a discard's `restore()`. Tracked-modified files are left alone — restore()
 *  already put them back at the parent's content, and removing them here
 *  would destroy legitimate state (Finding #16, 2026-04-13: this path was
 *  wiping README.md after a scope_violation discard on snapshot).
 *
 *  Best-effort: on git-unavailable or any remove failure, we skip rather than
 *  wipe. Leaving an untracked file behind is annoying; wiping a tracked one
 *  is a bug. */
export async function cleanupUntrackedAgentPaths(
  dir: string,
  agentTouchedPaths: string[],
): Promise<void> {
  if (agentTouchedPaths.length === 0) return;
  const untracked = await listUntrackedPaths(dir);
  if (untracked === null) {
    // git not answering — can't distinguish tracked from untracked safely.
    // Prior behaviour (remove everything) was the source of Finding #16;
    // skip entirely instead. The next iteration's dirty-baseline may be
    // slightly polluted with whatever the agent created, but no tracked
    // state is destroyed.
    return;
  }
  for (const p of agentTouchedPaths) {
    if (!untracked.has(p)) continue; // tracked — restore already handled it
    try {
      await Deno.remove(`${dir}/${p}`, { recursive: true });
    } catch {
      // File may already be gone (concurrent cleanup, symlink races, etc.)
      // or may be a dir that's been partially cleaned — safe to ignore.
    }
  }
}
