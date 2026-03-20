#!/usr/bin/env -S deno run --allow-run --allow-read --allow-write --allow-env

/**
 * Signal Bus CLI — Spawn agents, watch signals, manage worktrees
 *
 * Usage:
 *   deno run --allow-all src/cli.ts spawn "implement auth" --name auth-agent
 *   deno run --allow-all src/cli.ts spawn-all tasks.json
 *   deno run --allow-all src/cli.ts watch bus.jsonl
 */

import { SignalBus } from "./bus.ts";
import { AgentSpawner, type SpawnOptions, type AgentType, SANDBOX_PRESETS } from "./spawner.ts";
import { Registry } from "./registry.ts";
import { reviewLoop, race, ralph, costGuard, escalationRouter } from "./orchestrator.ts";
import { parseWorkflow, buildAgentPrompt, runWorkflow } from "./workflow.ts";
import { runMxit } from "./mxit-runner.ts";
import { withTimeout } from "./timeout.ts";
import { PermissionLedger } from "./permission-ledger.ts";
import type { AgentSignal, DenialDetail } from "./types.ts";

// --- Paths ---
const EXPO_DIR = ".expo";
const LOGS_DIR = `${EXPO_DIR}/logs`;

// Ensure logs directory exists
await Deno.mkdir(LOGS_DIR, { recursive: true }).catch(() => {});

// --- Colors ---
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";

// --- Pretty signal printer (headless UI consumer) ---
function printSignal(signal: AgentSignal): void {
  const agent = `${BOLD}${signal.agentId}${RESET}`;
  const ts = new Date(signal.timestamp).toISOString().slice(11, 19);
  const prefix = `${DIM}${ts}${RESET} ${agent}`;

  switch (signal.type) {
    case "spawned": {
      const model = (signal.payload as Record<string, unknown>).model ?? "";
      console.log(`${prefix} ${GREEN}● spawned${RESET} ${DIM}(${model})${RESET}`);
      break;
    }
    case "tool_call": {
      const p = signal.payload as Record<string, unknown>;
      const tool = p.tool as string;
      const isSubagent = p.isSubagent;
      const icon = isSubagent ? `${CYAN}◆ Agent` : `${BLUE}├ ${tool}`;
      const detail = isSubagent
        ? ` ${DIM}${p.subagentDescription}${RESET}`
        : formatToolInput(tool, p.input as Record<string, unknown>);
      console.log(`${prefix} ${icon}${RESET}${detail}`);
      break;
    }
    case "tool_result": {
      const p = signal.payload as Record<string, unknown>;
      const err = p.isError ? `${RED}✗${RESET}` : `${GREEN}✓${RESET}`;
      console.log(`${prefix} ${DIM}│${RESET} ${err}`);
      break;
    }
    case "output": {
      const text = ((signal.payload as Record<string, unknown>).text as string) ?? "";
      if (text.length > 120) {
        console.log(`${prefix} ${text.slice(0, 120)}${DIM}...${RESET}`);
      } else {
        console.log(`${prefix} ${text}`);
      }
      break;
    }
    case "progress": {
      const p = signal.payload as Record<string, unknown>;
      const msg = (p.message as string) ?? "";
      const preview = msg.length > 80 ? msg.slice(0, 80) + "..." : msg;
      console.log(`${prefix} ${DIM}💭 ${preview}${RESET}`);
      break;
    }
    case "done": {
      const p = signal.payload as Record<string, unknown>;
      const dur = ((p.durationMs as number) / 1000).toFixed(1);
      console.log(`${prefix} ${GREEN}✅ done${RESET} ${DIM}(${dur}s, ${p.numTurns} turns)${RESET}`);
      break;
    }
    case "failed": {
      const p = signal.payload as Record<string, unknown>;
      console.log(`${prefix} ${RED}✗ failed${RESET}: ${p.error}`);
      break;
    }
    case "cost": {
      const p = signal.payload as Record<string, unknown>;
      const cost = (p.totalCostUsd as number)?.toFixed(4) ?? "?";
      const input = (p.inputTokens as number) ?? 0;
      const output = (p.outputTokens as number) ?? 0;
      console.log(
        `${prefix} ${DIM}💰 $${cost} · ${input + output} tokens${RESET}`,
      );
      break;
    }
  }
}

function formatToolInput(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case "Read":
      return ` ${DIM}${input.file_path}${RESET}`;
    case "Edit":
      return ` ${DIM}${input.file_path}${RESET}`;
    case "Write":
      return ` ${DIM}${input.file_path}${RESET}`;
    case "Bash":
      return ` ${DIM}${String(input.command ?? "").slice(0, 60)}${RESET}`;
    case "Glob":
      return ` ${DIM}${input.pattern}${RESET}`;
    case "Grep":
      return ` ${DIM}${input.pattern}${RESET}`;
    default:
      return "";
  }
}

