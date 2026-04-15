#!/usr/bin/env -S deno run --allow-all
/**
 * Refine-loop MCP server for `expo refine`.
 *
 * Exposes one tool that the spawned refine agent calls at the end of its
 * iteration to submit a structured verdict. This closes the agent-harness
 * contract gap described in Finding #17 (TASKS.md:79): agents forget the
 * `<verdict>{...}</verdict>` fenced block 40-80% of iters on the Claude CLI
 * adapter, forcing expo's multi-layer parser to recover the work via
 * inferred-prose / defaulted-keep / extraction-retry. The retry alone costs
 * ~$0.10-$0.15 per iter.
 *
 * This server gives the agent a tool it CAN'T skip structurally — Claude's
 * tool-call path is structured output, not prose.
 *
 * # Channel back to the refine loop
 *
 * The server is a child of Claude, not of refine. There's no direct return
 * path. The refine loop sets `EXPO_VERDICT_INBOX` in the MCP config's `env`
 * block when spawning the agent. On `submit_verdict`, we write the verdict
 * JSON to that path. After the agent exits, refine reads the file.
 *
 * Per-iteration isolation: refine generates a fresh inbox path per iter
 * (e.g. `.refine/inbox/verdict-iter-3.json`) so there's never any ambiguity
 * about which iteration's verdict we're reading.
 *
 * # Protocol
 *
 * JSON-RPC 2.0 over stdio, newline-delimited. Same skeleton as
 * `permission-mcp-server.ts`.
 *
 * # Invocation
 *
 * This file exports a `runRefineMcpServer()` function that the compiled
 * `expo` binary dispatches to via a hidden `__refine-mcp-server` subcommand
 * in cli.ts. The MCP config written by `verdict-inbox.ts` points to
 * `${expo_binary} __refine-mcp-server` so the server runs as a child of
 * whatever shipped `expo` — source or compiled, no script path required.
 *
 * Running this file directly (`deno run refine-mcp-server.ts`) also works
 * for local development / tests — the import-time check at the bottom
 * auto-invokes the server when used as the main module.
 */

const SERVER_NAME = "expo_refine";
const TOOL_NAME = "submit_verdict";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function send(id: unknown, result: unknown) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n";
  await Deno.stdout.write(encoder.encode(msg));
}

async function sendError(id: unknown, code: number, message: string) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n";
  await Deno.stdout.write(encoder.encode(msg));
}

/** Surface internal errors/trace to stderr — Claude's stream-json capture
 *  includes our stderr so the refine loop can see server-side problems in
 *  the bus log. Never write trace to stdout; that channel is JSON-RPC only. */
function trace(msg: string) {
  try {
    Deno.stderr.writeSync(encoder.encode(`[refine-mcp] ${msg}\n`));
  } catch {
    // Stderr failures are non-fatal for the protocol.
  }
}

/** Validate and normalize the agent's verdict payload. Returns a cleaned
 *  object on success, or a string describing the validation failure. */
function validateVerdict(
  args: Record<string, unknown>,
): { ok: true; verdict: Record<string, unknown> } | { ok: false; reason: string } {
  const action = args.action;
  if (action !== "keep" && action !== "discard" && action !== "converged") {
    return {
      ok: false,
      reason: `action must be "keep", "discard", or "converged" (got ${JSON.stringify(action)})`,
    };
  }

  const change = args.change;
  if (typeof change !== "string" || change.trim().length === 0) {
    return { ok: false, reason: "change must be a non-empty string" };
  }

  const summary = args.summary;
  if (typeof summary !== "string" || summary.trim().length === 0) {
    return { ok: false, reason: "summary must be a non-empty string" };
  }

  // gate_proposals is optional; validate shape if present.
  const gateProposals: Array<Record<string, unknown>> = [];
  const raw = args.gate_proposals;
  if (raw !== undefined && raw !== null) {
    if (!Array.isArray(raw)) {
      return { ok: false, reason: "gate_proposals must be an array when present" };
    }
    for (let i = 0; i < raw.length; i++) {
      const p = raw[i] as Record<string, unknown> | undefined;
      if (!p || typeof p !== "object") {
        return { ok: false, reason: `gate_proposals[${i}] must be an object` };
      }
      const name = p.name;
      const command = p.command;
      if (typeof name !== "string" || name.trim().length === 0) {
        return { ok: false, reason: `gate_proposals[${i}].name must be a non-empty string` };
      }
      if (typeof command !== "string" || command.trim().length === 0) {
        return { ok: false, reason: `gate_proposals[${i}].command must be a non-empty string` };
      }
      const entry: Record<string, unknown> = { name: name.trim(), command: command.trim() };
      if (typeof p.rationale === "string" && p.rationale.trim().length > 0) {
        entry.rationale = p.rationale.trim();
      }
      gateProposals.push(entry);
    }
  }

  return {
    ok: true,
    verdict: {
      action,
      change: change.trim(),
      summary: summary.trim(),
      gate_proposals: gateProposals,
      submitted_at: new Date().toISOString(),
    },
  };
}

