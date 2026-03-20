# Workflow-Driven Research Orchestration

**Status:** ready
**From:** Live spike — conversation + 2 successful agent runs ($1.75 metabolite-lens + immune-lens)
**Task:** `-> TASKS.md` (pending)

## Problem

Expo can orchestrate coding agents, but the same fan-out/synthesize pattern applies to non-code tasks: hypothesis generation, literature review, grant writing, design docs. We proved this works by running 2 research agents that searched PubMed, wrote structured findings, and independently converged on the same mechanism (IDO/kynurenine pathway). The missing pieces were: (1) a workflow format, (2) harness-controlled permissions so headless agents can actually use tools, and (3) a synthesis step.

## Sources

- This conversation (2026-03-19): iterative spike from "do bus-* files matter" to running research agents
- `workflows/research-gut-brain.md` — first workflow file, gut-brain axis in TRD
- `output/metabolite-lens.md` — 17 papers, SCFA/kynurenine mechanisms (metabolite agent)
- `output/immune-lens.md` — 10 papers, leaky gut/IL-6/TNF-alpha cascade (immune agent)
- `tasks-gut-brain.json` — task manifest with sandbox configs
- `src/spawner.ts` — harness sandbox implementation (SandboxConfig → temp settings file → `--settings`)

## Investigation

### What we built and tested

**1. Workflow markdown files** — human-readable, machine-executable research briefs.

No custom parser needed. Claude Code *is* the parser. A workflow file declares:
- `## background` — problem context
- `## agents` — named lenses, each with a search/analysis prompt
- `## synthesize` — instructions for convergence
- `## formatting` — citation style, output structure
- `## output` — where to write results

The agent reads the file and follows it. Format is loose enough to handle variation — you don't need rigid sections, just clear intent.

**2. Harness-controlled sandbox** — the orchestrator owns permissions, not the agent.

Three permission approaches tested:

| Approach | How | Result |
|----------|-----|--------|
| No permissions | Default mode, agent prompts for everything | Agents stalled on WebSearch/Write, immune-lens bailed after 46s |
| `--permission-mode acceptEdits` + `--allowedTools` | Direct CLI flags | `--allowedTools` is variadic, swallowed the prompt arg. Fixed by piping prompt via stdin. Worked but blunt. |
| **`--settings <file>` (sandbox)** | Harness generates temp settings.json per agent with `allow`/`deny` rules | Clean separation. Agent stays in default permission mode. Harness controls exactly which tools are approved. Temp file cleaned up after agent exits. |

The sandbox approach is the winner. Implementation in `spawner.ts`:

```typescript
interface SandboxConfig {
  allow?: string[];   // "Read", "WebSearch", "Bash(mkdir:*)"
  deny?: string[];    // "Bash(rm:*)", "Bash(git:*)"
  addDirs?: string[]; // additional directory access
}
```

Spawner generates a temp settings file:
```json
{
  "permissions": {
    "allow": ["Read", "Write", "WebSearch", "WebFetch", "Bash(mkdir:*)", "Bash(ls:*)"],
    "deny": ["Bash(rm:*)", "Bash(git:*)"]
  }
}
```

Passes via `--settings /tmp/expo-sandbox-xxx/agent-settings.json`. Agent runs in default (tight) mode but the harness-generated settings whitelist specific tools. No `dangerously-skip-permissions`, no `acceptEdits`.

**3. Research output quality**

Two agents ran in parallel (~3 min each, $0.75 + $1.01):

- **metabolite-lens**: 17 papers with PMIDs/DOIs, 3 mechanistic pathway diagrams (SCFA depletion, kynurenine shunt, p-cresol accumulation), intervention target table, metabolite signature panel for TRD
- **immune-lens**: 10 papers with full citations, core pathogenic chain diagram (dysbiosis → leaky gut → LPS → inflammation → IDO → SSRI failure), biomarker comparison table (IL-6 vs TNF-alpha vs CRP), dual barrier failure model

**Independent convergence** — both agents, without seeing each other's work, identified:
- IDO → kynurenine → serotonin depletion as the central mechanism blocking SSRI efficacy
- Butyrate depletion as the upstream driver
- The same gap: no RCT testing gut barrier restoration + SSRI in TRD patients
- Biomarker-stratified treatment (CRP/IL-6/I-FABP) as the clinical path forward

This convergence is the signal. Two different starting points (metabolites vs immune markers) arriving at the same mechanism independently is stronger than either alone.

### Patterns that emerged

