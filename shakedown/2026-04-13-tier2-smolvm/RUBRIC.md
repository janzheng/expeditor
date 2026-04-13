# Tier-2 shakedown rubric: refine smolvm's TypeScript surface

You are refining `smolvm`, a polyglot repo (Rust core + Deno/TS CLI +
TS SDK). ~16k TS LOC across `cli/`, `sdk-ts/`, `tests/`. Scope is
intentionally TS-only — the Rust side (`src/`, `crates/`, `libkrun*`)
is out of bounds for this run.

## Do

- Fix unclear error messages in `cli/smolctl.ts` and `sdk-ts/` exports.
- Tighten validation at CLI argument boundaries (missing positional,
  flag without value, non-numeric where numeric expected).
- Add missing regression tests for any behavior you change.
- Fix obvious bugs you stumble on.

## Do not

- Do not touch Rust files (`src/**/*.rs`, `crates/**`, `libkrun*/**`).
- Do not extract helpers with < 3 call sites.
- Do not rename exports or reshape public types in `sdk-ts/`.
- Do not add CLI flags or SDK methods.
- Do not modify the TASKS-*.md files — those are human-authored plans.

## Quality bar for KEEP

- Under ~40 LOC of production change.
- New or updated test in `tests/` passes.
- `deno task test` still passes.
- A senior reviewer would call the diff "obviously right."

## Priority order

1. Error message clarity in CLI command handlers (`cli/smolctl.ts`)
2. Validation gaps at CLI argument parsing
3. Exported SDK functions in `sdk-ts/` that accept garbage
4. Small bug-fixes uncovered while reading 1-3

If you can't find a priority-1 or -2 candidate in 2+ tool calls,
prefer CONVERGED over reaching.
