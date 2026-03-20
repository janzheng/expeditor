/**
 * Claude Adapter — Transforms Claude Code stream-json into normalized AgentSignals
 *
 * Input:  Lines of JSON from `claude -p --output-format stream-json --verbose`
 * Output: AgentSignal objects
 *
 * This adapter is intentionally thin. Claude's stream-json is already well-structured;
 * we're mostly unwrapping content blocks and normalizing field names.
 */

import type {
  AgentSignal,
  CostPayload,
  DonePayload,
  FailedPayload,
  OutputPayload,
  ProgressPayload,
  SpawnedPayload,
  ToolCallPayload,
  ToolResultPayload,
} from "./types.ts";

export interface ClaudeAdapterOptions {
  agentId: string;
  parentId?: string;
}

/**
 * Parse a single stream-json line into zero or more AgentSignals.
 * One input line can produce multiple signals (e.g., an assistant message
 * with both text and tool_use content blocks).
 */
export function parseStreamJsonLine(
  line: string,
  opts: ClaudeAdapterOptions,
): AgentSignal[] {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line);
  } catch {
    return [];
  }

  const type = event.type as string;
  const sessionId = (event.session_id as string) ?? "";
  const now = Date.now();
  const base = {
    agentId: opts.agentId,
    parentId: opts.parentId,
    sessionId,
  };

  switch (type) {
    case "system":
      return [handleSystem(event, base, now)];

    case "assistant":
      return handleAssistant(event, base, now);

    case "user":
      return handleUser(event, base, now);

    case "result":
      return handleResult(event, base, now);

    case "rate_limit_event":
      return []; // skip — internal

    default:
      return [];
  }
}

// --- system → spawned ---

function handleSystem(
  event: Record<string, unknown>,
  base: { agentId: string; parentId?: string; sessionId: string },
  timestamp: number,
): AgentSignal {
  const payload: SpawnedPayload = {
    cwd: (event.cwd as string) ?? "",
    model: (event.model as string) ?? "",
    tools: (event.tools as string[]) ?? [],
  };

  return {
    ...base,
    timestamp,
    type: "spawned",
    payload: payload as unknown as Record<string, unknown>,
    _raw: event,
  };
}

// --- assistant → tool_call, output, progress (one per content block) ---

function handleAssistant(
  event: Record<string, unknown>,
  base: { agentId: string; parentId?: string; sessionId: string },
  timestamp: number,
): AgentSignal[] {
  const signals: AgentSignal[] = [];
  const message = event.message as Record<string, unknown> | undefined;
  if (!message) return signals;

  const content = message.content as Array<Record<string, unknown>> | undefined;
  if (!content) return signals;

  // Determine parentToolUseId for subagent linking
  const parentToolUseId = event.parent_tool_use_id as string | undefined;
  const effectiveParentId = parentToolUseId
    ? `${base.agentId}:${parentToolUseId}`
    : base.parentId;

  for (const block of content) {
    const blockType = block.type as string;

    if (blockType === "tool_use") {
      const toolName = block.name as string;
      const isSubagent = toolName === "Agent";

      const payload: ToolCallPayload = {
        toolUseId: (block.id as string) ?? "",
        tool: toolName,
        input: (block.input as Record<string, unknown>) ?? {},
        isSubagent,
        subagentDescription: isSubagent
          ? ((block.input as Record<string, unknown>)?.description as string)
          : undefined,
      };

      signals.push({
        ...base,
        parentId: effectiveParentId,
        timestamp,
        type: "tool_call",
        payload: payload as unknown as Record<string, unknown>,
        _raw: event,
      });
    } else if (blockType === "text") {
      const text = block.text as string;
      if (text) {
        const payload: OutputPayload = { text };
        signals.push({
          ...base,
          parentId: effectiveParentId,
          timestamp,
          type: "output",
          payload: payload as unknown as Record<string, unknown>,
          _raw: event,
        });
      }
    } else if (blockType === "thinking") {
      const thinking = block.thinking as string;
      if (thinking) {
        const payload: ProgressPayload = {
          message: thinking,
          kind: "thinking",
        };
        signals.push({
          ...base,
          parentId: effectiveParentId,
          timestamp,
          type: "progress",
          payload: payload as unknown as Record<string, unknown>,
          _raw: event,
        });
      }
    }
  }

  return signals;
}