/** Write the verdict to the inbox path from env. Throws if env is missing —
 *  that's a configuration bug in the caller (refine.ts) and we want it loud. */
async function writeVerdictToInbox(verdict: Record<string, unknown>): Promise<string> {
  const inboxPath = Deno.env.get("EXPO_VERDICT_INBOX");
  if (!inboxPath) {
    throw new Error(
      "EXPO_VERDICT_INBOX env var not set — the refine loop must set this when spawning the MCP server",
    );
  }
  // Ensure parent dir exists. refine should have created .refine/inbox/
  // before spawning, but belt-and-suspenders — mkdir -p is idempotent.
  const parent = inboxPath.substring(0, inboxPath.lastIndexOf("/"));
  if (parent) {
    await Deno.mkdir(parent, { recursive: true });
  }
  await Deno.writeTextFile(inboxPath, JSON.stringify(verdict, null, 2));
  return inboxPath;
}

async function handle(msg: Record<string, unknown>) {
  const { id, method, params } = msg as {
    id?: unknown;
    method: string;
    params?: Record<string, unknown>;
  };

  switch (method) {
    case "initialize":
      await send(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: "1.0.0" },
      });
      break;

    case "notifications/initialized":
      // Notification — no response
      break;

    case "tools/list":
      await send(id, {
        tools: [{
          name: TOOL_NAME,
          description:
            "Submit your verdict for this refine iteration. Call this ONCE when you're done — it's the primary way to report your outcome. The loop reads your verdict and decides whether to keep your changes or roll them back.",
          inputSchema: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["keep", "discard", "converged"],
                description:
                  "keep = my changes are good, snapshot them. discard = my changes didn't help, roll back. converged = the rubric is fully satisfied, stop the loop.",
              },
              change: {
                type: "string",
                description:
                  "One-line description of what you changed this iteration (e.g. 'refactored auth to use async/await').",
              },
              summary: {
                type: "string",
                description:
                  "Fuller explanation of what you did and why. Goes into the archive tree.",
              },
              gate_proposals: {
                type: "array",
                description:
                  "Optional: commands to run as gates on future iterations (e.g. new regression tests). Only used if --allow-agent-gates is set.",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string", description: "Short gate name (e.g. 'deno_test')" },
                    command: { type: "string", description: "Shell command to run" },
                    rationale: {
                      type: "string",
                      description: "Why this gate matters (optional but encouraged)",
                    },
                  },
                  required: ["name", "command"],
                },
              },
            },
            required: ["action", "change", "summary"],
          },
        }],
      });
      break;

    case "tools/call": {
      const name = (params as Record<string, unknown>)?.name;
      if (name !== TOOL_NAME) {
        await sendError(id, -32602, `Unknown tool: ${name}`);
        break;
      }

      const args = (params as Record<string, unknown>)?.arguments as
        | Record<string, unknown>
        | undefined;
      if (!args || typeof args !== "object") {
        await send(id, {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: "Missing arguments — submit_verdict requires {action, change, summary}",
            }),
          }],
          isError: true,
        });
        break;
      }

      const validation = validateVerdict(args);
      if (!validation.ok) {
        trace(`validation failed: ${validation.reason}`);
        await send(id, {
          content: [{
            type: "text",
            text: JSON.stringify({ ok: false, error: validation.reason }),
          }],
          isError: true,
        });
        break;
      }

      try {
        const writtenTo = await writeVerdictToInbox(validation.verdict);
        trace(`verdict submitted: action=${validation.verdict.action} → ${writtenTo}`);
        await send(id, {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              action: validation.verdict.action,
              written_to: writtenTo,
            }),
          }],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        trace(`inbox write failed: ${msg}`);
        await send(id, {
          content: [{
            type: "text",
            text: JSON.stringify({ ok: false, error: `inbox write failed: ${msg}` }),
          }],
          isError: true,
        });
      }
      break;
    }

    default:
      if (id !== undefined) {
        await sendError(id, -32601, `Method not found: ${method}`);
      }
  }
}

/** Start the stdio JSON-RPC loop. Reads newline-delimited JSON from stdin
 *  and dispatches to `handle`. Returns when stdin closes. */
export async function runRefineMcpServer(): Promise<void> {
  let buffer = "";
  const reader = Deno.stdin.readable.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value);
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as Record<string, unknown>;
        await handle(msg);
      } catch (err) {
        trace(`malformed line ignored: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

// Direct-invocation support: if someone runs this file via `deno run
// refine-mcp-server.ts` (legacy path, tests), start the server. When the
// compiled `expo` binary dispatches to us via the hidden
// `__refine-mcp-server` subcommand, cli.ts calls runRefineMcpServer()
// directly and this guard is false.
if (import.meta.main) {
  await runRefineMcpServer();
}
