/**
 * Workflow — Parse markdown workflow files and run multi-agent research pipelines
 *
 * A workflow file describes agents (lenses), synthesis instructions, sandbox rules,
 * and output format. This module parses the markdown, spawns agents in parallel,
 * collects results, and runs a synthesis step.
 *
 * Usage:
 *   deno task expo workflow workflows/research-gut-brain.md
 */

import { SignalBus } from "./bus.ts";
import { AgentSpawner, type SpawnOptions, type SandboxConfig, SANDBOX_PRESETS } from "./spawner.ts";
import { Registry } from "./registry.ts";
import { spawnAndWait, costGuard, type SpawnResult } from "./orchestrator.ts";
import { withTimeout } from "./timeout.ts";

// --- Types ---

export interface AgentSpec {
  name: string;
  instructions: string;
}

export interface WorkflowSpec {
  goal?: string;
  background?: string;
  agents: AgentSpec[];
  sandbox: SandboxConfig | string;
  synthesize: string;
  formatting?: string;
  output?: string;
}

export interface AgentResult {
  name: string;
  status: "success" | "failed";
  cost: number;
  permissionDenials: string[];
  output: string;
  exitCode: number;
}

export interface WorkflowResult {
  agents: AgentResult[];
  synthesis?: {
    output: string;
    cost: number;
  };
  totalCostUsd: number;
}

// --- Parser ---

export function parseWorkflow(markdown: string): WorkflowSpec {
  const sections = splitSections(markdown);

  // Extract agents from ## agents section
  const agentsSection = sections.get("agents");
  if (!agentsSection) {
    throw new Error("Workflow missing required section: ## agents");
  }

  const agents = parseAgents(agentsSection);
  if (agents.length === 0) {
    throw new Error("Workflow ## agents section has no agent definitions (use ### headings)");
  }

  // Synthesize is required
  const synthesize = sections.get("synthesize");
  if (!synthesize?.trim()) {
    throw new Error("Workflow missing required section: ## synthesize");
  }

  // Parse sandbox
  const sandboxRaw = sections.get("sandbox")?.trim();
  let sandbox: SandboxConfig | string;
  if (!sandboxRaw) {
    sandbox = "research"; // default
  } else if (SANDBOX_PRESETS[sandboxRaw]) {
    sandbox = sandboxRaw;
  } else {
    sandbox = parseSandboxConfig(sandboxRaw);
  }

  return {
    goal: sections.get("goal")?.trim(),
    background: sections.get("background")?.trim(),
    agents,
    sandbox,
    synthesize: synthesize.trim(),
    formatting: sections.get("formatting")?.trim(),
    output: sections.get("output")?.trim(),
  };
}

function splitSections(markdown: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = markdown.split("\n");
  let currentKey: string | null = null;
  let currentLines: string[] = [];

  // Skip lines before first ## heading (title line etc.)
  for (const line of lines) {
    const match = line.match(/^## (.+)/);
    if (match) {
      if (currentKey !== null) {
        sections.set(currentKey, currentLines.join("\n"));
      }
      currentKey = match[1].trim().toLowerCase();
      currentLines = [];
    } else if (currentKey !== null) {
      currentLines.push(line);
    }
  }

  if (currentKey !== null) {
    sections.set(currentKey, currentLines.join("\n"));
  }

  return sections;
}

function parseAgents(agentsBody: string): AgentSpec[] {
  const agents: AgentSpec[] = [];
  const lines = agentsBody.split("\n");
  let currentName: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    const match = line.match(/^### (.+)/);
    if (match) {
      if (currentName !== null) {
        agents.push({ name: currentName, instructions: currentLines.join("\n").trim() });
      }
      currentName = match[1].trim();
      currentLines = [];
    } else if (currentName !== null) {
      currentLines.push(line);
    }
  }

  if (currentName !== null) {
    agents.push({ name: currentName, instructions: currentLines.join("\n").trim() });
  }

  return agents;
}

function parseSandboxConfig(raw: string): SandboxConfig {
  const config: SandboxConfig = {};
  const lines = raw.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("allow:")) {
      config.allow = trimmed
        .slice(6)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (trimmed.startsWith("deny:")) {
      config.deny = trimmed
        .slice(5)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  return config;
}

// --- Prompt Builders ---

export function buildAgentPrompt(spec: WorkflowSpec, agent: AgentSpec): string {
  const parts: string[] = [];

  if (spec.goal) {
    parts.push(`# Research Goal\n${spec.goal}`);
  }
  if (spec.background) {
    parts.push(`# Background\n${spec.background}`);
  }

  parts.push(`# Your Task: ${agent.name}\n${agent.instructions}`);

  if (spec.formatting) {
    parts.push(`# Formatting Requirements\n${spec.formatting}`);
  }

  // Each agent writes to its own output file
  const outputDir = spec.output?.match(/`([^`]+)`/)?.[1]?.replace(/\/[^/]+$/, "") ?? ".expo/output";
  parts.push(`# Output\nWrite your findings to \`${outputDir}/${agent.name}.md\``);

  return parts.join("\n\n");
}

export function buildSynthesisPrompt(
  spec: WorkflowSpec,
  succeeded: AgentResult[],
  failed: AgentResult[],
): string {
  const parts: string[] = [];

  if (spec.goal) {
    parts.push(`# Research Goal\n${spec.goal}`);
  }

  parts.push(`# Synthesis Task\n${spec.synthesize}`);

  // Tell synthesis agent where to find the outputs
  const outputDir = spec.output?.match(/`([^`]+)`/)?.[1]?.replace(/\/[^/]+$/, "") ?? ".expo/output";
  const fileList = succeeded.map((a) => `- \`${outputDir}/${a.name}.md\``).join("\n");
  parts.push(`# Agent Outputs to Read\nThe following agent output files are available:\n${fileList}`);

  if (failed.length > 0) {
    const failList = failed.map((a) => `- ${a.name}`).join("\n");
    parts.push(`# Note: Failed Agents\nThe following agents failed and have no output:\n${failList}\nAccount for these gaps in your synthesis.`);
  }

  if (spec.formatting) {
    parts.push(`# Formatting Requirements\n${spec.formatting}`);
  }

  // Output path from the workflow
  const outputPath = spec.output?.match(/`([^`]+)`/)?.[1] ?? `${outputDir}/synthesis.md`;
  parts.push(`# Output\nWrite the synthesis to \`${outputPath}\``);

  return parts.join("\n\n");
}