// --- user (tool results) → tool_result ---

function handleUser(
  event: Record<string, unknown>,
  base: { agentId: string; parentId?: string; sessionId: string },
  timestamp: number,
): AgentSignal[] {
  const signals: AgentSignal[] = [];
  const message = event.message as Record<string, unknown> | undefined;

  // Tool results can be in event.tool_use_result or message.content
  const toolResult = event.tool_use_result as Record<string, unknown> | undefined;
  if (toolResult) {
    const payload: ToolResultPayload = {
      toolUseId: (toolResult.id as string) ?? "",
      result: truncate(JSON.stringify(toolResult.content ?? toolResult.output ?? ""), 500),
      isError: (toolResult.is_error as boolean) ?? false,
    };
    signals.push({
      ...base,
      timestamp,
      type: "tool_result",
      payload: payload as unknown as Record<string, unknown>,
      _raw: event,
    });
    return signals;
  }

  // Also check message.content for tool_result blocks
  if (message) {
    const content = message.content as Array<Record<string, unknown>> | undefined;
    if (content) {
      for (const block of content) {
        if (block.type === "tool_result") {
          const payload: ToolResultPayload = {
            toolUseId: (block.tool_use_id as string) ?? "",
            result: truncate(String(block.content ?? ""), 500),
            isError: (block.is_error as boolean) ?? false,
          };
          signals.push({
            ...base,
            timestamp,
            type: "tool_result",
            payload: payload as unknown as Record<string, unknown>,
            _raw: event,
          });
        }
      }
    }
  }

  return signals;
}

// --- result → done + cost ---

function handleResult(
  event: Record<string, unknown>,
  base: { agentId: string; parentId?: string; sessionId: string },
  timestamp: number,
): AgentSignal[] {
  const isError = event.is_error as boolean;
  const usage = (event.usage as Record<string, unknown>) ?? {};
  const modelUsageRaw = event.modelUsage as Record<string, Record<string, unknown>> | undefined;

  // Build cost signal
  const costPayload: CostPayload = {
    totalCostUsd: (event.total_cost_usd as number) ?? 0,
    durationMs: (event.duration_ms as number) ?? 0,
    inputTokens: (usage.input_tokens as number) ?? 0,
    outputTokens: (usage.output_tokens as number) ?? 0,
    cacheReadTokens: (usage.cache_read_input_tokens as number) ?? 0,
    cacheCreationTokens: (usage.cache_creation_input_tokens as number) ?? 0,
    modelUsage: modelUsageRaw
      ? Object.fromEntries(
          Object.entries(modelUsageRaw).map(([model, data]) => [
            model,
            {
              inputTokens: (data.inputTokens as number) ?? 0,
              outputTokens: (data.outputTokens as number) ?? 0,
              costUSD: (data.costUSD as number) ?? 0,
            },
          ]),
        )
      : undefined,
  };

  const costSignal: AgentSignal = {
    ...base,
    timestamp,
    type: "cost",
    payload: costPayload as unknown as Record<string, unknown>,
    _raw: event,
  };

  const permissionDenials = (event.permission_denials as string[]) ?? undefined;

  // Build done or failed signal
  if (isError) {
    const failedPayload: FailedPayload = {
      error: (event.result as string) ?? "Unknown error",
      permissionDenials,
    };
    return [
      {
        ...base,
        timestamp,
        type: "failed",
        payload: failedPayload as unknown as Record<string, unknown>,
        _raw: event,
      },
      costSignal,
    ];
  }

  const donePayload: DonePayload = {
    result: truncate((event.result as string) ?? "", 1000),
    stopReason: (event.stop_reason as string) ?? "",
    durationMs: (event.duration_ms as number) ?? 0,
    numTurns: (event.num_turns as number) ?? 0,
    permissionDenials,
  };

  return [
    {
      ...base,
      timestamp,
      type: "done",
      payload: donePayload as unknown as Record<string, unknown>,
      _raw: event,
    },
    costSignal,
  ];
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}
