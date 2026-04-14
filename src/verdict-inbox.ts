/**
 * Per-iteration verdict inbox — the channel from `refine-mcp-server.ts`
 * back to `refine.ts`.
 *
 * The MCP server runs as a child of Claude, not of refine. When the agent
 * calls `submit_verdict`, the server writes the verdict JSON to a path
 * passed via the `EXPO_VERDICT_INBOX` env var in its MCP config. After the
 * agent exits, refine reads that file here.
 *
 * Per-iteration isolation (choice (a) from the design sketch): refine
 * generates a fresh inbox path AND a fresh MCP config per iteration, so
 * there's zero ambiguity about which iteration's verdict is in which file.
 * Stale files from a prior iter can never leak into the next one's reading.
 *
 * See Finding #17 in expo's TASKS.md for the motivating pain.
 */

import { dirname, join } from "https://deno.land/std/path/mod.ts";

/** Shape of the JSON the MCP server writes. Must stay in sync with
 *  `refine-mcp-server.ts`'s `validateVerdict` output. */
export interface InboxVerdict {
  action: "keep" | "discard" | "converged";
  change: string;
  summary: string;
  gate_proposals: Array<{ name: string; command: string; rationale?: string }>;
  submitted_at: string;
}

/** A trimmed-down ParsedVerdict-shaped projection of the inbox contents.
 *  Matches refine.ts's `ParsedVerdict` and `GateProposal` shapes closely
 *  enough that refine's Layer 0 can drop this straight into its cascade.
 *  We intentionally don't import from refine.ts to keep this module
 *  dependency-light for testing. */
export interface InboxParsedVerdict {
  action: "keep" | "discard" | "converged";
  change: string;
  summary: string;
  gateProposals: Array<{ name: string; command: string; rationale?: string }>;
}

// ── Path helpers ───────────────────────────────────────────────

/** Root directory for per-iteration inbox files and config files.
 *  Lives under the target project's `.refine/` so it's scoped and gets
 *  cleaned up with the rest of refine state. */
export function verdictInboxRoot(dir: string): string {
  return join(dir, ".refine", "inbox");
}

/** Deterministic per-iteration inbox path. Uses the iteration number so a
 *  resumed run after crash still picks up the right file. */
export function inboxPathForIteration(dir: string, iteration: number): string {
  return join(verdictInboxRoot(dir), `verdict-iter-${iteration}.json`);
}

/** Deterministic per-iteration MCP config path. One config file per iter,
 *  matching the inbox path — keeps them in lockstep. */
export function mcpConfigPathForIteration(dir: string, iteration: number): string {
  return join(verdictInboxRoot(dir), `mcp-config-iter-${iteration}.json`);
}

// ── MCP config generation ──────────────────────────────────────

/** Decide how the MCP config should spawn the refine server.
 *
 *  When expo is running as a compiled binary (`~/.deno/bin/expo`),
 *  `import.meta.url` points into the binary's virtual self-extract, which
 *  isn't a real file the MCP spawn can reach. Instead, dispatch via the
 *  currently-running executable's hidden `__refine-mcp-server` subcommand
 *  (see cli.ts).
 *
 *  When running from source (`deno task expo refine ...`), `Deno.execPath()`
 *  is the deno binary itself — spawn it with `run --allow-all <file>`.
 *
 *  Exported for test visibility; callers should prefer `buildRefineMcpServerBlock`. */
export function resolveMcpServerCommand(): { command: string; args: string[] } {
  const execPath = Deno.execPath();
  const execBase = execPath.split("/").pop() ?? "";

  // Heuristic: if we're running under the deno binary (from source or
  // `deno run`), we need to spawn deno to re-run the server script. Any
  // other executable name means we're the compiled `expo` binary and can
  // re-invoke ourselves with the hidden subcommand.
  if (execBase === "deno") {
    const scriptPath = new URL("./refine-mcp-server.ts", import.meta.url).pathname;
    return { command: execPath, args: ["run", "--allow-all", scriptPath] };
  }

  return { command: execPath, args: ["__refine-mcp-server"] };
}

/** MCP server block for the refine-mcp server, wired to write to the given
 *  inbox path. Returned as a plain object so callers can merge it with other
 *  servers (e.g. the auto-approve permission server) before writing. */
export function buildRefineMcpServerBlock(
  inboxPath: string,
): Record<string, unknown> {
  const { command, args } = resolveMcpServerCommand();
  return {
    command,
    args,
    env: { EXPO_VERDICT_INBOX: inboxPath },
  };
}

/** Merge the refine-mcp server block with an optional existing MCP config
 *  file (e.g. the auto-approve permission server) and write the combined
 *  config to `outPath`. Returns `outPath` for chaining.
 *
 *  If `existingConfigPath` is provided, reads and merges its `mcpServers`
 *  into the output. On name collision, the refine-mcp server wins — but
 *  the server name is namespaced (`expo_refine`) so collisions should
 *  never happen in practice. We log a warning if they do. */
