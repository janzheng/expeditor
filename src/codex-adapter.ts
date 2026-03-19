/**
 * Codex Adapter — Transforms Codex CLI --json output into normalized AgentSignals
 *
 * Input:  Lines of JSON from `codex exec --json --full-auto`
 * Output: AgentSignal objects
 *
 * Codex event types:
 *   thread.started  → spawned
 *   turn.started    → (internal, skip)
 *   item.started    → tool_call (command_execution)
 *   item.completed  → tool_result (command_execution) or output (agent_message)
 *   turn.completed  → done + cost
 */

import type { AgentSignal } from "./types.ts";

export interface CodexAdapterOptions {
  agentId: string;
  parentId?: string;
}

export function parseCodexLine(
  line: string,
  opts: CodexAdapterOptions,
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
    sessionId: (event.thread_id as string) ?? "",
  };

  switch (type) {
    case "thread.started":
      return [{
        ...base,
        sessionId: (event.thread_id as string) ?? "",
        timestamp: now,
        type: "spawned",
        payload: {
          cwd: "",
          model: "codex",
          tools: ["command_execution"],
        },
        _raw: event,
      }];

    case "turn.started":
      return []; // internal

    case "item.started": {
      const item = event.item as Record<string, unknown> | undefined;
      if (!item) return [];

      if (item.type === "command_execution") {
        return [{
          ...base,
          timestamp: now,
          type: "tool_call",
          payload: {
            toolUseId: (item.id as string) ?? "",
            tool: "Bash",
            input: { command: (item.command as string) ?? "" },
            isSubagent: false,
          },
          _raw: event,
        }];
      }
      return [];
    }

    case "item.completed": {
      const item = event.item as Record<string, unknown> | undefined;
      if (!item) return [];

      if (item.type === "command_execution") {
        return [{
          ...base,
          timestamp: now,
          type: "tool_result",
          payload: {
            toolUseId: (item.id as string) ?? "",
            result: truncate((item.aggregated_output as string) ?? "", 500),
            isError: (item.exit_code as number) !== 0,
          },
          _raw: event,
        }];
      }

      if (item.type === "agent_message") {
        return [{
          ...base,
          timestamp: now,
          type: "output",
          payload: {
            text: (item.text as string) ?? "",
          },
          _raw: event,
        }];
      }

      return [];
    }

    case "turn.completed": {
      const usage = (event.usage as Record<string, unknown>) ?? {};
      const inputTokens = (usage.input_tokens as number) ?? 0;
      const cachedTokens = (usage.cached_input_tokens as number) ?? 0;
      const outputTokens = (usage.output_tokens as number) ?? 0;

      // Codex doesn't report cost directly — estimate from tokens
      // (rough estimate: $0.005/1k input, $0.015/1k output for codex models)
      const estimatedCost = (inputTokens * 0.005 + outputTokens * 0.015) / 1000;

      return [
        {
          ...base,
          timestamp: now,
          type: "done",
          payload: {
            result: "",
            stopReason: "turn_completed",
            durationMs: 0, // Codex doesn't report duration
            numTurns: 1,
          },
          _raw: event,
        },
        {
          ...base,
          timestamp: now,
          type: "cost",
          payload: {
            totalCostUsd: estimatedCost,
            durationMs: 0,
            inputTokens,
            outputTokens,
            cacheReadTokens: cachedTokens,
            cacheCreationTokens: 0,
          },
          _raw: event,
        },
      ];
    }

    default:
      return [];
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}