// --- Permission ledger helpers ---

async function loadLedger(): Promise<PermissionLedger> {
  const ledger = new PermissionLedger();
  await ledger.load();
  return ledger;
}

function printDenialReport(ledger: PermissionLedger): void {
  const pending = ledger.getPending();
  if (pending.length === 0) return;

  console.log("");
  console.log(`${YELLOW}⚠ Permission Denials (${pending.length} pending):${RESET}`);
  for (const entry of pending) {
    const countStr = entry.count > 1 ? `${entry.count}x` : "1x";
    console.log(`  ${RED}✗${RESET} ${entry.pattern.padEnd(30)} denied ${countStr}   → ${YELLOW}pending${RESET}`);
    // Show examples if available
    if (entry.examples?.length) {
      for (const ex of entry.examples.slice(-2)) {
        const parts: string[] = [];
        if (ex.command) parts.push(ex.command);
        if (ex.description) parts.push(`(${ex.description})`);
        if (parts.length > 0) {
          console.log(`    ${DIM}↳ ${parts.join(" ")}${RESET}`);
        }
      }
    }
  }
  console.log("");
  console.log(`  Run ${DIM}expo permissions${RESET} to review and approve for future runs.`);
}

async function saveLedgerAndReport(ledger: PermissionLedger): Promise<void> {
  await ledger.save();
  printDenialReport(ledger);
}

// --- Commands ---

async function cmdSpawn(args: string[]): Promise<void> {
  const prompt = args[0];
  if (!prompt) {
    console.error("Usage: cli.ts spawn <prompt> [--name <name>] [--model <model>] [--no-worktree] [--timeout <seconds>] [--sandbox <preset>]");
    Deno.exit(1);
  }

  // Parse flags
  let name = "agent-" + crypto.randomUUID().slice(0, 8);
  let model: string | undefined;
  let worktree = true;
  let agent: AgentType = "claude";
  let timeout = 0; // 0 = no timeout for single spawn
  let sandbox = "developer";
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--name" && args[i + 1]) {
      name = args[++i];
    } else if (args[i] === "--model" && args[i + 1]) {
      model = args[++i];
    } else if (args[i] === "--agent" && args[i + 1]) {
      agent = args[++i] as AgentType;
    } else if (args[i] === "--no-worktree") {
      worktree = false;
    } else if (args[i] === "--timeout" && args[i + 1]) {
      timeout = parseInt(args[++i]);
    } else if (args[i] === "--sandbox" && args[i + 1]) {
      sandbox = args[++i];
    }
  }

  const ledger = await loadLedger();

  const logFile = `${LOGS_DIR}/bus-${Date.now()}.jsonl`;
  const bus = new SignalBus({ logFile });
  await bus.init();
  bus.subscribe(printSignal);

  const registry = new Registry();
  const spawner = new AgentSpawner(bus, { registry });
  await spawner.init();

  // Merge ledger approvals into sandbox
  const baseSandbox = SANDBOX_PRESETS[sandbox];
  if (!baseSandbox) {
    console.error(`${RED}Unknown sandbox preset: ${sandbox}${RESET}`);
    console.error(`Available: ${Object.keys(SANDBOX_PRESETS).join(", ")}`);
    Deno.exit(1);
  }
  const mergedSandbox = ledger.buildSandbox(baseSandbox);

  console.log(`${BOLD}Signal Bus${RESET}`);
  console.log(`  Agent:   ${name} (${agent})`);
  console.log(`  Log:     ${logFile}`);
  console.log(`  Worktree: ${worktree ? "yes" : "no"}`);
  console.log("");

  // Track permission denials from bus signals
  const permissionDenials: string[] = [];
  const denialDetails: DenialDetail[] = [];
  bus.subscribe((signal) => {
    if (signal.agentId !== name) return;
    if (signal.type === "done" || signal.type === "failed") {
      const p = signal.payload as Record<string, unknown>;
      const denials = p.permissionDenials as string[] | undefined;
      if (denials) permissionDenials.push(...denials);
      const details = p.denialDetails as DenialDetail[] | undefined;
      if (details) denialDetails.push(...details);
    }
  });

  const spawnedAgent = await spawner.spawn({
    prompt,
    name,
    agent,
    label: name,
    model,
    worktree,
    sandbox: mergedSandbox,
  });

  const timeoutMs = timeout > 0 ? timeout * 1000 : undefined;
  const result = await withTimeout(spawnedAgent.process, spawnedAgent.done, { timeoutMs });
  console.log("");
  if (result.timedOut) {
    console.log(`${BOLD}Exit${RESET}: ${RED}timed out after ${timeout}s${RESET} (code ${result.exitCode})`);
  } else {
    console.log(`${BOLD}Exit${RESET}: ${result.exitCode === 0 ? GREEN + "success" : RED + "failed"} (code ${result.exitCode})${RESET}`);
  }
  console.log(`${DIM}Session: ${spawnedAgent.sessionId}${RESET}`);
  if (agent === "claude") {
    console.log(`${DIM}Resume:  claude --resume ${spawnedAgent.sessionId}${RESET}`);
  } else {
    console.log(`${DIM}Resume:  codex resume --last${RESET}`);
  }

  // Record denials and report
  if (permissionDenials.length > 0) {
    ledger.recordDenials(permissionDenials, name, denialDetails);
  }
  await saveLedgerAndReport(ledger);

  await bus.close();
}

