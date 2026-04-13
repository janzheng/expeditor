# Design Cycle — [Target directory or module]

One full diverge → converge pass across a codebase: explore what's
there (stage 1), synthesize 2–3 axes worth rubricizing (stage 2),
then hand off to `expo refine` per rubric (stage 3, manual).

See `.brief/design-cycle-orchestration.md` for the framing. This
template is the "first-class cycle" sketch implemented as a workflow —
good enough to run today, learn from, and eventually factor into an
`expo cycle` command.

## goal
Run stage 1 (diverge) + stage 2 (converge) of a design cycle on
[target directory or module]. Stage 1: multiple explorer agents
surface findings across different axes. Stage 2: synthesis agent
picks the 2–3 most load-bearing axes and writes one rubric per axis,
each ready to feed into `expo refine`.

## background
Replace this section with what you already know about the target:
prior audits, known pain points, recent incidents, what's shipped
lately. Leave it empty if you genuinely want an open exploration.

## agents

### explorer-surface
Read the target directory's source files. Look for obvious surface
issues: input validation gaps, unclear error messages, inconsistent
naming, dead code, places where the code says one thing and the
comments/types say another. For each finding, include the file path
and line number, a one-line description, and a proposed axis tag
(e.g. `validation`, `error-clarity`, `naming`, `dead-code`). Rank
within each axis by user-visible impact. Aim for 10–20 findings
total. Do not propose fixes — just describe what's there.

### explorer-edges
Read the target directory's source files with a focus on boundaries:
error paths, empty inputs, zero/null/undefined, off-by-one
conditions, concurrent access, partial-failure recovery, resource
cleanup. For each finding, include file path and line number, a
one-line description, the specific edge case, and an axis tag
(e.g. `error-handling`, `concurrency`, `cleanup`, `empty-input`).
Aim for 10–20 findings. Do not propose fixes — describe the gap.

### explorer-tests
Read the target directory's source AND test files. Map what's tested
vs what isn't: which functions lack tests, which branches lack
coverage, which edge cases no test currently exercises. For each
gap, include the file path, the function/branch, one line on what a
good test would exercise, and an axis tag (`test-coverage`,
`test-quality`, `integration-missing`). Aim for 10–20 findings.
Do not write tests — describe the gap.

## sandbox
research

## synthesize
Read all three explorer outputs. Your job is to CONVERGE on the 2–3
axes most worth spending compute on in this cycle.

1. **Cluster** findings by axis. The explorers proposed axis tags;
   prefer theirs when they agree, merge when they overlap, resolve
   when they conflict. Count findings per axis.
2. **Rank** axes by load-bearing-ness: (a) user-visible impact,
   (b) findings count, (c) how concrete the fix direction would be.
   Pick the top 2–3. Name the rest in a "not-this-cycle" section.
3. **Write the synthesis index** to `.expo/output/cycle-synthesis.md`
   with: the list of chosen axes, count per axis, the strongest 1–2
   findings per axis as representative examples, and a "next cycle
   candidates" list of axes you deferred.
4. **Write one rubric per chosen axis** to
   `.expo/output/cycle-rubric-A.md`, `.expo/output/cycle-rubric-B.md`,
   and (if 3 axes) `.expo/output/cycle-rubric-C.md`.
   Each rubric file must be shaped for `expo refine --rubric-file`:
   - A short title naming the axis
   - 3–6 specific, testable bullet criteria (not vague "be better")
   - 1–2 negative criteria ("the change is NOT in scope if...")
   - A "keep when" line summarizing the bar for acceptance
   Rubrics must be standalone — a refine run reads one without the
   others, so repeat shared context per file.

Do not run `expo refine` yourself. Stage 3 is manual (see Output).

## formatting
Rubrics must be standalone markdown. Synthesis index uses headers
per axis. Keep each rubric under 600 words.

## output
Write synthesis to `.expo/output/cycle-synthesis.md`. Additionally
write one rubric file per chosen axis at `.expo/output/cycle-rubric-A.md`,
`.expo/output/cycle-rubric-B.md`, `.expo/output/cycle-rubric-C.md`.

After this workflow completes, stage 3 is manual:

```bash
# Per rubric, run a bounded convergent pass
expo refine . \
  --rubric-file .expo/output/cycle-rubric-A.md \
  --scope 'src/**' \
  --max 5

# Review keeps, then re-run this workflow for cycle 2
# (optionally copy .expo/output/cycle-* into .brief/ first to
#  preserve the cycle history)
```
