/**
 * Signal Bus — Core Types
 *
 * The normalized signal format that all adapters emit.
 * Consumers (UIs, orchestrators, loggers) only need to understand these types.
 */

export type SignalType =
  | "spawned" // agent created and initialized
  | "progress" // free-form status (thinking, planning)
  | "tool_call" // agent invoked a tool
  | "tool_result" // tool returned a result
  | "output" // streaming text output
  | "done" // task completed successfully
  | "failed" // task failed
  | "cost"; // cost/token update

export interface AgentSignal {
  agentId: string;
  parentId?: string; // who spawned this agent (for subagent trees)
  sessionId: string;
  timestamp: number;
  type: SignalType;
  payload: Record<string, unknown>;
  /** Original event from the agent's native format, preserved for rich consumers */
  _raw?: unknown;
}

// --- Typed payloads for each signal type ---

export interface SpawnedPayload {
  cwd: string;
  model: string;
  tools: string[];
  worktree?: string;
  name?: string;
}

export interface ProgressPayload {
  message: string;
  kind?: "thinking" | "planning" | "status";
}

export interface ToolCallPayload {
  toolUseId: string;
  tool: string;
  input: Record<string, unknown>;
  isSubagent?: boolean; // true when tool is "Agent"
  subagentDescription?: string;
}

export interface ToolResultPayload {
  toolUseId: string;
  result?: string;
  isError?: boolean;
}

export interface OutputPayload {
  text: string;
}

export interface DonePayload {
  result: string;
  stopReason: string;
  durationMs: number;
  numTurns: number;
  permissionDenials?: string[];
}

export interface FailedPayload {
  error: string;
  exitCode?: number;
  permissionDenials?: string[];
}

export interface CostPayload {
  totalCostUsd: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  modelUsage?: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      costUSD: number;
    }
  >;
}

// --- Claude Code stream-json native types ---

export interface ClaudeStreamEvent {
  type: "system" | "assistant" | "user" | "result" | "rate_limit_event";
  subtype?: string;
  session_id?: string;
  uuid?: string;
  [key: string]: unknown;
}