async function cmdSpawnAll(args: string[]): Promise<void> {
  const tasksFile = args[0];
  if (!tasksFile) {
    console.error("Usage: cli.ts spawn-all <tasks.json>");
    console.error("");
    console.error("tasks.json format:");
    console.error('  [{"prompt": "...", "name": "agent-1"}, ...]');
    Deno.exit(1);
  }

  const tasks: SpawnOptions[] = JSON.parse(await Deno.readTextFile(tasksFile));

  // Parse optional --timeout flag from remaining args
  let timeout = 0;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--timeout" && args[i + 1]) timeout = parseInt(args[++i]);
  }

  const logFile = `${LOGS_DIR}/bus-${Date.now()}.jsonl`;
  const bus = new SignalBus({ logFile });
  await bus.init();
  bus.subscribe(printSignal);

  const registry = new Registry();
  const spawner = new AgentSpawner(bus, { registry });
  await spawner.init();

  console.log(`${BOLD}Signal Bus — ${tasks.length} agents${RESET}`);
  console.log(`  Log: ${logFile}`);
  console.log("");

  const agents = await spawner.spawnAll(tasks);

  // Wait for all to finish (with timeout protection)
  const timeoutMs = timeout > 0 ? timeout * 1000 : undefined;
  const results = await Promise.allSettled(
    agents.map((a) => withTimeout(a.process, a.done, { timeoutMs })),
  );

  console.log("");
  console.log(`${BOLD}=== Results ===${RESET}`);
  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i];
    const result = results[i];
    const status = result.status === "fulfilled"
      ? result.value.exitCode === 0
        ? `${GREEN}success${RESET}`
        : `${RED}failed (${result.value.exitCode})${RESET}`
      : `${RED}error: ${(result as PromiseRejectedResult).reason}${RESET}`;

    console.log(`  ${agent.agentId}: ${status}`);
    console.log(`    ${DIM}Resume: claude --resume ${agent.sessionId}${RESET}`);
  }

  await bus.close();
}

async function cmdStatus(): Promise<void> {
  const registry = new Registry();
  await registry.load();

  const entries = registry.getAll();
  if (entries.length === 0) {
    console.log(`${DIM}No agents in registry.${RESET}`);
    return;
  }

  console.log(`${BOLD}Agent Registry${RESET}`);
  console.log("");

  for (const entry of entries) {
    const statusColor =
      entry.status === "running" ? YELLOW :
      entry.status === "done" ? GREEN : RED;
    const dur = entry.finishedAt
      ? `${((entry.finishedAt - entry.startedAt) / 1000).toFixed(1)}s`
      : `${((Date.now() - entry.startedAt) / 1000).toFixed(0)}s...`;

    console.log(`  ${statusColor}●${RESET} ${BOLD}${entry.agentId}${RESET} ${DIM}(${entry.status}, ${dur})${RESET}`);
    console.log(`    ${DIM}Session: ${entry.sessionId}${RESET}`);
    if (entry.worktreePath) {
      console.log(`    ${DIM}Worktree: ${entry.worktreePath}${RESET}`);
    }
    if (entry.prompt) {
      console.log(`    ${DIM}Prompt: ${entry.prompt.slice(0, 80)}${entry.prompt.length > 80 ? "..." : ""}${RESET}`);
    }
    console.log(`    ${DIM}Resume: claude --resume ${entry.sessionId}${RESET}`);
    console.log("");
  }
}

