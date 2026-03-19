/**
 * Generic CLI Adapter — Wraps any process with basic lifecycle signals
 *
 * For agents that don't emit structured output (no stream-json equivalent).
 * Emits: spawned, output (per stdout line), done/failed (exit code).
 * No tool_call parsing — just process lifecycle.
 */

import type { AgentSignal } from "./types.ts";

export interface GenericAdapterOptions {
  agentId: string;
  parentId?: string;
  sessionId?: string;
}

/**
 * Create a spawned signal for a generic process.
 */
export function makeSpawnedSignal(
  opts: GenericAdapterOptions & { command: string; cwd: string },
): AgentSignal {
  return {
    agentId: opts.agentId,
    parentId: opts.parentId,
    sessionId: opts.sessionId ?? "",
    timestamp: Date.now(),
    type: "spawned",
    payload: {
      cwd: opts.cwd,
      command: opts.command,
      model: "generic",
      tools: [],
    },
  };
}

/**
 * Parse a single stdout line into an output signal.
 */
export function parseGenericLine(
  line: string,
  opts: GenericAdapterOptions,
): AgentSignal[] {
  if (!line.trim()) return [];

  return [
    {
      agentId: opts.agentId,
      parentId: opts.parentId,
      sessionId: opts.sessionId ?? "",
      timestamp: Date.now(),
      type: "output",
      payload: { text: line },
    },
  ];
}

/**
 * Create a done or failed signal based on exit code.
 */
export function makeExitSignal(
  opts: GenericAdapterOptions & {
    exitCode: number;
    durationMs: number;
  },
): AgentSignal {
  if (opts.exitCode === 0) {
    return {
      agentId: opts.agentId,
      parentId: opts.parentId,
      sessionId: opts.sessionId ?? "",
      timestamp: Date.now(),
      type: "done",
      payload: {
        result: "",
        stopReason: "exit",
        durationMs: opts.durationMs,
        numTurns: 0,
      },
    };
  }

  return {
    agentId: opts.agentId,
    parentId: opts.parentId,
    sessionId: opts.sessionId ?? "",
    timestamp: Date.now(),
    type: "failed",
    payload: {
      error: `Process exited with code ${opts.exitCode}`,
      exitCode: opts.exitCode,
    },
  };
}
