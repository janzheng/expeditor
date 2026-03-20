/**
 * OpenCode Adapter — Transforms OpenCode CLI --format json output into normalized AgentSignals
 *
 * Input:  Lines of JSON from `opencode run --format json`
 * Output: AgentSignal objects
 *
 * OpenCode event types (each line is `{ type, timestamp, sessionID, ...data }`):
 *   step_start          -> progress (status: planning/thinking)
 *   tool_use            -> tool_call + tool_result (part.state has input & output)
 *   text                -> output
 *   reasoning           -> progress (kind: thinking)
 *   step_finish         -> done + cost
 *   error               -> failed
 *
 * Note: OpenCode emits events via its `emit()` helper in run.ts.
 * The `part` field contains the message part object with type-specific data.
 * Tool parts have `part.state` with status, input, output, and error fields.
 */

import type { AgentSignal } from "./types.ts";

export interface OpenCodeAdapterOptions {
  agentId: string;
  parentId?: string;
}

export function parseOpenCodeLine(
  line: string,
  opts: OpenCodeAdapterOptions,
): AgentSignal[] {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line);
  } catch {
    return [];
  }

  const type = event.type as string;
  const now = (event.timestamp as number) ?? Date.now();
  const base = {
    agentId: opts.agentId,
    parentId: opts.parentId,
    sessionId: (event.sessionID as string) ?? "",
  };

  switch (type) {
    case "step_start": {
      // A new inference step is beginning
      const part = event.part as Record<string, unknown> | undefined;
      return [{
        ...base,
        timestamp: now,
        type: "spawned",
        payload: {
          cwd: "",
          model: "opencode",
          tools: [], // OpenCode doesn't enumerate tools in step_start
        },
        _raw: event,
      }, {
        ...base,
        timestamp: now,
        type: "progress",
        payload: {
          message: "Step started",
          kind: "planning",
        },
        _raw: event,
      }];
    }

    case "tool_use": {
      // Tool invocation — part.tool is the tool name, part.state has input/output
      const part = event.part as Record<string, unknown> | undefined;
      if (!part) return [];

      const toolName = (part.tool as string) ?? "unknown";
      const state = (part.state as Record<string, unknown>) ?? {};
      const status = state.status as string;
      const input = (state.input as Record<string, unknown>) ?? {};
      const isSubagent = toolName === "task";

      const signals: AgentSignal[] = [];

      // Always emit a tool_call signal
      signals.push({
        ...base,
        timestamp: now,
        type: "tool_call",
        payload: {
          toolUseId: (part.id as string) ?? "",
          tool: toolName,
          input,
          isSubagent,
          subagentDescription: isSubagent
            ? (input.description as string) ?? undefined
            : undefined,
        },
        _raw: event,
      });

      // If the tool has completed or errored, also emit a tool_result
      if (status === "completed") {
        signals.push({
          ...base,
          timestamp: now,
          type: "tool_result",
          payload: {
            toolUseId: (part.id as string) ?? "",
            result: truncate(String(state.output ?? ""), 500),
            isError: false,
          },
          _raw: event,
        });
      } else if (status === "error") {
        signals.push({
          ...base,
          timestamp: now,
          type: "tool_result",
          payload: {
            toolUseId: (part.id as string) ?? "",
            result: truncate(String(state.error ?? "Tool error"), 500),
            isError: true,
          },
          _raw: event,
        });
      }

      return signals;
    }

    case "text": {
      // Text output from the assistant
      const part = event.part as Record<string, unknown> | undefined;
      if (!part) return [];

      const text = (part.text as string) ?? "";
      if (!text.trim()) return [];

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

    case "reasoning": {
      // Thinking/reasoning block from the model
      const part = event.part as Record<string, unknown> | undefined;
      if (!part) return [];

      const text = (part.text as string) ?? "";
      if (!text.trim()) return [];

      return [{
        ...base,
        timestamp: now,
        type: "progress",
        payload: {
          message: text,
          kind: "thinking",
        },
        _raw: event,
      }];
    }

    case "step_finish": {
      // Step completed — emit done + cost
      // Note: OpenCode doesn't report token usage in step_finish events directly.
      // Token/cost data may need to be extracted from the part or session metadata.
      const part = event.part as Record<string, unknown> | undefined;
      const metadata = (part as Record<string, unknown>) ?? {};

      return [
        {
          ...base,
          timestamp: now,
          type: "done",
          payload: {
            result: "",
            stopReason: "step_finished",
            durationMs: 0, // OpenCode doesn't report duration in step_finish
            numTurns: 1,
          },
          _raw: event,
        },
        {
          ...base,
          timestamp: now,
          type: "cost",
          payload: {
            totalCostUsd: 0, // Not reported in step_finish — see session summary
            durationMs: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
          _raw: event,
        },
      ];
    }

    case "error": {
      // Session error
      const error = event.error as Record<string, unknown> | undefined;
      let errorMessage = "Unknown error";

      if (error) {
        const data = error.data as Record<string, unknown> | undefined;
        errorMessage = (data?.message as string)
          ?? (error.name as string)
          ?? "Unknown error";
      }

      return [{
        ...base,
        timestamp: now,
        type: "failed",
        payload: {
          error: errorMessage,
          exitCode: -1,
        },
        _raw: event,
      }];
    }

    default:
      return [];
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}