async function cmdResume(args: string[]): Promise<void> {
  const agentId = args[0];
  const headless = args.includes("--headless");

  if (!agentId) {
    console.error("Usage: cli.ts resume <agentId> [--headless]");
    Deno.exit(1);
  }

  const registry = new Registry();
  await registry.load();

  const entry = registry.get(agentId);
  if (!entry) {
    console.error(`Agent not found: ${agentId}`);
    console.error(`Run 'status' to see available agents.`);
    Deno.exit(1);
  }

  console.log(`${BOLD}Resuming${RESET}: ${entry.agentId}`);
  console.log(`  ${DIM}Session: ${entry.sessionId}${RESET}`);

  if (headless) {
    // Resume headless — pipe back through bus
    const prompt = args.find((a, i) => i > 0 && a !== "--headless" && !a.startsWith("--"));

    const resumeArgs = [
      "-p", "--output-format", "stream-json", "--verbose",
      "--resume", entry.sessionId,
    ];
    if (prompt) resumeArgs.push(prompt);

    const logFile = `${LOGS_DIR}/bus-resume-${Date.now()}.jsonl`;
    const bus = new SignalBus({ logFile });
    await bus.init();
    bus.subscribe(printSignal);

    console.log(`  ${DIM}Mode: headless (signals → ${logFile})${RESET}`);
    console.log("");

    const command = new Deno.Command("claude", {
      args: resumeArgs,
      cwd: entry.cwd,
      stdout: "piped",
      stderr: "piped",
    });

    const process = command.spawn();
    const { lineStream: ls } = await import("./bus.ts");
    const lines = ls(process.stdout);
    const adapterOpts = { agentId: entry.agentId };
    const { parseStreamJsonLine } = await import("./claude-adapter.ts");

    await bus.pipeLines(lines, (line) => parseStreamJsonLine(line, adapterOpts));
    const status = await process.status;
    await bus.close();

    console.log("");
    console.log(`${BOLD}Exit${RESET}: ${status.code === 0 ? GREEN + "success" : RED + "failed"}${RESET}`);
  } else {
    // Resume interactive — hand control to claude directly
    console.log(`  ${DIM}Mode: interactive${RESET}`);
    console.log("");

    const resumeArgs = ["--resume", entry.sessionId];
    const command = new Deno.Command("claude", {
      args: resumeArgs,
      cwd: entry.cwd,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });

    const process = command.spawn();
    const status = await process.status;
    Deno.exit(status.code);
  }
}

