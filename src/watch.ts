#!/usr/bin/env -S deno run --allow-read

/**
 * Bus Watcher — Tail a JSONL bus file and display signals in real-time
 *
 * Usage:
 *   deno run --allow-read src/watch.ts bus-1234.jsonl
 *   deno run --allow-read src/watch.ts bus-1234.jsonl --json
 *   deno run --allow-read src/watch.ts bus-1234.jsonl --summary
 */

import type { AgentSignal } from "./types.ts";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";

function printSignal(signal: AgentSignal): void {
  const agent = `${BOLD}${signal.agentId}${RESET}`;
  const ts = new Date(signal.timestamp).toISOString().slice(11, 19);
  const prefix = `${DIM}${ts}${RESET} ${agent}`;

  switch (signal.type) {
    case "spawned":
      console.log(`${prefix} ${GREEN}● spawned${RESET} ${DIM}(${(signal.payload as any).model ?? ""})${RESET}`);
      break;
    case "tool_call": {
      const p = signal.payload as any;
      const icon = p.isSubagent ? `${CYAN}◆ Agent` : `${BLUE}├ ${p.tool}`;
      console.log(`${prefix} ${icon}${RESET} ${DIM}${p.isSubagent ? p.subagentDescription : formatInput(p.tool, p.input)}${RESET}`);
      break;
    }
    case "tool_result":
      console.log(`${prefix} ${DIM}│${RESET} ${(signal.payload as any).isError ? `${RED}✗${RESET}` : `${GREEN}✓${RESET}`}`);
      break;
    case "output": {
      const text = (signal.payload as any).text ?? "";
      console.log(`${prefix} ${text.length > 120 ? text.slice(0, 120) + "..." : text}`);
      break;
    }
    case "progress":
      console.log(`${prefix} ${DIM}💭 ${((signal.payload as any).message ?? "").slice(0, 80)}${RESET}`);
      break;
    case "done": {
      const p = signal.payload as any;
      console.log(`${prefix} ${GREEN}✅ done${RESET} ${DIM}(${(p.durationMs / 1000).toFixed(1)}s, ${p.numTurns} turns)${RESET}`);
      break;
    }
    case "failed":
      console.log(`${prefix} ${RED}✗ failed${RESET}: ${(signal.payload as any).error}`);
      break;
    case "cost": {
      const p = signal.payload as any;
      console.log(`${prefix} ${DIM}💰 $${p.totalCostUsd?.toFixed(4)} · ${(p.inputTokens ?? 0) + (p.outputTokens ?? 0)} tokens${RESET}`);
      break;
    }
  }
}

function formatInput(tool: string, input: any): string {
  if (!input) return "";
  switch (tool) {
    case "Read": case "Edit": case "Write": return input.file_path ?? "";
    case "Bash": return String(input.command ?? "").slice(0, 60);
    case "Glob": return input.pattern ?? "";
    case "Grep": return input.pattern ?? "";
    default: return "";
  }
}

function printSummary(signals: AgentSignal[]): void {
  const agents = new Map<string, { status: string; cost: number; duration: number; tools: number }>();

  for (const s of signals) {
    if (!agents.has(s.agentId)) {
      agents.set(s.agentId, { status: "unknown", cost: 0, duration: 0, tools: 0 });
    }
    const a = agents.get(s.agentId)!;
    if (s.type === "spawned") a.status = "running";
    if (s.type === "done") { a.status = "done"; a.duration = (s.payload as any).durationMs ?? 0; }
    if (s.type === "failed") a.status = "failed";
    if (s.type === "cost") a.cost = (s.payload as any).totalCostUsd ?? 0;
    if (s.type === "tool_call") a.tools++;
  }

  console.log(`\n${BOLD}=== Summary ===${RESET}`);
  let totalCost = 0;
  for (const [id, a] of agents) {
    const statusIcon = a.status === "done" ? `${GREEN}✅${RESET}` : a.status === "failed" ? `${RED}✗${RESET}` : `${YELLOW}●${RESET}`;
    console.log(`  ${statusIcon} ${BOLD}${id}${RESET} — ${a.tools} tools, ${(a.duration / 1000).toFixed(1)}s, $${a.cost.toFixed(4)}`);
    totalCost += a.cost;
  }
  console.log(`\n  ${BOLD}Total:${RESET} ${agents.size} agents, $${totalCost.toFixed(4)}`);
}

// --- Main ---

const file = Deno.args[0];
const mode = Deno.args[1];

if (!file) {
  console.log(`${BOLD}sigbus watch${RESET} — Tail a signal bus JSONL file

Usage:
  watch <file.jsonl>              Pretty-print signals
  watch <file.jsonl> --json       Raw JSON output
  watch <file.jsonl> --summary    Show summary after reading
`);
  Deno.exit(0);
}

const content = await Deno.readTextFile(file);
const lines = content.trim().split("\n").filter(Boolean);
const signals: AgentSignal[] = [];

for (const line of lines) {
  try {
    const signal = JSON.parse(line) as AgentSignal;
    signals.push(signal);

    if (mode === "--json") {
      console.log(line);
    } else {
      printSignal(signal);
    }
  } catch {
    // skip invalid lines
  }
}

if (mode === "--summary") {
  printSummary(signals);
}