**Fan-out → synthesize** is the core research pattern:
- Spawn N agents with different lenses on the same question
- Each searches independently, writes structured output
- A synthesis agent reads all outputs and finds convergence/gaps/ranked hypotheses

This maps to other domains:

| Domain | Lenses | Synthesis |
|--------|--------|-----------|
| Research hypothesis | Molecular, computational, clinical, intervention | Convergence map + ranked hypotheses |
| Grant writing | Literature, gaps, aims, feasibility | Coherent specific aims page |
| PRD/design doc | User research, technical feasibility, competitive analysis | Prioritized feature set |
| Architecture decision | Performance, maintainability, cost, security | ADR with tradeoffs |

**Relationship to autorefine**: Fan-out explores a space (breadth). Autorefine improves a single artifact (depth). They compose: fan-out → synthesize → pick best → autorefine the winner. Explore then exploit.

### What's missing

**Synthesis step**: We ran 2 lenses but never ran the synthesis agent that reads both outputs and produces the convergence map. This is the highest-value step — it's where independent convergence becomes explicit and ranked hypotheses emerge.

**Iteration**: No feedback loop yet. After synthesis, you'd want to: identify weak spots → spawn targeted agents to fill gaps → re-synthesize. This is the "fold" pattern applied to research.

**Cost tracking per workflow**: The bus tracks cost per agent, but not per workflow. Would be useful to know "this hypothesis generation cost $1.75 total."

**PubMed MCP tools**: Both agents fell back to WebSearch because the PubMed MCP server was in "pending" state. When connected, the sandbox already allows the PubMed tools — just need the server auth sorted.

**Workflow-level sandbox defaults**: Currently each task in the JSON repeats the same sandbox config. The workflow markdown could declare a default sandbox that applies to all agents unless overridden.

## Recommendation

Ship the workflow system as-is with three additions:

1. **Add synthesis step** — after fan-out agents complete, spawn a synthesis agent that reads all `output/*.md` files and produces the convergence doc per the workflow's `## synthesize` section. Wire this into CLI as `deno task expo workflow <file.md>`.

2. **Workflow-level sandbox in markdown** — add a `## sandbox` section to workflow files so the sandbox config lives alongside the prompts, not duplicated in tasks.json:
   ```markdown
   ## sandbox
   allow: Read, Write, Edit, WebSearch, WebFetch, Bash(mkdir:*), Bash(ls:*)
   deny: Bash(rm:*), Bash(git:*)
   ```

3. **Auto-generate tasks.json from workflow markdown** — a small utility that reads the workflow file and produces the tasks.json manifest, so the user only maintains one file.

The workflow markdown file becomes the single source of truth: intent, lenses, sandbox rules, synthesis instructions, output format. `deno task expo workflow research-gut-brain.md` does the rest.

## Implementation Sketch

### Files to change

- `src/cli.ts` — add `workflow` command that reads a markdown file and orchestrates the full pipeline
- `src/workflow.ts` (new) — parse workflow markdown sections, generate SpawnOptions per agent, run synthesis step after fan-out
- `src/spawner.ts` — already has SandboxConfig, no changes needed

### Workflow execution flow

```
1. Read workflow.md
2. Parse sections: background, agents, sandbox, synthesize, formatting, output
3. For each agent section:
   a. Build prompt = background context + agent-specific instructions + formatting rules
   b. Apply sandbox (workflow-level defaults + agent overrides)
   c. Spawn via existing spawner
4. Wait for all agents to complete
5. Spawn synthesis agent:
   a. Prompt = "Read these output files: [...]. Follow these synthesis instructions: [...]"
   b. Same sandbox rules
   c. Write to output path from ## output section
6. Report: agents completed, cost, output location
```

### Sandbox section parsing

Simple key-value in markdown:
```markdown
## sandbox
allow: Read, Write, WebSearch, WebFetch
deny: Bash(rm:*), Bash(git:*)
```

Parsed as:
```typescript
{ allow: ["Read", "Write", "WebSearch", "WebFetch"], deny: ["Bash(rm:*)", "Bash(git:*)"] }
```

### Edge cases

- **Agent failure**: If one lens fails, still run synthesis on available outputs. Flag the gap.
- **PubMed auth**: When MCP server needs auth, agent should fall back to WebSearch (already happens naturally).
- **Output collision**: Each agent writes to a unique file (`output/{agent-name}.md`), synthesis writes to the path in `## output`.
- **Cost budget**: Could add `## budget` section with per-agent and total caps, wired to existing `costGuard` in orchestrator.
