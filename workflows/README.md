# Workflows

Markdown workflow files describe multi-agent pipelines. Each file
declares fan-out agents + a synthesis step. Run one with:

```bash
expo workflow workflows/templates/<name>.md --budget 5
```

See [`src/workflow.ts`](../src/workflow.ts) for the parser and
[`README.md`](../README.md#markdown-workflows) for the command.

## Included templates

| Template | Purpose | Sandbox |
|---|---|---|
| `templates/code-review.md` | Bug + security + style reviewers → unified review | developer |
| `templates/research.md` | Literature + practical + contrarian → synthesis | research |
| `templates/refactor.md` | Analyzer + proposer + validator → refactor plan | developer |
| `templates/design-cycle.md` | Three explorers → 2–3 rubrics, one per axis | research |

## Design cycle (diverge → converge, with a manual refine handoff)

`templates/design-cycle.md` runs one full cycle:

1. **Stage 1 (diverge, in the workflow)** — three explorer agents
   find issues from different angles (surface, edges, test coverage).
2. **Stage 2 (converge, in the workflow)** — synthesis picks 2–3
   load-bearing axes and writes one rubric per axis to
   `.expo/output/cycle-rubric-{A,B,C}.md`.
3. **Stage 3 (manual, after the workflow)** — run `expo refine` once
   per rubric to do the actual convergent improvement:

   ```bash
   expo workflow workflows/templates/design-cycle.md --budget 8
   # → .expo/output/cycle-synthesis.md
   # → .expo/output/cycle-rubric-{A,B,C}.md

   expo refine . \
     --rubric-file .expo/output/cycle-rubric-A.md \
     --scope 'src/**' --max 5
   ```

4. **Cycle 2** — re-run the workflow informed by what was kept. If
   you want cycle history preserved across runs, copy outputs into
   `.brief/cycle-YYYY-MM-DD/` before re-running.

See [`.brief/design-cycle-orchestration.md`](../.brief/design-cycle-orchestration.md)
for the framing that motivated this template, and
[`.brief/refine-philosophy.md`](../.brief/refine-philosophy.md) for
why stage 3 is separate (refine is a convergent tool, meant to be
fed a rubric — not to author one).