// --- Runner ---

export interface WorkflowRunnerOptions {
  workflowPath: string;
  model?: string;
  budget?: number;
  sandboxOverride?: string;
  dryRun?: boolean;
  /** Timeout per agent in seconds (0 = no timeout, default: 600) */
  timeout?: number;
}

export async function runWorkflow(opts: WorkflowRunnerOptions): Promise<WorkflowResult> {
  const markdown = await Deno.readTextFile(opts.workflowPath);
  const spec = parseWorkflow(markdown);

  // Override sandbox if specified
  if (opts.sandboxOverride) {
    spec.sandbox = opts.sandboxOverride;
  }

  // Resolve sandbox to a config
  const sandboxConfig = typeof spec.sandbox === "string"
    ? SANDBOX_PRESETS[spec.sandbox]
    : spec.sandbox;
  if (!sandboxConfig && typeof spec.sandbox === "string") {
    throw new Error(`Unknown sandbox preset: ${spec.sandbox}`);
  }

  if (opts.dryRun) {
    return { agents: [], totalCostUsd: 0 };
  }

  // Set up infrastructure
  const logsDir = ".expo/logs";
  await Deno.mkdir(logsDir, { recursive: true }).catch(() => {});
  const logFile = `${logsDir}/bus-workflow-${Date.now()}.jsonl`;
  const bus = new SignalBus({ logFile });
  await bus.init();

  const registry = new Registry();
  const spawner = new AgentSpawner(bus, { registry });
  await spawner.init();

  const budget = opts.budget ?? 10;
  const unguard = costGuard(bus, { totalBudget: budget });

  // Spawn all agents in parallel
  const spawnOpts: SpawnOptions[] = spec.agents.map((agent) => ({
    prompt: buildAgentPrompt(spec, agent),
    name: agent.name,
    model: opts.model,
    worktree: false,
    sandbox: spec.sandbox as string | SandboxConfig,
  }));

  const spawnedAgents = await spawner.spawnAll(spawnOpts);

  // Wait for all to complete (with timeout protection)
  const timeoutMs = (opts.timeout ?? 600) * 1000;
  const settledResults = await Promise.allSettled(
    spawnedAgents.map((a) => withTimeout(a.process, a.done, { timeoutMs })),
  );

  // Collect results
  const agentResults: AgentResult[] = [];
  let totalCost = 0;

  for (let i = 0; i < spawnedAgents.length; i++) {
    const agent = spawnedAgents[i];
    const settled = settledResults[i];
    const name = spec.agents[i].name;

    // Get cost and permission denials from bus signals
    let cost = 0;
    let output = "";
    const permissionDenials: string[] = [];

    // Read the output file if agent succeeded
    const outputDir = spec.output?.match(/`([^`]+)`/)?.[1]?.replace(/\/[^/]+$/, "") ?? ".expo/output";
    const outputPath = `${outputDir}/${name}.md`;

    if (settled.status === "fulfilled" && settled.value.exitCode === 0) {
      try {
        output = await Deno.readTextFile(outputPath);
      } catch {
        // Agent may not have written the file
      }
      agentResults.push({ name, status: "success", cost, permissionDenials, output, exitCode: 0 });
    } else {
      const exitCode = settled.status === "fulfilled" ? settled.value.exitCode : 1;
      agentResults.push({ name, status: "failed", cost, permissionDenials, output: "", exitCode });
    }

    totalCost += cost;
  }

  const succeeded = agentResults.filter((a) => a.status === "success");
  const failed = agentResults.filter((a) => a.status === "failed");

  // Run synthesis if any agents succeeded
  let synthesis: WorkflowResult["synthesis"] | undefined;
  if (succeeded.length > 0) {
    const synthPrompt = buildSynthesisPrompt(spec, succeeded, failed);
    const synthResult = await spawnAndWait(bus, spawner, {
      prompt: synthPrompt,
      name: "synthesis",
      model: opts.model,
      worktree: false,
      sandbox: spec.sandbox as string | SandboxConfig,
      timeout: opts.timeout,
    });

    synthesis = {
      output: synthResult.output,
      cost: synthResult.cost,
    };
    totalCost += synthResult.cost;
  }

  unguard();
  await bus.close();

  return {
    agents: agentResults,
    synthesis,
    totalCostUsd: totalCost,
  };
}
