#!/usr/bin/env -S deno run --allow-all

/**
 * Expo TUI Dashboard — Slate-style agent cards with live updates
 *
 * Usage:
 *   deno run --allow-all src/tui.tsx <bus-file.jsonl>
 *   # Or pipe live: expo spawn-all tasks.json 2>&1 | deno run --allow-all src/tui.tsx --live
 */

// @deno-types="npm:@types/react@19"
import React, { useState, useEffect } from "npm:react@19";
import { render, Box, Text } from "npm:ink@6";
import type { AgentSignal } from "./types.ts";

// --- Agent state derived from signals ---

interface AgentState {
  agentId: string;
  sessionId: string;
  status: "spawned" | "working" | "done" | "failed";
  model: string;
  task: string;
  toolCalls: { tool: string; detail: string; success?: boolean }[];
  latestText: string;
  costUsd: number;
  durationMs: number;
  tokens: number;
  startedAt: number;
}

function reduceSignal(agents: Map<string, AgentState>, signal: AgentSignal): Map<string, AgentState> {
  const next = new Map(agents);
  const id = signal.agentId;

  if (!next.has(id)) {
    next.set(id, {
      agentId: id,
      sessionId: signal.sessionId,
      status: "spawned",
      model: "",
      task: "",
      toolCalls: [],
      latestText: "",
      costUsd: 0,
      durationMs: 0,
      tokens: 0,
      startedAt: Date.now(),
    });
  }

  const agent = { ...next.get(id)! };

  switch (signal.type) {
    case "spawned": {
      const p = signal.payload as Record<string, unknown>;
      agent.model = (p.model as string) ?? "";
      agent.status = "spawned";
      agent.startedAt = signal.timestamp;
      break;
    }
    case "tool_call": {
      const p = signal.payload as Record<string, unknown>;
      const tool = p.tool as string;
      const isSubagent = p.isSubagent as boolean;
      let detail = "";
      if (isSubagent) {
        detail = (p.subagentDescription as string) ?? "";
      } else {
        const input = p.input as Record<string, unknown>;
        if (tool === "Read" || tool === "Edit" || tool === "Write") detail = (input?.file_path as string) ?? "";
        else if (tool === "Bash") detail = String(input?.command ?? "").slice(0, 50);
        else if (tool === "Glob" || tool === "Grep") detail = (input?.pattern as string) ?? "";
      }
      agent.toolCalls = [...agent.toolCalls, { tool: isSubagent ? "Agent" : tool, detail }];
      agent.status = "working";
      break;
    }
    case "tool_result": {
      const p = signal.payload as Record<string, unknown>;
      if (agent.toolCalls.length > 0) {
        const last = { ...agent.toolCalls[agent.toolCalls.length - 1] };
        last.success = !(p.isError as boolean);
        agent.toolCalls = [...agent.toolCalls.slice(0, -1), last];
      }
      break;
    }
    case "output": {
      const text = (signal.payload as Record<string, unknown>).text as string;
      if (text) agent.latestText = text.slice(0, 200);
      agent.status = "working";
      break;
    }
    case "done": {
      const p = signal.payload as Record<string, unknown>;
      agent.status = "done";
      agent.durationMs = (p.durationMs as number) ?? 0;
      break;
    }
    case "failed": {
      agent.status = "failed";
      agent.latestText = (signal.payload as Record<string, unknown>).error as string ?? "";
      break;
    }
    case "cost": {
      const p = signal.payload as Record<string, unknown>;
      agent.costUsd = (p.totalCostUsd as number) ?? 0;
      agent.tokens = ((p.inputTokens as number) ?? 0) + ((p.outputTokens as number) ?? 0);
      agent.durationMs = (p.durationMs as number) ?? agent.durationMs;
      break;
    }
  }

  next.set(id, agent);
  return next;
}

// --- Components ---

function StatusDot({ status }: { status: AgentState["status"] }) {
  const colors: Record<string, string> = {
    spawned: "blue",
    working: "yellow",
    done: "green",
    failed: "red",
  };
  const icons: Record<string, string> = {
    spawned: "○",
    working: "●",
    done: "✓",
    failed: "✗",
  };
  return <Text color={colors[status]}>{icons[status]}</Text>;
}

function ToolCallLine({ tc, collapsed }: { tc: { tool: string; detail: string; success?: boolean }; collapsed?: boolean }) {
  const icon = tc.success === undefined ? "…" : tc.success ? "✓" : "✗";
  const iconColor = tc.success === undefined ? "yellow" : tc.success ? "green" : "red";
  if (collapsed) return null;
  return (
    <Box>
      <Text dimColor>  ├ </Text>
      <Text>{tc.tool}</Text>
      <Text dimColor> {tc.detail ? tc.detail.slice(0, 40) : ""} </Text>
      <Text color={iconColor}>{icon}</Text>
    </Box>
  );
}