async function cmdFork(args: string[]): Promise<void> {
  const agentId = args[0];
  if (!agentId) {
    console.error("Usage: cli.ts fork <agentId>");
    Deno.exit(1);
  }

  const registry = new Registry();
  await registry.load();

  const entry = registry.get(agentId);
  if (!entry) {
    console.error(`Agent not found: ${agentId}`);
    Deno.exit(1);
  }

  console.log(`${BOLD}Forking${RESET}: ${entry.agentId} → interactive session`);
  console.log(`  ${DIM}Parent session: ${entry.sessionId}${RESET}`);
  console.log("");

  const command = new Deno.Command("claude", {
    args: ["--resume", entry.sessionId, "--fork-session"],
    cwd: entry.cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  const process = command.spawn();
  const status = await process.status;
  Deno.exit(status.code);
}

async function cmdCleanup(args: string[]): Promise<void> {
  const registry = new Registry();
  await registry.load();

  const bus = new SignalBus();
  const spawner = new AgentSpawner(bus, { registry });
  await spawner.init();

  if (args[0] === "--all") {
    const cleaned = await spawner.cleanupAll();
    if (cleaned.length === 0) {
      console.log(`${DIM}No finished agents to clean up.${RESET}`);
    } else {
      console.log(`${GREEN}Cleaned up ${cleaned.length} agents:${RESET}`);
      for (const id of cleaned) {
        console.log(`  ${DIM}${id}${RESET}`);
      }
    }
  } else if (args[0]) {
    await spawner.cleanup(args[0]);
    console.log(`${GREEN}Cleaned up: ${args[0]}${RESET}`);
  } else {
    console.error("Usage: cli.ts cleanup <agentId> | --all");
  }
}

async function cmdReview(args: string[]): Promise<void> {
  const prompt = args[0];
  if (!prompt) {
    console.error("Usage: cli.ts review <prompt> [--max <N>] [--timeout <seconds>] [--work-agent claude|codex] [--review-agent claude|codex]");
    Deno.exit(1);
  }

  let maxIterations = 3;
  let name = "review";
  let model: string | undefined;
  let timeout: number | undefined;
  let workAgent: AgentType | undefined;
  let workModel: string | undefined;
  let reviewAgent: AgentType | undefined;
  let reviewModel: string | undefined;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--max" && args[i + 1]) maxIterations = parseInt(args[++i]);
    else if (args[i] === "--name" && args[i + 1]) name = args[++i];
    else if (args[i] === "--model" && args[i + 1]) model = args[++i];
    else if (args[i] === "--timeout" && args[i + 1]) timeout = parseInt(args[++i]);
    else if (args[i] === "--work-agent" && args[i + 1]) workAgent = args[++i] as AgentType;
    else if (args[i] === "--work-model" && args[i + 1]) workModel = args[++i];
    else if (args[i] === "--review-agent" && args[i + 1]) reviewAgent = args[++i] as AgentType;
    else if (args[i] === "--review-model" && args[i + 1]) reviewModel = args[++i];
  }

  const logFile = `${LOGS_DIR}/bus-review-${Date.now()}.jsonl`;
  const bus = new SignalBus({ logFile });
  await bus.init();
  bus.subscribe(printSignal);

  const registry = new Registry();
  const spawner = new AgentSpawner(bus, { registry });
  await spawner.init();

  const unguard = costGuard(bus, { perAgentBudget: 1.0, totalBudget: 5.0 });

  const wAgent = workAgent ?? "claude";
  const rAgent = reviewAgent ?? "claude";

  console.log(`${BOLD}Review Loop${RESET}${wAgent !== rAgent ? ` ${CYAN}(cross-model: ${wAgent} → ${rAgent})${RESET}` : ""}`);
  console.log(`  Prompt: ${prompt.slice(0, 80)}${prompt.length > 80 ? "..." : ""}`);
  console.log(`  Work:   ${wAgent}${workModel ? `:${workModel}` : ""}`);
  console.log(`  Review: ${rAgent}${reviewModel ? `:${reviewModel}` : ""}`);
  console.log(`  Max iterations: ${maxIterations}`);
  console.log(`  Log: ${logFile}`);
  console.log("");

  const result = await reviewLoop(bus, spawner, {
    workPrompt: prompt,
    maxIterations,
    name,
    model,
    timeout,
    workAgent: workAgent,
    workModel: workModel,
    reviewAgent: reviewAgent,
    reviewModel: reviewModel,
  });

  unguard();
  await bus.close();

  console.log("");
  console.log(`${BOLD}=== Review Result ===${RESET}`);
  console.log(`  Verdict: ${result.verdict === "DONE" ? GREEN : YELLOW}${result.verdict}${RESET}`);
  console.log(`  Iterations: ${result.iterations}`);
  console.log(`  Cost: $${result.totalCostUsd.toFixed(4)}`);
  console.log(`  ${DIM}Output: ${result.lastOutput.slice(0, 200)}${result.lastOutput.length > 200 ? "..." : ""}${RESET}`);
}

async function cmdRace(args: string[]): Promise<void> {
  // Parse: race "prompt1" vs "prompt2" [--criteria "..."] [--name prefix] [--timeout <seconds>]
  const prompts: string[] = [];
  let criteria: string | undefined;
  let name = "race";
  let model: string | undefined;
  let timeout: number | undefined;

  let i = 0;
  while (i < args.length) {
    if (args[i] === "vs") { i++; continue; }
    if (args[i] === "--criteria" && args[i + 1]) { criteria = args[++i]; i++; continue; }
    if (args[i] === "--name" && args[i + 1]) { name = args[++i]; i++; continue; }
    if (args[i] === "--model" && args[i + 1]) { model = args[++i]; i++; continue; }
    if (args[i] === "--timeout" && args[i + 1]) { timeout = parseInt(args[++i]); i++; continue; }
    prompts.push(args[i]);
    i++;
  }

  if (prompts.length < 2) {
    console.error('Usage: cli.ts race "approach A" vs "approach B" [--criteria "..."]');
    Deno.exit(1);
  }

  const logFile = `${LOGS_DIR}/bus-race-${Date.now()}.jsonl`;
  const bus = new SignalBus({ logFile });
  await bus.init();
  bus.subscribe(printSignal);

  const registry = new Registry();
  const spawner = new AgentSpawner(bus, { registry });
  await spawner.init();

  console.log(`${BOLD}Race — ${prompts.length} branches${RESET}`);
  for (let j = 0; j < prompts.length; j++) {
    console.log(`  ${j + 1}. ${prompts[j].slice(0, 60)}`);
  }
  if (criteria) console.log(`  Criteria: ${criteria}`);
  console.log(`  Log: ${logFile}`);
  console.log("");

  const result = await race(bus, spawner, { prompts, criteria, name, model, timeout });
  await bus.close();

  console.log("");
  console.log(`${BOLD}=== Race Result ===${RESET}`);
  if (result.winner >= 0) {
    console.log(`  Winner: ${GREEN}Branch ${result.winner + 1}${RESET}`);
  } else {
    console.log(`  ${RED}No winner${RESET}`);
  }
  console.log(`  Cost: $${result.totalCostUsd.toFixed(4)}`);
  console.log(`  ${DIM}Reasoning: ${result.judgeReasoning.slice(0, 200)}${RESET}`);
}

async function cmdRalph(args: string[]): Promise<void> {
  const workPrompt = args[0];
  const gatePrompt = args[1];

  if (!workPrompt || !gatePrompt) {
    console.error('Usage: cli.ts ralph "<work prompt>" "<gate prompt>" [--max <N>] [--review]');
    Deno.exit(1);
  }

  let maxTasks = 5;
  let review = false;
  let name = "ralph";
  let model: string | undefined;
  let timeout: number | undefined;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--max" && args[i + 1]) maxTasks = parseInt(args[++i]);
    else if (args[i] === "--review") review = true;
    else if (args[i] === "--name" && args[i + 1]) name = args[++i];
    else if (args[i] === "--model" && args[i + 1]) model = args[++i];
    else if (args[i] === "--timeout" && args[i + 1]) timeout = parseInt(args[++i]);
  }

  const logFile = `${LOGS_DIR}/bus-ralph-${Date.now()}.jsonl`;
  const bus = new SignalBus({ logFile });
  await bus.init();
  bus.subscribe(printSignal);

  const registry = new Registry();
  const spawner = new AgentSpawner(bus, { registry });
  await spawner.init();

  const unguard = costGuard(bus, { totalBudget: 10.0 });
  const unescalate = escalationRouter(bus, {
    failThreshold: 2,
    onEscalate: (_signal, ctx) => {
      console.log(`\n${RED}⚠ ESCALATED${RESET}: ${ctx.agentId} failed ${ctx.failCount} times: ${ctx.reason}`);
    },
  });

  console.log(`${BOLD}Ralph — Task Progression${RESET}`);
  console.log(`  Work:  ${workPrompt.slice(0, 60)}${workPrompt.length > 60 ? "..." : ""}`);
  console.log(`  Gate:  ${gatePrompt.slice(0, 60)}${gatePrompt.length > 60 ? "..." : ""}`);
  console.log(`  Max:   ${maxTasks} tasks`);
  console.log(`  Review: ${review ? "yes" : "no"}`);
  console.log(`  Log:   ${logFile}`);
  console.log("");

  const result = await ralph(bus, spawner, {
    workPrompt,
    gatePrompt,
    maxTasks,
    review,
    name,
    model,
    timeout,
  });

  unguard();
  unescalate();
  await bus.close();

  console.log("");
  console.log(`${BOLD}=== Ralph Result ===${RESET}`);
  console.log(`  Verdict: ${result.verdict === "DONE" ? GREEN : YELLOW}${result.verdict}${RESET}`);
  console.log(`  Tasks completed: ${result.tasksCompleted}`);
  console.log(`  Cost: $${result.totalCostUsd.toFixed(4)}`);
}

