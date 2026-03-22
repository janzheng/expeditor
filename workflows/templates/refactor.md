# Refactor — [Area]

## goal
Analyze [area/module] and propose a refactoring plan, then validate it.

## agents

### analyzer
Read all files in [path]. Map the dependency graph: what imports what, what are the public interfaces, where are the coupling points. Identify code smells: long functions, duplicated logic, unclear abstractions, circular dependencies. Write a structured analysis.

### proposer
Read the analyzer's output. Propose a concrete refactoring plan with specific steps: what to extract, rename, merge, or reorganize. For each step, explain the before/after and why it's better. Estimate effort (S/M/L) per step.

### validator
Read the proposed refactoring plan. For each proposed change, check: (1) would it break existing callers? (2) are there tests that would catch regressions? (3) is the proposed interface actually simpler? Push back on changes that add complexity without clear benefit.

## sandbox
developer

## synthesize
Read all agent outputs. Produce a final refactoring plan that incorporates the validator's feedback. Order steps by priority (quick wins first, risky changes last). Include a dependency graph showing which steps must happen before others.

## output
Write plan to `.expo/output/refactor-plan.md`