export async function writeRefineMcpConfig(
  outPath: string,
  inboxPath: string,
  existingConfigPath?: string,
): Promise<string> {
  const mergedServers: Record<string, unknown> = {};

  if (existingConfigPath) {
    try {
      const existing = JSON.parse(await Deno.readTextFile(existingConfigPath)) as {
        mcpServers?: Record<string, unknown>;
      };
      if (existing.mcpServers && typeof existing.mcpServers === "object") {
        Object.assign(mergedServers, existing.mcpServers);
      }
    } catch (err) {
      // Bad existing config → warn, continue with just our server. Better
      // to run partial than to refuse entirely and break the user's loop.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[refine] could not read existing MCP config at ${existingConfigPath}: ${msg} — using refine-mcp server only`,
      );
    }
  }

  if ("expo_refine" in mergedServers) {
    console.warn(
      `[refine] existing MCP config already has an 'expo_refine' server — overwriting with our version`,
    );
  }
  mergedServers.expo_refine = buildRefineMcpServerBlock(inboxPath);

  await Deno.mkdir(dirname(outPath), { recursive: true });
  await Deno.writeTextFile(
    outPath,
    JSON.stringify({ mcpServers: mergedServers }, null, 2),
  );
  return outPath;
}

// ── Inbox reader ───────────────────────────────────────────────

/** Read the verdict inbox for the given iteration. Returns the parsed
 *  verdict on success, or `null` if the file is missing / unreadable /
 *  malformed. `null` is the signal for "agent didn't call submit_verdict
 *  this iteration" — refine's Layer 0 falls through to Layer 1+ on null.
 *
 *  This function never throws on missing or malformed files. The inbox is
 *  best-effort: if the agent skips the tool OR the file is somehow
 *  corrupted, we want the fallback parser layers to kick in, not an
 *  exception that kills the run. */
export async function readVerdictInbox(
  inboxPath: string,
): Promise<InboxParsedVerdict | null> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(inboxPath);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    console.warn(
      `[refine] verdict inbox read failed (${inboxPath}): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  let parsed: InboxVerdict;
  try {
    parsed = JSON.parse(raw) as InboxVerdict;
  } catch (err) {
    console.warn(
      `[refine] verdict inbox has malformed JSON (${inboxPath}): ${err instanceof Error ? err.message : String(err)} — falling back to prose parser`,
    );
    return null;
  }

  // Shape validation. The MCP server validates on write, but the file is
  // on disk — a concurrent actor could have tampered with it, or a human
  // could have hand-edited. Verify the shape before trusting it.
  if (
    parsed.action !== "keep" &&
    parsed.action !== "discard" &&
    parsed.action !== "converged"
  ) {
    console.warn(
      `[refine] verdict inbox has invalid action (${inboxPath}): ${JSON.stringify(parsed.action)} — falling back`,
    );
    return null;
  }
  if (typeof parsed.change !== "string" || parsed.change.trim().length === 0) {
    console.warn(`[refine] verdict inbox missing change (${inboxPath}) — falling back`);
    return null;
  }
  if (typeof parsed.summary !== "string" || parsed.summary.trim().length === 0) {
    console.warn(`[refine] verdict inbox missing summary (${inboxPath}) — falling back`);
    return null;
  }

  const gateProposals: Array<{ name: string; command: string; rationale?: string }> = [];
  if (Array.isArray(parsed.gate_proposals)) {
    for (const p of parsed.gate_proposals) {
      if (!p || typeof p !== "object") continue;
      if (typeof p.name !== "string" || p.name.trim().length === 0) continue;
      if (typeof p.command !== "string" || p.command.trim().length === 0) continue;
      const entry: { name: string; command: string; rationale?: string } = {
        name: p.name.trim(),
        command: p.command.trim(),
      };
      if (typeof p.rationale === "string" && p.rationale.trim().length > 0) {
        entry.rationale = p.rationale.trim();
      }
      gateProposals.push(entry);
    }
  }

  return {
    action: parsed.action,
    change: parsed.change.trim(),
    summary: parsed.summary.trim(),
    gateProposals,
  };
}

// ── Lifecycle helpers ──────────────────────────────────────────

/** Best-effort cleanup of the inbox + config files for one iteration.
 *  Called after the loop is done with iter N's verdict. Failures are
 *  logged but never thrown — stale files in `.refine/inbox/` are
 *  cosmetic, not correctness-breaking. */
export async function cleanupInboxIteration(
  dir: string,
  iteration: number,
): Promise<void> {
  const paths = [
    inboxPathForIteration(dir, iteration),
    mcpConfigPathForIteration(dir, iteration),
  ];
  for (const p of paths) {
    try {
      await Deno.remove(p);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) continue;
      // Swallow; not worth interrupting the loop.
    }
  }
}