async function cmdWorkflow(args: string[]): Promise<void> {
  const workflowFile = args[0];
  if (!workflowFile) {
    console.error("Usage: cli.ts workflow <file.md> [--model <model>] [--budget <N>] [--timeout <seconds>] [--dry-run] [--sandbox <preset>]");
    Deno.exit(1);
  }

  // Parse flags
  let model: string | undefined;
  let budget = 10;
  let dryRun = false;
  let sandboxOverride: string | undefined;
  let timeout: number | undefined;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--model" && args[i + 1]) model = args[++i];
    else if (args[i] === "--budget" && args[i + 1]) budget = parseFloat(args[++i]);
    else if (args[i] === "--dry-run") dryRun = true;
    else if (args[i] === "--sandbox" && args[i + 1]) sandboxOverride = args[++i];
    else if (args[i] === "--timeout" && args[i + 1]) timeout = parseInt(args[++i]);
  }

  // Parse the workflow for display
  let markdown: string;
  try {
    markdown = await Deno.readTextFile(workflowFile);
  } catch {
    console.error(`${RED}Error${RESET}: Cannot read workflow file: ${workflowFile}`);
    Deno.exit(1);
  }

  let spec;
  try {
    spec = parseWorkflow(markdown);
  } catch (err) {
    console.error(`${RED}Error${RESET}: ${(err as Error).message}`);
    Deno.exit(1);
  }

  console.log(`${BOLD}Workflow${RESET}: ${workflowFile}`);
  if (spec.goal) console.log(`  Goal: ${spec.goal.slice(0, 80)}${spec.goal.length > 80 ? "..." : ""}`);
  console.log(`  Agents: ${spec.agents.map((a) => a.name).join(", ")}`);
  console.log(`  Sandbox: ${typeof spec.sandbox === "string" ? spec.sandbox : "custom"}${sandboxOverride ? ` → ${sandboxOverride}` : ""}`);
  console.log(`  Budget: $${budget}`);
  if (spec.output) console.log(`  Output: ${spec.output}`);
  console.log("");

  if (dryRun) {
    console.log(`${BOLD}=== Dry Run ===${RESET}`);
    console.log("");
    for (const agent of spec.agents) {
      console.log(`${CYAN}### ${agent.name}${RESET}`);
      const prompt = buildAgentPrompt(spec, agent);
      console.log(`${DIM}${prompt.slice(0, 300)}${prompt.length > 300 ? "..." : ""}${RESET}`);
      console.log("");
    }
    console.log(`${GREEN}Validation passed.${RESET} Remove --dry-run to execute.`);
    return;
  }

  const ledger = await loadLedger();

  const result = await runWorkflow({
    workflowPath: workflowFile,
    model,
    budget,
    sandboxOverride,
    timeout,
    ledger,
  });

  // Aggregate all denials from agent results into ledger
  for (const agent of result.agents) {
    if (agent.permissionDenials.length > 0) {
      ledger.recordDenials(agent.permissionDenials, agent.name);
    }
  }

  console.log("");
  console.log(`${BOLD}=== Workflow Results ===${RESET}`);
  for (const agent of result.agents) {
    const status = agent.status === "success"
      ? `${GREEN}success${RESET}`
      : `${RED}failed (${agent.exitCode})${RESET}`;
    console.log(`  ${agent.name}: ${status}`);
    if (agent.permissionDenials.length > 0) {
      console.log(`    ${YELLOW}⚠ Permission denials: ${agent.permissionDenials.join(", ")}${RESET}`);
    }
  }

  if (result.synthesis) {
    console.log("");
    console.log(`  ${GREEN}Synthesis${RESET}: completed ($${result.synthesis.cost.toFixed(4)})`);
  } else if (result.agents.every((a) => a.status === "failed")) {
    console.log("");
    console.log(`  ${RED}Synthesis skipped${RESET}: all agents failed`);
  }

  console.log("");
  console.log(`  Total cost: $${result.totalCostUsd.toFixed(4)}`);

  await saveLedgerAndReport(ledger);
}

