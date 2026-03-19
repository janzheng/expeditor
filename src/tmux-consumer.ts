#!/usr/bin/env -S deno run --allow-all

/**
 * Tmux Consumer — agentgrid-style pane status updates from the signal bus
 *
 * Reads a JSONL bus file and updates tmux pane status labels.
 * Each agent gets a pane (matched by pane title = agentId).
 *
 * Usage:
 *   # Start agents in tmux panes first, then:
 *   deno run --allow-all src/tmux-consumer.ts <bus-file.jsonl>
 *
 *   # Or create panes automatically:
 *   deno run --allow-all src/tmux-consumer.ts <bus-file.jsonl> --create-panes
 */

import type { AgentSignal } from "./types.ts";

const RESET = "\x1b[0m";

interface PaneState {
  agentId: string;
  status: string;
  tool: string;
  costUsd: number;
  paneId?: string;
}

async function tmux(...args: string[]): Promise<string> {
  const cmd = new Deno.Command("tmux", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  return new TextDecoder().decode(out.stdout).trim();
}

async function setPaneTitle(paneId: string, title: string): Promise<void> {
  await tmux("select-pane", "-t", paneId, "-T", title);
}

async function setPaneStyle(paneId: string, status: string): Promise<void> {
  // Set border color based on status
  const colors: Record<string, string> = {
    spawned: "blue",
    working: "yellow",
    done: "green",
    failed: "red",
  };
  const color = colors[status] ?? "default";
  await tmux("select-pane", "-t", paneId, "-P", `border-style=${color}`).catch(() => {});
}

async function findPaneByTitle(title: string): Promise<string | undefined> {
  try {
    const panes = await tmux("list-panes", "-a", "-F", "#{pane_id}:#{pane_title}");
    for (const line of panes.split("\n")) {
      const [id, name] = line.split(":");
      if (name === title) return id;
    }
  } catch { /* not in tmux */ }
  return undefined;
}

async function createPane(agentId: string): Promise<string | undefined> {
  try {
    const result = await tmux("split-window", "-d", "-P", "-F", "#{pane_id}");
    await tmux("select-layout", "tiled");
    await setPaneTitle(result, agentId);
    return result;
  } catch {
    return undefined;
  }
}

function formatStatus(state: PaneState): string {
  const icons: Record<string, string> = {
    spawned: "○",
    working: "⚡",
    done: "✅",
    failed: "✗",
  };
  const icon = icons[state.status] ?? "?";
  const cost = state.costUsd > 0 ? ` $${state.costUsd.toFixed(3)}` : "";
  const tool = state.tool ? ` │ ${state.tool}` : "";
  return `${icon} ${state.agentId}${tool}${cost}`;
}

async function processSignals(file: string, createPanes: boolean): Promise<void> {
  const states = new Map<string, PaneState>();

  // Check if we're in tmux
  if (!Deno.env.get("TMUX")) {
    console.error("Not in a tmux session. Run this inside tmux.");
    console.error("Or use: tmux new-session -s expo 'deno run --allow-all src/tmux-consumer.ts ...'");
    Deno.exit(1);
  }

  console.log(`Watching: ${file}`);
  console.log(`Create panes: ${createPanes}`);
  console.log("Press Ctrl+C to stop.\n");

  // Poll file for new lines
  let lastLineCount = 0;

  const poll = async () => {
    try {
      const content = await Deno.readTextFile(file);
      const lines = content.trim().split("\n").filter(Boolean);

      if (lines.length <= lastLineCount) return;

      // Process new lines
      for (let i = lastLineCount; i < lines.length; i++) {
        let signal: AgentSignal;
        try {
          signal = JSON.parse(lines[i]);
        } catch {
          continue;
        }

        const id = signal.agentId;

        if (!states.has(id)) {
          states.set(id, { agentId: id, status: "spawned", tool: "", costUsd: 0 });

          // Find or create pane
          let paneId = await findPaneByTitle(id);
          if (!paneId && createPanes) {
            paneId = await createPane(id);
          }
          if (paneId) {
            states.get(id)!.paneId = paneId;
          }
        }

        const state = states.get(id)!;

        switch (signal.type) {
          case "spawned":
            state.status = "spawned";
            state.tool = "";
            break;
          case "tool_call": {
            const p = signal.payload as Record<string, unknown>;
            state.status = "working";
            state.tool = (p.isSubagent ? "Agent" : p.tool as string) ?? "";
            break;
          }
          case "tool_result":
            // Keep current tool, just update status stays working
            break;
          case "output":
            state.status = "working";
            break;
          case "done":
            state.status = "done";
            state.tool = "";
            break;
          case "failed":
            state.status = "failed";
            state.tool = (signal.payload as Record<string, unknown>).error as string ?? "";
            break;
          case "cost":
            state.costUsd = (signal.payload as Record<string, unknown>).totalCostUsd as number ?? 0;
            break;
        }

        // Update tmux pane
        if (state.paneId) {
          const title = formatStatus(state);
          await setPaneTitle(state.paneId, title);
          await setPaneStyle(state.paneId, state.status);
        }

        // Also print to console
        const statusColors: Record<string, string> = {
          spawned: "\x1b[34m",
          working: "\x1b[33m",
          done: "\x1b[32m",
          failed: "\x1b[31m",
        };
        const color = statusColors[state.status] ?? "";
        console.log(`${color}${formatStatus(state)}${RESET}`);
      }

      lastLineCount = lines.length;
    } catch {
      // File might not exist yet or be mid-write
    }
  };

  // Initial read
  await poll();

  // Poll every 500ms
  const interval = setInterval(poll, 500);

  // Wait for Ctrl+C
  const ac = new AbortController();
  Deno.addSignalListener("SIGINT", () => {
    clearInterval(interval);
    console.log("\nStopped.");
    ac.abort();
    Deno.exit(0);
  });

  // Keep alive
  await new Promise(() => {});
}

// --- Main ---

const file = Deno.args[0];
const createPanes = Deno.args.includes("--create-panes");

if (!file) {
  console.log(`expo tmux — agentgrid-style pane status from signal bus

Usage:
  deno run --allow-all src/tmux-consumer.ts <bus.jsonl>
  deno run --allow-all src/tmux-consumer.ts <bus.jsonl> --create-panes

Must be run inside a tmux session. Updates pane titles with agent status.
`);
  Deno.exit(0);
}

await processSignals(file, createPanes);