function AgentCard({ agent }: { agent: AgentState }) {
  const dur = agent.durationMs > 0
    ? `${(agent.durationMs / 1000).toFixed(1)}s`
    : `${((Date.now() - agent.startedAt) / 1000).toFixed(0)}s…`;

  const maxTools = 5;
  const hiddenCount = Math.max(0, agent.toolCalls.length - maxTools);
  const visibleTools = agent.toolCalls.slice(-maxTools);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={
      agent.status === "done" ? "green" :
      agent.status === "failed" ? "red" :
      agent.status === "working" ? "yellow" : "gray"
    } paddingX={1} width={44}>
      <Box>
        <StatusDot status={agent.status} />
        <Text bold> {agent.agentId}</Text>
        <Text dimColor> {agent.model.split("[")[0]}</Text>
      </Box>

      {hiddenCount > 0 && (
        <Text dimColor>  … +{hiddenCount} earlier tools</Text>
      )}

      {visibleTools.map((tc, i) => (
        <ToolCallLine key={i} tc={tc} />
      ))}

      {agent.latestText && (
        <Box marginTop={0}>
          <Text dimColor wrap="truncate">  {agent.latestText.slice(0, 80)}</Text>
        </Box>
      )}

      <Box marginTop={0}>
        <Text dimColor>  {dur}</Text>
        {agent.costUsd > 0 && <Text dimColor> · ${agent.costUsd.toFixed(4)}</Text>}
        {agent.tokens > 0 && <Text dimColor> · {agent.tokens}tok</Text>}
      </Box>
    </Box>
  );
}

function Dashboard({ signals }: { signals: AgentSignal[] }) {
  const [agents, setAgents] = useState<Map<string, AgentState>>(new Map());

  useEffect(() => {
    let state = new Map<string, AgentState>();
    for (const signal of signals) {
      state = reduceSignal(state, signal);
    }
    setAgents(state);
  }, [signals.length]);

  const agentList = Array.from(agents.values());
  const totalCost = agentList.reduce((sum, a) => sum + a.costUsd, 0);
  const doneCount = agentList.filter(a => a.status === "done").length;
  const failCount = agentList.filter(a => a.status === "failed").length;

  // Grid layout — 3 cards per row
  const rows: AgentState[][] = [];
  for (let i = 0; i < agentList.length; i += 3) {
    rows.push(agentList.slice(i, i + 3));
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>expo dashboard</Text>
        <Text dimColor>  {agentList.length} agents · </Text>
        <Text color="green">{doneCount} done</Text>
        {failCount > 0 && <Text color="red"> · {failCount} failed</Text>}
        <Text dimColor> · ${totalCost.toFixed(4)}</Text>
        <Text dimColor>  (Ctrl+C to quit)</Text>
      </Box>

      {rows.map((row, ri) => (
        <Box key={ri} gap={1}>
          {row.map(agent => (
            <AgentCard key={agent.agentId} agent={agent} />
          ))}
        </Box>
      ))}
    </Box>
  );
}

// --- Main ---

const file = Deno.args[0];

if (!file) {
  console.log("Usage: deno run --allow-all src/tui.tsx <bus-file.jsonl>");
  console.log("       deno run --allow-all src/tui.tsx <bus-file.jsonl> --watch");
  Deno.exit(0);
}

// Load signals
const content = await Deno.readTextFile(file);
const signals: AgentSignal[] = content
  .trim()
  .split("\n")
  .filter(Boolean)
  .map(line => { try { return JSON.parse(line); } catch { return null; } })
  .filter(Boolean);

const watchMode = Deno.args.includes("--watch");

const inkOpts = { exitOnCtrlC: true };

if (watchMode) {
  // Poll file for changes
  const { waitUntilExit } = render(<Dashboard signals={signals} />, inkOpts);

  const interval = setInterval(async () => {
    try {
      const newContent = await Deno.readTextFile(file);
      const newSignals = newContent
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);

      if (newSignals.length !== signals.length) {
        signals.length = 0;
        signals.push(...newSignals);
        // Re-render by unmounting and remounting
        // (Ink doesn't support hot signal updates easily without state management)
      }
    } catch { /* file might be mid-write */ }
  }, 1000);

  await waitUntilExit();
  clearInterval(interval);
} else {
  // Static render — no input needed
  const { unmount } = render(<Dashboard signals={signals} />, inkOpts);
  // Give Ink time to render, then exit
  await new Promise(r => setTimeout(r, 200));
  unmount();
}