async function cmdMxit(args: string[]): Promise<void> {
  const tasksFile = args[0];
  if (!tasksFile) {
    console.error("Usage: cli.ts mxit <TASKS.md> [--agent <type>] [--model <model>] [--timeout <seconds>] [--max <N>] [--parallel] [--budget <N>]");
    Deno.exit(1);
  }

  let agent: AgentType = "claude";
  let model: string | undefined;
  let timeout = 600;
  let maxTasks = 10;
  let parallel = false;
  let budget = 10;
  let sandbox = "developer";

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--agent" && args[i + 1]) agent = args[++i] as AgentType;
    else if (args[i] === "--model" && args[i + 1]) model = args[++i];
    else if (args[i] === "--timeout" && args[i + 1]) timeout = parseInt(args[++i]);
    else if (args[i] === "--max" && args[i + 1]) maxTasks = parseInt(args[++i]);
    else if (args[i] === "--parallel") parallel = true;
    else if (args[i] === "--budget" && args[i + 1]) budget = parseFloat(args[++i]);
    else if (args[i] === "--sandbox" && args[i + 1]) sandbox = args[++i];
  }

  const ledger = await loadLedger();

  console.log(`${BOLD}mxit Runner${RESET}`);
  console.log(`  Tasks: ${tasksFile}`);
  console.log(`  Agent: ${agent}${model ? `:${model}` : ""}`);
  console.log(`  Mode:  ${parallel ? "parallel" : "sequential"}`);
  console.log(`  Max:   ${maxTasks} tasks`);
  console.log(`  Timeout: ${timeout}s per task`);
  console.log(`  Budget: $${budget}`);
  console.log("");

  const result = await runMxit({
    tasksFile,
    agent,
    model,
    timeout,
    maxTasks,
    parallel,
    budget,
    sandbox,
    onSignal: printSignal,
    ledger,
  });

  console.log("");
  console.log(`${BOLD}=== mxit Results ===${RESET}`);
  console.log(`  Completed: ${GREEN}${result.tasksCompleted}${RESET}`);
  console.log(`  Failed:    ${result.tasksFailed > 0 ? RED : DIM}${result.tasksFailed}${RESET}`);
  console.log(`  Cost:      $${result.totalCostUsd.toFixed(4)}`);

  for (const r of result.results) {
    const status = r.status === "completed"
      ? `${GREEN}done${RESET}`
      : r.status === "timed_out"
        ? `${YELLOW}timed out${RESET}`
        : `${RED}failed (${r.exitCode})${RESET}`;
    console.log(`  ${DIM}L${r.task.line}${RESET} ${r.task.description.slice(0, 50)}: ${status}`);
  }

  await saveLedgerAndReport(ledger);
}

