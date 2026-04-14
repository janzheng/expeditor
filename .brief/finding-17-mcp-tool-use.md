# Finding #17 — Closing the Agent-Harness Contract Gap

**Status:** ready
**From:** Finding #17 root-cause follow-up (agents skip verdict wrapper
40-80% of iters; retry + prose-inference are shipped mitigations)
**Task:** `-> TASKS.md` — "Finding #17 MCP tool-use spike"

## Problem

Agents routinely ignore an "absolutely required" instruction in the
refinement prompt: "end your response with a `<verdict>{...}</verdict>`
block." Observed skip rate across 5 snapshot sessions is 40-80%. The
current mitigation stack (Layer 3 prose inference + Layer 4 default-
keep-if-safe + Layer 5 extraction-retry) routes around this cleanly,
but every run still pays a small tax and depends on agent prose
matching our regex patterns. We want to close the hole at the source:
make it structurally impossible for the agent to forget the verdict
format.

The root cause: **the verdict format is an output convention, not a
structural requirement**. Agents trained on code-explanation patterns
drift toward natural prose summaries ("All 32 tests pass, I closed the
rubric item") instead of fenced JSON blocks. The prompt tells them to
wrap; their training biases against it. Prompt-hardening (tried) didn't
shift the rate.

The fix direction is to move from "parse agent output" to "require a
structured action." But expo supports five adapter types (claude, codex,
opencode, pi, generic) with different levels of structured-output
support, so "just use tool calls" isn't straightforward.

## Investigation

### Current adapter landscape

Surveyed via codebase inspection (2026-04-13):

| Adapter | Invocation | Structured output | Native tool-use |
|---|---|---|---|
| **claude** | `claude -p --output-format stream-json` | stream-json (JSONL of typed events) | **Yes — MCP + built-in tools** |
| **codex** | `codex exec --json --full-auto` | JSONL (typed events) | No — commands are already-executed snapshots |
| **opencode** | `opencode run --format json` | JSONL (typed events) | Partial — `tool_use` events are already-executed |
| **pi** | `pi -p --mode json --tools ...` | JSONL (typed events) | Partial — `tool_execution_*` events are already-executed |
| **generic** | any command, raw stdout | None | None |

Key distinction: only **claude** supports true tool-use in the
"agent calls a function with typed args; host runs it" sense. The
others emit already-executed tool outputs as telemetry, which doesn't
solve our problem (we need the agent to CALL a tool, not report what
it did).

### Design space

Three approaches, each with different tradeoffs:

#### Option A — MCP tool-use for Claude; prose fallback for the rest

Expo exposes an MCP server with a single tool:

```
submit_verdict(
  action: "keep" | "discard" | "converged",
  change: string,
  summary: string,
  gate_proposals?: [{ name, command, rationale?, timeoutMs? }]
)
```

Claude is configured with the MCP server + `--permission-prompt-tool
submit_verdict` (or equivalent). The agent's natural workflow is "do
the work → call submit_verdict() → done." The tool-use schema
validation is enforced at call time: the agent cannot forget the
format, because there's no format — there's a typed function.

Other adapters fall through to the current 5-layer parsing stack
(fenced block / legacy line / prose inference / default-keep / retry).

- **Strongest fix for Claude** (the actual production-use adapter so
  far). Skip rate should drop to ~0%.
- **Asymmetric contract** — Claude runs differently from codex/
  opencode/pi in a user-visible way.
- **MCP setup complexity** — need a dedicated MCP server process
  alongside refine, config wiring, permission prompts. Expo already
  has MCP plumbing (`src/permission-mcp-server.ts`), so not greenfield.
- **Implementation:** ~200-300 LOC + tests.

#### Option B — File-based verdict sink for all adapters

Tell every agent: "write your verdict to `.expo-verdict.json` before
exiting. The harness reads that file." The prompt instruction becomes
a discrete action (file write) rather than a structural convention
(fenced block in prose).

- Works uniformly across all five adapters — no adapter-specific
  branching.
- Cooperation-based — the agent still has to remember to write the
  file. But writing a file is a concrete motion code agents are very
  comfortable with (Edit/Write is a primary tool), whereas "wrap
  output in fenced JSON" is a prose convention that's easy to drop.
