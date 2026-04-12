# Gate Ratchet — Invariant Inheritance for `expo refine`

**Status:** shipped 2026-04-12
**From:** Reading [evo-hq/evo](https://github.com/evo-hq/evo) (autonomous code optimizer inspired by Karpathy's autoresearch). Discussion on 2026-04-12 with the research notes in github-repos.
**Task:** `-> TASKS.md` — see "Gate ratchet — invariant inheritance" under `## expo refine`

## Shipped 2026-04-12

All core functionality is in:

- **`apps/snapshot/`** — `Gate` type + `addGate` / `removeGate` / `listGates` / `collectGates` exported from `@snapshot/core`. `tree()` now shows `[gates: N]` per variant. 7 new tests, all 12 snapshot tests pass.
- **`apps/expo/src/refine.ts`** — `runInheritedGates` helper; wired into KEEP path (runs before `snapshot()`, forces discard on non-zero exit). New `RefineOptions`: `gates`, `allowAgentGates`, `gateTimeout`. Prompt surfaces inherited gates to the agent and (when opted in) teaches it to emit `GATE_PROPOSAL:` lines. `parseVerdict` extracts proposals; loop attaches them to the freshly kept variant. `RefineResult` gains `gateFailures` + `gatesProposed` counters.
- **`apps/expo/src/cli.ts`** — new flags: `--gate "name=command"` (repeatable), `--allow-agent-gates`, `--gate-timeout N`. New subcommand: `expo refine <dir> gate list|add|remove ...`.
- **Tests** — `apps/expo/tests/test-refine-gates.ts` (24 passing): parseVerdict handles 0/1/many/malformed proposals; snapshot primitives compose correctly; scripted shell gates exit-code check.

Smoke-tested CLI surface end-to-end:
```
expo refine <dir> gate add 000 --name tests --command "exit 0" --rationale "..."
expo refine <dir> gate list           # archive-wide view
expo refine <dir> gate list 001       # inherited view for a specific variant
expo refine <dir> --tree              # shows `[gates: N]` per node
expo refine <dir> gate remove 000 --name tests
```

### Discovered-during-implementation issue (also fixed)

`snapshot()` in `@snapshot/core` used to always parent a new variant off
the last non-discarded variant in the manifest — *regardless of what's
currently restored*. That meant:

- `refine`'s "branch to under-explored variant after 3 discards" called
  `restore(dir, branchTarget.id)`, but the next `snapshot()` still
  recorded `parent = lastNonDiscarded`, producing linear chains rather
  than an actual tree.
- For whole-project gates this was benign (linear chains inherit gates
  straight down, which is what you want for invariants like `deno test`).
- It would've mattered the moment someone wanted real sibling branches
  with divergent invariant profiles.

**Fix (shipped 2026-04-12):** The manifest now tracks an explicit `head`
pointer — the variant the filesystem currently corresponds to.
`restore()` advances HEAD (and refuses to restore to a missing or
discarded variant). `snapshot()` parents new variants off HEAD.
`discard()` uses HEAD for the parent but does NOT advance it. Legacy
archives without the `head` field fall back to last-non-discarded for
the first operation, then populate `head` going forward.

5 new tests cover the HEAD semantics (`head: snapshot/restore/discard/
validation/legacy-fallback`). All 17 snapshot tests pass.

This also means `race`, `review`, and `mxit` now produce correctly
parented variants when they restore, not just `refine`. Free correctness
win for the whole snapshot-using family.

## Problem

`expo refine` runs a beam search over code states: agent proposes an edit, rubric-based verdict keeps or discards, snapshot/restore makes accept/reject atomic, and on 3 consecutive discards we branch to an under-explored variant. This is the **state ratchet** — only accepted states survive.

What's missing: an **invariant ratchet**. Today, acceptance is one LLM judgment against a rubric. If the rubric says "clarity, brevity, no dead code" and the agent deletes something that *looked* dead but was actually load-bearing (a side effect, a test registration, a config hook), the LLM judge won't catch it — the variant gets "kept" and the regression is locked in for all descendants.

The failure mode compounds in long unattended sessions: every subsequent iteration inherits the break, future rubric judgments still say "looks cleaner," and you never notice until you try to run the code.

## Sources

- `/Users/janzheng/Desktop/Projects/__resources/github-repos/evo/notes.md` — full research notes on evo, including architecture, benchmark design, and mechanism breakdown
- `/Users/janzheng/Desktop/Projects/__resources/github-repos/_workshop/gate-ratchet-pattern.md` — the pattern written up portably, with implementation sketch and fit/poor-fit cases
- `/Users/janzheng/Desktop/Projects/__resources/github-repos/evo/evo/src/evo/core.py:643` — reference implementation of `collect_gates_from_path` (~10 lines)
- `/Users/janzheng/Desktop/Projects/__resources/github-repos/evo/evo/skills/subagent/SKILL.md` — the prompt that teaches evo's subagents when to add gates ("behaviors that are non-negotiable — things that must never break regardless of what future experiments try")

## Investigation

### What's already here

`expo refine` has the lineage + state-ratchet substrate that gate inheritance needs:

- **Archive tree** with parent/child relationships via `@snapshot/core` (`src/refine.ts:16-24`). Every variant has a parent; you can walk root → parent → ... for any node.
- **Snapshot/restore atomicity** — `snapshot()` on keep, `restore()` on discard. Each variant is an isolated, recoverable state.
- **`--branch-from <id>`** — fork from a specific ancestor. This is exactly the structure gates need to inherit along.
- **`--tree` visualization** — same ASCII tree evo renders. Gate counts can be shown per node (evo does `gates=N` in its label).

So the infrastructure for gates is 80% present. What's missing is a schema slot on variants for gates, an inheritance walker, and a CLI/prompt surface for adding them.

### What evo does

Gates in evo are **named shell commands that must exit 0**, stored per-node on the experiment graph:

```json
{
  "id": "exp_0019",
  "parent": "exp_0005",
  "gates": [
    {"name": "refund_flow", "command": "python benchmark.py --agent {target} --task-ids 5"},
    {"name": "no_pii_leak", "command": "python checks/pii.py --agent {target}"}
  ]
}
```

Before running any experiment, evo calls `collect_gates_from_path(graph, parent_id)` which walks root→parent→grandparent, dedupes gates by name, and runs every gate. Any non-zero exit → candidate discarded regardless of score.

Three design choices make it a ratchet (not just a growing test suite):

1. **Add-only from the loop's perspective.** The agent can `add_gate`; it can't remove gates. Humans can, but the autonomous loop can only increase constraints.
2. **Named, deduped on inheritance.** If parent and grandparent both have `no_pii_leak`, the child sees one gate, not two.
3. **Inheritance is down-only.** A gate added at `node_019` affects only its descendants. Sibling branches that forked before the gate was added never see it. Different branches can have different invariant profiles — critical for not over-constraining the search.

### What evo's subagent prompt says about when to add gates

> "When you fix a critical behavior (e.g., the agent now correctly denies social engineering, or a previously-failing task now passes reliably), **lock it in as a gate** so future experiments on this branch can't regress it."
>
> "Good candidates for gates: a specific benchmark task that was hard to fix and is easy to regress; a test that validates a critical policy rule; a smoke test for a behavior you discovered is fragile."
>
> "Do NOT gate every passing task — that over-constrains the search. Gate only the critical ones."

This tension (too few gates = gaming; too many = search collapses) is managed by pushing the decision onto the LLM's judgment at gate-add time. There's no principled algorithm for "is this behavior critical enough to gate"; the agent decides in context.

### Why this matters for expo specifically

expo refine is going to be used for progressively-longer unattended sessions. The longer the session, the higher the odds of a regression slipping past rubric judgment and becoming load-bearing in the lineage. Gates turn "the agent might break something quietly" into "the agent can break only things we haven't explicitly protected" — the failure surface shrinks as the session progresses.

It also composes naturally with rubric-based judgment: gates are fast binary pre-checks (run before the LLM judge is invoked), rubric is slow qualitative post-check. If a gate fails, you don't spend the tokens asking the LLM for its opinion.

## Recommendation

Add gate inheritance to `@snapshot/core` variants (since that's where variant metadata already lives) and wire it into `expo refine`'s accept/reject path.

**Scope this to `refine` first.** The pattern also fits `review` and arguably `ralph`, but refine is the one with the existing archive tree. Ship refine, evaluate, then decide whether review needs it.

**Explicitly not in scope:**
- `race` (parallel, not lineage — gates don't naturally fit)
- `mxit` (task DAG, not variant lineage)
- `workflow` (stage pipeline, not lineage)

## Implementation Sketch

### 1. Extend the Variant schema in `@snapshot/core`

```ts
// apps/snapshot/src/types.ts (or equivalent)
interface Variant {
  id: string;
  parent: string | null;
  status: "baseline" | "kept" | "discarded";
  change: string;
  summary: string;
  // new:
  gates?: Gate[];
}

interface Gate {
  name: string;         // unique within inheritance chain
  command: string;      // shell command, `{variantDir}` placeholder
  addedAt: string;      // ISO timestamp
  addedBy: string;      // variant id where it was added (for display)
  rationale?: string;   // optional — why the agent added it
}
```

### 2. Add the inheritance walker

```ts
// apps/snapshot/src/core.ts or expo refine.ts
function collectGates(archive: Archive, variantId: string): Gate[] {
  const seen = new Set<string>();
  const gates: Gate[] = [];
  let current: Variant | null = archive.get(variantId);
  while (current) {
    for (const g of current.gates ?? []) {
      if (!seen.has(g.name)) {
        seen.add(g.name);
        gates.push(g);
      }
    }
    current = current.parent ? archive.get(current.parent) : null;
  }
  return gates;
}
```

### 3. Wire into `refine.ts` accept path

In the keep/discard decision path (`src/refine.ts`), before accepting a variant:

```ts
const gates = collectGates(archive, parentVariantId);
for (const gate of gates) {
  const cmd = gate.command.replaceAll("{variantDir}", variantDir);
  const result = await runShell(cmd, { cwd: variantDir, timeout: 60_000 });
  if (result.exitCode !== 0) {
    bus.emit({ type: "gate_failed", gate: gate.name, variantId });
    return { action: "discard", reason: `gate_failed:${gate.name}` };
  }
}
// then proceed with rubric judgment as usual
```

Emit `gate_failed` as a signal-bus event so the dashboard can show it.

### 4. Teach the agent to add gates

Update the refine agent prompt (wherever the rubric prompt is assembled) with an optional "If you just fixed something fragile that descendants shouldn't regress, propose a gate" instruction. Agent emits a structured signal:

```json
{
  "type": "gate_proposal",
  "name": "auth_flow",
  "command": "deno test tests/auth/",
  "rationale": "Spent 3 iterations getting this test passing; easy to break again"
}
```

The orchestrator attaches it to the newly-kept variant.

### 5. CLI surface

```bash
expo refine gate list <variant_id>      # show inherited gates
expo refine gate add <variant_id> \
  --name "auth_flow" \
  --command "deno test tests/auth/"     # manual add (human override)
expo refine gate remove <variant_id> --name "auth_flow"  # human-only, not for agent
```

The `--tree` output should show gate counts per node:

```
└── 000 baseline
    ├── 001 kept — Extracted helpers [gates: 1]
    │   └── 002 kept — Simplified error handling [gates: 2]
    └── 004 kept — Branched: different approach
```

### 6. Tests

- Gate add → appears in `collectGates` output for descendants but not siblings
- Gate inherited from ancestor runs on child; failure → child discarded
- Dedupe: same gate name at parent + grandparent = one execution
- `{variantDir}` substitution happens correctly
- Gate with non-zero exit short-circuits rubric judgment (no rubric call made)

### Open questions (decide during implementation)

- **Gate promotion** — if every descendant of `node_019` independently adds the same-named gate, is that a signal to move it up to `node_019` itself? evo doesn't do this. Could add as a later enhancement.
- **Gate timeout default** — 60s? 120s? Gates should be fast pre-checks; if you want something slow, that's what the rubric is for.
- **Should the agent be able to add gates to the ROOT variant?** Probably yes — a gate at root inherits everywhere. But this is a big commitment; maybe require a `--agent-can-gate-root` flag.
- **Gate history on discarded variants** — do discarded variants' proposed gates survive anywhere for inspection? Probably: log to REFINE.md so cross-session learning picks it up.

### Low-risk partial implementation

If full implementation feels heavy, the 80/20 version is:

1. Let `expo refine` take a `--gate "cmd"` CLI flag that applies one gate to the root variant
2. Run that command before every keep judgment
3. Discard with `reason: "gate_failed"` on non-zero exit

That gives most of the protection (a global test suite that refine can't regress) without any schema changes or agent-side gate-proposal surface. Ship this first, add per-node/per-agent gate-add later if it proves useful.
