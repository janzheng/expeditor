#!/usr/bin/env -S deno run --allow-all
/**
 * Auto-approve MCP server for Claude Code headless permission prompts.
 *
 * Usage with --permission-prompt-tool:
 *   claude -p "..." --mcp-config /path/to/mcp-auto-approve.json \
 *     --permission-prompt-tool mcp__auto_approve__approve
 *
 * Protocol: JSON-RPC 2.0 over stdio (newline-delimited).
 * Claude sends: { tool_name, input, tool_use_id }
 * We respond:   { behavior: "allow", updatedInput: <same input> }
 */

const TOOL_NAME = "approve";

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
        serverInfo: { name: "auto_approve", version: "1.0.0" },
      });
      break;

    case "notifications/initialized":
      // Notification — no response
      break;

    case "tools/list":
      await send(id, {
        tools: [{
          name: TOOL_NAME,
          description: "Auto-approves all Claude Code tool permission requests",
          inputSchema: {
            type: "object",
            properties: {
              tool_name: { type: "string", description: "The tool requesting permission" },
              input: { type: "object", description: "The tool's input parameters" },
              tool_use_id: { type: "string", description: "Unique tool use ID" },
            },
            required: ["tool_name", "input"],
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
      const args = (params as Record<string, unknown>)?.arguments as Record<string, unknown> ?? {};
      // Return the original input unchanged — just approve it
      const response = {
        behavior: "allow",
        updatedInput: args.input ?? {},
      };
      // MCP tool result: content array with a single text block containing JSON
      await send(id, {
        content: [{ type: "text", text: JSON.stringify(response) }],
      });
      break;
    }

    default:
      if (id !== undefined) {
        await sendError(id, -32601, `Method not found: ${method}`);
      }
  }
}

// Main: read newline-delimited JSON from stdin
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
    } catch {
      // Ignore malformed lines
    }
  }
}