- **Honest uncertainty:** this might help, or it might just move the
  problem. Prose inference currently recovers ~50% of failures; if
  file-write also has a 40-80% skip rate we're back to prose
  inference as the primary path with worse fallback (file absence
  is a discrete "no" vs prose inference's graceful recovery).
  Only a live test would settle this.
- **Implementation:** ~80-120 LOC (prompt change + post-iteration
  file read + cleanup).

#### Option C — Hybrid: MCP for claude, file sink for the rest

Best-of-both. Claude gets the structural guarantee via MCP tool-use.
Other adapters get the file-based sink as a cheaper-than-prose fallback.
The current 5-layer parsing stack stays as a last-resort backstop.

- Covers every adapter with the best available contract.
- Two code paths to maintain.
- Deferred complexity — file sink AND MCP bridge both need building,
  and the parsing stack stays.

### The hypothesis problem

Option B rests on an untested hypothesis: "code agents are more
reliable at discrete actions than at output conventions." It's plausible
(writing files is a primary tool motion) but we haven't validated it.
Shipping option B without a test is shipping a hope.

Option A rests on a well-understood premise: "tool-use with schema
validation cannot produce malformed output." This is architecturally
guaranteed — there's nothing for the agent to forget.

Option A has higher ceiling; option B has lower cost and wider reach.

## Recommendation

**Ship option A first for Claude**, which is expo's dominant adapter
in practice. The ~$0.50/run prose-inference tax disappears for the
majority of production runs. Claude's skip rate — currently the worst
— drops to near-zero.

Don't ship option B yet. Gather usage data first: after option A lands,
observe the `parseMethod` distribution for codex/opencode/pi runs in
the wild. If those adapters are used heavily and their prose-inference
rate is problematic, THEN ship option B as a phase-2 addition (the
hybrid option C shape naturally composes — add file sink for non-claude
adapters while leaving MCP for claude).

Reasoning:

- **Claude is the proven adapter.** All 5 snapshot sessions used it. The
  refine test suite is Claude-centric. The dogfood path is Claude. Fixing
  Claude solves 90%+ of the actual pain.
- **Option B is an unvalidated guess.** "Agents write files more reliably
  than they emit fenced JSON" is intuitive but not measured. Shipping
  option A first gives us a clean sample of non-claude runs against the
  current Layer 3 system — that data tells us whether option B is worth
  building.
- **The 5-layer stack is already an elegant non-claude fallback.** For
  codex/opencode/pi, Layer 3 (prose inference) + Layer 4 (default-keep)
  together recover ~95% of legitimate keeps at modest cost. That's
  better than "nothing" and possibly better than option B would manage
  — let actual usage decide.
- **Option A is a clean architectural win.** The asymmetric-contract
  concern ("Claude runs differently") is a feature, not a bug: Claude
  IS different — it's the only adapter with native MCP support today.
  Exploiting that advantage is correct.

Explicitly rejected:

- ~~Option C hybrid without data~~: builds two new paths without
  evidence either is needed. Overfits to speculative demand.
- ~~Option B standalone~~: gambles on a hypothesis we can cheaply
  measure instead.

## Implementation Sketch

### Phase 1 — MCP verdict tool for Claude (this BRIEF)

**New file:** `src/verdict-mcp-server.ts` — minimal MCP stdio server
exposing one tool. Shape roughly mirrors the existing
`src/permission-mcp-server.ts`:

```typescript
const server = new McpServer({ name: "expo-verdict", version: "0.1" });
server.tool(
  "submit_verdict",
  {
    action: z.enum(["keep", "discard", "converged"]),
    change: z.string(),
    summary: z.string(),
    gate_proposals: z.array(z.object({ ... })).optional(),
  },
  async (args) => {
    // Write the validated verdict to a rendezvous file the refine
    // loop reads. Could also be an RPC back to the refine process
    // via a Unix socket, but a file is simpler and matches the
    // permission-mcp pattern.
    await Deno.writeTextFile(
      `${RUNTIME_DIR}/verdict-${agentId}.json`,
      JSON.stringify(args),
    );
    return { content: [{ type: "text", text: "verdict recorded" }] };
  },
);
```

**Refine-side wiring:**

1. Before spawning the agent, generate a unique rendezvous path
   (`.expo/verdict-<iter>-<uuid>.json`).
2. Pass MCP config to Claude via `--mcp-config` (same mechanism used
   for `--auto-approve`).
3. Extend `buildRefinePrompt` to instruct the agent to call
   `submit_verdict` (replacing the existing fenced-block instruction
   for Claude). Keep the fenced-block instruction for non-Claude
   adapters.
4. After the agent exits, check for the rendezvous file FIRST. If
   present, parse it as the verdict (set `parseMethod: "tool-use"`).
   If absent, fall through to the existing 5-layer stack.
5. Clean up the rendezvous file post-iteration.

**Telemetry:** add `"tool-use"` to the `ParseMethod` type. The bus
signal `refineParseMethod` now surfaces "fenced / legacy-line /
inferred-prose / defaulted-keep / extraction-retry / defaulted-discard
/ **tool-use**" — over time we can observe how often Claude actually
uses the tool vs skips it.

**Tests:**

- Unit test for the MCP server in isolation (tool receives args,
  writes rendezvous file, returns confirmation).
- Integration test that spawns Claude with the MCP config + a trivial
  rubric, verifies the rendezvous file appears and has the right
  shape.
- Regression test for the non-Claude fallback path (MCP config not
  set → existing 5-layer stack runs unchanged).

**Acceptance:**

- A 5-iter refine run on Claude produces at least 4 of 5 verdicts
  via `parseMethod: "tool-use"` (i.e., Claude's skip rate drops below
  current ~50%+ baseline).
- The existing Layer 3/4/5 path still works for codex/opencode/pi
  runs — unchanged behaviour.
- No regressions in the existing 70+ unit tests.

### Phase 2 — File sink for non-Claude adapters (FUTURE, conditional)

Only ship after phase 1 is live and we have ≥2 weeks of
`refineParseMethod` telemetry from non-Claude runs. Revisit this BRIEF
if:

- non-Claude `parseMethod: "inferred-prose"` + `"defaulted-keep"` rate
  > 30% of iters across ≥10 runs (indicates prose inference is
  working fine — don't ship);
- OR non-Claude `parseMethod: "defaulted-discard"` rate > 5% of iters
  (indicates the current stack is dropping work — ship file sink).

The phase-2 BRIEF gets its own design doc if it turns out to be
needed.

## Out of scope

- Migration / deprecation of the fenced-block instruction in the
  prompt. For now the prompt tells Claude to use the tool AND tells
  everyone else to use the fenced block — both paths stay wired.
  Simplification comes after phase 2 data.
- Cross-process concurrency for the rendezvous file. One agent, one
  file, cleaned up per iteration. If fan-out refine ever becomes a
  thing, rendezvous needs redesign.
- Generalizing this pattern to other expo commands (spawn, review,
  race). Refine is the one with measured drift; others may be fine
  on the existing output-parsing contract.