async function cmdPermissions(args: string[]): Promise<void> {
  const ledger = await loadLedger();
  const subcommand = args[0];

  if (subcommand === "approve" && args[1]) {
    ledger.approve(args[1]);
    await ledger.save();
    console.log(`${GREEN}Approved${RESET}: ${args[1]}`);
    return;
  }

  if (subcommand === "reject" && args[1]) {
    ledger.reject(args[1]);
    await ledger.save();
    console.log(`${RED}Rejected${RESET}: ${args[1]}`);
    return;
  }

  if (subcommand === "reset") {
    ledger.reset();
    await ledger.save();
    console.log(`${GREEN}Ledger cleared.${RESET}`);
    return;
  }

  // Default: list all entries
  const entries = ledger.getAll();
  if (entries.length === 0) {
    console.log(`${DIM}No permission entries. Denials are recorded after agent runs.${RESET}`);
    return;
  }

  console.log(`${BOLD}Permission Ledger${RESET}`);
  console.log("");

  for (const entry of entries) {
    const statusColor =
      entry.status === "approved" ? GREEN :
      entry.status === "rejected" ? RED : YELLOW;
    const countStr = entry.count > 0 ? `${entry.count}x` : "";
    const sourceStr = entry.source ? ` ${DIM}(from: ${entry.source})${RESET}` : "";
    console.log(`  ${statusColor}●${RESET} ${entry.pattern.padEnd(30)} ${statusColor}${entry.status}${RESET}  ${DIM}${countStr}${RESET}${sourceStr}`);
    // Show examples
    if (entry.examples?.length) {
      for (const ex of entry.examples) {
        const parts: string[] = [];
        if (ex.command) parts.push(ex.command);
        if (ex.description) parts.push(`(${ex.description})`);
        if (parts.length > 0) {
          console.log(`    ${DIM}↳ ${parts.join(" ")}${RESET}`);
        }
      }
    }
  }

  const pending = entries.filter((e) => e.status === "pending");
  if (pending.length > 0) {
    console.log("");
    console.log(`${DIM}Approve:  expo permissions approve "<pattern>"${RESET}`);
    console.log(`${DIM}Reject:   expo permissions reject "<pattern>"${RESET}`);
    console.log(`${DIM}Reset:    expo permissions reset${RESET}`);
  }
}

// --- Main ---

const [command, ...args] = Deno.args;

switch (command) {
  case "spawn":
    await cmdSpawn(args);
    break;

  case "spawn-all":
    await cmdSpawnAll(args);
    break;

  case "status":
    await cmdStatus();
    break;

  case "resume":
    await cmdResume(args);
    break;

  case "fork":
    await cmdFork(args);
    break;

  case "cleanup":
    await cmdCleanup(args);
    break;

  case "review":
    await cmdReview(args);
    break;

  case "race":
    await cmdRace(args);
    break;

  case "ralph":
    await cmdRalph(args);
    break;

  case "workflow":
    await cmdWorkflow(args);
    break;

  case "mxit":
    await cmdMxit(args);
    break;

  case "permissions":
    await cmdPermissions(args);
    break;

  case "watch": {
    // Delegate to watch.ts
    const watchCmd = new Deno.Command("deno", {
      args: ["run", "--allow-read", new URL("./watch.ts", import.meta.url).pathname, ...args],
      stdin: "inherit", stdout: "inherit", stderr: "inherit",
    });
    const watchProc = watchCmd.spawn();
    const watchStatus = await watchProc.status;
    Deno.exit(watchStatus.code);
    break;
  }

  case "help":
  case "--help":
  case "-h":
  default:
    console.log(`${BOLD}sigbus${RESET} — Subagent signal bus

${BOLD}Commands:${RESET}
  spawn <prompt> [flags]    Spawn a single agent
  spawn-all <tasks.json>    Spawn multiple agents in parallel
  status                    Show all agents in registry
  resume <agentId>          Resume an agent interactively
  resume <agentId> --headless  Resume headless (signals → bus)
  fork <agentId>            Fork from an agent's session (new session)
  cleanup <agentId>         Remove agent's worktree + registry entry
  cleanup --all             Clean up all finished agents
  review <prompt>           Review loop: work → review → gate (DONE/ITERATE)
  race "A" vs "B" [flags]  Race branches in parallel, pick winner
  workflow <file.md>        Run a markdown workflow (agents + synthesis)
  mxit <TASKS.md>           Run ready tasks from a mxit task file
  permissions               List permission ledger entries
  permissions approve <p>   Approve a permission pattern for future runs
  permissions reject <p>    Reject a permission pattern
  permissions reset         Clear all permission entries

${BOLD}Spawn flags:${RESET}
  --name <name>             Agent name (also worktree name)
  --model <model>           Model override
  --no-worktree             Run in current directory (no isolation)
  --timeout <seconds>       Kill agent after N seconds (0 = no timeout)
  --sandbox <preset>        Sandbox preset (permissive|research|developer, default: developer)

${BOLD}Examples:${RESET}
  sigbus spawn "implement auth" --name auth-agent
  sigbus spawn-all tasks.json
  sigbus status
  sigbus resume auth-agent
  sigbus fork auth-agent
  sigbus cleanup --all
`);
    break;
}
