/**
 * Pi-Mono Adapter — Transforms pi coding agent `--mode json` output into normalized AgentSignals
 *
 * Pi-mono (badlogic/pi-mono) is a minimal AI coding agent CLI with four built-in
 * tools: read, write, edit, and bash. It supports a `--mode json` flag that emits
 * structured JSONL events on stdout.
 *
 * Decision: STRUCTURED adapter (not generic). Pi-mono has a well-documented JSON
 * output mode with typed events (session, agent_start, turn_start, message_start,
 * message_update, message_end, tool_execution_start, tool_execution_end, turn_end,
 * agent_end). This adapter parses those events into AgentSignals.
 *
 * Usage: `pi --mode json "your prompt" 2>/dev/null`
 *
 * Input:  Lines of JSON from `pi --mode json`
 * Output: AgentSignal objects
 *
 * Pi-mono event types:
 *   session                → spawned
 *   agent_start            → (internal, skip)
 *   turn_start             → (internal, skip)
 *   message_start          → (internal, skip)
 *   message_update         → progress (streaming text chunks)
 *   message_end            → output (final assistant message)
 *   tool_execution_start   → tool_call
 *   tool_execution_end     → tool_result
 *   turn_end               → (internal, skip)
 *   agent_end              → done
 *   auto_compaction_start  → progress
 *   auto_retry_start       → progress
 */

import type { AgentSignal } from "./types.ts";

export interface PiMonoAdapterOptions {
  agentId: string;
  parentId?: string;
}

export function parsePiMonoLine(
  line: string,
  opts: PiMonoAdapterOptions,
): AgentSignal[] {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line);
  } catch {
    return [];
  }

  const type = event.type as string;
  const now = Date.now();
  const base = {
    agentId: opts.agentId,
    parentId: opts.parentId,
    sessionId: (event.id as string) ?? "",
  };

  switch (type) {
    case "session": {
      return [{
        ...base,
        sessionId: (event.id as string) ?? "",
        timestamp: now,
        type: "spawned",
        payload: {
          cwd: (event.cwd as string) ?? "",
          model: "pi-mono",
          tools: ["read", "write", "edit", "bash"],
        },
        _raw: event,
      }];
    }

    case "agent_start":
    case "turn_start":
    case "message_start":
      return []; // internal lifecycle, skip

    case "message_update": {
      const assistantEvent = event.assistantMessageEvent as Record<string, unknown> | undefined;
      const text = extractMessageText(event);
      if (!text) return [];

      return [{
        ...base,
        timestamp: now,
        type: "progress",
        payload: {
          message: text,
          kind: "status",
        },
        _raw: assistantEvent ?? event,
      }];
    }

    case "message_end": {
      const text = extractMessageText(event);
      if (!text) return [];

      return [{
        ...base,
        timestamp: now,
        type: "output",
        payload: {
          text,
        },
        _raw: event,
      }];
    }

    case "tool_execution_start": {
      const toolName = (event.toolName as string) ?? "";
      const args = event.args as Record<string, unknown> | undefined;

      return [{
        ...base,
        timestamp: now,
        type: "tool_call",
        payload: {
          toolUseId: (event.toolCallId as string) ?? "",
          tool: normalizeTool(toolName),
          input: args ?? {},
          isSubagent: false,
        },
        _raw: event,
      }];
    }

    case "tool_execution_end": {
      return [{
        ...base,
        timestamp: now,
        type: "tool_result",
        payload: {
          toolUseId: (event.toolCallId as string) ?? "",
          result: truncate(stringifyResult(event.result), 500),
          isError: (event.isError as boolean) ?? false,
        },
        _raw: event,
      }];
    }

    case "turn_end":
      return []; // internal lifecycle, skip

    case "agent_end": {
      return [{
        ...base,
        timestamp: now,
        type: "done",
        payload: {
          result: "",
          stopReason: "agent_end",
          durationMs: 0, // pi-mono doesn't report duration in the event
          numTurns: 0,
        },
        _raw: event,
      }];
    }

    case "auto_compaction_start": {
      const reason = (event.reason as string) ?? "threshold";
      return [{
        ...base,
        timestamp: now,
        type: "progress",
        payload: {
          message: `Context compaction (${reason})`,
          kind: "status",
        },
        _raw: event,
      }];
    }

    case "auto_retry_start": {
      const attempt = (event.attempt as number) ?? 0;
      const maxAttempts = (event.maxAttempts as number) ?? 0;
      const errorMessage = (event.errorMessage as string) ?? "";
      return [{
        ...base,
        timestamp: now,
        type: "progress",
        payload: {
          message: `Retry ${attempt}/${maxAttempts}: ${errorMessage}`,
          kind: "status",
        },
        _raw: event,
      }];
    }

    default:
      return [];
  }
}

/**
 * Extract text content from a pi-mono message event.
 * Messages contain a `message` field with a `content` array of blocks.
 */
function extractMessageText(event: Record<string, unknown>): string {
  const message = event.message as Record<string, unknown> | undefined;
  if (!message) return "";

  // Try content array (assistant messages have content blocks)
  const content = message.content as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block.type === "text")
      .map((block) => (block.text as string) ?? "")
      .join("");
  }

  // Fallback: try direct text field
  if (typeof message.text === "string") return message.text;

  return "";
}

/**
 * Normalize pi-mono tool names to the expo convention.
 */
function normalizeTool(name: string): string {
  switch (name) {
    case "bash":
      return "Bash";
    case "read":
      return "Read";
    case "write":
      return "Write";
    case "edit":
      return "Edit";
    default:
      return name;
  }
}

function stringifyResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result == null) return "";
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}
