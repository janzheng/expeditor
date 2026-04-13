# Tier-1 shakedown rubric: refine `snapshot` lib

You are refining `@snapshot/core`, a small archive-based snapshot lib
(~1.3k LOC, Deno). It provides variant tracking + restore + gate
ratchet — used by expo as a dep. Treat every iteration as if
a reviewer will ship the diff; this is a library used in production.

## Do

- Fix unclear error messages (thrown Error messages, stderr output,
  result types' `reason` strings). "Clearer" = a caller can act on it
  without reading library source.
- Tighten validation at public-API boundaries (exported functions:
  init, snapshot, restore, list, addGate, listGates). If a caller
  passes garbage, return a structured error, not a cryptic git-style
  failure.
- Fix obvious bugs: missing await, swallowed error, wrong default
  that contradicts a nearby comment, off-by-one.
- Every behavioral change needs a test (`src/*.test.ts` or equivalent).

## Do not

- Do not extract helpers for "clarity" with < 3 call sites.
- Do not rename public exports, restructure modules, or reshape types.
- Do not add features, CLI flags, or new public API.
- Do not "improve" working code absent a concrete bug/error.

## Quality bar for KEEP

- Under ~40 LOC of production change.
- New or updated test passes.
- All inherited gates pass.
- A senior reviewer would call the diff "obviously right."

Everything else: DISCARD. Better CONVERGED early than a slop keep.

## Priority order

1. Error clarity in snapshot/restore/addGate failure paths
2. Validation at API-boundary functions (init, snapshot, restore)
3. Small bug-fixes uncovered while reading points 1-2

If no #1 or #2 candidate surfaces quickly, prefer CONVERGED.
